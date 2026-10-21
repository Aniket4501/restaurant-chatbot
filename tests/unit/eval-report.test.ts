import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AREAS, areaOf } from "@/evals/areas";
import { CATEGORIES } from "@/evals/case";
import { baselineFor, caseStatuses, compareRuns, latencySummary, listBenches, listRuns, loadRun, previousComparable, renderMarkdown, summarize, type Run } from "@/evals/report";
import type { CaseResult } from "@/evals/run";

// D-21: the report and the dashboard derive every number from results files. These tests pin the denominators, the
// case statuses, the comparison, and how unfinished or old files are read.
type Turn = CaseResult["turns"][number];
const turn = (o: Partial<Turn> = {}): Turn => ({ index: 0, kind: "guest", input: "x", reply: "ok", blocks: [], cited: [], outcome: "faq_answer", intent: "faq", retrievalMode: "hybrid", latencyMs: 1000, modelMs: 900, promptTokens: 100, cachedTokens: 90, outputTokens: 10, firstTryValid: true, ...o });
const res = (o: Partial<CaseResult>): CaseResult => ({ id: "X", category: "faq", severity: "major", run: 1, passed: true, status: "pass", durationMs: 5, expect: { expect: null, forbidden: [], notes: null, variantOf: null }, failures: [], violations: [], checks: [], offered: { total: 0, open: 0 }, modelCalls: 1, turns: [turn()], ...o });
const fail = (o: Partial<CaseResult>) => res({ passed: false, status: "fail", failures: ["turn 1: wrong"], ...o });
const run = (id: string, results: CaseResult[], meta: Record<string, unknown> = {}): Run => ({ summary: summarize(id, `${id}.json`, { kind: "eval-live", mode: "live", suite: "full", startedAt: `2026-10-2${id.length % 9}T00:00:00.000Z`, ...meta }, results, null, "complete", null), results });

