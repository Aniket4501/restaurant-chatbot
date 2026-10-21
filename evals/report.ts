import fs from "node:fs";
import path from "node:path";
import { AREAS, areaOf, type AreaKey } from "@/evals/areas";
import type { CaseResult } from "@/evals/run";
import type { ThresholdLine } from "@/evals/metrics";

// D-21: reading eval runs for the report (scripts/eval-report.ts) and the dashboard (/admin/evals). Pure apart from
// the file reads in loadRun/listRuns. The source of truth is the runner's results files in evals/results: every
// number here is derived from them, with its denominator, and nothing is shown for a metric without data.

export type RunStatus = "complete" | "running" | "interrupted";
export type CaseStatus = "pass" | "fail" | "error" | "flaky";
export type Stat = { key: string; label: string; value: number | null; n: number; kind: "rate" | "count" | "ms"; definition: string; better: "higher" | "lower" };
export type AreaSummary = { key: AreaKey | "other"; label: string; about: string; n: number; passed: number; rate: number | null; stats: Stat[] };
export type RunSummary = {
  id: string;
  file: string;
  mode: "scripted" | "live";
  suite: "smoke" | "full" | "subset";
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  gitSha: string | null;
  gitDirty: boolean | null;
  changedDuringRun: boolean | null;
  model: string;
  promptVersion: string | null;
  chooserVersion: string | null;
  datasetHash: string | null;
  config: { runs: number; numCtx: number | null; temperature: number | null; seed: number | null; loadAverage: number | null };
  counts: { selected: number; executed: number; passed: number; failed: number; errored: number; skipped: number; flaky: number; caseResults: number };
  critical: { invariantViolations: number; falseConfirmations: number; duplicateBookings: number; criticalCasesFailed: number };
  gates: ThresholdLine[] | null;
  gatesOk: boolean | null;
  areas: AreaSummary[];
  latency: LatencySummary;
};
export type Run = { summary: RunSummary; results: CaseResult[] };

/** D-24: where turn time went in a run, from its per-turn records. p95 only from 20 turns; stages only from D-24 runs. */
export type LatencyGroup = { key: string; label: string; n: number; p50: number | null; p95: number | null };
export type LatencyStage = { key: string; label: string; p50: number | null; mean: number | null; n: number };
export type LatencySummary = {
  modelTurns: LatencyGroup;
  noModelTurns: LatencyGroup;
  byIntent: LatencyGroup[];
  /** Medians per stage over the turns that called the model; null when the run predates stage timings. */
  stages: LatencyStage[] | null;
  model: { n: number; callsMean: number | null; evalTokensP50: number | null; uncachedPromptTokensP50: number | null; evalMsP50: number | null; promptEvalMsP50: number | null; loadMsP50: number | null; msPerOutputToken: number | null } | null;
};

type Meta = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Results from files written before D-21 lack status, expect and per-turn detail; fill what can be derived. */
function normalizeResult(r: CaseResult): CaseResult {
  const status = r.status ?? (r.passed ? "pass" : r.failures?.some((f) => f.startsWith("error:")) ? "error" : "fail");
  return {
    ...r,
    status,
    durationMs: r.durationMs ?? 0,
    expect: r.expect ?? { expect: null, forbidden: [], notes: null, variantOf: null },
    turns: (r.turns ?? []).map((t, i) => ({ ...t, index: t.index ?? i })),
  };
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One run from a results file (`*.json`, finished) or a progress file (`*.partial.jsonl`, running or interrupted). */
export function loadRun(file: string): Run | null {
  const id = path.basename(file).replace(/\.partial\.jsonl$|\.json$/, "");
  if (file.endsWith(".partial.jsonl")) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    const parsed = lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return []; // a line cut off by an interrupted write
      }
    });
    const header = (parsed[0]?.header ?? null) as Meta | null;
    const results = parsed.filter((x) => !("header" in x)).map((x) => normalizeResult(x as unknown as CaseResult));
    const mode = header?.mode === "scripted" || id.includes("_scripted") ? "scripted" : "live";
    const meta: Meta = { ...(header ?? {}), mode, kind: `eval-${mode}`, startedAt: str(header?.startedAt) ?? stampToIso(id) };
    const status: RunStatus = alive(header?.pid) ? "running" : "interrupted";
    return { summary: summarize(id, file, meta, results, null, status, (header?.selected as string[] | undefined)?.length ?? null), results };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { meta?: Meta; thresholds?: ThresholdLine[]; results?: CaseResult[] };
  if (!raw.meta || !String(raw.meta.kind ?? "").startsWith("eval-") || !Array.isArray(raw.results)) return null; // model probes etc.
  const results = raw.results.map(normalizeResult);
  return { summary: summarize(id, file, raw.meta, results, raw.thresholds ?? null, "complete", null), results };
}

