import { partyStated } from "@/lib/chat/guards";
import { hypeClaims } from "@/lib/chat/claims";
import { eligible, view, type MenuEntry } from "@/lib/chat/menu";
import { explicitPrefs, rupeesOf } from "@/lib/chat/recommend";
import { noPrefs, type Block, type Chip, type PlanFocus, type Prefs, type TraceEntry } from "@/lib/chat/types";
import type { FactSource } from "@/lib/kb/facts";
import type { ChooserDish } from "@/lib/llm/chooser";
import type { ChatMessage as LlmMessage } from "@/lib/llm/client";
import { buildPlannerSystem, buildPlannerUser, plannerCorrection, type Plan } from "@/lib/llm/planner";

// Budget meal planning for a group (D-28): "Can two people eat here under ₹1,000?". Code reads the party, the budget
// (the whole table's, unless the guest says per person) and what they eat, asks once about veg/non-veg when it isn't
// said, and narrows the menu; the model proposes the meal; code checks every dish, the arithmetic, the budget and that
// there's enough for everyone, and writes the total. Nothing here ranks dishes or picks the meal: when the model's plan
// can't be shown, the guest is told plainly. A budget is never stretched to make a plan fit.

export type PlanDiet = NonNullable<PlanFocus["diet"]>;
const DIET_WORD: Record<PlanDiet, string> = { vegetarian: "vegetarian ", vegan: "vegan ", any: "", mixed: "" };
const NUMBER: Record<number, string> = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve" };
const PARTY_MAX = 12;

