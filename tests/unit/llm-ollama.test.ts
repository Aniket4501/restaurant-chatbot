import { describe, expect, it } from "vitest";
import { interpretEnvelope, ModelError, type ModelRequest } from "@/lib/llm/client";
import { ollamaModel } from "@/lib/llm/ollama";
import { TURN_JSON_SCHEMA } from "@/lib/llm/schema";

// Layer A tests of the Ollama chat client with a stubbed fetch (D-12): D-05 request settings and error mapping.
const BASE = "http://127.0.0.1:11434";
const req = (signal?: AbortSignal): ModelRequest => ({ messages: [{ role: "system", content: "sys" }, { role: "user", content: "<guest_message>hi</guest_message>" }], format: TURN_JSON_SCHEMA, attempt: 1, signal });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const turn = { intent: "smalltalk", booking: { branch: null, date: null, time: null, timeWindow: null, partySize: null, ambiguity: null }, answer: "Hello!", citedFactIds: [], answerable: true };
const code = async (p: Promise<unknown>) => p.then(() => "resolved", (e) => (e instanceof ModelError ? e.code : String(e)));

describe("ollamaModel (stubbed fetch)", () => {
  it("posts the D-05 body: think false, truncate false, keep_alive 30m and only the §5.8 options", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const m = ollamaModel({
      baseUrl: BASE,
      model: "qwen3.5:9b",
      fetch: async (url, init) => {
        sent = { url: String(url), body: JSON.parse(String(init?.body)) };
        return json(200, { message: { role: "assistant", content: JSON.stringify(turn) }, done_reason: "stop", prompt_eval_count: 3500, prompt_eval_cached_count: 3400, eval_count: 40, total_duration: 950_000_000 });
      },
    });
    const env = await m.chat(req());
    expect(sent!.url).toBe(`${BASE}/api/chat`);
    expect(sent!.body).toEqual({ model: "qwen3.5:9b", messages: req().messages, stream: false, format: TURN_JSON_SCHEMA, think: false, truncate: false, keep_alive: "30m", options: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 400 } });
    expect(env).toEqual({ status: 200, error: null, content: JSON.stringify(turn), done_reason: "stop", thinking: null, prompt_eval_count: 3500, prompt_eval_cached_count: 3400, eval_count: 40, total_ms: 950 });
    expect(interpretEnvelope(env)).toMatchObject({ ok: true, turn: { intent: "smalltalk" } });
  });

  it("maps connection refused to MODEL_UNAVAILABLE and an abort or timeout to MODEL_TIMEOUT", async () => {
    const refused = ollamaModel({ baseUrl: BASE, model: "m", fetch: async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) });
    expect(await code(refused.chat(req()))).toBe("MODEL_UNAVAILABLE");
    const hang = ollamaModel({ baseUrl: BASE, model: "m", fetch: (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))) });
    expect(await code(hang.chat(req(AbortSignal.timeout(20))))).toBe("MODEL_TIMEOUT");
  });

  it("returns HTTP errors as envelopes, mapped by status (404 not pulled, 400 grammar, 500 unavailable)", async () => {
    const withStatus = (status: number, error: string) => ollamaModel({ baseUrl: BASE, model: "m", fetch: async () => json(status, { error }) });
    const c = async (status: number, error: string) => {
      const r = interpretEnvelope(await withStatus(status, error).chat(req()));
      return r.ok ? "ok" : r.code;
    };
    expect(await c(404, "model 'qwen3.5:9b' not found")).toBe("MODEL_NOT_PULLED");
    expect(await c(400, "invalid structured output grammar")).toBe("MODEL_INVALID_OUTPUT");
    expect(await c(500, "runner crashed")).toBe("MODEL_UNAVAILABLE");
    expect((await withStatus(400, "invalid structured output grammar").chat(req())).error).toBe("invalid structured output grammar");
  });

  it("flags thinking, whether in message.thinking or inline <think> tags", async () => {
    const reply = (message: Record<string, string>) => ollamaModel({ baseUrl: BASE, model: "m", fetch: async () => json(200, { message, done_reason: "stop" }) }).chat(req());
    expect((await reply({ content: JSON.stringify(turn), thinking: "Let me think" })).thinking).toBe("Let me think");
    expect((await reply({ content: `<think>hmm</think>${JSON.stringify(turn)}` })).thinking).toBe("<think> in content");
    expect(interpretEnvelope(await reply({ content: "", thinking: "…" }))).toMatchObject({ ok: false, code: "MODEL_INVALID_OUTPUT" });
  });

  it("treats a body that isn't JSON as empty content (invalid output), never a crash", async () => {
    const m = ollamaModel({ baseUrl: BASE, model: "m", fetch: async () => new Response("<html>proxy error</html>", { status: 200 }) });
    expect(interpretEnvelope(await m.chat(req()))).toMatchObject({ ok: false, code: "MODEL_INVALID_OUTPUT" });
  });
});