const stampToIso = (id: string) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : new Date(0).toISOString();
};

/** Per case ID across runs (a release repeats each case): pass if every run passed, flaky if some did. */
export function caseStatuses(results: CaseResult[]): Map<string, { status: CaseStatus; category: string; severity: string; runs: number; passes: number }> {
  const out = new Map<string, { status: CaseStatus; category: string; severity: string; runs: number; passes: number; errors: number }>();
  for (const r of results) {
    const x = out.get(r.id) ?? { status: "pass" as CaseStatus, category: r.category, severity: r.severity, runs: 0, passes: 0, errors: 0 };
    x.runs++;
    if (r.status === "pass") x.passes++;
    if (r.status === "error") x.errors++;
    out.set(r.id, x);
  }
  for (const x of out.values()) x.status = x.errors ? "error" : x.passes === x.runs ? "pass" : x.passes === 0 ? "fail" : "flaky";
  return out;
}

const rate = (ok: number, n: number) => (n ? ok / n : null);
export const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const STAGE_LABELS: [string, string][] = [
  ["setupMs", "Setup"],
  ["retrievalMs", "Retrieval"],
  ["promptMs", "Prompt build"],
  ["queueMs", "Queue"],
  ["statusMs", "Model status check"],
  ["turnModelMs", "Turn model"],
  ["chooserMs", "Recommendation chooser"],
  ["otherMs", "Validation and formatting"],
];
const INTENT_LABEL: Record<string, string> = { faq: "Questions (FAQ)", recommend: "Recommendations", menu: "Menu", booking: "Booking", manage_booking: "Change or cancel", smalltalk: "Small talk", off_topic: "Off topic", unclear: "Unclear", none: "Degraded or no intent" };

/** D-24: latency of a run's guest turns, split into turns that called the model and turns that didn't. */
export function latencySummary(results: CaseResult[]): LatencySummary {
  const turns = results.flatMap((r) => r.turns ?? []).filter((t) => t.latencyMs !== null && t.latencyMs !== undefined);
  const calledModel = (t: (typeof turns)[number]) => (t.timing ? t.timing.calls > 0 : t.modelMs !== null);
  const model = turns.filter(calledModel);
  const noModel = turns.filter((t) => !calledModel(t));
  const group = (key: string, label: string, xs: typeof turns): LatencyGroup => {
    const lat = xs.map((t) => t.latencyMs as number);
    return { key, label, n: lat.length, p50: pct(lat, 50), p95: lat.length >= 20 ? pct(lat, 95) : null };
  };
  const intents = [...new Set(model.map((t) => t.intent ?? "none"))].sort();
  const timed = model.filter((t) => t.timing);
  const vals = (k: string) => timed.flatMap((t) => (typeof (t.timing as Record<string, unknown>)[k] === "number" ? [(t.timing as Record<string, number>)[k]] : []));
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const evalMs = vals("evalMs");
  const evalTok = vals("evalTokens");
  return {
    modelTurns: group("model", "Turns that called the model", model),
    noModelTurns: group("noModel", "Turns without a model call", noModel),
    byIntent: intents.map((i) => group(i, INTENT_LABEL[i] ?? i, model.filter((t) => (t.intent ?? "none") === i))),
    stages: timed.length ? STAGE_LABELS.map(([key, label]) => ({ key, label, p50: pct(vals(key), 50), mean: mean(vals(key)), n: vals(key).length })) : null,
    model: timed.length
      ? {
          n: timed.length,
          callsMean: timed.length ? Math.round((vals("calls").reduce((a, b) => a + b, 0) / timed.length) * 100) / 100 : null,
          evalTokensP50: pct(evalTok, 50),
          uncachedPromptTokensP50: pct(vals("uncachedPromptTokens"), 50),
          evalMsP50: pct(evalMs, 50),
          promptEvalMsP50: pct(vals("promptEvalMs"), 50),
          loadMsP50: pct(vals("loadMs"), 50),
          msPerOutputToken: evalTok.reduce((a, b) => a + b, 0) > 0 ? Math.round((evalMs.reduce((a, b) => a + b, 0) / evalTok.reduce((a, b) => a + b, 0)) * 10) / 10 : null,
        }
      : null,
  };
}

function checkStat(results: CaseResult[], key: string, label: string, pred: (k: string) => boolean, definition: string): Stat {
  const cs = results.flatMap((r) => r.checks ?? []).filter((c) => pred(c.key));
  return { key, label, value: rate(cs.filter((c) => c.ok).length, cs.length), n: cs.length, kind: "rate", definition, better: "higher" };
}

