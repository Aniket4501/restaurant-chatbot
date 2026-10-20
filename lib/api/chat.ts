import fs from "node:fs";
import { runTurn } from "@/lib/chat/turn";
import { ChatBodySchema } from "@/lib/chat/types";
import { errorResponse, okResponse, readJson } from "@/lib/http/json";
import type { ApiDeps } from "@/lib/api/deps";

/**
 * POST /api/chat → 200 { reply, draft, intent, context, meta } / 400 / 413 / 429 (§5.9, D-15). The trace is included
 * only in test mode. With TEST_TRACE_PATH set (test mode only), each turn appends
 * { sessionId, now, blocks, citedFactIds, trace, maskedPrompt } to that file for the invariant checks (D-12).
 */
export function chatHandler(deps: ApiDeps) {
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
    const prompts: { system: string; user: string }[] = [];
    const tracePath = config.test?.tracePath;
    const { sessionId, messages, draft, action, context } = parsed.data;
    const r = await runTurn(
      { now, sessionId, messages, draft, action, context },
      { db: deps.db(), model: deps.chat.model(), embedder: deps.chat.embedder(), limiter: deps.chat.limiter, gate: deps.chat.gate, onPrompt: tracePath ? (p) => prompts.push(p) : undefined },
    );
    if (tracePath) {
      const entry = { sessionId, now, blocks: r.reply.blocks, citedFactIds: r.meta.citedFactIds, trace: r.trace, outcome: r.meta.outcome, maskedPrompt: prompts.at(-1) ?? null };
      fs.appendFileSync(tracePath, `${JSON.stringify(entry)}\n`);
    }
    if (r.status === "rate_limited") return errorResponse(429, "RATE_LIMITED", r.reply.text, {}, { "retry-after": String(Math.max(1, Math.ceil((r.retryAfterMs ?? 1000) / 1000))) });
    const { trace, status: _status, retryAfterMs: _retry, ...rest } = r;
    return okResponse(200, config.testMode ? { ...rest, trace } : rest);
  };
}
