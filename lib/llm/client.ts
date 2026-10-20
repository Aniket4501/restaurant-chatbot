import type { z } from "zod";
import { MODEL } from "@/lib/config";
import { ANSWER_MAX, TurnSchema, type Turn } from "@/lib/llm/schema";

// The chat-model boundary (§5.2, §5.8, D-05, D-12). Exactly two implementations: lib/llm/ollama.ts (local Ollama,
// T-18) and lib/llm/fake.ts (scripted). Both return the same raw envelope, and `interpretEnvelope` is the single
// place that decides whether a reply is usable, so tests of the fake exercise the production validation path.
// Documented in docs/MODEL_ADAPTER.md.

export type ModelErrorCode = "MODEL_UNAVAILABLE" | "MODEL_NOT_PULLED" | "MODEL_TIMEOUT" | "MODEL_INVALID_OUTPUT" | "CONTEXT_TOO_LARGE";

/** Thrown by a client only for transport failures (no HTTP response): unreachable or timed out. */
export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ModelRequest = {
  /** [system, user] on the first attempt; the corrective retry appends [assistant (the bad reply), user (the correction)]. */
  messages: ChatMessage[];
  /** JSON schema for grammar-constrained output (Ollama `format`). */
  format: Record<string, unknown>;
  attempt: 1 | 2;
  signal?: AbortSignal;
};

/** What one model call returned, before any interpretation (D-12). Durations in ms. */
export type RawEnvelope = {
  status: number; // HTTP status
  error: string | null; // the error body text on non-2xx
  content: string;
  done_reason: string | null;
  thinking: string | null;
  prompt_eval_count: number | null;
  prompt_eval_cached_count: number | null;
  eval_count: number | null;
  total_ms: number | null;
};

export interface ModelClient {
  readonly provider: "ollama" | "fake";
  readonly model: string;
  /** Resolves with the envelope for any HTTP response; rejects with ModelError (UNAVAILABLE, TIMEOUT) otherwise. */
  chat(req: ModelRequest): Promise<RawEnvelope>;
}

export type ModelMetrics = Pick<RawEnvelope, "prompt_eval_count" | "prompt_eval_cached_count" | "eval_count" | "total_ms"> & { thinking_present: boolean };

export type Interpreted =
  | { ok: true; turn: Turn; truncated: boolean; metrics: ModelMetrics }
  | { ok: false; code: ModelErrorCode; detail: string; metrics: ModelMetrics };

/**
 * Decide whether an envelope is a usable turn (§5.8, D-05):
 * - HTTP 404 → MODEL_NOT_PULLED (by status, never message text); 5xx/other → MODEL_UNAVAILABLE; 400 → MODEL_INVALID_OUTPUT
 *   (e.g. "invalid structured output grammar").
 * - prompt_eval_count ≥ num_ctx − 512 → CONTEXT_TOO_LARGE (backstop for the pre-call budget).
 * - thinking content, done_reason "length", empty content, non-JSON or a schema miss → MODEL_INVALID_OUTPUT.
 * - An answer of exactly 600 characters is flagged `truncated` (the caller shows the fallback).
 */
export function interpretEnvelope(env: RawEnvelope, numCtx: number = MODEL.numCtx): Interpreted {
  const r = interpretJson(env, TurnSchema, numCtx);
  if (!r.ok) return r;
  return { ok: true, turn: r.value, truncated: (r.value.answer?.length ?? 0) >= ANSWER_MAX, metrics: r.metrics };
}

/**
 * The envelope checks for any JSON contract (the turn, or the D-20 chooser): HTTP status, context size, thinking,
 * truncation, then JSON and the schema. Every model reply goes through here.
 */
export function interpretJson<T>(env: RawEnvelope, schema: z.ZodType<T>, numCtx: number = MODEL.numCtx): { ok: true; value: T; metrics: ModelMetrics } | { ok: false; code: ModelErrorCode; detail: string; metrics: ModelMetrics } {
  const metrics: ModelMetrics = {
    prompt_eval_count: env.prompt_eval_count,
    prompt_eval_cached_count: env.prompt_eval_cached_count,
    eval_count: env.eval_count,
    total_ms: env.total_ms,
    thinking_present: !!env.thinking,
  };
  const fail = (code: ModelErrorCode, detail: string) => ({ ok: false as const, code, detail, metrics });
  if (env.status === 404) return fail("MODEL_NOT_PULLED", "the chat model is not pulled");
  if (env.status === 400) return fail("MODEL_INVALID_OUTPUT", `HTTP 400${env.error ? `: ${env.error.slice(0, 120)}` : ""}`);
  if (env.status < 200 || env.status > 299) return fail("MODEL_UNAVAILABLE", `HTTP ${env.status}`);
  if (env.prompt_eval_count !== null && env.prompt_eval_count >= numCtx - 512) return fail("CONTEXT_TOO_LARGE", `prompt_eval_count ${env.prompt_eval_count}`);
  if (env.thinking) return fail("MODEL_INVALID_OUTPUT", "thinking content present");
  if (env.done_reason === "length") return fail("MODEL_INVALID_OUTPUT", "done_reason length");
  if (!env.content.trim()) return fail("MODEL_INVALID_OUTPUT", "empty content");
  let json: unknown;
  try {
    json = JSON.parse(env.content);
  } catch {
    return fail("MODEL_INVALID_OUTPUT", "content is not JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return fail("MODEL_INVALID_OUTPUT", `schema: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`);
  return { ok: true, value: parsed.data, metrics };
}

/** The short corrective message for the single retry (§5.7 step 4). */
export const CORRECTIVE_MESSAGE =
  "Your last reply was not a valid JSON object for the schema. Reply again with exactly one compact JSON object that matches the schema, and nothing else.";