/** The statistics each area reports, besides its pass rate. Only data present in the results is counted. */
function areaStats(key: AreaKey | "other", all: CaseResult[], inArea: CaseResult[]): Stat[] {
  const violations = all.flatMap((r) => r.violations ?? []);
  const turns = all.flatMap((r) => r.turns ?? []);
  const guestTurns = turns.filter((t) => t.kind === "guest" || t.kind === "action");
  const modelTurns = turns.filter((t) => t.firstTryValid !== null && t.firstTryValid !== undefined);
  const count = (k: string, label: string, value: number, n: number, definition: string): Stat => ({ key: k, label, value, n, kind: "count", definition, better: "lower" });
  switch (key) {
    case "normalization": {
      // A noisy variant should be understood like its clean case: compare the first turn's intent in the same run.
      const firstIntent = new Map(all.filter((r) => r.run === 1).map((r) => [r.id, r.turns[0]?.intent ?? null]));
      const pairs = all.filter((r) => r.run === 1 && r.expect?.variantOf && firstIntent.has(r.expect.variantOf));
      const same = pairs.filter((r) => r.turns[0]?.intent === firstIntent.get(r.expect.variantOf!)).length;
      return [{ key: "variantAgreement", label: "Same intent as the clean wording", value: rate(same, pairs.length), n: pairs.length, kind: "rate", definition: "Noisy variants whose first-turn intent matches their clean case's in the same run (pairs where both ran).", better: "higher" }];
    }
    case "understanding":
      return [
        checkStat(all, "intentAccuracy", "Intent accuracy", (k) => k === "intent", "Intent checks passed, over every case that states an expected intent (all areas)."),
        checkStat(all, "entityAccuracy", "Booking-field accuracy", (k) => k === "draft", "Booking-state checks (branch, date, time, party size) passed, over every case that states them."),
      ];
    case "grounding":
      return [
        checkStat(all, "groundedAnswers", "Grounded answer checks", (k) => ["mustCite", "mustCiteAny", "mustIncludeValues", "mustNotIncludeValues", "answer"].includes(k), "Citation and required/forbidden fact checks passed, and known facts answered rather than abstained."),
        checkStat(all, "abstention", "Abstains on unknown facts", (k) => k === "abstain", "Questions with no answer in the facts that got the fallback, not an invented answer."),
        count("unsupportedClaims", "Unsupported claims shown", violations.filter((v) => v.inv === "INV-04" || v.inv === "INV-05").length, guestTurns.length, "INV-04 (booking claim without a saved row) and INV-05 (a number not in the cited facts) violations, over the turns run."),
      ];
    case "recommendations":
      return [
        checkStat(all, "recommendationChecks", "All recommendation checks", (k) => k === "recommend" || k.startsWith("recommend."), "Every dish-card check (constraints, lead dish, shown or withheld, follow-ups); runs before D-21 recorded only this total."),
        checkStat(all, "constraintCompliance", "Stated constraints met", (k) => k === "recommend.constraints", "Turns whose shown dishes all meet the stated diet, allergen, budget and course (and none of the excluded dishes)."),
        checkStat(all, "leadChoice", "Acceptable lead dish", (k) => k === "recommend.lead", "Turns whose lead dish is one of the defensible answers listed by the case."),
        checkStat(all, "shownWhenExpected", "Card shown or withheld correctly", (k) => k === "recommend.shown", "A dish card shown when one fits, and none for an impossible request."),
        checkStat(all, "relations", "Cheaper / different follow-ups", (k) => k === "recommend.relation", "'Cheaper' leads are cheaper and 'another' leads differ from the earlier turn's."),
      ];
    case "conversation": {
      const multi = all.filter((r) => (r.turns ?? []).filter((t) => t.kind === "guest" || t.kind === "action").length >= 2);
      return [{ key: "multiTurnCompletion", label: "Multi-turn cases completed", value: rate(multi.filter((r) => r.status === "pass").length, multi.length), n: multi.length, kind: "rate", definition: "Cases with two or more guest turns (any area) that passed every check.", better: "higher" }];
    }
    case "reservations": {
      const offered = all.reduce((a, r) => ({ total: a.total + (r.offered?.total ?? 0), open: a.open + (r.offered?.open ?? 0) }), { total: 0, open: 0 });
      return [
        { key: "availabilityAccuracy", label: "Offered times really open", value: rate(offered.open, offered.total), n: offered.total, kind: "rate", definition: "Times shown to the guest that the availability engine had open at that moment (INV-03).", better: "higher" },
        checkStat(all, "submitOutcomes", "Submit outcomes as expected", (k) => k === "submitStatus" || k === "submitCode", "Reservation submits that returned the expected HTTP status and error code."),
        count("falseConfirmations", "False confirmations", violations.filter((v) => v.inv === "INV-01" || v.inv === "INV-04").length, guestTurns.length, "A confirmation without a matching saved row (INV-01) or booking-claim text without a create (INV-04)."),
        count("duplicateBookings", "Duplicate bookings", violations.filter((v) => v.inv === "INV-02").length, all.length, "Duplicate confirmed rows for one booking (INV-02)."),
      ];
    }
    case "safety":
      return [
        { key: "injectionResistance", label: "Injection cases passed", value: rate(all.filter((r) => r.category === "injection" && r.status === "pass").length, all.filter((r) => r.category === "injection").length), n: all.filter((r) => r.category === "injection").length, kind: "rate", definition: "Prompt-injection cases (forged history, instructions in guest text) that passed.", better: "higher" },
        { key: "safetyCases", label: "Allergen, diet and policy cases passed", value: rate(inArea.filter((r) => r.category === "safety" && r.status === "pass").length, inArea.filter((r) => r.category === "safety").length), n: inArea.filter((r) => r.category === "safety").length, kind: "rate", definition: "Safety cases: no unsupported allergen or diet claim, no invented policy, no prompt or reasoning disclosure.", better: "higher" },
      ];
    case "ux":
      return [
        checkStat(all, "noDuplicates", "Replies without repeated text", (k) => k === "ux.duplicate", "Turns where no text is shown twice (reply and notice, or a repeated sentence), over every turn run."),
        checkStat(all, "noLeaks", "Replies without IDs, JSON or internal wording", (k) => k === "ux.leak" || k === "ux.json" || k === "ux.internal", "Turn checks for fact IDs, JSON, prompt tags and internal list wording shown to the guest (three checks per turn)."),
      ];
    case "reliability": {
      const lat = modelTurns.flatMap((t) => (t.latencyMs === null ? [] : [t.latencyMs]));
      const timeouts = turns.flatMap((t) => t.trace ?? []).filter((x) => x.action === "model_call" && /TIMEOUT/.test(String((x as { result: string }).result))).length;
      return [
        { key: "errorRate", label: "Cases that could not run", value: rate(all.filter((r) => r.status === "error").length, all.length), n: all.length, kind: "rate", definition: "Case results with an execution error (setup or harness), not a failed expectation.", better: "lower" },
        { key: "degradedRate", label: "Model turns degraded", value: rate(modelTurns.filter((t) => t.outcome === "degraded").length, modelTurns.length), n: modelTurns.length, kind: "rate", definition: "Turns that called the model and fell back to the degraded reply (down, timeout, invalid output), including deliberate fault cases.", better: "lower" },
        count("modelTimeouts", "Model timeouts", timeouts, modelTurns.length, "Model calls that timed out, over the turns that called the model (traces from D-21 runs only)."),
        { key: "latencyP50", label: "Turn latency p50", value: pct(lat, 50), n: lat.length, kind: "ms", definition: "Median server turn time (the turn pipeline, without HTTP or the browser) over turns that called the model.", better: "lower" },
        { key: "latencyP95", label: "Turn latency p95", value: lat.length >= 20 ? pct(lat, 95) : null, n: lat.length, kind: "ms", definition: "95th percentile turn time (shown from 20 turns up).", better: "lower" },
      ];
    }
    default:
      return [];
  }
}

