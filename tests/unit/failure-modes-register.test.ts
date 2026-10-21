import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareFm, entryResults, fmBaseFor, fromPlaywright, fromVitest, gateOf, loadRegister, summarizeFm, type FmRun, type TestResult } from "@/evals/failure-modes";

// D-29: the register (evals/failure-modes.json) and how a run's test results become entry statuses, the release gate and
// the comparison with the baseline. Deterministic: no tests are run here.
const ROOT = path.resolve(__dirname, "../..");
const reg = loadRegister(path.join(ROOT, "evals/failure-modes.json"));
const t = (name: string, status: TestResult["status"], file = "tests/unit/x.test.ts"): TestResult => ({ suite: file.startsWith("tests/e2e") ? "e2e" : "vitest", file, name, status, durationMs: 1, failure: status === "failed" ? "AssertionError" : null });
const run = (id: string, startedAt: string, tests: TestResult[], label: string | null = null): FmRun =>
  summarizeFm(reg, entryResults(reg, tests, { e2eRan: false, only: new Set(["FM-021", "FM-022", "FM-036"]) }), { id, label, startedAt, durationMs: 1, gitSha: null, gitDirty: null, source: { vitest: "test", e2e: null } });

describe("the failure-mode register", () => {
  it("has every ID once, in order, with a known category, verdict and fix status", () => {
    expect(reg.failureModes.map((f) => f.id)).toEqual(Array.from({ length: reg.failureModes.length }, (_, i) => `FM-${String(i + 1).padStart(3, "0")}`));
    expect(reg.failureModes.length).toBeGreaterThanOrEqual(40);
    expect(reg.failureModes.filter((f) => f.origin === "given")).toHaveLength(20);
    const cats = new Set(reg.categories.map((c) => c.key));
    for (const f of reg.failureModes) {
      expect(cats.has(f.category), f.id).toBe(true);
      expect(["confirmed", "code-level", "not-reproduced", "not-applicable", "unverified"], f.id).toContain(f.verdict);
      for (const k of ["title", "trigger", "expected", "actual", "rootCause", "resolution"] as const) expect(f[k], `${f.id} ${k}`).toBeTruthy();
      // A P0/P1 needs its impact stated; a defect marked fixed needs a test.
      if (f.severity === "P0" || f.severity === "P1") expect(f.impact, f.id).toBeTruthy();
      if (f.fix === "fixed") expect(f.testFiles.length, f.id).toBeGreaterThan(0);
    }
  });
  it("lists exactly the test files whose names carry each ID, and every ID used in a test exists", () => {
    const ids = new Set(reg.failureModes.map((f) => f.id));
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(test|spec)\.ts$/.test(e.name) ? [path.join(d, e.name)] : []));
    const found = new Map<string, Set<string>>();
    // IDs in test and describe titles only (the runner maps results by name); fixture data may mention IDs too.
    const titles = (src: string) => [...src.matchAll(/\b(?:it|test|describe)(?:\.each\([^)]*\))?\(\s*(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]).join(" ");
    for (const file of walk(path.join(ROOT, "tests"))) for (const m of titles(fs.readFileSync(file, "utf8")).matchAll(/FM-\d{3}/g)) found.set(m[0], (found.get(m[0]) ?? new Set()).add(path.relative(ROOT, file)));
    for (const id of found.keys()) expect(ids.has(id), id).toBe(true);
    for (const f of reg.failureModes) expect(f.testFiles, f.id).toEqual([...(found.get(f.id) ?? [])].sort());
  });
  it("maps journeys A–J to existing eval cases and register entries", () => {
    expect(reg.journeys.map((j) => j.id)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    const cases = new Set(fs.readdirSync(path.join(ROOT, "evals/cases")).flatMap((n) => fs.readFileSync(path.join(ROOT, "evals/cases", n), "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id)));
    for (const j of reg.journeys) {
      for (const c of j.evalCases) expect(cases.has(c), `${j.id} ${c}`).toBe(true);
      for (const id of j.failureModes) expect(reg.failureModes.some((f) => f.id === id), `${j.id} ${id}`).toBe(true);
    }
  });
});

describe("failure-mode runs", () => {
  it("maps each test to every ID in its name; any failing test fails the entry", () => {
    const r = run("r", "2026-10-22T00:00:00.000Z", [t("FM-021 a", "passed"), t("FM-021/FM-022 shared", "failed"), t("FM-036 b", "passed")]);
    expect(r.entries.map((e) => [e.id, e.status])).toEqual([["FM-021", "fail"], ["FM-022", "fail"], ["FM-036", "pass"]]);
    expect(r.counts).toMatchObject({ entries: 3, pass: 1, fail: 2, tests: 3, testsPassed: 2, testsFailed: 1 });
  });
  it("an entry whose only tests are E2E specs is 'not run' when E2E didn't run, and 'no test' without tests", () => {
    const e = entryResults(reg, [], { e2eRan: false, only: new Set(["FM-017", "FM-052"]) });
    expect(e.map((x) => [x.id, x.status])).toEqual([["FM-017", "not run"], ["FM-052", "no test"]]);
  });
  it("blocks the release on a P1 safety or booking entry that fails, and not on a P3", () => {
    const failing = (id: string) => [{ id, status: "fail" as const, tests: [] }];
    expect(gateOf(reg, failing("FM-021"))).toEqual({ ok: false, blocking: [{ id: "FM-021", reason: "a test fails" }] });
    expect(gateOf(reg, failing("FM-036")).ok).toBe(true); // P2
  });
  it("compares with the baseline-labelled run before it: resolved, new and recurring failures", () => {
    const base = run("b", "2026-10-21T00:00:00.000Z", [t("FM-021", "failed"), t("FM-022", "passed"), t("FM-036", "failed")], "baseline-x");
    const mid = run("m", "2026-10-21T12:00:00.000Z", [t("FM-021", "passed")]);
    const head = run("h", "2026-10-22T00:00:00.000Z", [t("FM-021", "passed"), t("FM-022", "failed"), t("FM-036", "failed")]);
    expect(fmBaseFor([head, mid, base], head)?.id).toBe("b");
    expect(compareFm(base, head)).toMatchObject({ resolved: ["FM-021"], newFailures: ["FM-022"], recurring: ["FM-036"] });
  });
  it("reads the vitest and Playwright JSON reporters", () => {
    const v = fromVitest({ testResults: [{ name: "/r/tests/unit/a.test.ts", status: "failed", assertionResults: [{ ancestorTitles: ["d"], title: "FM-021 x", status: "failed", duration: 3, failureMessages: ["\u001b[31mAssertionError: no\u001b[39m\n at y"] }] }] }, "/r");
    expect(v).toEqual([{ suite: "vitest", file: "tests/unit/a.test.ts", name: "d > FM-021 x", status: "failed", durationMs: 3, failure: "AssertionError: no" }]);
    const p = fromPlaywright({ suites: [{ title: "guest.spec.ts", file: "tests/e2e/guest.spec.ts", specs: [{ title: "FM-017 y", file: "tests/e2e/guest.spec.ts", tests: [{ results: [{ status: "failed", duration: 5 }, { status: "passed", duration: 4 }] }] }] }] });
    expect(p).toEqual([{ suite: "e2e", file: "tests/e2e/guest.spec.ts", name: "FM-017 y", status: "passed", durationMs: 4, failure: null }]);
  });
});
