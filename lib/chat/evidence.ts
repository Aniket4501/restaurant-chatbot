import { ALLERGY_NOTE, describePrefs, hasPrefs, needsAllergyNote, servedAt, unlistedReferral, unmet, view, type MenuEntry } from "@/lib/chat/menu";
import { courseIn, DIET_CHIPS, DIET_QUESTION, SAFETY_QUESTION } from "@/lib/chat/recommend";
import type { Block, Chip, Course, Prefs, TraceEntry, TurnContext } from "@/lib/chat/types";

// Popularity, review and evidence questions (D-26). "What is your best seller?", "most popular dessert?", "which dish
// has the best reviews?", "do you have sales data for that?" are factual questions, not requests to choose. The data
// has no sales figures, ratings or reviews; the only evidence is a dish staff mark as a bestseller in the admin. So
// they are answered in code from that mark: the marked dishes that fit the question, or an honest "we don't keep
// that" with an offer to suggest something instead. Nothing here infers popularity from a description, a price or
// the model's judgment. "What's your best dish?" is not one of these: it is subjective, so it takes the
// recommendation path.

export type EvidenceKind = "sales" | "reviews" | "evidence";

// Popularity of food: a dish, a course or "on the menu" is the subject (review of D-26: bare "popular" caught "is
// Saturday a popular time?" and "is Hauz Khas popular?").
const SALES = /\b(?:best[- ]?sell(?:er|ers|ing)|top[- ]sell(?:er|ers|ing)|(?:best|top|biggest)[- ]?(?:[a-z]+[- ]){0,2}?sell(?:er|ers|ing)|sells? (?:the )?(?:most|best)|most (?:popular|ordered|loved|liked|requested|famous) (?:dish|dishes|item|items|food|dessert|desserts|main|mains|course|starter|starters|drink|drinks|thing|one|on the menu)|(?:what|which)(?:'s| is| are)? (?:your |the )?most (?:popular|ordered|loved|liked|requested|famous)\b(?! (?:time|day|night|branch|location|place|hours?))|(?:what|which) (?:dish|dishes|item|items|food|dessert|desserts|main|mains|starter|starters|drink|drinks|one) (?:is|are|sells?|gets? ordered) (?:the )?most(?: (?:popular|ordered|loved|liked|requested|famous|often))?\b|popular (?:dish|dishes|item|items|food|dessert|desserts|main|mains|starter|starters|drink|drinks|choice|choices|on the menu)|popularity|(?:fan|guest|customer|crowd)(?:'s|s')? favou?rites?|signature (?:dish|dishes)|what (?:do|does) (?:most )?(?:people|guests|everyone|customers|others) (?:usually |normally |mostly |tend to )?(?:order|get|eat|choose|pick))\b/i;
const IS_POPULAR = /\bis (?:the |your )?([a-z][a-z' -]{2,40}?) (?:very |really |quite )?popular\b(?! (?:time|day|night|place|branch|location|spot|hours?|area))/i;
// Reviews and ratings of food, in so many words (failure-mode audit FM-023: "star anise", "spice rating" and "hygiene
// rating" were answered "we don't collect reviews").
const REVIEWS = /\b(?:reviews?|reviewed|(?:best|highest|well|top|most|poorly|badly)[- ]rated|rated (?:the )?(?:best|highest|well|top)|star ratings?|(?:customer|guest|online|google|zomato|swiggy) ratings?|ratings? (?:of|for|on) (?:the )?(?:dish|dishes|food|menu)|how (?:is|are) (?:the |your )?[a-z' ]{2,40} rated)\b/i;
const NOT_REVIEWS = /\bstar anise\b|\b(?:spice|heat|hygiene|chilli|chili|fssai) ratings?\b|\brated (?:the )?(?:spiciest|hottest|mildest|for kids|for children)\b/i;
const FOOD_CONTEXT = /\b(?:dish|dishes|food|menu|item|items|dessert|desserts|main|mains|starter|starters|drink|drinks|curry|curries|biryani|best|top|highest|which|what)\b/i;
// The restaurant's "own" dish: the menu names none (FM-001: "chef's special?" got a dish presented as the answer).
const SIGNATURE = /\bchef'?s (?:special|speciality|specialty|choice|pick)\b|\b(?:your|the) (?:speciality|specialty)\b|\bsignature (?:dish|dishes)\b|\b(?:famous|known) for\b|\bwhat do (?:your )?(?:regulars|locals|people|most people) (?:usually )?order\b/i;
// Asking for data in so many words.
const DATA_ASK = /\b(?:sales (?:data|figures|numbers|records)|data (?:to (?:support|back)|behind|for that)|any (?:data|evidence|proof)|actual (?:data|evidence|numbers))\b/i;
// Challenging the last suggestion: only right after one, and not about hours, safety or a booking.
const CHALLENGE = /\b(?:how do you know|based on what|what (?:is|'s) that based on|is that (?:really )?(?:popular|a bestseller|true|right))\b/i;
const OTHER_TOPIC = /\b(?:open|close|hours?|timings?|safe|allerg\w*|book\w*|table|reservation|parking|address|vegan|vegetarian|gluten|jain|dairy|nuts?|eggs?|spicy|price|cost|₹|contain\w*|ingredients?)\b/i;
// A popularity statement in the last reply: the only thing "is that true?" can challenge as popularity (FM-023).
const POPULARITY_SAID = /\bbest[- ]?sell|\bpopular|\bsales\b|\breviews?\b|\brated\b|\bfavou?rite|\b(?:guests|people|everyone|customers) (?:love|adore|order)/i;

/**
 * The kind of popularity question the message asks, or null. `suggested`: a dish was suggested in this conversation;
 * `dishes`: the menu's dish names, so "is the butter chicken popular?" counts and "is Hauz Khas popular?" doesn't.
 */
export function evidenceQuestion(text: string, suggested = false, dishes: string[] = [], lastReply = ""): EvidenceKind | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const challenge = CHALLENGE.test(t) && !OTHER_TOPIC.test(t) && (/\bpopular|\bbest[- ]?sell/.test(t) || (suggested && POPULARITY_SAID.test(lastReply)));
  if (DATA_ASK.test(t) || challenge) return "evidence";
  if (REVIEWS.test(t) && !NOT_REVIEWS.test(t) && FOOD_CONTEXT.test(t)) return "reviews";
  if (SALES.test(t) || SIGNATURE.test(t)) return "sales";
  const m = IS_POPULAR.exec(t);
  const subject = m?.[1].trim() ?? "";
  if (m && (FOOD_CONTEXT.test(subject) || dishes.some((n) => n.toLowerCase().includes(subject.replace(/^(?:the|your) /, "")) || subject.includes(n.toLowerCase())))) return "sales";
  return null;
}

const ONE: Record<Course, string> = { "small-plates": "small plate", tandoor: "tandoor dish", mains: "main course", "breads-rice": "bread or rice dish", desserts: "dessert", drinks: "drink" };

/** "vegetarian dessert", "dish": what the guest asked about, in the singular. */
function what(p: Prefs): string {
  const diet = p.diet.filter((d) => d !== "jain").join(" ");
  return `${diet ? `${diet} ` : ""}${p.course ? ONE[p.course] : "dish"}`;
}
const article = (s: string) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);
const names = (ds: MenuEntry[]) => (ds.length === 1 ? `the ${ds[0].name}` : `${ds.slice(0, -1).map((d) => `the ${d.name}`).join(", ")} and the ${ds.at(-1)!.name}`);

export type EvidenceResult = { text: string; blocks: Block[]; cited: string[]; asked?: "diet"; recommended?: string[] };

export function evidenceStep(input: { kind: EvidenceKind; text: string; prefs: Prefs; entries: MenuEntry[]; context: Partial<TurnContext> | undefined; branch: string | null; trace: TraceEntry[] }): EvidenceResult {
  const p: Prefs = { ...input.prefs, course: input.prefs.course ?? courseIn(input.text) };
  // Allergies apply here as on every food path (review of D-26): an allergen the labels can't cover goes to staff, and
  // the note shows when it hasn't for these allergies, or the guest asks about safety.
  const referral = unlistedReferral(p);
  if (referral) return { text: referral.text, blocks: referral.blocks, cited: [] };
  const note: Block[] = needsAllergyNote(p) && (!input.context?.allergyNoted || SAFETY_QUESTION.test(input.text)) ? [{ type: "notice", tone: "info", text: ALLERGY_NOTE }] : [];
  const withNote = (r: EvidenceResult): EvidenceResult => ({ ...r, blocks: [...note, ...r.blocks] });
  return withNote(answer(input, p));
}

function answer(input: { kind: EvidenceKind; text: string; prefs: Prefs; entries: MenuEntry[]; context: Partial<TurnContext> | undefined; branch: string | null; trace: TraceEntry[] }, p: Prefs): EvidenceResult {
  const marked = input.entries.filter((e) => e.bestseller && e.available && servedAt(e, input.branch));
  const fit = marked.filter((e) => unmet(e, { ...p, maxPrice: p.maxPrice }) === null);
  input.trace.push({ action: "evidence", args: { kind: input.kind, bestsellers: fit.length } });
  const w = what(p);
  const asked = input.context?.asked ?? [];
  // The way on: a suggestion that suits the guest. With nothing known, one question about diet (asked once), as for
  // "recommend something"; otherwise a chip that asks for a suggestion of what they asked about.
  const offer = (): { text: string; blocks: Block[]; asked?: "diet" } => {
    if (!hasPrefs(p) && !p.allergy && !asked.includes("diet")) return { text: ` ${DIET_QUESTION.replace(/^Happy to help\. /, "I can suggest something that suits you instead. ")}`, blocks: [DIET_CHIPS()], asked: "diet" };
    const chip: Chip = { label: `Suggest ${article(w)}`, text: `Suggest ${article(w)}${p.maxPrice !== null ? ` up to ₹${p.maxPrice}` : ""}` };
    return { text: ` I can suggest ${article(w)} that suits you instead.`, blocks: [{ type: "quick_replies", chips: [chip, { label: "Show me the menu", action: { type: "menu", course: p.course } }] }] };
  };
  const card = (ds: MenuEntry[]): Block => ({ type: "recommendation", lead: false, items: ds.slice(0, 3).map(view) });

  // "Is the Dal Ember popular?", "how is the Dal Ember rated?": about one dish. A review question never gets a "yes"
  // (there are no reviews); a marked dish is offered only if it is available, served here and fits the guest's needs.
  const named = input.entries.filter((e) => new RegExp(`\\b${e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(input.text));
  if (named.length === 1 && input.kind !== "evidence") {
    const d = named[0];
    const reviews = input.kind === "reviews";
    if (!d.bestseller)
      return { text: reviews ? `We don't collect reviews or ratings, so I can't say how the ${d.name} is rated.` : `We don't keep sales figures, ratings or reviews, so I can't say how popular the ${d.name} is. The restaurant hasn't marked it as a bestseller.`, blocks: [], cited: [d.id] };
    const head = reviews ? `We don't collect reviews or ratings. The restaurant does mark the ${d.name} as a bestseller` : `Yes: the restaurant marks the ${d.name} as a bestseller`;
    const reason = !d.available ? "it's currently unavailable" : !servedAt(d, input.branch) ? "it isn't served at this branch" : unmet(d, { ...p, course: null, maxPrice: null });
    if (reason) return { text: `${head}, but ${reason.startsWith("it") ? reason : `it doesn't suit you: ${reason}`}.`, blocks: [], cited: [d.id] };
    return { text: `${head}.`, blocks: [card([d])], cited: [d.id], recommended: [d.id] };
  }

  if (input.kind === "evidence") {
    const lastId = input.context?.recommended?.[0] ?? null;
    const last = lastId ? input.entries.find((e) => e.id === lastId) ?? null : null;
    // A marked dish: the mark is the only evidence there is, and it is said first (review of D-26).
    if (last?.bestseller) return { text: `The restaurant marks the ${last.name} as a bestseller; beyond that we don't keep sales figures, ratings or reviews.`, blocks: [], cited: [last.id] };
    const why = last ? ` I suggested the ${last.name} ${hasPrefs(input.prefs) ? `because it fits what you asked for (${describePrefs(input.prefs)})` : "from its menu description, not from popularity"}.` : " My suggestions come from the menu and what you tell me.";
    return { text: `No, we don't keep sales or popularity figures, ratings or reviews.${why}`, blocks: [], cited: last ? [last.id] : [] };
  }

  if (input.kind === "reviews") {
    const head = `We don't collect reviews or ratings, so I can't say which ${w} is rated best.`;
    if (fit.length) return { text: `${head} The restaurant does mark ${names(fit.slice(0, 3))} as ${fit.length === 1 ? "a bestseller" : "bestsellers"}.`, blocks: [card(fit)], cited: fit.slice(0, 3).map((d) => d.id), recommended: fit.slice(0, 3).map((d) => d.id) };
    const o = offer();
    return { text: `${head}${o.text}`, blocks: o.blocks, cited: [], asked: o.asked };
  }

  // "Chef's special?", "what are you famous for?": the menu names no signature dish (FM-001). Staff bestseller marks are
  // a different thing and are offered as such.
  if (SIGNATURE.test(input.text) && !SALES.test(input.text.toLowerCase())) {
    const o = offer();
    const head = "The menu doesn't name a chef's special or a signature dish, so I can't point to one.";
    if (fit.length) return { text: `${head} The restaurant does mark ${names(fit.slice(0, 3))} as ${fit.length === 1 ? "a bestseller" : "bestsellers"}.`, blocks: [card(fit)], cited: fit.slice(0, 3).map((d) => d.id), recommended: fit.slice(0, 3).map((d) => d.id) };
    return { text: `${head}${o.text}`, blocks: o.blocks, cited: [], asked: o.asked };
  }
  // Sales and popularity.
  if (fit.length) {
    const among = p.course || p.diet.length ? `Of the ${w}${w.endsWith("sh") ? "es" : "s"}, the` : "The";
    const shown = fit.slice(0, 3);
    return { text: `${among} restaurant marks ${names(shown)} as ${shown.length === 1 ? "a bestseller" : "bestsellers"}.`, blocks: [card(shown)], cited: shown.map((d) => d.id), recommended: shown.map((d) => d.id) };
  }
  const o = offer();
  if (marked.length) return { text: hasPrefs({ ...p, course: null, diet: [] }) ? `None of the dishes the restaurant marks as bestsellers fits what you asked for (${describePrefs(p)}).${o.text}` : `None of the dishes the restaurant marks as bestsellers is ${article(w)}.${o.text}`, blocks: o.blocks, cited: [], asked: o.asked };
  return { text: `We don't keep sales or popularity figures, so I can't say which ${w} sells best.${o.text}`, blocks: o.blocks, cited: [], asked: o.asked };
}