export function summarize(id: string, file: string, meta: Meta, results: CaseResult[], gates: ThresholdLine[] | null, status: RunStatus, selected: number | null): RunSummary {
  const statuses = caseStatuses(results);
  const ids = [...statuses.values()];
  const violations = results.flatMap((r) => r.violations ?? []);
  const mode = meta.mode === "scripted" || meta.kind === "eval-scripted" ? "scripted" : "live";
  const sel = meta.selection as { case?: unknown; category?: unknown; area?: unknown } | undefined;
  // Only a run that says it was the full suite counts as one: pre-D-21 files have no suite and ran 3 to 276 cases, so
  // they are subsets in trends and comparisons (D-24 audit: a 3-case check showed as "Live full").
  const suite = sel && (sel.case || sel.category || sel.area) ? "subset" : meta.suite === "smoke" ? "smoke" : meta.suite === "full" || meta.kind === "eval-scripted" ? "full" : "subset";
  const runs = num(meta.runs) ?? Math.max(1, ...results.map((r) => r.run));
  const selectedCases = selected ?? num((meta.dataset as Meta | undefined)?.cases) ?? statuses.size;
  const areaRows: AreaSummary[] = [...AREAS.map((a) => ({ key: a.key as AreaKey | "other", label: a.label, about: a.about })), { key: "other" as const, label: "Other", about: "Categories from older results files." }].map((a) => {
    const inArea = results.filter((r) => areaOf(r.category) === a.key);
    return { ...a, n: inArea.length, passed: inArea.filter((r) => r.status === "pass").length, rate: rate(inArea.filter((r) => r.status === "pass").length, inArea.length), stats: a.key === "other" ? [] : areaStats(a.key, results, inArea) };
  });
  return {
    id,
    file,
    mode,
    suite,
    status,
    startedAt: str(meta.startedAt) ?? stampToIso(id),
    finishedAt: str(meta.finishedAt),
    durationMs: num(meta.durationMs) ?? (str(meta.finishedAt) && str(meta.startedAt) ? Date.parse(meta.finishedAt as string) - Date.parse(meta.startedAt as string) : null),
    gitSha: str(meta.gitSha),
    gitDirty: typeof meta.gitDirty === "boolean" ? meta.gitDirty : null,
    changedDuringRun: typeof meta.changedDuringRun === "boolean" ? meta.changedDuringRun : null,
    model: str(meta.model) ?? (mode === "scripted" ? "fake-sequence" : "unknown"),
    promptVersion: str(meta.promptVersion),
    chooserVersion: str(meta.chooserVersion),
    datasetHash: str((meta.dataset as Meta | undefined)?.hash) ?? str(meta.datasetHash),
    config: { runs, numCtx: num(meta.numCtx), temperature: num(meta.temperature), seed: num(meta.seed), loadAverage: Array.isArray(meta.loadAverage) ? num(meta.loadAverage[0]) : null },
    counts: {
      selected: selectedCases,
      executed: statuses.size,
      passed: ids.filter((x) => x.status === "pass").length,
      failed: ids.filter((x) => x.status === "fail").length,
      errored: ids.filter((x) => x.status === "error").length,
      flaky: ids.filter((x) => x.status === "flaky").length,
      skipped: Math.max(0, selectedCases - statuses.size), // selected but not run (an interrupted or running run)
      caseResults: results.length,
    },
    critical: {
      invariantViolations: violations.length,
      falseConfirmations: violations.filter((v) => v.inv === "INV-01" || v.inv === "INV-04").length,
      duplicateBookings: violations.filter((v) => v.inv === "INV-02").length,
      criticalCasesFailed: ids.filter((x) => x.severity === "critical" && x.status !== "pass").length,
    },
    gates: gates && gates.length ? gates : null,
    gatesOk: gates && gates.length ? gates.every((g) => g.ok) : null,
    areas: areaRows.filter((a) => a.key !== "other" || a.n > 0),
    latency: latencySummary(results),
  };
}

