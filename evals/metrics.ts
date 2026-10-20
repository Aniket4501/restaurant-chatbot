import type { CaseResult } from "@/evals/run";

// §6.5 metrics from a run's case results, and the check against evals/thresholds.json. Pure: the runner passes the
// results (and the live retrieval measurement); tests pass synthetic ones.

export type Rate = { value: number | null; n: number };
export type Latency = { n: number; p50: number | null; p95: number | null };
export type Metrics = {
  cases: number;
  runs: number;
  passRate: Rate;
  byCategory: Record<string, { results: number; passed: number }>;
  gates: {
    criticalInvariantViolations: number;
    duplicateBookingRate: Rate;
    availabilityAccuracy: Rate;
    unsupportedClaimsShown: number;
    injectionResistance: Rate;
    recoverySuccess: Rate;
    abstentionOnUnknown: Rate;
  };
  floors: { intentAccuracy: Rate; bookingFieldExtractionExact: Rate; backendActionCorrectness: Rate; groundedAnswerCorrectness: Rate; firstTrySchemaValidity: Rate };
  latency: { booking: Latency; faq: Latency; firstRunBooking: Latency; firstRunFaq: Latency };
  tokens: { promptMax: number | null; promptMean: number | null; cachedMean: number | null; outputMean: number | null };
  repeatability: { flaky: string[]; alwaysFail: string[] };
  retrieval: RetrievalMetrics | null;
};
export type RetrievalMetrics = { queries: number; hybrid: { hitAt8: number; recallAt8: number } | null; lexical: { hitAt8: number; recallAt8: number } };

const RECOVERY = new Set(["malformed_output", "backend_failure", "retry_after_timeout", "context_loss"]);
const GROUNDED_KEYS = new Set(["mustCite", "mustCiteAny", "mustIncludeValues", "mustNotIncludeValues", "answer"]);

const rate = (ok: number, n: number): Rate => ({ value: n ? ok / n : null, n });
const checksRate = (results: CaseResult[], keys: Set<string>): Rate => {
  const cs = results.flatMap((r) => r.checks).filter((c) => keys.has(c.key));
  return rate(cs.filter((c) => c.ok).length, cs.length);
};
function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const lat = (xs: number[]): Latency => ({ n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95) });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function computeMetrics(results: CaseResult[], retrieval: RetrievalMetrics | null = null): Metrics {
  const ids = [...new Set(results.map((r) => r.id))];
  const runs = Math.max(0, ...results.map((r) => r.run));
  const byCategory: Metrics["byCategory"] = {};
  for (const r of results) {
    byCategory[r.category] ??= { results: 0, passed: 0 };
    byCategory[r.category].results++;
    if (r.passed) byCategory[r.category].passed++;
  }
  const cat = (pred: (c: string) => boolean) => {
    const rs = results.filter((r) => pred(r.category));
    return rate(rs.filter((r) => r.passed).length, rs.length);
  };
  const violations = results.flatMap((r) => r.violations);
  const offered = results.reduce((a, r) => ({ total: a.total + r.offered.total, open: a.open + r.offered.open }), { total: 0, open: 0 });
  const turns = results.flatMap((r) => r.turns.map((t) => ({ ...t, run: r.run })));
  const modelTurns = turns.filter((t) => t.firstTryValid !== null);
  const timed = (intent: string, firstRunOnly: boolean) => turns.filter((t) => t.intent === intent && t.latencyMs !== null && (!firstRunOnly || t.run === 1)).map((t) => t.latencyMs!);
  const passesById = ids.map((id) => ({ id, passes: results.filter((r) => r.id === id && r.passed).length, runs: results.filter((r) => r.id === id).length }));
  return {
    cases: ids.length,
    runs,
    passRate: rate(results.filter((r) => r.passed).length, results.length),
    byCategory,
    gates: {
      criticalInvariantViolations: violations.length,
      duplicateBookingRate: rate(violations.filter((v) => v.inv === "INV-02").length, results.length),
      availabilityAccuracy: rate(offered.open, offered.total),
      unsupportedClaimsShown: violations.filter((v) => v.inv === "INV-04" || v.inv === "INV-05").length,
      injectionResistance: cat((c) => c === "injection"),
      recoverySuccess: cat((c) => RECOVERY.has(c)),
      abstentionOnUnknown: checksRate(results, new Set(["abstain"])),
    },
    floors: {
      intentAccuracy: checksRate(results, new Set(["intent"])),
      bookingFieldExtractionExact: checksRate(results, new Set(["draft"])),
      backendActionCorrectness: checksRate(results, new Set(["actions", "noActions"])),
      groundedAnswerCorrectness: checksRate(results, GROUNDED_KEYS),
      firstTrySchemaValidity: rate(modelTurns.filter((t) => t.firstTryValid).length, modelTurns.length),
    },
    latency: { booking: lat(timed("booking", false)), faq: lat(timed("faq", false)), firstRunBooking: lat(timed("booking", true)), firstRunFaq: lat(timed("faq", true)) },
    tokens: {
      promptMax: modelTurns.length ? Math.max(...modelTurns.map((t) => t.promptTokens ?? 0)) : null,
      promptMean: mean(modelTurns.flatMap((t) => (t.promptTokens === null ? [] : [t.promptTokens]))),
      cachedMean: mean(modelTurns.flatMap((t) => (t.cachedTokens === null ? [] : [t.cachedTokens]))),
      outputMean: mean(modelTurns.flatMap((t) => (t.outputTokens === null ? [] : [t.outputTokens]))),
    },
    repeatability: {
      flaky: passesById.filter((x) => x.runs > 1 && x.passes > 0 && x.passes < x.runs).map((x) => x.id),
      alwaysFail: passesById.filter((x) => x.passes === 0).map((x) => x.id),
    },
    retrieval,
  };
}

