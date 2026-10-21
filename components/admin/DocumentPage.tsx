"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ChevronIcon } from "@/components/ui/icons";
import { api, btn, ConfirmDialog, describe, ErrorBox, Field, inputCls, Loading, Notice, PageHeader, Pill, plural, textareaCls, useApi, when, panel, type Tone } from "@/components/admin/ui";
import { DOC_TYPES } from "@/components/admin/labels";
import { DOC_STATE, JOB_TONE, RetrievalPreview, type Doc, type Job } from "@/components/admin/KnowledgePage";

// One knowledge document (D-25): its ingestion pipeline stage by stage, the passages generated from it with their
// index status, the extracted text, and the actions the data supports (edit, replace the file, process again,
// activate or deactivate, delete).

type Detail = { document: Doc & { sizeBytes: number | null; createdAt: number; ingestedAt: number | null; failedStage: string | null }; extracted: string | null; content: string | null; passages: { seq: number; factId: string; heading: string | null; text: string; factText: string | null; keyword: boolean; vector: boolean | null }[]; warnings: string[]; jobs: Job[]; editable: boolean };
type Branches = { branches: { slug: string; name: string; isActive: boolean }[] };

const STAGE_TONE: Record<string, Tone> = { done: "good", failed: "bad", pending: "info", skipped: "neutral", off: "neutral", unknown: "warn" };
const STAGE_WORD: Record<string, string> = { done: "Done", failed: "Failed", pending: "Waiting", skipped: "Skipped", off: "Off", unknown: "Unknown" };

