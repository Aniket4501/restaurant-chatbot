"use client";

import { useEffect, useMemo, useState } from "react";
import type { EntryStatus, FailureMode, FmComparison, FmRun, Register } from "@/evals/failure-modes";
import { Pill, type Tone } from "@/components/admin/ui";
import { duration, when } from "@/components/admin/evals/format";

// D-29: the failure-mode register and the latest `npm run eval:failure-modes` run, compared with the baseline run (the
// code before the fixes). Every status comes from a results file; nothing here runs or scores a test.

type RunRef = Omit<FmRun, "entries" | "bySeverity" | "byCategory" | "kind" | "registerVersion" | "durationMs">;
type Data = { register: Register; runs: RunRef[]; head: FmRun | null; base: FmRun | null; comparison: FmComparison | null };

const STATUS: Record<EntryStatus, { label: string; tone: Tone }> = { pass: { label: "passing", tone: "good" }, fail: { label: "failing", tone: "bad" }, "not run": { label: "not run", tone: "neutral" }, "no test": { label: "no test", tone: "warn" } };
const VERDICT: Record<FailureMode["verdict"], string> = { confirmed: "Confirmed", "code-level": "Code-level", "not-reproduced": "Not reproduced", "not-applicable": "Not applicable", unverified: "Unverified" };
const SEVERITIES = ["P0", "P1", "P2", "P3", "none"] as const;

