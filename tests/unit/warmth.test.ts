import { describe, expect, it } from "vitest";
import { createModelGate, GateFullError } from "@/lib/chat/ratelimit";
import { MODEL } from "@/lib/config";
import type { Run } from "@/lib/llm/warm";
import { singleFlight, warmRound } from "@/lib/llm/warmer";
import { loadedChecker, modelTimeout } from "@/lib/llm/warmth";

// D-23: a model call gets the cold timeout only when Ollama says the model is unloaded.
describe("model timeout", () => {
  it("uses the cold timeout only when the model is known to be unloaded", () => {
    expect(modelTimeout(false)).toBe(MODEL.coldTimeoutMs);
    expect(modelTimeout(true)).toBe(MODEL.chatTimeoutMs);
    expect(modelTimeout(null)).toBe(MODEL.chatTimeoutMs);
    expect(MODEL.coldTimeoutMs).toBeGreaterThan(MODEL.chatTimeoutMs);
  });
  it("an explicit timeout (tests, evals) wins", () => {
    expect(modelTimeout(false, 1_000)).toBe(1_000);
  });
});

describe("loaded checker (Ollama /api/ps)", () => {
  const ps = (body: unknown, status = 200) => (async (url: string | URL | Request) => {
    expect(String(url)).toBe("http://127.0.0.1:11434/api/ps");
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  it("reports whether the chat model is in Ollama's loaded list", async () => {
    const loaded = { models: [{ name: "qwen3-embedding:0.6b", model: "qwen3-embedding:0.6b" }, { name: "qwen3.5:9b", model: "qwen3.5:9b" }] };
    expect(await loadedChecker("http://127.0.0.1:11434", "qwen3.5:9b", ps(loaded))()).toBe(true);
    expect(await loadedChecker("http://127.0.0.1:11434", "qwen3.5:9b", ps({ models: [loaded.models[0]] }))()).toBe(false);
    expect(await loadedChecker("http://127.0.0.1:11434", "qwen3.5:9b", ps({ models: [] }))()).toBe(false);
    expect(await loadedChecker("http://127.0.0.1:11434", "llama3", ps({ models: [{ name: "llama3:latest" }] }))()).toBe(true);
  });
  it("says it can't tell (null) when Ollama errors or can't be reached", async () => {
    expect(await loadedChecker("http://127.0.0.1:11434", "qwen3.5:9b", ps({}, 500))()).toBeNull();
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await loadedChecker("http://127.0.0.1:11434", "qwen3.5:9b", refused)()).toBeNull();
  });
});

describe("warm-up round (D-23)", () => {
  const deferred = () => {
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    return { done, release };
  };
  it("is skipped while an eval runs", async () => {
    let warmed = false;
    expect(await warmRound({ gate: createModelGate(), evalRunning: () => true, warm: async () => void (warmed = true) })).toBe("eval running");
    expect(warmed).toBe(false);
  });
  it("queues each step in the guest gate, so a guest waits for at most one step", async () => {
    const gate = createModelGate({ concurrency: 1, maxQueue: 4 });
    const order: string[] = [];
    const guestA = deferred();
    const a = gate.run(async () => {
      order.push("guest A");
      await guestA.done;
    });
    const step1 = deferred();
    let b: Promise<void> | null = null;
    const round = warmRound({
      gate,
      evalRunning: () => false,
      warm: async (run: Run) => {
        await run(async () => {
          order.push("warm 1");
          b = gate.run(async () => void order.push("guest B")); // a guest arrives during step 1
          await step1.done;
        });
        await run(async () => void order.push("warm 2"));
      },
    });
    await Promise.resolve();
    expect(order).toEqual(["guest A"]); // the warm-up waits for the guest's call
    guestA.release();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["guest A", "warm 1"]);
    step1.release();
    expect(await round).toBe("warmed");
    await b;
    expect(order).toEqual(["guest A", "warm 1", "guest B", "warm 2"]);
  });
  it("FM-046 runs one round at a time: a request during a round runs one more after it, never two at once", async () => {
    let active = 0;
    let peak = 0;
    let rounds = 0;
    const steps: (() => void)[] = [];
    const once = singleFlight(async () => {
      active++;
      rounds++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => steps.push(r));
      active--;
    });
    const a = once();
    void once();
    void once(); // three triggers while the first round runs
    await Promise.resolve();
    expect(rounds).toBe(1);
    steps.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(rounds).toBe(2); // one follow-up for all the requests made during round 1
    steps.shift()!();
    await a;
    expect([rounds, peak]).toEqual([2, 1]);
  });
  it("FM-015 a call that waits past the queue deadline is refused as busy; the queue moves on", async () => {
    const gate = createModelGate({ concurrency: 1, maxQueue: 4, maxWaitMs: 20 });
    const hold = deferred();
    const busy = gate.run(() => hold.done);
    await expect(gate.run(async () => "late")).rejects.toBeInstanceOf(GateFullError);
    expect(gate.waiting).toBe(0);
    hold.release();
    await busy;
    expect(await gate.run(async () => "next")).toBe("next");
  });
  it("gives up the round when the gate's queue is full", async () => {
    const gate = createModelGate({ concurrency: 1, maxQueue: 0 });
    const hold = deferred();
    const busy = gate.run(() => hold.done);
    await expect(warmRound({ gate, evalRunning: () => false, warm: (run) => run(async () => "x") })).rejects.toBeInstanceOf(GateFullError);
    hold.release();
    await busy;
  });
});
