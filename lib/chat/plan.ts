import { partyStated } from "@/lib/chat/guards";
import { hypeClaims } from "@/lib/chat/claims";
import { eligible, unlistedReferral, view, type MenuEntry } from "@/lib/chat/menu";
import { claimProblems, explicitPrefs, rupeesOf } from "@/lib/chat/recommend";
import { noPrefs, type Block, type Chip, type PlanFocus, type Prefs, type TraceEntry } from "@/lib/chat/types";
import type { FactSource } from "@/lib/kb/facts";
import type { ChatMessage as LlmMessage } from "@/lib/llm/client";
import { buildPlannerSystem, buildPlannerUser, plannerCorrection, type Plan, type PlannerDish } from "@/lib/llm/planner";

// Budget meal planning for a group (D-28): "Can two people eat here under ₹1,000?". Code reads the party, the budget
// (the whole table's, unless the guest says per person) and what they eat, asks once about veg/non-veg when it isn't
// said, and narrows the menu; the model proposes the meal; code checks every dish, the arithmetic, the budget and that
// there's enough for everyone, and writes the total. Nothing here ranks dishes or picks the meal: when the model's plan
// can't be shown, the guest is told plainly. A budget is never stretched to make a plan fit.

export type PlanDiet = NonNullable<PlanFocus["diet"]>;
const DIET_WORD: Record<PlanDiet, string> = { vegetarian: "vegetarian ", vegan: "vegan ", any: "", mixed: "", mixed_vegan: "" };
const NUMBER: Record<number, string> = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve" };
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const N = String.raw`\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|some`;
const num = (w: string) => (/^\d/.test(w) ? Number(w) : (WORDS[w] ?? NaN));
const PARTY_MAX = 12;
const BUDGET_MAX = 200_000; // ContextSchema's limit: a larger plan context would be refused on the next turn

// "One of us is vegetarian", "three of us are vegan", "one of us has a nut allergy": part of the group, not its size.
const SUBGROUP = new RegExp(String.raw`\b(?:${N}) of us (?:is|are|has|have|eats?|doesn't|don't|can't|cannot) (?:a |an |strictly |pure |only )?(?:veg\w*|vegan\w*|non[- ]?veg\w*|jain|allergic\w*|gluten\w*|co?eliac|celiac|lactose\w*|nut\w*|meat|chicken|fish|dairy|eggs?)\b`, "gi");

/** The size of the whole group: "2 people", "two of us", "for two", "we are 5", "me and 3 friends", "a couple". */
function partyIn(text: string): number | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const whole = t.replace(SUBGROUP, " ");
  const me = new RegExp(String.raw`\bme and (?:my )?(${N}) (?:friends|colleagues|others|people|guests|family members|cousins|kids|children|coworkers|co-workers)\b`).exec(whole);
  if (me) return num(me[1]) + 1;
  const stated = partyStated(whole);
  if (stated && stated >= 2) return stated;
  const m = new RegExp(String.raw`\b(?:for|we(?:'re| are)|there are|there will be)\s+(${N})\b(?!\s*(?:pm|am|o'?clock|:|\.\d|rupees|rs|inr|k\b|hours?|hrs?|mins?|minutes?|wheelers?|days?|nights?|weeks?|years?))`).exec(whole);
  if (m && num(m[1]) >= 2) return num(m[1]);
  if (/\b(?:both of us|a couple|the two of us|me and my (?:wife|husband|partner|friend|date|mother|father|mom|dad|son|daughter|sister|brother|colleague|boss))\b/.test(t)) return 2;
  if (/\bone of us\b[^.?!]*\b(?:the )?other\b/.test(t)) return 2;
  return null;
}

// Diet words, positive only: "non-veg" is not "veg", and "we don't eat meat" is no meat-eater.
const VEG = /(?<!non[- ]?)\b(?:veg|vegetarians?|veggie|pure veg|jain)\b/;
const VEGAN = /\bvegans?\b|\bplant[- ]based\b/;
const MEAT = /(?<!(?:don't|do not|doesn't|does not|never|can't|cannot|won't|no|not|nor)\s(?:\w+\s)?)\b(?:non[- ]?veg\w*|eats? (?:meat|chicken|fish|mutton|lamb|everything|anything)|meat[- ]eaters?|carnivores?)\b/;

