import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/lib/config";
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