/** "for two", "the two of us", "a couple", "both of us", "we're 3": a party size the guards' reader doesn't need. */
function partyIn(text: string): number | null {
  const t = text.toLowerCase();
  // "One of us is vegetarian" is part of the group, not its size.
  const stated = partyStated(text.replace(/\b(?:one|some|two) of us (?:is|are|eats?|doesn't|don't|can't)\b/gi, " "));
  if (stated) return stated;
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const m = /\b(?:for|we(?:'re| are))\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?!\s*(?:pm|am|o'?clock|:|\.\d|rupees|rs|inr|k\b))/.exec(t);
  if (m) return /^\d/.test(m[1]) ? Number(m[1]) : words[m[1]];
  if (/\b(?:both of us|a couple|the two of us|me and my (?:wife|husband|partner|friend|date|mother|father|mom|dad|son|daughter|sister|brother))\b/.test(t)) return 2;
  if (/\bone of us\b[^.?!]*\b(?:the )?other\b/.test(t)) return 2;
  return null;
}

/** What the group eats, as far as the guest said: null when unknown. */
export function planDietIn(text: string): PlanDiet | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  if (/\bmix(?:ed)?\b|\bboth veg and non[- ]?veg\b|\bveg and non[- ]?veg\b|\bnon[- ]?veg and veg\b|\bone of us\b[^.?!]*\bveg(?:etarian|an)?\b|\b(?:one|some) (?:of us )?(?:is|are) (?:veg|vegetarian|vegan)\b/.test(t)) return "mixed";
  const ex = explicitPrefs(text);
  if (/\b(?:eat (?:everything|anything|meat|chicken|fish)|eats (?:everything|anything|meat|chicken|fish)|non[- ]?veg(?:etarian)?|no restrictions?|no preference)\b/.test(t)) return "any";
  if (ex.diet?.includes("vegan")) return "vegan";
  if (ex.diet?.includes("vegetarian")) return "vegetarian";
  return null;
}

const BOOKING_WORDS = /\b(?:book\w*|reserv\w*|table for|a table)\b/i;
const MEAL_WORDS = /\b(?:eat|order|meal|dinner|lunch|food|dishes|have|get|plan)\b/i;
const CHEAPER = /\b(?:cheaper|less expensive|more affordable|lower (?:the )?(?:cost|price|total)|reduce (?:the )?(?:cost|price|total)|spend less|bring (?:it|the total) down)\b/i;
const ANOTHER = /\b(?:another (?:combination|option|plan|meal|set)|something else|different (?:dishes|combination|meal)|other (?:dishes|options))\b/i;
const PER_PERSON = /\b(?:per (?:person|head)|each|a head|pp)\b/i;

export type PlanRequest = { focus: PlanFocus; relation: "cheaper" | "another" | null; changed: boolean };

/**
 * A meal-planning message: a party of two or more with a budget ("can 2 of us eat under ₹1,000?"), or, right after a
 * plan or the plan's diet question, a follow-up that changes it ("make it cheaper", "our budget is ₹800 now",
 * "vegetarian"). Null for anything else, including booking messages ("a table for 4, budget ₹2,000" is a booking).
 */
export function readPlanRequest(text: string, prev: PlanFocus | null | undefined): PlanRequest | null {
  const t = text.toLowerCase();
  if (BOOKING_WORDS.test(t)) return null;
  const ex = explicitPrefs(text);
  const amount = ex.maxPrice ?? (() => {
    const m = /(?:₹|rs\.?\s*|inr\s*)(\d{1,2},\d{3}|\d{2,5}|\d{1,2}(?:\.\d)?\s?k)\b/i.exec(text);
    return m ? rupeesOf(m[1]) : null;
  })();
  const party = partyIn(text);
  const diet = planDietIn(text);
  if (prev) {
    // A follow-up to the last plan or its question.
    const perPerson = amount !== null && PER_PERSON.test(t);
    const p = Math.min(party ?? prev.party, PARTY_MAX);
    const budget = amount !== null ? (perPerson ? amount * p : amount) : prev.basis === "per_person" && party ? Math.round((prev.budget / prev.party) * p) : prev.budget;
    const relation = CHEAPER.test(t) ? "cheaper" : ANOTHER.test(t) ? "another" : null;
    const changed = amount !== null || party !== null || diet !== null || relation !== null;
    if (!changed) return null;
    return { focus: { ...prev, party: p, budget, basis: perPerson ? "per_person" : amount !== null ? "total" : prev.basis, diet: diet ?? prev.diet }, relation, changed };
  }
  if (amount === null || party === null || party < 2 || party > PARTY_MAX || !MEAL_WORDS.test(t) && !/\bhere\b/.test(t)) return null;
  const perPerson = PER_PERSON.test(t);
  return { focus: { party, budget: perPerson ? amount * party : amount, basis: perPerson ? "per_person" : "total", diet, subtotal: null, items: [] }, relation: null, changed: true };
}

const isMain = (d: MenuEntry) => d.course === "mains" || d.course === "tandoor" || /\bbiryani\b/i.test(d.name);
const mainsNeeded = (party: number) => Math.ceil(party / 2);
const vegFits = (d: MenuEntry) => d.dietary.includes("vegetarian") || d.dietary.includes("vegan");

/** The dishes a plan may use: available, at the branch, fitting the diet, allergies and exclusions (no ranking). */
export function planDishes(entries: MenuEntry[], focus: PlanFocus, prefs: Prefs, branch: string | null): MenuEntry[] {
  const base: Prefs = { ...noPrefs(), avoid: prefs.avoid, allergy: prefs.allergy, unlisted: prefs.unlisted, exclude: prefs.exclude ?? [], diet: focus.diet === "vegetarian" ? ["vegetarian"] : focus.diet === "vegan" ? ["vegan"] : [] };
  return eligible(entries, base, { branch });
}

/** The least a plan can cost: the cheapest main dishes needed, then the cheapest dishes up to one per person. */
export function cheapestPlan(dishes: MenuEntry[], focus: PlanFocus): { total: number; mains: MenuEntry[] } | null {
  const mains = [...dishes.filter(isMain)].sort((a, b) => a.price - b.price);
  const need = mainsNeeded(focus.party);
  const vegMain = mains.find(vegFits);
  if (!mains.length || (focus.diet === "mixed" && !vegMain)) return null;
  // Mains may repeat (two portions of the same dal); the cheapest fill the rest of the count.
  const picked = focus.diet === "mixed" ? [vegMain!, ...Array(need - 1).fill(mains[0])] : Array(need).fill(mains[0]);
  const rest = Math.max(0, focus.party - need);
  const cheapest = [...dishes].sort((a, b) => a.price - b.price)[0];
  return { total: picked.reduce((n, d) => n + d.price, 0) + rest * cheapest.price, mains: picked };
}

/** Why a proposed plan can't be shown (empty when it can), and the plan with duplicates merged. */
export function validatePlan(raw: Plan, dishes: MenuEntry[], focus: PlanFocus, relation: "cheaper" | "another" | null): { reasons: string[]; items: { d: MenuEntry; qty: number }[]; subtotal: number } {
  const byId = new Map(dishes.map((d) => [d.id, d]));
  const reasons: string[] = [];
  const merged = new Map<string, { d: MenuEntry; qty: number }>();
  for (const i of raw.items) {
    const id = i.id.startsWith("menu:") ? i.id : `menu:${i.id.trim()}`;
    const d = byId.get(id);
    if (!d) {
      reasons.push(`"${i.id}" is not one of the listed dishes`);
      continue;
    }
    merged.set(id, { d, qty: (merged.get(id)?.qty ?? 0) + i.qty });
  }
  const items = [...merged.values()];
  const subtotal = items.reduce((n, i) => n + i.d.price * i.qty, 0);
  const count = items.reduce((n, i) => n + i.qty, 0);
  const mains = items.filter((i) => isMain(i.d)).reduce((n, i) => n + i.qty, 0);
  if (!items.length) reasons.push("the plan has no dishes");
  if (subtotal > focus.budget) reasons.push(`the dishes add up to ₹${subtotal}, more than the ₹${focus.budget} budget: choose fewer or cheaper dishes`);
  if (mains < mainsNeeded(focus.party)) reasons.push(`include at least ${mainsNeeded(focus.party)} main dishes (mains, tandoor or a biryani)`);
  if (count < focus.party) reasons.push(`include at least ${focus.party} items so everyone eats`);
  if (count > focus.party * 4) reasons.push("that is too much food for the group");
  if (focus.diet === "mixed" && !items.some((i) => isMain(i.d) && vegFits(i.d))) reasons.push("include a vegetarian main dish for the vegetarian guest");
  if (relation === "cheaper" && focus.subtotal !== null && subtotal >= focus.subtotal) reasons.push(`the guest wants it cheaper than ₹${focus.subtotal}`);
  if (relation === "another" && focus.items.length && items.every((i) => focus.items.includes(i.d.id))) reasons.push("the guest wants different dishes from the last plan");
  return { reasons, items, subtotal };
}

/** The model's one-line reason, when it says nothing the app must not: no numbers, hype, safety promises or bookings. */
function safeNote(note: string): string | null {
  const n = note.trim().replace(/\s+/g, " ");
  if (!n || n.length > 240 || /\d|₹/.test(n) || hypeClaims(n).length || /\b(?:safe|nut[- ]free|dairy[- ]free|allergen|table|book|reserv)/i.test(n) || !/[.!]$/.test(n)) return null;
  return n;
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const groupWord = (n: number) => NUMBER[n] ?? String(n);

/** The service-charge FAQ, if the restaurant has one: its answer is quoted as is (D-28: only verified charges). */
function chargeNote(src: FactSource): string | null {
  const f = src.faq.find((q) => /\bservice charge\b/i.test(q.question));
  return f ? f.answer : null;
}

export type PlanCall = (attempt: 1 | 2, messages: LlmMessage[]) => Promise<{ plan: Plan | null; code: string; content: string }>;
export type PlanResult = { text: string; blocks: Block[]; focus: PlanFocus | null; asked: boolean; cited: string[] };

const DIET_CHIPS: Chip[] = [
  { label: "All vegetarian", text: "All vegetarian" },
  { label: "We eat everything", text: "We eat everything" },
  { label: "A mix", text: "A mix of veg and non-veg" },
];
const AFTER_CHIPS = (): Block => ({
  type: "quick_replies",
  chips: [
    { label: "Make it cheaper", text: "Make it cheaper" },
    { label: "Show me the menu", action: { type: "menu", course: null } },
    { label: "Find a table", action: { type: "set_field", field: "branch", value: null } },
  ],
});

/** A meal-planning turn, after readPlanRequest. `call` runs the planner through the model gate. */
export async function planTurn(
  input: { request: PlanRequest; text: string; history: { role: "guest" | "assistant"; content: string }[]; entries: MenuEntry[]; src: FactSource; prefs: Prefs; branch: string | null; asked: boolean; trace: TraceEntry[]; canRetry?: () => boolean },
  call: PlanCall,
): Promise<PlanResult> {
  const { focus, relation } = input.request;
  const group = `${groupWord(focus.party)} ${focus.party === 1 ? "person" : "people"}`;
  const budgetText = focus.basis === "per_person" ? `${rupees(focus.budget)} in all (${rupees(Math.round(focus.budget / focus.party))} each)` : `${rupees(focus.budget)} in all`;

  // What they eat matters for the plan: one question, once (D-28).
  if (focus.diet === null && !input.asked) {
    input.trace.push({ action: "ask_pref", args: { field: "plan_diet" } });
    return { text: `Happy to plan a meal for ${group} within ${rupees(focus.budget)}. Is everyone vegetarian, do you eat meat too, or is it a mix?`, blocks: [{ type: "quick_replies", chips: DIET_CHIPS }], focus, asked: true, cited: [] };
  }
  const plan: PlanFocus = { ...focus, diet: focus.diet ?? "any" };
  const dishes = planDishes(input.entries, plan, input.prefs, input.branch);
  const floor = cheapestPlan(dishes, plan);
  input.trace.push({ action: "plan_scope", party: plan.party, budget: plan.budget, diet: plan.diet!, dishes: dishes.length, least: floor?.total ?? null });
  // Not enough for a meal at menu prices, or nothing that fits: said plainly, with the real figures, and no model call.
  if (!floor) return { text: `I couldn't find enough ${DIET_WORD[plan.diet!]}main dishes on the menu to plan that meal. You can browse the menu instead.`, blocks: [{ type: "quick_replies", chips: [{ label: "Show me the menu", action: { type: "menu", course: null } }] }], focus: plan, asked: false, cited: [] };
  if (floor.total > plan.budget) {
    const cheapestMain = floor.mains[0];
    return {
      text: `${rupees(plan.budget)} isn't enough for a meal for ${group} here: our lowest-priced ${DIET_WORD[plan.diet!]}main dish is the ${cheapestMain.name} at ${rupees(cheapestMain.price)}, and the least a meal for ${group} comes to is ${rupees(floor.total)} at menu prices.`,
      blocks: [{ type: "quick_replies", chips: [{ label: `Plan for ${rupees(floor.total)}`, text: `Our budget is ${rupees(floor.total)}` }, { label: "Show me the menu", action: { type: "menu", course: null } }] }],
      focus: plan,
      asked: false,
      cited: [cheapestMain.id],
    };
  }

  const relationLine =
    relation === "cheaper" && plan.subtotal !== null ? `The last plan came to ₹${plan.subtotal}; the guest wants a cheaper one (a total below that).` : relation === "another" && plan.items.length ? `The guest wants a different combination from the last plan (${plan.items.map((id) => id.slice(5)).join(", ")}).` : null;
  const lines: ChooserDish[] = dishes.map((d) => ({ id: d.id, name: d.name, courseLabel: d.courseLabel, price: d.price, labels: d.labels, contains: d.contains, spice: d.spice, description: d.description, scope: d.scope }));
  const messages: LlmMessage[] = [
    { role: "system", content: buildPlannerSystem(input.src.restaurant?.name ?? "the restaurant") },
    {
      role: "user",
      content: buildPlannerUser({ group, budget: budgetText, mains: mainsNeeded(plan.party), minItems: plan.party, diet: plan.diet === "mixed" ? "a mix: some vegetarian, some eat meat" : plan.diet === "any" ? "everything" : `${plan.diet} only`, avoid: input.prefs.avoid.length ? input.prefs.avoid.join(", ") : null, relation: relationLine, history: input.history, dishes: lines, guest: input.text }),
    },
  ];
  for (const attempt of [1, 2] as const) {
    if (attempt === 2 && input.canRetry && !input.canRetry()) break;
    const r = await call(attempt, messages);
    if (!r.plan) {
      input.trace.push({ action: "plan", attempt, result: r.code, items: [], subtotal: null, rejected: [] });
      if (r.code === "MODEL_UNAVAILABLE" || r.code === "MODEL_TIMEOUT") break;
      continue;
    }
    const v = validatePlan(r.plan, dishes, plan, relation);
    input.trace.push({ action: "plan", attempt, result: v.reasons.length ? "rejected" : "ok", items: v.items.map((i) => `${i.d.id}×${i.qty}`), subtotal: v.subtotal, rejected: v.reasons });
    if (!v.reasons.length) {
      const note = safeNote(r.plan.note);
      const charge = chargeNote(input.src);
      const caveats = ["Menu prices. I don't have tax details, so the bill may differ.", ...(charge ? [charge] : [])];
      // What's left of the budget is on the card; the line gives the total and the budget only.
      const lead = `Here's a ${DIET_WORD[plan.diet!]}meal for ${group} that comes to ${rupees(v.subtotal)}, within your ${rupees(plan.budget)}.`;
      const items = v.items.map((i) => ({ ...view(i.d), qty: i.qty }));
      return {
        text: note ? `${lead} ${note}` : lead,
        blocks: [{ type: "meal_plan", party: plan.party, budget: plan.budget, budgetBasis: plan.basis, items, subtotal: v.subtotal, caveats }, AFTER_CHIPS()],
        focus: { ...plan, subtotal: v.subtotal, items: v.items.map((i) => i.d.id) },
        asked: false,
        cited: v.items.map((i) => i.d.id),
      };
    }
    messages.push({ role: "assistant", content: r.content }, { role: "user", content: plannerCorrection(v.reasons) });
  }
  // No plan the app can stand behind: said plainly. The budget and the dishes that fit are still there to browse.
  return {
    text: relation === "cheaper" ? `I couldn't put together a cheaper meal for ${group} just now. You can browse the menu, or ask again in a moment.` : `I couldn't put a meal plan together just now. You can browse the menu, or ask again in a moment.`,
    blocks: [{ type: "quick_replies", chips: [{ label: "Show me the menu", action: { type: "menu", course: null } }] }],
    focus: plan,
    asked: false,
    cited: [],
  };
}