/** Every run in a results directory, newest first. A progress file whose run finished (same stamp) is left out. */
const cache = new Map<string, { mtimeMs: number; size: number; run: Run | null }>();
export function listRuns(dir: string): Run[] {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir);
  const finished = new Set(names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, 24)));
  const runs: Run[] = [];
  for (const n of names) {
    const isPartial = n.endsWith(".partial.jsonl");
    if (!(n.endsWith(".json") || isPartial) || (isPartial && finished.has(n.slice(0, 24)))) continue;
    const file = path.join(dir, n);
    const st = fs.statSync(file);
    const hit = cache.get(file);
    let run: Run | null;
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && !isPartial) run = hit.run;
    else {
      try {
        run = loadRun(file);
      } catch {
        run = null; // unreadable: not a run
      }
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, run });
    }
    if (run && !(isPartial && run.results.length === 0 && run.summary.status === "interrupted")) runs.push(run);
  }
  return runs.sort((a, b) => b.summary.startedAt.localeCompare(a.summary.startedAt));
}

export type CaseChange = { id: string; category: string; severity: string; before: CaseStatus | null; after: CaseStatus | null };
export type Comparison = {
  base: { id: string; startedAt: string };
  head: { id: string; startedAt: string };
  comparable: boolean;
  note: string | null;
  newFailures: CaseChange[];
  resolved: CaseChange[];
  stillFailing: CaseChange[];
  added: CaseChange[];
  removed: CaseChange[];
  areas: { key: string; label: string; before: { rate: number | null; n: number }; after: { rate: number | null; n: number }; delta: number | null }[];
  stats: { area: string; key: string; label: string; kind: Stat["kind"]; better: Stat["better"]; before: { value: number | null; n: number }; after: { value: number | null; n: number }; delta: number | null; regressed: boolean }[];
  gateRegressions: string[];
  criticalRegressions: CaseChange[];
};

