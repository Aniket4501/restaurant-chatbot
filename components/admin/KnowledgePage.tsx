"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PlusIcon, SearchIcon, UploadIcon } from "@/components/ui/icons";
import { api, btn, describe, EmptyState, ErrorBox, Field, inputCls, Loading, Modal, Notice, PageHeader, Pill, plural, textareaCls, useApi, when, panel, type Tone } from "@/components/admin/ui";
import { DOC_TYPES, shortBranch } from "@/components/admin/labels";

// The knowledge base (D-25): the sources the chatbot retrieves from, how each is indexed, the document library, a
// retrieval preview that runs the chatbot's own search, and the index jobs. Statuses come from the stored rows.

type Stage = { key: string; label: string; status: string; detail: string | null };
export type Doc = { id: number; slug: string; title: string; docType: string; docTypeLabel: string; branch: string | null; branchLabel: string | null; source: "article" | "upload"; filename: string | null; isActive: boolean; status: string; error: string | null; embedError: string | null; updatedAt: number; passages: number; state: "searchable" | "keyword_only" | "processing" | "failed" | "inactive"; stages: Stage[] };
export type Job = { id: number; kind: "ingest" | "refresh"; documentId: number | null; documentTitle: string | null; trigger: string; status: string; summary: string | null; error: string | null; createdAt: number; finishedAt: number | null };
type Overview = {
  documents: Doc[];
  builtIn: { key: string; title: string; description: string; source: string; facts: number; keyword: number; vectors: number | null; searched: boolean; href: string }[];
  index: { facts: number; keyword: number; vectors: number | null; mode: "hybrid" | "keyword"; reason: string | null; refreshPending: boolean; lastRefresh: Job | null; model: string | null };
  jobs: Job[];
  counts: { documents: number; active: number; searchable: number; keywordOnly: number; failed: number; processing: number; passages: number };
};
type Branches = { branches: { slug: string; name: string; isActive: boolean }[] };

export const DOC_STATE: Record<Doc["state"], { label: string; tone: Tone }> = {
  searchable: { label: "Searchable", tone: "good" },
  keyword_only: { label: "Keyword search only", tone: "warn" },
  processing: { label: "Processing", tone: "info" },
  failed: { label: "Failed", tone: "bad" },
  inactive: { label: "Inactive", tone: "neutral" },
};
export const JOB_TONE: Record<string, Tone> = { succeeded: "good", failed: "bad", running: "info", queued: "info" };

