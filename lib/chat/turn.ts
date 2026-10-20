import { randomUUID } from "node:crypto";
import { LIMITS, MODEL, RULES } from "@/lib/config";
import { loadAvailabilityData } from "@/lib/booking/load";
import type { AvailabilityBundle } from "@/lib/booking/availability";
import type { DB } from "@/lib/db/client";
import type { Embedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts, renderStaticFacts, type Fact } from "@/lib/kb/facts";
import { retrievalQuery, retrieveFacts } from "@/lib/kb/retrieve";
import { CORRECTIVE_MESSAGE, interpretEnvelope, interpretJson, ModelError, type ChatMessage as LlmMessage, type Interpreted, type ModelClient } from "@/lib/llm/client";
import { CHOOSER_JSON_SCHEMA, CHOOSER_VERSION, ChooserSchema } from "@/lib/llm/chooser";
import { buildPrompt, promptChars, PROMPT_VERSION, type SystemPromptInput } from "@/lib/llm/prompt";
import { maskMessages } from "@/lib/llm/redact";
import { TURN_JSON_SCHEMA, type Intent } from "@/lib/llm/schema";
import type { LocalDate } from "@/lib/time/tz";
import { guardExtraction, largePartyStated } from "@/lib/chat/guards";
import { menuEntries, menuStep } from "@/lib/chat/menu";
import { recommendTurn, resolvePrefs, type ChooserCall, type RecommendResult } from "@/lib/chat/recommend";
import { GateFullError, openGate, type ModelGate, type TurnLimiter } from "@/lib/chat/ratelimit";
import { degradedStep, handleAction, routeTurn, type FlowCtx, type Step } from "@/lib/chat/router";
import { branchInfo } from "@/lib/chat/templates";
import { emptyDraft, noPrefs, type Action, type ChatMessage, type Draft, type Prefs, type TraceEntry, type TurnContext, type TurnReply } from "@/lib/chat/types";

// runTurn (§5.7, ARCHITECTURE "Chat turn pipeline"): the single entry point for POST /api/chat and the eval runner.
// The body is validated by the caller (ChatBodySchema). Nothing here reads the clock: `now` is an input, and
// `elapsed` (a monotonic timer) is only used for latency metrics.

export type TurnInput = {
  now: number;
  sessionId: string;
  messages: ChatMessage[];
  draft: Draft | null;
  action?: Action;
  /** Bounded memory from the client (D-13, D-20): cited facts to carry, food preferences, dishes suggested. */
  context?: Partial<TurnContext>;
};

export type TurnDeps = {
  db: DB;
  model: ModelClient;
  embedder: Embedder | null;
  limiter: TurnLimiter;
  gate?: ModelGate;
  elapsed?: () => number;
  modelTimeoutMs?: number;
  /** Test trace (D-12): receives the masked prompt of each model turn. */
  onPrompt?: (p: { system: string; user: string }) => void;
  /** Availability reads; the eval runner injects a failing one for backend-failure cases (§6.2 #16). */
  loadBundle?: (db: DB, dates: LocalDate[]) => AvailabilityBundle;
};

/** Today's static prompt inputs from the database (shared with model:check and model:warm, which plant the same prefix). */
export function systemInputFor(db: DB, now: number): SystemPromptInput {
  const src = loadFactSource(db);
  const branches = src.branches.filter((b) => b.isActive).map(branchInfo);
  return { now, zone: branches[0]?.timezone ?? RULES.timezone, restaurant: src.restaurant ?? { name: "the restaurant" }, branches, staticFacts: renderStaticFacts(src, now) };
}

/** Pre-call prompt budget in characters (D-15): the token budget at the ≈2.9 characters per token the probe measured. */
export const PROMPT_CHAR_BUDGET = Math.floor(MODEL.promptBudgetTokens * 2.9);

const RATE_LIMITED_TEXT = "You're sending messages quickly. Please wait a moment and try again.";

