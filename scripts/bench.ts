import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

// npm run bench (D-24): end-to-end latency of the real app with the local model, on an isolated production server
// (`next start` on its own port, a temporary database seeded from data/seed and indexed with the real embedder), so
// data/app.db and the user's server are never touched. Measures, per fixed scenario in evals/bench.json:
// - warm turns over HTTP: client time and the server's stage timings (meta.timing), round-robin for --trials rounds;
// - the reservation flow: the booking turn plus the POST /api/reservations save;
// - in a real browser (Chromium): send → reply painted, from the chat's user-timing marks;
// - cold start: both models unloaded (`ollama stop`), then one question.
// Writes evals/results/bench/<timestamp>_bench[_label].json. Needs a current `npm run build` (or pass --build).
//
//   npm run bench -- [--trials 5] [--cold 3] [--browser-trials 3] [--label name] [--port 3107] [--build] [--no-browser] [--no-cold]

const ROOT = process.cwd();
const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (k: string) => args.includes(`--${k}`);
const TRIALS = Number(arg("trials") ?? 5);
const COLD = flag("no-cold") ? 0 : Number(arg("cold") ?? 3);
const BROWSER_TRIALS = flag("no-browser") ? 0 : Number(arg("browser-trials") ?? 3);
const PORT = Number(arg("port") ?? 3107);
const LABEL = arg("label");
const BASE = `http://127.0.0.1:${PORT}`;

type Turn = { text?: string; action?: Record<string, unknown>; label?: string };
type Scenario = { id: string; kind: string; turns: Turn[]; submit?: boolean };
type BrowserScenario = { id: string; kind: string; type?: string; click?: string };
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "evals/bench.json"), "utf8")) as { version: number; warm: Scenario[]; cold: Scenario; browser: BrowserScenario[] };

type Timing = Record<string, number | null>;
type Sample = {
  scenario: string;
  kind: string;
  phase: "warm" | "cold" | "browser";
  trial: number;
  turn: number;
  ok: boolean;
  status: number;
  outcome: string | null;
  clientMs: number;
  serverMs: number | null;
  timing: Timing | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  /** Browser only: send → response received, and response → painted. */
  networkMs?: number | null;
  renderMs?: number | null;
  /** Reservation flow only: the save, and the whole flow (turn + save). */
  saveMs?: number | null;
  flowMs?: number | null;
  note?: string;
};

const sh = (cmd: string, a: string[]) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const median = (xs: number[]) => pct(xs, 50);

