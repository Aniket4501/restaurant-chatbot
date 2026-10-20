import { createHash } from "node:crypto";
import type { DB } from "@/lib/db/client";
import { immediate } from "@/lib/db/tx";
import { docText, type Embedder } from "@/lib/kb/embedder";
import { indexedText, type Fact } from "@/lib/kb/facts";

// The retrieval index (D-02, D-13): kb_fts for lexical search and fact_embeddings for semantic search.
// kb_fts is rebuilt whenever the seed changes (applySeed) and by kb:index. Embeddings are keyed by
// (fact_id, model digest) and carry the content hash of the exact text that was embedded.

/** sha256 of the text sent to the embedder for a fact. */
export const contentHash = (f: Fact) => createHash("sha256").update(docText(indexedText(f))).digest("hex");

/** Replace kb_fts with the given facts. Call inside the caller's transaction (applySeed) or via indexKb. */
export function rebuildLexical(db: DB, facts: Fact[]): void {
  db.prepare("DELETE FROM kb_fts").run();
  const ins = db.prepare("INSERT INTO kb_fts (fact_id, body) VALUES (?, ?)");
  for (const f of facts) ins.run(f.id, docText(indexedText(f)));
}

/** True if kb_fts holds exactly these facts with this text. */
export function lexicalCurrent(db: DB, facts: Fact[]): boolean {
  const rows = db.prepare("SELECT fact_id, body FROM kb_fts").all() as { fact_id: string; body: string }[];
  if (rows.length !== facts.length) return false;
  const want = new Map(facts.map((f) => [f.id, docText(indexedText(f))]));
  return rows.every((r) => want.get(r.fact_id) === r.body);
}

export type Coverage = { total: number; embedded: number; missing: string[]; stale: string[] };

function vectorRows(db: DB, digest: string) {
  return new Map(
    (db.prepare("SELECT fact_id, content_hash, dim, vector FROM fact_embeddings WHERE model_digest = ?").all(digest) as { fact_id: string; content_hash: string; dim: number; vector: Buffer }[]).map((r) => [
      r.fact_id,
      r,
    ]),
  );
}

/** Which current facts have an up-to-date vector for this model digest (D-13 index coverage). */
export function embeddingCoverage(db: DB, facts: Fact[], digest: string): Coverage {
  const rows = vectorRows(db, digest);
  const missing: string[] = [];
  const stale: string[] = [];
  for (const f of facts) {
    const r = rows.get(f.id);
    if (!r) missing.push(f.id);
    else if (r.content_hash !== contentHash(f)) stale.push(f.id);
  }
  return { total: facts.length, embedded: facts.length - missing.length - stale.length, missing, stale };
}

/** Vectors for every fact, or null unless all are present and current (hybrid needs full coverage). */
export function loadVectors(db: DB, facts: Fact[], digest: string): Map<string, Float32Array> | null {
  const rows = vectorRows(db, digest);
  const out = new Map<string, Float32Array>();
  for (const f of facts) {
    const r = rows.get(f.id);
    if (!r || r.content_hash !== contentHash(f) || r.vector.byteLength !== r.dim * 4) return null;
    out.set(f.id, new Float32Array(new Uint8Array(r.vector).buffer)); // copy: BLOB offsets need not be 4-byte aligned
  }
  return out;
}

export type IndexReport = { facts: number; embedded: number; reused: number; deleted: number; model: string; digest: string };

/**
 * kb:index (D-13): rebuild kb_fts, embed facts that have no current vector, and delete vectors of removed facts
 * (any digest). Embedding happens outside a transaction; the writes are one IMMEDIATE transaction. If any embed
 * call fails, nothing is written apart from the lexical rebuild, and the error propagates (non-zero exit).
 */
export async function indexKb(db: DB, facts: Fact[], embedder: Embedder, now: number, opts: { batchSize?: number; signal?: AbortSignal } = {}): Promise<IndexReport> {
  immediate(db, () => rebuildLexical(db, facts));
  const digest = await embedder.digest({ signal: opts.signal });
  const cov = embeddingCoverage(db, facts, digest);
  const todo = facts.filter((f) => cov.missing.includes(f.id) || cov.stale.includes(f.id));
  const vectors: Float32Array[] = [];
  const size = opts.batchSize ?? 16;
  for (let i = 0; i < todo.length; i += size) vectors.push(...(await embedder.embed(todo.slice(i, i + size).map((f) => docText(indexedText(f))), { signal: opts.signal })));
  const ids = facts.map((f) => f.id);
  const deleted = immediate(db, () => {
    const up = db.prepare(`INSERT INTO fact_embeddings (fact_id, model, model_digest, content_hash, dim, vector, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id, model_digest) DO UPDATE SET model = excluded.model, content_hash = excluded.content_hash, dim = excluded.dim, vector = excluded.vector, created_at = excluded.created_at`);
    todo.forEach((f, i) => up.run(f.id, embedder.model, digest, contentHash(f), vectors[i].length, Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength), now));
    return db.prepare(`DELETE FROM fact_embeddings WHERE fact_id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids)).changes;
  });
  return { facts: facts.length, embedded: todo.length, reused: facts.length - todo.length, deleted, model: embedder.model, digest };
}
