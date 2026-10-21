import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { faqHandlers, faqItemHandlers, chatTestHandler, menuHandlers, menuItemHandlers } from "@/lib/api/admin-workspace";
import { runTurn } from "@/lib/chat/turn";
import { noTurnLimit } from "@/lib/chat/ratelimit";
import { applySeed, StaffChangesError } from "@/lib/db/seed";
import { fakeEmbedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { embeddingCoverage, lexicalCurrent } from "@/lib/kb/index";
import { lexicalSearch, retrieveFacts } from "@/lib/kb/retrieve";
import { fakeModel, nullBooking, sequenceModel } from "@/lib/llm/fake";
import type { Turn } from "@/lib/llm/schema";
import type { Block } from "@/lib/chat/types";
import { call, E2E_SCRIPT, SEED, seeded } from "./helpers/admin";

// D-25 menu and FAQ management against the chatbot's own tables: edits are validated, logged, keyword-indexed in the
// same transaction and embedded in the background; the next chat turn sees them; nothing stale is kept.
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
let s: Awaited<ReturnType<typeof seeded>>;
beforeEach(async () => {
  s = await seeded("admin-menu", NOW, { hold: true });
});
// The background embedding waits for release(), so each test can check the state between a save and its refresh.
const settle = async () => {
  s.release();
  await s.deps.kb!.refresher.idle();
};
afterEach(() => s.t.cleanup());

const db = () => s.t.db;
const facts = () => renderKbFacts(loadFactSource(db()));
const factText = (id: string) => facts().find((f) => f.id === id)?.text ?? null;
const coverage = async () => embeddingCoverage(db(), facts(), await fakeEmbedder().digest());
const mode = async (q: string) => (await retrieveFacts(q, {}, { db: db(), facts: facts(), embedder: fakeEmbedder() })).mode;
const menu = () => menuHandlers(s.deps);
const item = () => menuItemHandlers(s.deps);
const browse = async (course: "mains" | "tandoor" | "small-plates") => {
  const r = await runTurn({ now: NOW, sessionId: "00000000-0000-4000-8000-000000000001", messages: [], draft: null, action: { type: "menu", course } }, { db: db(), model: fakeModel(), embedder: fakeEmbedder(), limiter: noTurnLimit });
  return r.reply.blocks.flatMap((b: Block) => (b.type === "menu_list" ? b.groups.flatMap((g) => g.items) : []));
};

const NEW_DISH = { name: "Smoked Beetroot Tikki", description: "Beetroot and potato patties smoked over coals, with mint chutney", category: "small-plates", priceInr: 345, dietary: ["vegan", "gluten-free"], spiceLevel: 1, branches: null };

describe("menu (D-25)", () => {
  it("lists the chatbot's 48 dishes with counts by status and category", async () => {
    const r = await call(menu().GET, "GET", "/api/admin/menu");
    expect(r.status).toBe(200);
    expect(r.json.counts).toEqual({ total: 48, listed: 48, available: 47, unavailable: 1, removed: 0 });
    expect(r.json.byCategory.find((c: { category: string }) => c.category === "mains")).toMatchObject({ listed: 10, available: 10 });
    expect(r.json.items.find((i: { slug: string }) => i.slug === "keema-pav-sliders")).toMatchObject({ scopeLabel: "Golf Course Road only", createdBy: "seed" });
  });

  it("creates a dish: one fact, keyword-indexed before the response, embedded by the refresher; a repeat submit is refused", async () => {
    const r = await call(menu().POST, "POST", "/api/admin/menu", NEW_DISH);
    expect(r.status).toBe(201);
    expect(r.json.item).toMatchObject({ slug: "smoked-beetroot-tikki", status: "available", createdBy: "staff", categoryLabel: "Small plates" });
    expect(factText("menu:smoked-beetroot-tikki")).toBe("Smoked Beetroot Tikki (small plates), ₹345. Beetroot and potato patties smoked over coals, with mint chutney. Vegan, vegetarian, gluten-free. Spice: mild.");
    expect(lexicalCurrent(db(), facts())).toBe(true);
    expect(lexicalSearch(db(), "smoked beetroot tikki").slice(0, 2)).toContain("menu:smoked-beetroot-tikki");
    expect((await coverage()).missing).toEqual(["menu:smoked-beetroot-tikki"]);
    expect(await mode("beetroot")).toBe("lexical"); // keyword-only until the new vector is stored
    await settle();
    expect(await coverage()).toMatchObject({ missing: [], stale: [] });
    expect(await mode("beetroot")).toBe("hybrid");
    const again = await call(menu().POST, "POST", "/api/admin/menu", NEW_DISH);
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ code: "CONFLICT", existing: "smoked-beetroot-tikki" });
    expect((db().prepare("SELECT count(*) AS n FROM menu_items").get() as { n: number }).n).toBe(49);
    expect(db().prepare("SELECT area, action, target FROM admin_changes").all()).toEqual([{ area: "menu", action: "created", target: "smoked-beetroot-tikki" }]);
  });

  it("validates on the server with field messages and stores nothing", async () => {
    const bad = async (patch: Record<string, unknown>) => (await call(menu().POST, "POST", "/api/admin/menu", { ...NEW_DISH, ...patch })).json.error;
    expect((await bad({ priceInr: 0 })).fields.priceInr).toMatch(/at least ₹1/);
    expect((await bad({ priceInr: 99.5 })).fields.priceInr).toMatch(/whole rupees/);
    expect((await bad({ dietary: ["vegan", "contains-dairy"] })).fields.dietary).toMatch(/can't contain dairy or egg/);
    expect((await bad({ dietary: ["halal"] })).fields.dietary).toBeDefined();
    expect((await bad({ category: "starters" })).fields.category).toBeDefined();
    expect((await bad({ branches: ["nowhere"] })).fields.branches).toMatch(/Unknown or inactive branch/);
    expect((await bad({ name: " " })).fields.name).toBeDefined();
    expect((await bad({ ingredients: "beetroot" })).code).toBe("VALIDATION"); // no such field: nothing invented
    expect((db().prepare("SELECT count(*) AS n FROM menu_items").get() as { n: number }).n).toBe(48);
  });

  it("a price edit reaches the next chat turn and the list facts, and only the changed facts are re-embedded", async () => {
    const r = await call(item().PATCH, "PATCH", "/api/admin/menu/dal-ember", { priceInr: 465 }, { slug: "dal-ember" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: true, summary: "price ₹445 → ₹465" });
    expect(factText("menu:dal-ember")).toContain("₹465");
    expect(factText("menu-cat:mains")).toContain("Dal Ember ₹465");
    expect((await browse("mains")).find((i) => i.id === "menu:dal-ember")?.price).toBe(465);
    expect((await coverage()).stale).toEqual(["menu:dal-ember"]); // aggregates are indexed by their description, not prices
    await settle();
    expect(await coverage()).toMatchObject({ missing: [], stale: [] });
    const job = db().prepare("SELECT status, summary FROM kb_jobs WHERE kind = 'refresh' ORDER BY id DESC LIMIT 1").get();
    expect(job).toEqual({ status: "succeeded", summary: "86 facts: 1 embedded, 85 already current, 0 old vectors removed" });
    expect((await call(item().PATCH, "PATCH", "/api/admin/menu/dal-ember", { priceInr: 465 }, { slug: "dal-ember" })).json.changed).toBe(false);
  });

  it("an unavailable dish is never suggested or listed for ordering, and the chatbot's fact says so", async () => {
    expect((await call(item().PATCH, "PATCH", "/api/admin/menu/dal-ember", { status: "unavailable" }, { slug: "dal-ember" })).json.item.status).toBe("unavailable");
    expect(factText("menu:dal-ember")).toMatch(/Currently unavailable\.$/);
    expect((await browse("mains")).map((i) => i.id)).not.toContain("menu:dal-ember");
    // The scripted chooser still picks the Dal Ember (as a stale model might): code refuses it and suggests a dish that fits.
    const turn = await runTurn(
      { now: NOW, sessionId: "00000000-0000-4000-8000-000000000002", messages: [{ role: "guest", content: "Recommend something vegetarian" }], draft: null },
      { db: db(), model: fakeModel({ script: E2E_SCRIPT }), embedder: fakeEmbedder(), limiter: noTurnLimit },
    );
    const shown = turn.reply.blocks.flatMap((b) => (b.type === "recommendation" ? b.items.map((i) => i.id) : []));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain("menu:dal-ember");
    expect(turn.reply.text).not.toContain("Dal Ember");
    const detail = await call(item().GET, "GET", "/api/admin/menu/dal-ember", undefined, { slug: "dal-ember" });
    expect(detail.json).toMatchObject({ guestCard: null, fact: { id: "menu:dal-ember" } });
  });

  it("a removed dish leaves the chatbot entirely (facts, keyword index and vectors) and can be restored", async () => {
    await call(item().PATCH, "PATCH", "/api/admin/menu/chana-pindi", { status: "removed" }, { slug: "chana-pindi" });
    expect(factText("menu:chana-pindi")).toBeNull();
    expect(factText("menu-diet:vegan")).not.toContain("Chana Pindi");
    expect(db().prepare("SELECT 1 FROM kb_fts WHERE fact_id = 'menu:chana-pindi'").get()).toBeUndefined();
    expect((await browse("mains")).map((i) => i.id)).not.toContain("menu:chana-pindi");
    await settle();
    expect(db().prepare("SELECT count(*) AS n FROM fact_embeddings WHERE fact_id = 'menu:chana-pindi'").get()).toEqual({ n: 0 });
    expect(await mode("chickpea curry")).toBe("hybrid");
    const detail = await call(item().GET, "GET", "/api/admin/menu/chana-pindi", undefined, { slug: "chana-pindi" });
    expect(detail.json).toMatchObject({ item: { status: "removed" }, fact: null, index: { keyword: "not_indexed", vector: "not_indexed" } });
    await call(item().PATCH, "PATCH", "/api/admin/menu/chana-pindi", { status: "available" }, { slug: "chana-pindi" });
    expect(factText("menu:chana-pindi")).toContain("Chana Pindi (mains), ₹395");
  });

  it("a blank spice level is 'not listed' in the chatbot's fact, never 'not spicy'", async () => {
    await call(item().PATCH, "PATCH", "/api/admin/menu/dal-ember", { spiceLevel: null }, { slug: "dal-ember" });
    expect(factText("menu:dal-ember")).toContain("Spice: not listed.");
  });

  it("404s an unknown dish and keeps slugs fixed", async () => {
    expect((await call(item().GET, "GET", "/api/admin/menu/nope", undefined, { slug: "nope" })).status).toBe(404);
    expect((await call(item().PATCH, "PATCH", "/api/admin/menu/dal-ember", { slug: "dal" }, { slug: "dal-ember" })).status).toBe(400);
  });
});

