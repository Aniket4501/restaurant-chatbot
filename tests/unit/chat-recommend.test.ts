import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { loadFactSource, renderKbFacts, renderStaticFacts, type Fact } from "@/lib/kb/facts";
import { describePrefs, eligible, menuEntries, menuStep, unmet, type MenuEntry } from "@/lib/chat/menu";
import { claimProblems, explicitPrefs, recommendTurn, resolvePrefs, shortlist, suitabilityClaim, validateChoice, type ChooserCall } from "@/lib/chat/recommend";
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
    expect(ok({ pick: "menu:dal-ember", reply: "Dal Ember at ₹445 is vegan and rich." }, P({ diet: ["vegetarian"], maxPrice: 500 }))).toContain("Dal Ember is not vegan");
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
  it("offers answers to a clarifying question as chips (user report: only 'Show me the menu' was offered)", async () => {
    const { res } = await run(recTurn({}), [{ pick: null, alternatives: [], reply: "Would you like something light or more filling?" }], { text: "Help me find a dish" });
    expect(res.text).toBe("Would you like something light or more filling?");
    // D-24: food chips are actions (no intent call), each carrying the same fixed text.
    const rec = (label: string) => ({ label, action: { type: "recommend", text: label } });
    expect(res.blocks).toEqual([{ type: "quick_replies", chips: [rec("Something light"), rec("Something filling"), rec("Something vegetarian"), rec("Surprise me"), { label: "Show me the menu", action: { type: "menu", course: null } }] }]);
  });
  it("answers an impossible request honestly, with no model call", async () => {
    const { res, calls } = await run(recTurn({ diet: ["vegan"], course: "mains", maxPrice: 200 }), [], { text: "Show me a vegan main course under ₹200" });
    expect(calls).toEqual([]);
    expect(res.text).toBe("We don't have any vegan main courses, up to ₹200 on the menu. Tap one to widen the search.");
    // Each chip's words lift its constraint in code (D-21 audit: "yes" to "want me to relax one?" changed nothing).
    const chips = (res.blocks.find((b) => b.type === "quick_replies") as { chips: { label: string; action?: { type: string; text?: string } }[] }).chips;
    expect(chips.map((c) => c.label)).toEqual(["Any price", "Not only vegan", "Show me the menu"]);
    const lifted = resolvePrefs(null, res.prefs, chips[0].action!.text!).prefs; // D-24: the text rides in the action
    expect(lifted.maxPrice).toBeNull();
    expect(resolvePrefs(null, res.prefs, chips[1].action!.text!).prefs.diet).toEqual([]);
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
  it("keeps 'cheaper' in the last suggestion's section when the guest named none", async () => {
    const seen: string[][] = [];
    const call: ChooserCall = async (_a, messages) => {
      seen.push([...messages[1].content.matchAll(/^([a-z0-9-]+) \|/gm)].map((m) => m[1]));
      return { choice: null, code: "MODEL_UNAVAILABLE", content: "" };
    };
    const ctx = { lastCitedIds: [], prefs: P({}), recommended: ["menu:mushroom-galouti"] };
    await recommendTurn({ turn: recTurn({ relation: "cheaper" }), text: "Anything cheaper?", history: [], context: ctx, entries, restaurant: "Neem & Ember", grounding, trace: [] }, call);
    expect(seen[0].length).toBeGreaterThan(0);
    for (const slug of seen[0]) expect(e(`menu:${slug}`).course, slug).toBe("small-plates");
    for (const slug of seen[0]) expect(e(`menu:${slug}`).price, slug).toBeLessThan(e("menu:mushroom-galouti").price);
    // Nothing cheaper in the section: said plainly, with no bread or dessert offered instead (user walkthrough).
    const cheapest = await recommendTurn({ turn: recTurn({ relation: "cheaper" }), text: "Anything cheaper?", history: [], context: { ...ctx, recommended: ["menu:kale-pakoda"] }, entries, restaurant: "Neem & Ember", grounding, trace: [] }, call);
    expect(cheapest.text).toBe("The Kale Pakoda (₹295) is already the cheapest of the small plates we have.");
    expect(cheapest.blocks.some((b) => b.type === "recommendation")).toBe(false);
  });
  it("looks in other sections for 'another' once the last suggestion's section is used up", async () => {
    const seen: string[][] = [];
    const call: ChooserCall = async (_a, messages) => {
      seen.push([...messages[1].content.matchAll(/^([a-z0-9-]+) \|/gm)].map((m) => m[1]));
      return { choice: null, code: "MODEL_UNAVAILABLE", content: "" };
    };
    const desserts = eligible(entries, P({ course: "desserts" })).map((d) => d.id);
    await recommendTurn({ turn: recTurn({ relation: "another" }), text: "Show me another option", history: [], context: { lastCitedIds: [], prefs: P({}), recommended: desserts.slice(0, 6) }, entries, restaurant: "Neem & Ember", grounding, trace: [] }, call);
    expect(seen[0].some((slug) => e(`menu:${slug}`).course !== "desserts")).toBe(true);
  });
  it("always adds the allergy note when an allergy or allergen is in play", async () => {
    const { res } = await run(recTurn({ avoid: ["nuts"], allergy: true, course: "desserts" }), [{ pick: "menu:mango-sorbet", alternatives: [], reply: "The Mango Sorbet at ₹245 is a safe bet for dessert." }], { text: "I have a nut allergy, which dessert?" });
    expect(res.blocks.find((b) => b.type === "notice")).toMatchObject({ text: expect.stringContaining("can't guarantee") });
    // "a safe bet" is a safety promise (review): the wording is rejected and the valid pick shown with a plain line.
    expect(res.text).toBe("I'd suggest the Mango Sorbet (₹245).");
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

describe("shortlist: which dishes the chooser reads (latency), never the answer", () => {
  it("keeps every dish when few fit", () => {
    const fit = eligible(entries, P({ diet: ["vegan"], course: "desserts" }));
    expect(shortlist(fit, [])).toEqual(fit);
  });
  it("puts the dishes retrieval found first, then up to three per course, at most 18", () => {
    const fit = eligible(entries, P({}));
    const s = shortlist(fit, ["menu:dal-ember", "faq:pets", "menu:mango-sorbet"]);
    expect(s).toHaveLength(18);
    expect(s.slice(0, 2).map((d) => d.id)).toEqual(["menu:dal-ember", "menu:mango-sorbet"]);
    const courses = new Set(s.map((d) => d.course));
    expect(courses.size).toBe(6); // every section is represented
    for (const c of courses) expect(s.filter((d) => d.course === c).length).toBeLessThanOrEqual(4);
  });
});


// ---------- D-20 review (docs/research/2026-10-20-d20-review.json): each scenario that slipped through ----------

describe("review: preferences read from the guest's words", () => {
  it.each([
    ["I'm not vegetarian, what's a good meat main?", { diet: undefined }],
    ["I'm not vegan", { diet: undefined }],
    ["nothing mild please, I like heat", { mild: undefined }],
    ["I'm veg, any mains?", { diet: ["vegetarian"] }],
    ["something for vegetarians", { diet: ["vegetarian"] }],
    ["I have a groundnut allergy", { allergy: true, avoid: ["nuts"] }],
    ["allergic to walnuts", { allergy: true, avoid: ["nuts"] }],
    ["I'm lactose intolerant", { avoid: ["dairy"] }],
    ["I'm allergic to gluten", { diet: ["gluten-free"] }],
    ["I can't eat gluten", { diet: ["gluten-free"] }],
    ["I love nuts, what's good?", { avoid: undefined }],
    ["a table for 6, something under 4 people", { maxPrice: undefined }],
    ["anything under 30 minutes for a party of 12?", { maxPrice: undefined }],
    ["something under ₹400 for 3 people", { maxPrice: 400 }],
  ])("%s", (text, want) => {
    const ex = explicitPrefs(text);
    for (const [k, v] of Object.entries(want)) expect(ex[k as keyof typeof ex], k).toEqual(v);
  });
  it("names an allergy the menu labels can't cover", () => {
    expect(explicitPrefs("I'm allergic to shellfish").unlisted).toEqual(["shellfish"]);
    expect(explicitPrefs("I have a soy allergy").unlisted).toEqual(["soy"]);
    expect(explicitPrefs("I'm allergic to kiwi").unlisted).toEqual(["other"]);
    expect(explicitPrefs("I have a severe peanut allergy").unlisted).toBeUndefined();
    expect(explicitPrefs("I'm allergic to nuts").unlisted).toBeUndefined();
  });
  it("reads the follow-up chips' texts as 'cheaper' and 'another'", () => {
    expect(explicitPrefs("Anything cheaper?").relation).toBe("cheaper");
    expect(explicitPrefs("Show me another option").relation).toBe("another");
  });
});

describe("review: constraints stay in force until the guest lifts them", () => {
  const model = (o: Partial<NonNullable<Turn["prefs"]>>): Turn["prefs"] => ({ diet: [], avoid: [], maxPrice: null, course: null, mild: false, allergy: false, relation: null, ...o });
  it("keeps an allergy and its allergen when the model's follow-up prefs drop them", () => {
    const r = resolvePrefs(model({ course: "mains", relation: "another" }), P({ avoid: ["nuts"], allergy: true, course: "mains" }), "Show me another option");
    expect(r.prefs).toMatchObject({ avoid: ["nuts"], allergy: true, course: "mains" });
  });
  it("keeps the diet and budget on a change of course, and lets the guest lift them", () => {
    expect(resolvePrefs(model({ course: "desserts" }), P({ diet: ["vegetarian"], maxPrice: 400 }), "Actually, suggest a dessert instead").prefs).toMatchObject({ diet: ["vegetarian"], maxPrice: 400, course: "desserts" });
    expect(resolvePrefs(model({ course: "mains" }), P({ diet: ["vegetarian"] }), "I'm not vegetarian actually, any meat main?").prefs.diet).toEqual([]);
    expect(resolvePrefs(model({}), P({ maxPrice: 400 }), "price doesn't matter, surprise me").prefs.maxPrice).toBeNull();
  });
  it("drops constraints the model invented ('light' is not 'mild'; no number, no budget)", () => {
    const r = resolvePrefs(model({ mild: true, maxPrice: 400 }), null, "I want something light, not too expensive");
    expect(r.prefs).toMatchObject({ mild: false, maxPrice: null });
  });
});

describe("review: claims in the reply are checked against the dish they are about", () => {
  const v = (c: Partial<Choice>, prefs = P({ course: "desserts" })) =>
    validateChoice({ pick: "menu:chocolate-chilli-mousse", alternatives: [], reply: "Try the Chocolate Chilli Mousse at ₹345.", ...c }, eligible(entries, prefs), byId(), prefs, grounding).reasons;
  it("a vegan claim about the pick fails even when an alternative is vegan", () => {
    expect(v({ alternatives: ["menu:mango-sorbet"], reply: "The Chocolate Chilli Mousse at ₹345 is a rich vegan treat. If you want something lighter, try the Mango Sorbet at ₹245." })).toContain("Chocolate Chilli Mousse is not vegan");
    expect(v({ pick: "menu:mango-sorbet", reply: "The Mango Sorbet at ₹245 is vegan and light." })).toEqual([]);
  });
  it("a negation elsewhere in the sentence doesn't hide a false claim, and an honest negation passes", () => {
    expect(v({ reply: "The Chocolate Chilli Mousse at ₹345 is vegan and not too heavy." })).toContain("Chocolate Chilli Mousse is not vegan");
    expect(v({ reply: "The Chocolate Chilli Mousse at ₹345 isn't vegan, but it's rich and dark." })).toEqual([]);
  });
  it("rejects allergen-absence and safety wording", () => {
    for (const reply of ["The Mango Sorbet at ₹245 contains no nuts, so it's safe for you.", "The Mango Sorbet at ₹245 is a safe bet.", "The Mango Sorbet at ₹245 is allergy-friendly."])
      expect(v({ pick: "menu:mango-sorbet", reply }), reply).not.toEqual([]);
    expect(v({ reply: "The Chocolate Chilli Mousse at ₹345 has no dairy." })).toContain("Chocolate Chilli Mousse is not vegan (the only dishes known to have no dairy or egg)");
  });
  it("a clarifying question can't carry claims or dishes", () => {
    expect(v({ pick: null, reply: "Would you like something light or more filling?" })).toEqual([]);
    expect(v({ pick: null, reply: "Our desserts are all vegan, would you like one?" })).not.toEqual([]);
    expect(v({ pick: null, reply: "Our most popular dessert is light, would you like it?" })).not.toEqual([]);
    expect(v({ pick: null, reply: "Would the Mango Sorbet suit you?" })).not.toEqual([]);
  });
  it("knows a dish by the last two words of its name, as the model writes it (live: 'Pistachio Kulfi')", () => {
    const reply = "The Coconut Jaggery Payasam at ₹265 is warm. For something richer, try the Pistachio Kulfi at ₹275, or the Mango Sorbet at ₹245.";
    expect(v({ pick: "menu:coconut-jaggery-payasam", alternatives: ["menu:pistachio-kulfi", "menu:mango-sorbet"], reply })).toEqual([]);
    expect(v({ pick: "menu:pistachio-kulfi", reply: "The Pistachio Kulfi at ₹275 is creamy." })).toEqual([]);
  });
  it("pairs every price with the dish named before it", () => {
    expect(v({ alternatives: ["menu:mango-sorbet"], reply: "The Chocolate Chilli Mousse is rich. The Mango Sorbet is ₹345." })).toContain("the reply gives Mango Sorbet the wrong price (₹345)");
  });
  it("rejects a dish named in the reply that isn't on the card", () => {
    expect(v({ reply: "The Chocolate Chilli Mousse at ₹345, or the Shahi Tukda." })).toContain("the reply names Shahi Tukda, which is not on the card");
  });
  it("rejects a number that is not on the menu (the grounding check)", () => {
    expect(v({ pick: "menu:mango-sorbet", reply: "The Mango Sorbet at ₹245 serves two." })).toEqual(["the reply has an unsupported detail (two)"]);
    expect(v({ pick: "menu:mango-sorbet", reply: "The Mango Sorbet at ₹245 takes 5 minutes." })).toEqual(["the reply has an unsupported detail (5)"]);
    expect(v({ pick: "menu:mango-sorbet", reply: "The Mango Sorbet at ₹245 is light and fruity." })).toEqual([]);
  });
  it("rejects extra hype wording and a reply cut off by the length limit", () => {
    expect(v({ reply: "The Chocolate Chilli Mousse at ₹345 is our speciality." })).toContain('"speciality" is not supported by the menu');
    expect(v({ reply: `The Chocolate Chilli Mousse at ₹345 ${"is rich ".repeat(48)}` })).toContain("the reply is cut off");
  });
});

describe("review: what recommendTurn does with these", () => {
  const run = async (turn: Turn, replies: Choice[], text: string, context: { prefs?: Prefs | null; recommended?: string[] } = {}) => {
    const call: ChooserCall = async () => {
      const r = replies.shift();
      return r ? { choice: r, code: "ok", content: JSON.stringify(r) } : { choice: null, code: "MODEL_UNAVAILABLE", content: "" };
    };
    return recommendTurn({ turn, text, history: [], context: { lastCitedIds: [], ...context }, entries, restaurant: "Neem & Ember", grounding, trace: [] }, call);
  };
  it("an allergy the labels can't cover stops the recommendation and sends the guest to staff", async () => {
    const res = await run(recTurn({ allergy: true }), [{ pick: "menu:amritsari-fish-fry", alternatives: [], reply: "Amritsari Fish Fry at ₹545." }], "I'm allergic to shellfish, what do you recommend?");
    expect(res.blocks.some((b) => b.type === "recommendation")).toBe(false);
    expect(res.text).toMatch(/shellfish/);
    expect(res.blocks.find((b) => b.type === "notice")).toBeTruthy();
  });
  it("the fallback shows dishes retrieval found first, not the first in the menu", async () => {
    const turn = recTurn({});
    const call: ChooserCall = async () => ({ choice: null, code: "MODEL_UNAVAILABLE", content: "" });
    const res = await recommendTurn({ turn, text: "anything with black lentils?", history: [], context: { lastCitedIds: [] }, entries, restaurant: "Neem & Ember", grounding, trace: [], relevant: ["menu:dal-ember"] }, call);
    expect((res.blocks[0] as { items: { id: string }[] }).items[0].id).toBe("menu:dal-ember");
  });
  it("'cheaper' with nothing cheaper says the last suggestion is already the cheapest", async () => {
    const res = await run(recTurn({ course: "desserts", relation: "cheaper" }), [], "Anything cheaper?", { prefs: P({ course: "desserts" }), recommended: ["menu:mango-sorbet"] });
    expect(res.text).toBe("The Mango Sorbet (₹245) is already the cheapest of the desserts we have.");
  });
});

describe("FAQ claim checks (D-21 after-run)", () => {
  it("accepts a negated safety statement and rejects a promise", () => {
    expect(claimProblems("No. Our kitchen handles nuts, so we can't guarantee the kitchen is nut-free.", [], entries)).toEqual([]);
    expect(claimProblems("Yes, the Mango Sorbet is safe for a nut allergy.", [e("menu:mango-sorbet")], entries)).toContain("promises allergen safety");
  });
  it("rejects an attribute no cited fact states ('halal'), and accepts one that a fact states", () => {
    expect(claimProblems("No. Our chicken dishes are not halal.", [e("menu:chicken-chettinad")], entries, "Chicken Chettinad: Fiery Tamil chicken curry")).toEqual(['"halal" is not in the facts']);
    expect(claimProblems("Yes, our chicken is halal.", [], entries, "All our meat is halal certified.")).toEqual([]);
  });
  it("rejects an ingredient the dish's description doesn't have, and a diet label it doesn't carry", () => {
    expect(claimProblems("Yes. The Chana Pindi is a vegan paneer dish.", [e("menu:chana-pindi")], entries)).toEqual(["Chana Pindi has no paneer in its menu description"]);
    expect(claimProblems("Yes, the Dal Ember is vegan.", [e("menu:dal-ember")], entries)).toEqual(["Dal Ember is not vegan"]);
    expect(claimProblems("The Chana Pindi is a vegan chickpea curry.", [e("menu:chana-pindi")], entries)).toEqual([]);
  });
});

describe("a new constraint on a follow-up (D-21 held-out LV-HOLD-012)", () => {
  it("doesn't exclude earlier suggestions that meet it, even when the model calls it 'another'", async () => {
    const seen: string[][] = [];
    const call: ChooserCall = async (_a, messages) => {
      seen.push([...messages[1].content.matchAll(/^([a-z0-9-]+) \|/gm)].map((m) => m[1]));
      return { choice: null, code: "MODEL_UNAVAILABLE", content: "" };
    };
    const ctx = { lastCitedIds: [], prefs: P({ diet: ["vegetarian"], course: "small-plates" }), recommended: ["menu:dahi-puri-shots", "menu:beetroot-peanut-tikki", "menu:kale-pakoda"] };
    const res = await recommendTurn({ turn: recTurn({ diet: ["vegan"], course: "small-plates", relation: "another" }), text: "make it vegan", history: [], context: ctx, entries, restaurant: "Neem & Ember", grounding, trace: [] }, call);
    expect(seen[0].sort()).toEqual(["beetroot-peanut-tikki", "kale-pakoda"]);
    expect(res.blocks.some((b) => b.type === "recommendation")).toBe(true);
  });
});


describe("D-24 audit: safety wording, allergen lists, attributes, sides and the chooser's rules", () => {
  it("rejects suitability wording paired with an allergy, the phrasings live replies used, but not a negated sentence", () => {
    for (const s of ["The Coconut Jaggery Payasam at ₹265 is vegan, making it a good option for your severe peanut allergy.", "As a coeliac guest, you can have the Mango Sorbet.", "It's ideal for someone with a nut allergy.", "This one fits your allergy needs."]) expect(suitabilityClaim(s), s).toBe(true);
    for (const s of ["The Mango Sorbet is an Alphonso mango sorbet.", "I can't say whether it suits your allergy; please tell your server.", "Please tell your server about your allergy.", "A good choice for a light dessert."]) expect(suitabilityClaim(s), s).toBe(false);
    expect(claimProblems("As a coeliac guest, you can have the Mango Sorbet.", [], entries)).toContain("promises allergen safety");
    const prefs = P({ avoid: ["nuts"], allergy: true, course: "desserts" });
    const v = validateChoice({ pick: "menu:coconut-jaggery-payasam", alternatives: [], reply: "The Coconut Jaggery Payasam at ₹265 is a rice pudding, making it a good option for your severe peanut allergy." }, eligible(entries, prefs), byId(), prefs, grounding);
    expect(v.reasons.join("; ")).toMatch(/allerg/);
  });
  it("reads every allergen in 'allergic to X and Y', so labelled ones never become an unknown allergen", () => {
    expect(explicitPrefs("I'm allergic to nuts and dairy. Which dessert can I have?")).toMatchObject({ allergy: true, avoid: ["nuts", "dairy"] });
    expect(explicitPrefs("I'm allergic to nuts and dairy. Which dessert can I have?").unlisted).toBeUndefined();
    expect(explicitPrefs("allergic to peanuts and eggs").unlisted).toBeUndefined();
    expect(explicitPrefs("allergic to milk, eggs or cashews so what can I eat").unlisted).toBeUndefined();
    expect(explicitPrefs("I'm allergic to kiwi and nuts").unlisted).toEqual(["other"]); // kiwi has no label
    expect(explicitPrefs("allergic to tree nuts").unlisted).toBeUndefined();
  });
  it("rejects an attribute the menu never states on a dish card (sugar-free, halal)", () => {
    const prefs = P({ course: "desserts" });
    const v = validateChoice({ pick: "menu:mango-sorbet", alternatives: [], reply: "The Mango Sorbet at ₹245 is sugar-free, so it suits a diabetic diet." }, eligible(entries, prefs), byId(), prefs, grounding);
    expect(v.reasons).toContain('"sugar-free" is not supported by the menu');
  });
  it("must pick when the guest asked for a choice; a question may name a diet or say 'which one'", () => {
    const prefs = P({});
    const fit = eligible(entries, prefs);
    const q = { pick: null, alternatives: [], reply: "Would you like something vegetarian or non-vegetarian? Which one sounds better?" };
    expect(validateChoice(q, fit, byId(), prefs, grounding).reasons).toEqual([]);
    expect(validateChoice(q, fit, byId(), prefs, grounding, { mustPick: true }).reasons).toContain("the guest asked you to choose, so pick one dish from the list instead of asking");
  });
  it("may name the dish a 'cheaper' request compares with, but no other dish off the card", () => {
    const prefs = P({ diet: ["vegetarian"], course: "mains" });
    const fit = eligible(entries, prefs, { cheaperThan: 445 });
    const reply = { pick: "menu:chana-pindi", alternatives: [], reply: "Cheaper than the Dal Ember, the Chana Pindi at ₹395 is a tangy chickpea curry." };
    expect(validateChoice(reply, fit, byId(), prefs, grounding).reasons.join("; ")).toMatch(/names Dal Ember/);
    expect(validateChoice(reply, fit, byId(), prefs, grounding, { mayName: ["menu:dal-ember"] }).reasons).toEqual([]);
  });
  it("doesn't offer sides or drinks for a dish request unless asked; a request for a drink still gets drinks", async () => {
    const seen: string[][] = [];
    const call: ChooserCall = async (_a, messages) => {
      seen.push(entries.filter((d) => messages[1].content.includes(`${d.id.slice(5)} |`) || messages[1].content.includes(d.name)).map((d) => d.course));
      return { choice: null, code: "MODEL_UNAVAILABLE", content: "" };
    };
    const go = (text: string, prefs: Partial<NonNullable<Turn["prefs"]>> = {}) => recommendTurn({ turn: recTurn(prefs), text, history: [], context: { lastCitedIds: [] }, entries, restaurant: "Neem & Ember", grounding, trace: [] }, call);
    await go("I want something light.", { mild: true });
    expect(seen[0].length).toBeGreaterThan(0);
    expect(seen[0].some((c) => c === "drinks")).toBe(false);
    await go("Something refreshing to drink?", { course: "drinks" });
    expect(seen[1].every((c) => c === "drinks")).toBe(true);
  });
});