export type Thresholds = {
  live: { gates: Record<string, number>; floors: Record<string, number>; retrieval: Record<string, number> };
  report: { warmLatencyP95TargetMs: number; promptTokensMax: number };
  overrides: { metric: string; value: number; decision: string }[];
};
export type ThresholdLine = { metric: string; value: number | null; want: string; ok: boolean; override: string | null };

/** Every gate and floor against thresholds.json. A G3-approved override (with its DECISIONS id) counts as met but is printed. */
export function checkThresholds(m: Metrics, t: Thresholds): ThresholdLine[] {
  const lines: ThresholdLine[] = [];
  const add = (metric: string, value: number | null, want: number, dir: "max" | "min") => {
    const met = value !== null && (dir === "min" ? value >= want : value <= want);
    const o = t.overrides.find((x) => x.metric === metric && value !== null && (dir === "min" ? value >= x.value : value <= x.value));
    lines.push({ metric, value, want: `${dir === "min" ? "≥" : "≤"} ${want}`, ok: met || !!o, override: !met && o ? o.decision : null });
  };
  add("criticalInvariantViolations", m.gates.criticalInvariantViolations, 0, "max");
  add("duplicateBookingRate", m.gates.duplicateBookingRate.value, t.live.gates.duplicateBookingRate, "max");
  add("availabilityAccuracy", m.gates.availabilityAccuracy.value ?? 1, t.live.gates.availabilityAccuracy, "min");
  add("unsupportedClaimsShown", m.gates.unsupportedClaimsShown, t.live.gates.unsupportedClaimsShown, "max");
  add("injectionResistance", m.gates.injectionResistance.value, t.live.gates.injectionResistance, "min");
  add("recoverySuccess", m.gates.recoverySuccess.value, t.live.gates.recoverySuccess, "min");
  add("abstentionOnUnknown", m.gates.abstentionOnUnknown.value, t.live.gates.abstentionOnUnknown, "min");
  add("intentAccuracy", m.floors.intentAccuracy.value, t.live.floors.intentAccuracy, "min");
  add("bookingFieldExtractionExact", m.floors.bookingFieldExtractionExact.value, t.live.floors.bookingFieldExtractionExact, "min");
  add("backendActionCorrectness", m.floors.backendActionCorrectness.value, t.live.floors.backendActionCorrectness, "min");
  add("groundedAnswerCorrectness", m.floors.groundedAnswerCorrectness.value, t.live.floors.groundedAnswerCorrectness, "min");
  add("firstTrySchemaValidity", m.floors.firstTrySchemaValidity.value, t.live.floors.firstTrySchemaValidity, "min");
  if (m.retrieval) {
    add("retrieval.hybridHitAt8", m.retrieval.hybrid?.hitAt8 ?? null, t.live.retrieval.hybridHitAt8, "min");
    add("retrieval.hybridRecallAt8", m.retrieval.hybrid?.recallAt8 ?? null, t.live.retrieval.hybridRecallAt8, "min");
    add("retrieval.lexicalHitAt8", m.retrieval.lexical.hitAt8, t.live.retrieval.lexicalHitAt8, "min");
  }
  add("promptTokensMax", m.tokens.promptMax, t.report.promptTokensMax, "max");
  return lines;
}
