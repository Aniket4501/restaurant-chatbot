import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { loadFactSource, type FactSource } from "@/lib/kb/facts";
import { menuEntries, type MenuEntry } from "@/lib/chat/menu";
import { cheapestPlan, planDishes, planTurn, portions, readPlanRequest, validatePlan, type PlanCall } from "@/lib/chat/plan";
import { noPrefs, type Block, type PlanFocus, type Prefs, type TraceEntry } from "@/lib/chat/types";
import type { Plan } from "@/lib/llm/planner";

// D-28 budget meal planning: code reads the party, budget and diet; the model (scripted here) proposes the meal; code
// checks dishes, arithmetic, budget and that there's enough for everyone. Fixture: evals/fixtures/base.json.
const ROOT = path.resolve(__dirname, "../..");
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
let src: FactSource;
let entries: MenuEntry[];
beforeAll(() => {
  const db = openDb(":memory:");
  migrate(db, NOW);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now: NOW });
  src = loadFactSource(db);
  entries = menuEntries(src);
});
const focus = (o: Partial<PlanFocus>): PlanFocus => ({ party: 2, budget: 1000, basis: "total", diet: "vegetarian", subtotal: null, items: [], ...o });
const scripted = (replies: (Plan | "down" | "invalid")[]) => {
  const calls: number[] = [];
  const call: PlanCall = async (attempt) => {
    calls.push(attempt);
    const r = replies.shift();
    if (r === "down") return { plan: null, code: "MODEL_UNAVAILABLE", content: "" };
    if (r === "invalid" || !r) return { plan: null, code: "MODEL_INVALID_OUTPUT", content: "oops" };
    return { plan: r, code: "ok", content: JSON.stringify(r) };
  };
  return { call, calls };
};
const run = async (text: string, replies: (Plan | "down" | "invalid")[], o: { prev?: PlanFocus | null; asked?: boolean; prefs?: Prefs } = {}) => {
  const request = readPlanRequest(text, o.prev ?? null);
  if (!request) throw new Error(`not a plan request: ${text}`);
  const s = scripted(replies);
  const trace: TraceEntry[] = [];
  const res = await planTurn({ request, text, history: [], entries, src, prefs: o.prefs ?? noPrefs(), branch: null, asked: !!o.asked, trace }, s.call);
  const plan = res.blocks.find((b) => b.type === "meal_plan") as Extract<Block, { type: "meal_plan" }> | undefined;
  return { res, plan, calls: s.calls, trace };
};

