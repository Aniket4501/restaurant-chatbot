import { getConfig } from "@/lib/config";
import { closeDb, getDb } from "@/lib/db/client";
import { EmbedError, embedderFor } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { indexKb } from "@/lib/kb/index";
import { getNow } from "@/lib/time/now";

// npm run kb:index   Rebuilds kb_fts, embeds new or changed menu/FAQ/aggregate facts with the configured embedder,
// and deletes vectors of removed facts (D-13). Exits non-zero if any embed call fails.
const config = getConfig();
const db = getDb();
try {
  const facts = renderKbFacts(loadFactSource(db));
  const embedder = embedderFor(config);
  const r = await indexKb(db, facts, embedder, getNow(), { signal: AbortSignal.timeout(300_000) });
  console.log(`kb:index ${r.facts} facts: ${r.embedded} embedded, ${r.reused} unchanged, ${r.deleted} stale vectors deleted (${embedder.provider} ${r.model} ${r.digest.slice(0, 18)})`);
} catch (e) {
  if (e instanceof EmbedError) {
    console.error(`kb:index failed: ${e.code}: ${e.message}. kb_fts was rebuilt; retrieval stays lexical until this succeeds.`);
    process.exitCode = 1;
  } else throw e;
} finally {
  closeDb();
}
