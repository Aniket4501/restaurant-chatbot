import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AREAS, areaOf } from "@/evals/areas";
import { loadCases, type EvalCase } from "@/evals/case";
import { describeExpect } from "@/evals/describe";
import { baselineFile, resultsDir } from "@/evals/paths";
import { baselineFor, baselineKey, caseStatuses, compareRuns, listRuns, previousComparable, readBaseline, type Comparison, type Run } from "@/evals/report";
import type { ApiDeps } from "@/lib/api/deps";
import { cancelJob, currentJob, startJob } from "@/lib/evals/jobs";
import { errorResponse, okResponse, readJson } from "@/lib/http/json";

// D-21: the evals dashboard API (staff pages: loopback only and same-origin changes, proxy.ts; no password, D-22). Every number
// comes from the runner's results files (evals/report.ts); run controls start the real runner (lib/evals/jobs.ts).

export type EvalsDeps = { resultsDir: () => string; baselineFile: () => string; root: () => string; casesDir: () => string };
export const defaultEvalsDeps = (): EvalsDeps => ({ resultsDir, baselineFile, root: () => process.cwd(), casesDir: () => path.join(process.cwd(), "evals/cases") });

const MAX_RUNS = 60;

export type CaseRow = {
  id: string;
  category: string;
  area: string;
  severity: string;
  status: "pass" | "fail" | "error" | "flaky";
  runs: number;
  passes: number;
  failure: string | null;
  failureType: string | null;
  expected: string[];
  actual: { input: string; reply: string; outcome: string | null; intent: string | null } | null;
  previous: "pass" | "fail" | "error" | "flaky" | null;
  regression: "new" | "still failing" | "resolved" | "new case" | null;
};

const runRef = (r: Run) => r.summary;
function findRun(runs: Run[], id: string): Run | null {
  return runs.find((r) => r.summary.id === id) ?? null;
}
function comparisonFor(runs: Run[], run: Run, baseId: string | null, baselineFileName: string): { base: Run | null; reason: "chosen" | "baseline" | "previous" | "none"; cmp: Comparison | null } {
  if (baseId) {
    const b = findRun(runs, baseId);
    return { base: b, reason: b ? "chosen" : "none", cmp: b ? compareRuns(b, run) : null };
  }
  const b = baselineFor(readBaseline(baselineFileName), runs, run);
  if (b) return { base: b, reason: "baseline", cmp: compareRuns(b, run) };
  const p = previousComparable(runs, run);
  return { base: p, reason: p ? "previous" : "none", cmp: p ? compareRuns(p, run) : null };
}

/** The dashboard's first data (also rendered into the page): run summaries, newest first, baselines and the job. */
export function evalsOverview(ev: EvalsDeps = defaultEvalsDeps()) {
  const runs = listRuns(ev.resultsDir());
  return { runs: runs.slice(0, MAX_RUNS).map(runRef), totalRuns: runs.length, baseline: readBaseline(ev.baselineFile()), areas: AREAS.map(({ key, label, about }) => ({ key, label, about })), job: currentJob() };
}

/** GET /api/admin/evals: every run's summary (newest first), the saved baselines and the current job. */
export function evalsOverviewHandler(deps: ApiDeps, ev: EvalsDeps = defaultEvalsDeps()) {
  return async (): Promise<Response> => {
    return okResponse(200, { ...evalsOverview(ev), now: deps.now() });
  };
}

const RunQuery = z.object({ base: z.string().regex(/^[\w.-]{1,120}$/).optional() });

/** GET /api/admin/evals/runs/:id[?base=:id]: the run, its comparison and one row per case for the failure explorer. */
export function evalsRunHandler(deps: ApiDeps, ev: EvalsDeps = defaultEvalsDeps()) {
  return async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
    const { id } = await ctx.params;
    const q = RunQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) return errorResponse(400, "VALIDATION", "Please check the comparison run.");
    const runs = listRuns(ev.resultsDir());
    const run = findRun(runs, id);
    if (!run) return errorResponse(404, "NOT_FOUND", "No such eval run.");
    const { base, reason, cmp } = comparisonFor(runs, run, q.data.base ?? null, ev.baselineFile());
    const before = base ? caseStatuses(base.results) : null;
    const statuses = caseStatuses(run.results);
    const rows: CaseRow[] = [...statuses.entries()].map(([caseId, s]): CaseRow => {
      const rs = run.results.filter((r) => r.id === caseId);
      const failing = rs.find((r) => r.status !== "pass") ?? rs[0];
      const lastTurn = failing.turns.at(-1);
      const prev = before?.get(caseId)?.status ?? null;
      const regression = s.status === "pass" ? (prev && prev !== "pass" ? "resolved" : null) : prev === "pass" ? "new" : prev ? "still failing" : before ? "new case" : null;
      const failure = failing.failures[0] ?? (failing.violations[0] ? `${failing.violations[0].inv}: ${failing.violations[0].detail}` : null);
      return {
        id: caseId,
        category: s.category,
        area: areaOf(s.category),
        severity: s.severity,
        status: s.status,
        runs: s.runs,
        passes: s.passes,
        failure,
        failureType: failure ? failureType(failure) : null,
        expected: [...describeExpect(failing.expect?.expect), ...failing.turns.flatMap((t) => describeExpect(t.expect))].slice(0, 6),
        actual: lastTurn ? { input: lastTurn.input, reply: lastTurn.reply.slice(0, 240), outcome: lastTurn.outcome, intent: lastTurn.intent } : null,
        previous: prev,
        regression,
      };
    });
    return okResponse(200, { run: run.summary, base: base ? base.summary : null, baseReason: reason, comparison: cmp, cases: rows });
  };
}

