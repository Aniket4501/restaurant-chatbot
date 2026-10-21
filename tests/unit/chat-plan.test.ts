import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { loadFactSource, type FactSource } from "@/lib/kb/facts";
import { menuEntries, type MenuEntry } from "@/lib/chat/menu";
import { cheapestPlan, planDishes, planTurn, readPlanRequest, validatePlan, type PlanCall } from "@/lib/chat/plan";
import { noPrefs, type Block, type PlanFocus, type TraceEntry } from "@/lib/chat/types";
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
const run = async (text: string, replies: (Plan | "down" | "invalid")[], o: { prev?: PlanFocus | null; asked?: boolean } = {}) => {
  const request = readPlanRequest(text, o.prev ?? null);
  if (!request) throw new Error(`not a plan request: ${text}`);
  const s = scripted(replies);
  const trace: TraceEntry[] = [];
  const res = await planTurn({ request, text, history: [], entries, src, prefs: noPrefs(), branch: null, asked: !!o.asked, trace }, s.call);
  const plan = res.blocks.find((b) => b.type === "meal_plan") as Extract<Block, { type: "meal_plan" }> | undefined;
  return { res, plan, calls: s.calls, trace };
};

describe("reading a planning request", () => {
  it("reads the party, a total or per-person budget, and what they eat", () => {
    expect(readPlanRequest("Can two people eat here under ₹1,000?", null)?.focus).toMatchObject({ party: 2, budget: 1000, basis: "total", diet: null });
    expect(readPlanRequest("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", null)?.focus).toMatchObject({ party: 2, budget: 1000, diet: "vegetarian" });
    expect(readPlanRequest("Dinner for two under ₹1500: one of us is vegetarian and the other eats chicken.", null)?.focus).toMatchObject({ party: 2, budget: 1500, diet: "mixed" });
    expect(readPlanRequest("We're 3 people with a budget of ₹400 per person and we eat everything. What can we get?", null)?.focus).toMatchObject({ party: 3, budget: 1200, basis: "per_person", diet: "any" });
    expect(readPlanRequest("Can 4 people eat here for ₹300 in total? We eat everything.", null)?.focus).toMatchObject({ party: 4, budget: 300, diet: "any" });
    expect(readPlanRequest("Dinner for 2 under 1.5k?", null)?.focus).toMatchObject({ party: 2, budget: 1500 });
  });
  it("leaves bookings, single-dish budgets and chat alone", () => {
    for (const t of ["Book a table for 4 tomorrow, budget ₹2000", "Something under ₹300 please", "A vegetarian main under ₹400", "We are 2 people, any table free tonight?", "Thanks!"]) expect(readPlanRequest(t, null), t).toBeNull();
  });
  it("reads a follow-up to the last plan: cheaper, a new budget, the diet answer, more people", () => {
    const prev = focus({ subtotal: 890, items: ["menu:dal-ember"] });
    expect(readPlanRequest("Can you make it cheaper?", prev)).toMatchObject({ relation: "cheaper", focus: { budget: 1000 } });
    expect(readPlanRequest("Actually our budget is ₹800 now.", prev)?.focus).toMatchObject({ budget: 800, basis: "total" });
    expect(readPlanRequest("Vegetarian", focus({ diet: null }))?.focus.diet).toBe("vegetarian");
    expect(readPlanRequest("A mix of veg and non-veg", focus({ diet: null }))?.focus.diet).toBe("mixed");
    expect(readPlanRequest("Actually there are 3 of us", focus({ basis: "per_person", budget: 800 }))?.focus).toMatchObject({ party: 3, budget: 1200 });
    expect(readPlanRequest("What time do you close?", prev)).toBeNull();
  });
});

describe("checking a plan", () => {
  it("knows the least a meal can cost, from the cheapest main dishes and items", () => {
    const veg4 = focus({ party: 4, diet: "vegetarian" });
    expect(cheapestPlan(planDishes(entries, veg4, noPrefs(), null), veg4)).toMatchObject({ total: 375 * 2 + 75 * 2 });
    const mixed = focus({ diet: "mixed" });
    expect(cheapestPlan(planDishes(entries, mixed, noPrefs(), null), mixed)?.mains[0].dietary).toContain("vegan");
  });
  it("checks every dish, the sum, the budget, the mains and the count; merges repeats", () => {
    const f = focus({});
    const dishes = planDishes(entries, f, noPrefs(), null);
    const ok = validatePlan({ items: [{ id: "dal-ember", qty: 1 }, { id: "butter-naan", qty: 2 }, { id: "menu:butter-naan", qty: 1 }], note: "" }, dishes, f, null);
    expect(ok).toMatchObject({ reasons: [], subtotal: 445 + 110 * 3 });
    expect(ok.items.find((i) => i.d.id === "menu:butter-naan")?.qty).toBe(3);
    expect(validatePlan({ items: [{ id: "old-delhi-butter-chicken", qty: 1 }, { id: "butter-naan", qty: 1 }], note: "" }, dishes, f, null).reasons).toContain('"old-delhi-butter-chicken" is not one of the listed dishes');
    expect(validatePlan({ items: [{ id: "paneer-lababdar", qty: 2 }], note: "" }, dishes, f, null).reasons.join("; ")).toMatch(/add up to ₹1050, more than the ₹1000 budget/);
    expect(validatePlan({ items: [{ id: "butter-naan", qty: 2 }], note: "" }, dishes, f, null).reasons.join("; ")).toMatch(/at least 1 main dishes/);
    expect(validatePlan({ items: [{ id: "dal-ember", qty: 1 }], note: "" }, dishes, f, null).reasons.join("; ")).toMatch(/at least 2 items/);
    expect(validatePlan({ items: [{ id: "dal-ember", qty: 1 }, { id: "butter-naan", qty: 1 }], note: "" }, dishes, focus({ subtotal: 500 }), "cheaper").reasons.join("; ")).toMatch(/cheaper than ₹500/);
  });
});

