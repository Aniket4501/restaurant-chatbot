import { getConfig } from "@/lib/config";
import { closeDb, getDb } from "@/lib/db/client";
import { embedderFor } from "@/lib/kb/embedder";
import { refreshIndex } from "@/lib/kb/refresh";
import { getNow } from "@/lib/time/now";

// npm run kb:index   Rebuilds kb_fts, embeds new or changed facts (menu, FAQs, aggregates and knowledge documents) with
// the configured embedder, and deletes vectors of removed facts (D-13). Exits non-zero if any embed call fails.
// It runs the refresher's pass (D-25), which re-reads the facts in its write transaction, so running it while the server
// is up never deletes or overwrites vectors that staff edits stored meanwhile (failure-mode audit FM-030).
const config = getConfig();
const db = getDb();
try {
  const embedder = embedderFor(config);
  const r = await refreshIndex(db, embedder, getNow(), { signal: AbortSignal.timeout(300_000) });
  if (r.ok) {
    const again = r.changed ? " Facts changed while embedding; run it again to embed them." : "";
    console.log(`kb:index ${r.facts} facts: ${r.embedded} embedded, ${r.reused} unchanged, ${r.deleted} stale vectors deleted (${embedder.provider} ${r.model} ${(r.digest ?? "").slice(0, 18)})${again}`);
  } else {
    console.error(`kb:index failed: ${r.error}\nkb_fts was rebuilt; retrieval stays lexical until this succeeds.`);
    process.exitCode = 1;
  }
} finally {
  closeDb();
}
