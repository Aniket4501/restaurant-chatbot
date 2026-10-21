import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { loadFactSource } from "@/lib/kb/facts";
import { evidenceQuestion, evidenceStep } from "@/lib/chat/evidence";
import { menuEntries, type MenuEntry } from "@/lib/chat/menu";
import { noPrefs, type Prefs, type TraceEntry } from "@/lib/chat/types";

// D-26: popularity, review and evidence questions are factual. The data has no sales figures, ratings or reviews; the
// only evidence is the bestseller mark staff set in the admin. Fixture: evals/fixtures/base.json (nothing marked).
const ROOT = path.resolve(__dirname, "../..");
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
let entries: MenuEntry[];
beforeAll(() => {
  const db = openDb(":memory:");
  migrate(db, NOW);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now: NOW });
  entries = menuEntries(loadFactSource(db));
});
const P = (o: Partial<Prefs> = {}): Prefs => ({ ...noPrefs(), ...o });
const marked = (...slugs: string[]) => entries.map((e) => ({ ...e, bestseller: slugs.includes(e.id.slice(5)) }));
const step = (text: string, o: { prefs?: Prefs; menu?: MenuEntry[]; recommended?: string[]; asked?: ("diet" | "course")[]; lastReply?: string } = {}) => {
  const trace: TraceEntry[] = [];
  const kind = evidenceQuestion(text, !!o.recommended?.length, entries.map((e) => e.name), o.lastReply ?? "");
  if (!kind) throw new Error(`not an evidence question: ${text}`);
  return { ...evidenceStep({ kind, text, prefs: o.prefs ?? P(), entries: o.menu ?? entries, context: { lastCitedIds: [], recommended: o.recommended, asked: o.asked }, branch: null, trace }), trace };
};

describe("which questions ask for evidence", () => {
  it("reads sales, popularity, review and evidence questions, in their usual wordings", () => {
    for (const t of ["What is your best seller?", "What is your best vegetarian seller?", "best-selling dessert?", "Which dish sells the most?", "What's the top selling main?", "What do most people order?", "Is the butter chicken popular?", "What's your most popular dessert?"]) expect(evidenceQuestion(t, false, entries.map((e) => e.name)), t).toBe("sales");
    expect(evidenceQuestion("Which dish has the best reviews?")).toBe("reviews");
    expect(evidenceQuestion("Do you have actual sales data to support that?")).toBe("evidence");
  });
  it("leaves subjective requests to the recommendation path", () => {
    for (const t of ["What's your best dish?", "best dessert?", "I want the best vegetarian option under 400", "What would you recommend?", "Recommend something under ₹400."]) expect(evidenceQuestion(t), t).toBeNull();
  });
});

describe("answers from the data, never from the model's judgment", () => {
  it("with nothing marked: no popularity claim, and the one diet question when nothing is known about the guest", () => {
    const r = step("What is your best seller?");
    expect(r.text).toBe("We don't keep sales or popularity figures, so I can't say which dish sells best. I can suggest something that suits you instead. Any preference: vegetarian, vegan, or do you eat everything?");
    expect(r.asked).toBe("diet");
    expect(r.blocks.some((b) => b.type === "recommendation")).toBe(false);
    expect(r.trace).toContainEqual({ action: "evidence", args: { kind: "sales", bestsellers: 0 } });
  });
  it("offers a suggestion of what was asked about once something is known, and asks the diet question only once", () => {
    const r = step("What's your most popular dessert?", { prefs: P({ diet: ["vegan"] }) });
    expect(r.text).toBe("We don't keep sales or popularity figures, so I can't say which vegan dessert sells best. I can suggest a vegan dessert that suits you instead.");
    expect(r.blocks[0]).toMatchObject({ type: "quick_replies", chips: [{ label: "Suggest a vegan dessert", text: "Suggest a vegan dessert" }, { label: "Show me the menu", action: { type: "menu", course: "desserts" } }] });
    expect(step("What is your best seller?", { asked: ["diet"] }).asked).toBeUndefined();
  });
  it("names the dishes staff marked that fit the question, filtered by diet and course", () => {
    const menu = marked("dal-ember", "old-delhi-butter-chicken");
    expect(step("What is your best vegetarian seller?", { prefs: P({ diet: ["vegetarian"] }), menu }).text).toBe("Of the vegetarian dishes, the restaurant marks the Dal Ember as a bestseller.");
    expect(step("What is your best seller?", { menu }).text).toBe("The restaurant marks the Old Delhi Butter Chicken and the Dal Ember as bestsellers.");
    expect(step("What's your most popular dessert?", { menu }).text).toBe("None of the dishes the restaurant marks as bestsellers is a dessert. I can suggest a dessert that suits you instead.");
  });
  it("answers about one dish by name: the mark if set, otherwise that there is no data", () => {
    expect(step("Is the Dal Ember popular?", { menu: marked("dal-ember") }).text).toBe("Yes: the restaurant marks the Dal Ember as a bestseller.");
    expect(step("Is the Chana Pindi popular?").text).toBe("We don't keep sales figures, ratings or reviews, so I can't say how popular the Chana Pindi is. The restaurant hasn't marked it as a bestseller.");
  });
  it("has no reviews or ratings to report", () => {
    expect(step("Which dish has the best reviews?", { asked: ["diet"] }).text).toBe("We don't collect reviews or ratings, so I can't say which dish is rated best. I can suggest a dish that suits you instead.");
  });
  it("asked for evidence after a suggestion: says there is none, and why that dish was suggested", () => {
    expect(step("Do you have actual sales data to support that?", { prefs: P({ diet: ["vegetarian"] }), recommended: ["menu:dal-ember"] }).text).toBe(
      "No, we don't keep sales or popularity figures, ratings or reviews. I suggested the Dal Ember because it fits what you asked for (vegetarian dishes).",
    );
    expect(step("How do you know?", { recommended: ["menu:dal-ember"], lastReply: "Guests love the Dal Ember." }).text).toBe("No, we don't keep sales or popularity figures, ratings or reviews. I suggested the Dal Ember from its menu description, not from popularity.");
    // FM-023: with no popularity said, "how do you know?" is an ordinary question for the model.
    expect(evidenceQuestion("How do you know?", true, [], "I'd suggest the Dal Ember: black lentils slow-cooked overnight.")).toBeNull();
    // A marked dish: the mark is said first.
    expect(step("Is that a bestseller?", { recommended: ["menu:dal-ember"], menu: marked("dal-ember") }).text).toBe("The restaurant marks the Dal Ember as a bestseller; beyond that we don't keep sales figures, ratings or reviews.");
  });
});