describe("the bestseller mark (D-26)", () => {
  it("is set by staff, changes the dish's fact, is logged, and is what the chatbot cites for 'best seller?'", async () => {
    const ask = async () => {
      const turn: Turn = { intent: "recommend", booking: nullBooking(), prefs: { diet: [], avoid: [], maxPrice: null, course: null, mild: false, allergy: false, relation: null }, answer: null, citedFactIds: [], answerable: true };
      return runTurn({ now: NOW, sessionId: "00000000-0000-4000-8000-000000000002", messages: [{ role: "guest", content: "What is your best seller?" }], draft: null, context: { lastCitedIds: [], asked: ["diet"] } }, { db: db(), model: sequenceModel([turn]), embedder: fakeEmbedder(), limiter: noTurnLimit });
    };
    expect((await ask()).reply.text).toBe("We don't keep sales or popularity figures, so I can't say which dish sells best. I can suggest a dish that suits you instead.");
    const r = await call(item().PATCH, "PATCH", "/api/admin/menu/dal-ember", { bestseller: true }, { slug: "dal-ember" });
    expect(r.status).toBe(200);
    expect(r.json.item.bestseller).toBe(true);
    expect(factText("menu:dal-ember")).toMatch(/ Marked as a bestseller by the restaurant\.$/);
    expect(lexicalCurrent(db(), facts())).toBe(true);
    expect(db().prepare("SELECT summary FROM admin_changes WHERE area = 'menu' ORDER BY id DESC LIMIT 1").get()).toMatchObject({ summary: expect.stringContaining("marked as a bestseller") });
    const after = await ask();
    expect(after.reply.text).toBe("The restaurant marks the Dal Ember as a bestseller.");
    expect(after.reply.blocks[0]).toMatchObject({ type: "recommendation", items: [{ id: "menu:dal-ember" }] });
    // A new dish isn't marked unless staff tick it.
    expect((await call(menu().POST, "POST", "/api/admin/menu", NEW_DISH)).json.item.bestseller).toBe(false);
  });
});