describe("a planning turn", () => {
  const VEG_PLAN: Plan = { items: [{ id: "dal-ember", qty: 1 }, { id: "yellow-dal-tadka", qty: 1 }, { id: "butter-naan", qty: 1 }], note: "Two lentil dishes, one smoky and one bright, with naan to share." };
  it("asks once what the group eats when it isn't said, with no model call", async () => {
    const { res, calls, trace } = await run("Can two people eat here under ₹1,000?", []);
    expect(calls).toEqual([]);
    expect(res.asked).toBe(true);
    expect(res.text).toMatch(/vegetarian.*meat.*mix\?$/);
    expect(res.focus).toMatchObject({ party: 2, budget: 1000, diet: null });
    expect(trace).toContainEqual({ action: "ask_pref", args: { field: "plan_diet" } });
    // Asked already: plans for everything rather than asking twice.
    expect((await run("Can two people eat here under ₹1,000?", [VEG_PLAN], { asked: true })).plan).toBeDefined();
  });
  it("shows the model's plan with prices and the total worked out in code, within the budget", async () => {
    const { res, plan, calls } = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [VEG_PLAN]);
    expect(calls).toEqual([1]);
    expect(plan).toMatchObject({ party: 2, budget: 1000, budgetBasis: "total", subtotal: 445 + 375 + 110, items: [{ id: "menu:dal-ember", price: 445, qty: 1 }, { id: "menu:yellow-dal-tadka", price: 375, qty: 1 }, { id: "menu:butter-naan", price: 110, qty: 1 }] });
    expect(res.text).toBe("Here's a vegetarian meal for two people that comes to ₹930, within your ₹1,000. Two lentil dishes, one smoky and one bright, with naan to share.");
  });
  it("never shows a plan over the budget: one retry with the reasons, then an honest line", async () => {
    const over: Plan = { items: [{ id: "paneer-lababdar", qty: 1 }, { id: "dal-ember", qty: 1 }, { id: "butter-naan", qty: 2 }], note: "A rich pairing." };
    const fits: Plan = { items: [{ id: "yellow-dal-tadka", qty: 1 }, { id: "chana-pindi", qty: 1 }, { id: "tandoori-roti", qty: 2 }], note: "Two hearty curries with rotis." };
    const retried = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [over, fits]);
    expect(retried.calls).toEqual([1, 2]);
    expect(retried.plan?.subtotal).toBe(375 + 395 + 150);
    expect(retried.trace.filter((x) => x.action === "plan")).toMatchObject([{ result: "rejected", subtotal: 1190, rejected: [expect.stringMatching(/more than the ₹1000 budget/)] }, { result: "ok" }]);
    const failed = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", [over, over]);
    expect(failed.plan).toBeUndefined();
    expect(failed.res.text).toMatch(/^I couldn't put a meal plan together/);
  });
  it("says plainly when the budget can't cover a meal, with the real figures and no model call", async () => {
    const { res, plan, calls } = await run("Can 4 people eat here for ₹300 in total? We eat everything.", []);
    expect(calls).toEqual([]);
    expect(plan).toBeUndefined();
    expect(res.text).toBe("₹300 isn't enough for a meal for four people here: our lowest-priced main dish is the Yellow Dal Tadka at ₹375, and the least a meal for four people comes to is ₹900 at menu prices.");
  });
  it("makes a follow-up plan cheaper than the last, and drops a note that states numbers or hype", async () => {
    const prev = focus({ subtotal: 1040, items: ["menu:dal-ember", "menu:yellow-dal-tadka", "menu:butter-naan"] });
    const cheaper: Plan = { items: [{ id: "yellow-dal-tadka", qty: 1 }, { id: "tandoori-roti", qty: 2 }], note: "Our most popular dal for just ₹375." };
    const { res, plan } = await run("Can you make it cheaper?", [cheaper], { prev });
    expect(plan?.subtotal).toBe(525);
    expect(res.text).toBe("Here's a vegetarian meal for two people that comes to ₹525, within your ₹1,000.");
  });
  it("quotes the service-charge FAQ and says taxes are unknown, never inventing either", async () => {
    const { plan } = await run("There are two of us, both vegetarian, and our budget is ₹1100 in total. What should we order?", [VEG_PLAN]);
    expect(plan?.caveats).toEqual(["Menu prices. I don't have tax details, so the bill may differ.", "No service charge is added to the bill. Tipping is optional."]);
  });
  it("model down: no plan, an honest line, no second attempt", async () => {
    const { res, calls, plan } = await run("There are two of us, both vegetarian, and our budget is ₹1000 in total. What should we order?", ["down"]);
    expect(calls).toEqual([1]);
    expect(plan).toBeUndefined();
    expect(res.text).toMatch(/^I couldn't put a meal plan together just now/);
  });
});
