import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { loadFactSource, renderKbFacts, renderStaticFacts, type Fact } from "@/lib/kb/facts";
import { describePrefs, eligible, menuEntries, menuStep, unmet, type MenuEntry } from "@/lib/chat/menu";
import { explicitPrefs, recommendTurn, resolvePrefs, validateChoice, type ChooserCall } from "@/lib/chat/recommend";
import { noPrefs, type Prefs, type TraceEntry } from "@/lib/chat/types";
import type { Choice } from "@/lib/llm/chooser";
import type { GroundingContext } from "@/lib/chat/grounding";
import { nullBooking } from "@/lib/llm/fake";
import type { Turn } from "@/lib/llm/schema";

// D-20: the model chooses, code validates. These tests pin the deterministic half: eligibility (filtering, never
// ranking), the constraints read from the guest's own words, the validation of a proposed choice, and the honest
// fallbacks. The fixture menu is evals/fixtures/base.json (Fri 16 Oct 2026).
const ROOT = path.resolve(__dirname, "../..");
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
let entries: MenuEntry[];
let grounding: GroundingContext;
beforeAll(() => {
  const db = openDb(":memory:");
  migrate(db, NOW);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now: NOW });
  const src = loadFactSource(db);
  entries = menuEntries(src);
  const facts: Fact[] = [...renderStaticFacts(src, NOW), ...renderKbFacts(src)];
  grounding = { factsById: new Map(facts.map((f) => [f.id, f])), sentIds: new Set(), zoneOf: () => "Asia/Kolkata" };
});
const P = (o: Partial<Prefs>): Prefs => ({ ...noPrefs(), ...o });
const byId = () => new Map(entries.map((e) => [e.id, e]));
const e = (id: string) => byId().get(id)!;
const recTurn = (prefs: Partial<NonNullable<Turn["prefs"]>> | null): Turn => ({ intent: "recommend", booking: nullBooking(), prefs: prefs ? { diet: [], avoid: [], maxPrice: null, course: null, mild: false, allergy: false, relation: null, ...prefs } : null, answer: null, citedFactIds: [], answerable: true });

describe("eligibility: verified data only, no ranking", () => {
  it("applies each constraint to the labels, allergens, price, course, spice and availability", () => {
    expect(unmet(e("menu:yellow-dal-tadka"), P({ diet: ["vegetarian"] }))).toBeNull(); // vegan counts as vegetarian
    expect(unmet(e("menu:dal-ember"), P({ diet: ["vegan"] }))).toBe("not vegan");
    expect(unmet(e("menu:pistachio-kulfi"), P({ avoid: ["nuts"] }))).toBe("contains nuts");
    expect(unmet(e("menu:old-delhi-butter-chicken"), P({ maxPrice: 400 }))).toBe("over ₹400");
    expect(unmet(e("menu:mango-sorbet"), P({ course: "mains" }))).toBe("not one of the main courses");
    expect(unmet(e("menu:tandoori-pomfret"), P({}))).toBe("unavailable");
    expect(unmet(e("menu:yellow-dal-tadka"), P({ diet: ["jain"] }))).toBeNull();
  });
  it("finds the vegan desserts, and nothing for a vegan main under ₹200", () => {
    expect(eligible(entries, P({ diet: ["vegan"], course: "desserts" })).map((d) => d.id)).toEqual(["menu:coconut-jaggery-payasam", "menu:mango-sorbet"]);
    expect(eligible(entries, P({ diet: ["vegan"], course: "mains", maxPrice: 200 }))).toEqual([]);
    expect(describePrefs(P({ diet: ["vegan"], course: "mains", maxPrice: 200 }))).toBe("vegan main courses, up to ₹200");
  });
  it("leaves out dishes already suggested, and anything not cheaper than the last one when asked", () => {
    const fit = eligible(entries, P({ course: "desserts" }), { exclude: ["menu:mango-sorbet"], cheaperThan: 280 });
    expect(fit.map((d) => d.id)).toEqual(["menu:pistachio-kulfi", "menu:coconut-jaggery-payasam"]);
  });
});

