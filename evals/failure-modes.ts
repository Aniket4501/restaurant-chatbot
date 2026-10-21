import fs from "node:fs";
import path from "node:path";

// D-29: the failure-mode register (evals/failure-modes.json) and its results. A register entry's tests are the vitest
// and Playwright tests whose names carry its ID ("FM-021 …"); a run maps each test result to every ID in its name.
// Nothing here scores model output: the tests decide, and these functions only count and compare their results.

export type Severity = "P0" | "P1" | "P2" | "P3";
export type Verdict = "confirmed" | "code-level" | "not-reproduced" | "not-applicable" | "unverified";
export type FixStatus = "fixed" | "partly fixed" | "no change needed" | "accepted risk" | "proposed";
export type FailureMode = {
  id: string;
  origin: "given" | "discovered";
  scenario: number | null;
  category: string;
  severity: Severity | null;
  likelihood: "low" | "medium" | "high" | null;
  impact: string | null;
  verdict: Verdict;
  fix: FixStatus;
  title: string;
  trigger: string;
  expected: string;
  actual: string;
  rootCause: string;
  resolution: string;
  remainingRisk: string | null;
  /** How a fix was shown to matter when the register's baseline run couldn't run its test (E2E specs). */
  baselineEvidence: string | null;
  testFiles: string[];
  deterministic: boolean;
  repro: string | null;
};
export type Register = {
  version: number;
  description: string;
  releaseGate: { severities: Severity[]; categories: string[]; rule: string };
  categories: { key: string; label: string }[];
  journeys: { id: string; title: string; adaptation: string | null; evalCases: string[]; failureModes: string[]; e2e: string[] }[];
  failureModes: FailureMode[];
};

export type TestResult = { suite: "vitest" | "e2e"; file: string; name: string; status: "passed" | "failed" | "skipped"; durationMs: number | null; failure: string | null };
export type EntryStatus = "pass" | "fail" | "not run" | "no test";
export type EntryResult = { id: string; status: EntryStatus; tests: TestResult[] };
export type FmRun = {
  kind: "failure-modes";
  id: string;
  label: string | null;
  startedAt: string;
  durationMs: number | null;
  gitSha: string | null;
  gitDirty: boolean | null;
  source: { vitest: string; e2e: string | null };
  registerVersion: number;
  counts: { entries: number; pass: number; fail: number; notRun: number; noTest: number; tests: number; testsPassed: number; testsFailed: number; testsSkipped: number };
  bySeverity: { severity: string; entries: number; pass: number; fail: number }[];
  byCategory: { key: string; label: string; entries: number; pass: number; fail: number; rate: number | null }[];
  gate: { ok: boolean; blocking: { id: string; reason: string }[] };
  entries: EntryResult[];
};

export const FM_ID = /FM-\d{3}/g;
export const registerFile = (root: string) => path.join(root, "evals/failure-modes.json");
export const fmResultsDir = (resultsDir: string) => path.join(resultsDir, "failure-modes");

export function loadRegister(file: string): Register {
  const r = JSON.parse(fs.readFileSync(file, "utf8")) as Register;
  const ids = r.failureModes.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new Error("failure-modes.json: duplicate IDs");
  return r;
}

type VitestJson = { testResults: { name: string; status: string; message?: string; assertionResults: { ancestorTitles: string[]; title: string; status: string; duration?: number | null; failureMessages?: string[] }[] }[] };
type PlaywrightJson = { suites: PwSuite[] };
type PwSuite = { title: string; file?: string; specs?: { title: string; file?: string; tests: { results: { status: string; duration: number; error?: { message?: string } }[] }[] }[]; suites?: PwSuite[] };

const firstLine = (s: string | undefined | null) => (s ? s.replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim())?.trim().slice(0, 300) ?? null : null);

/** Vitest's JSON reporter output as test results. A file that failed to load counts as one failed test per ID it names. */
export function fromVitest(json: VitestJson, root: string): TestResult[] {
  const out: TestResult[] = [];
  for (const f of json.testResults) {
    const file = path.relative(root, f.name);
    for (const a of f.assertionResults) {
      const status = a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped";
      out.push({ suite: "vitest", file, name: [...a.ancestorTitles, a.title].join(" > "), status, durationMs: a.duration ?? null, failure: status === "failed" ? firstLine(a.failureMessages?.[0]) : null });
    }
    if (f.status === "failed" && f.assertionResults.length === 0) out.push({ suite: "vitest", file, name: `${file} (failed to load)`, status: "failed", durationMs: null, failure: firstLine(f.message) });
  }
  return out;
}

/** Playwright's JSON reporter output as test results (the last retry decides). */
export function fromPlaywright(json: PlaywrightJson): TestResult[] {
  const out: TestResult[] = [];
  const walk = (s: PwSuite, file: string) => {
    for (const spec of s.specs ?? [])
      for (const t of spec.tests) {
        const last = t.results.at(-1);
        const status = !last ? "skipped" : last.status === "passed" ? "passed" : last.status === "skipped" ? "skipped" : "failed";
        out.push({ suite: "e2e", file: spec.file ?? file, name: spec.title, status, durationMs: last?.duration ?? null, failure: status === "failed" ? firstLine(last?.error?.message) : null });
      }
    for (const c of s.suites ?? []) walk(c, c.file ?? file);
  };
  for (const s of json.suites) walk(s, s.file ?? s.title);
  return out;
}