describe("reading a planning request", () => {
  it("reads the party, a total or per-person budget, and what they eat", () => {
    expect(readPlanRequest("Can two people eat here under ₹1,000?", null)?.focus).toMatchObject({ party: 2, budget: 1000, basis: "total", diet: null });
    expect(readPlanRequest("Can two of us eat here under ₹1,000?", null)?.focus).toMatchObject({ party: 2, budget: 1000 }); // review: was not read
    expect(readPlanRequest("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", null)?.focus).toMatchObject({ party: 2, budget: 1000, diet: "vegetarian" });
    expect(readPlanRequest("Dinner for two under ₹1500: one of us is vegetarian and the other eats chicken.", null)?.focus).toMatchObject({ party: 2, budget: 1500, diet: "mixed" });
    expect(readPlanRequest("We're 3 people with a budget of ₹400 per person and we eat everything. What can we get?", null)?.focus).toMatchObject({ party: 3, budget: 1200, basis: "per_person", diet: "any" });
    expect(readPlanRequest("Can 4 people eat here for ₹300 in total? We eat everything.", null)?.focus).toMatchObject({ party: 4, budget: 300, diet: "any" });
    expect(readPlanRequest("Dinner for 2 under 1.5k?", null)?.focus).toMatchObject({ party: 2, budget: 1500 });
  });
  it("review: reads diets, mixed groups, the whole party and per-person budgets the way guests say them", () => {
    // "We don't eat meat" is vegetarian, not "everything".
    expect(readPlanRequest("Can 2 of us eat here under ₹1000? We don't eat meat.", null)?.focus.diet).toBe("vegetarian");
    expect(readPlanRequest("We are 4, we don't eat non-veg, can we have dinner under ₹2000?", null)?.focus).toMatchObject({ party: 4, diet: "vegetarian" });
    // Mixed groups in their usual wordings; a vegan member needs a vegan main.
    expect(readPlanRequest("Can 2 of us eat under ₹1500? I'm vegetarian, my husband is non-veg", null)?.focus.diet).toBe("mixed");
    expect(readPlanRequest("Can 4 of us eat here for ₹3,000? 2 veg, 2 non-veg", null)?.focus.diet).toBe("mixed");
    expect(readPlanRequest("We are 4 and one of us is vegan, can we have dinner for ₹2,500?", null)?.focus).toMatchObject({ party: 4, diet: "mixed_vegan" });
    // The whole party, not the subgroup with a diet.
    expect(readPlanRequest("We are 5, three of us are vegetarian, can we eat under ₹3000?", null)?.focus).toMatchObject({ party: 5, diet: "mixed" });
    expect(readPlanRequest("Can me and 3 friends eat here under ₹2,000?", null)?.focus.party).toBe(4);
    // "One main each" is no per-person budget.
    expect(readPlanRequest("Can 2 of us eat under ₹1,000? We'd like one main each.", null)?.focus).toMatchObject({ budget: 1000, basis: "total" });
    expect(readPlanRequest("Can 3 of us eat here for ₹500 each?", null)?.focus).toMatchObject({ budget: 1500, basis: "per_person" });
  });
  it("leaves bookings, single-dish budgets, huge budgets and chat alone", () => {
    for (const t of [
      "Book a table for 4 tomorrow, budget ₹2000",
      "Dinner for 4 on Saturday at 8pm, budget ₹4000",
      "Lunch for 3 tomorrow at 1, budget Rs 2000",
      "Do you have a biryani under ₹700 for 2?",
      "Can I get a starter under ₹400 for 2 people?",
      "Show me dishes under ₹400, we are 2",
      "Something under ₹300 please",
      "A vegetarian main under ₹400",
      "We are 2 people, any table free tonight?",
      "Can 12 of us eat here for ₹20,000 each?",
      "Thanks!",
    ])
      expect(readPlanRequest(t, null), t).toBeNull();
  });
  it("reads a follow-up that changes the plan: cheaper, a new budget, the diet answer, more people", () => {
    const prev = focus({ subtotal: 890, items: ["menu:dal-ember"] });
    expect(readPlanRequest("Can you make it cheaper?", prev)).toMatchObject({ relation: "cheaper", focus: { budget: 1000 } });
    expect(readPlanRequest("Actually our budget is ₹800 now.", prev)?.focus).toMatchObject({ budget: 800, basis: "total" });
    expect(readPlanRequest("Vegetarian", focus({ diet: null }))?.focus.diet).toBe("vegetarian");
    expect(readPlanRequest("We eat everything", focus({ diet: null }))?.focus.diet).toBe("any");
    expect(readPlanRequest("A mix of veg and non-veg", focus({ diet: null }))?.focus.diet).toBe("mixed");
    expect(readPlanRequest("Actually there are 3 of us", focus({ basis: "per_person", budget: 800 }))?.focus).toMatchObject({ party: 3, budget: 1200 });
  });
  it("review: after a plan, a question about a dish, a one-dish budget or anything else is answered normally", () => {
    const prev = focus({ subtotal: 890, items: ["menu:dal-ember"] });
    for (const t of ["What time do you close?", "Is the dal ember vegetarian?", "Any vegan dessert?", "Do you have any non-veg starters?", "Do you have something under ₹300?", "Is there parking for 2 wheelers?", "We'll come for 2 hours", "Actually we are 15 people now"]) expect(readPlanRequest(t, prev), t).toBeNull();
  });
});

