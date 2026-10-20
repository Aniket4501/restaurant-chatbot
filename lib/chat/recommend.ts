import { checkGrounding, type GroundingContext } from "@/lib/chat/grounding";
import { smalltalkShowable } from "@/lib/chat/claims";
import { ALLERGY_NOTE, describePrefs, eligible as eligibleAll, hasPrefs, unlistedReferral, unmet, view, type MenuEntry } from "@/lib/chat/menu";
import { AVOIDS, DIETS, noPrefs, PrefsSchema, UNLISTED, type Action, type Block, type Prefs, type TraceEntry, type TurnContext } from "@/lib/chat/types";
import { buildChooserSystem, buildChooserUser, chooserCorrection, type Choice } from "@/lib/llm/chooser";
import type { ChatMessage as LlmMessage } from "@/lib/llm/client";
import { priceSpans } from "@/lib/kb/canonical";
import { foldDigits } from "@/lib/llm/redact";
import type { Turn } from "@/lib/llm/schema";

// Recommendations (D-20). The model reasons; code keeps it honest.
// 1. The first model call says the guest wants a recommendation and proposes their active preferences. Code adds only
//    what the guest's own words state for certain (a budget, a diet, "not spicy", an allergy), so a stated constraint
//    can't be dropped.
// 2. Code narrows the menu to the dishes that meet those constraints (lib/chat/menu.ts: filtering, never ranking).
// 3. The chooser call compares those dishes and picks one, with up to two alternatives and a short reason.
// 4. Code validates the choice: the dish is on the narrowed list, the reply names it, every price is real, and there
//    are no booking words, invented popularity or unsupported diet or allergy claims. One retry with the reasons;
//    then an honest fallback that never pretends a choice was made.

type Diet = Prefs["diet"][number];
type Avoid = Prefs["avoid"][number];
type Unlisted = Prefs["unlisted"][number];
/** What the guest's own words state for certain (D-20), plus a follow-up relation and allergens the labels can't cover. */
export type Stated = Partial<Omit<Prefs, "unlisted">> & { unlisted?: Unlisted[]; relation?: "cheaper" | "another" };

const clean = (raw: string) => foldDigits(raw).toLowerCase().replace(/[’‘]/g, "'");
// A word right after one of these (up to two words between: "not really vegetarian", "not suitable for vegans") is negated.
const NEG_BEFORE = String.raw`(?<!\b(?:non|not|no|nothing|never|isn't|aren't|nor|forget|drop|ignore)[- ](?:\w+ ){0,2})`;
const NUTS = String.raw`(?:pea|ground|wal|hazel|pine|tree[- ]?)?nuts?|cashews?|almonds?|pistachios?`;
const DAIRY_ALLERGY = String.raw`dairy|lactose|milk`;
const DAIRY_FOOD = String.raw`dairy|lactose|milk|cream|paneer|ghee|cheese`;
const EGG = String.raw`eggs?`;
const ALLERGY_WORD = /\ballerg(?:y|ic|ies)\b|\banaphyla/;
const NO_ALLERGY = /\bno (?:food )?allerg(?:y|ies)\b|\bnot allergic(?: to \w+)?\b|\bwithout (?:any )?allerg\w*/;
const COELIAC = /\bco?eliac\b|\bceliac\b|\bgluten (?:allerg|intoleran)\w*|\ballergic to (?:gluten|wheat)\b|\bwheat allerg\w*/;
// "no nuts", "can't eat dairy", "without egg", "nut-free", "egg allergy": the avoidance is tied to the allergen.
const avoids = (food: string) => new RegExp(String.raw`\b(?:no|without|avoid(?:ing)?|skip|hold the|can't (?:eat|have)|cannot (?:eat|have)|don't (?:eat|want)|free (?:of|from))\s+(?:any |the )?(?:\w+ (?:or|and|,) )?(?:${food})\b|\b(?:${food})[- ]free\b|\b(?:${food}) (?:allerg|intoleran)\w*`);
const UNLISTED_RE: [Unlisted, RegExp][] = [
  ["shellfish", /\bshellfish\b|\bprawns?\b|\bshrimps?\b|\bcrabs?\b|\blobsters?\b|\bmolluscs?\b|\bcrustaceans?\b/],
  ["fish", /\bfish\b/],
  ["seafood", /\bseafood\b/],
  ["soy", /\bsoy(?:a|bean)?s?\b/],
  ["sesame", /\bsesame\b|\btil\b/],
  ["mustard", /\bmustard\b/],
  ["mushroom", /\bmushrooms?\b/],
  ["coconut", /\bcoconuts?\b/],
];
const NOT_AN_ALLERGEN = new Set(["no", "any", "is", "has", "have", "with", "a", "an", "my", "the", "some", "any", "severe", "serious", "bad", "mild", "food", "real", "life", "many", "few", "certain", "known", "slight", "major", "minor", "this", "that", "it", "something", "things", "stuff", "several"]);

