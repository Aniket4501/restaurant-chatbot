import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// npm run verify [-- --release]   (MASTER_PROMPT §8 Phase 4, AC-13, INV-08)
// verify = lint, typecheck, test:unit, test:unit:tz, test:integration, eval:scripted, build, test:e2e, invariant report.
// verify:release adds model:check and the live eval at 3 runs per case against evals/thresholds.json.
// One line per step; each step's output goes to test-results/verify/<step>.log. A step that depends on a failed step is
// skipped and counts as failed. Exits non-zero if anything failed (INV-08).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = path.join(ROOT, "test-results/verify");

export type Step = { name: string; cmd?: string[]; run?: (since: number) => Promise<string | null>; needs?: string };
export type StepResult = { name: string; ok: boolean; skipped: boolean; ms: number; detail: string };

const logFile = (dir: string, name: string) => path.join(dir, `${name.replace(/[^a-z0-9.-]+/gi, "_")}.log`);

function exec(name: string, cmd: string[], dir = LOGS): Promise<{ code: number; ms: number }> {
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(logFile(dir, name), "w");
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: ["ignore", log, log], env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
    child.on("close", (code) => {
      fs.closeSync(log);
      resolve({ code: code ?? 1, ms: performance.now() - t0 });
    });
    child.on("error", () => resolve({ code: 127, ms: performance.now() - t0 }));
  });
}

/** Run steps in order and print one line each. Returns the results; the caller sets the exit code. */
export async function runSteps(steps: Step[], print: (line: string) => void = (l) => process.stdout.write(`${l}\n`), logDir = LOGS): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const since = Date.now();
  for (const s of steps) {
    const dep = s.needs ? results.find((r) => r.name === s.needs) : undefined;
    if (dep && !dep.ok) {
      results.push({ name: s.name, ok: false, skipped: true, ms: 0, detail: `skipped: ${s.needs} failed` });
      print(`- ${s.name.padEnd(18)} skipped (${s.needs} failed)`);
      continue;
    }
    const t0 = performance.now();
    let ok: boolean;
    let detail: string;
    if (s.run) {
      const problem = await s.run(since).catch((e: Error) => e.message);
      ok = problem === null;
      detail = problem ?? "ok";
    } else {
      const r = await exec(s.name, s.cmd!, logDir);
      ok = r.code === 0;
      detail = ok ? "ok" : `exit ${r.code} → ${path.relative(ROOT, logFile(logDir, s.name))}`;
    }
    const ms = performance.now() - t0;
    results.push({ name: s.name, ok, skipped: false, ms, detail });
    print(`${ok ? "✓" : "✗"} ${s.name.padEnd(18)} ${(ms / 1000).toFixed(1).padStart(6)}s  ${ok ? "" : detail}`.trimEnd());
  }
  return results;
}

/** The invariant report: D1 and E2E results written during this run, with no violations. */
async function invariantReport(since: number): Promise<string | null> {
  const evalFile = path.join(ROOT, "test-results/evals/scripted-latest.json");
  const e2eFile = path.join(ROOT, "test-results/e2e/invariants.jsonl");
  if (!fs.existsSync(evalFile) || fs.statSync(evalFile).mtimeMs < since) return "no eval:scripted results from this run";
  const d1 = JSON.parse(fs.readFileSync(evalFile, "utf8")) as { summary: { invariantViolations: number; failed: number } };
  if (d1.summary.invariantViolations || d1.summary.failed) return `eval:scripted: ${d1.summary.failed} failed, ${d1.summary.invariantViolations} violations`;
  if (!fs.existsSync(e2eFile) || fs.statSync(e2eFile).mtimeMs < since) return "no E2E invariant results from this run";
  const lines = fs.readFileSync(e2eFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { test: string; violations: unknown[]; at?: number });
  const bad = lines.filter((l) => l.violations.length);
  return bad.length ? `E2E: ${bad.length} spec(s) with violations, e.g. ${bad[0].test}` : null;
}

export function verifySteps(release: boolean): Step[] {
  const npm = (script: string): Step => ({ name: script, cmd: ["npm", "run", "-s", script] });
  const steps: Step[] = [
    npm("lint"),
    npm("typecheck"),
    npm("test:unit"),
    npm("test:unit:tz"),
    npm("test:integration"),
    npm("eval:scripted"),
    npm("build"),
    // The build above is the one under test, so Playwright runs directly (test:e2e alone would build again).
    {
      name: "test:e2e",
      needs: "build",
      run: async () => {
        fs.rmSync(path.join(ROOT, "test-results/e2e/invariants.jsonl"), { force: true });
        const r = await exec("test:e2e", ["npx", "playwright", "test"]);
        return r.code === 0 ? null : `exit ${r.code} → test-results/verify/test_e2e.log`;
      },
    },
    { name: "invariants", run: invariantReport },
  ];
  if (release) steps.push(npm("model:check"), { name: "eval (3 runs)", cmd: ["npm", "run", "-s", "eval", "--", "--runs", "3"] });
  return steps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = process.argv.includes("--release");
  const results = await runSteps(verifySteps(release));
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`verify${release ? ":release" : ""}: ${results.length - failed.length}/${results.length} steps passed${failed.length ? ` (failed: ${failed.map((r) => r.name).join(", ")})` : ""}\n`);
  process.exitCode = failed.length ? 1 : 0;
}