/** What changed from `base` to `head`, case by case and metric by metric. Only cases both runs ran are compared. */
export function compareRuns(base: Run, head: Run): Comparison {
  const a = caseStatuses(base.results);
  const b = caseStatuses(head.results);
  const failing = (s: CaseStatus | null) => s === "fail" || s === "error" || s === "flaky";
  const changes: CaseChange[] = [...new Set([...a.keys(), ...b.keys()])].sort().map((id) => ({ id, category: (b.get(id) ?? a.get(id))!.category, severity: (b.get(id) ?? a.get(id))!.severity, before: a.get(id)?.status ?? null, after: b.get(id)?.status ?? null }));
  const both = changes.filter((c) => c.before && c.after);
  const newFailures = both.filter((c) => c.before === "pass" && failing(c.after));
  const sameKind = base.summary.mode === head.summary.mode;
  // Area and metric deltas only between runs of the same kind and suite (two full runs, even if cases were added since),
  // or over the same cases: a rerun of five failing cases against the full run it came from would show "−38 pts" for
  // fixing three of them (review of D-24). Case-level changes are always compared.
  const sameSet = a.size === b.size && [...b.keys()].every((id) => a.has(id));
  const sameCases = sameKind && ((head.summary.suite !== "subset" && head.summary.suite === base.summary.suite) || sameSet);
  const areas = head.summary.areas.map((h) => {
    const p = base.summary.areas.find((x) => x.key === h.key);
    return { key: h.key, label: h.label, before: { rate: p?.rate ?? null, n: p?.n ?? 0 }, after: { rate: h.rate, n: h.n }, delta: sameCases && p?.rate != null && h.rate != null ? h.rate - p.rate : null };
  });
  const stats = head.summary.areas.flatMap((h) =>
    h.stats.map((s) => {
      const p = base.summary.areas.find((x) => x.key === h.key)?.stats.find((x) => x.key === s.key);
      const delta = sameCases && p?.value != null && s.value != null ? s.value - p.value : null;
      // Counts and latency are compared as they are; a rate only when both sides have data.
      const regressed = delta !== null && (s.better === "higher" ? delta < 0 : delta > 0) && (s.kind !== "ms" || Math.abs(delta) > 0.2 * (p?.value ?? 0));
      return { area: h.key, key: s.key, label: s.label, kind: s.kind, better: s.better, before: { value: p?.value ?? null, n: p?.n ?? 0 }, after: { value: s.value, n: s.n }, delta, regressed };
    }),
  );
  const gateRegressions = (head.summary.gates ?? []).filter((g) => !g.ok && (base.summary.gates ?? []).some((x) => x.metric === g.metric && x.ok)).map((g) => g.metric);
  return {
    base: { id: base.summary.id, startedAt: base.summary.startedAt },
    head: { id: head.summary.id, startedAt: head.summary.startedAt },
    comparable: sameKind,
    note: !sameKind ? "Different modes (scripted vs live): case statuses are compared, but the model differs." : !sameCases ? "These runs ran different sets of cases: case-level changes are compared, but not area rates or metrics." : base.summary.datasetHash !== head.summary.datasetHash ? "The case files changed between these runs: only cases both ran are compared, and an edited case may score differently for that reason." : null,
    newFailures,
    resolved: both.filter((c) => failing(c.before) && c.after === "pass"),
    stillFailing: both.filter((c) => failing(c.before) && failing(c.after)),
    added: changes.filter((c) => !c.before && c.after),
    removed: changes.filter((c) => c.before && !c.after),
    areas,
    stats,
    gateRegressions,
    criticalRegressions: newFailures.filter((c) => c.severity === "critical"),
  };
}

/** The previous run of the same mode and suite before `run` (the dashboard's default comparison). */
export function previousComparable(runs: Run[], run: Run): Run | null {
  return runs.filter((r) => r.summary.status === "complete" && r.summary.mode === run.summary.mode && r.summary.suite === run.summary.suite && r.summary.startedAt < run.summary.startedAt).sort((a, b) => b.summary.startedAt.localeCompare(a.summary.startedAt))[0] ?? null;
}

const fmtRate = (v: number | null, n: number) => (v === null ? `n/a (n ${n})` : `${(v * 100).toFixed(1)}% (n ${n})`);
const fmtStat = (s: { value: number | null; n: number }, kind: Stat["kind"]) => (s.value === null ? `n/a (n ${s.n})` : kind === "rate" ? fmtRate(s.value, s.n) : kind === "ms" ? `${Math.round(s.value)} ms (n ${s.n})` : `${s.value} (over ${s.n})`);

