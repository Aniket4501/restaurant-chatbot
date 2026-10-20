import { createHash } from "node:crypto";
import fs from "node:fs";
import { offeredStarts } from "@/lib/chat/offered";
import { runTurn } from "@/lib/chat/turn";
import { ChatBodySchema } from "@/lib/chat/types";
import { errorResponse, okResponse, readJson } from "@/lib/http/json";
import type { ApiDeps } from "@/lib/api/deps";

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
  const seen = new Map<string, { at: number; result: Promise<Result> }>();
  return {
    run(key: string | null, now: number, compute: () => Promise<Result>): { result: Promise<Result>; duplicate: boolean } {
      if (!key) return { result: compute(), duplicate: false };
      for (const [k, v] of seen) if (now - v.at > ttl || seen.size > max) seen.delete(k);
      const hit = seen.get(key);
      if (hit && now - hit.at <= ttl) return { result: hit.result, duplicate: true };
      const result = compute();
      seen.set(key, { at: now, result });
      // Only a reply is remembered: a crash, a rate limit or a full queue is not, so a retry runs again (review).
      const forget = () => {
        if (seen.get(key)?.result === result) seen.delete(key);
      };
      result.then((r) => r.status !== 200 && forget(), forget);
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
    const r = await result;
    if (process.env.NODE_ENV !== "test" && !config.testMode) {
      // One line per guest action for debugging (D-20): ids, timings and outcomes, never guest text.
      const m = r.json.meta as Record<string, unknown> | undefined;
      console.info(JSON.stringify({ event: "chat_turn", requestId: requestId ?? null, session: sessionId.slice(0, 8), duplicate, status: r.status, intent: r.json.intent ?? null, outcome: m?.outcome ?? null, latencyMs: m?.latencyMs ?? null, modelMs: m?.modelMs ?? null, retrieval: m?.retrievalMode ?? null, cited: m?.citedFactIds ?? [] }));
    }
    return r.status === 200 ? okResponse(200, r.json) : errorResponse(r.status, "RATE_LIMITED", String((r.json as { text?: string }).text ?? ""), {}, r.headers);
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
      { db: deps.db(), model: deps.chat.model(), embedder: deps.chat.embedder(), limiter: deps.chat.limiter, gate: deps.chat.gate, onPrompt: tracePath ? (p) => prompts.push(p) : undefined },
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
