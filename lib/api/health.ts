import { okResponse } from "@/lib/http/json";
import { EmbedError } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { embeddingCoverage, lexicalCurrent } from "@/lib/kb/index";
import type { ApiDeps } from "@/lib/api/deps";

/**
 * GET /api/health: DB, Ollama reachability, model names/digests, and retrieval index coverage (D-13: hybrid needs a
 * current vector for every fact; otherwise retrieval is lexical). No secrets, no guest data (§5.9). Incomplete
 * coverage is reported but is not a failure: lexical retrieval is a supported mode.
 */
export function healthHandler(deps: ApiDeps) {
  return async (): Promise<Response> => {
    const config = deps.config();
    let db: { ok: boolean; schema?: string[]; error?: string };
    try {
      const rows = deps.db().prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[];
      db = { ok: true, schema: rows.map((r) => r.version) };
    } catch (e) {
      db = { ok: false, error: (e as Error).name };
    }
    const model = { provider: config.llmProvider, embedProvider: config.embedProvider, chatModel: config.chatModel, embedModel: config.embedModel, reachable: false as boolean, digests: {} as Record<string, string | null> };
    if (config.llmProvider === "fake" && config.embedProvider === "fake") model.reachable = true;
    else {
      try {
        const res = await deps.fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const tags = (await res.json()) as { models?: { name: string; digest: string }[] };
          model.reachable = true;
          for (const m of [config.chatModel, config.embedModel]) model.digests[m] = tags.models?.find((t) => t.name === m)?.digest ?? null;
        }
      } catch {
        model.reachable = false;
      }
    }
    let kb: Record<string, unknown> = { error: "unavailable" };
    if (db.ok) {
      try {
        const facts = renderKbFacts(loadFactSource(deps.db()));
        const embedder = deps.chat.embedder();
        let embedded: number | null = null;
        let embedError: string | null = embedder ? null : "no_embedder";
        if (embedder) {
          try {
            embedded = embeddingCoverage(deps.db(), facts, await embedder.digest({ signal: AbortSignal.timeout(1500) })).embedded;
          } catch (e) {
            embedError = e instanceof EmbedError ? e.code : "EMBED_UNAVAILABLE";
          }
        }
        kb = { facts: facts.length, lexicalIndexed: lexicalCurrent(deps.db(), facts), embedded, retrievalMode: embedded === facts.length ? "hybrid" : "lexical", embedError };
      } catch (e) {
        kb = { error: (e as Error).name };
      }
    }
    const ok = db.ok && model.reachable;
    return okResponse(ok ? 200 : 503, { ok, db, model, kb, testMode: config.testMode });
  };
}