/** The human-readable report: summary, gates, areas with denominators, and the comparison when there is one. */
export function renderMarkdown(run: Run, cmp: Comparison | null): string {
  const s = run.summary;
  const L: string[] = [];
  L.push(`# Eval run ${s.id}`, "");
  L.push(`- Mode: ${s.mode}, suite: ${s.suite}, status: ${s.status}${s.config.runs > 1 ? `, ${s.config.runs} runs per case` : ""}`);
  L.push(`- Code: ${s.gitSha ?? "unknown"}${s.gitDirty ? " (uncommitted changes)" : ""}${s.changedDuringRun ? " (changed during the run)" : ""}; prompt ${s.promptVersion ?? "?"}, chooser ${s.chooserVersion ?? "?"}; dataset ${s.datasetHash ?? "?"}`);
  L.push(`- Model: ${s.model}${s.config.temperature !== null ? `, temperature ${s.config.temperature}, seed ${s.config.seed}, ctx ${s.config.numCtx}` : ""}${s.config.loadAverage !== null ? `; load average at the end ${s.config.loadAverage.toFixed(1)}` : ""}`);
  L.push(`- Started ${s.startedAt}${s.durationMs !== null ? `, took ${Math.round(s.durationMs / 1000)} s` : ""}`);
  L.push(`- Cases: ${s.counts.executed} of ${s.counts.selected} run; ${s.counts.passed} passed, ${s.counts.failed} failed, ${s.counts.flaky} flaky, ${s.counts.errored} errored, ${s.counts.skipped} not run`);
  L.push(`- Critical: ${s.critical.invariantViolations} invariant violations, ${s.critical.falseConfirmations} false confirmations, ${s.critical.duplicateBookings} duplicate bookings, ${s.critical.criticalCasesFailed} critical cases not passing`, "");
  if (s.gates) {
    L.push(`## Release gates (${s.gatesOk ? "all met" : "NOT met"})`, "", "| Metric | Value | Wanted | |", "|---|---|---|---|");
    for (const g of s.gates) L.push(`| ${g.metric} | ${g.value === null ? "n/a" : Number.isInteger(g.value) ? g.value : g.value.toFixed(3)} | ${g.want} | ${g.ok ? "met" : "**not met**"} |`);
    L.push("");
  } else L.push("## Release gates", "", s.mode === "live" ? "Not applied: a subset or smoke run (gates apply to a full live run)." : "Scripted runs gate on every case passing with no invariant violations.", "");
  L.push("## Quality areas", "", "| Area | Cases passed | Change |", "|---|---|---|");
  for (const a of s.areas) {
    const c = cmp?.areas.find((x) => x.key === a.key);
    L.push(`| ${a.label} | ${fmtRate(a.rate, a.n)} | ${c?.delta == null ? "–" : `${c.delta >= 0 ? "+" : ""}${(c.delta * 100).toFixed(1)} pts`} |`);
  }
  L.push("", "### Metrics by area", "", "| Area | Metric | Value | Before | Definition |", "|---|---|---|---|---|");
  for (const a of s.areas)
    for (const st of a.stats) {
      const c = cmp?.stats.find((x) => x.area === a.key && x.key === st.key);
      L.push(`| ${a.label} | ${st.label}${c?.regressed ? " **(worse)**" : ""} | ${fmtStat(st, st.kind)} | ${c ? fmtStat(c.before, st.kind) : "–"} | ${st.definition} |`);
    }
  L.push("");
  if (cmp) {
    L.push(`## Compared with ${cmp.base.id}`, "");
    if (cmp.note) L.push(`Note: ${cmp.note}`, "");
    const list = (title: string, xs: CaseChange[]) => L.push(`- ${title} (${xs.length})${xs.length ? `: ${xs.map((x) => `${x.id}${x.severity === "critical" ? " [critical]" : ""}`).join(", ")}` : ""}`);
    list("New failures", cmp.newFailures);
    list("Resolved", cmp.resolved);
    list("Still failing", cmp.stillFailing);
    list("New cases", cmp.added);
    list("Cases no longer run", cmp.removed);
    L.push(`- Gate regressions: ${cmp.gateRegressions.length ? cmp.gateRegressions.join(", ") : "none"}`, "");
  } else L.push("## Comparison", "", "No earlier comparable run or baseline was given.", "");
  const failed = [...caseStatuses(run.results).entries()].filter(([, x]) => x.status !== "pass");
  L.push(`## Cases not passing (${failed.length})`, "");
  for (const [id, x] of failed) {
    const r = run.results.find((y) => y.id === id && y.status !== "pass")!;
    L.push(`### ${id} (${x.category}, ${x.severity}, ${x.status}${x.runs > 1 ? `, ${x.passes}/${x.runs} runs passed` : ""})`, "");
    for (const f of [...r.failures, ...(r.violations ?? []).map((v) => `${v.inv}: ${v.detail}`)].slice(0, 8)) L.push(`- ${f}`);
    L.push("", `Rerun: \`npx tsx evals/run.ts --mode ${s.mode} --case ${id}\``, "");
  }
  return `${L.join("\n")}\n`;
}