describe("areas", () => {
  it("put every category in exactly one area", () => {
    for (const c of CATEGORIES) expect(areaOf(c), c).not.toBe("other");
    const all = AREAS.flatMap((a) => a.categories);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("summaries: counts and denominators", () => {
  it("counts cases (not case results) as passed, failed, errored and flaky across repeated runs", () => {
    const s = summarize("r", "r.json", { kind: "eval-live", mode: "live", runs: 2, dataset: { cases: 4 } }, [res({ id: "A" }), res({ id: "A", run: 2 }), fail({ id: "B" }), fail({ id: "B", run: 2 }), res({ id: "C" }), fail({ id: "C", run: 2 }), res({ id: "D", status: "error", passed: false })], null, "complete", null);
    expect(s.counts).toEqual({ selected: 4, executed: 4, passed: 1, failed: 1, errored: 1, flaky: 1, skipped: 0, caseResults: 7 });
  });
  it("shows no rate without data, and every rate with its n", () => {
    const s = summarize("r", "r.json", { kind: "eval-live" }, [res({ id: "A", checks: [{ key: "intent", ok: true, detail: "" }, { key: "intent", ok: false, detail: "" }] })], null, "complete", null);
    const understanding = s.areas.find((a) => a.key === "understanding")!;
    expect(understanding.rate).toBeNull();
    expect(understanding.n).toBe(0);
    expect(understanding.stats.find((x) => x.key === "intentAccuracy")).toMatchObject({ value: 0.5, n: 2 });
    expect(s.areas.find((a) => a.key === "recommendations")!.stats.find((x) => x.key === "constraintCompliance")).toMatchObject({ value: null, n: 0 });
  });
  it("counts false confirmations and critical cases separately from other failures", () => {
    const s = summarize("r", "r.json", { kind: "eval-live" }, [fail({ id: "A", severity: "critical", violations: [{ inv: "INV-04", turn: 0, detail: "claim" }] }), fail({ id: "B" })], null, "complete", null);
    expect(s.critical).toEqual({ invariantViolations: 1, falseConfirmations: 1, duplicateBookings: 0, criticalCasesFailed: 1 });
  });
  it("scores a noisy variant against its clean case's intent in the same run", () => {
    const s = summarize("r", "r.json", { kind: "eval-live" }, [res({ id: "CLEAN", turns: [turn({ intent: "booking" })] }), res({ id: "V1", category: "normalization", expect: { expect: null, forbidden: [], notes: null, variantOf: "CLEAN" }, turns: [turn({ intent: "booking" })] }), res({ id: "V2", category: "normalization", expect: { expect: null, forbidden: [], notes: null, variantOf: "CLEAN" }, turns: [turn({ intent: "faq" })] })], null, "complete", null);
    expect(s.areas.find((a) => a.key === "normalization")!.stats[0]).toMatchObject({ value: 0.5, n: 2 });
  });
  it("hides p95 latency below 20 turns", () => {
    const s = summarize("r", "r.json", { kind: "eval-live" }, [res({ id: "A" })], null, "complete", null);
    expect(s.areas.find((a) => a.key === "reliability")!.stats.find((x) => x.key === "latencyP95")).toMatchObject({ value: null, n: 1 });
  });
});

describe("latency summary (D-24)", () => {
  const timing = (o: Record<string, number | null> = {}) => ({ setupMs: 2, retrievalMs: 30, promptMs: 1, queueMs: 0, statusMs: 3, turnModelMs: 2000, chooserMs: null, otherMs: 4, calls: 1, loadMs: 1, promptEvalMs: 400, evalMs: 1500, evalTokens: 100, uncachedPromptTokens: 600, ...o });
  it("splits model and no-model turns, gives p95 only from 20 turns, and medians per stage", () => {
    const model = Array.from({ length: 20 }, (_, i) => turn({ latencyMs: 1000 + i * 100, timing: timing() }));
    const chips = [turn({ latencyMs: 3, modelMs: null, intent: null, outcome: "ask_field", timing: timing({ calls: 0, turnModelMs: null, retrievalMs: null, evalTokens: null, evalMs: null }) })];
    const l = latencySummary([res({ turns: [...model, ...chips] })]);
    expect(l.modelTurns).toMatchObject({ n: 20, p50: 1900, p95: 2800 }); // nearest rank: the 19th of 20
    expect(l.noModelTurns).toMatchObject({ n: 1, p50: 3, p95: null }); // fewer than 20: no p95
    expect(l.stages?.find((x) => x.key === "turnModelMs")).toMatchObject({ p50: 2000, n: 20 });
    expect(l.stages?.find((x) => x.key === "chooserMs")).toMatchObject({ p50: null, n: 0 });
    expect(l.model).toMatchObject({ n: 20, callsMean: 1, evalTokensP50: 100, msPerOutputToken: 15 });
  });
  it("a run from before stage timings has totals only", () => {
    const l = latencySummary([res({ turns: [turn({ latencyMs: 1200 }), turn({ latencyMs: 5, modelMs: null })] })]);
    expect(l.modelTurns).toMatchObject({ n: 1, p50: 1200 });
    expect(l.noModelTurns).toMatchObject({ n: 1, p50: 5 });
    expect(l.stages).toBeNull();
    expect(l.model).toBeNull();
  });
  it("reads benchmark files, newest first, ignoring anything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
    fs.mkdirSync(path.join(dir, "bench"));
    const b = (startedAt: string, label: string | null) => ({ kind: "bench", label, startedAt, finishedAt: startedAt, gitSha: "abc1234", gitDirty: false, promptVersion: "v6", model: "qwen3.5:9b", loadAverage: { start: [2, 2, 2], end: [3, 3, 3] }, trials: { warm: 5, browser: 3, cold: 3 }, summary: [{ phase: "warm", key: "kind:lookup", n: 20, failed: 0, p50: 3000, p95: 4000, min: 2000, max: 5000, serverP50: 2900, stagesP50: {}, extra: {} }], samples: [] });
    fs.writeFileSync(path.join(dir, "bench", "a_bench_baseline.json"), JSON.stringify(b("2026-10-21T06:00:00.000Z", "baseline")));
    fs.writeFileSync(path.join(dir, "bench", "b_bench.json"), JSON.stringify(b("2026-10-21T09:00:00.000Z", null)));
    fs.writeFileSync(path.join(dir, "bench", "c.json"), JSON.stringify({ kind: "other" }));
    fs.writeFileSync(path.join(dir, "bench", "d.json"), "{ not json");
    const list = listBenches(dir);
    expect(list.map((x) => [x.id, x.label])).toEqual([["b_bench", null], ["a_bench_baseline", "baseline"]]);
    expect(list[0].groups[0]).toMatchObject({ key: "kind:lookup", p50: 3000 });
    expect(listBenches(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("comparisons", () => {
  it("compares a rerun of a few cases with its full run case by case, but not by area rate (review of D-24)", () => {
    const full = run("full-run", [res({ id: "A" }), res({ id: "B" }), fail({ id: "C" }), fail({ id: "D" })], { suite: "full" });
    const rerun = run("rerun", [res({ id: "C" }), fail({ id: "D" })], { selection: { case: "C,D" } });
    const cmp = compareRuns(full, rerun);
    expect(cmp.resolved.map((c) => c.id)).toEqual(["C"]);
    expect(cmp.areas.every((x) => x.delta === null)).toBe(true);
    expect(cmp.stats.every((x) => x.delta === null && !x.regressed)).toBe(true);
    expect(cmp.note).toMatch(/different sets of cases/);
    // Two full runs still compare by area, even when cases were added since.
    expect(compareRuns(full, run("full-2", [res({ id: "A" }), res({ id: "B" }), res({ id: "C" }), fail({ id: "D" }), res({ id: "E" })], { suite: "full" })).areas.some((x) => x.delta !== null)).toBe(true);
  });
  it("FM-044 an unfinished full run is compared case by case only, with a note, never by area rate or pass rate", () => {
    const full = run("full-run", [res({ id: "A" }), fail({ id: "B" }), res({ id: "C" }), fail({ id: "D" })], { suite: "full" });
    const results = [res({ id: "A" }), res({ id: "B" })];
    const partial: Run = { summary: summarize("part", "part.json", { kind: "eval-live", mode: "live", suite: "full", startedAt: "2026-10-22T00:00:00.000Z" }, results, null, "interrupted", null), results };
    const c = compareRuns(full, partial);
    expect(c.ratesComparable).toBe(false);
    expect(c.areas.every((x) => x.delta === null)).toBe(true);
    expect(c.stats.every((x) => x.delta === null && !x.regressed)).toBe(true);
    expect(c.note).toMatch(/^This run is unfinished/);
    expect(c.resolved.map((x) => x.id)).toEqual(["B"]);
    expect(compareRuns(full, run("full-2", [res({ id: "A" }), res({ id: "B" }), res({ id: "C" }), fail({ id: "D" })], { suite: "full" })).ratesComparable).toBe(true);
  });
  const base = run("base", [res({ id: "A" }), fail({ id: "B" }), res({ id: "C", severity: "critical" }), res({ id: "GONE" })]);
  const head = run("headrun", [res({ id: "A" }), res({ id: "B" }), fail({ id: "C", severity: "critical" }), res({ id: "NEW" })]);
  it("finds new failures, resolved and still-failing cases, and critical regressions", () => {
    const c = compareRuns(base, head);
    expect(c.newFailures.map((x) => x.id)).toEqual(["C"]);
    expect(c.resolved.map((x) => x.id)).toEqual(["B"]);
    expect(c.stillFailing).toEqual([]);
    expect(c.added.map((x) => x.id)).toEqual(["NEW"]);
    expect(c.removed.map((x) => x.id)).toEqual(["GONE"]);
    expect(c.criticalRegressions.map((x) => x.id)).toEqual(["C"]);
  });
  it("marks a worse rate as a regression even when the overall pass rate is higher", () => {
    const b = run("b", [res({ id: "A", checks: [{ key: "intent", ok: true, detail: "" }] }), fail({ id: "B" })]);
    const h = run("hh", [res({ id: "A", checks: [{ key: "intent", ok: false, detail: "" }] }), res({ id: "B" })]);
    const c = compareRuns(b, h);
    expect(c.stats.find((x) => x.key === "intentAccuracy")).toMatchObject({ delta: -1, regressed: true });
  });
  it("picks the previous finished run of the same mode and suite, and the saved baseline", () => {
    const older = run("o", [res({ id: "A" })], { startedAt: "2026-10-19T00:00:00.000Z" });
    const smoke = run("s", [res({ id: "A" })], { startedAt: "2026-10-19T12:00:00.000Z", suite: "smoke" });
    const latest = run("l", [res({ id: "A" })], { startedAt: "2026-10-20T00:00:00.000Z" });
    expect(previousComparable([latest, smoke, older], latest)?.summary.id).toBe("o");
    expect(baselineFor({ "live-full": { id: "o", setAt: "", note: null } }, [latest, older], latest)?.summary.id).toBe("o");
    expect(baselineFor({ "live-full": { id: "l", setAt: "", note: null } }, [latest, older], latest)).toBeNull(); // not itself
  });
  it("renders the comparison and each failing case's rerun command", () => {
    const md = renderMarkdown(head, compareRuns(base, head));
    expect(md).toContain("New failures (1): C [critical]");
    expect(md).toContain("`npx tsx evals/run.ts --mode live --case C`");
  });
});

describe("reading results files", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "rc-evals-"));
  const header = (o: Record<string, unknown>) => JSON.stringify({ header: { mode: "live", suite: "full", startedAt: "2026-10-21T10:00:00.000Z", selected: ["A", "B", "C"], runs: 1, pid: 99999999, ...o } });
  it("reads an interrupted progress file as interrupted, with the unrun cases counted as not run (never as passed)", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "2026-10-21T10-00-00-000Z_live.partial.jsonl"), `${header({})}\n${JSON.stringify(res({ id: "A" }))}\n{"id":"B","cut`);
    const [r] = listRuns(d);
    expect(r.summary.status).toBe("interrupted");
    expect(r.summary.counts).toMatchObject({ selected: 3, executed: 1, passed: 1, skipped: 2 });
  });
  it("shows a progress file as running while its process is alive", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "2026-10-21T10-00-00-000Z_live.partial.jsonl"), `${header({ pid: process.pid })}\n`);
    expect(listRuns(d)[0].summary.status).toBe("running");
  });
  it("leaves out a progress file whose run finished, and files that are not eval runs", () => {
    const d = dir();
    fs.writeFileSync(path.join(d, "2026-10-21T10-00-00-000Z_live.partial.jsonl"), `${header({})}\n${JSON.stringify(res({ id: "A" }))}\n`);
    fs.writeFileSync(path.join(d, "2026-10-21T10-00-00-000Z_qwen.json"), JSON.stringify({ meta: { kind: "eval-live", startedAt: "2026-10-21T10:00:00.000Z" }, results: [res({ id: "A" })] }));
    fs.writeFileSync(path.join(d, "2026-10-19T00-00-00-000Z_probe.json"), JSON.stringify({ meta: { kind: "model-probe" }, results: [] }));
    const runs = listRuns(d);
    expect(runs.map((r) => [r.summary.id, r.summary.status])).toEqual([["2026-10-21T10-00-00-000Z_qwen", "complete"]]);
  });
  it("reads a results file written before D-21 (no status or per-turn index)", () => {
    const d = dir();
    const old = { ...res({ id: "A", passed: false, failures: ["error: setup book failed"] }) } as Partial<CaseResult>;
    delete old.status;
    delete old.expect;
    const f = path.join(d, "2026-10-19T00-00-00-000Z_qwen.json");
    fs.writeFileSync(f, JSON.stringify({ meta: { kind: "eval-live", runs: 1 }, results: [old] }));
    const r = loadRun(f)!;
    expect(r.results[0].status).toBe("error");
    expect(r.summary.counts.errored).toBe(1);
  });
  it("aggregates statuses per case for repeated runs", () => {
    expect([...caseStatuses([res({ id: "A" }), fail({ id: "A", run: 2 })]).values()][0]).toMatchObject({ status: "flaky", runs: 2, passes: 1 });
  });
});

