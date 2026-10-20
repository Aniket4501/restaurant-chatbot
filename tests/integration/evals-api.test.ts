import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminSessionHandlers } from "@/lib/api/admin";
import type { ApiDeps } from "@/lib/api/deps";
import { evalsCaseHandler, evalsJobHandlers, evalsOverviewHandler, evalsRunHandler, failureType, type EvalsDeps } from "@/lib/api/evals";
import { applyLine, resetJobs, runnerArgs, type Job } from "@/lib/evals/jobs";
import { loadConfig } from "@/lib/config";
import { createLimiter } from "@/lib/http/ratelimit";
import type { CaseResult } from "@/evals/run";
import { testChatDeps } from "../helpers/chat-deps";
import { tempDb } from "./helpers/db";

// D-21: the evals dashboard API. Admin only; every number from results files in a temp directory; run controls
// validated and started through an injected spawn (no real runner here: tests/e2e covers the real one).
const NOW = Date.parse("2026-10-21T10:00:00+05:30");
const ENV = { ADMIN_PASSWORD: "correct horse battery", ADMIN_SESSION_SECRET: "cd".repeat(32) };
let t: ReturnType<typeof tempDb>;
let deps: ApiDeps;
let dir: string;
let ev: EvalsDeps;

type Turn = CaseResult["turns"][number];
const turn = (o: Partial<Turn> = {}): Turn => ({ index: 0, kind: "guest", input: "hi", reply: "Hello", blocks: [], cited: [], outcome: "smalltalk", intent: "smalltalk", retrievalMode: "hybrid", latencyMs: 900, modelMs: 800, promptTokens: 100, cachedTokens: 90, outputTokens: 10, firstTryValid: true, trace: [{ action: "model_call", attempt: 1, result: "ok" }], checks: [], ...o });
const res = (o: Partial<CaseResult>): CaseResult => ({ id: "X", category: "faq", severity: "major", run: 1, passed: true, status: "pass", durationMs: 5, expect: { expect: { intent: "faq" }, forbidden: [], notes: null, variantOf: null }, failures: [], violations: [], checks: [], offered: { total: 0, open: 0 }, modelCalls: 1, turns: [turn()], ...o });
const write = (name: string, meta: Record<string, unknown>, results: CaseResult[]) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ meta: { kind: "eval-live", mode: "live", suite: "full", runs: 1, ...meta }, results }));

beforeEach(() => {
  t = tempDb("evals");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-evals-api-"));
  ev = { resultsDir: () => dir, baselineFile: () => path.join(dir, "baseline.json"), root: () => process.cwd(), casesDir: () => path.join(process.cwd(), "evals/cases") };
  deps = {
    db: () => t.db,
    now: () => NOW,
    config: () => loadConfig({ DATABASE_PATH: path.join(os.tmpdir(), "x.db") }),
    fetch,
    adminEnv: () => ENV,
    limits: { createsPerPhone: createLimiter({ limit: 100, windowMs: 60_000 }), createsGlobal: createLimiter({ limit: 100, windowMs: 60_000 }), adminLogin: createLimiter({ limit: 5, windowMs: 60_000 }) },
    chat: testChatDeps(),
  };
  resetJobs();
  write("2026-10-20T10-00-00-000Z_qwen.json", { startedAt: "2026-10-20T10:00:00.000Z" }, [res({ id: "LV-A" }), res({ id: "LV-B", status: "fail", passed: false, failures: ["turn 1: intent faq ∉ booking"] }), res({ id: "LV-C" })]);
  write("2026-10-21T10-00-00-000Z_qwen.json", { startedAt: "2026-10-21T10:00:00.000Z" }, [res({ id: "LV-A", status: "fail", passed: false, severity: "critical", failures: ["turn 1: shows the same text twice: \"x\""] }), res({ id: "LV-B" }), res({ id: "LV-C" })]);
  fs.writeFileSync(path.join(dir, "2026-10-19T00-00-00-000Z_probe.json"), JSON.stringify({ meta: { kind: "model-probe" }, results: [] }));
});
afterEach(() => {
  t.cleanup();
  resetJobs();
});

