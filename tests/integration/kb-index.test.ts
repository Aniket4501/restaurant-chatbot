import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySeed, parseSeed } from "@/lib/db/seed";
import type { SeedData } from "@/lib/db/seed-schema";
import { EmbedError, fakeEmbedder, type Embedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { embeddingCoverage, indexKb, lexicalCurrent } from "@/lib/kb/index";
import { retrieveFacts } from "@/lib/kb/retrieve";
import { tempDb } from "./helpers/db";

const ROOT = path.resolve(__dirname, "../..");
const NOW = Date.parse("2026-10-16T14:05:00+05:30");
const fixture = (): SeedData => parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8")));
const run = promisify(execFile);

let t: ReturnType<typeof tempDb>;
beforeEach(() => {
  t = tempDb("kb");
  applySeed(t.db, fixture(), { now: NOW });
});
afterEach(() => t.cleanup());

const kb = () => renderKbFacts(loadFactSource(t.db));
const vectorCount = (where = "1") => (t.db.prepare(`SELECT count(*) AS n FROM fact_embeddings WHERE ${where}`).get() as { n: number }).n;

describe("lexical index follows the seed (D-13)", () => {
  it("is rebuilt inside applySeed, including after menu changes", () => {
    expect(lexicalCurrent(t.db, kb())).toBe(true);
    const seed = fixture();
    seed.menu = seed.menu.filter((m) => m.slug !== "dal-ember").map((m) => (m.slug === "mango-sorbet" ? { ...m, description: "Alphonso mango sorbet" } : m));
    applySeed(t.db, seed, { now: NOW });
    expect(lexicalCurrent(t.db, kb())).toBe(true);
    expect((t.db.prepare("SELECT count(*) AS n FROM kb_fts WHERE fact_id = 'menu:dal-ember'").get() as { n: number }).n).toBe(0);
    expect((t.db.prepare("SELECT fact_id FROM kb_fts WHERE kb_fts MATCH '\"alphonso\"'").all() as { fact_id: string }[]).map((r) => r.fact_id)).toContain("menu:mango-sorbet");
  });
});

describe("indexKb (kb:index)", () => {
  it("embeds every fact once, then reuses current vectors", async () => {
    const fake = fakeEmbedder();
    const first = await indexKb(t.db, kb(), fake, NOW);
    expect(first).toMatchObject({ facts: 86, embedded: 86, reused: 0, deleted: 0, model: "qwen3-embedding:0.6b" });
    expect(embeddingCoverage(t.db, kb(), first.digest)).toEqual({ total: 86, embedded: 86, missing: [], stale: [] });
    const second = await indexKb(t.db, kb(), fake, NOW);
    expect(second).toMatchObject({ embedded: 0, reused: 86, deleted: 0 });
  });

  it("re-embeds changed facts and deletes vectors of removed facts", async () => {
    const fake = fakeEmbedder();
    const { digest } = await indexKb(t.db, kb(), fake, NOW);
    const seed = fixture();
    seed.menu = seed.menu.filter((m) => m.slug !== "dal-ember").map((m) => (m.slug === "mango-sorbet" ? { ...m, priceInr: 260 } : m));
    applySeed(t.db, seed, { now: NOW });
    const cov = embeddingCoverage(t.db, kb(), digest);
    expect(cov.stale).toEqual(["menu:mango-sorbet"]); // aggregates are indexed by their description, so a price change leaves them current
    expect(cov.missing).toEqual([]);
    const r = await indexKb(t.db, kb(), fake, NOW);
    expect(r).toMatchObject({ facts: 85, embedded: 1, reused: 84, deleted: 1 });
    expect(vectorCount("fact_id = 'menu:dal-ember'")).toBe(0);
    expect(embeddingCoverage(t.db, kb(), digest).embedded).toBe(85);
  });

  it("writes no vectors when an embed call fails, and retrieval stays lexical", async () => {
    const failing: Embedder = { provider: "ollama", model: "m", digest: async () => "d1", embed: async () => Promise.reject(new EmbedError("EMBED_UNAVAILABLE", "down")) };
    await expect(indexKb(t.db, kb(), failing, NOW)).rejects.toMatchObject({ code: "EMBED_UNAVAILABLE" });
    expect(vectorCount()).toBe(0);
    expect(lexicalCurrent(t.db, kb())).toBe(true);
    const r = await retrieveFacts("vegan dessert", {}, { db: t.db, facts: kb(), embedder: { ...failing, embed: fakeEmbedder().embed } });
    expect([r.mode, r.reason]).toEqual(["lexical", "index_incomplete"]);
  });

  it("keys vectors by model digest, so a re-pulled model is not treated as indexed", async () => {
    const fake = fakeEmbedder();
    await indexKb(t.db, kb(), fake, NOW);
    const repulled: Embedder = { ...fake, digest: async () => "fake:new-digest" };
    expect(embeddingCoverage(t.db, kb(), "fake:new-digest").missing).toHaveLength(86);
    expect((await retrieveFacts("dal", {}, { db: t.db, facts: kb(), embedder: repulled })).reason).toBe("index_incomplete");
  });
});

describe("npm run kb:index", () => {
  const script = (env: Record<string, string>) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["E2E_TEST_MODE", "LLM_PROVIDER", "EMBED_PROVIDER", "OLLAMA_BASE_URL"]) delete childEnv[k];
    Object.assign(childEnv, { DATABASE_PATH: t.file }, env);
    return run(process.execPath, ["--import", "tsx", "scripts/kb-index.ts"], { cwd: ROOT, env: childEnv }).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
    );
  };

  it("indexes with the configured embedder and exits 0", async () => {
    t.db.close();
    const r = await script({ EMBED_PROVIDER: "fake" });
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toMatch(/kb:index 86 facts: 86 embedded, 0 unchanged, 0 stale vectors deleted \(fake qwen3-embedding:0\.6b/);
  });

  it("exits non-zero when the embedder is unreachable", async () => {
    t.db.close();
    const r = await script({ EMBED_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:9" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/kb:index failed: EMBED_UNAVAILABLE/);
  });
});