describe("FAQs (D-25)", () => {
  const faqs = () => faqHandlers(s.deps);
  const faq = () => faqItemHandlers(s.deps);

  it("lists the 25 seeded FAQs with no conflicts", async () => {
    const r = await call(faqs().GET, "GET", "/api/admin/faqs");
    expect(r.json.counts).toEqual({ total: 25, active: 25, inactive: 0 });
    expect(r.json.conflicts).toEqual([]);
  });

  it("creates, edits and deactivates an FAQ; the chatbot's fact and keyword index follow each change", async () => {
    const r = await call(faqs().POST, "POST", "/api/admin/faqs", { question: "Do you charge corkage?", answer: "We don't allow outside wine or spirits.", category: "food", branch: null });
    expect(r.status).toBe(201);
    expect(factText("faq:do-you-charge-corkage")).toBe("Q: Do you charge corkage? A: We don't allow outside wine or spirits.");
    expect(lexicalSearch(db(), "corkage")[0]).toBe("faq:do-you-charge-corkage");
    expect((await call(faqs().POST, "POST", "/api/admin/faqs", { question: "Do you charge corkage?", answer: "Again", category: "food", branch: null })).status).toBe(409);
    await call(faq().PATCH, "PATCH", "/api/admin/faqs/do-you-charge-corkage", { answer: "Corkage is ₹1,000 per bottle at Golf Course Road.", branch: "gurugram" }, { slug: "do-you-charge-corkage" });
    expect(factText("faq:do-you-charge-corkage")).toBe("(Golf Course Road) Q: Do you charge corkage? A: Corkage is ₹1,000 per bottle at Golf Course Road.");
    expect(lexicalCurrent(db(), facts())).toBe(true);
    await call(faq().PATCH, "PATCH", "/api/admin/faqs/do-you-charge-corkage", { isActive: false }, { slug: "do-you-charge-corkage" });
    expect(factText("faq:do-you-charge-corkage")).toBeNull();
    expect(lexicalSearch(db(), "corkage")).toEqual([]);
    await settle();
    expect(await coverage()).toMatchObject({ missing: [], stale: [] });
    expect(db().prepare("SELECT count(*) AS n FROM fact_embeddings WHERE fact_id = 'faq:do-you-charge-corkage'").get()).toEqual({ n: 0 });
  });

  it("validates questions, answers, categories and scope", async () => {
    const bad = async (b: Record<string, unknown>) => (await call(faqs().POST, "POST", "/api/admin/faqs", { question: "Is there a kids menu?", answer: "Yes.", category: "food", branch: null, ...b })).json.error;
    expect((await bad({ question: "Kids" })).fields.question).toMatch(/at least 5/);
    expect((await bad({ answer: "x".repeat(501) })).fields.answer).toMatch(/up to 500/);
    expect((await bad({ category: "misc" })).fields.category).toBeDefined();
    expect((await bad({ branch: "noida" })).fields.branch).toMatch(/Unknown or inactive/);
  });

  it("warns when two active FAQs ask the same thing with different answers, and clears when one is deactivated", async () => {
    await call(faqs().POST, "POST", "/api/admin/faqs", { question: "Is there parking?", answer: "Yes, free valet at both branches.", category: "facilities", branch: null });
    const r = await call(faqs().GET, "GET", "/api/admin/faqs");
    expect(r.json.conflicts.map((c: { kind: string; a: string; b: string }) => `${c.kind} ${[c.a, c.b].sort().join(" ")}`).sort()).toEqual(["conflict is-there-parking parking-gurugram", "conflict is-there-parking parking-hauz-khas"]);
    await call(faq().PATCH, "PATCH", "/api/admin/faqs/is-there-parking", { isActive: false }, { slug: "is-there-parking" });
    expect((await call(faqs().GET, "GET", "/api/admin/faqs")).json.conflicts).toEqual([]);
  });

  it("answers a staff test question with a real chat turn (scripted model here) and its cited facts", async () => {
    const r = await call(chatTestHandler(s.deps), "POST", "/api/admin/chat-test", { question: "can I bring my dog?" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ outcome: "faq_answer", intent: "faq", text: "Well-behaved dogs are welcome on the Golf Course Road terrace.", cited: [{ id: "faq:pets" }] });
    expect(r.json.cited[0].text).toMatch(/^Q: Can I bring my dog\?/);
    expect(db().prepare("SELECT count(*) AS n FROM reservations").get()).toEqual({ n: 0 });
    expect((await call(chatTestHandler(s.deps), "POST", "/api/admin/chat-test", { question: "" })).status).toBe(400);
  });
});

describe("reseeding after staff edits (D-25)", () => {
  it("refuses to overwrite staff changes unless told to", async () => {
    await call(item().PATCH, "PATCH", "/api/admin/menu/dal-ember", { priceInr: 465 }, { slug: "dal-ember" });
    expect(() => applySeed(db(), SEED, { now: NOW })).toThrow(StaffChangesError);
    expect(factText("menu:dal-ember")).toContain("₹465");
    applySeed(db(), SEED, { now: NOW, overwriteStaffChanges: true });
    expect(factText("menu:dal-ember")).toContain("₹445");
    expect(() => applySeed(db(), SEED, { now: NOW })).not.toThrow(); // nothing changed since that seed
  });
});
