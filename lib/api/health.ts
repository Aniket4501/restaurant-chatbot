import { okResponse } from "@/lib/http/json";
import type { ApiDeps } from "@/lib/api/deps";

/** GET /api/health: DB, Ollama reachability and model names/digests. No secrets, no guest data (§5.9). */
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
    const ok = db.ok && model.reachable;
    return okResponse(ok ? 200 : 503, { ok, db, model, testMode: config.testMode });
  };
}
