import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Booking rules (SPEC BR-03…BR-07) and runtime limits. Tables themselves come from the seed (BR-03).
export const RULES = {
  timezone: "Asia/Kolkata",
  slotMinutes: 30, // BR-05
  sittingMinutes: (party: number) => (party <= 4 ? 90 : 120), // BR-04
  leadMinutes: 60, // BR-06
  horizonDays: 30, // BR-06
  onlinePartyMin: 1, // BR-07
  onlinePartyMax: 8, // BR-07
  nameMin: 2, // BR-09
  nameMax: 80,
  noteMax: 300,
} as const;

export const LIMITS = {
  guestTextMax: 500, // §5.7 step 1
  assistantTextMax: 600, // D-15
  historyMax: 8,
  bodyBytesMax: 16 * 1024, // D-15
  turnsPerMin: 20, // per session and per socket address
  createsPerMinPerPhone: 5, // D-14
  createsPerMinGlobal: 30,
  retrievalTopK: 8,
  retrievalAggregateMax: 2, // menu-cat/menu-diet facts per turn (T-10 measurement, D-13 note)
  retrievalCarryMax: 4, // D-13 follow-ups: at most 4 of last turn's cited facts are kept, leaving room for new hits
} as const;

export const MODEL = {
  numCtx: 8192,
  numPredict: 400,
  temperature: 0,
  seed: 42,
  keepAlive: "30m",
  promptBudgetTokens: 8192 - 512, // §5.8 CONTEXT_TOO_LARGE threshold
  chatTimeoutMs: 15_000,
  // A call made while Ollama reports the model unloaded gets time to load it (D-23).
  coldTimeoutMs: 45_000,
  // The server warms the model this often (D-23): it stays loaded (keepAlive 30m) and its prompt prefixes stay cached.
  rewarmEveryMs: 15 * 60_000,
  warmTimeoutMs: 120_000,
  embedTimeoutMs: 2_500, // over this, retrieval falls back to lexical for the turn (D-02)
} as const;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const CLOUD_MODEL = /(^|[:-])cloud$/i;

const modelName = z
  .string()
  .min(1)
  .refine((m) => !CLOUD_MODEL.test(m), { message: "cloud models are not allowed (local Ollama only)" });

const EnvSchema = z.object({
  DATABASE_PATH: z.string().min(1).optional(),
  LLM_PROVIDER: z.enum(["ollama", "fake"]).default("ollama"),
  EMBED_PROVIDER: z.enum(["ollama", "fake"]).default("ollama"),
  OLLAMA_BASE_URL: z
    .string()
    .default("http://127.0.0.1:11434")
    .refine(
      (u) => {
        try {
          const url = new URL(u);
          return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
        } catch {
          return false;
        }
      },
      { message: "must be an http URL on 127.0.0.1, localhost or ::1" },
    ),
  CHAT_MODEL: modelName.default("qwen3.5:9b"),
  EMBED_MODEL: modelName.default("qwen3-embedding:0.6b"),
  E2E_TEST_MODE: z.enum(["0", "1"]).optional(),
  FAKE_SCRIPT: z.string().min(1).optional(),
  NOW_OVERRIDE: z.string().min(1).optional(),
  RATE_LIMIT_TURNS_PER_MIN: z.coerce.number().int().positive().optional(),
  RESERVATION_CREATES_PER_MIN: z.coerce.number().int().positive().optional(),
  TEST_TRACE_PATH: z.string().min(1).optional(),
});

export type AppConfig = Readonly<{
  databasePath: string;
  llmProvider: "ollama" | "fake";
  embedProvider: "ollama" | "fake";
  ollamaBaseUrl: string;
  chatModel: string;
  embedModel: string;
  testMode: boolean;
  /** Present only in test mode (D-12). */
  test: Readonly<{
    fakeScript?: string;
    nowOverrideMs?: number;
    turnsPerMin?: number;
    createsPerMin?: number;
    tracePath?: string;
  }> | null;
}>;

const DEV_DB = "data/app.db";

/** Resolve a path through symlinks as far as it exists (macOS /var → /private/var). */
function realish(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(realish(parent), realish(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Parse and validate configuration from an environment. Pure apart from path resolution, so tests pass
 * their own env. Problems name variables, never their values (H10).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const e = parsed.data;
  const databasePath = path.resolve(cwd, e.DATABASE_PATH ?? DEV_DB);
  const testMode = e.E2E_TEST_MODE === "1";

  if (testMode) {
    const problems: string[] = [];
    if (e.LLM_PROVIDER !== "fake") problems.push("E2E_TEST_MODE=1 requires LLM_PROVIDER=fake");
    if (e.EMBED_PROVIDER !== "fake") problems.push("E2E_TEST_MODE=1 requires EMBED_PROVIDER=fake");
    if (!e.DATABASE_PATH) problems.push("E2E_TEST_MODE=1 requires DATABASE_PATH to be set");
    else if (realish(databasePath) === realish(path.resolve(cwd, DEV_DB)))
      problems.push("E2E_TEST_MODE=1 refuses DATABASE_PATH=data/app.db");
    else if (!isUnder(databasePath, os.tmpdir()) && !isUnder(databasePath, path.resolve(cwd, "test-results")))
      problems.push("E2E_TEST_MODE=1 requires DATABASE_PATH under the OS temp dir or test-results/");
    let nowOverrideMs: number | undefined;
    if (e.NOW_OVERRIDE !== undefined) {
      nowOverrideMs = Date.parse(e.NOW_OVERRIDE);
      if (!/[zZ]|[+-]\d\d:\d\d$/.test(e.NOW_OVERRIDE) || Number.isNaN(nowOverrideMs))
        problems.push("NOW_OVERRIDE must be an ISO instant with an offset");
    }
    if (problems.length) throw new ConfigError(problems);
    return Object.freeze({
      databasePath,
      llmProvider: e.LLM_PROVIDER,
      embedProvider: e.EMBED_PROVIDER,
      ollamaBaseUrl: e.OLLAMA_BASE_URL,
      chatModel: e.CHAT_MODEL,
      embedModel: e.EMBED_MODEL,
      testMode,
      test: Object.freeze({
        fakeScript: e.FAKE_SCRIPT,
        nowOverrideMs,
        turnsPerMin: e.RATE_LIMIT_TURNS_PER_MIN,
        createsPerMin: e.RESERVATION_CREATES_PER_MIN,
        tracePath: e.TEST_TRACE_PATH,
      }),
    });
  }

  // Outside test mode every test hook is ignored (D-12).
  return Object.freeze({
    databasePath,
    llmProvider: e.LLM_PROVIDER,
    embedProvider: e.EMBED_PROVIDER,
    ollamaBaseUrl: e.OLLAMA_BASE_URL,
    chatModel: e.CHAT_MODEL,
    embedModel: e.EMBED_MODEL,
    testMode: false,
    test: null,
  });
}

let cached: AppConfig | null = null;
/** Process-wide config, validated on first use. */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