describe("response-shape checks (every reply, D-21)", async () => {
  const { checkUx } = await import("@/evals/run");
  const ux = (text: string, notices: string[] = []) => checkUx({ index: 0, kind: "guest", shown: { text, blocks: notices.map((n) => ({ type: "notice" as const, tone: "warning" as const, text: n })) } }).filter((c) => !c.ok).map((c) => c.key);
  it("passes ordinary replies, prices, times and a question", () => {
    expect(ux("The Mango Sorbet is ₹245. We're open 12:00 PM to 3:30 PM. Would you like a table?")).toEqual([]);
    expect(ux("Golf Course Road has free valet parking from 12:00 PM to 11:00 PM.", ["Menu labels only list the main allergens."])).toEqual([]);
  });
  it("flags fact IDs, JSON, internal wording and the same text twice", () => {
    expect(ux("See menu:dal-ember for details.")).toEqual(["ux.leak"]);
    expect(ux('{"intent": "faq"}')).toEqual(["ux.json"]);
    expect(ux("Desserts (6 available), cheapest first")).toEqual(["ux.internal"]);
    expect(ux("Q: Can I bring my dog? A: Yes.")).toEqual(["ux.internal"]); // the old info card's format
    expect(ux("Here it is.\nQ: Can I bring my dog?\nA: Yes.")).toEqual(["ux.internal"]);
    expect(ux("Sorry, I couldn't check availability just now.", ["Sorry, I couldn't check availability just now."])).toEqual(["ux.duplicate"]);
    expect(ux("I can help with bookings and the menu. I can help with bookings and the menu.")).toEqual(["ux.duplicate"]);
  });
});
