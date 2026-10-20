import { describe, expect, it } from "vitest";
import { requestDeduper } from "@/lib/api/chat";

// D-20 duplicate protection on the server: one reply per (session, request id, body). Review: only successful replies
// are remembered, entries expire, and the map stays bounded.
type R = { status: number; json: Record<string, unknown>; headers?: Record<string, string> };
const reply = (status: number, n: number): Promise<R> => Promise.resolve({ status, json: { n } });

describe("requestDeduper", () => {
  it("shares one computation between a request and its duplicate", async () => {
    const d = requestDeduper();
    let calls = 0;
    const a = d.run("k", 0, () => reply(200, ++calls));
    const b = d.run("k", 10, () => reply(200, ++calls));
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect(await b.result).toEqual(await a.result);
    expect(calls).toBe(1);
  });
  it("runs again after the time to live", async () => {
    const d = requestDeduper({ ttlMs: 1000 });
    let calls = 0;
    await d.run("k", 0, () => reply(200, ++calls)).result;
    expect(d.run("k", 1001, () => reply(200, ++calls)).duplicate).toBe(false);
    expect(calls).toBe(2);
  });
  it("does not remember a rate limit, a full queue or a crash", async () => {
    const d = requestDeduper();
    for (const status of [429, 503]) {
      await d.run(`k${status}`, 0, () => reply(status, 0)).result;
      await Promise.resolve();
      expect(d.run(`k${status}`, 1, () => reply(200, 1)).duplicate, String(status)).toBe(false);
    }
    await d.run("crash", 0, () => Promise.reject(new Error("boom"))).result.catch(() => undefined);
    await Promise.resolve();
    expect(d.run("crash", 1, () => reply(200, 1)).duplicate).toBe(false);
  });
  it("stays bounded, evicting the oldest entries first", async () => {
    const d = requestDeduper({ max: 3 });
    for (let i = 0; i < 6; i++) await d.run(`k${i}`, i, () => reply(200, i)).result;
    expect(d.run("k5", 7, () => reply(200, 99)).duplicate).toBe(true); // the newest is kept
    expect(d.run("k0", 8, () => reply(200, 99)).duplicate).toBe(false); // the oldest was evicted
  });
  it("treats no key as no deduplication", () => {
    const d = requestDeduper();
    expect(d.run(null, 0, () => reply(200, 1)).duplicate).toBe(false);
    expect(d.run(null, 0, () => reply(200, 1)).duplicate).toBe(false);
  });
});