/** What kind of failure a failure line is, for the explorer's filter. */
export function failureType(line: string): string {
  if (line.startsWith("error:")) return "execution error";
  if (/^INV-0[14]|booking_claim_text|forbidden: reservation_created/.test(line)) return "false confirmation";
  if (/^INV-/.test(line)) return "invariant";
  if (/shows (an internal fact ID|JSON|internal wording|the same text twice)/.test(line)) return "response shape";
  if (/intent /.test(line)) return "intent";
  if (/draft |slots? |submit |reservations created|field_request|alternatives/.test(line)) return "booking state";
  if (/cite|reply lacks|reply includes|abstain|no answer shown/.test(line)) return "grounding";
  if (/lead |shows one of|is not (vegetarian|vegan|mild)|costs ₹|contains |no dish shown|recommendation/.test(line)) return "recommendation";
  if (/reply (does not match|matches)/.test(line)) return "wording";
  if (/model calls/.test(line)) return "model calls";
  return "other";
}

/** GET /api/admin/evals/runs/:id/cases/:caseId: everything recorded for one case (each repeat), and how to rerun it. */
export function evalsCaseHandler(deps: ApiDeps, ev: EvalsDeps = defaultEvalsDeps()) {
  return async (req: Request, ctx: { params: Promise<{ id: string; caseId: string }> }): Promise<Response> => {
    const { id, caseId } = await ctx.params;
    const run = findRun(listRuns(ev.resultsDir()), id);
    const results = run?.results.filter((r) => r.id === caseId) ?? [];
    if (!run || !results.length) return errorResponse(404, "NOT_FOUND", "No such case in this run.");
    let spec: EvalCase | null = null;
    try {
      spec = loadCases(ev.casesDir()).find((c) => c.id === caseId) ?? null;
    } catch {
      spec = null; // a case file that doesn't parse: the recorded result is still shown
    }
    const mode = run.summary.mode;
    return okResponse(200, {
      run: run.summary,
      caseId,
      area: areaOf(results[0].category),
      // The case as it is now (it may have changed since the run: see run.datasetHash).
      spec: spec ? { notes: spec.notes ?? null, now: spec.now, turns: spec.turns.length, setup: spec.setup ?? [], variantOf: spec.variantOf ?? null, version: spec.version } : null,
      results,
      rerun: { command: `npx tsx evals/run.ts --mode ${mode} --case ${caseId}`, request: { mode, suite: "full", area: null, caseIds: [caseId] } },
    });
  };
}

const JobBody = z.strictObject({
  mode: z.enum(["scripted", "live"]),
  suite: z.enum(["smoke", "full"]),
  area: z.enum(AREAS.map((a) => a.key) as [string, ...string[]]).nullable().default(null),
  caseIds: z.array(z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,40}$/)).min(1).max(20).nullable().default(null),
});

/** GET (status), POST (start) and DELETE (cancel) /api/admin/evals/jobs. */
export function evalsJobHandlers(deps: ApiDeps, ev: EvalsDeps = defaultEvalsDeps(), spawnFn?: Parameters<typeof startJob>[1]["spawn"]) {
  return {
    GET: async (): Promise<Response> => {
      return okResponse(200, { job: currentJob(), now: deps.now() });
    },
    POST: async (req: Request): Promise<Response> => {
      const body = await readJson(req);
      if (!body.ok) return body.response;
      const p = JobBody.safeParse(body.value);
      if (!p.success) return errorResponse(400, "VALIDATION", "Please check the run options.", { fields: Object.fromEntries(p.error.issues.map((i) => [i.path.join(".") || "body", i.message])) });
      if (p.data.caseIds) {
        let known: Set<string>;
        try {
          known = new Set(loadCases(ev.casesDir()).filter((c) => c.mode === p.data.mode).map((c) => c.id));
        } catch {
          return errorResponse(503, "UNAVAILABLE", "The eval case files don't load; fix them first (npm run eval:scripted shows the problem).");
        }
        const unknown = p.data.caseIds.filter((c) => !known.has(c));
        if (unknown.length) return errorResponse(400, "VALIDATION", `No ${p.data.mode} case ${unknown.join(", ")}.`);
      }
      const otherRunActive = () => fs.existsSync(ev.resultsDir()) && listRuns(ev.resultsDir()).some((r) => r.summary.status === "running");
      const r = startJob(p.data, { root: ev.root(), spawn: spawnFn, otherRunActive });
      if (!r.ok) return errorResponse(409, "BUSY", r.message, { job: currentJob() });
      return okResponse(202, { job: r.job });
    },
    DELETE: async (): Promise<Response> => {
      return okResponse(200, { job: cancelJob() });
    },
  };
}

export { baselineKey };