export function KnowledgePage() {
  const router = useRouter();
  const { data, error, reload } = useApi<Overview>("/api/admin/knowledge");
  const branches = useApi<Branches>("/api/admin/branches");
  const [adding, setAdding] = useState<null | "article" | "upload">(null);
  const [notice, setNotice] = useState<{ tone: "good" | "bad" | "warn"; text: string; href?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");
  const [state, setState] = useState("");

  // While an index refresh is queued or running, check again every 2 seconds.
  const pending = !!data?.index.refreshPending;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [pending, reload]);

  const docs = useMemo(() => (data?.documents ?? []).filter((d) => (!q.trim() || d.title.toLowerCase().includes(q.trim().toLowerCase()) || (d.filename ?? "").toLowerCase().includes(q.trim().toLowerCase())) && (!state || d.state === state)), [data, q, state]);

  const refresh = async () => {
    setRefreshing(true);
    const r = await api("/api/admin/knowledge/refresh", { method: "POST" });
    setRefreshing(false);
    setNotice(r.ok ? { tone: "good", text: "Index refresh started. Statuses update here as it runs." } : { tone: "bad", text: r.error.message });
    await reload();
  };

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8">
      <PageHeader
        title="Knowledge base"
        description="What the chatbot looks up when it answers. Documents are split into passages and indexed for keyword and meaning search, like the menu and the FAQs."
        actions={
          <>
            <button type="button" className={btn.secondary} onClick={() => setAdding("upload")}>
              <UploadIcon className="h-5 w-5" />
              Upload a file
            </button>
            <button type="button" className={btn.primary} onClick={() => setAdding("article")}>
              <PlusIcon className="h-5 w-5" />
              Write an article
            </button>
          </>
        }
      />
      {notice && (
        <Notice tone={notice.tone}>
          {notice.text}{" "}
          {notice.href && (
            <Link href={notice.href} className="underline underline-offset-4">
              Open the document
            </Link>
          )}
        </Notice>
      )}
      {error && <ErrorBox message={`Couldn't load the knowledge base. ${error}`} onRetry={reload} />}
      {!data && !error && <Loading label="Loading the knowledge base" rows={4} />}
      {data && (
        <>
          <section aria-labelledby="index-h" className={`${panel} space-y-3 p-5`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="index-h" className="font-display text-2xl">
                Search index
              </h2>
              <button type="button" className={btn.secondary} onClick={refresh} disabled={refreshing || data.index.refreshPending}>
                {data.index.refreshPending ? "Refreshing…" : refreshing ? "Starting…" : "Refresh the index"}
              </button>
            </div>
            <p className="flex flex-wrap items-center gap-2 text-[15px]">
              The chatbot searches by {data.index.mode === "hybrid" ? <Pill tone="good">meaning and keywords</Pill> : <Pill tone="warn">keywords only</Pill>}
              {data.index.refreshPending && <Pill tone="info">refresh running</Pill>}
            </p>
            {data.index.reason && <p className="text-[14px] text-muted">{data.index.reason}</p>}
            <dl className="grid gap-x-8 gap-y-1 text-[14px] sm:grid-cols-3">
              <div>
                <dt className="text-muted">Searchable facts</dt>
                <dd className="tabular-nums">{data.index.facts}</dd>
              </div>
              <div>
                <dt className="text-muted">In the keyword index</dt>
                <dd className="tabular-nums">
                  {data.index.keyword} of {data.index.facts}
                </dd>
              </div>
              <div>
                <dt className="text-muted">With current vectors{data.index.model ? ` (${data.index.model})` : ""}</dt>
                <dd className="tabular-nums">{data.index.vectors === null ? "unknown: the embedding model didn't answer" : `${data.index.vectors} of ${data.index.facts}`}</dd>
              </div>
            </dl>
            <p className="text-[13px] text-muted">
              {data.index.lastRefresh ? (
                <>
                  Last refresh {when(data.index.lastRefresh.finishedAt)}: <Pill tone={JOB_TONE[data.index.lastRefresh.status] ?? "neutral"}>{data.index.lastRefresh.status}</Pill> {data.index.lastRefresh.error ?? data.index.lastRefresh.summary}
                </>
              ) : (
                "No refresh has run from this workspace yet; the index was built when the database was set up."
              )}
            </p>
          </section>

          <section aria-labelledby="sources-h">
            <h2 id="sources-h" className="font-display text-2xl">
              Built-in sources
            </h2>
            <div className="mt-3 overflow-hidden rounded-xl border border-line bg-paper">
              <table className="w-full text-left text-[15px]">
                <thead className="border-b border-line bg-ash/60 text-[14px] text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">Source</th>
                    <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">Where it comes from</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Facts</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Index</th>
                  </tr>
                </thead>
                <tbody>
                  {data.builtIn.map((b) => (
                    <tr key={b.key} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-3">
                        <Link href={b.href} className="font-medium underline-offset-4 hover:text-neem hover:underline">
                          {b.title}
                        </Link>
                        <p className="text-[13px] text-muted">{b.description}</p>
                      </td>
                      <td className="hidden px-4 py-3 text-[14px] text-muted md:table-cell">{b.source}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{b.facts}</td>
                      <td className="px-4 py-3 text-[14px]">
                        {b.searched ? (
                          <>
                            Keyword {b.keyword}/{b.facts}
                            <br />
                            Vectors {b.vectors === null ? "unknown" : `${b.vectors}/${b.facts}`}
                          </>
                        ) : (
                          <span className="text-muted">Always given to the chatbot</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="docs-h" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="docs-h" className="font-display text-2xl">
                Documents
              </h2>
              <p className="text-[14px] text-muted">
                {plural(data.counts.documents, "document")}, {plural(data.counts.passages, "passage")} · {data.counts.searchable} searchable{data.counts.keywordOnly ? `, ${data.counts.keywordOnly} keyword only` : ""}
                {data.counts.failed ? `, ${data.counts.failed} failed` : ""}
              </p>
            </div>
            {data.documents.length > 0 && (
              <div className="grid gap-2 rounded-xl border border-line bg-paper p-2 sm:grid-cols-[2fr_1fr]">
                <div className="relative">
                  <label htmlFor="doc-q" className="sr-only">
                    Search documents
                  </label>
                  <SearchIcon className="pointer-events-none absolute top-3 left-3 h-5 w-5 text-muted" />
                  <input id="doc-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles and file names" className={`${inputCls} pl-10`} />
                </div>
                <label htmlFor="doc-state" className="sr-only">
                  Document status
                </label>
                <select id="doc-state" value={state} onChange={(e) => setState(e.target.value)} className={inputCls}>
                  <option value="">Any status</option>
                  {Object.entries(DOC_STATE).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {data.documents.length === 0 ? (
              <EmptyState
                title="No documents yet"
                action={
                  <span className="flex flex-wrap justify-center gap-2">
                    <button type="button" className={btn.secondary} onClick={() => setAdding("upload")}>
                      Upload a .txt or .md file
                    </button>
                    <button type="button" className={btn.primary} onClick={() => setAdding("article")}>
                      Write an article
                    </button>
                  </span>
                }
              >
                The chatbot answers from the menu, the FAQs and the restaurant details. Add a policy or guide here and it can quote that too.
              </EmptyState>
            ) : docs.length === 0 ? (
              <EmptyState title="No documents match" />
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
                {docs.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <Link href={`/admin/knowledge/${d.id}`} className="font-medium underline-offset-4 hover:text-neem hover:underline">
                        {d.title}
                      </Link>
                      <p className="text-[13px] text-muted">
                        {d.docTypeLabel} · {d.branchLabel ? `${d.branchLabel} only` : "All branches"} · {d.source === "upload" ? d.filename : "Article"} · {plural(d.passages, "passage")} · updated {when(d.updatedAt)}
                      </p>
                      {d.state === "failed" && d.error && <p className="text-[13px] text-bad">{d.error}</p>}
                      {d.state === "keyword_only" && d.embedError && <p className="text-[13px] text-warn">{d.embedError}</p>}
                    </div>
                    <Pill tone={DOC_STATE[d.state].tone}>{DOC_STATE[d.state].label}</Pill>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <RetrievalPreview />

          <section aria-labelledby="jobs-h">
            <h2 id="jobs-h" className="font-display text-2xl">
              Index jobs
            </h2>
            {data.jobs.length === 0 ? (
              <p className="mt-2 text-[15px] text-muted">No jobs yet. Adding a document or editing the menu or FAQs starts one.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper text-[14px]">
                {data.jobs.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                    <span className="min-w-0">
                      <span className="font-medium">{j.kind === "ingest" ? `Ingest ${j.documentTitle ? `“${j.documentTitle}”` : "document"}` : "Index refresh"}</span> <span className="text-muted">({j.trigger})</span>
                      <span className="block text-muted">{j.error ?? j.summary ?? ""}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Pill tone={JOB_TONE[j.status] ?? "neutral"}>{j.status}</Pill>
                      <span className="text-muted">{when(j.finishedAt ?? j.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <AddDocument
        mode={adding}
        branches={(branches.data?.branches ?? []).filter((b) => b.isActive)}
        onClose={() => setAdding(null)}
        onDone={async (r) => {
          setAdding(null);
          if (r.ok) setNotice({ tone: r.warnings.length ? "warn" : "good", text: `Added and indexed for keyword search; semantic vectors follow in the background.${r.warnings.length ? ` Note: ${r.warnings.join(" ")}` : ""}`, href: `/admin/knowledge/${r.id}` });
          else setNotice({ tone: "bad", text: `The file was saved but couldn't be read: ${r.error}`, href: `/admin/knowledge/${r.id}` });
          await reload();
          if (r.ok) router.refresh();
        }}
      />
    </main>
  );
}

type IngestResult = { id: number; ok: boolean; error: string | null; warnings: string[] };

function AddDocument({ mode, branches, onClose, onDone }: { mode: null | "article" | "upload"; branches: { slug: string; name: string }[]; onClose: () => void; onDone: (r: IngestResult) => void }) {
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("other");
  const [branch, setBranch] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    if (busy) return;
    setTitle("");
    setText("");
    setFile(null);
    setFields({});
    setError(null);
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const local: Record<string, string> = {};
    if (mode === "article" && title.trim().length < 3) local.title = "Give the article a title";
    if (mode === "article" && text.trim().length < 20) local.text = "Write at least a sentence or two";
    if (mode === "upload" && !file) local.file = "Choose a .txt or .md file";
    if (mode === "upload" && file && !/\.(txt|md|markdown)$/i.test(file.name)) local.file = "Only plain text (.txt) and Markdown (.md) files can be read";
    setFields(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    let r;
    if (mode === "article") r = await api<IngestResult>("/api/admin/knowledge", { body: { title, docType, branch: branch || null, text } });
    else {
      const fd = new FormData();
      fd.set("file", file!);
      fd.set("docType", docType);
      fd.set("branch", branch);
      if (title.trim()) fd.set("title", title);
      r = await api<IngestResult>("/api/admin/knowledge", { form: fd });
    }
    setBusy(false);
    if (!r.ok) {
      setFields(r.error.fields ?? {});
      setError(r.error.message);
      return;
    }
    setTitle("");
    setText("");
    setFile(null);
    onDone(r.data);
  };

  return (
    <Modal open={mode !== null} onClose={close} title={mode === "upload" ? "Upload a file" : "Write an article"} wide>
      <form onSubmit={submit} noValidate className="space-y-4">
        {mode === "upload" && (
          <Field id="d-file" label="File" hint="Plain text (.txt) or Markdown (.md), UTF-8, up to 256 KB. PDF and Word files can't be read." error={fields.file}>
            <input {...describe("d-file", fields.file, true)} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-[15px] file:mr-3 file:min-h-11 file:rounded-full file:border file:border-line file:bg-paper file:px-4" />
          </Field>
        )}
        <Field id="d-title" label={mode === "upload" ? "Title (optional: the file name is used otherwise)" : "Title"} error={fields.title}>
          <input {...describe("d-title", fields.title)} className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="d-type" label="Type" error={fields.docType}>
            <select {...describe("d-type", fields.docType)} className={inputCls} value={docType} onChange={(e) => setDocType(e.target.value)}>
              {DOC_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="d-scope" label="Applies to" error={fields.branch}>
            <select {...describe("d-scope", fields.branch)} className={inputCls} value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {shortBranch(b.name)} only
                </option>
              ))}
            </select>
          </Field>
        </div>
        {mode === "article" && (
          <Field id="d-text" label="Text" hint="Markdown headings (# Heading) start new sections. Keep facts short and specific; the chatbot quotes booking rules word for word." error={fields.text}>
            <textarea {...describe("d-text", fields.text, true)} className={textareaCls} rows={10} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-[15px] text-bad">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? "Processing…" : mode === "upload" ? "Upload and process" : "Add article"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type Preview = { query: string; mode: "hybrid" | "lexical"; reason: string | null; hits: { rank: number; factId: string; kind: string; source: string; href: string | null; text: string; score: number; matchedBy: string }[]; note: string };
type Answer = { text: string; intent: string | null; outcome: string; retrievalMode: string; model: string; latencyMs: number; cited: { id: string; text: string | null }[] };
const KIND: Record<string, string> = { doc: "Document", menu: "Dish", faq: "FAQ", "menu-cat": "Menu list", "menu-diet": "Menu list" };
const MATCH: Record<string, string> = { both: "keywords and meaning", lexical: "keywords", semantic: "meaning", carry: "earlier turn" };

/** Run the chatbot's retrieval (and optionally a whole chat turn) for a sample question. */
export function RetrievalPreview({ initial = "" }: { initial?: string }) {
  const [q, setQ] = useState(initial);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "search" | "answer">(null);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    setAnswer(null);
    setBusy("search");
    const r = await api<Preview>("/api/admin/knowledge/preview", { body: { query: q } });
    setBusy(null);
    if (r.ok) setPreview(r.data);
    else setError(r.error.message);
  };
  const ask = async () => {
    if (busy) return;
    setError(null);
    setBusy("answer");
    const r = await api<Answer>("/api/admin/chat-test", { body: { question: q } });
    setBusy(null);
    if (r.ok) setAnswer(r.data);
    else setError(r.error.message);
  };

  return (
    <section aria-labelledby="try-h" className={`${panel} space-y-3 p-5`}>
      <h2 id="try-h" className="font-display text-2xl">
        Try a guest question
      </h2>
      <p className="text-[14px] text-muted">See what the chatbot&apos;s own search finds for a question, and optionally how it answers. Nothing is booked or saved, apart from anonymous timing metrics.</p>
      <form onSubmit={search} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="try-q" className="sr-only">
          Guest question
        </label>
        <input id="try-q" className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="What is your cancellation policy?" maxLength={300} />
        <button type="submit" className={btn.primary} disabled={!!busy || q.trim().length < 2}>
          {busy === "search" ? "Searching…" : "Search"}
        </button>
        <button type="button" className={btn.secondary} onClick={ask} disabled={!!busy || q.trim().length < 2}>
          {busy === "answer" ? "Asking the chatbot…" : "Ask the chatbot"}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-[15px] text-bad">
          {error}
        </p>
      )}
      {preview && (
        <div className="space-y-2" aria-live="polite">
          <h3 className="text-[15px] font-medium">Retrieved evidence for “{preview.query}”</h3>
          <p className="text-[13px] text-muted">
            {preview.mode === "hybrid" ? "Searched by meaning and keywords." : `Searched by keywords only. ${preview.reason ?? ""}`} {preview.note}
          </p>
          {preview.hits.length === 0 ? (
            <Notice tone="warn">Nothing matched. The chatbot would have no facts for this question and would say it doesn&apos;t have that information.</Notice>
          ) : (
            <ol className="space-y-2">
              {preview.hits.map((h) => (
                <li key={h.factId} className="rounded-xl border border-line px-3 py-2">
                  <p className="flex flex-wrap items-baseline justify-between gap-2 text-[13px] text-muted">
                    <span>
                      {h.rank}. {KIND[h.kind] ?? h.kind}:{" "}
                      {h.href ? (
                        <Link href={h.href} className="text-neem underline underline-offset-4">
                          {h.source}
                        </Link>
                      ) : (
                        h.source
                      )}
                    </span>
                    <span>
                      score {h.score.toFixed(4)} · matched by {MATCH[h.matchedBy] ?? h.matchedBy}
                    </span>
                  </p>
                  <p className="mt-1 text-[14px] leading-relaxed">{h.text}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {answer && (
        <div className="space-y-2 rounded-xl bg-ash p-4" aria-live="polite">
          <h3 className="text-[15px] font-medium">The chatbot&apos;s answer (generated, then checked)</h3>
          <p className="text-[15px]">{answer.text}</p>
          <p className="text-[13px] text-muted">
            {answer.outcome.replace(/_/g, " ")} · {answer.model} · {(answer.latencyMs / 1000).toFixed(1)} s · search {answer.retrievalMode}
          </p>
          {answer.cited.length > 0 && (
            <div>
              <p className="text-[13px] text-muted">Facts it cited:</p>
              <ul className="mt-1 space-y-1 text-[13px]">
                {answer.cited.map((c) => (
                  <li key={c.id}>{c.text ?? c.id}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
