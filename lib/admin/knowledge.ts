import { z } from "zod";
import type { DB } from "@/lib/db/client";
import { slug as slugSchema } from "@/lib/db/seed-schema";
import { chunkText, contentHashOf, contentWarnings, DOC_LIMITS, DOC_TYPE_LABEL, DOC_TYPES, extractText, normalizeText, uploadTypeOf, type DocType } from "@/lib/kb/documents";
import type { Embedder } from "@/lib/kb/embedder";
import { branchShortName, docFactId, loadFactSource, renderKbFacts, renderStaticFacts, type Fact } from "@/lib/kb/facts";
import { contentHash, embedFailedDocs } from "@/lib/kb/index";
import { insertJob, listJobs, type Job, type JobStage } from "@/lib/kb/refresh";
import { retrieveFacts, type Hit } from "@/lib/kb/retrieve";
import { AdminError, adminWrite, fieldError, line, notFound, ownPhones, parse, slugify } from "@/lib/admin/common";

// Knowledge base management (D-25). What the chatbot retrieves from:
// - built-in sources: the menu and FAQ tables (one fact per dish and per FAQ, plus menu list facts), and the restaurant,
//   branch and hours tables, whose facts are always in the prompt rather than searched;
// - documents staff add (an article typed here, or an uploaded .txt/.md file). A document is the source; its passages
//   (kb_chunks) are the retrievable facts "doc:<slug>:<n>".
// Ingestion runs extract → normalise → chunk → keyword index in the request, and records an "ingest" job; embedding
// follows in the background (lib/kb/refresh.ts). Every status shown is computed from the stored rows and the index
// tables, never assumed: a document is "searchable" only when its passages are in kb_fts with their current text.

export type StageStatus = "done" | "failed" | "pending" | "skipped" | "off" | "unknown";
export type PipelineStage = { key: "extract" | "normalize" | "chunk" | "keyword" | "embed"; label: string; status: StageStatus; detail: string | null };
export type DocState = "searchable" | "keyword_only" | "processing" | "failed" | "inactive";

export type AdminDocument = {
  id: number;
  slug: string;
  title: string;
  docType: DocType;
  docTypeLabel: string;
  branch: string | null;
  branchLabel: string | null;
  source: "article" | "upload";
  filename: string | null;
  sizeBytes: number | null;
  isActive: boolean;
  status: "processing" | "ready" | "failed";
  failedStage: string | null;
  error: string | null;
  embedError: string | null;
  createdAt: number;
  updatedAt: number;
  ingestedAt: number | null;
  passages: number;
  state: DocState;
  stages: PipelineStage[];
};

type DocRow = {
  id: number; slug: string; title: string; doc_type: DocType; branch_id: number | null; source: "article" | "upload"; filename: string | null; mime: string | null; size_bytes: number | null;
  raw_text: string | null; content: string | null; content_hash: string | null; is_active: number; status: "processing" | "ready" | "failed"; failed_stage: string | null; error: string | null;
  embed_error: string | null; created_at: number; updated_at: number; ingested_at: number | null;
};
type ChunkRow = { id: number; document_id: number; seq: number; heading: string | null; text: string; char_start: number; char_end: number };

const STAGE_LABEL: Record<PipelineStage["key"], string> = { extract: "Read the file", normalize: "Tidy the text", chunk: "Split into passages", keyword: "Keyword index", embed: "Semantic vectors" };

/** What the index looks like right now, for one set of fact IDs. `digest` null = the embedder couldn't be asked. */
type IndexView = { fts: Map<string, string>; vectors: Map<string, string[]>; facts: Map<string, Fact>; digest: string | null; digestError: string | null; refreshPending: boolean };

function indexView(db: DB, digest: { value: string | null; error: string | null }): IndexView {
  const facts = new Map(renderKbFacts(loadFactSource(db)).map((f) => [f.id, f]));
  const fts = new Map((db.prepare("SELECT fact_id, body FROM kb_fts").all() as { fact_id: string; body: string }[]).map((r) => [r.fact_id, r.body]));
  const vectors = new Map<string, string[]>();
  if (digest.value) for (const r of db.prepare("SELECT fact_id, content_hash FROM fact_embeddings WHERE model_digest = ?").all(digest.value) as { fact_id: string; content_hash: string }[]) vectors.set(r.fact_id, [...(vectors.get(r.fact_id) ?? []), r.content_hash]);
  const refreshPending = !!db.prepare("SELECT 1 FROM kb_jobs WHERE kind = 'refresh' AND status IN ('queued','running')").get();
  return { fts, vectors, facts, digest: digest.value, digestError: digest.error, refreshPending };
}

