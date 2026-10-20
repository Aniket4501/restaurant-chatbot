import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkThresholds, computeMetrics, type Thresholds } from "@/evals/metrics";
import type { CaseResult } from "@/evals/run";

const thresholds = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/thresholds.json"), "utf8")) as Thresholds;
type Turn = CaseResult["turns"][number];
const turn = (o: Partial<Turn>): Turn => ({ index: 0, kind: "guest", input: "x", reply: "", blocks: [], cited: [], outcome: "faq_answer", intent: "faq", retrievalMode: "hybrid", latencyMs: 1000, modelMs: 900, promptTokens: 3600, cachedTokens: 3500, outputTokens: 50, firstTryValid: true, ...o });
const result = (o: Partial<CaseResult>): CaseResult => ({ id: "X", category: "faq", severity: "critical", run: 1, passed: true, status: "pass", durationMs: 10, expect: { expect: null, forbidden: [], notes: null, variantOf: null }, failures: [], violations: [], checks: [], offered: { total: 0, open: 0 }, modelCalls: 1, turns: [turn({})], ...o });

describe("computeMetrics (§6.5)", () => {
  it("scores each metric from its expectation keys and categories", () => {
    const m = computeMetrics([
      result({ id: "A", checks: [{ key: "intent", ok: true, detail: "" }, { key: "mustCiteAny", ok: true, detail: "" }] }),
      result({ id: "B", passed: false, checks: [{ key: "intent", ok: false, detail: "" }, { key: "abstain", ok: false, detail: "" }], turns: [turn({ firstTryValid: false, latencyMs: 3000 })] }),
      result({ id: "C", category: "injection", checks: [{ key: "noActions", ok: true, detail: "" }] }),
      result({ id: "D", category: "booking_intent", checks: [{ key: "draft", ok: true, detail: "" }], turns: [turn({ intent: "booking", latencyMs: 2000 })], offered: { total: 4, open: 4 } }),
    ]);
    expect(m.passRate).toEqual({ value: 0.75, n: 4 });
    expect(m.floors.intentAccuracy).toEqual({ value: 0.5, n: 2 });
    expect(m.floors.groundedAnswerCorrectness).toEqual({ value: 1, n: 1 });
    expect(m.gates.abstentionOnUnknown).toEqual({ value: 0, n: 1 });
    expect(m.gates.injectionResistance).toEqual({ value: 1, n: 1 });
    expect(m.gates.availabilityAccuracy).toEqual({ value: 1, n: 4 });
    expect(m.floors.firstTrySchemaValidity).toEqual({ value: 0.75, n: 4 });
    expect(m.latency.faq).toEqual({ n: 3, p50: 1000, p95: 3000 });
    expect(m.latency.booking).toEqual({ n: 1, p50: 2000, p95: 2000 });
  });
  it("finds flaky and always-failing cases across runs", () => {
    const m = computeMetrics([result({ id: "A", run: 1 }), result({ id: "A", run: 2, passed: false }), result({ id: "B", run: 1, passed: false }), result({ id: "B", run: 2, passed: false })]);
    expect(m.repeatability).toEqual({ flaky: ["A"], alwaysFail: ["B"] });
  });
});

describe("checkThresholds", () => {
  const base = () => computeMetrics([result({ checks: [{ key: "intent", ok: true, detail: "" }, { key: "draft", ok: true, detail: "" }, { key: "actions", ok: true, detail: "" }, { key: "mustCite", ok: true, detail: "" }, { key: "abstain", ok: true, detail: "" }] }), result({ id: "I", category: "injection" }), result({ id: "R", category: "backend_failure" })], { queries: 30, hybrid: { hitAt8: 1, recallAt8: 0.95 }, lexical: { hitAt8: 0.867, recallAt8: 0.83 } });
  it("passes when every gate and floor is met", () => {
    const lines = checkThresholds(base(), thresholds);
    expect(lines.filter((l) => !l.ok)).toEqual([]);
    expect(lines.map((l) => l.metric)).toContain("retrieval.hybridRecallAt8");
  });
  it("fails a missed floor, and accepts it only with an approved override", () => {
    const m = base();
    m.floors.intentAccuracy = { value: 0.8, n: 10 };
    expect(checkThresholds(m, thresholds).find((l) => l.metric === "intentAccuracy")).toMatchObject({ ok: false, override: null });
    const withOverride = { ...thresholds, overrides: [{ metric: "intentAccuracy", value: 0.8, decision: "D-99 (G3)" }] };
    expect(checkThresholds(m, withOverride).find((l) => l.metric === "intentAccuracy")).toMatchObject({ ok: true, override: "D-99 (G3)" });
  });
  it("treats a metric with no data as unmet, never as a pass", () => {
    const m = computeMetrics([result({})]);
    expect(checkThresholds(m, thresholds).find((l) => l.metric === "injectionResistance")).toMatchObject({ value: null, ok: false });
  });
});
