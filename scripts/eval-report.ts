// npm run eval:report -- [--run latest|<run id>] [--mode live|scripted] [--against baseline|previous|<run id>] [--set-baseline [note]]
// D-21: writes evals/reports/<run>.md (summary, gates, areas with denominators, comparison, failing cases with their
// rerun commands), <run>.json (the same, machine-readable) and <run>-review.md (outputs for human review), and prints
// the comparison. Exit 1 when the run's release gates fail, it has critical failures, or a case that passed in the
// comparison run now fails.
import fs from "node:fs";
import path from "node:path";
import { baselineFile, reportsDir, resultsDir } from "@/evals/paths";
import { baselineFor, baselineKey, compareRuns, listRuns, previousComparable, readBaseline, renderMarkdown, renderReview, type Run } from "@/evals/report";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (process.argv[i + 1] ?? "");
};

function main(): number {
  const runs = listRuns(resultsDir());
  const mode = arg("mode");
  const want = arg("run") ?? "latest";
  const candidates = runs.filter((r) => r.summary.status === "complete" && (!mode || r.summary.mode === mode));
  const run: Run | undefined = want === "latest" ? candidates[0] : runs.find((r) => r.summary.id === want || r.summary.id.startsWith(want));
  if (!run) {
    console.error(`eval:report: no ${want === "latest" ? `finished ${mode ?? ""} run` : `run ${want}`} in ${path.relative(process.cwd(), resultsDir())}`);
    return 2;
  }
  const baseline = readBaseline(baselineFile());
  if (process.argv.includes("--set-baseline")) {
    const note = arg("set-baseline");
    baseline[baselineKey(run.summary)] = { id: run.summary.id, setAt: new Date().toISOString(), note: note && !note.startsWith("--") ? note : null };
    fs.writeFileSync(baselineFile(), `${JSON.stringify(baseline, null, 1)}\n`);
    console.log(`baseline for ${baselineKey(run.summary)} is now ${run.summary.id}`);
  }
  const against = arg("against") ?? "baseline";
  const base = against === "baseline" ? (baselineFor(baseline, runs, run) ?? previousComparable(runs, run)) : against === "previous" ? previousComparable(runs, run) : (runs.find((r) => r.summary.id === against || r.summary.id.startsWith(against)) ?? null);
  const cmp = base ? compareRuns(base, run) : null;
  fs.mkdirSync(reportsDir(), { recursive: true });
  const stem = path.join(reportsDir(), run.summary.id);
  fs.writeFileSync(`${stem}.md`, renderMarkdown(run, cmp));
  fs.writeFileSync(`${stem}.json`, `${JSON.stringify({ summary: run.summary, comparison: cmp }, null, 1)}\n`);
  fs.writeFileSync(`${stem}-review.md`, renderReview(run));
  const s = run.summary;
  console.log(`${s.id}: ${s.mode} ${s.suite}, ${s.counts.passed}/${s.counts.executed} cases passed (${s.counts.failed} failed, ${s.counts.flaky} flaky, ${s.counts.errored} errored, ${s.counts.skipped} not run)`);
  for (const a of s.areas) console.log(`  ${a.label.padEnd(30)} ${a.rate === null ? "  n/a" : `${(a.rate * 100).toFixed(1).padStart(5)}%`}  (${a.passed}/${a.n})`);
  if (cmp) {
    console.log(`compared with ${cmp.base.id}${base && baseline[baselineKey(run.summary)]?.id === base.summary.id ? " (baseline)" : ""}: ${cmp.newFailures.length} new failures, ${cmp.resolved.length} resolved, ${cmp.stillFailing.length} still failing, ${cmp.added.length} new cases`);
    if (cmp.newFailures.length) console.log(`  new failures: ${cmp.newFailures.map((c) => c.id).join(", ")}`);
    if (cmp.note) console.log(`  note: ${cmp.note}`);
  } else console.log("no baseline or earlier comparable run to compare with");
  console.log(`report: ${path.relative(process.cwd(), stem)}.md (and .json, -review.md)`);
  const blocked = s.gatesOk === false || s.critical.invariantViolations > 0 || s.critical.criticalCasesFailed > 0 || (cmp?.newFailures.length ?? 0) > 0;
  if (blocked) console.log("release check: NOT met (gates, critical failures or new failures above)");
  return blocked ? 1 : 0;
}

process.exitCode = main();