describe("constraints the guest's own words state for certain", () => {
  it.each([
    ["What's the best vegetarian option under ₹400?", { diet: ["vegetarian"], maxPrice: 400 }],
    ["something vegan, not too spicy, below 300", { diet: ["vegan"], mild: true, maxPrice: 300 }],
    ["I'm allergic to peanuts, what can I have?", { allergy: true, avoid: ["nuts"] }],
    ["any gluten free desserts? budget 350", { diet: ["gluten-free"], maxPrice: 350 }],
    ["do you do vegan chicken?", { diet: ["vegan"] }],
  ])("%s", (text, want) => expect(explicitPrefs(text)).toMatchObject(want));
  it("does not read 'non-veg' or a bare number as a constraint", () => {
    expect(explicitPrefs("something non-vegetarian and filling")).toEqual({});
    expect(explicitPrefs("a table for 4 and something light")).toEqual({});
  });
  it("keeps the model's active preferences, falls back to the previous ones, and adds stated constraints it dropped", () => {
    expect(resolvePrefs(null, P({ diet: ["vegetarian"], maxPrice: 400 }), "anything else?").prefs).toEqual(P({ diet: ["vegetarian"], maxPrice: 400 }));
    const r = resolvePrefs({ diet: [], avoid: [], maxPrice: null, course: "desserts", mild: false, allergy: false, relation: null }, P({ diet: ["vegetarian"] }), "a vegetarian dessert under 300 please");
    expect(r.prefs).toEqual(P({ diet: ["vegetarian"], course: "desserts", maxPrice: 300 }));
    expect(r.added).toEqual(["vegetarian", "up to ₹300"]);
  });
});

describe("validating the model's choice", () => {
  const ok = (c: Partial<Choice>, prefs = P({ diet: ["vegetarian"], maxPrice: 400 })) => {
    const fit = eligible(entries, prefs);
    return validateChoice({ pick: "menu:yellow-dal-tadka", alternatives: [], reply: "Try the Yellow Dal Tadka at ₹375: lentils tempered with cumin.", ...c }, fit, byId(), prefs, grounding).reasons;
  };
  it("accepts a dish that fits, named with its real price", () => expect(ok({})).toEqual([]));
  it("rejects an invented dish, one that breaks a constraint, and one that is unavailable", () => {
    expect(ok({ pick: "menu:truffle-risotto" })).toEqual(['"menu:truffle-risotto" is not one of the listed IDs']);
    // A slug without the "menu:" prefix (how the chooser lists dishes) is the same dish.
    expect(ok({ pick: "yellow-dal-tadka" })).toEqual([]);
    expect(ok({ pick: "menu:old-delhi-butter-chicken", reply: "Old Delhi Butter Chicken at ₹645." })).toEqual(["Old Delhi Butter Chicken not vegetarian"]);
    expect(ok({ pick: "menu:tandoori-pomfret", reply: "Tandoori Pomfret." }, P({}))).toEqual(["Tandoori Pomfret unavailable"]);
  });
  it("rejects a reply that names another dish, invents a price, or talks about bookings", () => {
    expect(ok({ reply: "You'll love it, it's light and comforting." })).toContain("the reply must name Yellow Dal Tadka");
    expect(ok({ reply: "Try the Yellow Dal Tadka at ₹350." })[0]).toMatch(/price that is not on the menu/);
    expect(ok({ reply: "The Yellow Dal Tadka at ₹375. We have a table for you tonight." })).toContain("the reply must not talk about tables or bookings");
  });
  it("rejects invented popularity, allergen promises and diet claims no dish shown has", () => {
    expect(ok({ reply: "Our most popular dish, the Yellow Dal Tadka at ₹375." })).toContain('"most popular" is not supported by the menu');
    expect(ok({ reply: "The Yellow Dal Tadka at ₹375 is nut-free." })).toContain("the reply must not promise allergen safety");
    expect(ok({ pick: "menu:dal-ember", reply: "Dal Ember at ₹445 is vegan and rich." }, P({ diet: ["vegetarian"], maxPrice: 500 }))).toContain("no dish shown is vegan");
    expect(ok({ pick: "menu:dal-ember", reply: "Dal Ember at ₹445 isn't vegan, but it is rich and smoky." }, P({ diet: ["vegetarian"], maxPrice: 500 }))).toEqual([]);
  });
  it("accepts a short clarifying question without a dish, and nothing else without one", () => {
    expect(ok({ pick: null, reply: "Would you like something light or more filling?" })).toEqual([]);
    expect(ok({ pick: null, reply: "Here is a great dish." })).toHaveLength(1);
  });
  it("drops alternatives that don't fit instead of failing the whole choice", () => {
    const prefs = P({ diet: ["vegetarian"], maxPrice: 400 });
    const v = validateChoice({ pick: "menu:yellow-dal-tadka", alternatives: ["menu:old-delhi-butter-chicken", "menu:chana-pindi"], reply: "Yellow Dal Tadka at ₹375, or Chana Pindi at ₹395." }, eligible(entries, prefs), byId(), prefs, grounding);
    expect(v).toEqual({ reasons: [], alternatives: ["menu:chana-pindi"], pick: "menu:yellow-dal-tadka" });
  });
});