/** Each register entry's tests and status. An entry whose only tests are E2E specs is "not run" when E2E didn't run. */
export function entryResults(register: Register, tests: TestResult[], opts: { e2eRan: boolean; only?: Set<string> }): EntryResult[] {
  const byId = new Map<string, TestResult[]>();
  for (const t of tests) for (const id of new Set(`${t.file} ${t.name}`.match(FM_ID) ?? [])) byId.set(id, [...(byId.get(id) ?? []), t]);
  return register.failureModes
    .filter((f) => !opts.only || opts.only.has(f.id))
    .map((f) => {
      const ts = (byId.get(f.id) ?? []).filter((t) => t.status !== "skipped");
      const e2eOnly = f.testFiles.length > 0 && f.testFiles.every((x) => x.startsWith("tests/e2e/"));
      const status: EntryStatus = ts.some((t) => t.status === "failed") ? "fail" : ts.length ? "pass" : f.testFiles.length === 0 ? "no test" : e2eOnly && !opts.e2eRan ? "not run" : "no test";
      return { id: f.id, status, tests: byId.get(f.id) ?? [] };
    });
}

/** The release gate (register.releaseGate): blocked by a P0/P1 entry in a gated category that fails, has no test or isn't fixed. */
export function gateOf(register: Register, entries: EntryResult[]): FmRun["gate"] {
  const g = register.releaseGate;
  const blocking: { id: string; reason: string }[] = [];
  for (const e of entries) {
    const f = register.failureModes.find((x) => x.id === e.id)!;
    if (!f.severity || !g.severities.includes(f.severity) || !g.categories.includes(f.category)) continue;
    if (e.status === "fail") blocking.push({ id: f.id, reason: "a test fails" });
    else if (e.status !== "pass") blocking.push({ id: f.id, reason: e.status === "not run" ? "its tests were not run" : "no test" });
    else if (f.fix !== "fixed" && f.fix !== "no change needed") blocking.push({ id: f.id, reason: `fix status: ${f.fix}` });
  }
  return { ok: blocking.length === 0, blocking };
}

export function summarizeFm(register: Register, entries: EntryResult[], meta: Omit<FmRun, "kind" | "counts" | "bySeverity" | "byCategory" | "gate" | "entries" | "registerVersion">): FmRun {
  const fm = (id: string) => register.failureModes.find((x) => x.id === id)!;
  const tests = entries.flatMap((e) => e.tests).filter((t, i, all) => all.findIndex((x) => x.file === t.file && x.name === t.name) === i);
  const count = (es: EntryResult[]) => ({ entries: es.length, pass: es.filter((e) => e.status === "pass").length, fail: es.filter((e) => e.status === "fail").length });
  return {
    kind: "failure-modes",
    ...meta,
    registerVersion: register.version,
    counts: {
      ...count(entries),
      notRun: entries.filter((e) => e.status === "not run").length,
      noTest: entries.filter((e) => e.status === "no test").length,
      tests: tests.length,
      testsPassed: tests.filter((t) => t.status === "passed").length,
      testsFailed: tests.filter((t) => t.status === "failed").length,
      testsSkipped: tests.filter((t) => t.status === "skipped").length,
    },
    bySeverity: ["P0", "P1", "P2", "P3", "none"].map((s) => ({ severity: s, ...count(entries.filter((e) => (fm(e.id).severity ?? "none") === s)) })),
    byCategory: register.categories.map((c) => {
      const n = count(entries.filter((e) => fm(e.id).category === c.key));
      return { key: c.key, label: c.label, ...n, rate: n.pass + n.fail ? n.pass / (n.pass + n.fail) : null };
    }),
    gate: gateOf(register, entries),
    entries,
  };
}

export type FmComparison = { base: { id: string; label: string | null; gitSha: string | null }; head: { id: string; label: string | null; gitSha: string | null }; resolved: string[]; newFailures: string[]; recurring: string[]; stillPassing: string[]; other: string[] };

/** Entry statuses between two runs: resolved (fail → pass), new failures (pass → fail), recurring (fail in both). */
export function compareFm(base: FmRun, head: FmRun): FmComparison {
  const before = new Map(base.entries.map((e) => [e.id, e.status]));
  const out: FmComparison = { base: { id: base.id, label: base.label, gitSha: base.gitSha }, head: { id: head.id, label: head.label, gitSha: head.gitSha }, resolved: [], newFailures: [], recurring: [], stillPassing: [], other: [] };
  for (const e of head.entries) {
    const b = before.get(e.id);
    if (b === "fail" && e.status === "pass") out.resolved.push(e.id);
    else if (b === "pass" && e.status === "fail") out.newFailures.push(e.id);
    else if (b === "fail" && e.status === "fail") out.recurring.push(e.id);
    else if (b === "pass" && e.status === "pass") out.stillPassing.push(e.id);
    else out.other.push(e.id);
  }
  return out;
}

/** Failure-mode runs in a results directory, newest first. */
export function listFmRuns(dir: string): FmRun[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .flatMap((n) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as FmRun;
        return r.kind === "failure-modes" ? [r] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** The comparison base for a run: the newest earlier run labelled "baseline…", else the previous run. */
export function fmBaseFor(runs: FmRun[], head: FmRun): FmRun | null {
  const earlier = runs.filter((r) => r.startedAt < head.startedAt);
  return earlier.find((r) => r.label?.startsWith("baseline")) ?? earlier[0] ?? null;
}