describe("checking a plan", () => {
  it("orders by stated portions: a main shared by two, a bread each, rice per two, a drink each", () => {
    const by = (slug: string) => entries.find((e) => e.id === `menu:${slug}`)!;
    expect([portions(by("dal-ember"), 4), portions(by("butter-naan"), 4), portions(by("steamed-basmati"), 4), portions(by("masala-chai"), 4), portions(by("mango-sorbet"), 4), portions(by("subz-dum-biryani"), 4)]).toEqual([1, 4, 2, 4, 2, 1]);
  });
  it("knows the least a meal can cost: the cheapest distinct mains, then the cheapest way to feed everyone", () => {
    const veg4 = focus({ party: 4, diet: "vegetarian" });
    expect(cheapestPlan(planDishes(entries, veg4, noPrefs(), null), veg4)).toMatchObject({ total: 375 + 395 + 4 * 75 });
    const mixed = focus({ diet: "mixed_vegan" });
    expect(cheapestPlan(planDishes(entries, mixed, noPrefs(), null), mixed)?.mains[0].dietary).toContain("vegan");
  });
  it("checks every dish, the sum, the budget, the mains and that everyone eats", () => {
    const f = focus({});
    const dishes = planDishes(entries, f, noPrefs(), null);
    const ok = validatePlan({ sum: "", dishes: ["dal-ember", "butter-naan", "menu:butter-naan"], note: "" }, dishes, f, null);
    expect(ok).toMatchObject({ reasons: [], subtotal: 445 + 110 * 2 });
    expect(ok.items.map((i) => [i.d.id, i.qty])).toEqual([["menu:dal-ember", 1], ["menu:butter-naan", 2]]);
    expect(validatePlan({ sum: "", dishes: ["old-delhi-butter-chicken", "butter-naan"], note: "" }, dishes, f, null).reasons).toContain('"old-delhi-butter-chicken" is not one of the listed dishes');
    expect(validatePlan({ sum: "", dishes: ["paneer-lababdar", "dal-ember", "butter-naan"], note: "" }, dishes, f, null).reasons.join("; ")).toMatch(/come to ₹1190 for the group \(Paneer Lababdar ₹525, Dal Ember ₹445, Butter Naan ₹220\), ₹190 more than the ₹1000 budget/);
    expect(validatePlan({ sum: "", dishes: ["butter-naan"], note: "" }, dishes, f, null).reasons.join("; ")).toMatch(/at least 1 main dishes/);
    expect(validatePlan({ sum: "", dishes: ["dal-ember"], note: "" }, dishes, f, null).reasons.join("; ")).toMatch(/so all 2 people eat/);
    expect(validatePlan({ sum: "", dishes: ["dal-ember", "butter-naan"], note: "" }, dishes, focus({ subtotal: 500 }), "cheaper").reasons.join("; ")).toMatch(/cheaper than ₹500/);
    // A vegan member needs a vegan main: a dairy main doesn't count.
    const mv = focus({ diet: "mixed_vegan" });
    expect(validatePlan({ sum: "", dishes: ["paneer-lababdar", "old-delhi-butter-chicken", "butter-naan"], note: "" }, planDishes(entries, mv, noPrefs(), null), { ...mv, budget: 3000 }, null).reasons).toContain("include a vegan main dish for the vegan guest");
  });
  it("review: plans use only dishes that meet every stated need (allergens, gluten-free, exclusions)", () => {
    const f = focus({ diet: "any" });
    const ids = (p: Prefs) => planDishes(entries, f, p, null).map((d) => d.id);
    expect(ids({ ...noPrefs(), avoid: ["nuts"], allergy: true })).not.toContain("menu:paneer-lababdar");
    expect(ids({ ...noPrefs(), diet: ["gluten-free"], allergy: true }).filter((id) => /naan|roti|paratha/.test(id))).toEqual([]);
    expect(ids({ ...noPrefs(), exclude: ["paneer"] })).not.toContain("menu:smoked-paneer-tikka");
  });
});

