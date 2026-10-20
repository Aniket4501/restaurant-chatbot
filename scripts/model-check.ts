import fs from "node:fs";
import path from "node:path";
import { getConfig, MODEL } from "@/lib/config";
import { openDb, type DB } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { systemInputFor } from "@/lib/chat/turn";
import { ollamaEmbedder, queryText } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { embeddingCoverage } from "@/lib/kb/index";
import { interpretEnvelope } from "@/lib/llm/client";
import { ollamaModel } from "@/lib/llm/ollama";
import { buildPrompt } from "@/lib/llm/prompt";
import { TURN_JSON_SCHEMA } from "@/lib/llm/schema";
import { getNow } from "@/lib/time/now";

// npm run model:check (§5.8, D-05, D-13, D-16). One line per check; exits 1 if a required check fails.
// Talks only to OLLAMA_BASE_URL, which lib/config restricts to 127.0.0.1, localhost or ::1.
const config = getConfig();
const base = config.ollamaBaseUrl;
let failed = false;
const line = (ok: boolean | "warn", label: string, detail: string) => {
  if (ok === false) failed = true;
  console.log(`${ok === true ? "✓" : ok === "warn" ? "!" : "✗"} ${label.padEnd(22)} ${detail}`);
};
async function call(pathname: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${base}${pathname}`, body === undefined ? { signal: AbortSignal.timeout(timeoutMs) } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
const remoteKeys = (o: Record<string, unknown> | null | undefined) => Object.keys(o ?? {}).filter((k) => /remote/i.test(k));

try {
  const v = await call("/api/version");
  line(v.status === 200, "ollama", `version ${String(v.json?.version)} at ${base}`);
} catch {
  line(false, "ollama", `cannot reach ${base}. Is \`ollama serve\` running?`);
  process.exit(1);
}

// Models present, with digests, and local (D-16).
const tags = (await call("/api/tags")).json as { models?: Record<string, unknown>[] } | null;
const tag = (name: string) => tags?.models?.find((m) => m.name === name || m.model === name);
for (const name of [config.chatModel, config.embedModel]) {
  const t = tag(name);
  if (!t) line(false, name, `not pulled. Run \`ollama pull ${name}\``);
  else line(remoteKeys(t).length === 0, name, `digest ${String(t.digest).slice(0, 12)}, ${remoteKeys(t).length ? `REMOTE (${remoteKeys(t).join(", ")})` : "local"}`);
}

// Capabilities, thinking control, runner and context (D-05).
const show = (await call("/api/show", { model: config.chatModel })).json as { capabilities?: string[]; thinking?: { values?: boolean[]; default?: boolean }; details?: { runner?: string }; model_info?: Record<string, unknown> } | null;
if (show) {
  const caps = show.capabilities ?? [];
  const ctx = Object.entries(show.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1];
  line(caps.includes("completion") && remoteKeys(show as Record<string, unknown>).length === 0, "chat capabilities", `${caps.join(", ")}; runner ${show.details?.runner ?? "?"}; model context ${String(ctx)}`);
  const thinking = show.thinking;
  line(!thinking || (thinking.values ?? []).includes(false), "thinking control", thinking ? `values [${(thinking.values ?? []).join(", ")}], default ${thinking.default}; requests send think:false` : "no thinking support (think:false is harmless)");
}
const embedShow = (await call("/api/show", { model: config.embedModel })).json as { capabilities?: string[] } | null;
if (embedShow) line((embedShow.capabilities ?? []).includes("embedding") && remoteKeys(embedShow as Record<string, unknown>).length === 0, "embed capabilities", (embedShow.capabilities ?? []).join(", "));

// A database to build the production prompt from: the configured one if it is seeded, else the eval fixture in memory.
function promptDb(): { db: DB; label: string } {
  try {
    const db = openDb(config.databasePath);
    if (db.prepare("SELECT 1 FROM restaurant").get()) return { db, label: path.relative(process.cwd(), config.databasePath) };
    db.close();
  } catch {
    /* not migrated yet */
  }
  const db = openDb(":memory:");
  migrate(db, getNow());
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync("evals/fixtures/base.json", "utf8"))), { now: getNow() });
  return { db, label: "evals/fixtures/base.json (in memory)" };
}
const { db, label } = promptDb();

// Schema round-trip with the production prompt and grammar (fails on HTTP 400 "invalid structured output grammar"),
// twice: the second call shows warm latency and prefix-cache reuse.
const model = ollamaModel({ baseUrl: base, model: config.chatModel });
const prompt = buildPrompt({ ...systemInputFor(db, getNow()), retrieved: [], draft: null, history: [], guest: "hi" });
for (const pass of ["first", "warm"]) {
  const t0 = performance.now();
  try {
    const env = await model.chat({ messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], format: TURN_JSON_SCHEMA, attempt: 1, signal: AbortSignal.timeout(MODEL.warmTimeoutMs) });
    const r = interpretEnvelope(env);
    const ms = Math.round(performance.now() - t0);
    line(r.ok, `round-trip (${pass})`, r.ok ? `valid turn (intent ${r.turn.intent}) in ${ms} ms; prompt ${env.prompt_eval_count} tokens, ${env.prompt_eval_cached_count ?? 0} cached, ${env.eval_count} out, done ${env.done_reason}` : `${r.code}: ${r.detail}`);
  } catch (e) {
    line(false, `round-trip (${pass})`, (e as Error).message);
  }
}

// num_ctx in effect: on the MLX runner it is a soft load-time value (D-05, OL-10); the app enforces its own budget.
const ps = (await call("/api/ps")).json as { models?: { name: string; context_length?: number; size?: number }[] } | null;
const loaded = ps?.models?.find((m) => m.name === config.chatModel);
line(loaded ? true : "warn", "loaded context", loaded ? `context_length ${loaded.context_length ?? "?"} (requested num_ctx ${MODEL.numCtx}; soft on MLX), resident ${((loaded.size ?? 0) / 2 ** 30).toFixed(1)} GiB` : "chat model not resident after the round-trip");

// Embedder and retrieval index coverage (D-13). Incomplete coverage is a warning: retrieval stays lexical.
const embedder = ollamaEmbedder({ baseUrl: base, model: config.embedModel });
try {
  const digest = await embedder.digest({ signal: AbortSignal.timeout(10_000) });
  const t0 = performance.now();
  const [vec] = await embedder.embed([queryText("can I bring my dog")], { signal: AbortSignal.timeout(MODEL.warmTimeoutMs) });
  line(vec.length > 0, "embedder", `dim ${vec.length}, norm ${Math.hypot(...vec).toFixed(3)}, ${Math.round(performance.now() - t0)} ms`);
  const cov = embeddingCoverage(db, renderKbFacts(loadFactSource(db)), digest);
  line(cov.embedded === cov.total ? true : "warn", "index coverage", `${cov.embedded}/${cov.total} facts embedded for this digest in ${label}${cov.embedded === cov.total ? "" : "; run `npm run kb:index` (retrieval is lexical until then)"}`);
} catch (e) {
  line(false, "embedder", (e as Error).message);
}
db.close();
console.log(failed ? "model:check failed" : "model:check passed");
process.exitCode = failed ? 1 : 0;