describe("recommendTurn: the full turn after the first model call", () => {
  const run = async (turn: Turn, replies: (Choice | "invalid" | "down")[], o: { text?: string; context?: { prefs?: Prefs | null; recommended?: string[] } } = {}) => {
    const calls: number[] = [];
    const call: ChooserCall = async (attempt) => {
      calls.push(attempt);
      const r = replies.shift();
      if (r === "down") return { choice: null, code: "MODEL_UNAVAILABLE", content: "" };
      if (r === "invalid" || !r) return { choice: null, code: "MODEL_INVALID_OUTPUT", content: "oops" };
      return { choice: r, code: "ok", content: JSON.stringify(r) };
    };
    const trace: TraceEntry[] = [];
    const res = await recommendTurn({ turn, text: o.text ?? "What's the best vegetarian option under ₹400?", history: [], context: { lastCitedIds: [], ...o.context }, entries, restaurant: "Neem & Ember", grounding, trace }, call);
    return { res, calls, trace };
  };
  const veg400 = recTurn({ diet: ["vegetarian"], maxPrice: 400 });

  it("shows the model's valid choice as a card from the menu table, with follow-ups, and remembers it", async () => {
    const { res, calls } = await run(veg400, [{ pick: "menu:yellow-dal-tadka", alternatives: ["menu:chana-pindi"], reply: "I'd go for the Yellow Dal Tadka at ₹375; it's gentle and comforting. For something tangier, try the Chana Pindi at ₹395." }]);
    expect(calls).toEqual([1]);
    expect(res.text).toMatch(/^I'd go for the Yellow Dal Tadka/);
    expect(res.blocks[0]).toMatchObject({ type: "recommendation", lead: true, items: [{ id: "menu:yellow-dal-tadka", price: 375, labels: ["Vegan", "Gluten-free", "Jain option"] }, { id: "menu:chana-pindi" }] });
    expect(res.blocks.at(-1)).toMatchObject({ type: "quick_replies" });
    expect(res.recommended).toEqual(["menu:yellow-dal-tadka", "menu:chana-pindi"]);
    expect(res.cited).toEqual(["menu:yellow-dal-tadka", "menu:chana-pindi"]);
  });
  it("gives the model one retry with the reasons, then accepts a valid second choice", async () => {
    const { res, calls, trace } = await run(veg400, [{ pick: "menu:old-delhi-butter-chicken", alternatives: [], reply: "Old Delhi Butter Chicken at ₹645." }, { pick: "menu:chana-pindi", alternatives: [], reply: "The Chana Pindi at ₹395 is hearty and tangy." }]);
    expect(calls).toEqual([1, 2]);
    expect(res.blocks[0]).toMatchObject({ type: "recommendation", lead: true, items: [{ id: "menu:chana-pindi" }] });
    expect(trace.filter((t) => t.action === "recommend")).toMatchObject([{ result: "rejected" }, { result: "ok" }]);
  });
  it("after two invalid choices, shows a few dishes that fit without pretending to choose", async () => {
    const bad: Choice = { pick: "menu:truffle-risotto", alternatives: [], reply: "Truffle Risotto at ₹450." };
    const { res } = await run(veg400, [bad, bad]);
    expect(res.text).toBe("Here are a few vegetarian dishes, up to ₹400 to choose from.");
    expect(res.blocks[0]).toMatchObject({ type: "recommendation", lead: false });
    expect((res.blocks[0] as { items: unknown[] }).items).toHaveLength(3);
  });
  it("keeps a valid pick with a plain line when only its wording failed twice", async () => {
    const pickBadWords: Choice = { pick: "menu:chana-pindi", alternatives: [], reply: "Our most popular dish, the Chana Pindi at ₹395." };
    const { res } = await run(veg400, [pickBadWords, pickBadWords]);
    expect(res.text).toBe("I'd suggest the Chana Pindi (₹395).");
    expect(res.blocks[0]).toMatchObject({ type: "recommendation", lead: true, items: [{ id: "menu:chana-pindi" }] });
  });
  it("answers an impossible request honestly, with no model call", async () => {
    const { res, calls } = await run(recTurn({ diet: ["vegan"], course: "mains", maxPrice: 200 }), [], { text: "Show me a vegan main course under ₹200" });
    expect(calls).toEqual([]);
    expect(res.text).toBe("We don't have any vegan main courses, up to ₹200 on the menu. Want me to relax one of those?");
    expect(res.blocks.some((b) => b.type === "recommendation")).toBe(false);
  });
  it("falls back to dishes that fit, without a retry, when the model is down", async () => {
    const { res, calls } = await run(veg400, ["down"]);
    expect(calls).toEqual([1]);
    expect(res.blocks[0]).toMatchObject({ type: "recommendation", lead: false });
  });
  it("understands 'cheaper' and 'another' relative to the last suggestion", async () => {
    const last = { prefs: P({ course: "desserts" }), recommended: ["menu:chocolate-chilli-mousse"] };
    const cheaper = await run(recTurn({ course: "desserts", relation: "cheaper" }), [{ pick: "menu:mango-sorbet", alternatives: [], reply: "The Mango Sorbet at ₹245 is lighter and cheaper." }], { text: "Anything cheaper?", context: last });
    expect(cheaper.res.recommended).toEqual(["menu:mango-sorbet", "menu:chocolate-chilli-mousse"]);
    // Pricier than the last suggestion (₹345): rejected, so the second reply is used.
    const notCheaper = await run(recTurn({ course: "desserts", relation: "cheaper" }), [{ pick: "menu:shahi-tukda", alternatives: [], reply: "Shahi Tukda at ₹295." }, { pick: "menu:shahi-tukda", alternatives: [], reply: "Shahi Tukda at ₹295." }], { text: "Anything cheaper?", context: { ...last, recommended: ["menu:shahi-tukda"] } });
    expect(notCheaper.res.blocks[0]).toMatchObject({ lead: false });
  });
  it("always adds the allergy note when an allergy or allergen is in play", async () => {
    const { res } = await run(recTurn({ avoid: ["nuts"], allergy: true, course: "desserts" }), [{ pick: "menu:mango-sorbet", alternatives: [], reply: "The Mango Sorbet at ₹245 is a safe bet for dessert." }], { text: "I have a nut allergy, which dessert?" });
    expect(res.blocks.find((b) => b.type === "notice")).toMatchObject({ text: expect.stringContaining("can't guarantee") });
  });
});

describe("menu browsing (no model)", () => {
  it("lists the sections when nothing is narrowed, and a section's available dishes otherwise", () => {
    const sections = menuStep(entries, noPrefs(), null);
    expect(sections.text).toBe("Which part of the menu would you like to see?");
    expect(sections.blocks[0]).toMatchObject({ type: "quick_replies" });
    const tandoor = menuStep(entries, noPrefs(), "tandoor");
    expect(tandoor.text).toBe("Here are our tandoor dishes.");
    const ids = (tandoor.blocks[0] as { groups: { items: { id: string }[] }[] }).groups[0].items.map((i) => i.id);
    expect(ids).not.toContain("menu:tandoori-pomfret");
    expect(ids).toContain("menu:achari-soya-chaap");
  });
  it("groups the dishes that fit a diet by course, with no internal wording", () => {
    const vegan = menuStep(entries, P({ diet: ["vegan"] }), null);
    expect(vegan.text).toBe("Here's what we have: vegan dishes.");
    expect(JSON.stringify(vegan)).not.toMatch(/cheapest first|available\)/);
  });
});