describe("a planning turn", () => {
  const VEG_PLAN: Plan = { sum: "", dishes: ["dal-ember", "yellow-dal-tadka", "tandoori-roti"], note: "Two lentil dishes, one smoky and one bright, with rotis to share." };
  it("asks once what the group eats when it isn't said, with no model call", async () => {
    const { res, calls, trace } = await run("Can two people eat here under ₹1,000?", []);
    expect(calls).toEqual([]);
    expect(res.asked).toBe(true);
    expect(res.text).toMatch(/vegetarian.*meat.*mix\?$/);
    expect(res.focus).toMatchObject({ party: 2, budget: 1000, diet: null });
    expect(trace).toContainEqual({ action: "ask_pref", args: { field: "plan_diet" } });
    // Asked already in this plan: no second question; the guest's own stated diet, else everything.
    expect((await run("Can two people eat here under ₹1,000?", [VEG_PLAN], { asked: true })).plan).toBeDefined();
    expect((await run("Can two people eat here under ₹1,000?", [VEG_PLAN], { asked: true, prefs: { ...noPrefs(), diet: ["vegetarian"] } })).res.focus?.diet).toBe("vegetarian");
  });
  it("shows the model's dishes with code's portions, prices and total, within the budget", async () => {
    const { res, plan, calls } = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [VEG_PLAN]);
    expect(calls).toEqual([1]);
    expect(plan).toMatchObject({ party: 2, budget: 1000, budgetBasis: "total", subtotal: 445 + 375 + 150, items: [{ id: "menu:dal-ember", price: 445, qty: 1 }, { id: "menu:yellow-dal-tadka", price: 375, qty: 1 }, { id: "menu:tandoori-roti", price: 75, qty: 2 }] });
    expect(res.text).toBe("Here's a vegetarian meal for two people that comes to ₹970, within your ₹1,000. Two lentil dishes, one smoky and one bright, with rotis to share.");
  });
  it("never shows a plan over the budget: one retry with the group costs, then an honest line", async () => {
    const over: Plan = { sum: "", dishes: ["paneer-lababdar", "dal-ember", "butter-naan"], note: "A rich pairing." };
    const fits: Plan = { sum: "", dishes: ["yellow-dal-tadka", "chana-pindi", "tandoori-roti"], note: "Two hearty curries with rotis." };
    const retried = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [over, fits]);
    expect(retried.calls).toEqual([1, 2]);
    expect(retried.plan?.subtotal).toBe(375 + 395 + 150);
    expect(retried.trace.filter((x) => x.action === "plan")).toMatchObject([{ result: "rejected", subtotal: 1190, rejected: [expect.stringMatching(/more than the ₹1000 budget/)] }, { result: "ok" }]);
    const failed = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [over, over]);
    expect(failed.plan).toBeUndefined();
    expect(failed.res.text).toMatch(/^I couldn't put a meal plan together/);
  });
  it("leaves out the extras that alone push a plan over budget, and says so; never trims the meal itself", async () => {
    const withChai: Plan = { sum: "", dishes: ["yellow-dal-tadka", "baingan-bharta", "tandoori-roti", "masala-chai"], note: "A comforting meal with chai." };
    const t = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [withChai]);
    expect(t.calls).toEqual([1]);
    expect(t.plan?.items.map((i) => i.id)).toEqual(["menu:yellow-dal-tadka", "menu:baingan-bharta", "menu:tandoori-roti"]);
    expect(t.res.text).toBe("Here's a vegetarian meal for two people that comes to ₹950, within your ₹1,000. I left out the Masala Chai to stay within your budget.");
    expect(t.trace.find((x) => x.action === "plan")).toMatchObject({ result: "trimmed", subtotal: 950 });
    // Over budget without any extras: nothing is trimmed; the model is asked again with how much it was over.
    const mains: Plan = { sum: "", dishes: ["dal-ember", "baingan-bharta", "tandoori-roti"], note: "" };
    const m = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [mains, "down"]);
    expect(m.plan).toBeUndefined();
    expect(m.trace.find((x) => x.action === "plan")).toMatchObject({ result: "rejected", rejected: [expect.stringMatching(/₹20 more than the ₹1000 budget/)] });
  });
  it("says plainly when the budget can't cover a meal, with no model call and no figure that isn't on the menu", async () => {
    const { res, plan, calls } = await run("Can 4 people eat here for ₹300 in total? We eat everything.", []);
    expect(calls).toEqual([]);
    expect(plan).toBeUndefined();
    expect(res.text).toBe("₹300 isn't enough for a meal for four people here: our lowest-priced main dish is the Yellow Dal Tadka at ₹375, and a meal needs two mains and enough for everyone.");
    expect((res.blocks[0] as Extract<Block, { type: "quick_replies" }>).chips[0]).toEqual({ label: "Plan for ₹1,070", text: "Our budget is ₹1,070" });
  });
  it("makes a follow-up plan cheaper than the last; says so when it already is the cheapest; drops a note with numbers or hype", async () => {
    const prev = focus({ subtotal: 1040, items: ["menu:dal-ember", "menu:yellow-dal-tadka", "menu:butter-naan"] });
    const cheaper: Plan = { sum: "", dishes: ["yellow-dal-tadka", "tandoori-roti"], note: "Our most popular dal for just ₹375." };
    const { res, plan } = await run("Can you make it cheaper?", [cheaper], { prev });
    expect(plan?.subtotal).toBe(525);
    expect(res.text).toBe("Here's a vegetarian meal for two people that comes to ₹525, within your ₹1,000.");
    const floor = await run("Can you make it cheaper?", [], { prev: focus({ subtotal: 525, items: ["menu:yellow-dal-tadka", "menu:tandoori-roti"] }) });
    expect(floor.calls).toEqual([]);
    expect(floor.res.text).toBe("That's already about the lowest-priced meal for two people on our menu.");
  });
  it("review: drops a note with diet, allergen or attribute claims, or naming a dish not in the plan", async () => {
    for (const note of ["A fully vegan, gluten-free spread that suits a coeliac guest perfectly.", "Halal chicken with soft naan, all mild.", "The Dal Ember with the Paneer Lababdar is a rich pairing."]) {
      const { res } = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [{ ...VEG_PLAN, note }]);
      expect(res.text, note).toBe("Here's a vegetarian meal for two people that comes to ₹970, within your ₹1,000.");
    }
  });
  it("review: an allergen the labels can't cover sends the guest to staff, with no plan", async () => {
    const { res, calls, plan } = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [VEG_PLAN], { prefs: { ...noPrefs(), allergy: true, unlisted: ["shellfish"] } });
    expect(calls).toEqual([]);
    expect(plan).toBeUndefined();
    expect(res.text).toMatch(/can't suggest a dish around your allergy/);
  });
  it("quotes the service-charge FAQ that applies and says taxes are unknown, never inventing either", async () => {
    const { plan } = await run("There are two of us, both vegetarian, and our budget is ₹1100 in total. What should we order?", [VEG_PLAN]);
    expect(plan?.caveats).toEqual(["Menu prices. I don't have tax details, so the bill may differ.", "Portions: a main dish is shared by two, a bread is one each.", "No service charge is added to the bill. Tipping is optional."]);
  });
  it("model down: no plan, an honest line, no second attempt", async () => {
    const { res, calls, plan } = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", ["down"]);
    expect(calls).toEqual([1]);
    expect(plan).toBeUndefined();
    expect(res.text).toMatch(/^I couldn't put a meal plan together just now/);
  });
});
