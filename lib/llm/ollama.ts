import { MODEL } from "@/lib/config";
import { ModelError, type ModelClient, type ModelRequest, type RawEnvelope } from "@/lib/llm/client";

// The local Ollama chat client (§5.8, D-05, D-16). Local only: lib/config accepts only loopback base URLs and rejects
// cloud model names. Every HTTP response becomes a raw envelope that interpretEnvelope judges; only transport failures
// throw (connection refused → MODEL_UNAVAILABLE, abort or timeout → MODEL_TIMEOUT).
//
// D-05 request settings for qwen3.5 on the MLX runner:
// - think:false always (omitting it turns thinking on: empty content and done_reason "length");
// - truncate:false, num_ctx 8192 as a soft value, with the app-level prompt budget (CONTEXT_TOO_LARGE);
// - only temperature 0, seed 42, num_ctx and num_predict; the Modelfile's other sampling parameters are kept;
// - keep_alive "30m".

export function chatOptions(overrides: { num_predict?: number } = {}) {
  return { temperature: MODEL.temperature, seed: MODEL.seed, num_ctx: MODEL.numCtx, num_predict: overrides.num_predict ?? MODEL.numPredict };
}

/** The /api/chat body for a request (exported for model:warm, which plants the prefix snapshot with the same body). */
export function chatBody(model: string, req: Pick<ModelRequest, "messages" | "format">, overrides: { num_predict?: number } = {}) {
  return { model, messages: req.messages, stream: false, format: req.format, think: false, truncate: false, keep_alive: MODEL.keepAlive, options: chatOptions(overrides) };
}

const isAbort = (e: unknown) => ["AbortError", "TimeoutError"].includes((e as { name?: string })?.name ?? "");
const ns2ms = (x: unknown) => (typeof x === "number" ? x / 1e6 : null);

type ChatJson = {
  message?: { content?: string; thinking?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  total_duration?: number;
  error?: string;
};

export function ollamaModel(opts: { baseUrl: string; model: string; fetch?: typeof fetch }): ModelClient {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    provider: "ollama",
    model: opts.model,
    async chat(req) {
      let res: Response;
      let text: string;
      try {
        res = await doFetch(`${opts.baseUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatBody(opts.model, req)), signal: req.signal });
        text = await res.text();
      } catch (e) {
        if (isAbort(e)) throw new ModelError("MODEL_TIMEOUT", "the model did not answer in time");
        throw new ModelError("MODEL_UNAVAILABLE", "cannot reach Ollama. Is `ollama serve` running?");
      }
      let j: ChatJson = {};
      try {
        j = JSON.parse(text) as ChatJson;
      } catch {
        /* a non-JSON body: an empty envelope, which interpretEnvelope rejects */
      }
      if (!res.ok) {
        return { status: res.status, error: (j.error ?? text).slice(0, 300), content: "", done_reason: null, thinking: null, prompt_eval_count: null, prompt_eval_cached_count: null, eval_count: null, total_ms: null } satisfies RawEnvelope;
      }
      const content = j.message?.content ?? "";
      // Thinking can arrive as message.thinking or, with some templates, inline <think> tags (D-05).
      const thinking = j.message?.thinking ? j.message.thinking : /<think>/i.test(content) ? "<think> in content" : null;
      return {
        status: res.status,
        error: null,
        content,
        done_reason: j.done_reason ?? null,
        thinking,
        prompt_eval_count: j.prompt_eval_count ?? null,
        prompt_eval_cached_count: j.prompt_eval_cached_count ?? null,
        eval_count: j.eval_count ?? null,
        total_ms: ns2ms(j.total_duration),
      } satisfies RawEnvelope;
    },
  };
}

/**
 * Plant a prefix-cache snapshot at the static-prompt boundary (D-05): on the MLX runner the cache resumes only at
 * snapshot offsets (OL-22/23), so two requests share the system prompt and diverge at the first user token.
 * Returns each request's prompt and cached token counts. Used by model:warm and before a live eval run.
 */
export async function plantSnapshot(opts: { baseUrl: string; model: string; system: string; format: Record<string, unknown>; timeoutMs: number }) {
  const out: { ms: number; prompt: number | null; cached: number | null }[] = [];
  for (const user of ["1", "2"]) {
    const t0 = performance.now();
    const res = await fetch(`${opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody(opts.model, { messages: [{ role: "system", content: opts.system }, { role: "user", content: user }], format: opts.format }, { num_predict: 1 })),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const j = (await res.json().catch(() => ({}))) as { prompt_eval_count?: number; prompt_eval_cached_count?: number; error?: string };
    if (!res.ok) throw new Error(`HTTP ${res.status} ${j.error ?? ""}`.trim());
    out.push({ ms: Math.round(performance.now() - t0), prompt: j.prompt_eval_count ?? null, cached: j.prompt_eval_cached_count ?? null });
  }
  return out;
}
