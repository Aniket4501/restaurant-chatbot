"use client";

import { useState } from "react";
import { ms, when } from "@/components/admin/evals/format";
import type { BenchSummary, RunSummary } from "@/components/admin/evals/types";

// D-24: where the time goes. From the selected run's per-turn records (p50/p95 with sample sizes; stage medians from
// runs with stage timings) and from the latency benchmark files (warm, browser, reservation flow, cold start).
// Replies are not streamed (each is validated before it is shown), so there is no time to first token to report.

const delta = (before: number | null | undefined, after: number | null | undefined) => {
  if (before == null || after == null) return null;
  const d = after - before;
  if (Math.abs(d) < 1) return null; // no change worth showing
  return { text: `${d <= 0 ? "−" : "+"}${ms(Math.abs(d))}`, better: d < 0 };
};

function Delta({ before, after }: { before: number | null | undefined; after: number | null | undefined }) {
  const d = delta(before, after);
  if (!d) return null;
  return <span className={`ml-1 text-[12px] ${d.better ? "text-neem" : "text-bad"}`}>{d.text}</span>;
}

const STAGE_TONE = ["bg-line", "bg-sage", "bg-ash", "bg-warn-tint", "bg-warn", "bg-neem", "bg-neem-dark", "bg-muted"];

export function LatencyPanel({ run, base, benches }: { run: RunSummary; base: RunSummary | null; benches: BenchSummary[] }) {
  const lat = run.latency;
  // Only like with like: scripted runs time a fake model, and a rerun of a few cases isn't the full run's mix of turns.
  const b = base && base.mode === run.mode && base.suite === run.suite && base.suite !== "subset" ? (base.latency ?? null) : null;
  const [benchId, setBenchId] = useState<string | null>(benches[0]?.id ?? null);
  const bench = benches.find((x) => x.id === benchId) ?? null;
  const benchBase = bench ? (benches.find((x) => x.id !== bench.id && x.label === "baseline" && x.startedAt < bench.startedAt) ?? benches.find((x) => x.startedAt < bench.startedAt) ?? null) : null;
  const stageTotal = lat?.stages?.reduce((n, s) => n + (s.p50 ?? 0), 0) ?? 0;

  return (
    <section aria-labelledby="latency-heading" className="space-y-3">
      <h2 id="latency-heading" className="font-display text-2xl">
        Latency
      </h2>
      {!lat || (lat.modelTurns.n === 0 && lat.noModelTurns.n === 0) ? (
        <p className="rounded-xl border border-dashed border-line bg-paper px-4 py-6 text-center text-muted">This run has no timed turns.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <article aria-labelledby="lat-turns" className="rounded-2xl border border-line bg-paper p-4">
            <h3 id="lat-turns" className="text-[15px] font-medium">
              Turn time in this run
            </h3>
            <p className="text-[13px] text-muted">Server time per guest turn, from the run&apos;s records{base ? `; change against ${base.id === run.id ? "itself" : "the comparison run"}` : ""}.</p>
            <table className="mt-2 w-full text-[14px]">
              <caption className="sr-only">Turn latency by kind of turn</caption>
              <thead className="text-left text-[13px] text-muted">
                <tr>
                  <th scope="col" className="py-1 font-medium">
                    Turns
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    n
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    p50
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    p95
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {[lat.modelTurns, lat.noModelTurns, ...lat.byIntent].map((g, i) => {
                  const before = i === 0 ? b?.modelTurns : i === 1 ? b?.noModelTurns : b?.byIntent.find((x) => x.key === g.key);
                  return (
                    <tr key={`${i}-${g.key}`} className={i === 1 ? "border-b border-line" : ""}>
                      <th scope="row" className={`py-1 text-left font-normal ${i > 1 ? "pl-3 text-muted" : ""}`}>
                        {g.label}
                      </th>
                      <td className="py-1 text-right">{g.n}</td>
                      <td className="py-1 text-right">
                        {ms(g.p50)}
                        <Delta before={before?.p50} after={g.p50} />
                      </td>
                      <td className="py-1 text-right">{g.p95 === null ? <span className="text-muted">{g.n < 20 ? "n < 20" : "No data"}</span> : <>{ms(g.p95)}<Delta before={before?.p95} after={g.p95} /></>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </article>

          <article aria-labelledby="lat-stages" className="rounded-2xl border border-line bg-paper p-4">
            <h3 id="lat-stages" className="text-[15px] font-medium">
              Where a model turn&apos;s time goes
            </h3>
            {!lat.stages ? (
              <p className="mt-2 text-[14px] text-muted">This run predates stage timings (D-24): only totals were recorded.</p>
            ) : (
              <>
                <p className="text-[13px] text-muted">Median of each stage over {lat.model?.n ?? 0} model turns (medians don&apos;t add up exactly to the turn median).</p>
                <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full" aria-hidden="true">
                  {lat.stages.map((s, i) => (s.p50 ? <span key={s.key} className={STAGE_TONE[i]} style={{ width: `${(s.p50 / Math.max(1, stageTotal)) * 100}%` }} /> : null))}
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[14px] tabular-nums">
                  {lat.stages.map((s, i) => (
                    <div key={s.key} className="flex items-center justify-between gap-2">
                      <dt className="flex items-center gap-1.5">
                        <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${STAGE_TONE[i]}`} />
                        {s.label}
                      </dt>
                      <dd>
                        {s.n ? ms(s.p50) : <span className="text-muted">not used</span>}
                        <Delta before={b?.stages?.find((x) => x.key === s.key)?.p50} after={s.p50} />
                      </dd>
                    </div>
                  ))}
                </dl>
                {lat.model && (
                  <p className="mt-3 text-[13px] text-muted">
                    Inside the model: generation {ms(lat.model.evalMsP50)} for {lat.model.evalTokensP50 ?? "?"} tokens (about {lat.model.msPerOutputToken ?? "?"} ms per token), prompt reading {ms(lat.model.promptEvalMsP50)} for {lat.model.uncachedPromptTokensP50 ?? "?"} uncached tokens, loading {ms(lat.model.loadMsP50)}; {lat.model.callsMean ?? "?"} model calls per turn on average.
                  </p>
                )}
              </>
            )}
          </article>
        </div>
      )}

      <article aria-labelledby="lat-bench" className="rounded-2xl border border-line bg-paper p-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 id="lat-bench" className="text-[15px] font-medium">
              Benchmark: warm, in the browser, booking flow and cold start
            </h3>
            <p className="text-[13px] text-muted">From `npm run bench` on an isolated server. Client time includes HTTP; the browser time runs from send to the reply painted.</p>
          </div>
          {benches.length > 0 && (
            <label className="flex items-center gap-1.5 text-[14px]">
              <span className="text-muted">Benchmark</span>
              <select value={benchId ?? ""} onChange={(e) => setBenchId(e.target.value)} className="min-h-11 rounded-full border border-line bg-ash px-3 text-[14px]">
                {benches.map((x) => (
                  <option key={x.id} value={x.id}>
                    {when(x.startedAt)}
                    {x.label ? ` · ${x.label}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {!bench ? (
          <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-6 text-center text-muted">No benchmark yet. Run `npm run bench` (needs a current build and Ollama).</p>
        ) : (
          <>
            <p className="mt-2 text-[13px] text-muted">
              Commit {bench.gitSha ?? "?"}
              {bench.gitDirty ? " with uncommitted changes" : ""}, {bench.model}, prompt {bench.promptVersion ?? "?"}; machine load {bench.loadAverage ? `${bench.loadAverage.start[0].toFixed(1)} → ${bench.loadAverage.end[0].toFixed(1)}` : "?"}
              {benchBase ? `. Changes against ${when(benchBase.startedAt)}${benchBase.label ? ` (${benchBase.label})` : ""}.` : "."}
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-[14px]">
                <caption className="sr-only">Benchmark latency by phase and kind of request</caption>
                <thead className="text-left text-[13px] text-muted">
                  <tr>
                    {["Phase", "Kind", "n", "p50", "p95", "Server p50", "Model p50", "Chooser p50", "Detail"].map((h, i) => (
                      <th key={h} scope="col" className={`py-1 font-medium ${i > 1 ? "text-right" : ""}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {bench.groups
                    .filter((g) => g.key.startsWith("kind:"))
                    .sort((x, y) => ["warm", "browser", "cold"].indexOf(x.phase) - ["warm", "browser", "cold"].indexOf(y.phase) || x.key.localeCompare(y.key))
                    .map((g) => {
                      const prev = benchBase?.groups.find((x) => x.phase === g.phase && x.key === g.key);
                      const detail = g.phase === "browser" ? `network ${ms(g.extra.networkP50)}, paint ${ms(g.extra.renderP50)}` : g.key === "kind:reservation" ? `turn ${ms(g.extra.turnP50)}, save ${ms(g.extra.saveP50)}` : g.phase === "cold" ? `model load ${ms(g.stagesP50.loadMs)}` : "";
                      return (
                        <tr key={`${g.phase}-${g.key}`} className="border-t border-line">
                          <td className="py-1 capitalize">{g.phase}</td>
                          <td className="py-1">{g.key.slice(5)}</td>
                          <td className="py-1 text-right">
                            {g.n}
                            {g.failed ? <span className="ml-1 text-bad">({g.failed} failed)</span> : null}
                          </td>
                          <td className="py-1 text-right">
                            {ms(g.p50)}
                            <Delta before={prev?.p50} after={g.p50} />
                          </td>
                          <td className="py-1 text-right">{g.p95 === null ? <span className="text-muted">n &lt; 20</span> : <>{ms(g.p95)}<Delta before={prev?.p95} after={g.p95} /></>}</td>
                          <td className="py-1 text-right">{ms(g.serverP50)}</td>
                          <td className="py-1 text-right">{g.stagesP50.turnModelMs == null ? "—" : ms(g.stagesP50.turnModelMs)}</td>
                          <td className="py-1 text-right">{g.stagesP50.chooserMs == null ? "—" : ms(g.stagesP50.chooserMs)}</td>
                          <td className="py-1 text-right text-[13px] text-muted">{detail}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="mt-2 text-[13px] text-muted">Time to first token: not applicable. Replies aren&apos;t streamed, because each one is checked against the restaurant&apos;s data before it is shown.</p>
      </article>
    </section>
  );
}
