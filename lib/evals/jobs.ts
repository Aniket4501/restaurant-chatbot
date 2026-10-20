import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { getNow } from "@/lib/time/now";

// D-21: eval runs started from the dashboard. One job at a time, in this server process: the real runner
// (`tsx evals/run.ts`) in a child process, its output parsed for progress and the results file it writes. Nothing
// here scores anything or edits results; the dashboard reads the results file when the job ends.

export type JobRequest = { mode: "scripted" | "live"; suite: "smoke" | "full"; area: string | null; caseIds: string[] | null };
export type JobState = "running" | "passed" | "failed" | "cancelled" | "error";
export type Job = {
  id: string;
  request: JobRequest;
  command: string;
  state: JobState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  progress: { done: number; failed: number; total: number | null };
  log: string[];
  runId: string | null;
  error: string | null;
};

type Spawn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }) => ChildProcess;
type Store = { job: Job | null; child: ChildProcess | null };
// Kept on globalThis so a dev-server module reload doesn't lose a running job.
const g = globalThis as typeof globalThis & { __rcEvalJob?: Store };
const store = (): Store => (g.__rcEvalJob ??= { job: null, child: null });

const LOG_LINES = 80;

/** The runner's command line for a request; only validated values reach it (no shell, fixed flags). */
export function runnerArgs(r: JobRequest): string[] {
  return ["tsx", "evals/run.ts", "--mode", r.mode, "--suite", r.caseIds ? "full" : r.suite, ...(r.area ? ["--area", r.area] : []), ...(r.caseIds ? ["--case", r.caseIds.join(",")] : []), "--save"];
}

export const currentJob = (): Job | null => store().job;

/** Updates the job from one line of runner output. Exported for tests. */
export function applyLine(job: Job, line: string): void {
  const text = line.replace(/\s+$/, "");
  if (!text) return;
  job.log.push(text.slice(0, 400));
  if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
  const sel = /^eval:(?:scripted|live) (?:smoke|full): (\d+) cases(?: x (\d+) runs)?/.exec(text);
  if (sel) job.progress.total = Number(sel[1]) * Number(sel[2] ?? 1);
  if (/^(PASS|FAIL) [A-Z0-9-]+ /.test(text)) {
    job.progress.done++;
    if (text.startsWith("FAIL")) job.progress.failed++;
  }
  const out = /→ (\S+\.json)\s*$/.exec(text);
  if (out) job.runId = path.basename(out[1]).replace(/\.json$/, "");
}

export function startJob(request: JobRequest, opts: { root: string; spawn?: Spawn; now?: () => Date; otherRunActive?: () => boolean }): { ok: true; job: Job } | { ok: false; code: "BUSY"; message: string } {
  const s = store();
  if (s.job?.state === "running") return { ok: false, code: "BUSY", message: "An eval run started from this page is still going. Wait for it, or cancel it." };
  if (opts.otherRunActive?.()) return { ok: false, code: "BUSY", message: "Another eval run is in progress (started from the command line). Wait for it to finish." };
  const now = opts.now ?? (() => new Date(getNow())); // the app clock (D-12: only lib/time reads the system clock)
  const args = runnerArgs(request);
  const job: Job = { id: `${now().getTime().toString(36)}`, request, command: `npx ${args.join(" ")}`, state: "running", startedAt: now().toISOString(), finishedAt: null, exitCode: null, progress: { done: 0, failed: 0, total: null }, log: [], runId: null, error: null };
  // The runner sets up its own configuration (fixtures, fake or local model); the server's NODE_ENV is not passed on.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_ENV")) as NodeJS.ProcessEnv;
  let child: ChildProcess;
  try {
    // Detached: its own process group, so Cancel stops npx and the runner under it together.
    child = (opts.spawn ?? (spawn as unknown as Spawn))("npx", args, { cwd: opts.root, env, detached: true });
  } catch (e) {
    job.state = "error";
    job.error = `Could not start the runner: ${(e as Error).message}`;
    job.finishedAt = now().toISOString();
    s.job = job;
    return { ok: true, job };
  }
  s.job = job;
  s.child = child;
  let buffer = "";
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const l of lines) applyLine(job, l);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => {
    job.state = "error";
    job.error = `The runner failed to start: ${e.message}`;
    job.finishedAt = now().toISOString();
  });
  child.on("close", (code) => {
    if (buffer) applyLine(job, buffer);
    if (job.state === "running") job.state = code === 0 ? "passed" : "failed";
    job.exitCode = code;
    job.finishedAt = now().toISOString();
    if (job.state === "failed" && !job.runId) job.error = "The runner stopped before writing results. See the output below.";
    s.child = null;
  });
  return { ok: true, job };
}

export function cancelJob(): Job | null {
  const s = store();
  if (!s.job || s.job.state !== "running" || !s.child?.pid) return s.job;
  s.job.state = "cancelled";
  try {
    process.kill(-s.child.pid, "SIGTERM");
  } catch {
    s.child.kill("SIGTERM");
  }
  return s.job;
}

/** Tests only: forget the job. */
export function resetJobs(): void {
  const s = store();
  s.job = null;
  s.child = null;
}
