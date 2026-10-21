import { createHash } from "node:crypto";
import fs from "node:fs";
import { offeredStarts } from "@/lib/chat/offered";
import { runTurn } from "@/lib/chat/turn";
import { ChatBodySchema } from "@/lib/chat/types";
import { errorResponse, okResponse, readJson } from "@/lib/http/json";
import type { ApiDeps } from "@/lib/api/deps";
import type { TurnTiming } from "@/lib/chat/types";

/** The turn's stages as a Server-Timing header value (D-24). */
export function serverTiming(t: TurnTiming, duplicate = false): string {
  const parts: [string, number | null][] = [["setup", t.setupMs], ["retrieval", t.retrievalMs], ["prompt", t.promptMs], ["queue", t.queueMs], ["status", t.statusMs], ["model", t.turnModelMs], ["chooser", t.chooserMs], ["other", t.otherMs]];
  return [...parts.filter(([, v]) => v !== null).map(([k, v]) => `${k};dur=${v}`), ...(duplicate ? ["duplicate"] : [])].join(", ");
}

/**
 * POST /api/chat → 200 { reply, draft, intent, context, meta } / 400 / 413 / 429 (§5.9, D-15). The trace is included
 * only in test mode. With TEST_TRACE_PATH set (test mode only), each turn appends
 * { sessionId, now, text, blocks, citedFactIds, trace, outcome, offered, maskedPrompt } to that file for the invariant checks
 * (D-12).
 */
type Result = { status: number; json: Record<string, unknown>; headers?: Record<string, string> };

/**
 * One reply per guest action (D-20). A repeat of the same request id with the same body (a double submit, a client
 * retry after a lost response) gets the first request's result, awaited if it is still running, and never a second
 * model call. In memory, per server process, bounded by size and age.
 */
export function requestDeduper(opts: { ttlMs?: number; max?: number } = {}) {
  const ttl = opts.ttlMs ?? 120_000;
  const max = opts.max ?? 500;
  const seen = new Map<string, { at: number; result: Promise<Result>; settled: boolean }>();
  return {
    run(key: string | null, now: number, compute: () => Promise<Result>): { result: Promise<Result>; duplicate: boolean } {
      if (!key) return { result: compute(), duplicate: false };
      // A turn still running is never expired or evicted, so a retry always joins it however long it takes (failure-mode
      // audit FM-045: after 120 s a retry started a second model turn behind the first).
      for (const [k, v] of seen) if (v.settled && (now - v.at > ttl || seen.size > max)) seen.delete(k);
      const hit = seen.get(key);
      if (hit && (!hit.settled || now - hit.at <= ttl)) return { result: hit.result, duplicate: true };
      const result = compute();
      const entry = { at: now, result, settled: false };
      seen.set(key, entry);
      // Only a reply is remembered: a crash, a rate limit or a full queue is not, so a retry runs again (review).
      const forget = () => {
        if (seen.get(key)?.result === result) seen.delete(key);
      };
      result.then(
        (r) => {
          entry.settled = true;
          if (r.status !== 200) forget();
        },
        forget,
      );
      return { result, duplicate: false };
    },
  };
}
const dedupe = requestDeduper();

export function chatHandler(deps: ApiDeps, dedup = dedupe) {
  return async (req: Request): Promise<Response> => {
    const body = await readJson(req);
    if (!body.ok) return body.response;
    const parsed = ChatBodySchema.safeParse(body.value);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const i of parsed.error.issues) fields[i.path.join(".") || "body"] ??= i.message;
      return errorResponse(400, "VALIDATION", "Please check the request.", { fields });
    }
    const config = deps.config();
    const now = deps.now();
    const { sessionId, requestId } = parsed.data;
    const key = requestId ? `${sessionId}:${requestId}:${createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex").slice(0, 16)}` : null;
    const { result, duplicate } = dedup.run(key, now, () => turnResult(deps, parsed.data, now));
    let r: Result;
    try {
      r = await result;
    } catch (e) {
      // A turn that throws answers with a JSON error, not a bare 500. A database behind the code's migrations is named in
      // the log (failure-mode audit FM-028: every guest turn failed with no explanation anywhere). Never guest text.
      const behind = e instanceof Error && e.name === "SqliteError" && /no such (?:column|table)/.test(e.message);
      console.error(JSON.stringify({ event: "chat_error", requestId: requestId ?? null, error: behind ? "schema_behind" : e instanceof Error ? e.name : "unknown" }));
      return behind
        ? errorResponse(503, "UNAVAILABLE", "The chat is being updated and can't answer just now. Please try again later, or call the restaurant.", {}, { "retry-after": "30" })
        : errorResponse(500, "INTERNAL", "Something went wrong on our side, and nothing was changed. Please try again.");
    }
    if (process.env.NODE_ENV !== "test" && !config.testMode) {
      // One line per guest action for debugging (D-20): ids, timings and outcomes, never guest text.
      const m = r.json.meta as Record<string, unknown> | undefined;
      console.info(JSON.stringify({ event: "chat_turn", requestId: requestId ?? null, session: sessionId.slice(0, 8), duplicate, status: r.status, intent: r.json.intent ?? null, outcome: m?.outcome ?? null, latencyMs: m?.latencyMs ?? null, modelMs: m?.modelMs ?? null, retrieval: m?.retrievalMode ?? null, cited: m?.citedFactIds ?? [], timing: m?.timing ?? null }));
    }
    if (r.status !== 200) return errorResponse(r.status, "RATE_LIMITED", String((r.json as { text?: string }).text ?? ""), {}, r.headers);
    const res = okResponse(200, r.json);
    // Stage timings for the browser's network panel and the benchmark (D-24); a duplicate shares the first request's.
    const tm = (r.json.meta as { timing?: TurnTiming } | undefined)?.timing;
    if (tm) res.headers.set("server-timing", serverTiming(tm, duplicate));
    return res;
  };
}

async function turnResult(deps: ApiDeps, body: ReturnType<typeof ChatBodySchema.parse>, now: number): Promise<Result> {
  {
    const config = deps.config();
    const prompts: { system: string; user: string }[] = [];
    const tracePath = config.test?.tracePath;
    const { sessionId, messages, draft, action, context } = body;
    const r = await runTurn(
      { now, sessionId, messages, draft, action, context },
      { db: deps.db(), model: deps.chat.model(), embedder: deps.chat.embedder(), limiter: deps.chat.limiter, gate: deps.chat.gate, modelLoaded: deps.chat.modelLoaded, onPrompt: tracePath ? (p) => prompts.push(p) : undefined },
    );
    if (tracePath) {
      // Test mode only: what was shown, plus an engine re-check of every offered time for INV-03 (§6.4).
      const offered = offeredStarts(deps.db(), r.reply.blocks, now);
      const entry = { sessionId, now, text: r.reply.text, blocks: r.reply.blocks, citedFactIds: r.meta.citedFactIds, trace: r.trace, outcome: r.meta.outcome, offered, maskedPrompt: prompts.at(-1) ?? null };
      fs.appendFileSync(tracePath, `${JSON.stringify(entry)}\n`);
    }
    if (r.status === "rate_limited") return { status: 429, json: { text: r.reply.text }, headers: { "retry-after": String(Math.max(1, Math.ceil((r.retryAfterMs ?? 1000) / 1000))) } };
    const out = { reply: r.reply, draft: r.draft, intent: r.intent, context: r.context, meta: r.meta };
    return { status: 200, json: config.testMode ? { ...out, trace: r.trace } : out };
  }
}
