"use client";

import { useEffect, useRef, useState } from "react";
import { describeExpect } from "@/evals/describe";
import type { CaseDetail as Detail, CaseResult, JobRequest } from "@/components/admin/evals/types";
import { duration, STATUS_LABEL, STATUS_TONE, when } from "@/components/admin/evals/format";

// D-21: one case, everything the run recorded for it: per turn the input, the reply and cards, the tool calls and
// validation results (trace), the booking state, the facts retrieved, and each check with its result. Guest inputs
// in results are synthetic and masked; no prompts or model reasoning are stored.

type TraceEntry = NonNullable<CaseResult["turns"][number]["trace"]>[number];

export function traceLine(t: TraceEntry): string {
  const x = t as Record<string, unknown> & { action: string };
  switch (x.action) {
    case "retrieve":
      return `Retrieved facts (${x.mode}${x.reason ? `, ${x.reason}` : ""}): ${(x.ids as string[]).join(", ") || "none"}`;
    case "model_call":
      return `Model call ${x.attempt}: ${x.result}`;
    case "check_availability": {
      const a = x.args as Record<string, unknown>;
      return `Checked availability: ${a.branch}, ${a.date}, ${a.partySize} guests${a.time ? ` at ${a.time}` : a.window ? `, ${a.window}` : ""} → ${x.result} (${x.slots} times, ${x.alternatives} alternatives)`;
    }
    case "ask_field":
      return `Asked for the ${x.field}${x.reason ? ` (${x.reason})` : ""}`;
    case "ignore_field":
      return `Ignored the model's ${x.field} (${x.reason})`;
    case "correct_field":
      return `Corrected the ${x.field} (${x.reason})`;
    case "prefs": {
      const p = x.prefs as Record<string, unknown>;
      const on = Object.entries(p).filter(([, v]) => (Array.isArray(v) ? v.length : v !== null && v !== false)).map(([k, v]) => `${k} ${JSON.stringify(v)}`);
      return `Preferences: ${on.join(", ") || "none"}${(x.added as string[]).length ? ` (code changed: ${(x.added as string[]).join(", ")})` : ""}`;
    }
    case "eligible":
      return x.none ? `Dishes that fit: ${x.count} (${x.none})` : `Dishes that fit: ${x.count}`;
    case "recommend":
      return `Chooser attempt ${x.attempt}: ${x.result}${x.pick ? `, picked ${x.pick}` : ""}${(x.alternatives as string[]).length ? ` (+ ${(x.alternatives as string[]).join(", ")})` : ""}${(x.rejected as string[]).length ? ` — rejected: ${(x.rejected as string[]).join("; ")}` : ""}`;
    case "menu":
      return `Menu list: ${x.course ?? "by preference"}, ${x.items} dishes`;
    case "confirm":
      return `Confirm card: ${x.branch} at ${when(new Date(x.startsAt as number).toISOString())}`;
    case "answer_faq":
      return `Answered from facts: ${(x.ids as string[]).join(", ")}${x.rendered ? " (written by code)" : ""}`;
    case "fallback_unknown":
      return `Fallback, not answered (${x.reason})`;
    case "create_reservation": {
      const r = x.result as { status: number; code: string | null; ref: string | null };
      return `Reservation submit: HTTP ${r.status}${r.code ? ` ${r.code}` : ""}${r.ref ? `, ref ${r.ref}` : ""}`;
    }
    case "degraded":
      return `Degraded reply (${x.code})`;
    default: {
      const rest = Object.fromEntries(Object.entries(x).filter(([k]) => k !== "action"));
      return `${x.action.replace(/_/g, " ")}${Object.keys(rest).length ? `: ${JSON.stringify(rest)}` : ""}`;
    }
  }
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
      className="min-h-11 rounded-full border border-line bg-paper px-4 text-[14px] hover:border-neem hover:text-neem"
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function CaseDetailDialog({ runId, caseId, onClose, onRerun, rerunDisabled }: { runId: string; caseId: string; onClose: () => void; onRerun: (r: JobRequest) => void; rerunDisabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    let live = true;
    fetch(`/api/admin/evals/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`);
        return r.json() as Promise<Detail>;
      })
      .then((j) => live && setData(j))
      .catch((e: Error) => live && setError(`Couldn't load this case: ${e.message}`));
    return () => {
      live = false;
    };
  }, [runId, caseId]);

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="case-title" className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-3xl overflow-y-auto border-l border-line bg-ash p-0 text-ink backdrop:bg-ink/40">
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-paper px-5 py-4">
        <div className="min-w-0">
          <h2 id="case-title" className="font-display text-2xl break-all">
            {caseId}
          </h2>
          {data && (
            <p className="text-[14px] text-muted">
              {data.area} · {data.results[0].category} · {data.results[0].severity} · run {data.run.id}
            </p>
          )}
        </div>
        <button type="button" onClick={() => dialog.current?.close()} className="min-h-11 shrink-0 rounded-full border border-line px-4 text-[15px] hover:border-neem hover:text-neem">
          Close
        </button>
      </div>
      <div className="space-y-5 px-5 py-5">
        {error && (
          <p role="alert" className="rounded-xl bg-bad-tint px-4 py-3 text-bad">
            {error}
          </p>
        )}
        {!data && !error && <p className="text-muted">Loading the case…</p>}
        {data && (
          <>
            <div className="flex flex-wrap gap-2">
              <Copy text={caseId} label="Copy case ID" />
              <Copy text={data.rerun.command} label="Copy rerun command" />
              <button type="button" disabled={rerunDisabled} onClick={() => onRerun(data.rerun.request)} className="min-h-11 rounded-full bg-neem px-4 text-[14px] text-white hover:bg-neem-dark disabled:opacity-50">
                Rerun this case
              </button>
            </div>
            <p className="text-[14px] text-muted">
              <span className="font-medium text-ink">Rerun from a terminal:</span> <code className="break-all rounded bg-paper px-1.5 py-0.5">{data.rerun.command}</code>
            </p>
            {data.spec?.notes && <p className="rounded-xl border border-line bg-paper px-4 py-3 text-[15px]">{data.spec.notes}</p>}
            {data.spec?.variantOf && <p className="text-[14px] text-muted">A noisy variant of {data.spec.variantOf}: its intent should match that case&apos;s.</p>}
            {data.results.map((r) => (
              <ResultView key={r.run} r={r} repeats={data.results.length} />
            ))}
          </>
        )}
      </div>
    </dialog>
  );
}