// The runner writes a dish card as "recommend <ids>" (a lead dish) or "options <ids>" (a list to choose from).
const isCard = (b: string) => b.startsWith("recommend ") || b.startsWith("options ");

/** Outputs for a person to read (Layer 6): recommendations, clarifications, no-match replies, noisy input, safety. */
export function renderReview(run: Run): string {
  const L: string[] = [`# Human review sample: ${run.summary.id}`, "", "Automated checks verify facts and constraints; these replies are for judging relevance, tone and helpfulness. Mark each: good / acceptable / poor, with a note.", ""];
  const pick = (title: string, pred: (r: CaseResult, t: CaseResult["turns"][number]) => boolean, max = 20) => {
    const rows = run.results.filter((r) => r.run === 1).flatMap((r) => r.turns.filter((t) => pred(r, t)).map((t) => ({ r, t }))).slice(0, max);
    L.push(`## ${title} (${rows.length})`, "");
    for (const { r, t } of rows) {
      L.push(`- **${r.id}** turn ${t.index + 1} (${r.status}): “${t.input}”`, `  - Reply: ${t.reply || "(no text)"}`);
      const dishes = t.blocks.filter(isCard);
      if (dishes.length) L.push(`  - Card: ${dishes.join("; ")}`);
      L.push("  - Verdict: ");
    }
    L.push("");
  };
  pick("Recommendations", (_r, t) => t.outcome === "recommend" && t.blocks.some(isCard));
  pick("No-match and clarifying replies", (_r, t) => (t.outcome === "recommend" && !t.blocks.some(isCard)) || t.outcome === "clarify");
  pick("Noisy, informal or Hinglish input", (r) => r.category === "normalization");
  pick("Allergy, diet and policy", (r) => r.category === "safety" || r.category === "unsupported_fact");
  pick("Cases the automated checks failed", (r) => r.status !== "pass", 30);
  return `${L.join("\n")}\n`;
}

/** The saved baseline: a run ID per mode and suite ("live-full", "scripted-full"), in evals/baseline.json. */
export type Baseline = Record<string, { id: string; setAt: string; note: string | null }>;
export const baselineKey = (s: Pick<RunSummary, "mode" | "suite">) => `${s.mode}-${s.suite}`;
export function readBaseline(file: string): Baseline {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
  } catch {
    return {};
  }
}
export function baselineFor(baseline: Baseline, runs: Run[], run: Run): Run | null {
  const b = baseline[baselineKey(run.summary)];
  return b && b.id !== run.summary.id ? (runs.find((r) => r.summary.id === b.id) ?? null) : null;
}

/** D-24: a latency benchmark file (scripts/bench.ts) without its samples. */
export type BenchGroup = { phase: string; key: string; n: number; failed: number; p50: number | null; p95: number | null; min: number | null; max: number | null; serverP50: number | null; stagesP50: Record<string, number | null>; extra: Record<string, number | null> };
export type BenchSummary = { id: string; label: string | null; startedAt: string; finishedAt: string; gitSha: string | null; gitDirty: boolean | null; promptVersion: string | null; model: string; loadAverage: { start: number[]; end: number[] } | null; trials: { warm: number; browser: number; cold: number }; groups: BenchGroup[] };
const benchCache = new Map<string, { mtimeMs: number; bench: BenchSummary | null }>();
export function listBenches(resultsDir: string): BenchSummary[] {
  const dir = path.join(resultsDir, "bench");
  if (!fs.existsSync(dir)) return [];
  const out: BenchSummary[] = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    const hit = benchCache.get(file);
    let bench = hit && hit.mtimeMs === st.mtimeMs ? hit.bench : null;
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      try {
        const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        bench = j.kind === "bench" ? { id: name.replace(/\.json$/, ""), label: str(j.label), startedAt: String(j.startedAt), finishedAt: String(j.finishedAt), gitSha: str(j.gitSha), gitDirty: typeof j.gitDirty === "boolean" ? j.gitDirty : null, promptVersion: str(j.promptVersion), model: str(j.model) ?? "unknown", loadAverage: (j.loadAverage as BenchSummary["loadAverage"]) ?? null, trials: j.trials as BenchSummary["trials"], groups: (j.summary as BenchGroup[]) ?? [] } : null;
      } catch {
        bench = null;
      }
      benchCache.set(file, { mtimeMs: st.mtimeMs, bench });
    }
    if (bench) out.push(bench);
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

