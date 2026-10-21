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
const step = (text: string, o: { prefs?: Prefs; menu?: MenuEntry[]; recommended?: string[]; asked?: ("diet" | "course")[] } = {}) => {
  const trace: TraceEntry[] = [];
  const kind = evidenceQuestion(text);
  if (!kind) throw new Error(`not an evidence question: ${text}`);
  return { ...evidenceStep({ kind, text, prefs: o.prefs ?? P(), entries: o.menu ?? entries, context: { lastCitedIds: [], recommended: o.recommended, asked: o.asked }, branch: null, trace }), trace };
};

describe("which questions ask for evidence", () => {
  it("reads sales, popularity, review and evidence questions, in their usual wordings", () => {
    for (const t of ["What is your best seller?", "What is your best vegetarian seller?", "best-selling dessert?", "Which dish sells the most?", "What's the top selling main?", "What do most people order?", "Is the butter chicken popular?", "What's your most popular dessert?"]) expect(evidenceQuestion(t), t).toBe("sales");
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
    expect(step("How do you know?", { recommended: ["menu:dal-ember"] }).text).toBe("No, we don't keep sales or popularity figures, ratings or reviews. I suggested the Dal Ember because its menu description matched your request.");
  });
});