async function main() {
  const startedAt = new Date();
  const loadStart = os.loadavg();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ne-bench-"));
  const dbPath = path.join(tmp, "bench.db");
  process.env.DATABASE_PATH = dbPath;
  // Imported after DATABASE_PATH is set: config is read once.
  const { getConfig, MODEL } = await import("@/lib/config");
  const { closeDb, getDb } = await import("@/lib/db/client");
  const { migrate } = await import("@/lib/db/migrate");
  const { applySeed, parseSeed, readSeedDir } = await import("@/lib/db/seed");
  const { embedderFor } = await import("@/lib/kb/embedder");
  const { loadFactSource, renderKbFacts } = await import("@/lib/kb/facts");
  const { indexKb } = await import("@/lib/kb/index");
  const { getNow } = await import("@/lib/time/now");
  const config = getConfig();
  if (config.llmProvider !== "ollama") throw new Error("bench needs LLM_PROVIDER=ollama");

  if (flag("build")) execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  if (!fs.existsSync(path.join(ROOT, ".next/BUILD_ID"))) throw new Error("no production build: run `npm run build` or pass --build");

  // A temporary database, seeded like data/app.db and indexed with the real embedder.
  const db = getDb();
  migrate(db, getNow());
  applySeed(db, parseSeed(readSeedDir()), { now: getNow() });
  await indexKb(db, renderKbFacts(loadFactSource(db)), embedderFor(config), getNow(), { signal: AbortSignal.timeout(300_000) });
  closeDb();

  const server = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(PORT)], { cwd: ROOT, env: { ...process.env, DATABASE_PATH: dbPath, NEXT_TELEMETRY_DISABLED: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  server.stdout!.on("data", (d: Buffer) => log.push(...d.toString().split("\n")));
  server.stderr!.on("data", (d: Buffer) => log.push(...d.toString().split("\n")));
  const stop = (p: ChildProcess) => {
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", () => stop(server));

  const samples: Sample[] = [];
  try {
    await waitFor(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok === true, 60_000, "server start");
    // The server warms the model at start (D-23); warm trials begin after it has.
    await waitFor(async () => log.some((l) => l.includes('"model_warm"') || l.includes("model_warm_skipped")), 240_000, "server warm-up");
    const warmLine = log.find((l) => l.includes('"model_warm"')) ?? null;

    // Warm, round-robin so one scenario's identical prompt isn't the next request.
    for (let trial = 1; trial <= TRIALS; trial++) {
      for (const s of spec.warm) samples.push(...(await runScenario(s, "warm", trial)));
      process.stdout.write(`warm round ${trial}/${TRIALS} done\n`);
    }

    // Browser: what a guest sees, send → painted.
    if (BROWSER_TRIALS > 0) {
      const browser = await chromium.launch();
      try {
        for (let trial = 1; trial <= BROWSER_TRIALS; trial++) {
          for (const s of spec.browser) samples.push(await runBrowser(browser, s, trial));
        }
      } finally {
        await browser.close();
      }
      process.stdout.write("browser trials done\n");
    }

    // Cold: both models unloaded first.
    for (let trial = 1; trial <= COLD; trial++) {
      for (const m of [config.chatModel, config.embedModel]) sh("ollama", ["stop", m]);
      await waitFor(async () => !(await loaded()).some((n) => n === norm(config.chatModel) || n === norm(config.embedModel)), 60_000, "models unloaded");
      samples.push(...(await runScenario(spec.cold, "cold", trial)));
      process.stdout.write(`cold trial ${trial}/${COLD} done\n`);
    }

    const ollama = await ollamaInfo(config.ollamaBaseUrl, [config.chatModel, config.embedModel]);
    const out = {
      kind: "bench",
      formatVersion: 1,
      label: LABEL ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      gitSha: sh("git", ["rev-parse", "--short", "HEAD"]),
      gitDirty: (sh("git", ["status", "--porcelain"]) ?? "").split("\n").some((l) => l.trim() && !l.includes("evals/results/")),
      buildId: fs.readFileSync(path.join(ROOT, ".next/BUILD_ID"), "utf8").trim(),
      scenariosVersion: spec.version,
      promptVersion: samples.map((s) => (s as Sample & { promptVersion?: string }).promptVersion).find(Boolean) ?? null,
      model: config.chatModel,
      embedModel: config.embedModel,
      ollama,
      settings: { numCtx: MODEL.numCtx, numPredict: MODEL.numPredict, temperature: MODEL.temperature, keepAlive: MODEL.keepAlive, chatTimeoutMs: MODEL.chatTimeoutMs },
      chip: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
      ramBytes: os.totalmem(),
      node: process.version,
      loadAverage: { start: loadStart, end: os.loadavg() },
      trials: { warm: TRIALS, browser: BROWSER_TRIALS, cold: COLD },
      serverWarmup: warmLine ? JSON.parse(warmLine.slice(warmLine.indexOf("{"))) : null,
      summary: summarize(samples),
      samples,
    };
    const dir = path.join(process.env.EVALS_RESULTS_DIR ? path.resolve(process.env.EVALS_RESULTS_DIR) : path.join(ROOT, "evals/results"), "bench");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${startedAt.toISOString().replace(/[:.]/g, "-")}_bench${LABEL ? `_${LABEL.replace(/[^\w.-]/g, "-")}` : ""}.json`);
    fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
    printSummary(out.summary);
    console.log(`\nbench: ${samples.length} samples → ${path.relative(ROOT, file)} (load ${loadStart.map((x) => x.toFixed(1)).join(" ")} → ${os.loadavg().map((x) => x.toFixed(1)).join(" ")})`);
  } finally {
    stop(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function waitFor(check: () => Promise<boolean>, ms: number, what: string) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const norm = (n: string | undefined) => (n ? (n.includes(":") ? n : `${n}:latest`).toLowerCase() : "");
async function loaded(): Promise<string[]> {
  const r = await fetch(`${process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"}/api/ps`).catch(() => null);
  if (!r?.ok) return [];
  return (((await r.json()) as { models?: { name?: string }[] }).models ?? []).map((m) => norm(m.name));
}

async function ollamaInfo(baseUrl: string, names: string[]) {
  const get = async (p: string) => (await fetch(`${baseUrl}${p}`).catch(() => null))?.json().catch(() => null) as Promise<Record<string, unknown> | null>;
  const [version, tags] = await Promise.all([get("/api/version"), get("/api/tags")]);
  const models = (tags?.models as { name?: string; digest?: string }[] | undefined) ?? [];
  return { version: (version?.version as string) ?? null, digests: Object.fromEntries(names.map((n) => [n, models.find((m) => norm(m.name) === norm(n))?.digest?.slice(0, 12) ?? null])) };
}

// The app allows 20 chat turns a minute per address (LIMITS.turnsPerMin, not adjustable outside test mode): pace to
// 18. The wait happens before a request's timer starts.
const sent: number[] = [];
async function pace() {
  for (;;) {
    const now = performance.now();
    while (sent.length && now - sent[0] > 61_000) sent.shift();
    if (sent.length < 18) break;
    await new Promise((r) => setTimeout(r, 61_000 - (now - sent[0]) + 50));
  }
  sent.push(performance.now());
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...headers }, body: JSON.stringify(body) });

const RES_TIMES = ["7 pm", "7:30 pm", "8 pm", "8:30 pm", "9 pm", "6:30 pm", "9:30 pm", "1 pm", "1:30 pm", "2 pm"];

async function runScenario(s: Scenario, phase: "warm" | "cold", trial: number): Promise<Sample[]> {
  const sessionId = randomUUID();
  const messages: { role: "guest" | "assistant"; content: string }[] = [];
  let draft: unknown = null;
  let context: unknown = undefined;
  const out: Sample[] = [];
  for (const [i, t] of s.turns.entries()) {
    const text = (t.text ?? t.label ?? "").replace("{party}", "2").replace("{time}", RES_TIMES[(trial - 1) % RES_TIMES.length]);
    messages.push({ role: "guest", content: text });
    await pace();
    const t0 = performance.now();
    const res = await post("/api/chat", { sessionId, requestId: randomUUID(), messages: messages.slice(-7), draft, ...(context ? { context } : {}), ...(t.action ? { action: t.action } : {}) });
    const j = (await res.json().catch(() => null)) as { reply?: { text: string; blocks: { type: string; branch?: string; startsAtMs?: number; partySize?: number }[] }; draft?: unknown; context?: unknown; meta?: Record<string, unknown> } | null;
    const clientMs = performance.now() - t0;
    const meta = j?.meta ?? null;
    const sample: Sample & { promptVersion?: string } = {
      scenario: s.id,
      kind: s.kind,
      phase,
      trial,
      turn: i + 1,
      ok: res.status === 200 && !!j?.reply && meta?.outcome !== "degraded",
      status: res.status,
      outcome: (meta?.outcome as string) ?? null,
      clientMs: Math.round(clientMs),
      serverMs: (meta?.latencyMs as number) ?? null,
      timing: (meta?.timing as Timing) ?? null,
      promptTokens: (meta?.promptTokens as number) ?? null,
      cachedTokens: (meta?.cachedTokens as number) ?? null,
      promptVersion: (meta?.promptVersion as string) ?? undefined,
    };
    if (j?.reply) {
      messages.push({ role: "assistant", content: j.reply.text.slice(0, 600) });
      draft = j.draft ?? null;
      context = j.context;
    }
    if (s.submit) {
      const card = j?.reply?.blocks.find((b) => b.type === "confirm");
      if (!card) sample.note = `no confirm card (outcome ${sample.outcome})`;
      else {
        const s0 = performance.now();
        const r = await post("/api/reservations", { branch: card.branch, startsAt: card.startsAtMs, partySize: card.partySize, name: "Bench Guest", phone: `9${randomInt(100000000, 999999999)}`, email: null, note: null }, { "idempotency-key": randomUUID() });
        sample.saveMs = Math.round(performance.now() - s0);
        sample.flowMs = Math.round(clientMs + sample.saveMs);
        sample.ok = sample.ok && (r.status === 201 || r.status === 200);
        if (!sample.ok) sample.note = `save HTTP ${r.status}`;
      }
    }
    out.push(sample);
  }
  return out;
}

async function runBrowser(browser: import("@playwright/test").Browser, s: BrowserScenario, trial: number): Promise<Sample> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE);
    await pace();
    if (s.type) {
      const box = page.getByPlaceholder("Type a message…");
      await box.fill(s.type);
      await box.press("Enter");
    } else await page.getByRole("button", { name: s.click }).first().click();
    await page.waitForFunction(() => performance.getEntriesByType("measure").some((m) => m.name.startsWith("chat-total:")), null, { timeout: 90_000 });
    const m = await page.evaluate(() => {
      const all = performance.getEntriesByType("measure") as PerformanceMeasure[];
      const total = all.find((x) => x.name.startsWith("chat-total:"))!;
      const net = all.find((x) => x.name.startsWith("chat-network:"));
      return { total: total.duration, network: net?.duration ?? null, serverMs: (net?.detail as { serverMs?: number } | null)?.serverMs ?? null };
    });
    return { scenario: s.id, kind: s.kind, phase: "browser", trial, turn: 1, ok: true, status: 200, outcome: null, clientMs: Math.round(m.total), serverMs: m.serverMs, timing: null, promptTokens: null, cachedTokens: null, networkMs: m.network === null ? null : Math.round(m.network), renderMs: m.network === null ? null : Math.round(m.total - m.network) };
  } catch (e) {
    return { scenario: s.id, kind: s.kind, phase: "browser", trial, turn: 1, ok: false, status: 0, outcome: null, clientMs: 0, serverMs: null, timing: null, promptTokens: null, cachedTokens: null, note: (e as Error).message.slice(0, 200) };
  } finally {
    await ctx.close();
  }
}

