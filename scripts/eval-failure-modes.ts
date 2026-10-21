import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resultsDir } from "@/evals/paths";
import { compareFm, entryResults, fmBaseFor, fmResultsDir, fromPlaywright, fromVitest, listFmRuns, loadRegister, registerFile, summarizeFm, type TestResult } from "@/evals/failure-modes";

// npm run eval:failure-modes [-- --label L] [--only FM-021,FM-036] [--e2e] [--no-save]
//                            [--from-vitest report.json [--from-e2e report.json] --sha abc1234]
// D-29: runs every test whose name carries a failure-mode ID (vitest; with --e2e also the Playwright specs, after a
// fresh build), maps the results to evals/failure-modes.json, and writes
// evals/results/failure-modes/<timestamp>_failure-modes[_label].json. --from-vitest/--from-e2e build a run from saved
// reporter output instead (the baseline was run that way on a checkout of the code before the fixes; --sha records
// which code it was). Exits 1 when the release gate is blocked, 2 when the tests couldn't be run.
const ROOT = process.cwd();
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? "") : null;
};
const flag = (name: string) => argv.includes(`--${name}`);
const sh = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

const register = loadRegister(registerFile(ROOT));
const only = arg("only") ? new Set(arg("only")!.split(",").map((s) => s.trim().toUpperCase())) : undefined;
for (const id of only ?? []) if (!register.failureModes.some((f) => f.id === id)) {
  console.error(`eval:failure-modes: no register entry ${id}`);
  process.exit(2);
}
const pattern = only ? [...only].join("|") : "FM-\\d{3}";
const label = arg("label");
const started = new Date();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-fm-"));

function vitest(): { tests: TestResult[]; source: string } {
  const from = arg("from-vitest");
  if (from) return { tests: fromVitest(JSON.parse(fs.readFileSync(from, "utf8")), path.resolve(path.dirname(from), arg("vitest-root") ?? ROOT)), source: path.basename(from) };
  const out = path.join(tmp, "vitest.json");
  spawnSync("npx", ["vitest", "run", "-t", pattern, "--reporter=json", `--outputFile=${out}`], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  if (!fs.existsSync(out)) throw new Error("vitest wrote no report");
  return { tests: fromVitest(JSON.parse(fs.readFileSync(out, "utf8")), ROOT), source: "vitest run" };
}

function e2e(): { tests: TestResult[]; source: string | null } {
  const from = arg("from-e2e");
  if (from) return { tests: fromPlaywright(JSON.parse(fs.readFileSync(from, "utf8"))), source: path.basename(from) };
  if (!flag("e2e")) return { tests: [], source: null };
  if (spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] }).status !== 0) throw new Error("npm run build failed");
  const out = path.join(tmp, "e2e.json");
  spawnSync("npx", ["playwright", "test", "-g", pattern, "--reporter=json"], { cwd: ROOT, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out }, stdio: ["ignore", "ignore", "inherit"] });
  if (!fs.existsSync(out)) throw new Error("playwright wrote no report");
  return { tests: fromPlaywright(JSON.parse(fs.readFileSync(out, "utf8"))), source: "playwright run" };
}

let v: ReturnType<typeof vitest>;
let e: ReturnType<typeof e2e>;
try {
  v = vitest();
  e = e2e();
} catch (err) {
  console.error(`eval:failure-modes: ${(err as Error).message}`);
  process.exit(2);
}
const imported = !!arg("from-vitest");
const entries = entryResults(register, [...v.tests, ...e.tests], { e2eRan: e.source !== null, only });
const stamp = started.toISOString().replace(/[:.]/g, "-");
const run = summarizeFm(register, entries, {
  id: `${stamp}_failure-modes${label ? `_${label}` : ""}`,
  label,
  startedAt: started.toISOString(),
  durationMs: Date.now() - started.getTime(),
  gitSha: imported ? (arg("sha") ?? null) : sh("git", ["rev-parse", "--short", "HEAD"]),
  gitDirty: imported ? null : (sh("git", ["status", "--porcelain"]) ?? "").split("\n").some((l) => l.trim() && !l.includes("evals/results/")),
  source: { vitest: v.source, e2e: e.source },
});

const c = run.counts;
console.log(`eval:failure-modes ${c.entries} entries: ${c.pass} pass, ${c.fail} fail, ${c.notRun} not run, ${c.noTest} with no test (${c.testsPassed}/${c.tests} tests passed)`);
for (const s of run.bySeverity.filter((x) => x.entries)) console.log(`  ${s.severity}: ${s.pass} of ${s.entries} pass${s.fail ? `, ${s.fail} fail` : ""}`);
for (const x of entries.filter((x) => x.status === "fail")) {
  const f = register.failureModes.find((y) => y.id === x.id)!;
  console.log(`FAIL ${x.id} ${f.severity ?? "-"} ${f.title}`);
  for (const t of x.tests.filter((t) => t.status === "failed")) console.log(`     ${t.file}: ${t.name.slice(0, 140)}\n       ${t.failure ?? ""}`);
}
const dir = fmResultsDir(resultsDir());
const base = fmBaseFor(listFmRuns(dir), run);
if (base) {
  const cmp = compareFm(base, run);
  console.log(`  vs ${base.id}: ${cmp.resolved.length} resolved, ${cmp.newFailures.length} new failures, ${cmp.recurring.length} recurring${cmp.newFailures.length ? ` (${cmp.newFailures.join(", ")})` : ""}`);
}
console.log(`  release gate (${register.releaseGate.severities.join("/")} in ${register.releaseGate.categories.join(", ")}): ${run.gate.ok ? "not blocked" : `BLOCKED: ${run.gate.blocking.map((b) => `${b.id} (${b.reason})`).join(", ")}`}`);
if (!flag("no-save")) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  console.log(`  → ${path.relative(ROOT, file)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = run.gate.ok ? 0 : 1;