function ResultView({ r, repeats }: { r: CaseResult; repeats: number }) {
  const expected = describeExpect(r.expect?.expect);
  return (
    <section aria-label={repeats > 1 ? `Run ${r.run}` : "Result"} className="space-y-3 rounded-2xl border border-line bg-paper p-4">
      <div className="flex flex-wrap items-center gap-2">
        {repeats > 1 && <h3 className="font-display text-xl">Run {r.run}</h3>}
        <span className={`rounded-full px-2.5 py-0.5 text-[13px] font-medium ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
        <span className="text-[13px] text-muted">
          {duration(r.durationMs)} · {r.modelCalls} model calls
        </span>
      </div>
      {(r.failures.length > 0 || r.violations.length > 0) && (
        <div className="rounded-xl bg-bad-tint px-4 py-3 text-[14px] text-bad">
          <p className="font-medium">Why it failed</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {r.failures.map((f, i) => (
              <li key={`f${i}`}>{f}</li>
            ))}
            {r.violations.map((v, i) => (
              <li key={`v${i}`}>
                {v.inv}
                {v.turn !== null ? ` (turn ${v.turn + 1})` : ""}: {v.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(expected.length > 0 || (r.expect?.forbidden.length ?? 0) > 0) && (
        <div className="text-[14px]">
          <p className="font-medium">Expected for the whole case</p>
          <ul className="mt-1 list-disc pl-5 text-muted">
            {expected.map((e) => (
              <li key={e}>{e}</li>
            ))}
            {r.expect?.forbidden.map((f) => (
              <li key={f}>never: {f.replace(/_/g, " ")}</li>
            ))}
          </ul>
        </div>
      )}
      <ol className="space-y-3">
        {r.turns.map((t, i) => (
          <li key={i} className="rounded-xl border border-line bg-ash/60 p-3">
            <p className="text-[13px] text-muted">
              Turn {t.index + 1} · {t.kind}
              {t.intent ? ` · intent ${t.intent}` : ""}
              {t.outcome ? ` · ${t.outcome}` : ""}
              {t.latencyMs !== null ? ` · ${t.latencyMs.toLocaleString("en-GB")} ms` : ""}
            </p>
            {t.timing && (
              <p className="text-[13px] text-muted">
                {t.timing.calls} model call{t.timing.calls === 1 ? "" : "s"}
                {t.timing.turnModelMs !== null ? ` · turn model ${t.timing.turnModelMs.toLocaleString("en-GB")} ms` : ""}
                {t.timing.chooserMs !== null ? ` · chooser ${t.timing.chooserMs.toLocaleString("en-GB")} ms` : ""}
                {t.timing.retrievalMs !== null ? ` · retrieval ${t.timing.retrievalMs} ms (${t.retrievalMode ?? "?"})` : ""}
                {t.timing.evalTokens !== null ? ` · ${t.timing.evalTokens} tokens written, ${t.timing.uncachedPromptTokens ?? "?"} prompt tokens read` : ""}
              </p>
            )}
            <p className="mt-1 text-[15px]">
              <span className="font-medium">Guest:</span> {t.input}
            </p>
            {t.reply && (
              <p className="mt-1 text-[15px]">
                <span className="font-medium">Reply:</span> {t.reply}
              </p>
            )}
            {t.blocks.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
                {t.blocks.map((b, k) => (
                  <li key={k}>Shown: {b}</li>
                ))}
              </ul>
            )}
            {(t.trace?.length ?? 0) > 0 && (
              <details className="mt-2 text-[13px]">
                <summary className="cursor-pointer text-neem">Tool calls and validation ({t.trace!.length})</summary>
                <ul className="mt-1 space-y-0.5 pl-1">
                  {t.trace!.map((x, k) => (
                    <li key={k}>{traceLine(x)}</li>
                  ))}
                </ul>
                {t.draft && (
                  <p className="mt-1 text-muted">
                    Booking state after the turn: {Object.entries(t.draft).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ") || "empty"}
                  </p>
                )}
              </details>
            )}
            {(t.checks?.length ?? 0) > 0 && (
              <ul className="mt-2 space-y-0.5 text-[13px]">
                {t.checks!.filter((c) => !c.ok || !c.key.startsWith("ux.")).map((c, k) => (
                  <li key={k} className={c.ok ? "text-neem" : "text-bad"}>
                    {c.ok ? "✓" : "✗"} {c.key}: {c.ok ? describeCheckOk(c.key) : c.detail.replace(/^turn \d+: /, "")}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

const describeCheckOk = (key: string) => (key.startsWith("recommend") ? "met" : key === "replyLength" ? "short enough" : "as expected");
