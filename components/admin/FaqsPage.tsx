"use client";

import { useMemo, useState, type FormEvent } from "react";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { api, btn, describe, EmptyState, ErrorBox, Field, inputCls, Loading, Modal, Notice, PageHeader, Pill, plural, textareaCls, useApi, when } from "@/components/admin/ui";
import { FAQ_CATEGORIES, shortBranch } from "@/components/admin/labels";

// FAQ management (D-25): curated questions and answers, the chatbot's faq:<slug> facts. Search and filters, a warning
// when two active FAQs ask the same thing, an editor with a preview of the answer and a real test of the chatbot.

type Faq = { slug: string; question: string; answer: string; category: string; categoryLabel: string; branch: string | null; branchLabel: string | null; isActive: boolean; createdBy: "seed" | "staff"; updatedAt: number | null };
type Conflict = { kind: "duplicate" | "conflict"; a: string; b: string; message: string };
type List = { items: Faq[]; conflicts: Conflict[]; counts: { total: number; active: number; inactive: number } };
type Detail = { faq: Faq; fact: { id: string; text: string } | null; index: { keyword: string; vector: string }; warnings: string[]; conflicts: Conflict[]; changes: { id: number; at: number; summary: string }[] };
type Branches = { branches: { slug: string; name: string; isActive: boolean }[] };
type Answer = { text: string; outcome: string; model: string; latencyMs: number; cited: { id: string; text: string | null }[] };