type Group = { phase: string; key: string; n: number; failed: number; p50: number | null; p95: number | null; min: number | null; max: number | null; serverP50: number | null; stagesP50: Record<string, number | null>; extra: Record<string, number | null> };
const STAGES = ["setupMs", "retrievalMs", "promptMs", "queueMs", "statusMs", "turnModelMs", "chooserMs", "otherMs", "loadMs", "promptEvalMs", "evalMs", "evalTokens", "uncachedPromptTokens", "calls"];

/** p50 and p95 per phase × kind and per phase × scenario; p95 only from 20 samples (as in evals/report.ts). */
function summarize(samples: Sample[]): Group[] {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    for (const key of [`${s.phase}|kind:${s.kind}`, `${s.phase}|scenario:${s.scenario}`]) groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()].map(([k, xs]) => {
    const [phase, key] = k.split("|");
    const ok = xs.filter((x) => x.ok);
    const lat = ok.map((x) => x.flowMs ?? x.clientMs);
    const stage = (name: string) => median(ok.flatMap((x) => (x.timing && typeof x.timing[name] === "number" ? [x.timing[name] as number] : [])));
    const extra = (name: "saveMs" | "networkMs" | "renderMs" | "clientMs") => median(ok.flatMap((x) => (typeof x[name] === "number" ? [x[name] as number] : [])));
    return {
      phase,
      key,
      n: ok.length,
      failed: xs.length - ok.length,
      p50: median(lat),
      p95: lat.length >= 20 ? pct(lat, 95) : null,
      min: lat.length ? Math.min(...lat) : null,
      max: lat.length ? Math.max(...lat) : null,
      serverP50: median(ok.flatMap((x) => (x.serverMs === null ? [] : [x.serverMs]))),
      stagesP50: Object.fromEntries(STAGES.map((st) => [st, stage(st)])),
      extra: { turnP50: extra("clientMs"), saveP50: extra("saveMs"), networkP50: extra("networkMs"), renderP50: extra("renderMs") },
    };
  });
}

function printSummary(groups: Group[]) {
  const rows = groups.filter((g) => g.key.startsWith("kind:")).sort((a, b) => a.phase.localeCompare(b.phase) || a.key.localeCompare(b.key));
  console.log("\nphase    kind          n  fail   p50 ms   p95 ms   model p50   chooser p50   eval tok p50");
  for (const g of rows) console.log(`${g.phase.padEnd(8)} ${g.key.slice(5).padEnd(12)} ${String(g.n).padStart(3)} ${String(g.failed).padStart(4)} ${String(g.p50 ?? "-").padStart(8)} ${String(g.p95 ?? "-").padStart(8)} ${String(g.stagesP50.turnModelMs ?? "-").padStart(11)} ${String(g.stagesP50.chooserMs ?? "-").padStart(13)} ${String(g.stagesP50.evalTokens ?? "-").padStart(14)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`bench failed: ${(e as Error).message}`);
    process.exit(1);
  },
);