const keywordCurrent = (v: IndexView, f: Fact) => v.fts.get(f.id) === (f.indexText ?? f.text).normalize("NFKC");
const vectorCurrent = (v: IndexView, f: Fact) => (v.vectors.get(f.id) ?? []).includes(contentHash(f));

function toDocument(r: DocRow, passages: ChunkRow[], branches: Map<number, { slug: string; name: string; is_active: number }>, v: IndexView): AdminDocument {
  const b = r.branch_id === null ? null : branches.get(r.branch_id) ?? null;
  const ids = passages.map((c) => docFactId(r.slug, c.seq));
  const facts = ids.map((id) => v.facts.get(id)).filter((f): f is Fact => !!f);
  const failedAt = r.status === "failed" ? r.failed_stage : null;
  const order: PipelineStage["key"][] = ["extract", "normalize", "chunk"];
  const stages: PipelineStage[] = order.map((key, i) => {
    const failedIdx = failedAt ? order.indexOf(failedAt as PipelineStage["key"]) : -1;
    if (r.status === "processing") return { key, label: STAGE_LABEL[key], status: "pending", detail: null };
    if (failedIdx === i) return { key, label: STAGE_LABEL[key], status: "failed", detail: r.error };
    if (failedIdx >= 0 && i > failedIdx) return { key, label: STAGE_LABEL[key], status: "skipped", detail: null };
    const detail = key === "extract" ? (r.source === "article" ? "Typed in the editor" : `${r.filename ?? "file"}, ${Math.ceil((r.size_bytes ?? 0) / 1024)} KB`) : key === "normalize" ? `${(r.content ?? "").length.toLocaleString("en-IN")} characters` : `${passages.length} ${passages.length === 1 ? "passage" : "passages"}`;
    return { key, label: STAGE_LABEL[key], status: "done", detail };
  });
  const usable = r.status === "ready" && r.is_active === 1 && (!b || b.is_active === 1);
  const inactiveReason = r.is_active !== 1 ? "Inactive: the chatbot doesn't use it" : b && b.is_active !== 1 ? "Its branch is inactive" : null;
  let keyword: PipelineStage;
  let embed: PipelineStage;
  if (r.status !== "ready") {
    keyword = { key: "keyword", label: STAGE_LABEL.keyword, status: r.status === "failed" ? "skipped" : "pending", detail: null };
    embed = { key: "embed", label: STAGE_LABEL.embed, status: r.status === "failed" ? "skipped" : "pending", detail: null };
  } else if (!usable) {
    keyword = { key: "keyword", label: STAGE_LABEL.keyword, status: "off", detail: inactiveReason };
    embed = { key: "embed", label: STAGE_LABEL.embed, status: "off", detail: inactiveReason };
  } else {
    const kw = facts.filter((f) => keywordCurrent(v, f)).length;
    keyword = { key: "keyword", label: STAGE_LABEL.keyword, status: kw === ids.length && facts.length === ids.length ? "done" : "pending", detail: `${kw} of ${ids.length} passages` };
    if (!v.digest) embed = { key: "embed", label: STAGE_LABEL.embed, status: "unknown", detail: v.digestError ? `Couldn't ask the embedding model: ${v.digestError}` : "No embedding model" };
    else {
      const vec = facts.filter((f) => vectorCurrent(v, f)).length;
      const all = vec === ids.length;
      embed = {
        key: "embed",
        label: STAGE_LABEL.embed,
        status: all ? "done" : v.refreshPending ? "pending" : r.embed_error ? "failed" : "pending",
        detail: all ? `${vec} of ${ids.length} passages` : v.refreshPending ? `Embedding (${vec} of ${ids.length} done)` : r.embed_error ? r.embed_error : `${vec} of ${ids.length} passages; waiting for an index refresh`,
      };
    }
  }
  const state: DocState = r.status === "failed" ? "failed" : r.status === "processing" ? "processing" : !usable ? "inactive" : keyword.status !== "done" ? "processing" : embed.status === "done" ? "searchable" : "keyword_only";
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    docType: r.doc_type,
    docTypeLabel: DOC_TYPE_LABEL[r.doc_type],
    branch: b?.slug ?? null,
    branchLabel: b ? branchShortName(b.name) : null,
    source: r.source,
    filename: r.filename,
    sizeBytes: r.size_bytes,
    isActive: r.is_active === 1,
    status: r.status,
    failedStage: r.failed_stage,
    error: r.error,
    embedError: r.embed_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ingestedAt: r.ingested_at,
    passages: passages.length,
    state,
    stages: [...stages, keyword, embed],
  };
}