export function explicitPrefs(raw: string): Stated {
  const t = clean(raw);
  const out: Stated = {};
  const budget = /\b(?:under|below|less than|within|up ?to|max(?:imum)?|no more than|not more than|budget(?: of| is)?)\s*(?:₹|rs\.?\s*|inr\s*)?(\d{2,5})\b(?!\s*(?:people|persons?|guests?|pax|of us|kids?|children|adults?|years?|yrs?|mins?|minutes?|hours?|hrs?|pm|am|o'?clock|km|%|percent))|(?:₹|rs\.?\s*)(\d{2,5})\s*(?:or less|max|tops)\b/.exec(t);
  if (budget) out.maxPrice = Number(budget[1] ?? budget[2]);
  const diet: Diet[] = [];
  if (new RegExp(`${NEG_BEFORE}\\bvegans?\\b`).test(t)) diet.push("vegan");
  if (new RegExp(`${NEG_BEFORE}\\b(?:vegetarians?|veggie|veg)\\b`).test(t) || NO_MEAT.test(t)) diet.push("vegetarian");
  if (/\bgluten[- ]free\b|\bno gluten\b|\bcoeliac\b|\bceliac\b|\bgluten (?:allerg|intoleran)\w*|\ballergic to (?:gluten|wheat)\b|\bwheat allerg\w*|\bcan't (?:eat|have) (?:gluten|wheat)\b/.test(t)) diet.push("gluten-free");
  if (/\bjain\b/.test(t)) diet.push("jain");
  if (diet.length) out.diet = diet;
  if (/\bnot (?:too |very |that |so )?spicy\b|(?<!\b(?:not|nothing|no) (?:too |so |very )?)\bmild\b|\bless spicy\b|\bno spice\b|\bnon[- ]spicy\b/.test(t)) out.mild = true;
  // "No allergies for me, but my daughter is allergic to peanuts" (D-21 audit): the negated phrase is removed before
  // looking for an allergy, so it cancels nothing stated elsewhere in the message. Coeliac is a medical need too: the
  // kitchen handles gluten, so the allergy note applies.
  const positive = t.replace(new RegExp(NO_ALLERGY.source, "g"), " ");
  const allergy = ALLERGY_WORD.test(positive) || COELIAC.test(t);
  if (allergy) out.allergy = true;
  const avoid: Avoid[] = [];
  if ((allergy && new RegExp(`\\b(?:${NUTS})\\b`).test(t)) || avoids(NUTS).test(t)) avoid.push("nuts");
  if ((allergy && new RegExp(`\\b(?:${DAIRY_ALLERGY})\\b`).test(t)) || avoids(DAIRY_FOOD).test(t) || /\blactose[- ]intoleran\w*/.test(t)) avoid.push("dairy");
  if ((allergy && new RegExp(`\\b${EGG}\\b`).test(t)) || avoids(EGG).test(t)) avoid.push("egg");
  if (avoid.length) out.avoid = avoid;
  if (allergy) {
    const unlisted = UNLISTED_RE.filter(([, re]) => re.test(t)).map(([u]) => u);
    // "allergic to kiwi": an allergen nobody can check against the labels.
    // Read from the message without its "no allergies" phrases, so "no" is never taken for an allergen (D-21 audit).
    const named = [...positive.matchAll(/\ballergic to (?:\w+ )?(\w+)|\b(\w+) allerg(?:y|ies)\b/g)].map((m) => m[1] ?? m[2]).filter((w) => !NOT_AN_ALLERGEN.has(w));
    const covered = new RegExp(`^(?:${NUTS}|${DAIRY_ALLERGY}|${DAIRY_FOOD}|${EGG}|gluten|wheat|nut|peanut|tree)$`);
    if (!unlisted.length && named.some((w) => !covered.test(w) && !UNLISTED_RE.some(([, re]) => re.test(w)))) unlisted.push("other");
    if (unlisted.length) out.unlisted = unlisted;
  }
  if (/^anything cheaper\??$|\bcheaper\b|\bless expensive\b|\bmore affordable\b|\blower[- ]priced?\b/.test(t)) out.relation = "cheaper";
  else if (/^show me another option$|\banother (?:one|option|dish|suggestion|idea)\b|\bsomething (?:else|different)\b|\bother options?\b/.test(t)) out.relation = "another";
  return out;
}

/** Constraints the guest's words lift ("I'm not vegetarian", "price doesn't matter", "spicy is fine", "no allergies"). */
export function liftedPrefs(raw: string): { diet: Diet[]; maxPrice: boolean; mild: boolean; allergy: boolean; avoid: Avoid[] } {
  const t = clean(raw);
  const noMeat = NO_MEAT.test(t);
  const meat = !ALLERGY_WORD.test(t) && !noMeat && /(?<!\b(?:no|not|without|avoid|than|any|eat|or|nor|with|of the|instead of) )\b(?:chicken|mutton|lamb|goat|fish|prawns?|shrimps?|meat|keema|seafood|pork|beef|non[- ]?veg\w*)\b/.test(t);
  const diet: Diet[] = [];
  if (meat || /\bnot (?:a |really |strictly |fully )?(?:vegetarian|veg|veggie)\b|(?<!\b(?:don't|do not|never|can't|cannot|won't) )\b(?:i )?eat (?:meat|everything|anything)\b|\b(?:forget|drop|ignore|never ?mind) (?:the )?(?:veg\w*)\b/.test(t)) diet.push("vegetarian", "vegan");
  else if (/\bnot (?:a |really |strictly |fully )?vegan\b|\b(?:forget|drop|ignore|never ?mind) (?:the )?vegan\b/.test(t)) diet.push("vegan");
  const maxPrice = /\bprice (?:doesn't|does not|isn't|is not) (?:matter|an issue|a concern)|\bno budget\b|\bany (?:price|budget)\b|\bmoney is no (?:object|issue)|\bbudget (?:doesn't|does not) matter|\bdon't (?:care|worry) about (?:the )?(?:price|cost|budget)|\bsplurge\b|\bforget (?:the |my )?budget\b|\bexpensive is (?:fine|ok|okay)\b/.test(t);
  const mild = /\b(?:nothing|not) (?:too |so )?mild\b|\bspicier\b|\b(?:like|love|want|prefer) (?:it )?(?:spicy|hot|heat)\b|\b(?:extra|very|really) spicy\b|\bspic(?:y|e) (?:is )?(?:fine|ok|okay|good)\b|\bsomething (?:spicy|hot|fiery)\b/.test(t);
  // Lifted only when the message states no allergy anywhere else ("no allergies, but I'm allergic to nuts" lifts nothing).
  const allergy = NO_ALLERGY.test(t) && !ALLERGY_WORD.test(t.replace(new RegExp(NO_ALLERGY.source, "g"), " "));
  const avoid: Avoid[] = [];
  const canEat = (food: string) => new RegExp(String.raw`\bcan (?:eat|have) (?:${food})\b|\b(?:${food}) (?:is|are) (?:fine|ok|okay)\b`).test(t);
  if (allergy || canEat(NUTS)) avoid.push("nuts");
  if (allergy || canEat(DAIRY_FOOD)) avoid.push("dairy");
  if (allergy || canEat(EGG)) avoid.push("egg");
  return { diet, maxPrice, mild, allergy, avoid };
}

// "I don't eat meat", "no meat or fish", "nothing with chicken", "meat-free": vegetarian, stated (D-21 audit).
const NO_MEAT = /\b(?:don't|do not|never|can't|cannot|won't) eat (?:any )?(?:meat|chicken|fish|seafood|non[- ]?veg)\b|\bno (?:meat|chicken|fish|non[- ]?veg)\b|\bnothing with (?:meat|chicken|fish)\b|\bmeat[- ]?free\b|\bmeatless\b/;

const SPICE_WORD = /\bspic|\bmild\b|\bheat\b|\bhot\b|\bchill?i|\bkick\b|\bbland\b|\bfiery\b/i;

/**
 * Active preferences after this turn (D-20, review). The model proposes them; code keeps them honest:
 * - what the guest's words state for certain is always added;
 * - diet, budget, mild, an allergy and its allergens stay in force from earlier turns unless the guest lifts them
 *   (the model dropping one is not enough);
 * - a budget needs a number in the guest's words, and "mild" a word about spice, so the model can't invent either.
 */
export function resolvePrefs(model: Turn["prefs"], previous: Prefs | null | undefined, text: string): { prefs: Prefs; added: string[] } {
  const prev = previous ?? noPrefs();
  const ex = explicitPrefs(text);
  const lift = liftedPrefs(text);
  const m = model ? { diet: model.diet, avoid: model.avoid, maxPrice: model.maxPrice && model.maxPrice > 0 ? model.maxPrice : null, course: model.course, mild: model.mild, allergy: model.allergy } : prev;
  const keep = <T,>(xs: T[], lifted: T[]) => xs.filter((x) => !lifted.includes(x));
  const relation = model?.relation ?? ex.relation ?? null;
  const digits = /\d/.test(foldDigits(text));
  const prefs: Prefs = PrefsSchema.parse({
    diet: DIETS.filter((d) => ex.diet?.includes(d) || keep([...m.diet, ...prev.diet], lift.diet).includes(d)),
    avoid: AVOIDS.filter((a) => ex.avoid?.includes(a) || keep([...m.avoid, ...prev.avoid], lift.avoid).includes(a)),
    maxPrice: ex.maxPrice ?? (lift.maxPrice ? null : digits && m.maxPrice !== null ? m.maxPrice : prev.maxPrice),
    course: m.course ?? (relation ? prev.course : null),
    mild: !!ex.mild || (!lift.mild && (prev.mild || (m.mild && SPICE_WORD.test(text)))),
    allergy: !!ex.allergy || (!lift.allergy && (prev.allergy || m.allergy)),
    unlisted: UNLISTED.filter((u) => ex.unlisted?.includes(u) || (!lift.allergy && prev.unlisted.includes(u))),
  });
  // What code changed relative to the model's proposal, for the trace.
  const added = [
    ...prefs.diet.filter((d) => !m.diet.includes(d)),
    ...m.diet.filter((d) => !prefs.diet.includes(d)).map((d) => `not ${d}`),
    ...prefs.avoid.filter((a) => !m.avoid.includes(a)).map((a) => `no ${a}`),
    ...(prefs.maxPrice !== m.maxPrice ? [prefs.maxPrice === null ? "no budget" : `up to ₹${prefs.maxPrice}`] : []),
    ...(prefs.mild !== m.mild ? [prefs.mild ? "mild" : "not mild"] : []),
    ...(prefs.allergy && !m.allergy ? ["allergy"] : []),
    ...prefs.unlisted.map((u) => `unlisted allergen: ${u}`),
  ];
  return { prefs, added };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Claims the menu can't support (rule 4 of the chooser prompt), unless the dish's own description says so.
const HYPE_RE = /\b(?:most popular|popular|best[- ]?sell\w*|favou?rites?|signature|chef'?s (?:special|choice|pick|recommendation|speciality|specialty)|chef recommends|award[- ]winning|famous|highly rated|top[- ]rated|must[- ]try|crowd[- ]pleaser|speciality|specialty|house (?:special|classic|favou?rite)|everyone(?:'s)? (?:loves?|favou?rite)|(?:much|well)[- ]loved|loved by|guests love|people love|go-to)\b/i;
// Allergen safety can't be confirmed from labels (ALLERGY_NOTE): no "safe", no "nut-free", no "contains no nuts".
// Also "doesn't contain any nuts", "suits your allergy", "fine for an allergy" (D-21 audit). Shared with the FAQ path.
export const SAFETY_RE = /\bsafe(?:ly|r|st)?\b|\ballerg(?:y|en)[- ](?:free|friendly|safe)\b|\b(?:pea)?nut[- ]free\b|\bwon't (?:trigger|affect|cause|bother)\b|\bharmless\b|\bfree (?:of|from) (?:any )?(?:allergens?|(?:pea|tree )?nuts?|traces?|sesame|gluten|shellfish|soy)\b|\b(?:no|without|zero) (?:any )?(?:(?:pea|tree )?nuts?|allergens?|traces?)\b|\b(?:doesn't|does not|don't|do not|has no|have no|won't|will not)\s+(?:contain|have|include|use)\s+(?:any\s+)?(?:(?:pea|tree )?nuts?|allergens?|traces?|sesame|shellfish|soy|gluten|mustard)\b|\b(?:suits?|fine for|ok(?:ay)? for|good for|works for)\s+(?:your|an?|the)\s+(?:\w+\s+)?allerg\w*/i;
// A diet word must be true of the dish it describes (the nearest dish named before it in the sentence, else after).
const DIET_WORDS: { re: RegExp; label: string; has: (d: MenuEntry) => boolean }[] = [
  { re: /\bvegans?\b|\bplant[- ]based\b/gi, label: "vegan", has: (d) => d.dietary.includes("vegan") },
  { re: /\bvegetarians?\b|\bveg\b|\bveggie\b|\bmeat[- ]?free\b|\bmeatless\b/gi, label: "vegetarian", has: (d) => d.dietary.includes("vegetarian") || d.dietary.includes("vegan") },
  { re: /\bgluten[- ]free\b|\bno gluten\b|\bwithout gluten\b/gi, label: "labelled gluten-free", has: (d) => d.dietary.includes("gluten-free") },
  { re: /\bjain\b/gi, label: "a Jain option", has: (d) => d.dietary.includes("jain-available") },
  // Only a vegan dish is known to have no dairy or egg.
  { re: /\b(?:dairy|egg|milk|lactose)[- ]free\b|\b(?:no|without|zero) (?:any )?(?:dairy|milk|cream|ghee|paneer|cheese|lactose|eggs?)\b|\b(?:free (?:of|from)) (?:any )?(?:dairy|milk|eggs?)\b|\b(?:doesn't|does not|has no|won't)\s+(?:contain|have|include|use)\s+(?:any\s+)?(?:dairy|milk|cream|ghee|cheese|eggs?)\b/gi, label: "vegan (the only dishes known to have no dairy or egg)", has: (d) => d.dietary.includes("vegan") },
];
const NEGATED = /\b(?:not|isn't|aren't|non|nor|never|no)[- ](?:\w+ ){0,2}$/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Where a dish is named in the text: its full name, or for names of three words or more, its first or last two words
 * ("Pistachio Kulfi" for "Ember Pistachio Kulfi", as the model writes it) unless another dish's name contains them
 * too ("Dum Biryani").
 */
function nameRe(d: MenuEntry, partial: boolean, menu: MenuEntry[]): RegExp {
  const words = norm(d.name).split(" ");
  const join = (ws: string[]) => ws.map((w) => (w === "and" ? "(?:and|&)" : escapeRe(w))).join("[^a-z0-9₹]+");
  const shorts = partial && words.length >= 3 ? [words.slice(0, 2), words.slice(-2)].filter((ws) => !menu.some((o) => o.id !== d.id && ` ${norm(o.name)} `.includes(` ${ws.join(" ")} `))) : [];
  const alts = [join(words), ...shorts.map(join)];
  return new RegExp(`(?<![a-z0-9])(?:${alts.join("|")})(?![a-z0-9])`, "gi");
}
type Mention = { d: MenuEntry; start: number; end: number };
function mentionsOf(text: string, dishes: MenuEntry[], partial: boolean, menu: MenuEntry[]): Mention[] {
  return dishes.flatMap((d) => [...text.matchAll(nameRe(d, partial, menu))].map((m) => ({ d, start: m.index, end: m.index + m[0].length }))).sort((a, b) => a.start - b.start);
}

// Main ingredients that define a dish. Named after a dish in the same sentence, one must be in that dish's own name or
// description ("The Chana Pindi is a vegan paneer dish" is false: it is chickpeas; D-21 baseline LV-GRD-011).
const INGREDIENTS = ["paneer", "chicken", "lamb", "mutton", "goat", "prawn", "shrimp", "fish", "crab", "lobster", "egg", "mushroom", "chickpea", "lentil", "beef", "pork", "tofu", "soya", "keema", "potato", "broccoli", "kale", "beetroot", "aubergine", "baingan", "cauliflower"];
const INGREDIENT_RE = new RegExp(`\\b(${INGREDIENTS.join("|")})(?:e?s)?\\b`, "gi");

/**
 * Claims in model prose that the menu data doesn't support, tied to the dish each is about (the nearest dish named
 * before it in the sentence, else after, else the only dish cited): allergen safety, diet labels, main ingredients.
 * Used for FAQ answers (D-21 audit: "Yes, the Mango Sorbet is safe", "the Dal Ember is vegan" were shown).
 */
export function claimProblems(text: string, dishes: MenuEntry[], menu: MenuEntry[]): string[] {
  const reasons: string[] = [];
  if (SAFETY_RE.test(text)) reasons.push("promises allergen safety");
  if (!dishes.length) return reasons;
  const named = mentionsOf(text, dishes, true, menu);
  const sentences = [...text.matchAll(/[^.!?]+[.!?]*/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const subjectAt = (pos: number): MenuEntry | null => {
    const sent = sentences.find((s) => s.start <= pos && pos < s.end) ?? { start: 0, end: text.length };
    const before = named.filter((m) => m.end <= pos && m.start >= sent.start).at(-1);
    const after = named.find((m) => m.start >= pos && m.start < sent.end);
    return (before ?? after)?.d ?? (dishes.length === 1 ? dishes[0] : null);
  };
  for (const w of DIET_WORDS)
    for (const m of text.matchAll(w.re)) {
      const sent = sentences.find((s) => s.start <= m.index && m.index < s.end);
      if (NEGATED.test(text.slice(sent?.start ?? 0, m.index))) continue;
      const d = subjectAt(m.index);
      if (d && !w.has(d)) reasons.push(`${d.name} is not ${w.label}`);
    }
  reasons.push(...ingredientProblems(text, named, sentences));
  return [...new Set(reasons)];
}

function ingredientProblems(text: string, named: Mention[], sentences: { start: number; end: number }[]): string[] {
  const out: string[] = [];
  for (const s of sentences) {
    const inSentence = named.filter((m) => m.start >= s.start && m.start < s.end);
    const dishes = [...new Set(inSentence.map((m) => m.d))];
    if (dishes.length !== 1) continue; // a sentence comparing dishes is left alone
    const d = dishes[0];
    const own = `${d.name} ${d.description}`.toLowerCase();
    const after = text.slice(inSentence[0].end, s.end);
    for (const m of after.matchAll(INGREDIENT_RE)) {
      const word = m[1].toLowerCase();
      const head = after.slice(0, m.index);
      if (/\b(?:no|not|without|isn't|doesn't|instead of|unlike|than)\b[^,;]*$/i.test(head)) continue; // "no paneer", "unlike the chicken"
      if (!new RegExp(`\\b${word}`).test(own)) out.push(`${d.name} has no ${word} in its menu description`);
    }
  }
  return out;
}

/** Why a chooser reply can't be shown (empty when it can). Exported for tests. */
export function validateChoice(raw: Choice, fit: MenuEntry[], all: Map<string, MenuEntry>, prefs: Prefs, grounding: GroundingContext): { reasons: string[]; alternatives: string[]; pick: string | null } {
  // Dishes are listed by slug; "dal-ember" and "menu:dal-ember" both mean the dish (a format, not a fact).
  const id = (s: string) => (s.startsWith("menu:") ? s : `menu:${s}`);
  const choice: Choice = { ...raw, pick: raw.pick === null ? null : id(raw.pick.trim()), alternatives: raw.alternatives.map((a) => id(a.trim())) };
  const reasons: string[] = [];
  const fitIds = new Set(fit.map((d) => d.id));
  const reply = choice.reply.trim();
  const menu = [...all.values()];
  if (!reply) reasons.push("the reply is empty");
  // The grammar caps the reply at 400 characters; one cut off there (or without an ending) is not shown.
  else if (reply.length >= 390 || !/[.!?)"'’…]$/.test(reply)) reasons.push("the reply is cut off");
  const hype = HYPE_RE.exec(reply);
  if (choice.pick === null) {
    // A clarifying question: no dish, no prices, no booking words, and no claims about food.
    if (reply && !(reply.includes("?") && smalltalkShowable(reply))) reasons.push("without a dish, the reply must be one short question with no prices or booking words");
    if (hype || SAFETY_RE.test(reply) || DIET_WORDS.some((w) => new RegExp(w.re.source, "i").test(reply)) || mentionsOf(reply, menu, false, menu).length) reasons.push("without a dish, the question must not name or describe dishes");
    return { reasons, alternatives: [], pick: null };
  }
  const pick = all.get(choice.pick);
  if (!fitIds.has(choice.pick)) reasons.push(pick ? `${pick.name} ${unmet(pick, prefs) ?? "is not one of the dishes listed"}` : `"${raw.pick}" is not one of the listed IDs`);
  const alternatives = [...new Set(choice.alternatives)].filter((a) => a !== choice.pick && fitIds.has(a)).slice(0, 2);
  if (reasons.length && !fitIds.has(choice.pick)) return { reasons, alternatives, pick: choice.pick };
  const shown = [choice.pick, ...alternatives].map((x) => all.get(x)!);
  const named = mentionsOf(reply, shown, true, menu);
  if (!named.some((m) => m.d.id === choice.pick)) reasons.push(`the reply must name ${pick!.name}`);
  const g = checkGrounding(reply, shown.map((d) => d.id), { ...grounding, sentIds: fitIds });
  if (!g.ok) reasons.push(g.reason === "price" ? `the reply has a price that is not on the menu (${g.detail})` : g.reason === "claim" || g.reason === "booking_state" ? "the reply must not talk about tables or bookings" : `the reply has an unsupported detail (${g.detail || g.reason})`);
  // Dish names, never internal IDs or slugs ("yellow-dal-tadka", "menu:dal-ember"; D-21 audit).
  const slug = menu.find((d) => new RegExp(`(?<![a-z0-9-])(?:menu:)?${escapeRe(d.id.slice(5))}(?![a-z0-9-])`, "i").test(reply) && d.id.slice(5).includes("-"));
  if (slug || /\bmenu:[a-z0-9-]+/i.test(reply)) reasons.push("the reply must use dish names, not IDs");
  // A dish named in the reply must be on the card (one dropped as an alternative, or never chosen, is not).
  for (const m of mentionsOf(reply, menu, false, menu)) if (!shown.includes(m.d) && !named.some((n) => n.start <= m.start && m.end <= n.end)) reasons.push(`the reply names ${m.d.name}, which is not on the card`);
  // Claims are tied to the dish they are about: the nearest dish named before them in the sentence, else the first
  // one after, else the last one named earlier in the reply, else the pick (review: any dish on the card used to do).
  const sentences = [...reply.matchAll(/[^.!?]+[.!?]*/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const subjectAt = (pos: number): MenuEntry => {
    const sent = sentences.find((s) => s.start <= pos && pos < s.end) ?? { start: 0, end: reply.length };
    const before = named.filter((m) => m.end <= pos && m.start >= sent.start).at(-1);
    const after = named.find((m) => m.start >= pos && m.start < sent.end);
    const earlier = named.filter((m) => m.end <= sent.start).at(-1);
    return (before ?? after ?? earlier)?.d ?? pick!;
  };
  for (const p of priceSpans(reply)) {
    const d = subjectAt(p.start);
    if (p.value !== d.price) reasons.push(`the reply gives ${d.name} the wrong price (₹${p.value})`);
  }
  if (hype && !shown.some((d) => d.description.toLowerCase().includes(hype[0].toLowerCase()))) reasons.push(`"${hype[0]}" is not supported by the menu`);
  if (SAFETY_RE.test(reply)) reasons.push("the reply must not promise allergen safety");
  for (const w of DIET_WORDS)
    for (const m of reply.matchAll(w.re)) {
      const sent = sentences.find((s) => s.start <= m.index && m.index < s.end);
      if (NEGATED.test(reply.slice(sent?.start ?? 0, m.index))) continue; // "isn't vegan", "not suitable for vegans"
      const d = subjectAt(m.index);
      if (!w.has(d)) reasons.push(`${d.name} is not ${w.label}`);
    }
  reasons.push(...ingredientProblems(reply, named, sentences));
  return { reasons: [...new Set(reasons)], alternatives, pick: choice.pick };
}

export type ChooserCall = (attempt: 1 | 2, messages: LlmMessage[]) => Promise<{ choice: Choice | null; code: string; content: string }>;

/**
 * The dishes the chooser reads (latency: each line is prompt the model must read). With many dishes that fit, the
 * ones retrieval found relevant to the message come first, then up to three per course in menu order, so a vague
 * request still sees every kind of dish. This picks what to show the model; it never decides the answer, and
 * validation still accepts any dish that fits.
 */
export function shortlist(fit: MenuEntry[], relevant: string[], max = 18): MenuEntry[] {
  if (fit.length <= max) return fit;
  const byId = new Map(fit.map((d) => [d.id, d]));
  const out: MenuEntry[] = [];
  const perCourse = new Map<string, number>();
  const add = (d: MenuEntry) => {
    out.push(d);
    perCourse.set(d.course, (perCourse.get(d.course) ?? 0) + 1);
  };
  for (const id of relevant) {
    const d = byId.get(id);
    if (d && !out.includes(d) && out.length < max) add(d);
  }
  for (const d of fit) if (out.length < max && !out.includes(d) && (perCourse.get(d.course) ?? 0) < 3) add(d);
  return out;
}

export type RecommendResult = { text: string; blocks: Block[]; cited: string[]; prefs: Prefs; recommended: string[] };

const FOLLOW_UPS = (): Block => ({
  type: "quick_replies",
  chips: [
    { label: "Something cheaper", text: "Anything cheaper?" },
    { label: "Another option", text: "Show me another option" },
    { label: "Find a table", action: { type: "set_field", field: "branch", value: null } as Action },
  ],
});
const MENU_CHIP = (): Block => ({ type: "quick_replies", chips: [{ label: "Show me the menu", action: { type: "menu", course: null } }] });
// Answers to the chooser's clarifying question ("light or filling?"), so the guest can tap instead of typing. Each one
// is sent as the guest's message and goes back to the model; none of them picks a dish.
const ANSWER_CHIPS = (): Block => ({
  type: "quick_replies",
  chips: [
    { label: "Something light", text: "Something light" },
    { label: "Something filling", text: "Something filling" },
    { label: "Something vegetarian", text: "Something vegetarian" },
    { label: "Surprise me", text: "Surprise me" },
    { label: "Show me the menu", action: { type: "menu", course: null } },
  ],
});

/** One chip per constraint that can be lifted, each sent as words liftedPrefs reads as lifting it. */
function relaxChips(p: Prefs): { label: string; text: string }[] {
  return [
    ...(p.maxPrice !== null ? [{ label: "Any price", text: "Any price is fine" }] : []),
    ...(p.diet.includes("vegan") ? [{ label: "Not only vegan", text: "Forget the vegan" }] : p.diet.includes("vegetarian") ? [{ label: "Not only vegetarian", text: "Forget the vegetarian" }] : []),
    ...(p.mild ? [{ label: "Spicy is fine", text: "Spicy is fine" }] : []),
  ];
}

/** The dishes that fit, the ones retrieval found relevant to this message first (for the fallback list). */
const relevantFirst = (fit: MenuEntry[], relevant: string[]) => [...fit.filter((d) => relevant.includes(d.id)).sort((a, b) => relevant.indexOf(a.id) - relevant.indexOf(b.id)), ...fit.filter((d) => !relevant.includes(d.id))];

/**
 * A "recommend" turn after the first model call. `call` runs the chooser through the model gate; it is never called
 * when no dish fits or the guest has an allergy the labels can't cover, so those are answered without a model call.
 */
export async function recommendTurn(
  input: { turn: Turn; text: string; history: { role: "guest" | "assistant"; content: string }[]; context: Partial<TurnContext> | undefined; entries: MenuEntry[]; restaurant: string; grounding: GroundingContext; trace: TraceEntry[]; canRetry?: () => boolean; relevant?: string[]; branch?: string | null },
  call: ChooserCall,
): Promise<RecommendResult> {
  const { prefs, added } = resolvePrefs(input.turn.prefs, input.context?.prefs, input.text);
  input.trace.push({ action: "prefs", prefs, added });
  // Only dishes served at the guest's branch, when one is known (D-21 audit: Golf Course Road-only dishes were offered
  // for Hauz Khas).
  const eligible = (items: MenuEntry[], p: Prefs, o: { exclude?: string[]; cheaperThan?: number | null } = {}) => eligibleAll(items, p, { ...o, branch: input.branch });
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const previous = (input.context?.recommended ?? []).filter((id) => byId.has(id));
  // The chips send fixed texts, so "cheaper" and "another" never depend on the model alone.
  const relation = input.turn.prefs?.relation ?? explicitPrefs(input.text).relation ?? null;
  // The dish "cheaper" is measured against: the last suggestion, else the first dish this conversation last showed.
  const anchorId = previous[0] ?? (input.context?.lastCitedIds ?? []).find((id) => byId.has(id)) ?? null;
  const last = anchorId ? byId.get(anchorId)! : null;
  const cheaperThan = relation === "cheaper" && last ? last.price : null;
  const exclude = relation === "another" || relation === "cheaper" ? previous : [];
  const allergyNote: Block[] = prefs.avoid.length || prefs.allergy ? [{ type: "notice", tone: "info", text: ALLERGY_NOTE }] : [];
  const keep = (shown: string[]) => [...new Set([...shown, ...previous])].slice(0, 6);
  const done = (text: string, blocks: Block[]): RecommendResult => ({ text, blocks, cited: [], prefs, recommended: previous });

  // An allergen the labels don't cover: no dish can be checked against it, so the guest is sent to staff.
  const referral = unlistedReferral(prefs);
  if (referral) {
    input.trace.push({ action: "eligible", count: 0, none: "unlisted allergen" });
    return done(referral.text, referral.blocks);
  }

  // "Cheaper" and "another" stay in the last suggestion's section when the guest named none: a cheaper small plate, not
  // a bread. "Cheaper" never leaves it (nothing cheaper there is answered as such); "another" looks everywhere if the
  // section is used up. The section is not stored as a preference.
  const sameCourse = relation && prefs.course === null && last ? last.course : null;
  const scope: Prefs = sameCourse ? { ...prefs, course: sameCourse } : prefs;
  const inCourse = sameCourse ? eligible(input.entries, scope, { exclude, cheaperThan }) : [];
  const fit = sameCourse && (inCourse.length || cheaperThan !== null) ? inCourse : eligible(input.entries, prefs, { exclude, cheaperThan });
  if (!fit.length) {
    const what = describePrefs(cheaperThan !== null ? scope : prefs);
    const any = eligible(input.entries, cheaperThan !== null ? scope : prefs);
    let text: string;
    let none: string;
    // "Already the cheapest" only of what the last dish itself is: with a new constraint it may not meet ("anything
    // cheaper that's gluten-free?" after the Butter Naan), that would be a false claim (D-21 audit). Then the cheapest
    // dish that does fit is shown, as a fact, not a choice.
    const anchorFits = !!last && unmet(last, { ...(cheaperThan !== null ? scope : prefs), maxPrice: null }) === null;
    if (cheaperThan !== null && last && any.length && !anchorFits) {
      const cheapest = [...any].sort((a, b) => a.price - b.price)[0];
      input.trace.push({ action: "eligible", count: any.length, none: `${last.name} doesn't fit the new preferences` });
      return { text: `The ${last.name} isn't one of the ${what}. The cheapest that is: the ${cheapest.name} (₹${cheapest.price}).`, blocks: [{ type: "recommendation", lead: true, items: [view(cheapest)] }, ...allergyNote, FOLLOW_UPS()], cited: [cheapest.id], prefs, recommended: keep([cheapest.id]) };
    }
    if (cheaperThan !== null && last && any.length && Math.min(...any.map((d) => d.price)) >= last.price) {
      none = "already the cheapest";
      text = `The ${last.name} (₹${last.price}) is already the cheapest of the ${what} we have.`;
      input.trace.push({ action: "eligible", count: 0, none });
      // The dish stays the subject of the conversation ("is that vegan?" refers to it).
      return { text, blocks: [...allergyNote, MENU_CHIP()], cited: [last.id], prefs, recommended: previous };
    } else if ((relation === "another" || cheaperThan !== null) && eligible(input.entries, prefs, { cheaperThan }).length) {
      none = "already suggested every dish that fits";
      text = `I've already suggested all the ${cheaperThan !== null ? `${what} under ₹${cheaperThan}` : what} we have. Want to try something different?`;
    } else {
      none = "no dish fits";
      text = `We don't have any ${describePrefs(prefs, { cheaperThan })} on the menu.${relaxChips(prefs).length ? " Tap one to widen the search." : ""}`;
    }
    input.trace.push({ action: "eligible", count: 0, none });
    // Chips whose texts lift a constraint in code ("any price", "forget the vegan"), not a question code can't act on
    // ("want me to relax one of those?" — a "yes" changed nothing; D-21 audit).
    const relax = none === "no dish fits" ? relaxChips(prefs) : [];
    return done(text, [...allergyNote, { type: "quick_replies", chips: [...relax, { label: "Show me the menu", action: { type: "menu", course: null } }] }]);
  }
  input.trace.push({ action: "eligible", count: fit.length, none: null });

  const relationLine = cheaperThan !== null && last ? `They want something cheaper than ${last.name} (₹${last.price}).` : relation === "another" && previous.length ? `They want something different from: ${previous.map((x) => byId.get(x)!.name).join(", ")}.` : null;
  if (sameCourse && fit === inCourse) input.trace.push({ action: "eligible", count: inCourse.length, none: `same section as ${last!.name}` });
  const prefsLine = [hasPrefs(prefs) ? describePrefs(prefs) : null, prefs.allergy ? "they have a food allergy, so never call a dish safe or free of anything" : null].filter(Boolean).join("; ") || "none stated";
  const messages: LlmMessage[] = [
    { role: "system", content: buildChooserSystem(input.restaurant) },
    { role: "user", content: buildChooserUser({ prefs: prefsLine, relation: relationLine, history: input.history, dishes: shortlist(fit, input.relevant ?? []), guest: input.text }) },
  ];

  let lastPick: string | null = null;
  let alternatives: string[] = [];
  for (const attempt of [1, 2] as const) {
    if (attempt === 2 && input.canRetry && !input.canRetry()) break; // the turn is already slow: fall back instead
    const r = await call(attempt, messages);
    if (!r.choice) {
      input.trace.push({ action: "recommend", attempt, result: r.code, pick: null, alternatives: [], rejected: [] });
      if (r.code !== "MODEL_INVALID_OUTPUT") break; // down or timed out: fall back without another call
      messages.push({ role: "assistant", content: r.content }, { role: "user", content: chooserCorrection(["it was not a valid JSON object for the schema"]) });
      continue;
    }
    const v = validateChoice(r.choice, fit, byId, prefs, input.grounding);
    input.trace.push({ action: "recommend", attempt, result: v.reasons.length ? "rejected" : "ok", pick: r.choice.pick, alternatives: r.choice.alternatives, rejected: v.reasons });
    if (!v.reasons.length) {
      if (v.pick === null) return done(r.choice.reply.trim(), [...allergyNote, ANSWER_CHIPS()]);
      const shown = [v.pick, ...v.alternatives];
      return { text: r.choice.reply.trim(), blocks: [{ type: "recommendation", lead: true, items: shown.map((x) => view(byId.get(x)!)) }, ...allergyNote, FOLLOW_UPS()], cited: shown, prefs, recommended: keep(shown) };
    }
    if (v.pick && fit.some((d) => d.id === v.pick)) {
      lastPick = v.pick;
      alternatives = v.alternatives;
    }
    messages.push({ role: "assistant", content: r.content }, { role: "user", content: chooserCorrection(v.reasons) });
  }

  // Fallbacks, in code and honest about it: the model's valid pick with a plain line, or a few dishes that fit, the
  // ones retrieval found for this message first ("anything with black lentils?" shows the dal, not the first starter).
  if (lastPick) {
    const d = byId.get(lastPick)!;
    const shown = [lastPick, ...alternatives];
    return { text: `I'd suggest the ${d.name} (₹${d.price}).`, blocks: [{ type: "recommendation", lead: true, items: shown.map((x) => view(byId.get(x)!)) }, ...allergyNote, FOLLOW_UPS()], cited: shown, prefs, recommended: keep(shown) };
  }
  const few = relevantFirst(fit, input.relevant ?? []).slice(0, 3);
  return { text: hasPrefs(prefs) ? `Here are a few ${describePrefs(prefs, { cheaperThan })} to choose from.` : "Here are a few dishes to choose from.", blocks: [{ type: "recommendation", lead: false, items: few.map(view) }, ...allergyNote, FOLLOW_UPS()], cited: few.map((d) => d.id), prefs, recommended: keep(few.map((d) => d.id)) };
}