/** What the group eats, as far as the guest said: null when unknown. A vegan in a mixed group is "mixed_vegan". */
export function planDietIn(text: string, party: number | null = null): PlanDiet | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const ex = explicitPrefs(text);
  // A part of the group with its own diet ("one of us is vegetarian", "2 veg, 2 non-veg", "I'm vegetarian, my husband
  // is non-veg"), or both kinds named: a mixed group.
  const sub = [...t.matchAll(new RegExp(String.raw`\b(${N}) of us (?:is|are) (?:a |strictly |pure )?(veg\w*|vegan\w*)`, "g"))].filter((m) => m[1] === "one" || m[1] === "some" || (party !== null && num(m[1]) < party));
  const mixed = /\bmix(?:ed)?\b/.test(t) || sub.length > 0 || ((VEG.test(t) || VEGAN.test(t)) && MEAT.test(t)) || new RegExp(String.raw`\b(?:${N}) (?:veg|vegetarian)s?\b[^.?!]*\b(?:${N}) non[- ]?veg`).test(t);
  if (mixed) return VEGAN.test(t) ? "mixed_vegan" : "mixed";
  if (ex.diet?.includes("vegan") || VEGAN.test(t)) return "vegan";
  if (ex.diet?.includes("vegetarian")) return "vegetarian";
  if (MEAT.test(t) || /\b(?:no restrictions?|no preference|anything is fine|we're not fussy|not fussy)\b/.test(t)) return "any";
  return null;
}

const BOOKING_WORDS = /\b(?:book\w*|reserv\w*|table for|a table)\b/i;
// A day or time named: a visit being arranged, which the booking flow handles ("dinner for 4 on Saturday at 8pm").
const WHEN = /\b(?:today|tonight|tomorrow|tmrw|(?:mon|tues|wednes|thurs|fri|satur|sun)day|weekend|\d{1,2}(?::\d{2})?\s*(?:am|pm)|at \d{1,2}\b|\d{1,2}(?:st|nd|rd|th)\b|(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d)/i;
// One dish or a list of dishes under a price is a menu or recommendation question, not a meal plan.
const SINGLE = /\b(?:a|one|any) (?:dish|starter|main(?: course)?|dessert|drink|biryani|curry|bread|snack|side)\b|\bshow me\b|\b(?:something|anything|dishes|items|options|starters?|mains?|desserts?|drinks?) (?:under|below|within|for less than|up to)\b/i;
// Words that ask for a whole meal for the group.
const PLAN_CUE = new RegExp(String.raw`\bwhat (?:should|can|could|would) (?:we|the (?:${N}) of us|all of us) (?:order|get|eat|have)\b|\bplan (?:a |our |the )?(?:meal|dinner|lunch|menu|order)\b|\bcan (?:${N}|we|both of us|the (?:${N}) of us|all of us)(?: (?:people|persons|guests|adults|of us))? (?:eat|dine|have (?:a meal|dinner|lunch)|get (?:a meal|dinner|lunch))\b|\beat here\b|\bfeed\b`, "i");
// "Dinner for 4": a meal, but also how a booking starts, so it counts only with no day or time named.
const MEAL_FOR = new RegExp(String.raw`\b(?:meal|dinner|lunch|food) for (?:${N})\b`, "i");
const MEAL_WORDS = /\b(?:eat|order|meal|dinner|lunch|food|have|get|plan)\b/i;
const CHEAPER = /\b(?:cheaper|less expensive|more affordable|lower (?:the )?(?:cost|price|total)|reduce (?:the )?(?:cost|price|total)|spend less|bring (?:it|the total) down)\b/i;
const ANOTHER = /\b(?:another (?:combination|option|plan|meal|set)|something else|different (?:dishes|combination|meal)|other (?:dishes|options))\b/i;
// Per person only when the amount says so ("₹400 each", "₹400 per person"), not "one main each".
const PER_PERSON = /(?:₹|rs\.?\s*|inr\s*)?\d[\d,.]*\s?k?\s*(?:each|per (?:person|head)|a head|pp)\b|\bper (?:person|head)\b|\beach (?:of us )?(?:has|have|can spend|spends?)\b/i;

export type PlanRequest = { focus: PlanFocus; relation: "cheaper" | "another" | null; changed: boolean };

/**
 * A meal-planning message: a party of two or more with a budget ("can 2 of us eat under ₹1,000?"), or, right after a
 * plan or the plan's diet question, a follow-up that changes it ("make it cheaper", "our budget is ₹800 now",
 * "vegetarian"). Null for anything else: bookings ("dinner for 4 on Saturday at 8, budget ₹4,000"), one-dish questions
 * ("a starter under ₹400 for 2"), and, after a plan, questions about a dish ("is the dal vegetarian?").
 */
export function readPlanRequest(text: string, prev: PlanFocus | null | undefined): PlanRequest | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  if (BOOKING_WORDS.test(t)) return null;
  const ex = explicitPrefs(text);
  const amount = ex.maxPrice ?? (() => {
    const m = /(?:₹|rs\.?\s*|inr\s*)(\d{1,2},\d{3}|\d{2,6}|\d{1,3}(?:\.\d)?\s?k)\b/i.exec(text);
    return m ? rupeesOf(m[1]) : null;
  })();
  const party = partyIn(text);
  const perPerson = amount !== null && PER_PERSON.test(t);
  if (prev) {
    // A follow-up to the last plan or its diet question, only when it changes the plan. A question about a dish, a
    // single-dish budget or a booking is answered normally (the plan is dropped).
    const relation = CHEAPER.test(t) ? "cheaper" : ANOTHER.test(t) ? "another" : null;
    const dishQuestion = !relation && (/\?\s*$/.test(t) || /^(?:is|are|does|do you|any|which|what's in|how)\b/.test(t.trim()));
    const budgetChange = amount !== null && !SINGLE.test(t) && /\b(?:budget|in total|in all|total|each|per (?:person|head)|now|instead|actually|make it|change|raise|increase|lower|up to|within|spend)\b/.test(t);
    const partyChange = party !== null && new RegExp(String.raw`\b(?:we are|we're|there are|there will be|now|actually|instead|make it|of us|people|guests|friends)\b`).test(t);
    const diet = planDietIn(text, party ?? prev.party);
    const dietAnswer = diet !== null && !dishQuestion && (prev.diet === null || /\b(?:all|everyone|we(?:'re| are)|both|whole group|make it|actually|instead)\b/.test(t));
    if (!relation && !budgetChange && !partyChange && !dietAnswer) return null;
    const p = party ?? prev.party;
    if (p > PARTY_MAX) return null;
    const budget = amount !== null && budgetChange ? (perPerson ? amount * p : amount) : prev.basis === "per_person" && partyChange ? Math.round((prev.budget / prev.party) * p) : prev.budget;
    if (budget > BUDGET_MAX) return null;
    return { focus: { ...prev, party: p, budget, basis: budgetChange ? (perPerson ? "per_person" : "total") : prev.basis, diet: dietAnswer ? diet : prev.diet }, relation, changed: true };
  }
  if (amount === null || party === null || party < 2 || party > PARTY_MAX) return null;
  // A whole meal: asked for in so many words; otherwise a meal word with no day or time named and no single dish.
  if (!PLAN_CUE.test(t) && (!(MEAL_WORDS.test(t) || MEAL_FOR.test(t)) || WHEN.test(t) || SINGLE.test(t))) return null;
  const budget = perPerson ? amount * party : amount;
  if (budget > BUDGET_MAX) return null;
  return { focus: { party, budget, basis: perPerson ? "per_person" : "total", diet: planDietIn(text, party), subtotal: null, items: [] }, relation: null, changed: true };
}

const isMain = (d: MenuEntry) => d.course === "mains" || d.course === "tandoor" || /\bbiryani\b/i.test(d.name);
const mainsNeeded = (party: number) => Math.ceil(party / 2);
const vegFits = (d: MenuEntry) => d.dietary.includes("vegetarian") || d.dietary.includes("vegan");
const veganFits = (d: MenuEntry) => d.dietary.includes("vegan");
/** The main a mixed group must include for its vegetarian (or vegan) member. */
const memberMain = (diet: PlanDiet | null) => (diet === "mixed_vegan" ? veganFits : diet === "mixed" ? vegFits : null);

/**
 * The dishes a plan may use: available, at the branch, fitting the group's diet and every need the guest stated
 * (allergens, gluten-free, Jain, exclusions), with no ranking.
 */
export function planDishes(entries: MenuEntry[], focus: PlanFocus, prefs: Prefs, branch: string | null): MenuEntry[] {
  const group = focus.diet === "vegetarian" ? ["vegetarian" as const] : focus.diet === "vegan" ? ["vegan" as const] : [];
  const own = prefs.diet.filter((d) => d === "gluten-free" || d === "jain");
  const base: Prefs = { ...noPrefs(), avoid: prefs.avoid, allergy: prefs.allergy, unlisted: prefs.unlisted, exclude: prefs.exclude ?? [], diet: [...group, ...own] };
  return eligible(entries, base, { branch });
}

/** The least a plan can cost: the cheapest main dishes needed, then the cheapest dishes up to one per person. */
export function cheapestPlan(dishes: MenuEntry[], focus: PlanFocus): { total: number; mains: MenuEntry[] } | null {
  const mains = [...dishes.filter(isMain)].sort((a, b) => a.price - b.price);
  const need = mainsNeeded(focus.party);
  const member = memberMain(focus.diet);
  const memberDish = member ? mains.find(member) : undefined;
  if (!mains.length || (member && !memberDish)) return null;
  // Distinct main dishes (one portion each, the mixed group's own main first), then the cheapest way to reach one item
  // per person. A lower bound for honesty, not a plan: it is never shown as a meal.
  const picked = memberDish ? [memberDish] : [];
  const distinct = [...new Set(picked)];
  for (const d of mains) if (distinct.length < need && !distinct.includes(d)) distinct.push(d);
  if (distinct.length < need) return null;
  const mainCost = distinct.reduce((n, d) => n + d.price, 0);
  const short = Math.max(0, focus.party - distinct.length);
  const fillers = dishes.filter((d) => !isMain(d)).map((d) => ({ d, qty: portions(d, focus.party) })).filter((f) => f.qty >= short).sort((a, b) => a.d.price * a.qty - b.d.price * b.qty);
  const fill = short === 0 ? 0 : fillers.length ? fillers[0].d.price * fillers[0].qty : Infinity;
  return Number.isFinite(fill) ? { total: mainCost + fill, mains: distinct } : null;
}

const BREAD = /\b(?:naans?|rotis?|parathas?|kulchas?|breads?|chapatis?|phulkas?)\b/i;

/**
 * How many portions the plan orders of a dish for this group (D-28, stated so the guest can check it): a main dish is
 * shared by two (one portion), a bread is one each, rice serves two, a drink is one each, a dessert serves two, a
 * starter serves four. Portion sizes aren't in the menu data, so these are the plan's rules, not a measurement.
 */
export function portions(d: MenuEntry, party: number): number {
  if (isMain(d)) return 1;
  if (d.course === "breads-rice") return BREAD.test(d.name) ? party : Math.ceil(party / 2);
  if (d.course === "drinks") return party;
  if (d.course === "desserts") return Math.ceil(party / 2);
  return Math.ceil(party / 4);
}

/** Why a proposed plan can't be shown (empty when it can), with each dish's portions and the total. */
export function validatePlan(raw: Plan, dishes: MenuEntry[], focus: PlanFocus, relation: "cheaper" | "another" | null): { reasons: string[]; items: { d: MenuEntry; qty: number }[]; subtotal: number } {
  const byId = new Map(dishes.map((d) => [d.id, d]));
  const reasons: string[] = [];
  const seen = new Set<string>();
  const items: { d: MenuEntry; qty: number }[] = [];
  for (const raw0 of raw.dishes) {
    const id = raw0.startsWith("menu:") ? raw0.trim() : `menu:${raw0.trim()}`;
    const d = byId.get(id);
    if (!d) {
      reasons.push(`"${raw0}" is not one of the listed dishes`);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ d, qty: portions(d, focus.party) });
  }
  const subtotal = items.reduce((n, i) => n + i.d.price * i.qty, 0);
  const count = items.reduce((n, i) => n + i.qty, 0);
  const mains = items.filter((i) => isMain(i.d)).length;
  if (!items.length) reasons.push("the plan has no dishes");
  if (subtotal > focus.budget) reasons.push(`these dishes come to ₹${subtotal} for the group (${items.map((i) => `${i.d.name} ₹${i.d.price * i.qty}`).join(", ")}), ₹${subtotal - focus.budget} more than the ₹${focus.budget} budget: leave out a dish or choose cheaper ones`);
  if (mains < mainsNeeded(focus.party)) reasons.push(`include at least ${mainsNeeded(focus.party)} main dishes (mains, tandoor or a biryani)`);
  if (items.length && count < focus.party) reasons.push(`add bread, rice or another dish so all ${focus.party} people eat`);
  const member = memberMain(focus.diet);
  if (member && !items.some((i) => isMain(i.d) && member(i.d))) reasons.push(focus.diet === "mixed_vegan" ? "include a vegan main dish for the vegan guest" : "include a vegetarian main dish for the vegetarian guest");
  if (relation === "cheaper" && focus.subtotal !== null && subtotal >= focus.subtotal) reasons.push(`the guest wants it cheaper than ₹${focus.subtotal}`);
  if (relation === "another" && focus.items.length && items.every((i) => focus.items.includes(i.d.id))) reasons.push("the guest wants different dishes from the last plan");
  return { reasons, items, subtotal };
}

/** Drinks, desserts and starters: what a meal can do without. */
const isExtra = (d: MenuEntry) => d.course === "drinks" || d.course === "desserts" || d.course === "small-plates";

/**
 * A plan over the budget only because of its extras: the model's meal without them, last added first, until it fits
 * and still passes every check; null otherwise. The guest is told what was left out. Nothing is added or swapped, and
 * the budget is never stretched.
 */
export function withoutExtras(raw: Plan, dishes: MenuEntry[], focus: PlanFocus, relation: "cheaper" | "another" | null): { v: ReturnType<typeof validatePlan>; left: MenuEntry[] } | null {
  const byId = new Map(dishes.map((d) => [d.id, d]));
  const ids = raw.dishes.map((x) => (x.startsWith("menu:") ? x.trim() : `menu:${x.trim()}`));
  const left: MenuEntry[] = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const d = byId.get(ids[i]);
    if (!d || !isExtra(d)) continue;
    left.push(d);
    const kept = ids.filter((id) => !left.some((l) => l.id === id));
    const v = validatePlan({ ...raw, dishes: kept }, dishes, focus, relation);
    if (!v.reasons.length) return { v, left };
  }
  return null;
}

/**
 * The model's one-line reason, shown only when it says nothing the app must not: no numbers, hype, safety promises or
 * bookings, no diet, allergen or attribute words (the card shows each dish's labels), no dish that isn't in the plan,
 * and nothing the claim checks reject.
 */
function safeNote(note: string, planned: MenuEntry[], menu: MenuEntry[]): string | null {
  const n = note.trim().replace(/\s+/g, " ");
  if (!n || n.length > 240 || !/[.!]$/.test(n) || /\d|₹/.test(n) || hypeClaims(n).length) return null;
  if (/\b(?:safe|vegan|vegetarian|veg|gluten|co?eliac|celiac|halal|kosher|jain|organic|keto|dairy|lactose|nuts?|egg|allerg\w*|free|table|book\w*|reserv\w*)\b/i.test(n)) return null;
  const lower = n.toLowerCase();
  if (menu.some((d) => !planned.includes(d) && lower.includes(d.name.toLowerCase()))) return null;
  if (claimProblems(n, planned, menu).length) return null;
  return n;
}

const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const groupWord = (n: number) => NUMBER[n] ?? String(n);

/**
 * The service-charge FAQ that applies, quoted as is (D-28: only verified charges): the branch's own, else one for every
 * branch. With no branch known and only branch-specific answers, none is quoted.
 */
function chargeNote(src: FactSource, branch: string | null): string | null {
  const id = branch ? (src.branches.find((b) => b.slug === branch)?.id ?? null) : null;
  const all = src.faq.filter((q) => /\bservice charge\b/i.test(q.question));
  const f = (id !== null ? all.find((q) => q.branchId === id) : undefined) ?? all.find((q) => q.branchId === null);
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
  const menuChip: Chip = { label: "Show me the menu", action: { type: "menu", course: null } };

  // An allergen the labels don't cover: no plan can be checked against it, so the guest is sent to staff (as on the
  // menu and recommendation paths).
  const referral = unlistedReferral(input.prefs);
  if (referral) return { text: referral.text, blocks: referral.blocks, focus, asked: false, cited: [] };
  // What they eat matters for the plan: one question per plan (D-28). Asked already and still not said: the guest's
  // own stated diet, else everything.
  if (focus.diet === null && !input.asked) {
    input.trace.push({ action: "ask_pref", args: { field: "plan_diet" } });
    return { text: `Happy to plan a meal for ${group} within ${rupees(focus.budget)}. Is everyone vegetarian, do you eat meat too, or is it a mix?`, blocks: [{ type: "quick_replies", chips: DIET_CHIPS }], focus, asked: true, cited: [] };
  }
  const plan: PlanFocus = { ...focus, diet: focus.diet ?? (input.prefs.diet.includes("vegan") ? "vegan" : input.prefs.diet.includes("vegetarian") ? "vegetarian" : "any") };
  const dishes = planDishes(input.entries, plan, input.prefs, input.branch);
  const floor = cheapestPlan(dishes, plan);
  input.trace.push({ action: "plan_scope", party: plan.party, budget: plan.budget, diet: plan.diet!, dishes: dishes.length, least: floor?.total ?? null });
  // Not enough for a meal at menu prices, or nothing that fits: said plainly, with the real figures, and no model call.
  if (!floor) return { text: `I couldn't find enough ${DIET_WORD[plan.diet!]}main dishes that fit to plan that meal. You can browse the menu instead.`, blocks: [{ type: "quick_replies", chips: [menuChip] }], focus: plan, asked: false, cited: [] };
  if (floor.total > plan.budget) {
    const cheapestMain = [...floor.mains].sort((a, b) => a.price - b.price)[0];
    return {
      text: `${rupees(plan.budget)} isn't enough for a meal for ${group} here: our lowest-priced ${DIET_WORD[plan.diet!]}main dish is the ${cheapestMain.name} at ${rupees(cheapestMain.price)}, and a meal needs ${mainsNeeded(plan.party) === 1 ? "one main" : `${groupWord(mainsNeeded(plan.party))} mains`} and enough for everyone.`,
      blocks: [{ type: "quick_replies", chips: [{ label: `Plan for ${rupees(floor.total)}`, text: `Our budget is ${rupees(floor.total)}` }, menuChip] }],
      focus: plan,
      asked: false,
      cited: [cheapestMain.id],
    };
  }
  // "Cheaper" when the last plan already costs the least a meal can: said, with no model call.
  if (relation === "cheaper" && plan.subtotal !== null && floor.total >= plan.subtotal) return { text: `That's already about the lowest-priced meal for ${group} on our menu.`, blocks: [{ type: "quick_replies", chips: [menuChip] }], focus: plan, asked: false, cited: [] };

  const relationLine =
    relation === "cheaper" && plan.subtotal !== null ? `The last plan came to ₹${plan.subtotal} (${plan.items.map((id) => id.slice(5)).join(", ")}); the guest wants a cheaper one: a total below ₹${plan.subtotal}, with a cheaper main or fewer dishes.` : relation === "another" && plan.items.length ? `The guest wants a different combination from the last plan (${plan.items.map((id) => id.slice(5)).join(", ")}).` : null;
  const lines: PlannerDish[] = dishes.map((d) => ({ id: d.id, name: d.name, courseLabel: d.courseLabel, price: d.price, labels: d.labels, contains: d.contains, spice: d.spice, description: d.description, scope: d.scope, qty: portions(d, plan.party) }));
  const needs = [...input.prefs.avoid, ...input.prefs.diet.filter((d) => d === "gluten-free" || d === "jain").map((d) => (d === "jain" ? "non-Jain dishes" : "gluten")), ...(input.prefs.exclude ?? [])];
  const messages: LlmMessage[] = [
    { role: "system", content: buildPlannerSystem(input.src.restaurant?.name ?? "the restaurant") },
    {
      role: "user",
      content: buildPlannerUser({ group, budget: budgetText, mains: mainsNeeded(plan.party), diet: plan.diet === "mixed" ? "a mix: some vegetarian, some eat meat" : plan.diet === "mixed_vegan" ? "a mix: one vegan, the others eat everything" : plan.diet === "any" ? "everything" : `${plan.diet} only`, avoid: needs.length ? needs.join(", ") : null, relation: relationLine, history: input.history, dishes: lines, guest: input.text }),
    },
  ];
  for (const attempt of [1, 2] as const) {
    if (input.canRetry && !input.canRetry()) break; // past the turn's time budget (FM-025)
    const r = await call(attempt, messages);
    if (!r.plan) {
      input.trace.push({ action: "plan", attempt, result: r.code, items: [], subtotal: null, rejected: [] });
      if (r.code === "MODEL_UNAVAILABLE" || r.code === "MODEL_TIMEOUT") break;
      continue;
    }
    const proposed = validatePlan(r.plan, dishes, plan, relation);
    // Over the budget only because of drinks, desserts or starters: the meal without them (said in the reply).
    const trimmed = proposed.reasons.length ? withoutExtras(r.plan, dishes, plan, relation) : null;
    const v = trimmed?.v ?? proposed;
    input.trace.push({ action: "plan", attempt, result: v.reasons.length ? "rejected" : trimmed ? "trimmed" : "ok", items: v.items.map((i) => `${i.d.id}×${i.qty}`), subtotal: v.subtotal, rejected: proposed.reasons });
    if (!v.reasons.length) {
      const note = safeNote(r.plan.note, v.items.map((i) => i.d), input.entries);
      const charge = chargeNote(input.src, input.branch);
      const caveats = ["Menu prices. I don't have tax details, so the bill may differ.", "Portions: a main dish is shared by two, a bread is one each.", ...(charge ? [charge] : [])];
      // What's left of the budget is on the card; the line gives the total and the budget only.
      const lead = `Here's a ${DIET_WORD[plan.diet!]}meal for ${group} that comes to ${rupees(v.subtotal)}, within your ${rupees(plan.budget)}.`;
      const items = v.items.map((i) => ({ ...view(i.d), qty: i.qty }));
      const leftOut = trimmed ? ` I left out the ${join(trimmed.left.reverse().map((d) => d.name))} to stay within your budget.` : "";
      return {
        text: `${lead}${leftOut}${note && !trimmed ? ` ${note}` : ""}`,
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
    blocks: [{ type: "quick_replies", chips: [menuChip] }],
    focus: plan,
    asked: false,
    cited: [],
  };
}