export function FailureModesPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [show, setShow] = useState<"all" | "failing" | "changed">("all");

  useEffect(() => {
    let live = true;
    fetch("/api/admin/evals/failure-modes", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`);
        return (await r.json()) as Data;
      })
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const fms = useMemo(() => data?.register.failureModes ?? [], [data]);
  const now = useMemo(() => new Map((data?.head?.entries ?? []).map((e) => [e.id, e])), [data]);
  const before = useMemo(() => new Map((data?.base?.entries ?? []).map((e) => [e.id, e])), [data]);
  const cmp = data?.comparison ?? null;
  const changed = new Set([...(cmp?.resolved ?? []), ...(cmp?.newFailures ?? [])]);
  const rows = fms.filter(
    (f) => (category === "all" || f.category === category) && (severity === "all" || (f.severity ?? "none") === severity) && (show === "all" || (show === "failing" ? now.get(f.id)?.status === "fail" : changed.has(f.id))),
  );
  const catLabel = (k: string) => data?.register.categories.find((c) => c.key === k)?.label ?? k;

  return (
    <section aria-labelledby="fm-heading" className="space-y-3">
      <h2 id="fm-heading" className="font-display text-2xl">
        Failure modes
      </h2>
      <p className="max-w-3xl text-[15px] text-muted">
        The ways this chatbot was found to fail, each with a regression test named by its ID. Statuses come from <code>npm run eval:failure-modes</code>; the comparison is with the baseline run on the code before the fixes.
      </p>
      {error && <p className="text-bad">Couldn&apos;t load the failure modes: {error}</p>}
      {!data && !error && <p className="text-muted">Loading the failure modes…</p>}
      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="Failure modes" value={String(fms.length)} note={`${fms.filter((f) => f.origin === "given").length} given scenarios, ${fms.filter((f) => f.origin === "discovered").length} found in this code`} />
            <Card title="Defects found" value={String(fms.filter((f) => f.verdict === "confirmed" || f.verdict === "code-level").length)} note={`${fms.filter((f) => f.verdict === "confirmed").length} reproduced, ${fms.filter((f) => f.verdict === "code-level").length} from the code; ${fms.filter((f) => f.verdict === "not-reproduced" || f.verdict === "not-applicable").length} held up`} />
            {data.head ? (
              <Card
                title="Passing now"
                value={`${data.head.counts.pass} of ${data.head.counts.entries}`}
                note={`${data.head.counts.testsPassed} of ${data.head.counts.tests} tests passed${data.head.counts.fail ? `, ${data.head.counts.fail} failing` : ""}${data.head.counts.noTest ? `; ${data.head.counts.noTest} with no test` : ""}${data.head.counts.notRun ? `; ${data.head.counts.notRun} not run` : ""}`}
              />
            ) : (
              <Card title="Passing now" value="No run yet" note="Run npm run eval:failure-modes to record one." />
            )}
            <Card
              title="Release gate"
              value={data.head ? (data.head.gate.ok ? "Not blocked" : "Blocked") : "No run yet"}
              tone={data.head ? (data.head.gate.ok ? "good" : "bad") : "neutral"}
              note={data.head && !data.head.gate.ok ? data.head.gate.blocking.map((b) => `${b.id}: ${b.reason}`).join("; ") : data.register.releaseGate.rule}
            />
          </div>

          {data.head && (
            <p className="text-[14px] text-muted">
              Run {when(data.head.startedAt)} on code {data.head.gitSha ?? "unknown"}
              {data.head.gitDirty ? " (with uncommitted changes)" : ""}, {data.head.source.e2e ? "unit, integration and E2E tests" : "unit and integration tests only"}
              {data.head.durationMs !== null ? `, took ${duration(data.head.durationMs)}` : ""}.
              {data.base && cmp && ` Compared with ${data.base.label ?? data.base.id} (code ${data.base.gitSha ?? "unknown"}): ${cmp.resolved.length} resolved, ${cmp.newFailures.length} new failures, ${cmp.recurring.length} still failing.`}
            </p>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="overflow-x-auto rounded-2xl border border-line bg-paper p-4">
              <table className="w-full text-[14px]">
                <caption className="pb-2 text-left font-medium">By severity</caption>
                <thead className="text-left text-muted">
                  <tr>
                    <th className="py-1 font-normal">Severity</th>
                    <th className="py-1 font-normal">Entries</th>
                    <th className="py-1 font-normal">Passing now</th>
                    <th className="py-1 font-normal">At baseline</th>
                  </tr>
                </thead>
                <tbody>
                  {SEVERITIES.map((s) => {
                    const of = fms.filter((f) => (f.severity ?? "none") === s);
                    if (!of.length) return null;
                    return (
                      <tr key={s} className="border-t border-line">
                        <td className="py-1.5">{s === "none" ? "No defect" : s}</td>
                        <td className="py-1.5 tabular-nums">{of.length}</td>
                        <td className="py-1.5 tabular-nums">{data.head ? of.filter((f) => now.get(f.id)?.status === "pass").length : "–"}</td>
                        <td className="py-1.5 tabular-nums">{data.base ? of.filter((f) => before.get(f.id)?.status === "pass").length : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto rounded-2xl border border-line bg-paper p-4">
              <table className="w-full text-[14px]">
                <caption className="pb-2 text-left font-medium">By area</caption>
                <thead className="text-left text-muted">
                  <tr>
                    <th className="py-1 font-normal">Area</th>
                    <th className="py-1 font-normal">Entries</th>
                    <th className="py-1 font-normal">Passing now</th>
                    <th className="py-1 font-normal">At baseline</th>
                  </tr>
                </thead>
                <tbody>
                  {data.register.categories.map((c) => {
                    const of = fms.filter((f) => f.category === c.key);
                    if (!of.length) return null;
                    return (
                      <tr key={c.key} className="border-t border-line">
                        <td className="py-1.5">{c.label}</td>
                        <td className="py-1.5 tabular-nums">{of.length}</td>
                        <td className="py-1.5 tabular-nums">{data.head ? of.filter((f) => now.get(f.id)?.status === "pass").length : "–"}</td>
                        <td className="py-1.5 tabular-nums">{data.base ? of.filter((f) => before.get(f.id)?.status === "pass").length : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[14px]">
              <span className="block text-muted">Area</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="min-h-11 rounded-xl border border-line bg-paper px-3">
                <option value="all">All areas</option>
                {data.register.categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[14px]">
              <span className="block text-muted">Severity</span>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="min-h-11 rounded-xl border border-line bg-paper px-3">
                <option value="all">All</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s === "none" ? "No defect" : s}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[14px]">
              <span className="block text-muted">Show</span>
              <select value={show} onChange={(e) => setShow(e.target.value as typeof show)} className="min-h-11 rounded-xl border border-line bg-paper px-3">
                <option value="all">Every entry</option>
                <option value="failing">Failing now</option>
                <option value="changed">Changed since the baseline</option>
              </select>
            </label>
            <p className="pb-2 text-[14px] text-muted">
              {rows.length} of {fms.length} shown
            </p>
          </div>

          <ul className="space-y-2" aria-label="Failure modes">
            {rows.map((f) => {
              const e = now.get(f.id);
              const b = before.get(f.id);
              return (
                <li key={f.id} className="rounded-2xl border border-line bg-paper">
                  <details>
                    <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                      <span className="font-medium tabular-nums">{f.id}</span>
                      <span className="min-w-0 flex-1 wrap-anywhere">{f.title}</span>
                      <span className="text-[13px] text-muted">{f.severity ?? "no defect"}</span>
                      <Pill tone={e ? STATUS[e.status].tone : "neutral"}>{e ? STATUS[e.status].label : "no run"}</Pill>
                    </summary>
                    <div className="space-y-2 border-t border-line px-4 py-3 text-[14px]">
                      <p className="text-muted">
                        {catLabel(f.category)} · {VERDICT[f.verdict]} · fix: {f.fix}
                        {f.likelihood ? ` · likelihood ${f.likelihood}` : ""}
                        {f.scenario ? ` · given scenario ${f.scenario}` : ""}
                        {b ? ` · at baseline: ${STATUS[b.status].label}` : ""}
                      </p>
                      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[10rem_1fr]">
                        {(
                          [
                            ["Trigger", f.trigger],
                            ["Expected", f.expected],
                            ["What happened", f.actual],
                            ["Impact", f.impact],
                            ["Root cause", f.rootCause],
                            ["Resolution", f.resolution],
                            ["Remaining risk", f.remainingRisk],
                            ["Shown at baseline", f.baselineEvidence],
                            ["Reproduce", f.repro],
                          ] as const
                        )
                          .filter(([, v]) => v)
                          .map(([k, v]) => (
                            <div key={k} className="contents">
                              <dt className="text-muted">{k}</dt>
                              <dd className="min-w-0 wrap-anywhere">{k === "Reproduce" ? <code>{v}</code> : v}</dd>
                            </div>
                          ))}
                      </dl>
                      {e && e.tests.length > 0 && (
                        <div>
                          <p className="text-muted">Tests in this run</p>
                          <ul className="mt-1 space-y-1">
                            {e.tests.map((t) => (
                              <li key={`${t.file}:${t.name}`} className="wrap-anywhere">
                                <Pill tone={t.status === "passed" ? "good" : t.status === "failed" ? "bad" : "neutral"}>{t.status}</Pill> <code className="text-[13px]">{t.file}</code> {t.name}
                                {t.failure && <span className="block text-bad">{t.failure}</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function Card({ title, value, note, tone }: { title: string; value: string; note: string; tone?: Tone }) {
  return (
    <div className="rounded-2xl border border-line bg-paper p-4">
      <p className="text-[14px] text-muted">{title}</p>
      <p className={`mt-1 font-display text-3xl ${tone === "bad" ? "text-bad" : tone === "good" ? "text-neem" : ""}`}>{value}</p>
      <p className="mt-1 text-[13px] text-muted wrap-anywhere">{note}</p>
    </div>
  );
}
