import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatHandler, requestDeduper } from "@/lib/api/chat";
import { knowledgeHandlers } from "@/lib/api/admin-workspace";
import { healthHandler } from "@/lib/api/health";
import { faqDetail, updateFaq } from "@/lib/admin/faq";
import { menuItemDetail, updateMenuItem } from "@/lib/admin/menu";
import { openDb } from "@/lib/db/client";
import { migrate, MIGRATIONS_DIR } from "@/lib/db/migrate";
import { applySeed } from "@/lib/db/seed";
import { EmbedError, fakeEmbedder, type Embedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { embeddingCoverage } from "@/lib/kb/index";
import { createRefresher, refreshIndex, resumeRefresh } from "@/lib/kb/refresh";
import { call, SEED, seeded } from "./helpers/admin";

// Failure-mode audit (evals/failure-modes.json): admin, knowledge-index and schema regressions on temp databases (never
// data/app.db), with the real handlers and the fake embedder. Fixed clock: Fri 16 Oct 2026, 2:00 PM IST.
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const SID = "4b7d0c9e-2f1a-4c3b-9d8e-7f6a5b4c3d2e";
let s: Awaited<ReturnType<typeof seeded>>;
const cleanups: (() => void)[] = [];
afterEach(() => {
  s?.t.cleanup();
  for (const c of cleanups.splice(0)) c();
});
const db = () => s.t.db;
const facts = () => renderKbFacts(loadFactSource(db()));
const fact = (id: string) => facts().find((f) => f.id === id);
/** An embedder that fails while `down.value` is true. */
const flaky = (down: { value: boolean }, only?: string): Embedder => {
  const base = fakeEmbedder();
  return {
    provider: "fake",
    model: base.model,
    digest: async (o) => {
      if (down.value && !only) throw new EmbedError("EMBED_UNAVAILABLE", "could not reach the embedding model");
      return base.digest(o);
    },
    embed: async (inputs, o) => {
      if (down.value && (!only || inputs.some((i) => i.includes(only)))) throw new EmbedError("EMBED_UNAVAILABLE", "could not reach the embedding model");
      return base.embed(inputs, o);
    },
  };
};

describe("failure modes: schema, index refresh and status", () => {
  it("FM-028 a database one migration behind: health is 503 with the pending list, and chat answers a JSON 503, not a bare 500", async () => {
    s = await seeded("fm-adm", NOW);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-fm-mig-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f < "004")) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const old = openDb(path.join(dir, "app.db"));
    cleanups.push(() => old.close());
    migrate(old, NOW, dir);
    const deps = { ...s.deps, db: () => old };
    const health = await healthHandler(deps)();
    expect(health.status).toBe(503);
    expect((await health.json()).db).toMatchObject({ ok: false, pending: ["004_bestseller"] });
    const body = { sessionId: SID, requestId: "5c2b9f1e-1d3a-4e5b-8c7d-6e5f4a3b2c1d", messages: [{ role: "guest", content: "What desserts do you have?" }], draft: null };
    const res = await chatHandler(deps, requestDeduper())(new Request("http://127.0.0.1:3100/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({ code: "UNAVAILABLE" });
    expect((await healthHandler(s.deps)()).status).toBe(200); // the up-to-date database is healthy
  });

  it("FM-020 after an embedding outage the refresher retries on its own (bounded), and a start-up resumes a failed refresh", async () => {
    s = await seeded("fm-adm", NOW);
    const down = { value: true };
    const timers: { fn: () => void; ms: number }[] = [];
    const r = createRefresher({ db: () => db(), embedder: () => flaky(down), now: () => NOW, retry: { delaysMs: [60_000, 300_000], schedule: (fn, ms) => void timers.push({ fn, ms }) } });
    updateMenuItem(db(), NOW, "dal-ember", { priceInr: 465 });
    r.request("menu");
    await r.idle();
    expect(timers.map((t) => t.ms)).toEqual([60_000]);
    timers.shift()!.fn(); // still down: one more retry, then no more
    await r.idle();
    expect(timers.map((t) => t.ms)).toEqual([300_000]);
    down.value = false;
    timers.shift()!.fn();
    await r.idle();
    expect(timers).toEqual([]);
    expect(embeddingCoverage(db(), facts(), await fakeEmbedder().digest()).missing).toEqual([]);
    // Start-up: a failed last refresh runs again; a succeeded one doesn't.
    expect(resumeRefresh(db(), r)).toBeNull();
    down.value = true;
    updateMenuItem(db(), NOW, "dal-ember", { priceInr: 475 });
    r.request("menu");
    await r.idle();
    down.value = false;
    const fresh = createRefresher({ db: () => db(), embedder: () => flaky(down), now: () => NOW, retry: { delaysMs: [], schedule: () => {} } });
    expect(resumeRefresh(db(), fresh)).toEqual(expect.any(Number));
    await fresh.idle();
    expect(embeddingCoverage(db(), facts(), await fakeEmbedder().digest()).stale).toEqual([]);
  });

  it("FM-029 a document that can't be embedded is named in the index status, which says no refresh is on its way", async () => {
    const down = { value: true };
    s = await seeded("fm-adm", NOW, { embedder: flaky(down, "Corkage") });
    await call(knowledgeHandlers(s.deps).POST, "POST", "/api/admin/knowledge", { title: "Corkage policy", docType: "payment", branch: null, text: "# Corkage\n\nCorkage is ₹1,000 a bottle at both branches, up to two bottles a table." });
    await s.deps.kb!.refresher.idle();
    const o = (await call(knowledgeHandlers(s.deps).GET, "GET", "/api/admin/knowledge")).json;
    expect(o.index.mode).toBe("keyword"); // D-13: hybrid search needs every fact's vector
    expect(o.index.reason).toMatch(/until the index is refreshed\. "Corkage policy" couldn't be embedded/);
    expect(o.index.reason).not.toMatch(/until the index refresh finishes/);
  });

  it("FM-030 kb:index's pass, racing a staff edit and the server's refresh, leaves every vector current", async () => {
    s = await seeded("fm-adm", NOW);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = fakeEmbedder();
    const held: Embedder = { provider: "fake", model: base.model, digest: (o) => base.digest(o), embed: async (i, o) => (await gate, base.embed(i, o)) };
    updateMenuItem(db(), NOW, "dal-ember", { priceInr: 455 });
    const script = refreshIndex(db(), held, NOW); // the old text is embedded while...
    await new Promise((r) => setTimeout(r, 0));
    updateMenuItem(db(), NOW, "dal-ember", { priceInr: 465 }); // ...staff edit again and the server refreshes
    await refreshIndex(db(), base, NOW);
    release();
    await script;
    const cov = embeddingCoverage(db(), facts(), await base.digest());
    expect([cov.missing, cov.stale]).toEqual([[], []]);
    expect(fs.readFileSync(path.resolve(__dirname, "../../scripts/kb-index.ts"), "utf8")).toMatch(/refreshIndex\(/);
  });

  it("FM-032 a dish's or FAQ's vector counts only for the embedding model in use; unknown when it doesn't answer", async () => {
    s = await seeded("fm-adm", NOW);
    const digest = await fakeEmbedder().digest();
    expect(menuItemDetail(db(), "dal-ember", digest).index.vector).toBe("current");
    expect(menuItemDetail(db(), "dal-ember", "sha256:another-model").index.vector).toBe("missing");
    expect(menuItemDetail(db(), "dal-ember", null).index.vector).toBe("unknown");
    expect(faqDetail(db(), "pets", "sha256:another-model").index.vector).toBe("missing");
  });
});

describe("failure modes: menu and seed data", () => {
  it("FM-031 a dish limited to the only open branch stays limited when the other branch reopens", async () => {
    s = await seeded("fm-adm", NOW);
    db().prepare("UPDATE branches SET is_active = 0 WHERE slug = 'gurugram'").run();
    updateMenuItem(db(), NOW, "dal-ember", { branches: ["hauz-khas"] });
    db().prepare("UPDATE branches SET is_active = 1 WHERE slug = 'gurugram'").run();
    expect(db().prepare("SELECT branch_slugs FROM menu_items WHERE slug = 'dal-ember'").get()).toEqual({ branch_slugs: JSON.stringify(["hauz-khas"]) });
    expect(fact("menu:dal-ember")?.text).toMatch(/Hauz Khas only\./);
  });
  it("FM-033 --overwrite-staff-changes brings back a dish staff removed and an FAQ they deactivated", async () => {
    s = await seeded("fm-adm", NOW);
    updateMenuItem(db(), NOW, "dal-ember", { status: "removed" });
    updateFaq(db(), NOW, "pets", { isActive: false });
    expect(fact("menu:dal-ember")).toBeUndefined();
    expect(fact("faq:pets")).toBeUndefined();
    applySeed(db(), SEED, { now: NOW, overwriteStaffChanges: true });
    expect(fact("menu:dal-ember")).toBeDefined();
    expect(fact("faq:pets")).toBeDefined();
  });
  it("FM-034 a staff edit that doesn't change the category leaves the stored one as it is", async () => {
    s = await seeded("fm-adm", NOW);
    db().prepare("UPDATE menu_items SET category = 'soups' WHERE slug = 'dal-ember'").run(); // a row from an older seed
    updateMenuItem(db(), NOW, "dal-ember", { priceInr: 455 });
    expect(db().prepare("SELECT category FROM menu_items WHERE slug = 'dal-ember'").get()).toEqual({ category: "soups" });
  });
});