const branchRows = (db: DB) => new Map((db.prepare("SELECT id, slug, name, is_active FROM branches").all() as { id: number; slug: string; name: string; is_active: number }[]).map((b) => [b.id, b]));

/** Ask the embedder for its model digest, briefly; the admin works without it (vector status "unknown"). */
export async function currentDigest(embedder: Embedder | null, timeoutMs = 2000): Promise<{ value: string | null; error: string | null }> {
  if (!embedder) return { value: null, error: "no embedding model is configured" };
  try {
    return { value: await embedder.digest({ signal: AbortSignal.timeout(timeoutMs) }), error: null };
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message.slice(0, 160) : "unknown error" };
  }
}

export type KnowledgeOverview = {
  documents: AdminDocument[];
  builtIn: { key: "menu" | "faq" | "prompt"; title: string; description: string; source: string; facts: number; keyword: number; vectors: number | null; searched: boolean; href: string }[];
  index: { facts: number; keyword: number; vectors: number | null; mode: "hybrid" | "keyword"; reason: string | null; refreshPending: boolean; lastRefresh: Job | null; model: string | null };
  jobs: Job[];
  counts: { documents: number; active: number; inactive: number; searchable: number; keywordOnly: number; failed: number; processing: number; passages: number };
};

export function knowledgeOverview(db: DB, now: number, digest: { value: string | null; error: string | null }, model: string | null): KnowledgeOverview {
  const v = indexView(db, digest);
  const branches = branchRows(db);
  const chunks = db.prepare("SELECT * FROM kb_chunks ORDER BY document_id, seq").all() as ChunkRow[];
  const byDoc = new Map<number, ChunkRow[]>();
  for (const c of chunks) byDoc.set(c.document_id, [...(byDoc.get(c.document_id) ?? []), c]);
  const documents = (db.prepare("SELECT * FROM kb_documents ORDER BY updated_at DESC, id DESC").all() as DocRow[]).map((r) => toDocument(r, byDoc.get(r.id) ?? [], branches, v));
  const all = [...v.facts.values()];
  const group = (pred: (f: Fact) => boolean) => {
    const fs = all.filter(pred);
    return { facts: fs.length, keyword: fs.filter((f) => keywordCurrent(v, f)).length, vectors: v.digest ? fs.filter((f) => vectorCurrent(v, f)).length : null };
  };
  const menu = group((f) => f.kind === "menu" || f.kind === "menu-cat" || f.kind === "menu-diet");
  const faq = group((f) => f.kind === "faq");
  const src = loadFactSource(db);
  const statics = renderStaticFacts(src, now);
  const keyword = all.filter((f) => keywordCurrent(v, f)).length;
  const vectors = v.digest ? all.filter((f) => vectorCurrent(v, f)).length : null;
  const extraFts = [...v.fts.keys()].filter((id) => !v.facts.has(id)).length;
  const hybrid = vectors === all.length && keyword === all.length && extraFts === 0;
  // Say which documents hold semantic search back, and whether a refresh is actually on its way (failure-mode audit
  // FM-029: the text said "until the index refresh finishes" with none pending and named no document).
  const failedDocs = embedFailedDocs(db);
  const failedNote = failedDocs.size ? ` ${[...failedDocs.values()].map((t) => `"${t}"`).join(", ")} couldn't be embedded: open ${failedDocs.size === 1 ? "it" : "them"} to retry, or deactivate ${failedDocs.size === 1 ? "it" : "them"} to turn semantic search back on.` : "";
  const waiting = v.refreshPending ? "until the index refresh finishes" : "until the index is refreshed";
  const lastRefresh = (db.prepare("SELECT id FROM kb_jobs WHERE kind = 'refresh' AND status IN ('succeeded','failed') ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined)?.id;
  return {
    documents,
    builtIn: [
      { key: "menu", title: "Menu", description: "One fact per dish, plus a list fact for each section and dietary label.", source: "Menu table (seeded from data/seed/menu.json, then edited here)", ...menu, searched: true, href: "/admin/menu" },
      { key: "faq", title: "FAQs", description: "One fact per active question and answer.", source: "FAQ table (seeded from data/seed/faq.json, then edited here)", ...faq, searched: true, href: "/admin/faqs" },
      { key: "prompt", title: "Restaurant, branches and hours", description: "Always given to the chatbot in full, so they are never searched.", source: "Restaurant, branch, hours and special-date tables", facts: statics.length, keyword: 0, vectors: null, searched: false, href: "/admin/branches" },
    ],
    index: {
      facts: all.length,
      keyword,
      vectors,
      mode: hybrid ? "hybrid" : "keyword",
      reason: hybrid
        ? null
        : !v.digest
          ? `The embedding model couldn't be reached (${v.digestError ?? "unknown"}), so searches use keywords only.`
          : vectors !== all.length
            ? `${all.length - (vectors ?? 0)} of ${all.length} facts have no current vector, so searches use keywords only ${waiting}.${failedNote}`
            : "The keyword index is out of date; refresh the index.",
      refreshPending: v.refreshPending,
      lastRefresh: lastRefresh ? listJobs(db, { limit: 50 }).find((j) => j.id === lastRefresh) ?? null : null,
      model,
    },
    jobs: listJobs(db, { limit: 15 }),
    counts: {
      documents: documents.length,
      active: documents.filter((d) => d.isActive).length,
      inactive: documents.filter((d) => !d.isActive).length,
      searchable: documents.filter((d) => d.state === "searchable").length,
      keywordOnly: documents.filter((d) => d.state === "keyword_only").length,
      failed: documents.filter((d) => d.state === "failed").length,
      processing: documents.filter((d) => d.state === "processing").length,
      passages: chunks.length,
    },
  };
}

export type DocumentDetail = {
  document: AdminDocument;
  extracted: string | null;
  content: string | null;
  passages: { seq: number; factId: string; heading: string | null; text: string; factText: string | null; keyword: boolean; vector: boolean | null }[];
  warnings: string[];
  jobs: Job[];
  editable: boolean;
};

export function documentDetail(db: DB, id: number, digest: { value: string | null; error: string | null }): DocumentDetail {
  const r = db.prepare("SELECT * FROM kb_documents WHERE id = ?").get(id) as DocRow | undefined;
  if (!r) throw notFound("Document");
  const v = indexView(db, digest);
  const chunks = db.prepare("SELECT * FROM kb_chunks WHERE document_id = ? ORDER BY seq").all(id) as ChunkRow[];
  const document = toDocument(r, chunks, branchRows(db), v);
  return {
    document,
    extracted: r.raw_text,
    content: r.content,
    passages: chunks.map((c) => {
      const f = v.facts.get(docFactId(r.slug, c.seq));
      return { seq: c.seq, factId: docFactId(r.slug, c.seq), heading: c.heading, text: c.text, factText: f?.text ?? null, keyword: !!f && keywordCurrent(v, f), vector: v.digest ? !!f && vectorCurrent(v, f) : null };
    }),
    warnings: r.content ? contentWarnings(r.content, ownPhones(db)) : [],
    jobs: listJobs(db, { documentId: id, limit: 10 }),
    editable: r.raw_text !== null,
  };
}

// ---------- writes ----------

const Common = {
  title: line("a title", 3, 120),
  docType: z.enum(DOC_TYPES, { error: "Choose a document type" }),
  branch: slugSchema.nullable(),
};
export const ArticleSchema = z.strictObject({ ...Common, text: z.string({ error: "Write the article text" }).max(DOC_LIMITS.maxChars + 5000, `Articles can be up to ${DOC_LIMITS.maxChars.toLocaleString("en-IN")} characters`), isActive: z.boolean().default(true) });
export const UploadMetaSchema = z.strictObject({ ...Common, title: Common.title.optional() });
export const DocPatchSchema = z.strictObject({
  title: Common.title.optional(),
  docType: Common.docType.optional(),
  branch: Common.branch.optional(),
  isActive: z.boolean().optional(),
  text: z.string().max(DOC_LIMITS.maxChars + 5000).optional(),
});

function branchIdOf(db: DB, slug: string | null): number | null {
  if (slug === null) return null;
  const b = db.prepare("SELECT id, is_active FROM branches WHERE slug = ?").get(slug) as { id: number; is_active: number } | undefined;
  if (!b || b.is_active !== 1) throw fieldError("branch", `Unknown or inactive branch: ${slug}`);
  return b.id;
}

type Pipeline = { ok: true; raw: string; content: string; chunks: ReturnType<typeof chunkText> & { ok: true } } | { ok: false; stage: "extract" | "normalize" | "chunk"; error: string; raw: string | null };

/** Extract → normalise → chunk, without touching the database. */
function runPipeline(input: { bytes: Uint8Array; markdown: boolean } | { text: string; markdown: boolean }): Pipeline {
  let raw: string;
  if ("bytes" in input) {
    const x = extractText(input.bytes);
    if (!x.ok) return { ok: false, stage: "extract", error: x.error, raw: null };
    raw = x.value;
  } else raw = input.text;
  const n = normalizeText(raw, { markdown: input.markdown });
  if (!n.ok) return { ok: false, stage: "normalize", error: n.error, raw };
  const c = chunkText(n.value);
  if (!c.ok) return { ok: false, stage: "chunk", error: c.error, raw };
  return { ok: true, raw, content: n.value, chunks: c };
}

const stagesOf = (p: Pipeline, source: "article" | "upload"): JobStage[] => {
  const order = ["extract", "normalize", "chunk"] as const;
  const failed = p.ok ? -1 : order.indexOf(p.stage);
  const out: JobStage[] = order.map((s, i) => ({
    stage: s,
    status: failed === i ? "failed" : failed >= 0 && i > failed ? "skipped" : "done",
    detail: failed === i && !p.ok ? p.error : p.ok ? (s === "extract" ? (source === "article" ? "typed text" : `${p.raw.length.toLocaleString("en-IN")} characters read`) : s === "normalize" ? `${p.content.length.toLocaleString("en-IN")} characters` : `${p.chunks.value.length} passages`) : null,
  }));
  out.push({ stage: "keyword", status: p.ok ? "done" : "skipped", detail: null }, { stage: "embed", status: p.ok ? "queued" : "skipped", detail: p.ok ? "runs in the background" : null });
  return out;
};

/** Store a pipeline result for a document (inside adminWrite): chunks replaced, vectors of removed passages deleted. */
function storeResult(db: DB, now: number, doc: { id: number; slug: string; title: string }, p: Pipeline, source: "article" | "upload", trigger: string): void {
  const old = (db.prepare("SELECT seq FROM kb_chunks WHERE document_id = ?").all(doc.id) as { seq: number }[]).map((c) => docFactId(doc.slug, c.seq));
  db.prepare("DELETE FROM kb_chunks WHERE document_id = ?").run(doc.id);
  if (p.ok) {
    const ins = db.prepare("INSERT INTO kb_chunks (document_id, seq, heading, text, char_start, char_end) VALUES (?, ?, ?, ?, ?, ?)");
    for (const c of p.chunks.value) ins.run(doc.id, c.seq, c.heading, c.text, c.start, c.end);
    db.prepare("UPDATE kb_documents SET raw_text = ?, content = ?, content_hash = ?, status = 'ready', failed_stage = NULL, error = NULL, embed_error = NULL, ingested_at = ?, updated_at = ? WHERE id = ?").run(p.raw, p.content, contentHashOf(p.content), now, now, doc.id);
  } else {
    db.prepare("UPDATE kb_documents SET raw_text = ?, content = NULL, content_hash = NULL, status = 'failed', failed_stage = ?, error = ?, embed_error = NULL, updated_at = ? WHERE id = ?").run(p.raw, p.stage, p.error, now, doc.id);
  }
  // No stale passages: vectors of passages that no longer exist go now; changed ones are re-embedded by the refresher.
  const keep = new Set(p.ok ? p.chunks.value.map((c) => docFactId(doc.slug, c.seq)) : []);
  const del = db.prepare("DELETE FROM fact_embeddings WHERE fact_id = ?");
  for (const id of old) if (!keep.has(id)) del.run(id);
  insertJob(db, now, { kind: "ingest", trigger, status: p.ok ? "succeeded" : "failed", documentId: doc.id, documentTitle: doc.title, stages: stagesOf(p, source), summary: p.ok ? `${p.chunks.value.length} passages` : null, error: p.ok ? null : p.error, finished: true });
}

function uniqueSlug(db: DB, title: string): string {
  const base = slugify(title, 50);
  let slug = base;
  for (let n = 2; db.prepare("SELECT 1 FROM kb_documents WHERE slug = ?").get(slug); n++) slug = `${base}-${n}`;
  return slug;
}

function refuseDuplicate(db: DB, p: Pipeline, exceptId: number | null) {
  if (!p.ok) return;
  const dup = db.prepare("SELECT id, title FROM kb_documents WHERE content_hash = ? AND (? IS NULL OR id <> ?)").get(contentHashOf(p.content), exceptId, exceptId) as { id: number; title: string } | undefined;
  if (dup) throw new AdminError(409, "CONFLICT", `This text is already in the knowledge base as "${dup.title}".`, { existing: dup.id });
}

export type IngestResult = { id: number; ok: boolean; error: string | null; warnings: string[] };

/** A new article typed by staff. Text that can't make a document is a 400 and stores nothing. */
export function createArticle(db: DB, now: number, raw: unknown): IngestResult {
  const input = parse(ArticleSchema, raw);
  const p = runPipeline({ text: input.text, markdown: true });
  if (!p.ok) throw fieldError("text", p.error);
  return adminWrite(db, now, { reindex: true }, () => {
    const branchId = branchIdOf(db, input.branch);
    if (db.prepare("SELECT 1 FROM kb_documents WHERE lower(title) = lower(?)").get(input.title)) throw new AdminError(409, "CONFLICT", `A document called "${input.title}" already exists.`);
    refuseDuplicate(db, p, null);
    const slug = uniqueSlug(db, input.title);
    const id = Number(
      db
        .prepare("INSERT INTO kb_documents (slug, title, doc_type, branch_id, source, is_active, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'article', ?, 'processing', ?, ?)")
        .run(slug, input.title, input.docType, branchId, input.isActive ? 1 : 0, now, now).lastInsertRowid,
    );
    storeResult(db, now, { id, slug, title: input.title }, p, "article", "created");
    return { result: { id, ok: true, error: null, warnings: contentWarnings(p.content, ownPhones(db)) }, change: { area: "knowledge", action: "created", target: slug, summary: `Added the article "${input.title}" (${p.chunks.value.length} passages)` } };
  });
}

/**
 * An uploaded file. An unsupported type is refused (415) and stores nothing; a supported file that can't be read or
 * split is stored as a failed document with the reason, so staff can see it and replace the file.
 */
export function createUpload(db: DB, now: number, file: { name: string; bytes: Uint8Array }, rawMeta: unknown): IngestResult {
  const type = uploadTypeOf(file.name);
  if (!type) throw new AdminError(415, "UNSUPPORTED_FILE", `"${file.name}" isn't a supported file. Upload a plain text (.txt) or Markdown (.md) file; PDF and Word files can't be read yet.`);
  if (file.bytes.byteLength > DOC_LIMITS.maxBytes) throw new AdminError(413, "VALIDATION", `The file is ${Math.ceil(file.bytes.byteLength / 1024)} KB; the limit is ${DOC_LIMITS.maxBytes / 1024} KB.`, { fields: { file: "too large" } });
  const meta = parse(UploadMetaSchema, rawMeta);
  const title = meta.title ?? (file.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim().slice(0, 120) || "Untitled document");
  if (title.length < 3) throw fieldError("title", "Give the document a title of at least 3 characters");
  const filename = file.name.replace(/[\\/]/g, "_").slice(0, 160);
  const p = runPipeline({ bytes: file.bytes, markdown: type.markdown });
  return adminWrite(db, now, { reindex: true }, () => {
    const branchId = branchIdOf(db, meta.branch);
    if (db.prepare("SELECT 1 FROM kb_documents WHERE lower(title) = lower(?)").get(title)) throw new AdminError(409, "CONFLICT", `A document called "${title}" already exists.`);
    refuseDuplicate(db, p, null);
    const slug = uniqueSlug(db, title);
    const id = Number(
      db
        .prepare("INSERT INTO kb_documents (slug, title, doc_type, branch_id, source, filename, mime, size_bytes, is_active, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'upload', ?, ?, ?, 1, 'processing', ?, ?)")
        .run(slug, title, meta.docType, branchId, filename, type.mime, file.bytes.byteLength, now, now).lastInsertRowid,
    );
    storeResult(db, now, { id, slug, title }, p, "upload", "uploaded");
    return {
      result: { id, ok: p.ok, error: p.ok ? null : p.error, warnings: p.ok ? contentWarnings(p.content, ownPhones(db)) : [] },
      change: { area: "knowledge", action: p.ok ? "uploaded" : "upload failed", target: slug, summary: p.ok ? `Uploaded "${title}" (${filename}, ${p.chunks.value.length} passages)` : `Uploaded "${title}" (${filename}); it couldn't be read: ${p.error}` },
    };
  });
}

/** Replace a document's file. A file that can't be read is refused and the current version stays. */
export function replaceUpload(db: DB, now: number, id: number, file: { name: string; bytes: Uint8Array }): IngestResult {
  const type = uploadTypeOf(file.name);
  if (!type) throw new AdminError(415, "UNSUPPORTED_FILE", `"${file.name}" isn't a supported file. Upload a plain text (.txt) or Markdown (.md) file.`);
  const p = runPipeline({ bytes: file.bytes, markdown: type.markdown });
  return adminWrite(db, now, { reindex: true }, () => {
    const r = db.prepare("SELECT * FROM kb_documents WHERE id = ?").get(id) as DocRow | undefined;
    if (!r) throw notFound("Document");
    if (!p.ok && r.status === "ready") throw fieldError("file", `The new file couldn't be used, so the current version stays: ${p.error}`);
    refuseDuplicate(db, p, id);
    db.prepare("UPDATE kb_documents SET source = 'upload', filename = ?, mime = ?, size_bytes = ? WHERE id = ?").run(file.name.replace(/[\\/]/g, "_").slice(0, 160), type.mime, file.bytes.byteLength, id);
    storeResult(db, now, r, p, "upload", "file replaced");
    return { result: { id, ok: p.ok, error: p.ok ? null : p.error, warnings: p.ok ? contentWarnings(p.content, ownPhones(db)) : [] }, change: { area: "knowledge", action: "file replaced", target: r.slug, summary: p.ok ? `Replaced the file of "${r.title}" (${p.chunks.value.length} passages)` : `Replaced the file of "${r.title}"; it couldn't be read: ${p.error}` } };
  });
}

/**
 * Edit a document: title, type, scope, active flag, or its text (articles, and uploads whose text was read). New text
 * is ingested again; text that can't make a document is refused and the current version stays.
 */
export function updateDocument(db: DB, now: number, id: number, raw: unknown): { changed: boolean; summary: string; warnings: string[] } {
  const patch = parse(DocPatchSchema, raw);
  const p = patch.text === undefined ? null : runPipeline({ text: patch.text, markdown: true });
  if (p && !p.ok) throw fieldError("text", p.error);
  return adminWrite<{ changed: boolean; summary: string; warnings: string[] }>(db, now, { reindex: true }, () => {
    const r = db.prepare("SELECT * FROM kb_documents WHERE id = ?").get(id) as DocRow | undefined;
    if (!r) throw notFound("Document");
    if (patch.text !== undefined && r.raw_text === null) throw fieldError("text", "This file couldn't be read, so its text can't be edited; replace the file instead.");
    const parts: string[] = [];
    if (patch.title !== undefined && patch.title !== r.title) {
      if (db.prepare("SELECT 1 FROM kb_documents WHERE lower(title) = lower(?) AND id <> ?").get(patch.title, id)) throw new AdminError(409, "CONFLICT", `A document called "${patch.title}" already exists.`);
      parts.push(`title "${r.title}" → "${patch.title}"`);
    }
    if (patch.docType !== undefined && patch.docType !== r.doc_type) parts.push(`type ${DOC_TYPE_LABEL[r.doc_type]} → ${DOC_TYPE_LABEL[patch.docType]}`);
    const branchId = patch.branch === undefined ? r.branch_id : branchIdOf(db, patch.branch);
    if (branchId !== r.branch_id) parts.push("scope");
    if (patch.isActive !== undefined && patch.isActive !== (r.is_active === 1)) parts.push(patch.isActive ? "activated" : "deactivated");
    const textChanged = p?.ok && p.content !== r.content;
    if (textChanged) parts.push("text");
    if (!parts.length) return { result: { changed: false, summary: "no change", warnings: [] }, change: null };
    db.prepare("UPDATE kb_documents SET title = ?, doc_type = ?, branch_id = ?, is_active = ?, updated_at = ? WHERE id = ?").run(patch.title ?? r.title, patch.docType ?? r.doc_type, branchId, (patch.isActive ?? r.is_active === 1) ? 1 : 0, now, id);
    if (textChanged && p) {
      refuseDuplicate(db, p, id);
      storeResult(db, now, { id, slug: r.slug, title: patch.title ?? r.title }, p, r.source, "text edited");
    }
    if (patch.isActive === false) db.prepare("DELETE FROM fact_embeddings WHERE fact_id LIKE ?").run(`doc:${r.slug}:%`); // deactivated: no vectors kept
    const summary = parts.join("; ");
    const action = parts.length === 1 && (parts[0] === "activated" || parts[0] === "deactivated") ? parts[0] : "edited";
    return { result: { changed: true, summary, warnings: p?.ok ? contentWarnings(p.content, ownPhones(db)) : [] }, change: { area: "knowledge", action, target: r.slug, summary: `"${patch.title ?? r.title}": ${summary}` } };
  });
}

/** Run ingestion again from the stored text (a retry after a failure, or a re-index after a rule change). */
export function reingestDocument(db: DB, now: number, id: number): IngestResult {
  return adminWrite(db, now, { reindex: true }, () => {
    const r = db.prepare("SELECT * FROM kb_documents WHERE id = ?").get(id) as DocRow | undefined;
    if (!r) throw notFound("Document");
    if (r.raw_text === null) throw new AdminError(409, "CONFLICT", "This file couldn't be read as text, so there is nothing to process again. Replace the file with a UTF-8 .txt or .md file.");
    const markdown = r.source === "article" || r.mime === "text/markdown";
    const p = runPipeline({ text: r.raw_text, markdown });
    if (!p.ok && r.status === "ready") throw new AdminError(409, "CONFLICT", `Processing again would fail (${p.error}), so the current version stays.`);
    storeResult(db, now, r, p, r.source, "retry");
    return { result: { id, ok: p.ok, error: p.ok ? null : p.error, warnings: p.ok ? contentWarnings(p.content, ownPhones(db)) : [] }, change: { area: "knowledge", action: p.ok ? "processed again" : "retry failed", target: r.slug, summary: p.ok ? `Processed "${r.title}" again (${p.chunks.value.length} passages)` : `Processing "${r.title}" failed again: ${p.error}` } };
  });
}

/** Delete a document, its passages and their vectors; the keyword index is rebuilt in the same transaction. */
export function deleteDocument(db: DB, now: number, id: number): { title: string } {
  return adminWrite(db, now, { reindex: true }, () => {
    const r = db.prepare("SELECT id, slug, title FROM kb_documents WHERE id = ?").get(id) as { id: number; slug: string; title: string } | undefined;
    if (!r) throw notFound("Document");
    db.prepare("DELETE FROM fact_embeddings WHERE fact_id LIKE ?").run(`doc:${r.slug}:%`);
    db.prepare("DELETE FROM kb_documents WHERE id = ?").run(id); // passages go with it (ON DELETE CASCADE)
    return { result: { title: r.title }, change: { area: "knowledge", action: "deleted", target: r.slug, summary: `Deleted "${r.title}"` } };
  });
}

// ---------- retrieval preview ----------

export type PreviewHit = { rank: number; factId: string; kind: Fact["kind"]; source: string; href: string | null; text: string; score: number; matchedBy: Hit["source"] };
export type Preview = { query: string; mode: "hybrid" | "lexical"; reason: string | null; hits: PreviewHit[]; note: string };

const REASON_TEXT: Record<string, string> = {
  no_embedder: "No embedding model is configured.",
  index_incomplete: "Some facts have no current vector yet, so only keyword search ran.",
  dimension_mismatch: "Stored vectors don't match the embedding model; refresh the index.",
  EMBED_UNAVAILABLE: "The embedding model couldn't be reached, so only keyword search ran.",
  EMBED_NOT_PULLED: "The embedding model isn't installed, so only keyword search ran.",
  EMBED_TIMEOUT: "The embedding model didn't answer in time, so only keyword search ran.",
  EMBED_INVALID_OUTPUT: "The embedding model returned something unusable, so only keyword search ran.",
};

/** The chatbot's own retrieval for a sample question: the same function, facts and limits a chat turn uses. */
export async function previewRetrieval(db: DB, embedder: Embedder | null, query: string): Promise<Preview> {
  const src = loadFactSource(db);
  const facts = renderKbFacts(src);
  const byId = new Map(facts.map((f) => [f.id, f]));
  const docs = new Map((db.prepare("SELECT id, slug, title FROM kb_documents").all() as { id: number; slug: string; title: string }[]).map((d) => [d.slug, d]));
  const r = await retrieveFacts(query, {}, { db, facts, embedder });
  const sourceOf = (f: Fact): { source: string; href: string | null } => {
    if (f.kind === "doc") {
      const [, slug, seq] = f.id.split(":");
      const d = docs.get(slug);
      return { source: `${d?.title ?? slug}, passage ${seq}`, href: d ? `/admin/knowledge/${d.id}` : null };
    }
    if (f.kind === "menu") return { source: `Menu: ${f.text.split(" (")[0]}`, href: `/admin/menu/${f.id.slice(5)}` };
    if (f.kind === "faq") return { source: `FAQ: ${f.text.replace(/^\([^)]*\) /, "").replace(/^Q: /, "").split(" A: ")[0]}`, href: `/admin/faqs?open=${f.id.slice(4)}` };
    if (f.kind === "menu-cat") return { source: "Menu section list", href: "/admin/menu" };
    if (f.kind === "menu-diet") return { source: "Menu dietary list", href: "/admin/menu" };
    return { source: f.kind, href: null };
  };
  const hits = r.hits.flatMap((h, i) => {
    const f = byId.get(h.factId);
    return f ? [{ rank: i + 1, factId: f.id, kind: f.kind, ...sourceOf(f), text: f.text, score: Math.round(h.score * 10_000) / 10_000, matchedBy: h.source }] : [];
  });
  return {
    query,
    mode: r.mode,
    reason: r.reason ? (REASON_TEXT[r.reason] ?? r.reason) : null,
    hits,
    note: "Scores are rank-fusion scores (higher is better), not probabilities. Opening hours, branch details and the restaurant description are always given to the chatbot, so they never appear here.",
  };
}
