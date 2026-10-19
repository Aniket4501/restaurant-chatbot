import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, ENV_EXAMPLE_PLACEHOLDERS, loadAdminSecrets, loadConfig } from "@/lib/config";
import { getNow } from "@/lib/time/now";

const CWD = path.resolve(__dirname, "../..");
const tmpDb = path.join(os.tmpdir(), "rc-config-test", "t.db");
const testEnv = { E2E_TEST_MODE: "1", LLM_PROVIDER: "fake", EMBED_PROVIDER: "fake", DATABASE_PATH: tmpDb };

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe("loadConfig defaults", () => {
  it("uses local Ollama, the dev DB and no test hooks", () => {
    const c = loadConfig({}, CWD);
    expect(c.llmProvider).toBe("ollama");
    expect(c.embedProvider).toBe("ollama");
    expect(c.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
    expect(c.chatModel).toBe("qwen3.5:9b");
    expect(c.embedModel).toBe("qwen3-embedding:0.6b");
    expect(c.databasePath).toBe(path.join(CWD, "data/app.db"));
    expect(c.testMode).toBe(false);
    expect(c.test).toBeNull();
  });

  it("ignores test hooks outside test mode", () => {
    const c = loadConfig({ NOW_OVERRIDE: "2026-10-16T14:00:00+05:30", FAKE_SCRIPT: "x.json", RATE_LIMIT_TURNS_PER_MIN: "999" }, CWD);
    expect(c.test).toBeNull();
    expect(getNow(c)).toBeGreaterThan(Date.parse("2026-10-17T00:00:00Z"));
  });
});

describe("local-only model path (D-16)", () => {
  it.each(["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"])("accepts %s", (u) => {
    expect(loadConfig({ OLLAMA_BASE_URL: u }, CWD).ollamaBaseUrl).toBe(u);
  });
  it.each(["https://127.0.0.1:11434", "https://ollama.com", "http://192.168.1.5:11434", "http://ollama.local:11434", "not a url"])(
    "rejects %s",
    (u) => {
      expect(problems(() => loadConfig({ OLLAMA_BASE_URL: u }, CWD)).join()).toMatch(/OLLAMA_BASE_URL/);
    },
  );
  it.each(["gpt-oss:120b-cloud", "qwen3.5:cloud", "deepseek-v3.1:671b-cloud"])("rejects cloud model %s", (m) => {
    expect(problems(() => loadConfig({ CHAT_MODEL: m }, CWD)).join()).toMatch(/CHAT_MODEL/);
    expect(problems(() => loadConfig({ EMBED_MODEL: m }, CWD)).join()).toMatch(/EMBED_MODEL/);
  });
});

describe("test-mode guard (D-12)", () => {
  it("accepts both fakes with a temp database and honours the hooks", () => {
    const c = loadConfig({ ...testEnv, NOW_OVERRIDE: "2026-10-16T14:00:00+05:30", RATE_LIMIT_TURNS_PER_MIN: "1000" }, CWD);
    expect(c.testMode).toBe(true);
    expect(c.test?.nowOverrideMs).toBe(Date.parse("2026-10-16T08:30:00Z"));
    expect(c.test?.turnsPerMin).toBe(1000);
    expect(getNow(c)).toBe(Date.parse("2026-10-16T08:30:00Z"));
  });
  it("accepts a database under test-results/", () => {
    expect(loadConfig({ ...testEnv, DATABASE_PATH: "test-results/e2e/app.db" }, CWD).testMode).toBe(true);
  });
  it("refuses the real model provider", () => {
    expect(problems(() => loadConfig({ ...testEnv, LLM_PROVIDER: "ollama" }, CWD))).toContain("E2E_TEST_MODE=1 requires LLM_PROVIDER=fake");
  });
  it("refuses the real embedder", () => {
    expect(problems(() => loadConfig({ ...testEnv, EMBED_PROVIDER: "ollama" }, CWD))).toContain("E2E_TEST_MODE=1 requires EMBED_PROVIDER=fake");
  });
  it("refuses a missing DATABASE_PATH", () => {
    expect(problems(() => loadConfig({ ...testEnv, DATABASE_PATH: undefined }, CWD))).toContain("E2E_TEST_MODE=1 requires DATABASE_PATH to be set");
  });
  it.each(["data/app.db", "./data/../data/app.db", path.join(CWD, "data/app.db")])("refuses the dev database (%s)", (p) => {
    expect(problems(() => loadConfig({ ...testEnv, DATABASE_PATH: p }, CWD))).toContain("E2E_TEST_MODE=1 refuses DATABASE_PATH=data/app.db");
  });
  it("refuses a database outside temp dirs", () => {
    expect(problems(() => loadConfig({ ...testEnv, DATABASE_PATH: "data/other.db" }, CWD)).join()).toMatch(/under the OS temp dir/);
  });
  it("refuses an offset-less NOW_OVERRIDE", () => {
    expect(problems(() => loadConfig({ ...testEnv, NOW_OVERRIDE: "2026-10-16T14:00:00" }, CWD)).join()).toMatch(/NOW_OVERRIDE/);
  });
});

describe("admin secrets (D-16)", () => {
  const goodSecret = "a".repeat(64);
  it("accepts a 12+ char password and a 32-byte hex secret", () => {
    const r = loadAdminSecrets({ ADMIN_PASSWORD: "correct horse battery", ADMIN_SESSION_SECRET: goodSecret });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.secretKey.length).toBe(32);
  });
  it("accepts a base64 secret of 32 bytes", () => {
    expect(loadAdminSecrets({ ADMIN_PASSWORD: "correct horse battery", ADMIN_SESSION_SECRET: Buffer.alloc(32, 7).toString("base64") }).ok).toBe(true);
  });
  it.each([
    [{}, ["ADMIN_PASSWORD is not set", "ADMIN_SESSION_SECRET is not set"]],
    [{ ADMIN_PASSWORD: "short", ADMIN_SESSION_SECRET: goodSecret }, ["ADMIN_PASSWORD must be at least 12 characters"]],
    [{ ADMIN_PASSWORD: ENV_EXAMPLE_PLACEHOLDERS.ADMIN_PASSWORD, ADMIN_SESSION_SECRET: goodSecret }, ["ADMIN_PASSWORD is still the .env.example placeholder"]],
    [{ ADMIN_PASSWORD: "correct horse battery", ADMIN_SESSION_SECRET: ENV_EXAMPLE_PLACEHOLDERS.ADMIN_SESSION_SECRET }, ["ADMIN_SESSION_SECRET is still the .env.example placeholder"]],
    [{ ADMIN_PASSWORD: "correct horse battery", ADMIN_SESSION_SECRET: "ab".repeat(16) }, ["ADMIN_SESSION_SECRET must decode (hex or base64) to at least 32 bytes"]],
    [{ ADMIN_PASSWORD: goodSecret, ADMIN_SESSION_SECRET: goodSecret }, ["ADMIN_SESSION_SECRET must differ from ADMIN_PASSWORD"]],
  ])("rejects %o", (env, expected) => {
    const r = loadAdminSecrets(env as Record<string, string>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(expected);
  });
  it("never echoes secret values in problems", () => {
    const r = loadAdminSecrets({ ADMIN_PASSWORD: "hunter2-but-longer!", ADMIN_SESSION_SECRET: "hunter2-but-longer!" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).not.toContain("hunter2");
  });
});
