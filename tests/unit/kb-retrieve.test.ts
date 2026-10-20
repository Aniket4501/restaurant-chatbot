import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb, type DB } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { EmbedError, fakeEmbedder, type Embedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts, type Fact } from "@/lib/kb/facts";
import { indexKb } from "@/lib/kb/index";
import { ftsQuery, lexicalSearch, retrievalQuery, retrieveFacts, rrf } from "@/lib/kb/retrieve";

const ROOT = path.resolve(__dirname, "../..");
const read = (p: string) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
type Labelled = { id: string; query: string; relevant: string[] };
const probe = read("evals/fixtures/probe-messages.json") as { now: string; retrieval: Labelled[] };
const lists = read("evals/fixtures/retrieval-aggregates.json") as { queries: Labelled[] };
const LABELLED = [...probe.retrieval, ...lists.queries];
const NOW = Date.parse(probe.now);

let db: DB;
let facts: Fact[];
let fake: ReturnType<typeof fakeEmbedder>;
beforeAll(async () => {
  db = openDb(":memory:");
  migrate(db, NOW);
  applySeed(db, parseSeed(read("evals/fixtures/base.json")), { now: NOW });
  facts = renderKbFacts(loadFactSource(db));
  fake = fakeEmbedder();
  await indexKb(db, facts, fake, NOW);
});
const ids = (r: { hits: { factId: string }[] }) => r.hits.map((h) => h.factId);

// Research SQ-41: raw guest text bound to MATCH raised syntax errors or silently became operators/column filters.
const SQ41 = [
  "can I bring my dog?",
  "gluten-free roti",
  "what's vegan",
  'he said "spicy',
  "NOT spicy",
  "dal OR",
  "paneer AND",
  "(dal",
  "NEAR(dal",
  "",
  "   ",
  "price: 400",
  "*",
  "Rs.420",
  "e-mail",
  "body:dog",
  "{body}: dog",
  "veg*",
  "^dal",
  "-body: dog",
  "fact_id: menu",
  "ＮＯＴ spicy", // fullwidth, NFKC → NOT
  "🍛🍛🍛",
  "\u0000\u0007",
  "पनीर टिक्का",
  "x".repeat(5000),
];

