"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { BarChart, LineChart, Sparkline } from "@/components/admin/evals/Charts";
import { CaseDetailDialog } from "@/components/admin/evals/CaseDetail";
import { FailureExplorer } from "@/components/admin/evals/FailureExplorer";
import { RunControls } from "@/components/admin/evals/RunControls";
import { clock, duration, pct, pts, runLabel, shortWhen, statDelta, statValue, when } from "@/components/admin/evals/format";
import type { Job, JobRequest, Overview, RunDetail, RunSummary } from "@/components/admin/evals/types";

// D-21 evals dashboard. Everything shown is read from the runner's results files through /api/admin/evals; the run
// buttons start the real runner. With no data, the page says so instead of showing zeros.

const TREND_RUNS = 12;
const POLL_MS = 2000;

function pickDefault(runs: RunSummary[]): string | null {
  const done = runs.filter((r) => r.status === "complete");
  return (done.find((r) => r.mode === "live" && r.suite === "full") ?? done[0] ?? runs[0])?.id ?? null;
}

export function EvalsDashboard({ initial, serverNow }: { initial: Overview; serverNow: number }) {
  const router = useRouter();
  const [overview, setOverview] = useState<Overview>(initial);
  const [runId, setRunId] = useState<string | null>(() => pickDefault(initial.runs));
  const [baseId, setBaseId] = useState<string>("auto");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openCase, setOpenCase] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(initial.job);
  const [startError, setStartError] = useState<string | null>(null);
  const [now, setNow] = useState(serverNow);
  const [openArea, setOpenArea] = useState<string | null>(null);
  const detailReq = useRef(0);

  const loadOverview = useCallback(async () => {
    const r = await fetch("/api/admin/evals", { cache: "no-store" });
    if (r.status === 401) return router.replace("/admin/login");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as Overview & { now: number };
    setOverview(j);
    setNow(j.now);
    return j;
  }, [router]);

  // The selected run, its comparison and its cases.
  useEffect(() => {
    if (!runId) return;
    const id = ++detailReq.current;
    const base = baseId === "auto" ? "" : `?base=${encodeURIComponent(baseId)}`;
    fetch(`/api/admin/evals/runs/${encodeURIComponent(runId)}${base}`, { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) {
          router.replace("/admin/login");
          return null;
        }
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`);
        return (await r.json()) as RunDetail;
      })
      .then((j) => {
        if (j && id === detailReq.current) {
          setDetail(j);
          setLoadError(null);
        }
      })
      .catch((e: Error) => id === detailReq.current && setLoadError(`Couldn't load this run: ${e.message}`));
  }, [runId, baseId, router]);

  // Follow a running job; when it ends, reload the runs and show the new one.
  useEffect(() => {
    if (job?.state !== "running") return;
    const t = setInterval(async () => {
      const r = await fetch("/api/admin/evals/jobs", { cache: "no-store" }).catch(() => null);
      if (!r?.ok) return;
      const j = (await r.json()) as { job: Job | null; now: number };
      setJob(j.job);
      setNow(j.now);
      if (j.job && j.job.state !== "running") {
        await loadOverview().catch(() => null);
        if (j.job.runId) {
          setBaseId("auto");
          setRunId(j.job.runId);
        }
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [job?.state, loadOverview]);

  const start = async (request: JobRequest) => {
    setStartError(null);
    const r = await fetch("/api/admin/evals/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }).catch(() => null);
    if (!r) return setStartError("Couldn't reach the server to start the run.");
    const j = (await r.json().catch(() => null)) as { job?: Job; error?: { message: string; job?: Job } } | null;
    if (!r.ok) {
      setStartError(j?.error?.message ?? `Couldn't start the run (HTTP ${r.status}).`);
      if (j?.error?.job) setJob(j.error.job);
      return;
    }
    setJob(j?.job ?? null);
    setOpenCase(null);
  };
  const cancel = async () => {
    const r = await fetch("/api/admin/evals/jobs", { method: "DELETE" }).catch(() => null);
    const j = r?.ok ? ((await r.json()) as { job: Job | null }) : null;
    if (j) setJob(j.job);
  };

  const runs = overview.runs;
  const run = detail?.run ?? runs.find((r) => r.id === runId) ?? null;
  const cmp = detail?.comparison ?? null;
  const base = detail?.base ?? null;
  // Trends: finished runs of the same mode and suite, oldest first.
  const trend = useMemo(() => (run ? runs.filter((r) => r.status === "complete" && r.mode === run.mode && r.suite === run.suite).slice(0, TREND_RUNS).reverse() : []), [runs, run]);
  // Dates alone when the runs span several days; otherwise the time tells them apart.
  const trendLabels = trend.map((r) => (new Set(trend.map((x) => shortWhen(x.startedAt))).size > 1 && trend.length <= 6 ? shortWhen(r.startedAt) : clock(r.startedAt)));
  const areaTrend = (key: string) => trend.map((r) => r.areas.find((a) => a.key === key)?.rate ?? null);
  const passRate = (r: RunSummary) => (r.counts.executed ? r.counts.passed / r.counts.executed : null);
  const baselineId = run ? overview.baseline[`${run.mode}-${run.suite}`]?.id ?? null : null;

  return (
    <div className="min-h-dvh">
      <AdminHeader current="evals" />
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-8">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl">Evals</h1>
          <p className="mt-1 max-w-3xl text-[15px] text-muted">How the chatbot scores on its test cases, what changed since the baseline, and why each failing case failed. Every number comes from a results file in evals/results.</p>
        </div>

        <RunControls job={job} areas={overview.areas} onStart={start} onCancel={cancel} onView={(id) => { setBaseId("auto"); setRunId(id); }} startError={startError} nowMs={now} />

        {runs.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-line bg-paper px-6 py-10 text-center">
            <h2 className="font-display text-2xl">No eval runs yet</h2>
            <p className="mx-auto mt-2 max-w-xl text-muted">Start a scripted smoke run above (it takes seconds), or run <code>npm run eval:smoke</code> in a terminal. Results appear here when the run finishes.</p>
          </section>
        ) : (
          <>
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-paper p-2 lg:flex-row lg:items-center">
              <div className="flex flex-1 items-center gap-2 text-[14px]">
                <label htmlFor="eval-run" className="shrink-0 text-muted">
                  Run
                </label>
                <select id="eval-run" value={runId ?? ""} onChange={(e) => { setBaseId("auto"); setDetail(null); setRunId(e.target.value); }} className="min-h-11 w-full rounded-full border border-line bg-ash px-3 text-[14px]">
                  {runs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {runLabel(r)} · {r.counts.passed}/{r.counts.executed} passed{r.id === overview.baseline[`${r.mode}-${r.suite}`]?.id ? " · baseline" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-1 items-center gap-2 text-[14px]">
                <label htmlFor="eval-base" className="shrink-0 text-muted">
                  Compare with
                </label>
                <select id="eval-base" value={baseId} onChange={(e) => setBaseId(e.target.value)} className="min-h-11 w-full rounded-full border border-line bg-ash px-3 text-[14px]">
                  <option value="auto">{baselineId && baselineId !== runId ? "Saved baseline" : "Previous run of the same kind"}</option>
                  {runs.filter((r) => r.id !== runId).map((r) => (
                    <option key={r.id} value={r.id}>
                      {runLabel(r)}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" onClick={() => loadOverview().catch(() => setLoadError("Couldn't refresh the runs."))} className="min-h-11 shrink-0 rounded-full border border-line bg-paper px-4 text-[14px] hover:border-neem hover:text-neem">
                Refresh
              </button>
            </div>

            {loadError && (
              <p role="alert" className="rounded-xl bg-bad-tint px-4 py-3 text-bad">
                {loadError}
              </p>
            )}

            {run && <OverviewCards run={run} base={base} cmp={cmp} baseReason={detail?.baseReason ?? null} />}

            {run && (
              <section aria-labelledby="areas-heading" className="space-y-3">
                <h2 id="areas-heading" className="font-display text-2xl">
                  Quality by area
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {run.areas.map((a) => {
                    const c = cmp?.areas.find((x) => x.key === a.key);
                    const open = openArea === a.key;
                    return (
                      <article key={a.key} aria-labelledby={`area-${a.key}`} className={`rounded-2xl border bg-paper p-4 ${open ? "border-neem" : "border-line"}`}>
                        <div className="flex items-start justify-between gap-2">
                          <h3 id={`area-${a.key}`} className="text-[15px] font-medium">
                            {a.label}
                          </h3>
                          <Sparkline values={areaTrend(a.key)} label={`${a.label} pass rate`} />
                        </div>
                        <p className="mt-1 font-display text-4xl text-neem tabular-nums">{a.n ? pct(a.rate, 0) : <span className="text-2xl text-muted">No cases</span>}</p>
                        <p className="text-[13px] text-muted">
                          {a.n ? `${a.passed} of ${a.n} case results passed` : "No case in this run belongs to this area"}
                          {c?.delta != null && <span className={`ml-1.5 font-medium ${c.delta < 0 ? "text-bad" : c.delta > 0 ? "text-neem" : "text-muted"}`}>{pts(c.delta)}</span>}
                        </p>
                        <button type="button" aria-expanded={open} onClick={() => setOpenArea(open ? null : a.key)} className="mt-2 min-h-11 text-[14px] text-neem underline decoration-line underline-offset-4 hover:decoration-neem">
                          {open ? "Hide metrics" : `Metrics (${a.stats.length})`}
                        </button>
                        {open && (
                          <div className="mt-1 space-y-2">
                            <p className="text-[13px] text-muted">{a.about}</p>
                            <dl className="space-y-2">
                              {a.stats.map((s) => {
                                const st = cmp?.stats.find((x) => x.area === a.key && x.key === s.key);
                                const d = st ? statDelta(st.before.value, st.after.value, s.kind) : null;
                                return (
                                  <div key={s.key} className="rounded-lg bg-ash/70 px-3 py-2">
                                    <dt className="text-[13px] font-medium">{s.label}</dt>
                                    <dd className="text-[13px]">
                                      <span className="font-display text-lg tabular-nums">{statValue(s)}</span> <span className="text-muted">n {s.n}</span>
                                      {d && <span className={`ml-1.5 ${st?.regressed ? "text-bad" : "text-muted"}`}>{d}{st?.regressed ? " (worse)" : ""}</span>}
                                      <span className="mt-0.5 block text-muted">{s.definition}</span>
                                    </dd>
                                  </div>
                                );
                              })}
                            </dl>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {run && (
              <section aria-labelledby="trends-heading" className="space-y-3">
                <h2 id="trends-heading" className="font-display text-2xl">
                  Trends
                </h2>
                {trend.length < 2 ? (
                  <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center text-muted">Only {trend.length === 1 ? "one finished run" : "no finished run"} of this kind ({run.mode}, {run.suite}) so far. Trends appear from the second run.</p>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-2xl border border-line bg-paper p-4">
                      <h3 className="text-[15px] font-medium">Cases passed, last {trend.length} {run.mode} {run.suite} runs</h3>
                      <LineChart title="Share of cases passed per run" labels={trendLabels} yMax={1} format={(v) => `${Math.round(v * 100)}%`} series={[{ label: "Cases passed", values: trend.map(passRate), tone: "neem" }]} />
                    </div>
                    <div className="rounded-2xl border border-line bg-paper p-4">
                      <h3 className="text-[15px] font-medium">Cases not passing per run</h3>
                      <BarChart title="Cases failed, flaky or errored per run" labels={trendLabels} values={trend.map((r) => r.counts.failed + r.counts.flaky + r.counts.errored)} format={(v) => String(v)} />
                    </div>
                    {run.mode === "live" && (
                      <div className="rounded-2xl border border-line bg-paper p-4 lg:col-span-2">
                        <h3 className="text-[15px] font-medium">Turn latency (turns that called the model)</h3>
                        <LineChart width={1160} title="Turn latency per run" labels={trendLabels} format={(v) => `${(v / 1000).toFixed(1)} s`} series={[
                          { label: "p50", values: trend.map((r) => r.areas.find((a) => a.key === "reliability")?.stats.find((s) => s.key === "latencyP50")?.value ?? null), tone: "neem" },
                          { label: "p95", values: trend.map((r) => r.areas.find((a) => a.key === "reliability")?.stats.find((s) => s.key === "latencyP95")?.value ?? null), tone: "warn", dashed: true },
                        ]} />
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {run && <Regressions cmp={cmp} base={base} onOpen={setOpenCase} />}

            {detail && run && <FailureExplorer rows={detail.cases} areas={overview.areas} hasComparison={!!cmp} onOpen={setOpenCase} />}
            {!detail && !loadError && <p className="text-muted">Loading the run…</p>}
          </>
        )}
      </div>
      {openCase && runId && <CaseDetailDialog runId={runId} caseId={openCase} onClose={() => setOpenCase(null)} onRerun={start} rerunDisabled={job?.state === "running"} />}
    </div>
  );
}

function OverviewCards({ run, base, cmp, baseReason }: { run: RunSummary; base: RunSummary | null; cmp: RunDetail["comparison"]; baseReason: RunDetail["baseReason"] | null }) {
  const rate = run.counts.executed ? run.counts.passed / run.counts.executed : null;
  const baseRate = base && base.counts.executed ? base.counts.passed / base.counts.executed : null;
  const critical = run.critical.invariantViolations + run.critical.criticalCasesFailed;
  const card = "rounded-2xl border border-line bg-paper p-4";
  const statusTone = run.status === "complete" ? "text-neem" : run.status === "running" ? "text-warn" : "text-bad";
  return (
    <section aria-labelledby="overview-heading" className="space-y-3">
      <h2 id="overview-heading" className="sr-only">
        Run overview
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className={card}>
          <p className="text-[13px] text-muted">Status</p>
          <p className={`font-display text-2xl ${statusTone}`}>{run.status === "complete" ? "Complete" : run.status === "running" ? "Running" : "Interrupted"}</p>
          <p className="text-[13px] text-muted">
            {when(run.startedAt)} · {run.durationMs !== null ? `took ${duration(run.durationMs)}` : run.status === "complete" ? "duration not recorded (older results file)" : "still running or stopped"}
          </p>
          {run.status !== "complete" && <p className="mt-1 text-[13px] text-bad">Not a finished run: {run.counts.skipped} selected cases were not run, and none of them count as passed.</p>}
        </div>
        <div className={card}>
          <p className="text-[13px] text-muted">Cases passed</p>
          <p className="font-display text-4xl text-neem tabular-nums">{pct(rate)}</p>
          <p className="text-[13px] text-muted">
            {run.counts.passed} of {run.counts.executed} cases{run.config.runs > 1 ? ` (all ${run.config.runs} runs)` : ""}
            {baseRate !== null && rate !== null && <span className={`ml-1.5 font-medium ${rate < baseRate ? "text-bad" : rate > baseRate ? "text-neem" : ""}`}>{pts(rate - baseRate)}</span>}
          </p>
        </div>
        <div className={card}>
          <p className="text-[13px] text-muted">Cases</p>
          <ul className="mt-1 space-y-0.5 text-[14px] tabular-nums">
            <li>{run.counts.executed} run of {run.counts.selected} selected</li>
            <li className={run.counts.failed ? "text-bad" : ""}>{run.counts.failed} failed</li>
            <li className={run.counts.flaky ? "text-warn" : ""}>{run.counts.flaky} flaky (passed some repeats)</li>
            <li className={run.counts.errored ? "text-bad" : ""}>{run.counts.errored} could not run</li>
            <li>{run.counts.skipped} not run</li>
          </ul>
        </div>
        <div className={`${card} ${critical ? "border-bad" : ""}`}>
          <p className="text-[13px] text-muted">Critical</p>
          <p className={`font-display text-4xl tabular-nums ${critical ? "text-bad" : "text-neem"}`}>{critical}</p>
          <ul className="text-[13px] text-muted">
            <li>{run.critical.falseConfirmations} false confirmations</li>
            <li>{run.critical.duplicateBookings} duplicate bookings</li>
            <li>{run.critical.invariantViolations} invariant violations in all</li>
            <li>{run.critical.criticalCasesFailed} critical cases not passing</li>
          </ul>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className={card}>
          <p className="text-[13px] text-muted">Model and configuration</p>
          <p className="mt-1 text-[15px]">
            {run.model} · prompt {run.promptVersion ?? "?"} · chooser {run.chooserVersion ?? "?"}
          </p>
          <p className="text-[13px] text-muted">
            {run.mode === "live" ? `temperature ${run.config.temperature ?? "?"}, seed ${run.config.seed ?? "?"}, context ${run.config.numCtx ?? "?"} · ` : ""}
            code {run.gitSha ?? "unknown"}
            {run.gitDirty ? " with uncommitted changes" : ""}
            {run.changedDuringRun ? " (changed during the run)" : ""} · dataset {run.datasetHash ?? "?"}
            {run.config.loadAverage !== null ? ` · machine load ${run.config.loadAverage.toFixed(1)}` : ""}
          </p>
        </div>
        <div className={card}>
          <p className="text-[13px] text-muted">Release gates</p>
          {run.gates ? (
            <>
              <p className={`mt-1 text-[15px] font-medium ${run.gatesOk ? "text-neem" : "text-bad"}`}>
                {run.gates.filter((g) => g.ok).length} of {run.gates.length} met{run.gatesOk ? "" : ": release blocked"}
              </p>
              {!run.gatesOk && (
                <ul className="text-[13px] text-bad">
                  {run.gates.filter((g) => !g.ok).map((g) => (
                    <li key={g.metric}>
                      {g.metric}: {g.value ?? "no data"} (wanted {g.want})
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="mt-1 text-[14px] text-muted">{run.mode === "live" ? "Not applied: gates apply to a full live run." : "Scripted runs pass only when every case passes with no invariant violations."}</p>
          )}
          <p className="mt-1 text-[13px] text-muted">{base ? `Compared with ${baseReason === "baseline" ? "the saved baseline" : baseReason === "previous" ? "the previous run of the same kind" : "the chosen run"}: ${runLabel(base)}.` : "No baseline or earlier run of this kind to compare with."}</p>
          {cmp?.note && <p className="text-[13px] text-warn">{cmp.note}</p>}
        </div>
      </div>
    </section>
  );
}

function Regressions({ cmp, base, onOpen }: { cmp: RunDetail["comparison"]; base: RunSummary | null; onOpen: (id: string) => void }) {
  if (!cmp || !base)
    return (
      <section aria-labelledby="reg-heading" className="space-y-2">
        <h2 id="reg-heading" className="font-display text-2xl">
          Changes since the comparison run
        </h2>
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center text-muted">There is no saved baseline or earlier run of this kind to compare with yet.</p>
      </section>
    );
  const list = (title: string, items: { id: string; severity: string }[], tone: string, empty: string) => (
    <div className="rounded-2xl border border-line bg-paper p-4">
      <h3 className="text-[15px] font-medium">
        {title} <span className="text-muted">({items.length})</span>
      </h3>
      {items.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {items.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onOpen(c.id)} className={`min-h-11 rounded-full px-3 text-[13px] ${tone}`}>
                {c.id}
                {c.severity === "critical" ? " · critical" : ""}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[14px] text-muted">{empty}</p>
      )}
    </div>
  );
  const improved = cmp.stats.filter((s) => s.delta !== null && s.delta !== 0 && !s.regressed);
  const worse = cmp.stats.filter((s) => s.regressed);
  return (
    <section aria-labelledby="reg-heading" className="space-y-3">
      <h2 id="reg-heading" className="font-display text-2xl">
        Changes since {runLabel(base)}
      </h2>
      {(cmp.criticalRegressions.length > 0 || cmp.gateRegressions.length > 0) && (
        <p role="alert" className="rounded-xl border border-bad bg-bad-tint px-4 py-3 text-[15px] text-bad">
          {cmp.criticalRegressions.length > 0 && `Critical cases that passed before now fail: ${cmp.criticalRegressions.map((c) => c.id).join(", ")}. `}
          {cmp.gateRegressions.length > 0 && `Release gates met before and not now: ${cmp.gateRegressions.join(", ")}.`}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        {list("New failures", cmp.newFailures, "bg-bad-tint text-bad hover:bg-bad hover:text-white", "None: nothing that passed before fails now.")}
        {list("Resolved", cmp.resolved, "bg-neem-tint text-neem hover:bg-neem hover:text-white", "No case that failed before passes now.")}
        {list("Still failing", cmp.stillFailing, "bg-warn-tint text-warn hover:bg-warn hover:text-white", "No case failed in both runs.")}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-paper p-4">
          <h3 className="text-[15px] font-medium">Metrics that got worse ({worse.length})</h3>
          <ul className="mt-1 space-y-0.5 text-[14px]">
            {worse.length ? worse.map((s) => <li key={`${s.area}-${s.key}`} className="text-bad">{s.label}: {statValue({ value: s.before.value, kind: s.kind })} → {statValue({ value: s.after.value, kind: s.kind })} (n {s.after.n})</li>) : <li className="text-muted">None.</li>}
          </ul>
        </div>
        <div className="rounded-2xl border border-line bg-paper p-4">
          <h3 className="text-[15px] font-medium">Metrics that improved or changed ({improved.length})</h3>
          <ul className="mt-1 space-y-0.5 text-[14px]">
            {improved.length ? improved.map((s) => <li key={`${s.area}-${s.key}`}>{s.label}: {statValue({ value: s.before.value, kind: s.kind })} → {statValue({ value: s.after.value, kind: s.kind })} (n {s.after.n})</li>) : <li className="text-muted">None.</li>}
          </ul>
        </div>
      </div>
      {cmp.added.length > 0 && <p className="text-[14px] text-muted">{cmp.added.length} cases are new in this run and have no earlier result: {cmp.added.slice(0, 12).map((c) => c.id).join(", ")}{cmp.added.length > 12 ? "…" : ""}</p>}
    </section>
  );
}