export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnReply> {
  const elapsed = deps.elapsed ?? (() => performance.now());
  const started = elapsed();
  const trace: TraceEntry[] = [];
  const draft0 = input.draft ?? emptyDraft();
  // Memory out (D-20): unchanged unless this turn is about food choices.
  let prefsOut: Prefs | null = input.context?.prefs ?? null;
  let recommendedOut: string[] = input.context?.recommended ?? [];
  const metrics = { retrievalMode: "none" as "hybrid" | "lexical" | "none", retrievalReason: null as string | null, modelMs: null as number | null, retrievalMs: null as number | null, promptTokens: null as number | null, cachedTokens: null as number | null, outputTokens: null as number | null, promptVersion: null as string | null };

  const finish = (step: Step, intent: Intent | null, status: TurnReply["status"] = "ok", retryAfterMs?: number): TurnReply => {
    const reply: TurnReply = {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      reply: { text: step.text, blocks: step.blocks },
      draft: step.draft,
      intent,
      context: { lastCitedIds: (step.citedFactIds ?? []).slice(0, 8), prefs: prefsOut, recommended: recommendedOut.slice(0, 6) },
      trace,
      meta: {
        outcome: step.outcome,
        degraded: step.outcome === "degraded",
        retrievalMode: metrics.retrievalMode,
        retrievalReason: metrics.retrievalReason,
        citedFactIds: step.citedFactIds ?? [],
        model: deps.model.model,
        promptVersion: metrics.promptVersion,
        latencyMs: Math.round(elapsed() - started),
        modelMs: metrics.modelMs === null ? null : Math.round(metrics.modelMs),
        retrievalMs: metrics.retrievalMs === null ? null : Math.round(metrics.retrievalMs),
        promptTokens: metrics.promptTokens,
        cachedTokens: metrics.cachedTokens,
        outputTokens: metrics.outputTokens,
      },
    };
    writeMetrics(deps.db, input, reply);
    return reply;
  };

  // 1. Rate limits (the body was already validated by the caller).
  const allowed = deps.limiter.allow(input.sessionId, input.now);
  if (!allowed.ok) {
    trace.push({ action: "rate_limited" });
    return finish({ text: RATE_LIMITED_TEXT, blocks: [], draft: draft0, outcome: "rate_limited" }, null, "rate_limited", allowed.retryAfterMs);
  }

  // The day's snapshot: everything comes from the database (BR-14).
  const src = loadFactSource(deps.db);
  const branches = src.branches.filter((b) => b.isActive).map(branchInfo);
  const zone = branches[0]?.timezone ?? RULES.timezone;
  const bundles = new Map<string, AvailabilityBundle>();
  const ctx: FlowCtx = {
    now: input.now,
    zone,
    branches,
    allSlugs: new Set(src.branches.map((b) => b.slug)),
    trace,
    bundle: (dates: LocalDate[]) => {
      const key = [...dates].sort().join(",");
      if (!bundles.has(key)) bundles.set(key, (deps.loadBundle ?? loadAvailabilityData)(deps.db, dates));
      return bundles.get(key)!;
    },
  };

  // 2. Chip, slot and menu actions: deterministic, no model call.
  const entries = menuEntries(src);
  if (input.action?.type === "menu") {
    const p = prefsOut ?? noPrefs();
    const m = menuStep(entries, input.action.course === null ? noPrefs() : { ...noPrefs(), diet: p.diet, avoid: p.avoid, allergy: p.allergy }, input.action.course);
    trace.push({ action: "menu", course: input.action.course, items: m.shown });
    return finish({ text: m.text, blocks: m.blocks, draft: draft0, outcome: "menu", citedFactIds: m.cited }, null);
  }
  if (input.action) return finish(handleAction(input.action, draft0, ctx), null);

  // 3. Mask every message once, whatever its role (D-15).
  const masked = maskMessages(input.messages);
  const latest = masked.at(-1)!.content;
  const history = masked.slice(0, -1).slice(-(LIMITS.historyMax - 1));
  const previousGuest = history.filter((m) => m.role === "guest").at(-1)?.content ?? null;

  // 4. Retrieve (D-02, D-13).
  const staticFacts = renderStaticFacts(src, input.now);
  const kbFacts = renderKbFacts(src);
  const kbById = new Map(kbFacts.map((f) => [f.id, f]));
  const r0 = elapsed();
  const retrieval = await retrieveFacts(retrievalQuery(latest, previousGuest), { carry: input.context?.lastCitedIds }, { db: deps.db, facts: kbFacts, embedder: deps.embedder });
  metrics.retrievalMs = elapsed() - r0;
  metrics.retrievalMode = retrieval.mode;
  metrics.retrievalReason = retrieval.reason;
  trace.push({ action: "retrieve", mode: retrieval.mode, reason: retrieval.reason, ids: retrieval.hits.map((h) => h.factId) });
  const retrieved = retrieval.hits.map((h) => kbById.get(h.factId)!);

  // 5. Build the prompt, within the character budget (D-15): trim history to 2 messages once, else degrade.
  const byId = new Map(entries.map((e) => [e.id, e]));
  const suggested = recommendedOut.filter((id) => byId.has(id)).slice(0, 3).map((id) => `${byId.get(id)!.name} (₹${byId.get(id)!.price})`).join(", ") || null;
  const promptFor = (h: typeof history) =>
    buildPrompt({ now: input.now, zone, restaurant: src.restaurant ?? { name: "the restaurant" }, branches, staticFacts, retrieved, draft: draft0, history: h, guest: latest, prefs: prefsOut ? JSON.stringify(prefsOut) : null, suggested });
  let usedHistory = history;
  let prompt = promptFor(usedHistory);
  if (promptChars(prompt) > PROMPT_CHAR_BUDGET) {
    usedHistory = history.slice(-2);
    prompt = promptFor(usedHistory);
  }
  metrics.promptVersion = PROMPT_VERSION;
  if (promptChars(prompt) > PROMPT_CHAR_BUDGET) return finish(degradedStep(draft0, ctx, "CONTEXT_TOO_LARGE"), null);

  // 6–7. Call the model through the gate; one corrective retry for invalid output, one trimmed retry for context.
  const call = async (attempt: 1 | 2, messages: LlmMessage[]): Promise<{ result: Interpreted; content: string }> => {
    const m0 = elapsed();
    try {
      const env = await deps.model.chat({ messages, format: TURN_JSON_SCHEMA, attempt, signal: AbortSignal.timeout(deps.modelTimeoutMs ?? MODEL.chatTimeoutMs) });
      const result = interpretEnvelope(env);
      metrics.promptTokens = env.prompt_eval_count;
      metrics.cachedTokens = env.prompt_eval_cached_count;
      metrics.outputTokens = env.eval_count;
      trace.push({ action: "model_call", attempt, result: result.ok ? (result.truncated ? "truncated" : "ok") : result.code });
      return { result, content: env.content };
    } catch (e) {
      if ((e as { name?: string })?.name === "ScriptExhaustedError") throw e; // a test script ran out: fail the test
      const code = e instanceof ModelError ? e.code : (e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError" ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE";
      trace.push({ action: "model_call", attempt, result: code });
      return { result: { ok: false, code, detail: "", metrics: { prompt_eval_count: null, prompt_eval_cached_count: null, eval_count: null, total_ms: null, thinking_present: false } }, content: "" };
    } finally {
      metrics.modelMs = (metrics.modelMs ?? 0) + (elapsed() - m0);
    }
  };

  const factsById = new Map<string, Fact>([...staticFacts, ...kbFacts].map((f) => [f.id, f]));
  const sentIds = new Set([...staticFacts.map((f) => f.id), ...retrieved.map((f) => f.id)]);
  const zoneOf = (slug: string) => src.branches.find((b) => b.slug === slug)?.timezone ?? zone;

  // The recommendation chooser (D-20): the second model call of a recommend turn, in the same gate slot as the first,
  // so another session can't take the slot in between.
  const chooser: ChooserCall = async (attempt, messages) => {
    const m0 = elapsed();
    try {
      const env = await deps.model.chat({ messages, format: CHOOSER_JSON_SCHEMA, attempt, signal: AbortSignal.timeout(deps.modelTimeoutMs ?? MODEL.chatTimeoutMs) });
      const r = interpretJson(env, ChooserSchema);
      return r.ok ? { choice: r.value, code: "ok", content: env.content } : { choice: null, code: r.code, content: env.content };
    } catch (e) {
      if ((e as { name?: string })?.name === "ScriptExhaustedError") throw e; // a test script ran out: fail the test
      const code = e instanceof ModelError ? e.code : (e as { name?: string })?.name === "TimeoutError" || (e as { name?: string })?.name === "AbortError" ? "MODEL_TIMEOUT" : "MODEL_UNAVAILABLE";
      return { choice: null, code, content: "" };
    } finally {
      metrics.modelMs = (metrics.modelMs ?? 0) + (elapsed() - m0);
    }
  };
  const recommended: { result: RecommendResult | null } = { result: null }; // set inside the gate closure

  let outcome: { result: Interpreted; content: string };
  try {
    outcome = await (deps.gate ?? openGate).run(async () => {
      deps.onPrompt?.(prompt);
      const base: LlmMessage[] = [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ];
      let first = await call(1, base);
      const r = first.result;
      const answerTurn = r.ok && (r.turn.intent === "faq" || r.turn.intent === "smalltalk");
      if (!r.ok && r.code === "MODEL_INVALID_OUTPUT") first = await call(2, [...base, { role: "assistant", content: first.content }, { role: "user", content: CORRECTIVE_MESSAGE }]);
      else if (r.ok && r.truncated && answerTurn) first = await call(2, [...base, { role: "assistant", content: first.content }, { role: "user", content: CORRECTIVE_MESSAGE }]);
      else if (!r.ok && r.code === "CONTEXT_TOO_LARGE" && usedHistory.length > 2) {
        usedHistory = usedHistory.slice(-2);
        prompt = promptFor(usedHistory);
        deps.onPrompt?.(prompt);
        first = await call(2, [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ]);
      }
      const t1 = first.result;
      // A stated large party is a booking whatever the model said (D-17), so it never reaches the chooser.
      if (t1.ok && t1.turn.intent === "recommend" && largePartyStated(latest) === null) {
        recommended.result = await recommendTurn(
          { turn: t1.turn, text: latest, history: usedHistory, context: input.context, entries, restaurant: src.restaurant?.name ?? "the restaurant", grounding: { factsById, sentIds, zoneOf }, trace, canRetry: () => elapsed() - started < 18_000, relevant: retrieval.hits.map((h) => h.factId) },
          chooser,
        );
        metrics.promptVersion = `${PROMPT_VERSION}+${CHOOSER_VERSION}`;
      }
      return first;
    });
  } catch (e) {
    if (e instanceof GateFullError) {
      trace.push({ action: "rate_limited" });
      return finish({ text: RATE_LIMITED_TEXT, blocks: [], draft: draft0, outcome: "rate_limited" }, null, "rate_limited", 1000);
    }
    throw e;
  }

  // 8. Route (or degrade).
  const r = outcome.result;
  if (!r.ok) return finish(degradedStep(draft0, ctx, r.code), null);
  const guarded = guardExtraction(r.truncated ? { ...r.turn, answer: null } : r.turn, latest, input.now, zone); // D-17
  trace.push(...guarded.trace);
  const turn = guarded.turn; // a truncated answer is still too long after the retry → fallback/greeting

  // 9. Food turns (D-20): menu browsing from the menu table; recommendations through the chooser.
  let prepared: { text: string; blocks: TurnReply["reply"]["blocks"]; cited: string[] } | null = null;
  if (turn.intent === "menu") {
    const { prefs, added } = resolvePrefs(turn.prefs, prefsOut, latest);
    trace.push({ action: "prefs", prefs, added });
    prefsOut = prefs;
    const m = menuStep(entries, prefs, prefs.course);
    trace.push({ action: "menu", course: prefs.course, items: m.shown });
    prepared = { text: m.text, blocks: m.blocks, cited: m.cited };
  } else if (turn.intent === "recommend" && recommended.result) {
    const rec = recommended.result;
    prefsOut = rec.prefs;
    recommendedOut = rec.recommended;
    prepared = { text: rec.text, blocks: rec.blocks, cited: rec.cited };
  }
  const step = routeTurn(turn, draft0, ctx, { factsById, sentIds, zoneOf, staticFacts }, prepared);
  return finish(step, turn.intent);
}

/** One chat_turns row per turn: metrics only, never guest text (§5.7 step 6). A failed write never fails the turn. */
function writeMetrics(db: DB, input: TurnInput, r: TurnReply): void {
  try {
    db.prepare(
      `INSERT INTO chat_turns (id, session_id, intent, outcome, model, prompt_version, retrieval_mode, latency_ms, model_ms, retrieval_ms, prompt_tokens, cached_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.sessionId,
      r.intent,
      r.meta.outcome,
      r.meta.model,
      r.meta.promptVersion,
      r.meta.retrievalMode,
      r.meta.latencyMs,
      r.meta.modelMs,
      r.meta.retrievalMs,
      r.meta.promptTokens,
      r.meta.cachedTokens,
      r.meta.outputTokens,
      input.now,
    );
  } catch {
    r.trace.push({ action: "metrics_write_failed" });
  }
}