describe("FTS5 sanitiser (SQ-41, D-08, D-13)", () => {
  it("never throws on raw guest text, and only ever emits quoted OR-joined tokens", () => {
    for (const s of SQ41) {
      expect(() => lexicalSearch(db, s), JSON.stringify(s.slice(0, 40))).not.toThrow();
      const q = ftsQuery(s);
      if (q !== null) expect(q).toMatch(/^"[\p{L}\p{N}]+"( OR "[\p{L}\p{N}]+")*$/u);
    }
  });

  it("turns operators and column syntax into plain search terms", () => {
    expect(ftsQuery("NOT spicy")).toBe('"not" OR "spicy"');
    expect(ftsQuery("body:dog")).toBe('"body" OR "dog"');
    expect(ftsQuery("fact_id: menu")).toBe('"fact" OR "id" OR "menu"');
    expect(lexicalSearch(db, "body:dog")).toContain("faq:pets"); // not a column filter
  });

  it("removes stopwords, falls back to all tokens if only stopwords remain, de-duplicates and caps at 16", () => {
    expect(ftsQuery("can I bring my dog?")).toBe('"bring" OR "dog"');
    expect(ftsQuery("what is it")).toBe('"what" OR "is" OR "it"');
    expect(ftsQuery("Dal dal DAL")).toBe('"dal"');
    expect(ftsQuery(Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "))!.split(" OR ").length).toBe(16);
    expect(ftsQuery("a ? !")).toBeNull();
  });

});

describe("rrf", () => {
  it("sums 1/(k+rank) and keeps first-seen order on ties", () => {
    const r = rrf([["a", "b"], ["b", "c"]], 60);
    expect(r.map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(r[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(rrf([["x"], ["y"]]).map((x) => x.id)).toEqual(["x", "y"]);
  });
  it("builds the query from the latest and previous guest turns", () => {
    expect(retrievalQuery("and dessert?", "is the dal vegan")).toBe("and dessert? is the dal vegan");
    expect(retrievalQuery("hi", null)).toBe("hi");
  });
});

describe("golden top-8 under the fake embedder (AC-15 Layer A)", () => {
  it("matches the committed lists exactly, for hybrid and lexical-only retrieval", async () => {
    const got: Record<"hybrid" | "lexical", Record<string, string[]>> = { hybrid: {}, lexical: {} };
    for (const r of LABELLED) {
      const h = await retrieveFacts(r.query, {}, { db, facts, embedder: fake });
      expect(h.mode, r.id).toBe("hybrid");
      got.hybrid[r.id] = ids(h);
      const l = await retrieveFacts(r.query, {}, { db, facts, embedder: null });
      expect([l.mode, l.reason]).toEqual(["lexical", "no_embedder"]);
      got.lexical[r.id] = ids(l);
    }
    expect(fake.misses, "every query and fact has a recorded vector").toEqual([]);
    const body = (m: "hybrid" | "lexical") => Object.entries(got[m]).map(([k, v]) => `    "${k}": ${JSON.stringify(v)}`).join(",\n");
    await expect(`{\n  "hybrid": {\n${body("hybrid")}\n  },\n  "lexical": {\n${body("lexical")}\n  }\n}\n`).toMatchFileSnapshot("../golden/retrieval-top8.json");

    // The measured floors (D-13) still hold for the committed lists, and every list question (A01–A10)
    // retrieves its aggregate in both modes (review M5, M10).
    const metrics = (m: "hybrid" | "lexical", set: Labelled[]) => {
      const rows = set.map((r) => r.relevant.filter((id) => got[m][r.id].includes(id)).length / Math.min(r.relevant.length, 8));
      return { hit: rows.filter((x) => x > 0).length / rows.length, recall: rows.reduce((a, b) => a + b, 0) / rows.length };
    };
    expect(metrics("hybrid", probe.retrieval).hit).toBe(1);
    expect(metrics("hybrid", probe.retrieval).recall).toBeGreaterThanOrEqual(0.9);
    expect(metrics("lexical", probe.retrieval).hit).toBeGreaterThanOrEqual(0.85);
    expect(metrics("hybrid", lists.queries).hit).toBe(1);
    expect(metrics("lexical", lists.queries).hit).toBe(1);
    for (const m of ["hybrid", "lexical"] as const)
      for (const [id, top] of Object.entries(got[m])) expect(top.filter((x) => /^menu-(cat|diet):/.test(x)).length, `${m} ${id}`).toBeLessThanOrEqual(2);
  });
});

describe("retrieveFacts falls back to lexical, never throws (D-02, D-13, AC-16)", () => {
  it("reports why: embedder down, timeout, not pulled, other errors", async () => {
    for (const [q, reason] of [
      ["vegan dessert #fake:embed_down", "EMBED_UNAVAILABLE"],
      ["vegan dessert #fake:embed_timeout", "EMBED_TIMEOUT"],
    ] as const) {
      const r = await retrieveFacts(q, {}, { db, facts, embedder: fake });
      expect([r.mode, r.reason]).toEqual(["lexical", reason]);
      expect(ids(r)).toContain("menu:mango-sorbet");
    }
    const broken = (err: unknown): Embedder => ({ provider: "ollama", model: "m", digest: async () => Promise.reject(err), embed: async () => [] });
    expect((await retrieveFacts("dal", {}, { db, facts, embedder: broken(new EmbedError("EMBED_NOT_PULLED", "x")) })).reason).toBe("EMBED_NOT_PULLED");
    expect((await retrieveFacts("dal", {}, { db, facts, embedder: broken(new Error("weird")) })).reason).toBe("EMBED_UNAVAILABLE");
  });

  it("times out a slow embedder within the budget", async () => {
    const slow: Embedder = {
      provider: "ollama",
      model: "m",
      digest: (o) => new Promise((_r, reject) => o?.signal?.addEventListener("abort", () => reject(new EmbedError("EMBED_TIMEOUT", "slow")))),
      embed: async () => [],
    };
    const r = await retrieveFacts("dal", {}, { db, facts, embedder: slow, timeoutMs: 20 });
    expect([r.mode, r.reason]).toEqual(["lexical", "EMBED_TIMEOUT"]);
  });

  it("uses lexical when any current fact lacks a current vector (missing, stale or other digest)", async () => {
    const other: Embedder = { ...fake, digest: async () => "some-other-digest", embed: fake.embed };
    expect((await retrieveFacts("dal", {}, { db, facts, embedder: other })).reason).toBe("index_incomplete");
    const changed = facts.map((f) => (f.id === "menu:dal-ember" ? { ...f, text: `${f.text} New recipe.` } : f));
    expect((await retrieveFacts("dal", {}, { db, facts: changed, embedder: fake })).reason).toBe("index_incomplete");
    db.prepare("SAVEPOINT s").run();
    db.prepare("DELETE FROM fact_embeddings WHERE fact_id = 'faq:pets'").run();
    expect((await retrieveFacts("dal", {}, { db, facts, embedder: fake })).reason).toBe("index_incomplete");
    db.prepare("ROLLBACK TO s").run();
    db.prepare("RELEASE s").run();
    expect((await retrieveFacts("dal", {}, { db, facts, embedder: fake })).mode).toBe("hybrid");
  });
});

describe("aggregate cap", () => {
  it("allows at most 2 aggregates per turn, counting carried ones", async () => {
    const r = await retrieveFacts("vegan gluten-free desserts and drinks", { carry: ["menu-diet:egg"] }, { db, facts, embedder: fake });
    expect(ids(r)[0]).toBe("menu-diet:egg");
    expect(ids(r).filter((x) => /^menu-(cat|diet):/.test(x))).toHaveLength(2);
    const carried = await retrieveFacts("dal", { carry: ["menu-diet:egg", "menu-cat:drinks", "menu-cat:mains", "faq:pets"] }, { db, facts, embedder: fake });
    expect(ids(carried).slice(0, 3)).toEqual(["menu-diet:egg", "menu-cat:drinks", "faq:pets"]);
    expect(ids(carried).filter((x) => /^menu-(cat|diet):/.test(x))).toHaveLength(2);
  });
});

describe("lastCitedIds carry-over (D-13)", () => {
  it("puts current carried facts first (at most 4), drops unknown or non-retrievable IDs, then fills to 8", async () => {
    const carry = ["faq:pets", "hours:hauz-khas:mon", "menu:nope", "faq:pets", "menu:dal-ember", "faq:wifi", "faq:deposit", "faq:payment"];
    const r = await retrieveFacts("vegan dessert", { carry }, { db, facts, embedder: fake });
    expect(ids(r).slice(0, 4)).toEqual(["faq:pets", "menu:dal-ember", "faq:wifi", "faq:deposit"]);
    expect(r.hits.slice(0, 4).every((h) => h.source === "carry")).toBe(true);
    expect(ids(r)).toHaveLength(8);
    expect(new Set(ids(r)).size).toBe(8);
    expect(ids(r)).toContain("menu:mango-sorbet");
  });
});
