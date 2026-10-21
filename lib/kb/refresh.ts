import type { DB } from "@/lib/db/client";
import { immediate } from "@/lib/db/tx";
import { docText, EmbedError, type Embedder } from "@/lib/kb/embedder";
import { indexedText, loadFactSource, renderKbFacts, type Fact } from "@/lib/kb/facts";
import { contentHash, embeddingCoverage, rebuildLexical } from "@/lib/kb/index";

// The index refresher (D-25). Staff edits rebuild the keyword index inside their own transaction (lib/admin/common.ts);
// this embeds whatever then lacks a current vector, so semantic retrieval comes back as soon as possible:
// - one run at a time per database, coalesced: requests made while a run is queued join it, and a request made while
//   one is running queues exactly one more;
// - vectors are written only for facts whose text is still the text that was embedded (re-read in the write
//   transaction), and vectors of facts that no longer exist are deleted, so stale vectors are never kept or used;
// - each knowledge document is embedded separately, so one failing document is reported against that document and the
//   menu, the FAQs and the other documents still get their vectors;
// - every run is a kb_jobs row (status, stages, counts, error), which the admin shows.
// While any retrievable fact lacks a current vector, retrieval runs keyword-only (D-13, unchanged).

export type RefreshFailure = { owner: string; documentId: number | null; error: string };
export type RefreshResult = {
  ok: boolean;
  facts: number;
  embedded: number;
  reused: number;
  deleted: number;
  failures: RefreshFailure[];
  /** Every current fact has a current vector after the run. */
  complete: boolean;
  /** Facts changed while the run embedded, so another run is needed. */
  changed: boolean;
  model: string | null;
  digest: string | null;
  error: string | null;
};

const describe = (e: unknown) => (e instanceof EmbedError ? `${e.code}: ${e.message}` : e instanceof Error && e.name === "TimeoutError" ? "EMBED_TIMEOUT: the embedding model did not answer in time" : "Unexpected error while embedding");

const docSlugOf = (id: string) => (id.startsWith("doc:") ? id.split(":")[1] : null);