export function FaqsPage({ initialOpen }: { initialOpen: string | null }) {
  const { data, error, reload } = useApi<List>("/api/admin/faqs");
  const branches = useApi<Branches>("/api/admin/branches");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [scope, setScope] = useState("");
  const [status, setStatus] = useState("active");
  const [open, setOpenRaw] = useState<string | "new" | null>(initialOpen);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const setOpen = (slug: string | "new" | null) => {
    setEditorNotice(null);
    setOpenRaw(slug);
  };

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.items ?? []).filter(
      (f) =>
        (!term || f.question.toLowerCase().includes(term) || f.answer.toLowerCase().includes(term)) &&
        (!category || f.category === category) &&
        (!scope || (scope === "all" ? f.branch === null : f.branch === scope)) &&
        (status === "any" || (status === "active" ? f.isActive : !f.isActive)),
    );
  }, [data, q, category, scope, status]);
  const inConflict = new Set((data?.conflicts ?? []).flatMap((c) => [c.a, c.b]));
  const active = (branches.data?.branches ?? []).filter((b) => b.isActive);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8">
      <PageHeader
        title="FAQs"
        description="Curated questions and answers. The chatbot finds the relevant ones for each guest question and answers from them; inactive FAQs are never used."
        actions={
          <button type="button" className={btn.primary} onClick={() => setOpen("new")}>
            <PlusIcon className="h-5 w-5" />
            Add an FAQ
          </button>
        }
      />
      {notice && <Notice tone="good">{notice}</Notice>}
      {error && <ErrorBox message={`Couldn't load the FAQs. ${error}`} onRetry={reload} />}
      {!data && !error && <Loading label="Loading the FAQs" />}
      {data && (
        <>
          {data.conflicts.length > 0 && (
            <section aria-label="Possible conflicts" className="space-y-2">
              {data.conflicts.map((c) => (
                <div key={`${c.a}-${c.b}`} role="status" className="rounded-xl border border-warn/30 bg-warn-tint px-4 py-3 text-[15px] text-warn">
                  <p>
                    <span className="font-medium">{c.kind === "duplicate" ? "Duplicate" : "Possible conflict"}:</span> {c.message}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-3 text-[14px]">
                    <button type="button" className="underline underline-offset-4" onClick={() => setOpen(c.a)}>
                      Open the first
                    </button>
                    <button type="button" className="underline underline-offset-4" onClick={() => setOpen(c.b)}>
                      Open the second
                    </button>
                  </p>
                </div>
              ))}
            </section>
          )}
          <p className="text-[14px] text-muted">
            {plural(data.counts.active, "active FAQ")}, {data.counts.inactive} inactive.
          </p>
          <section aria-label="Filters" className="grid gap-2 rounded-xl border border-line bg-paper p-2 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
            <div className="relative">
              <label htmlFor="faq-q" className="sr-only">
                Search FAQs
              </label>
              <SearchIcon className="pointer-events-none absolute top-3 left-3 h-5 w-5 text-muted" />
              <input id="faq-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions and answers" className={`${inputCls} pl-10`} />
            </div>
            <label htmlFor="faq-cat" className="sr-only">
              Category
            </label>
            <select id="faq-cat" value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
              <option value="">All categories</option>
              {FAQ_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <label htmlFor="faq-scope" className="sr-only">
              Scope
            </label>
            <select id="faq-scope" value={scope} onChange={(e) => setScope(e.target.value)} className={inputCls}>
              <option value="">Any scope</option>
              <option value="all">All branches</option>
              {active.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {shortBranch(b.name)} only
                </option>
              ))}
            </select>
            <label htmlFor="faq-status" className="sr-only">
              Status
            </label>
            <select id="faq-status" value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="any">Active and inactive</option>
            </select>
          </section>
          {items.length === 0 ? (
            <EmptyState title={data.items.length ? "No FAQs match" : "No FAQs yet"} action={<button type="button" className={btn.secondary} onClick={() => setOpen("new")}>Add an FAQ</button>}>
              {data.items.length ? "Try another search or filter." : "Add the questions guests ask most, with the answers you want the chatbot to give."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-paper">
              {items.map((f) => (
                <li key={f.slug} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <button type="button" onClick={() => setOpen(f.slug)} className="min-h-11 text-left text-[15px] font-medium underline-offset-4 hover:text-neem hover:underline">
                      {f.question}
                    </button>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {inConflict.has(f.slug) && <Pill tone="warn">Check for conflict</Pill>}
                      <Pill tone="info">{f.categoryLabel}</Pill>
                      <Pill tone={f.isActive ? "good" : "neutral"}>{f.isActive ? "Active" : "Inactive"}</Pill>
                    </span>
                  </div>
                  <p className="text-[14px] text-muted">{f.answer}</p>
                  <p className="mt-1 text-[13px] text-muted">
                    {f.branchLabel ? `${f.branchLabel} only` : "All branches"}
                    {f.createdBy === "staff" ? " · added by staff" : ""}
                    {f.updatedAt ? ` · edited ${when(f.updatedAt)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <FaqEditor
        key={open ?? "closed"}
        slug={open}
        notice={editorNotice}
        branches={active}
        onClose={() => setOpen(null)}
        onSaved={async (text, slug) => {
          setNotice(text);
          setOpenRaw(slug ?? open);
          setEditorNotice(text);
          await reload();
        }}
      />
    </main>
  );
}

/** Keyed by the FAQ it edits, so each opening starts from that FAQ's saved state. */
function FaqEditor({ slug, notice, branches, onClose, onSaved }: { slug: string | "new" | null; notice: string | null; branches: { slug: string; name: string }[]; onClose: () => void; onSaved: (text: string, slug?: string) => void }) {
  const isNew = slug === "new";
  const detail = useApi<Detail>(slug && !isNew ? `/api/admin/faqs/${slug}` : null);
  const [form, setForm] = useState<{ question: string; answer: string; category: string; branch: string; isActive: boolean } | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const f = form ?? (isNew ? { question: "", answer: "", category: "general", branch: "", isActive: true } : detail.data ? { question: detail.data.faq.question, answer: detail.data.faq.answer, category: detail.data.faq.category, branch: detail.data.faq.branch ?? "", isActive: detail.data.faq.isActive } : null);
  const set = (p: Partial<NonNullable<typeof f>>) => f && setForm({ ...f, ...p });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!f || busy) return;
    const local: Record<string, string> = {};
    if (f.question.trim().length < 5) local.question = "Write the question as a guest would ask it";
    if (f.answer.trim().length < 2) local.answer = "Write the answer";
    setFields(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    setError(null);
    const body = { question: f.question, answer: f.answer, category: f.category, branch: f.branch || null, isActive: f.isActive };
    const r = isNew ? await api<{ faq: Faq }>("/api/admin/faqs", { body }) : await api<{ changed: boolean; summary: string; faq: Faq }>(`/api/admin/faqs/${slug}`, { method: "PATCH", body });
    setBusy(false);
    if (!r.ok) {
      setFields(r.error.fields ?? {});
      setError(r.error.message);
      return;
    }
    setForm(null);
    const out = r.data as { faq: Faq; changed?: boolean; summary?: string };
    const text = isNew ? `Added “${out.faq.question}”. The chatbot can use it from its next reply.` : out.changed ? `Saved “${out.faq.question}” (${out.summary}).` : "Nothing to save: no changes.";
    onSaved(text, out.faq.slug);
    if (!isNew) await detail.reload();
  };

  const test = async () => {
    if (!f || testing) return;
    setTesting(true);
    setTestError(null);
    const r = await api<Answer>("/api/admin/chat-test", { body: { question: f.question } });
    setTesting(false);
    if (r.ok) setAnswer(r.data);
    else setTestError(r.error.message);
  };

  const unsaved = !!form && !isNew;
  return (
    <Modal open={slug !== null} onClose={() => !busy && onClose()} title={isNew ? "Add an FAQ" : "Edit FAQ"} wide>
      {!isNew && detail.error && <ErrorBox message={detail.error} onRetry={detail.reload} />}
      {!f && !detail.error && <Loading label="Loading the FAQ" rows={2} />}
      {f && (
        <div className="space-y-5">
          {notice && <Notice tone="good">{notice}</Notice>}
          <form onSubmit={save} noValidate className="space-y-4" aria-label={isNew ? "New FAQ" : "Edit FAQ"}>
            <Field id="f-q" label="Question" hint="As a guest would ask it." error={fields.question}>
              <input {...describe("f-q", fields.question, true)} className={inputCls} value={f.question} onChange={(e) => set({ question: e.target.value })} maxLength={200} />
            </Field>
            <Field id="f-a" label="Answer" hint="Up to 500 characters. Keep numbers, times and prices exactly as they should be quoted." error={fields.answer}>
              <textarea {...describe("f-a", fields.answer, true)} className={textareaCls} rows={4} value={f.answer} onChange={(e) => set({ answer: e.target.value })} maxLength={500} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="f-cat" label="Category" error={fields.category}>
                <select {...describe("f-cat", fields.category)} className={inputCls} value={f.category} onChange={(e) => set({ category: e.target.value })}>
                  {FAQ_CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="f-scope" label="Applies to" error={fields.branch}>
                <select {...describe("f-scope", fields.branch)} className={inputCls} value={f.branch} onChange={(e) => set({ branch: e.target.value })}>
                  <option value="">All branches</option>
                  {branches.map((b) => (
                    <option key={b.slug} value={b.slug}>
                      {shortBranch(b.name)} only
                    </option>
                  ))}
                </select>
              </Field>
              <div className="space-y-1">
                <p className="text-[14px] font-medium">Status</p>
                <label className="flex min-h-11 items-center gap-2 text-[15px]">
                  <input type="checkbox" checked={f.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
                  Active (the chatbot may use it)
                </label>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-[15px] text-bad">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btn.secondary} onClick={onClose} disabled={busy}>
                {unsaved ? "Discard changes" : "Close"}
              </button>
              <button type="submit" className={btn.primary} disabled={busy}>
                {busy ? "Saving…" : isNew ? "Add FAQ" : "Save"}
              </button>
            </div>
          </form>

          <section aria-labelledby="fprev-h" className="space-y-2">
            <h3 id="fprev-h" className="text-[15px] font-medium">
              Preview
            </h3>
            <div className="rounded-2xl rounded-bl-md bg-neem-tint px-4 py-3 text-[15px] text-ink">{f.answer || "The answer appears here."}</div>
            <p className="text-[13px] text-muted">The chatbot words its own reply from this answer and checks every number against it; it doesn&apos;t always repeat it verbatim.</p>
            {detail.data?.warnings.map((w) => (
              <p key={w} className="text-[13px] text-warn">
                {w}
              </p>
            ))}
            {detail.data?.conflicts.map((c) => (
              <p key={c.a + c.b} className="text-[13px] text-warn">
                {c.message}
              </p>
            ))}
          </section>

          <section aria-labelledby="ftest-h" className="space-y-2 rounded-xl bg-ash p-4">
            <h3 id="ftest-h" className="text-[15px] font-medium">
              How the chatbot answers this question
            </h3>
            <p className="text-[13px] text-muted">Asks the real chatbot the question above{unsaved ? ". Save first to test your changes" : ""}. Nothing is booked.</p>
            <button type="button" className={btn.secondary} onClick={test} disabled={testing || f.question.trim().length < 2}>
              {testing ? "Asking…" : "Ask the chatbot"}
            </button>
            {testError && (
              <p role="alert" className="text-[14px] text-bad">
                {testError}
              </p>
            )}
            {answer && (
              <div aria-live="polite" className="space-y-1">
                <p className="text-[15px]">{answer.text}</p>
                <p className="text-[13px] text-muted">
                  {answer.outcome.replace(/_/g, " ")} · {(answer.latencyMs / 1000).toFixed(1)} s · cited {answer.cited.length ? answer.cited.map((c) => c.id).join(", ") : "nothing"}
                </p>
                {!isNew && slug && !answer.cited.some((c) => c.id === `faq:${slug}`) && <p className="text-[13px] text-warn">It didn&apos;t use this FAQ. Another source matched better, or the FAQ is inactive.</p>}
              </div>
            )}
          </section>

          {!isNew && detail.data && (
            <p className="text-[13px] text-muted">
              Keyword search: {detail.data.index.keyword.replace("_", " ")} · semantic search: {detail.data.index.vector.replace("_", " ")}
              {detail.data.changes[0] ? ` · last change ${when(detail.data.changes[0].at)}` : ""}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
