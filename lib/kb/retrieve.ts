import type { DB } from "@/lib/db/client";
import { LIMITS, MODEL } from "@/lib/config";
import { EmbedError, queryText, type EmbedErrorCode, type Embedder } from "@/lib/kb/embedder";
import type { Fact } from "@/lib/kb/facts";
import { loadVectors } from "@/lib/kb/index";

// Hybrid retrieval over menu, FAQ and aggregate facts (D-02, D-13): FTS5 bm25 + cosine over stored vectors,
// fused by reciprocal rank (k = 60), top 8. Any embedder problem or incomplete index → lexical only. Never throws.

/** Fixed English stopwords removed before the 16-token cap (D-13; the probe's list). */
export const STOPWORDS = new Set(
  "a an the and or of to for in on at is are am be do does did can could would will i we you my our your me us it this that there what which who how any some with without please hi hello just get have has".split(" "),
);
const MAX_TOKENS = 16;
const CANDIDATES = 20; // per list, before fusion (as the probe)
const RRF_K = 60;

/**
 * The tested FTS5 sanitiser (research SQ-41, D-08): NFKC, letter/number tokens of 2+ characters, lower-cased,
 * de-duplicated, stopwords removed (all tokens kept if nothing else remains), at most 16, each double-quoted and
 * OR-joined. Raw guest text never reaches MATCH, so no input can raise an FTS5 syntax error or become an operator.
 */
export function ftsQuery(q: string): string | null {
  const toks = [...new Set((q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 1))];
  const kept = toks.filter((t) => !STOPWORDS.has(t));
  const use = (kept.length ? kept : toks).slice(0, MAX_TOKENS);
  return use.length ? use.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ") : null;
}

/** The retrieval query for a turn (D-02): the masked latest guest message plus the previous guest turn. */
export function retrievalQuery(latestGuest: string, previousGuest?: string | null): string {
  return previousGuest ? `${latestGuest} ${previousGuest}` : latestGuest;
}

/** Fact IDs by bm25, best first (ties by fact_id). */
export function lexicalSearch(db: DB, q: string, limit = CANDIDATES): string[] {
  const m = ftsQuery(q);
  if (!m) return [];
  return (db.prepare("SELECT fact_id FROM kb_fts WHERE kb_fts MATCH ? ORDER BY bm25(kb_fts), fact_id LIMIT ?").all(m, limit) as { fact_id: string }[]).map((r) => r.fact_id);
}

/** Reciprocal-rank fusion. Ties keep first-seen order (lexical list first), as the probe did. */
export function rrf(lists: string[][], k = RRF_K): { id: string; score: number }[] {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score);
}

const isAggregate = (id: string) => id.startsWith("menu-cat:") || id.startsWith("menu-diet:");
const isDoc = (id: string) => id.startsWith("doc:");

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export type RetrievalReason = "no_embedder" | "index_incomplete" | "dimension_mismatch" | EmbedErrorCode;
export type Hit = { factId: string; score: number; source: "carry" | "lexical" | "semantic" | "both" };
export type Retrieval = {
  hits: Hit[];
  mode: "hybrid" | "lexical";
  /** Why the turn fell back to lexical (recorded in the trace and chat_turns), null in hybrid mode. */
  reason: RetrievalReason | null;
  lexicalError: boolean;
};

export type RetrieveDeps = {
  db: DB;
  /** The current retrievable facts (renderKbFacts of this turn's snapshot). */
  facts: Fact[];
  embedder: Embedder | null;
  timeoutMs?: number;
};

/**
 * Top-k facts for a (masked) query. `carry` holds the previous turn's cited IDs (D-13 `lastCitedIds`): those that
 * are still current retrievable facts come first, at most LIMITS.retrievalCarryMax, then the fused list fills to k
 * with at most LIMITS.retrievalAggregateMax aggregates (carried ones count).
 */
export async function retrieveFacts(query: string, opts: { carry?: string[]; topK?: number }, deps: RetrieveDeps): Promise<Retrieval> {
  const topK = opts.topK ?? LIMITS.retrievalTopK;
  const current = new Set(deps.facts.map((f) => f.id));

  let lexicalError = false;
  let lexical: string[] = [];
  try {
    lexical = lexicalSearch(deps.db, query).filter((id) => current.has(id));
  } catch {
    lexicalError = true; // unreachable with the sanitiser; never let retrieval break a turn
  }

  let semantic: string[] | null = null;
  let reason: RetrievalReason | null = null;
  if (!deps.embedder) reason = "no_embedder";
  else {
    try {
      const signal = AbortSignal.timeout(deps.timeoutMs ?? MODEL.embedTimeoutMs);
      const digest = await deps.embedder.digest({ signal });
      const vectors = loadVectors(deps.db, deps.facts, digest);
      if (!vectors) reason = "index_incomplete";
      else {
        const [qv] = await deps.embedder.embed([queryText(query)], { signal });
        const first = vectors.values().next().value;
        if (first && first.length !== qv.length) reason = "dimension_mismatch";
        else
          semantic = deps.facts
            .map((f) => ({ id: f.id, s: dot(qv, vectors.get(f.id)!) }))
            .sort((a, b) => b.s - a.s)
            .slice(0, CANDIDATES)
            .map((x) => x.id);
      }
    } catch (e) {
      reason = e instanceof EmbedError ? e.code : "EMBED_UNAVAILABLE";
    }
  }

  const fused = semantic ? rrf([lexical, semantic]) : rrf([lexical]);
  const inLex = new Set(lexical);
  const inSem = new Set(semantic ?? []);
  // At most 2 aggregates per turn, carried ones included: they are long, and generic "… dishes" queries would
  // otherwise fill the top 8 with them and push out the items asked about (T-10 measurement: cap 1/2/3 → probe
  // hybrid recall 0.958/0.950/0.942, list-question hit 0.9/1.0/1.0).
  // Knowledge document passages (D-25) are capped the same way, at LIMITS.retrievalDocMax per turn.
  let aggregates = 0;
  let docs = 0;
  const carry = [...new Set(opts.carry ?? [])]
    .filter((id) => current.has(id))
    .filter((id) => !isAggregate(id) || ++aggregates <= LIMITS.retrievalAggregateMax)
    .filter((id) => !isDoc(id) || ++docs <= LIMITS.retrievalDocMax)
    .slice(0, LIMITS.retrievalCarryMax);
  aggregates = carry.filter(isAggregate).length;
  docs = carry.filter(isDoc).length;
  const hits: Hit[] = carry.map((id) => ({ factId: id, score: fused.find((f) => f.id === id)?.score ?? 0, source: "carry" }));
  for (const f of fused) {
    if (hits.length >= topK) break;
    if (carry.includes(f.id)) continue;
    if (isAggregate(f.id)) {
      if (aggregates >= LIMITS.retrievalAggregateMax) continue;
      aggregates++;
    }
    if (isDoc(f.id)) {
      if (docs >= LIMITS.retrievalDocMax) continue;
      docs++;
    }
    hits.push({ factId: f.id, score: f.score, source: inLex.has(f.id) && inSem.has(f.id) ? "both" : inLex.has(f.id) ? "lexical" : "semantic" });
  }
  return { hits: hits.slice(0, topK), mode: semantic ? "hybrid" : "lexical", reason: semantic ? null : reason, lexicalError };
}