/** One refresh pass (no job bookkeeping): embed missing and stale facts, store, prune, record per-document errors. */
export async function refreshIndex(db: DB, embedder: Embedder | null, now: number, opts: { signal?: AbortSignal; batchSize?: number } = {}): Promise<RefreshResult> {
  const base = { facts: 0, embedded: 0, reused: 0, deleted: 0, failures: [] as RefreshFailure[], complete: false, changed: false, model: embedder?.model ?? null, digest: null as string | null };
  const snapshot = renderKbFacts(loadFactSource(db));
  // The keyword index always matches the current facts, whatever happens to the embedding below.
  immediate(db, () => rebuildLexical(db, snapshot));
  if (!embedder) return { ...base, ok: false, facts: snapshot.length, error: "No embedding model is configured, so search is keyword-only." };
  let digest: string;
  try {
    digest = await embedder.digest({ signal: opts.signal });
  } catch (e) {
    return { ...base, ok: false, facts: snapshot.length, error: describe(e) };
  }
  const cov = embeddingCoverage(db, snapshot, digest);
  const todoIds = new Set([...cov.missing, ...cov.stale]);
  const todo = snapshot.filter((f) => todoIds.has(f.id));
  const groups = new Map<string, Fact[]>();
  for (const f of todo) {
    const owner = docSlugOf(f.id) ?? "catalog";
    groups.set(owner, [...(groups.get(owner) ?? []), f]);
  }
  const vectors = new Map<string, { hash: string; v: Float32Array }>();
  const failures: RefreshFailure[] = [];
  const size = opts.batchSize ?? 16;
  for (const [owner, facts] of groups) {
    try {
      for (let i = 0; i < facts.length; i += size) {
        const batch = facts.slice(i, i + size);
        const out = await embedder.embed(batch.map((f) => docText(indexedText(f))), { signal: opts.signal });
        batch.forEach((f, j) => vectors.set(f.id, { hash: contentHash(f), v: out[j] }));
      }
    } catch (e) {
      for (const f of facts) vectors.delete(f.id);
      failures.push({ owner, documentId: null, error: describe(e) });
    }
  }

  const written = immediate(db, () => {
    const current = renderKbFacts(loadFactSource(db));
    rebuildLexical(db, current);
    const hashes = new Map(current.map((f) => [f.id, contentHash(f)]));
    const up = db.prepare(`INSERT INTO fact_embeddings (fact_id, model, model_digest, content_hash, dim, vector, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id, model_digest) DO UPDATE SET model = excluded.model, content_hash = excluded.content_hash, dim = excluded.dim, vector = excluded.vector, created_at = excluded.created_at`);
    let embedded = 0;
    for (const [id, { hash, v }] of vectors) {
      if (hashes.get(id) !== hash) continue; // edited again while embedding: the next run embeds the new text
      up.run(id, embedder.model, digest, hash, v.length, Buffer.from(v.buffer, v.byteOffset, v.byteLength), now);
      embedded++;
    }
    const deleted = db.prepare(`DELETE FROM fact_embeddings WHERE fact_id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(current.map((f) => f.id))).changes;
    // Per-document embedding state, shown on the document's page.
    const docs = db.prepare("SELECT id, slug FROM kb_documents").all() as { id: number; slug: string }[];
    const failed = new Map(failures.filter((f) => f.owner !== "catalog").map((f) => [f.owner, f.error]));
    const setErr = db.prepare("UPDATE kb_documents SET embed_error = ? WHERE id = ?");
    for (const d of docs) {
      if (failed.has(d.slug)) {
        setErr.run(failed.get(d.slug)!, d.id);
        failures.find((f) => f.owner === d.slug)!.documentId = d.id;
      } else if (groups.has(d.slug)) setErr.run(null, d.id);
    }
    const after = embeddingCoverage(db, current, digest);
    const sameSet = current.length === snapshot.length && current.every((f, i) => f.id === snapshot[i].id && hashes.get(f.id) === contentHash(snapshot[i]));
    return { embedded, deleted, facts: current.length, complete: after.missing.length === 0 && after.stale.length === 0, changed: !sameSet };
  });
  return {
    ...base,
    ...written,
    reused: written.facts - todo.length,
    failures,
    digest,
    ok: failures.length === 0,
    error: failures.length ? failures.map((f) => `${f.owner === "catalog" ? "Menu and FAQs" : `Document ${f.owner}`}: ${f.error}`).join("; ") : null,
  };
}

export type JobStage = { stage: string; status: "done" | "failed" | "skipped" | "queued" | "running"; detail: string | null };
export type Job = {
  id: number;
  kind: "ingest" | "refresh";
  documentId: number | null;
  documentTitle: string | null;
  trigger: string;
  status: "queued" | "running" | "succeeded" | "failed";
  stages: JobStage[];
  summary: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

type JobRow = { id: number; kind: Job["kind"]; document_id: number | null; document_title: string | null; trigger: string; status: Job["status"]; stages: string; summary: string | null; error: string | null; created_at: number; started_at: number | null; finished_at: number | null };
const toJob = (r: JobRow): Job => ({
  id: r.id,
  kind: r.kind,
  documentId: r.document_id,
  documentTitle: r.document_title,
  trigger: r.trigger,
  status: r.status,
  stages: JSON.parse(r.stages) as JobStage[],
  summary: r.summary,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export function listJobs(db: DB, opts: { limit?: number; documentId?: number } = {}): Job[] {
  return (db.prepare("SELECT * FROM kb_jobs WHERE (? IS NULL OR document_id = ?) ORDER BY id DESC LIMIT ?").all(opts.documentId ?? null, opts.documentId ?? null, opts.limit ?? 20) as JobRow[]).map(toJob);
}

export function insertJob(db: DB, now: number, j: { kind: Job["kind"]; trigger: string; status: Job["status"]; documentId?: number | null; documentTitle?: string | null; stages?: JobStage[]; summary?: string | null; error?: string | null; finished?: boolean }): number {
  return Number(
    db
      .prepare("INSERT INTO kb_jobs (kind, document_id, document_title, trigger, status, stages, summary, error, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(j.kind, j.documentId ?? null, j.documentTitle ?? null, j.trigger.slice(0, 40), j.status, JSON.stringify(j.stages ?? []), j.summary ?? null, j.error ?? null, now, j.finished ? now : null, j.finished ? now : null).lastInsertRowid,
  );
}

const KEEP_JOBS = 200;

export type Refresher = {
  /** Queue a refresh (or join the queued one) and start it in the background. Returns the job id. */
  request(trigger: string): number;
  /** Resolves when no refresh is queued or running. */
  idle(): Promise<void>;
};

export type RefresherDeps = {
  db: () => DB;
  embedder: () => Embedder | null;
  now: () => number;
  timeoutMs?: number;
  /**
   * After a failed run, retry after each of these delays in turn, then wait for the next request (failure-mode audit
   * FM-020: after an embedding-model outage nothing re-ran the refresh, so retrieval stayed keyword-only until staff
   * acted). `schedule` is injected so tests control time.
   */
  retry?: { delaysMs: number[]; schedule: (fn: () => void, ms: number) => void };
};

const defaultRetry: NonNullable<RefresherDeps["retry"]> = {
  delaysMs: [60_000, 5 * 60_000, 15 * 60_000],
  schedule: (fn, ms) => void setTimeout(fn, ms).unref?.(),
};

/**
 * A background refresher for one database. Jobs left "queued" or "running" by a previous process (a restart mid-run)
 * are marked failed on creation, so the admin never shows a run that isn't happening.
 */
export function createRefresher(deps: RefresherDeps): Refresher {
  let loop: Promise<void> | null = null;
  let interrupted = false;
  const retry = deps.retry ?? defaultRetry;
  let failedRuns = 0;
  let retryScheduled = false;
  const db = () => deps.db();
  const markInterrupted = () => {
    if (interrupted) return;
    interrupted = true;
    db()
      .prepare("UPDATE kb_jobs SET status = 'failed', error = 'Interrupted: the server restarted before this run finished.', finished_at = ? WHERE status IN ('queued','running')")
      .run(deps.now());
  };

  const runOne = async (): Promise<boolean> => {
    const d = db();
    const job = d.prepare("SELECT id FROM kb_jobs WHERE kind = 'refresh' AND status = 'queued' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (!job) return false;
    const started = deps.now();
    d.prepare("UPDATE kb_jobs SET status = 'running', started_at = ?, stages = ? WHERE id = ?").run(started, JSON.stringify([{ stage: "embed", status: "running", detail: null }]), job.id);
    let r: RefreshResult;
    try {
      r = await refreshIndex(d, deps.embedder(), deps.now(), { signal: AbortSignal.timeout(deps.timeoutMs ?? 300_000) });
    } catch (e) {
      r = { ok: false, facts: 0, embedded: 0, reused: 0, deleted: 0, failures: [], complete: false, changed: false, model: null, digest: null, error: e instanceof Error ? `Unexpected error: ${e.message.slice(0, 200)}` : "Unexpected error" };
    }
    const summary = `${r.facts} facts: ${r.embedded} embedded, ${r.reused} already current, ${r.deleted} old vectors removed${r.complete ? "" : "; some facts still have no vector"}`;
    const stages: JobStage[] = [
      { stage: "keyword", status: "done", detail: `${r.facts} facts` },
      { stage: "embed", status: r.ok ? "done" : "failed", detail: r.ok ? `${r.embedded} embedded, ${r.reused} current` : r.error },
    ];
    d.prepare("UPDATE kb_jobs SET status = ?, finished_at = ?, summary = ?, error = ?, stages = ? WHERE id = ?").run(r.ok ? "succeeded" : "failed", deps.now(), summary, r.error, JSON.stringify(stages), job.id);
    // A bounded retry after a failure with an embedding model configured; a success resets the count.
    if (r.ok) failedRuns = 0;
    else if (deps.embedder() && failedRuns < retry.delaysMs.length && !retryScheduled) {
      retryScheduled = true;
      retry.schedule(() => {
        retryScheduled = false;
        try {
          self.request("retry");
        } catch (e) {
          // The database went away (a test reset or shutdown): nothing to retry.
          console.error(JSON.stringify({ event: "kb_refresh_retry_error", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
        }
      }, retry.delaysMs[failedRuns++]);
    }
    // Facts changed while embedding: one more run picks up the new text.
    if (r.ok && r.changed && !d.prepare("SELECT 1 FROM kb_jobs WHERE kind = 'refresh' AND status = 'queued'").get()) insertJob(d, deps.now(), { kind: "refresh", trigger: "follow-up", status: "queued" });
    d.prepare(`DELETE FROM kb_jobs WHERE id <= (SELECT id FROM kb_jobs ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(KEEP_JOBS);
    return true;
  };

  const kick = () => {
    loop ??= (async () => {
      try {
        while (await runOne());
      } catch (e) {
        // A database error (for example the E2E reset closing the file mid-run). The run is marked failed if the
        // database is still there; the next request starts a new run.
        console.error(JSON.stringify({ event: "kb_refresh_error", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
        try {
          db().prepare("UPDATE kb_jobs SET status = 'failed', error = 'Interrupted by an unexpected error; request a refresh to try again.', finished_at = ? WHERE status = 'running'").run(deps.now());
        } catch {
          /* the database is gone (reset); nothing to mark */
        }
      } finally {
        loop = null;
      }
    })();
  };

  const self: Refresher = {
    request(trigger) {
      markInterrupted();
      const d = db();
      const queued = d.prepare("SELECT id FROM kb_jobs WHERE kind = 'refresh' AND status = 'queued' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
      const id = queued?.id ?? insertJob(d, deps.now(), { kind: "refresh", trigger, status: "queued" });
      kick();
      return id;
    },
    async idle() {
      while (loop) await loop;
    },
  };
  return self;
}

/**
 * At server start: a refresh that a restart interrupted, or whose last run failed, runs again (FM-020; previously it
 * waited for the next staff edit or a manual refresh).
 */
export function resumeRefresh(db: DB, refresher: Refresher): number | null {
  const last = db.prepare("SELECT status FROM kb_jobs WHERE kind = 'refresh' ORDER BY id DESC LIMIT 1").get() as { status: string } | undefined;
  return last && last.status !== "succeeded" ? refresher.request("startup") : null;
}