const signIn = async () => {
  const r = await adminSessionHandlers(deps).POST(new Request("http://127.0.0.1:3100/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: ENV.ADMIN_PASSWORD }) }));
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
};
const get = (url: string, cookie?: string) => new Request(`http://127.0.0.1:3100${url}`, { headers: cookie ? { cookie } : {} });

describe("evals API: admin only", () => {
  it("refuses every endpoint without the admin cookie", async () => {
    const jobs = evalsJobHandlers(deps, ev);
    expect((await evalsOverviewHandler(deps, ev)(get("/api/admin/evals"))).status).toBe(401);
    expect((await evalsRunHandler(deps, ev)(get("/api/admin/evals/runs/x"), { params: Promise.resolve({ id: "x" }) })).status).toBe(401);
    expect((await evalsCaseHandler(deps, ev)(get("/api/admin/evals/runs/x/cases/y"), { params: Promise.resolve({ id: "x", caseId: "y" }) })).status).toBe(401);
    expect((await jobs.GET(get("/api/admin/evals/jobs"))).status).toBe(401);
    expect((await jobs.POST(new Request("http://127.0.0.1:3100/api/admin/evals/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(401);
    expect((await jobs.DELETE(new Request("http://127.0.0.1:3100/api/admin/evals/jobs", { method: "DELETE" }))).status).toBe(401);
  });
});

describe("evals API: runs, comparisons and cases from results files", () => {
  it("lists eval runs newest first (not other files) with the server time", async () => {
    const cookie = await signIn();
    const j = await (await evalsOverviewHandler(deps, ev)(get("/api/admin/evals", cookie))).json();
    expect(j.runs.map((r: { id: string }) => r.id)).toEqual(["2026-10-21T10-00-00-000Z_qwen", "2026-10-20T10-00-00-000Z_qwen"]);
    expect(j.runs[0].counts).toMatchObject({ executed: 3, passed: 2, failed: 1 });
    expect(j.now).toBe(NOW);
    expect(j.areas).toHaveLength(9);
  });
  it("compares a run with the previous one of its kind by default, and with the saved baseline once set", async () => {
    const cookie = await signIn();
    const run = async (qs = "") => (await evalsRunHandler(deps, ev)(get(`/api/admin/evals/runs/2026-10-21T10-00-00-000Z_qwen${qs}`, cookie), { params: Promise.resolve({ id: "2026-10-21T10-00-00-000Z_qwen" }) })).json();
    const j = await run();
    expect(j.baseReason).toBe("previous");
    expect(j.comparison.newFailures.map((c: { id: string }) => c.id)).toEqual(["LV-A"]);
    expect(j.comparison.resolved.map((c: { id: string }) => c.id)).toEqual(["LV-B"]);
    const a = j.cases.find((c: { id: string }) => c.id === "LV-A");
    expect(a).toMatchObject({ status: "fail", previous: "pass", regression: "new", failureType: "response shape", severity: "critical", expected: ["intent faq"] });
    expect(j.cases.find((c: { id: string }) => c.id === "LV-B")).toMatchObject({ status: "pass", regression: "resolved" });
    fs.writeFileSync(ev.baselineFile(), JSON.stringify({ "live-full": { id: "2026-10-20T10-00-00-000Z_qwen", setAt: "", note: null } }));
    expect((await run()).baseReason).toBe("baseline");
    expect((await run("?base=nope")).baseReason).toBe("none");
  });
  it("returns 404 for an unknown run or case, and a case's results with its rerun command", async () => {
    const cookie = await signIn();
    expect((await evalsRunHandler(deps, ev)(get("/api/admin/evals/runs/nope", cookie), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    const c = (id: string) => evalsCaseHandler(deps, ev)(get(`/api/admin/evals/runs/x/cases/${id}`, cookie), { params: Promise.resolve({ id: "2026-10-21T10-00-00-000Z_qwen", caseId: id }) });
    expect((await c("NOPE")).status).toBe(404);
    const j = await (await c("LV-A")).json();
    expect(j.results[0].failures).toEqual(['turn 1: shows the same text twice: "x"']);
    expect(j.results[0].turns[0].trace).toEqual([{ action: "model_call", attempt: 1, result: "ok" }]);
    expect(j.rerun).toEqual({ command: "npx tsx evals/run.ts --mode live --case LV-A", request: { mode: "live", suite: "full", area: null, caseIds: ["LV-A"] } });
  });
  it("shows an interrupted run as interrupted, never as passed", async () => {
    fs.writeFileSync(path.join(dir, "2026-10-21T12-00-00-000Z_live.partial.jsonl"), `${JSON.stringify({ header: { mode: "live", suite: "full", startedAt: "2026-10-21T12:00:00.000Z", selected: ["LV-A", "LV-B", "LV-C"], runs: 1, pid: 2 ** 22 + 12345 } })}\n${JSON.stringify(res({ id: "LV-A" }))}\n`);
    const j = await (await evalsOverviewHandler(deps, ev)(get("/api/admin/evals", await signIn()))).json();
    expect(j.runs[0]).toMatchObject({ status: "interrupted", counts: { executed: 1, passed: 1, skipped: 2 } });
  });
  it("classifies failure lines for the explorer's filter", () => {
    expect(failureType("error: setup book failed")).toBe("execution error");
    expect(failureType("INV-04: claim text without a create")).toBe("false confirmation");
    expect(failureType("turn 2: intent faq ∉ booking")).toBe("intent");
    expect(failureType("turn 1: did not cite faq:pets (cited none)")).toBe("grounding");
  });
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 999_999;
  killed: string | null = null;
  kill(sig: string) {
    this.killed = sig;
    return true;
  }
}

describe("evals API: run controls", () => {
  const post = (body: unknown, cookie: string) => new Request("http://127.0.0.1:3100/api/admin/evals/jobs", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  it("validates the request and refuses an unknown case", async () => {
    const cookie = await signIn();
    const jobs = evalsJobHandlers(deps, ev, () => new FakeChild() as unknown as ChildProcess);
    expect((await jobs.POST(post({ mode: "bogus", suite: "smoke" }, cookie))).status).toBe(400);
    expect((await jobs.POST(post({ mode: "live", suite: "smoke", area: "nope" }, cookie))).status).toBe(400);
    expect((await jobs.POST(post({ mode: "live", suite: "smoke", caseIds: ["rm -rf /"] }, cookie))).status).toBe(400);
    const r = await jobs.POST(post({ mode: "scripted", suite: "full", caseIds: ["LV-SLOT-001"] }, cookie)); // a live case asked of the scripted runner
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toBe("No scripted case LV-SLOT-001.");
  });
  it("starts the runner with fixed arguments, follows its progress, and allows one run at a time", async () => {
    const cookie = await signIn();
    const children: FakeChild[] = [];
    const calls: { cmd: string; args: string[]; detached: boolean }[] = [];
    const jobs = evalsJobHandlers(deps, ev, (cmd, args, opts) => {
      calls.push({ cmd, args, detached: opts.detached });
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    });
    const r = await jobs.POST(post({ mode: "scripted", suite: "smoke", area: "reliability" }, cookie));
    expect(r.status).toBe(202);
    expect(calls).toEqual([{ cmd: "npx", args: ["tsx", "evals/run.ts", "--mode", "scripted", "--suite", "smoke", "--area", "reliability", "--save"], detached: true }]);
    const busy = await jobs.POST(post({ mode: "live", suite: "full" }, cookie));
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe("BUSY");
    children[0].stdout.emit("data", "eval:scripted smoke: 2 cases\nPASS SC-A backend_failure\nFAIL SC-B backend_");
    children[0].stdout.emit("data", "failure\n     turn 1: x\neval:scripted 1/2 passed, 0 invariant violations → evals/results/2026-10-21T10-00-00-000Z_scripted_smoke.json\n");
    children[0].emit("close", 1);
    const job = (await (await jobs.GET(get("/api/admin/evals/jobs", cookie))).json()).job as Job;
    expect(job).toMatchObject({ state: "failed", exitCode: 1, progress: { done: 2, failed: 1, total: 2 }, runId: "2026-10-21T10-00-00-000Z_scripted_smoke", error: null });
    expect((await jobs.POST(post({ mode: "scripted", suite: "smoke" }, cookie))).status).toBe(202); // the next run may start
  });
  it("refuses to start while another eval run (from the command line) is in progress", async () => {
    fs.writeFileSync(path.join(dir, "2026-10-21T12-00-00-000Z_live.partial.jsonl"), `${JSON.stringify({ header: { mode: "live", suite: "full", startedAt: "2026-10-21T12:00:00.000Z", selected: ["LV-A"], runs: 1, pid: process.pid } })}\n`);
    const jobs = evalsJobHandlers(deps, ev, () => new FakeChild() as unknown as ChildProcess);
    const r = await jobs.POST(post({ mode: "scripted", suite: "smoke" }, await signIn()));
    expect(r.status).toBe(409);
    expect((await r.json()).error.message).toMatch(/command line/);
  });
  it("cancels a running job", async () => {
    const cookie = await signIn();
    const child = new FakeChild();
    const jobs = evalsJobHandlers(deps, ev, () => child as unknown as ChildProcess);
    await jobs.POST(post({ mode: "live", suite: "smoke" }, cookie));
    const j = (await (await jobs.DELETE(new Request("http://127.0.0.1:3100/api/admin/evals/jobs", { method: "DELETE", headers: { cookie } }))).json()).job as Job;
    expect(j.state).toBe("cancelled");
    child.emit("close", null);
    expect(((await (await jobs.GET(get("/api/admin/evals/jobs", cookie))).json()).job as Job).state).toBe("cancelled");
  });
  it("builds the runner's arguments only from validated values", () => {
    expect(runnerArgs({ mode: "live", suite: "smoke", area: null, caseIds: ["LV-A", "LV-B"] })).toEqual(["tsx", "evals/run.ts", "--mode", "live", "--suite", "full", "--case", "LV-A,LV-B", "--save"]);
    const job = { log: [], progress: { done: 0, failed: 0, total: null }, runId: null } as unknown as Job;
    applyLine(job, "eval:live full: 10 cases x 3 runs");
    expect(job.progress.total).toBe(30);
  });
});