export function DocumentPage({ id }: { id: string }) {
  const router = useRouter();
  const { data, error, reload } = useApi<Detail>(`/api/admin/knowledge/${id}`);
  const branches = useApi<Branches>("/api/admin/branches");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: "", docType: "other", branch: "", text: "" });
  const [fields, setFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "good" | "bad" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<null | string>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  // While the embedding is still running for this document, look again every 2 seconds.
  const waiting = data?.document.stages.some((s) => s.key === "embed" && s.status === "pending") ?? false;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [waiting, reload]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-8">
        <Back />
        <ErrorBox message={error === "Document not found." ? "This document doesn't exist (it may have been deleted)." : `Couldn't load the document. ${error}`} onRetry={reload} />
      </main>
    );
  }
  if (!data) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-8">
        <Back />
        <Loading label="Loading the document" rows={4} />
      </main>
    );
  }
  const d = data.document;

  const startEdit = () => {
    setForm({ title: d.title, docType: d.docType, branch: d.branch ?? "", text: data.extracted ?? "" });
    setFields({});
    setEditing(true);
  };

  const run = async (label: string, fn: () => Promise<{ ok: boolean; text: string; tone?: "good" | "warn" }>) => {
    if (busy) return;
    setBusy(label);
    setMessage(null);
    const r = await fn();
    setBusy(null);
    setMessage({ tone: r.ok ? (r.tone ?? "good") : "bad", text: r.text });
    await reload();
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run("save", async () => {
      const body: Record<string, unknown> = { title: form.title, docType: form.docType, branch: form.branch || null };
      if (data.editable && form.text !== (data.extracted ?? "")) body.text = form.text;
      const r = await api<{ changed: boolean; summary: string; warnings: string[] }>(`/api/admin/knowledge/${d.id}`, { method: "PATCH", body });
      if (!r.ok) {
        setFields(r.error.fields ?? {});
        return { ok: false, text: r.error.message };
      }
      setEditing(false);
      return { ok: true, tone: r.data.warnings.length ? "warn" : "good", text: r.data.changed ? `Saved (${r.data.summary}). ${body.text ? "The new text was split into passages and keyword-indexed; vectors follow in the background." : ""}${r.data.warnings.length ? ` Note: ${r.data.warnings.join(" ")}` : ""}` : "Nothing to save: no changes." };
    });
  };

  const toggle = () =>
    run("toggle", async () => {
      const r = await api(`/api/admin/knowledge/${d.id}`, { method: "PATCH", body: { isActive: !d.isActive } });
      return r.ok ? { ok: true, text: d.isActive ? "Deactivated. The chatbot no longer uses this document; its passages left the search index." : "Activated. The chatbot can use it again once it is re-indexed." } : { ok: false, text: r.error.message };
    });

  const reingest = () =>
    run("reingest", async () => {
      const r = await api<{ ok: boolean; error: string | null }>(`/api/admin/knowledge/${d.id}/reingest`, { method: "POST" });
      return r.ok ? (r.data.ok ? { ok: true, text: "Processed again." } : { ok: false, text: `Processing failed again: ${r.data.error}` }) : { ok: false, text: r.error.message };
    });

  const retryEmbedding = () =>
    run("retry", async () => {
      const r = await api("/api/admin/knowledge/refresh", { method: "POST" });
      return r.ok ? { ok: true, text: "Retrying the embedding. The status updates here when it finishes." } : { ok: false, text: r.error.message };
    });

  const replace = (e: FormEvent) => {
    e.preventDefault();
    if (!file) {
      setFields({ file: "Choose a .txt or .md file" });
      return;
    }
    void run("replace", async () => {
      const fd = new FormData();
      fd.set("file", file);
      const r = await api<{ ok: boolean; error: string | null }>(`/api/admin/knowledge/${d.id}/file`, { method: "PUT", form: fd });
      if (!r.ok) {
        setFields(r.error.fields ?? {});
        return { ok: false, text: r.error.message };
      }
      setFile(null);
      return r.data.ok ? { ok: true, text: "File replaced and processed." } : { ok: false, text: `The new file couldn't be read: ${r.data.error}` };
    });
  };

  const remove = async () => {
    setBusy("delete");
    setDeleteError(null);
    const r = await api(`/api/admin/knowledge/${d.id}`, { method: "DELETE" });
    setBusy(null);
    if (!r.ok) {
      setDeleteError(r.error.message);
      return;
    }
    router.push("/admin/knowledge");
  };

  const embed = d.stages.find((s) => s.key === "embed");

  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-8">
      <Back />
      <PageHeader
        title={d.title}
        description={
          <>
            {d.docTypeLabel} · {d.branchLabel ? `${d.branchLabel} only` : "All branches"} · {d.source === "upload" ? `Uploaded file ${d.filename}` : "Article written here"} · added {when(d.createdAt)}
            {d.ingestedAt ? `, processed ${when(d.ingestedAt)}` : ""}
          </>
        }
        actions={<Pill tone={DOC_STATE[d.state].tone}>{DOC_STATE[d.state].label}</Pill>}
      />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {data.warnings.map((w) => (
        <Notice key={w} tone="warn" live={false}>
          {w}
        </Notice>
      ))}

      <section aria-labelledby="pipe-h" className={`${panel} p-5`}>
        <h2 id="pipe-h" className="font-display text-2xl">
          Processing
        </h2>
        <ol className="mt-3 grid gap-2 md:grid-cols-5">
          {d.stages.map((s, i) => (
            <li key={s.key} className="rounded-xl border border-line px-3 py-2">
              <p className="text-[13px] text-muted">Step {i + 1}</p>
              <p className="text-[15px] font-medium">{s.label}</p>
              <p className="mt-1">
                <Pill tone={STAGE_TONE[s.status] ?? "neutral"}>{STAGE_WORD[s.status] ?? s.status}</Pill>
              </p>
              {s.detail && <p className={`mt-1 text-[13px] ${s.status === "failed" ? "text-bad" : "text-muted"}`}>{s.detail}</p>}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[13px] text-muted">The file is read, tidied into plain text, split into passages, added to the keyword index, then embedded for meaning search. The chatbot uses it once the keyword index has it.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {data.editable && (
            <button type="button" className={btn.secondary} onClick={startEdit} disabled={!!busy || editing}>
              Edit
            </button>
          )}
          <button type="button" className={btn.secondary} onClick={toggle} disabled={!!busy}>
            {busy === "toggle" ? "Saving…" : d.isActive ? "Deactivate" : "Activate"}
          </button>
          {data.editable && (
            <button type="button" className={btn.secondary} onClick={reingest} disabled={!!busy}>
              {busy === "reingest" ? "Processing…" : d.state === "failed" ? "Retry processing" : "Process again"}
            </button>
          )}
          {embed?.status === "failed" && (
            <button type="button" className={btn.secondary} onClick={retryEmbedding} disabled={!!busy}>
              {busy === "retry" ? "Starting…" : "Retry embedding"}
            </button>
          )}
          <button type="button" className={`${btn.secondary} text-bad hover:border-bad hover:text-bad`} onClick={() => (setDeleteError(null), setConfirmDelete(true))} disabled={!!busy}>
            Delete
          </button>
        </div>
        {d.source === "upload" && (
          <form onSubmit={replace} className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
            <Field id="r-file" label={d.state === "failed" ? "Upload a corrected file" : "Replace the file"} error={fields.file}>
              <input {...describe("r-file", fields.file)} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-[15px] file:mr-3 file:min-h-11 file:rounded-full file:border file:border-line file:bg-paper file:px-4" />
            </Field>
            <button type="submit" className={btn.secondary} disabled={!!busy}>
              {busy === "replace" ? "Uploading…" : "Upload"}
            </button>
          </form>
        )}
      </section>

      {editing && (
        <form onSubmit={save} noValidate className={`${panel} space-y-4 p-5`} aria-label="Edit document">
          <h2 className="font-display text-2xl">Edit</h2>
          <Field id="e-title" label="Title" error={fields.title}>
            <input {...describe("e-title", fields.title)} className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="e-type" label="Type">
              <select id="e-type" className={inputCls} value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })}>
                {DOC_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="e-scope" label="Applies to" error={fields.branch}>
              <select {...describe("e-scope", fields.branch)} className={inputCls} value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                <option value="">All branches</option>
                {(branches.data?.branches ?? [])
                  .filter((b) => b.isActive)
                  .map((b) => (
                    <option key={b.slug} value={b.slug}>
                      {b.name.split(", ").pop()} only
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          {data.editable && (
            <Field id="e-text" label="Text" hint="Saving new text splits it into passages again; old passages are removed from the index." error={fields.text}>
              <textarea {...describe("e-text", fields.text, true)} className={textareaCls} rows={12} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
            </Field>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btn.secondary} onClick={() => setEditing(false)} disabled={!!busy}>
              Cancel
            </button>
            <button type="submit" className={btn.primary} disabled={!!busy}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}

      <section aria-labelledby="pass-h" className="space-y-2">
        <h2 id="pass-h" className="font-display text-2xl">
          Passages ({data.passages.length})
        </h2>
        {data.passages.length === 0 ? (
          <p className="text-[15px] text-muted">{d.state === "failed" ? "None: processing stopped before the text could be split." : "None."}</p>
        ) : (
          <ol className="space-y-2">
            {data.passages.map((p) => (
              <li key={p.seq} className={`${panel} px-4 py-3`}>
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                  Passage {p.seq}
                  {p.heading ? ` · ${p.heading}` : ""}
                  {d.isActive && <Pill tone={p.keyword ? "good" : "warn"}>{p.keyword ? "keyword indexed" : "not in the keyword index"}</Pill>}
                  {d.isActive && p.vector !== null && <Pill tone={p.vector ? "good" : "warn"}>{p.vector ? "vector stored" : "no vector yet"}</Pill>}
                </p>
                <p className="mt-1 text-[15px] leading-relaxed">{p.text}</p>
              </li>
            ))}
          </ol>
        )}
        {data.passages[0]?.factText && <p className="text-[13px] text-muted">The chatbot reads each passage with the document&apos;s title, for example: “{data.passages[0].factText.slice(0, 160)}{data.passages[0].factText.length > 160 ? "…" : ""}”</p>}
      </section>

      {data.extracted !== null && (
        <details className={`${panel} p-5`}>
          <summary className="min-h-11 cursor-pointer text-[15px] font-medium">Extracted text ({plural((data.extracted ?? "").length, "character")})</summary>
          <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-ash p-3 text-[13px] leading-relaxed whitespace-pre-wrap">{data.extracted}</pre>
        </details>
      )}

      {d.isActive && d.state !== "failed" && <RetrievalPreview initial={d.title} />}

      <section aria-labelledby="djobs-h">
        <h2 id="djobs-h" className="font-display text-2xl">
          History
        </h2>
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-paper text-[14px]">
          {data.jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-baseline justify-between gap-x-4 px-4 py-2.5">
              <span>
                {j.kind === "ingest" ? "Processed" : "Index refresh"} ({j.trigger}){j.error ? <span className="block text-bad">{j.error}</span> : j.summary ? <span className="block text-muted">{j.summary}</span> : null}
              </span>
              <span className="flex items-center gap-2">
                <Pill tone={JOB_TONE[j.status] ?? "neutral"}>{j.status}</Pill>
                <span className="text-muted">{when(j.finishedAt ?? j.createdAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this document?"
        body={<p>“{d.title}” and its {plural(d.passages, "passage")} will be removed from the knowledge base and the search index. The chatbot stops using it immediately. This can&apos;t be undone.</p>}
        confirmLabel="Delete document"
        busyLabel="Deleting…"
        error={deleteError}
        busy={busy === "delete"}
        onConfirm={remove}
        onCancel={() => busy !== "delete" && setConfirmDelete(false)}
      />
    </main>
  );
}

function Back() {
  return (
    <Link href="/admin/knowledge" className="inline-flex min-h-11 items-center gap-1 text-[15px] text-neem underline-offset-4 hover:underline">
      <ChevronIcon dir="left" className="h-4 w-4" />
      Back to the knowledge base
    </Link>
  );
}