describe("review of D-26", () => {
  it("doesn't take busy times, branches, kids' ratings or hours challenges for popularity questions", () => {
    const names = entries.map((e) => e.name);
    for (const t of ["Is Saturday a popular time to come?", "Is Hauz Khas popular?", "Is the terrace rated for kids?", "What's your most popular time?", "How do you know you're open on Sunday?"]) expect(evidenceQuestion(t, true, names), t).toBeNull();
    expect(evidenceQuestion("How do you know?", false, names)).toBeNull(); // nothing suggested yet
    expect(evidenceQuestion("Is the Dal Ember popular?", false, names)).toBe("sales");
    expect(evidenceQuestion("Is the butter chicken popular?", false, names)).toBe("sales");
  });
  it("a named marked dish is offered only if available, served here and right for the guest; a review question never gets a yes", () => {
    const menu = marked("dal-ember", "tandoori-pomfret");
    expect(step("Is the Tandoori Pomfret popular?", { menu }).text).toBe("Yes: the restaurant marks the Tandoori Pomfret as a bestseller, but it's currently unavailable.");
    expect(step("Is the Dal Ember popular?", { menu, prefs: P({ avoid: ["dairy"], allergy: true }), asked: ["diet"] }).text).toBe("Yes: the restaurant marks the Dal Ember as a bestseller, but it doesn't suit you: contains dairy.");
    expect(step("How are the reviews for the Dal Ember dish?", { menu }).text).toBe("We don't collect reviews or ratings. The restaurant does mark the Dal Ember as a bestseller.");
  });
  it("allergies apply: an unlisted allergen goes to staff, and the note shows", () => {
    expect(step("What is your best seller?", { prefs: P({ allergy: true, unlisted: ["sesame"] }) }).text).toMatch(/can't suggest a dish around your allergy/);
    expect(step("What is your best seller?", { prefs: P({ avoid: ["nuts"], allergy: true }), menu: marked("dal-ember") }).blocks[0]).toMatchObject({ type: "notice" });
  });
  it("says which need ruled the marked dishes out", () => {
    expect(step("What's your bestseller under ₹300?", { prefs: P({ maxPrice: 300 }), menu: marked("dal-ember") }).text).toMatch(/^None of the dishes the restaurant marks as bestsellers fits what you asked for \(dishes, up to ₹300\)\./);
  });
});

describe("failure-mode audit FM-001/FM-023", () => {
  const names = () => entries.map((e) => e.name);
  it("FM-023: star anise, spice and hygiene ratings are not review questions; a dish question with a diet word is not a challenge", () => {
    for (const t of ["Which dishes have star anise?", "What's the spice rating of the Chicken Chettinad?", "What's your hygiene rating?", "Is that true that the dal is vegan?"]) expect(evidenceQuestion(t, true, names(), "Guests love it."), t).toBeNull();
    expect(evidenceQuestion("Which dish has the best reviews?", false, names())).toBe("reviews");
  });
  it("FM-001: chef's special, speciality and 'famous for' get an honest answer, not a dish presented as the answer", () => {
    for (const t of ["What's the chef's special today?", "What's your speciality?", "What are you famous for?", "What do your regulars order?"]) {
      expect(evidenceQuestion(t, false, names()), t).toBe("sales");
      const r = step(t, { asked: ["diet"] });
      expect(r.blocks.some((b) => b.type === "recommendation"), t).toBe(false);
    }
    expect(step("What's the chef's special today?", { asked: ["diet"] }).text).toMatch(/^The menu doesn't name a chef's special or a signature dish/);
  });
});

