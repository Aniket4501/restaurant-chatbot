import { checkGrounding, type GroundingContext } from "@/lib/chat/grounding";
import { hypeClaims, hypeMatches, isBestsellerClaim, smalltalkShowable } from "@/lib/chat/claims";
import { ALLERGY_NOTE, describePrefs, eligible as eligibleAll, foodWords, hasPrefs, stemOf, unlistedReferral, unmet, view, type MenuEntry } from "@/lib/chat/menu";
import { AVOIDS, DIETS, noPrefs, PrefsSchema, RECOMMEND_CHIP_TEXTS, UNLISTED, type Action, type Block, type Chip, type Course, type Prefs, type TraceEntry, type TurnContext } from "@/lib/chat/types";
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
export type Relation = "cheaper" | "another" | "milder" | "spicier";
export type Stated = Partial<Omit<Prefs, "unlisted" | "exclude">> & { unlisted?: Unlisted[]; relation?: Relation; /** Candidate ingredient exclusions, checked against the menu before use (D-26). */ exclude?: string[] };

const clean = (raw: string) => foldDigits(raw).toLowerCase().replace(/[’‘]/g, "'");
// A word right after one of these (up to two words between: "not really vegetarian", "not suitable for vegans") is negated.
const NEG_BEFORE = String.raw`(?<!\b(?:non|not|no|nothing|never|isn't|aren't|nor|forget|drop|ignore)[- ](?:\w+ ){0,2})`;
const NUTS = String.raw`(?:pea|ground|wal|hazel|pine|tree[- ]?)?nuts?|cashews?|almonds?|pistachios?`;
const DAIRY_ALLERGY = String.raw`dairy|lactose|milk`;
// "No paneer" is about paneer, not all dairy (D-26: it is an ingredient exclusion now; it used to remove every dairy dish).
const DAIRY_FOOD = String.raw`dairy|lactose|milk|cream|ghee|cheese`;
const EGG = String.raw`eggs?`;
const DAIRY_NAMED = /^(?:paneer|cheese|ghee|cream|butter|curd|yog(?:h)?urt|milk|dairy|lactose)$/;
const ALLERGY_WORD = /\ballerg(?:y|ic|ies)\b|\banaphyla/;
// The guest saying they have no allergy (failure-mode audit FM-022: "my friend has no allergies" lifted the guest's
// own nut allergy). "Not allergic to X" lifts only X (see liftedPrefs).
const NO_ALLERGY = /^\s*no(?:,| -)? (?:food )?allerg(?:y|ies)\b|\b(?:i|we)(?:'m| am| are|'re)? (?:have )?no (?:food )?allerg(?:y|ies)\b|\b(?:i|we) (?:don't|do not) have (?:any )?(?:food )?allerg\w*|\b(?:i'm|i am|we're|we are) not allergic\b(?! to)|\bno (?:food )?allerg(?:y|ies) (?:for (?:me|us)|here|at all)\b|\b(?:i|we) (?:have|am|are) (?:without|free of) (?:any )?allerg\w*/;
const NOT_ALLERGIC_TO = /\bnot allergic to ((?:\w+(?: and | or |, )?){1,3})/;
const COELIAC = /(?<!\b(?:not|no|never|isn't|aren't)[- ](?:\w+ ){0,2})\b(?:co?eliac|celiac)\b|\bgluten (?:allerg|intoleran)\w*|\ballergic to (?:gluten|wheat)\b|\bwheat allerg\w*/;
// "no nuts", "can't eat dairy", "without egg", "nut-free", "egg allergy": the avoidance is tied to the allergen.
// Also "nothing with nuts", "not eating dairy", "off dairy", "eggless", "non-dairy" (failure-mode audit FM-021: these were
// read by neither reader, so the guest's allergen was dropped).
const avoids = (food: string) => new RegExp(String.raw`\b(?:no|without|avoid(?:ing)?|skip|hold the|can't (?:eat|have)|cannot (?:eat|have)|don't (?:eat|want)|free (?:of|from)|nothing with|not eating|off)\s+(?:any |the )?(?:\w+ (?:or|and|,) )?(?:${food})\b|\b(?:${food})[- ]free\b|\b(?:${food}) (?:allerg|intoleran)\w*|\b(?:${food})-?less\b|\bnon[- ](?:${food})\b`);
// The words for each labelled allergen, for keeping the model's reading when the guest named it (FM-021).
const ALLERGEN_NAMED: Record<Avoid, RegExp> = { nuts: new RegExp(String.raw`\b(?:${NUTS})\b`), dairy: /\b(?:dairy|lactose|milk|cream|ghee|cheese|paneer|butter)\b/, egg: /\beggs?\b|\beggless\b/ };
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

// After "allergic to": separators between allergens, words that are no allergen ("tree nuts tonight", "cashews badly"),
// and words that end the list ("nuts and need something sweet", "kiwi she's 5"). Any other punctuation, a digit or a
// symbol ends it too. Review of D-24: a list pattern that needed the clause to end in . , ; ! ? or a stop word missed
// "kiwi & nuts", "kiwi (badly)", "kiwi — what dessert?", and took "tonight" or "dessert" for allergens.
const LIST_SEPARATORS = new Set(["and", "or", "&", "/", ",", "also", "both", "plus", "as", "well"]);
const LIST_SKIP = new Set(["any", "all", "some", "kinds", "kind", "types", "type", "of", "very", "really", "quite", "too", "badly", "severely", "mildly", "slightly", "seriously", "extremely", "tonight", "today", "tomorrow", "now", "though", "unfortunately", "certain", "most", "raw", "fresh", "a", "an", "the", "little", "bit", "lot"]);
// A comma often starts a new clause ("allergic to nuts, show me another option"), so the verbs and words that open one
// end the list too.
const LIST_STOP = new Set(["need", "needs", "want", "wants", "would", "like", "love", "have", "has", "had", "so", "but", "which", "what", "whats", "what's", "how", "where", "when", "why", "can", "could", "will", "should", "may", "might", "must", "shall", "is", "are", "am", "was", "were", "be", "please", "i", "i'm", "im", "i'd", "i'll", "my", "we", "we're", "our", "us", "me", "you", "your", "she", "she's", "he", "he's", "they", "it", "it's", "its", "this", "that", "these", "don't", "dont", "do", "does", "doesn't", "did", "suggest", "recommend", "show", "give", "tell", "find", "get", "make", "bring", "offer", "list", "try", "pick", "choose", "order", "eat", "book", "anything", "something", "everything", "for", "in", "on", "at", "to", "from", "then", "if", "with", "who", "help", "looking", "thanks", "thank", "ok", "okay", "hi", "hello", "hey", "yes", "no"]);
export function allergicToList(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(/\ballergic to\b/g)) {
    const rest = t.slice(m.index + m[0].length, m.index + m[0].length + 120);
    for (const tok of rest.matchAll(/[a-z]+(?:'[a-z]+)?(?:-[a-z]+)*|[&\/,]|\S/g)) {
      const w = tok[0];
      if (LIST_SEPARATORS.has(w) || LIST_SKIP.has(w)) continue;
      if (LIST_STOP.has(w) || !/^[a-z]/.test(w)) break;
      out.push(w);
    }
  }
  return out;
}

/** "1,000" → 1000, "1.5k" → 1500, "400" → 400 (D-28: "under ₹1,000" was not read as a budget). */
export const rupeesOf = (s: string) => (/k$/i.test(s.trim()) ? Math.round(Number(s.trim().replace(/\s?k$/i, "")) * 1000) : Number(s.replace(/,/g, "")));

export function explicitPrefs(raw: string): Stated {
  const t = clean(raw);
  const out: Stated = {};
  const budget = /\b(?:under|below|less than|within|up ?to|max(?:imum)?|no more than|not more than|budget(?: of| is)?)\s*(?:₹|rs\.?\s*|inr\s*)?(\d{1,2},\d{3}|\d{2,5}|\d{1,2}(?:\.\d)?\s?k)\b(?!\s*(?:people|persons?|guests?|pax|of us|kids?|children|adults?|years?|yrs?|mins?|minutes?|hours?|hrs?|pm|am|o'?clock|km|%|percent))|(?:₹|rs\.?\s*)(\d{1,2},\d{3}|\d{2,5})\s*(?:or less|max|tops)\b/.exec(t);
  if (budget) out.maxPrice = rupeesOf(budget[1] ?? budget[2]);
  const diet: Diet[] = [];
  if (new RegExp(`${NEG_BEFORE}\\bvegans?\\b`).test(t) || /\bplant[- ]based\b|\bno animal products\b/.test(t)) diet.push("vegan");
  if (new RegExp(`${NEG_BEFORE}\\b(?:vegetarians?|veggie|veg|shakahari|pure veg)\\b`).test(t) || NO_MEAT.test(t)) diet.push("vegetarian");
  // Negated mentions ("forget the gluten-free", "I'm not coeliac", "forget Jain") are lifts, not statements (FM-002).
  if (new RegExp(String.raw`${NEG_BEFORE}(?:\bgluten[- ]free\b|\bco?eliac\b|\bceliac\b)`).test(t) || /\bno gluten\b|\bgluten (?:allerg|intoleran)\w*|\ballergic to (?:gluten|wheat)\b|\bwheat allerg\w*|\bcan't (?:eat|have) (?:gluten|wheat)\b/.test(t)) diet.push("gluten-free");
  if (new RegExp(String.raw`${NEG_BEFORE}\bjain\b`).test(t)) diet.push("jain");
  if (diet.length) out.diet = diet;
  if (/\bnot (?:too |very |that |so )?spicy\b|(?<!\b(?:not|nothing|no) (?:too |so |very )?)\bmild\b|\bless spicy\b|\bno spice\b|\bnon[- ]spicy\b/.test(t)) out.mild = true;
  // "No allergies for me, but my daughter is allergic to peanuts" (D-21 audit): the negated phrase is removed before
  // looking for an allergy, so it cancels nothing stated elsewhere in the message. Coeliac is a medical need too: the
  // kitchen handles gluten, so the allergy note applies.
  const positive = t.replace(new RegExp(NO_ALLERGY.source, "g"), " ").replace(new RegExp(NOT_ALLERGIC_TO.source, "g"), " ");
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
    // Every allergen of "allergic to nuts and dairy", "kiwi & nuts", "kiwi/strawberry" (D-24 audit: the old pattern
    // read "and" as the allergen and sent the guest to staff).
    const named = [...allergicToList(positive), ...[...positive.matchAll(/\b(\w+) allerg(?:y|ies)\b/g)].map((m) => m[1])].filter((w) => !NOT_AN_ALLERGEN.has(w));
    // A dairy food named as the allergen ("allergic to paneer") is a dairy allergy the labels cover (review of D-26:
    // paneer left DAIRY_FOOD, and "allergic to paneer" was sent to staff as an unlisted allergen).
    if (named.some((w) => DAIRY_NAMED.test(w)) && !(out.avoid ?? []).includes("dairy")) out.avoid = [...(out.avoid ?? []), "dairy"];
    const covered = new RegExp(`^(?:${NUTS}|${DAIRY_ALLERGY}|${DAIRY_FOOD}|${EGG}|gluten|wheat|nut|peanut|tree|paneer|curd|butter|yog(?:h)?urt)$`);
    if (!unlisted.length && named.some((w) => !covered.test(w) && !UNLISTED_RE.some(([, re]) => re.test(w)))) unlisted.push("other");
    if (unlisted.length) out.unlisted = unlisted;
  }
  // D-26: a liking for spice (medium or hot dishes), stated positively; "spicy is fine" only lifts "mild".
  if (!out.mild && SPICY.test(t) && !SPICE_AVERSE.test(t) && !/\bspic(?:y|e) (?:is )?(?:fine|ok|okay)\b/.test(t)) out.spicy = true;
  // D-26: ingredients the guest doesn't want ("another option, but not paneer"); kept only if the menu has the word.
  const exclude = [...t.matchAll(EXCLUDE_RE)].map((m) => m[1]).filter((w) => !NOT_AN_EXCLUSION.has(w) && !(NO_MEAT.test(t) && MEAT_WORDS.test(w)));
  if (exclude.length) out.exclude = [...new Set(exclude)];
  // "I can't have paneer, I'm allergic": a dairy food the guest can't have because of an allergy is a dairy allergy.
  if (out.allergy && exclude.some((w) => DAIRY_NAMED.test(w)) && !(out.avoid ?? []).includes("dairy")) out.avoid = [...(out.avoid ?? []), "dairy"];
  if (/^anything cheaper\??$|\bcheaper\b|\bless (?:expensive|pricey|costly)\b|\bmore affordable\b|\blower[- ](?:priced?|cost)\b|\bbudget[- ]friendly\b/.test(t)) out.relation = "cheaper";
  else if (/\bless spicy\b|\bmilder\b|\bnot (?:as|so) (?:spicy|hot)\b|\bless (?:hot|heat)\b/.test(t)) out.relation = "milder";
  else if (/\bspicier\b|\bmore (?:spicy|heat)\b|\bhotter\b|\bmore of a kick\b/.test(t)) out.relation = "spicier";
  else if (/^show me another option$|\banother (?:one|option|dish|suggestion|idea)\b|\bsomething (?:else|different)\b|\bother options?\b|\bnot that one\b|\bwhat else\b|\banything else\b|\bsomething other than\b|\ba different (?:one|dish|option)\b|\balternatives?\b/.test(t)) out.relation = "another";
  return out;
}

// D-26 "spicy": a stated liking, not a passing mention ("is it spicy?"). "Hot" only of food ("I like it hot"), never
// "something hot to drink" (review of D-26).
const SPICY = new RegExp(
  String.raw`(?<!\b(?:not|no|less|nothing|never|too) (?:too |so |very |really )?)(?:\b(?:like|love|prefer|want|enjoy|crave|fancy)\s+(?:it\s+|my food\s+|food\s+|things\s+|something\s+|dishes\s+)?(?:really\s+|very\s+|extra\s+)?(?:spicy|fiery)\b|\b(?:like|love|prefer) (?:it|my food|food) hot\b|\b(?:something|anything|a dish|dishes|food)\s+(?:really\s+|very\s+|extra\s+)?(?:spicy|fiery)\b|\b(?:spicier|extra spicy|very spicy|really spicy)\b|\bspicy (?:food|dish|dishes|one|main|starter|curry|curries)\b)`,
);
// A dislike of spice anywhere in the clause ("I don't like spicy food", "not a fan of spicy", "the kids can't handle
// spice"): never read as a liking (review of D-26).
const SPICE_AVERSE = /\b(?:don't|do not|doesn't|does not|didn't|not a fan of|can't|cannot|can not|hate|avoid|dislike|no|not|never|without)\b[^.,;!?]{0,25}\b(?:spicy|spice|fiery|heat|chill?i)\b/;
// "not paneer", "no mushrooms", "without onion", "anything but chicken", "I can't have paneer": a candidate exclusion.
const EXCLUDE_RE = /\b(?:but not|not|no|without|except|other than|nothing with|don't (?:like|want)|do not (?:like|want)|can't (?:eat|have)|cannot (?:eat|have)|can not (?:eat|have)|skip|hold the|minus|anything but)\s+(?:any\s+|the\s+|more\s+|too much\s+)?([a-z]{3,20})\b/g;
// Words after "no"/"not" that aren't ingredients, or are read elsewhere (diet, allergens, spice, price).
const NOT_AN_EXCLUSION = new Set(["allergic", "spicy", "spice", "hot", "mild", "too", "that", "this", "one", "ones", "more", "much", "very", "sure", "really", "expensive", "cheap", "pricey", "heavy", "big", "veg", "vegetarian", "vegan", "dairy", "milk", "cream", "ghee", "cheese", "lactose", "nuts", "nut", "peanuts", "egg", "eggs", "gluten", "wheat", "allergies", "allergy", "budget", "problem", "worries", "thanks", "thank", "need", "idea", "preference", "preferences", "restrictions", "fussy", "bother", "matter", "something", "anything", "everything", "dish", "dishes", "food", "main", "mains", "dessert", "desserts", "starter", "starters", "drink", "drinks", "same", "again", "longer", "fan", "big", "keen", "into"]);
const MEAT_WORDS = /^(?:meat|chicken|fish|mutton|lamb|seafood|prawns?|keema|non)$/;

/** Constraints the guest's words lift ("I'm not vegetarian", "price doesn't matter", "spicy is fine", "no allergies"). */
export function liftedPrefs(raw: string): { diet: Diet[]; maxPrice: boolean; mild: boolean; allergy: boolean; avoid: Avoid[]; exclude: string[] } {
  const t = clean(raw);
  const noMeat = NO_MEAT.test(t);
  // "I eat chicken now", "fine with meat" lift vegetarian too (D-26; "I don't eat chicken" is caught by NO_MEAT first).
  // Said of the guest themselves (failure-mode audit FM-022: "my husband wants chicken" lifted the guest's own diet).
  const meat =
    !ALLERGY_WORD.test(t) &&
    !noMeat &&
    (/\b(?:i|we)(?:'ll| will| do| can| also| now)? (?:eat|have|want|like|love|fancy|order|prefer)\b[^.?!]{0,24}\b(?:chicken|mutton|lamb|goat|fish|prawns?|shrimps?|meat|keema|seafood|pork|beef|non[- ]?veg\w*)\b/.test(t) ||
      /\b(?:fine|ok|okay|happy|good|alright) with (?:meat|chicken|fish|lamb|mutton|non[- ]?veg\w*)\b/.test(t));
  const diet: Diet[] = [];
  // Gluten-free and Jain can be lifted too (FM-002: only vegetarian and vegan could), and "vegetarian now" or "dairy is
  // fine" lifts vegan.
  const anyDiet = /\bno (?:dietary )?restrictions?\b|\b(?:i|we) (?:eat|can eat) (?:everything|anything)\b/.test(t);
  if (anyDiet || /\b(?:gluten|wheat) (?:is|are) (?:fine|ok|okay)\b|\bcan (?:eat|have) (?:gluten|wheat)\b|\bnot (?:a )?co?eliac\b|\b(?:forget|drop|ignore|never ?mind) (?:the )?gluten[- ]free\b/.test(t)) diet.push("gluten-free");
  if (anyDiet || /\b(?:forget|drop|ignore|never ?mind) (?:the )?jain\b|\b(?:onions?|garlic)(?: and (?:onions?|garlic))? (?:is|are) (?:fine|ok|okay)\b|\bnot jain\b/.test(t)) diet.push("jain");
  const veganLift = /\b(?:now|actually|just|only)\b[^.?!]{0,20}\bvegetarian\b|\bvegetarian\b[^.?!]{0,12}\b(?:now|actually)\b|\b(?:dairy|milk|eggs?|paneer)(?: and (?:dairy|milk|eggs?|paneer))? (?:is|are) (?:fine|ok|okay)\b|\bcan (?:have|eat) (?:dairy|milk|eggs?|paneer)\b/.test(t);
  if (meat || /\bnot (?:a |really |strictly |fully )?(?:vegetarian|veg|veggie)\b|(?<!\b(?:don't|do not|never|can't|cannot|won't) )\b(?:i )?eat (?:meat|everything|anything)\b|\b(?:forget|drop|ignore|never ?mind) (?:the )?(?:veg\w*)\b/.test(t)) diet.push("vegetarian", "vegan");
  else if (veganLift || /\bnot (?:a |really |strictly |fully )?vegan\b|\b(?:forget|drop|ignore|never ?mind) (?:the )?vegan\b/.test(t)) diet.push("vegan");
  const maxPrice = /\bprice (?:doesn't|does not|isn't|is not) (?:matter|an issue|a concern)|\bno budget\b|\bany (?:price|budget)\b|\bmoney is no (?:object|issue)|\bbudget (?:doesn't|does not) matter|\bdon't (?:care|worry) about (?:the )?(?:price|cost|budget)|\bsplurge\b|\bforget (?:the |my )?budget\b|\bexpensive is (?:fine|ok|okay)\b/.test(t);
  const mild = !SPICE_AVERSE.test(t) && /\b(?:nothing|not) (?:too |so )?mild\b|\bspicier\b|\b(?:like|love|want|prefer) (?:it )?(?:spicy|heat)\b|\b(?:like|love|prefer) (?:it|my food|food) hot\b|\b(?:extra|very|really) spicy\b|\bspic(?:y|e) (?:is )?(?:fine|ok|okay|good)\b|\bsomething (?:spicy|fiery)\b/.test(t);
  // Lifted only when the guest says it of themselves and states no allergy anywhere else ("no allergies, but I'm
  // allergic to nuts" lifts nothing).
  const allergy = NO_ALLERGY.test(t) && !ALLERGY_WORD.test(t.replace(new RegExp(NO_ALLERGY.source, "g"), " ").replace(NOT_ALLERGIC_TO, " "));
  const avoid: Avoid[] = [];
  // "Not allergic to dairy" lifts dairy only; the other allergens stay ("…only nuts").
  const notTo = NOT_ALLERGIC_TO.exec(t)?.[1] ?? "";
  const canEat = (food: string) => new RegExp(String.raw`\bcan (?:eat|have) (?:${food})\b|\b(?:${food}) (?:is|are) (?:fine|ok|okay)\b`).test(t) || new RegExp(String.raw`\b(?:${food})\b`).test(notTo);
  if (allergy || canEat(NUTS)) avoid.push("nuts");
  if (allergy || canEat(DAIRY_FOOD)) avoid.push("dairy");
  if (allergy || canEat(EGG)) avoid.push("egg");
  // "Paneer is fine after all": an exclusion is lifted (D-26).
  const exclude = [...t.matchAll(/\b([a-z]{3,20}) (?:is|are) (?:fine|ok|okay)\b|\b(?:i (?:can|do) (?:eat|have)|fine with) ([a-z]{3,20})\b/g)].map((m) => m[1] ?? m[2]);
  return { diet, maxPrice, mild, allergy, avoid, exclude };
}

// "I don't eat meat", "no meat or fish", "nothing with chicken", "meat-free": vegetarian, stated (D-21 audit).
const NO_MEAT = /\b(?:don't|do not|never|can't|cannot|won't) eat (?:any )?(?:meat|chicken|fish|seafood|non[- ]?veg)\b|\bno (?:meat|chicken|fish|non[- ]?veg)\b|\b(?:nothing with|without) (?:any )?(?:meat|chicken|fish)\b|\bmeat[- ]?free\b|\bmeatless\b/;

const SPICE_WORD = /\bspic|\bmild\b|\bheat\b|\bhot\b|\bchill?i|\bkick\b|\bbland\b|\bfiery\b/i;
// Words about avoiding a food for health reasons: the model's allergy reading counts only with one of these (D-28).
const AVOID_CUE = /\b(?:allerg\w*|intoleran\w*|sensitiv\w*|coeliac|celiac|anaphyla\w*|avoid\w*|can'?t (?:have|eat|take|tolerate)|cannot (?:have|eat|take|tolerate)|(?:don't|do not|doesn't|does not) (?:agree|suit)|without|[a-z]+[- ]free|react\w* to)\b/i;

/**
 * Active preferences after this turn (D-20, review). The model proposes them; code keeps them honest:
 * - what the guest's words state for certain is always added;
 * - diet, budget, mild, an allergy and its allergens stay in force from earlier turns unless the guest lifts them
 *   (the model dropping one is not enough);
 * - a budget needs a number in the guest's words, and "mild" a word about spice, so the model can't invent either.
 */
export function resolvePrefs(model: Turn["prefs"], previous: Prefs | null | undefined, text: string, entries?: MenuEntry[]): { prefs: Prefs; added: string[]; inferred: string[] } {
  const prev = previous ?? noPrefs();
  const ex = explicitPrefs(text);
  const lift = liftedPrefs(text);
  const m = model ? { diet: model.diet, avoid: model.avoid, maxPrice: model.maxPrice && model.maxPrice > 0 ? model.maxPrice : null, course: model.course, mild: model.mild, allergy: model.allergy } : null;
  const keep = <T,>(xs: T[], lifted: T[]) => xs.filter((x) => !lifted.includes(x));
  // "Cheaper" and "another" come from the guest's words (or a chip's), like "less spicy" (failure-mode audit FM-024: a
  // relation the model read into "something vegan please" narrowed it to the last dish's section).
  const relation = ex.relation ?? null;
  // A budget figure in the message ("under 400", "₹500"), not any digit ("for the 2 of us"; FM-002).
  const priceSaid = /₹|\brs\.?\s*\d|\brupees?\b|\binr\b|\b(?:under|below|within|budget|max(?:imum)?|up ?to|less than|no more than)\s*\d/.test(foldDigits(text).toLowerCase());
  // D-28 provenance: only what the guest's words state (explicitPrefs, or a chip they tapped, whose text is read the
  // same way) or stated earlier becomes a constraint. What the model proposes beyond that is an inference: recorded in
  // the trace as such, never stored or used as a filter. The section is taken from the guest's words, else kept for a
  // follow-up ("cheaper", "another").
  // The section: the guest's own words when they name one, else the model's reading of this message (a section is no
  // dietary or safety constraint, and it lasts only for this request and its follow-ups), else the last one for a
  // follow-up.
  const stated = courseIn(text);
  const course = stated ?? (relation ? prev.course : (m?.course ?? null));
  // A per-dish budget belongs to the request it was given for: it is dropped when the guest names another section
  // (D-28: "a main under ₹400", then "now a dessert" kept ₹400), unless restated, whatever relation the model read.
  const budgetCarries = stated === null || prev.course === null || stated === prev.course;
  const prefs: Prefs = PrefsSchema.parse({
    diet: DIETS.filter((d) => ex.diet?.includes(d) || keep(prev.diet, lift.diet).includes(d)),
    // An allergen to avoid the model read is kept when the guest's words are about avoiding something ("lactose
    // intolerant", "can't have shellfish"): over-filtering is the safe side. Never from a diet alone ("vegetarian" is
    // not dairy-free or nut-free).
    // FM-021: also when the guest named that allergen in this message ("nothing with nuts in it").
    avoid: AVOIDS.filter((a) => ex.avoid?.includes(a) || keep(prev.avoid, lift.avoid).includes(a) || (!!m?.avoid.includes(a) && (AVOID_CUE.test(text) || ALLERGEN_NAMED[a].test(clean(text))))),
    maxPrice: ex.maxPrice ?? (lift.maxPrice ? null : priceSaid && m?.maxPrice ? m.maxPrice : budgetCarries ? prev.maxPrice : null),
    course,
    mild: !!ex.mild || (!lift.mild && (prev.mild || (!!m?.mild && SPICE_WORD.test(text)))),
    allergy: !!ex.allergy || (!lift.allergy && prev.allergy) || (!!m?.allergy && AVOID_CUE.test(text)),
    unlisted: UNLISTED.filter((u) => ex.unlisted?.includes(u) || (!lift.allergy && prev.unlisted.includes(u))),
    // D-26: a liking for spice stays until the guest asks for mild; "mild" and "spicy" never hold together.
    spicy: !!ex.spicy || (!ex.mild && !!prev.spicy),
    // D-26: exclusions the menu can match, kept across turns until lifted ("paneer is fine"); at most five.
    // Matched on the dish's name and description directly, so three-letter words count ("no dal"); lifted by stem
    // ("paneer is fine" lifts "no paneer", "mushroom is fine" lifts "no mushrooms").
    exclude: [...new Set([...(prev.exclude ?? []).filter((w) => !lift.exclude.some((l) => stemOf(l) === stemOf(w))), ...(entries ? (ex.exclude ?? []).filter((w) => /^[a-z]{3,24}$/.test(w) && entries.some((e) => new RegExp(`\\b${escapeRe(stemOf(w))}`).test(`${e.name} ${e.description}`.toLowerCase()))) : [])])].slice(-5),
  });
  if (prefs.spicy && prefs.mild) prefs.mild = !!ex.mild && !ex.spicy;
  // What code read from the guest's words, and what the model inferred that was not applied (D-28), for the trace.
  const added = [...(ex.diet ?? []), ...(ex.avoid ?? []).map((a) => `no ${a}`), ...(ex.maxPrice !== undefined ? [`up to ₹${ex.maxPrice}`] : []), ...(ex.mild ? ["mild"] : []), ...(ex.allergy ? ["allergy"] : []), ...prefs.unlisted.map((u) => `unlisted allergen: ${u}`), ...(prefs.spicy ? ["spicy"] : []), ...prefs.exclude.map((w) => `no ${w}`)];
  const inferred = m
    ? [
        ...m.diet.filter((d) => !prefs.diet.includes(d)),
        ...m.avoid.filter((a) => !prefs.avoid.includes(a)).map((a) => `no ${a}`),
        ...(m.course && m.course !== stated ? [`course ${m.course}${stated || relation ? "" : " (used for this request only)"}`] : []),
        ...(model?.relation && model.relation !== relation ? [`relation ${model.relation}`] : []),
        ...(m.mild && !prefs.mild ? ["mild"] : []),
        ...(m.allergy && !prefs.allergy ? ["allergy"] : []),
        ...(m.maxPrice !== null && m.maxPrice !== prefs.maxPrice ? [`up to ₹${m.maxPrice}`] : []),
      ]
    : [];
  return { prefs, added, inferred };
}

// The menu section a message names ("a light dessert", "something to start"): the guest's own words (D-28).
const COURSE_WORDS: [Course, RegExp][] = [
  ["desserts", /\b(?:desserts?|sweets?|pudding|something sweet)\b/],
  ["mains", /\b(?:mains?|main course|main dish)\b/],
  ["small-plates", /\b(?:starters?|small plates?|appeti[sz]ers?|snacks?|to start(?: with)?|bites?)\b/],
  ["drinks", /\b(?:drinks?|beverages?|cocktails?|mocktails?|something to drink)\b/],
  ["breads-rice", /\b(?:breads?|naans?|rotis?|parathas?|rice|biryanis?)\b/],
  ["tandoor", /\b(?:tandoor\w*|grills?|grilled|kebabs?|tikkas?)\b/],
];
export function courseIn(text: string): Course | null {
  const t = clean(text);
  const found = COURSE_WORDS.filter(([, re]) => re.test(t)).map(([c]) => c);
  return found.length === 1 ? found[0] : null; // two sections named ("a main and a dessert"): no single section
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Allergen safety can't be confirmed from labels (ALLERGY_NOTE): no "safe", no "nut-free", no "contains no nuts".
// Also "doesn't contain any nuts", "suits your allergy", "fine for an allergy" (D-21 audit). Shared with the FAQ path.
export const SAFETY_RE = /\bsafe(?:ly|r|st)?\b|\ballerg(?:y|en)[- ](?:free|friendly|safe)\b|\b(?:pea)?nut[- ]free\b|\bwon't (?:trigger|affect|cause|bother)\b|\bharmless\b|\bfree (?:of|from) (?:any )?(?:allergens?|(?:pea|tree )?nuts?|traces?|sesame|gluten|shellfish|soy)\b|\b(?:no|without|zero) (?:any )?(?:(?:pea|tree )?nuts?|allergens?|traces?)\b|\b(?:doesn't|does not|don't|do not|has no|have no|won't|will not)\s+(?:contain|have|include|use)\s+(?:any\s+)?(?:(?:pea|tree )?nuts?|allergens?|traces?|sesame|shellfish|soy|gluten|mustard)\b|\b(?:suits?|fine for|ok(?:ay)? for|good for|works for)\s+(?:your|an?|the)\s+(?:\w+\s+)?allerg\w*/i;
// A dish recommended *for* an allergy promises safety too ("a good option for your severe peanut allergy", "as a coeliac
// guest, you can have…", "given your nut allergy, a lovely choice", "this fits your allergy"; D-24 audit: SAFETY_RE
// missed them). Mentioning an allergy is not ("tell your server about your allergy"), and a negation right before the
// claim cancels it ("I can't say it suits your allergy"); one elsewhere in the sentence ("isn't heavy") does not.
const ALLERGY_WORD_RE = String.raw`(?:allerg\w*|co?eliacs?|celiacs?|intoleran\w*|anaphyla\w*)`;
const FOR_ALLERGY = new RegExp(String.raw`\b(?:for|given|because of|considering|with)\s+(?:your|an?|the|any|someone(?:'s)?(?:\s+with\s+an?)?|people\s+with|those\s+with|anyone\s+with|guests?\s+with)?\s*(?:[a-z-]+\s+){0,3}?${ALLERGY_WORD_RE}`, "i");
const AS_ALLERGIC = new RegExp(String.raw`\b(?:as|being)\s+(?:an?\s+)?(?:[a-z-]+\s+)?(?:allergic|co?eliac|celiac)\b`, "i");
const SUITS_ALLERGY = new RegExp(String.raw`\b(?:suits?|fits?|works for|safe for|fine for|good for|ok(?:ay)? for|right for|suitable for)\s+(?:your|an?|the|any)\s+(?:[a-z-]+\s+){0,2}${ALLERGY_WORD_RE}`, "i");
const POSITIVE = /\b(?:good|great|ideal|perfect|fine|safe(?:ly)?|suitable|suited|suits?|ok(?:ay)?|right|lovely|nice|best|appropriate|recommended|works?|fits?|enjoy|go (?:with|for)|try|have|pick|choice|option)\b/gi;
const NEGATED_NEAR = /\b(?:not|never|can't|cannot|can not|isn't|aren't|won't|wouldn't|couldn't|no guarantee|unable to|don't|doesn't)\b[^.!?,;]{0,24}$/i;
export function suitabilityClaim(text: string): boolean {
  return [...text.matchAll(/[^.!?]+[.!?]*/g)].some(({ 0: s }) => {
    const direct = SUITS_ALLERGY.exec(s);
    if (direct && !NEGATED_NEAR.test(s.slice(0, direct.index))) return true;
    if (!FOR_ALLERGY.test(s) && !AS_ALLERGIC.test(s)) return false;
    return [...s.matchAll(POSITIVE)].some((m) => !NEGATED_NEAR.test(s.slice(0, m.index)));
  });
}
// A diet word must be true of the dish it describes (the nearest dish named before it in the sentence, else after).
const DIET_WORDS: { re: RegExp; label: string; has: (d: MenuEntry) => boolean }[] = [
  { re: /\bvegans?\b|\bplant[- ]based\b/gi, label: "vegan", has: (d) => d.dietary.includes("vegan") },
  { re: /\bvegetarians?\b|\bveg\b|\bveggie\b|\bmeat[- ]?free\b|\bmeatless\b/gi, label: "vegetarian", has: (d) => d.dietary.includes("vegetarian") || d.dietary.includes("vegan") },
  { re: /\bgluten[- ]free\b|\bno gluten\b|\bwithout gluten\b|\bwheat[- ]free\b|\b(?:no|without) wheat\b|\bmade without wheat\b/gi, label: "labelled gluten-free", has: (d) => d.dietary.includes("gluten-free") },
  { re: /\bjain\b/gi, label: "a Jain option", has: (d) => d.dietary.includes("jain-available") },
  // Only a vegan dish is known to have no dairy or egg.
  // FM-009: also "non-dairy", "eggless", "no animal products".
  { re: /\b(?:dairy|egg|milk|lactose)[- ]free\b|\bnon[- ]dairy\b|\begg[- ]?less\b|\bno animal products\b|\b(?:no|without|zero) (?:any )?(?:dairy|milk|cream|ghee|paneer|cheese|lactose|eggs?)\b|\b(?:free (?:of|from)) (?:any )?(?:dairy|milk|eggs?)\b|\b(?:doesn't|does not|has no|won't)\s+(?:contain|have|include|use)\s+(?:any\s+)?(?:dairy|milk|cream|ghee|cheese|eggs?)\b/gi, label: "vegan (the only dishes known to have no dairy or egg)", has: (d) => d.dietary.includes("vegan") },
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
  // The last word alone when no other dish's name has it ("the kulfi", "the pomfret", "the sorbet"; failure-mode audit
  // FM-006/FM-009: a claim about "the kulfi" was checked against no dish).
  const last = words.at(-1)!;
  const single = partial && words.length >= 2 && last.length >= 4 && !menu.some((o) => o.id !== d.id && norm(o.name).split(" ").includes(last)) ? [[last]] : [];
  const alts = [join(words), ...shorts.map(join), ...single.map(join)];
  return new RegExp(`(?<![a-z0-9])(?:${alts.join("|")})(?![a-z0-9])`, "gi");
}
type Mention = { d: MenuEntry; start: number; end: number };
function mentionsOf(text: string, dishes: MenuEntry[], partial: boolean, menu: MenuEntry[]): Mention[] {
  return dishes.flatMap((d) => [...text.matchAll(nameRe(d, partial, menu))].map((m) => ({ d, start: m.index, end: m.index + m[0].length }))).sort((a, b) => a.start - b.start);
}

// Main ingredients that define a dish. Named after a dish in the same sentence, one must be in that dish's own name or
// description ("The Chana Pindi is a vegan paneer dish" is false: it is chickpeas; D-21 baseline LV-GRD-011).
const INGREDIENTS = ["paneer", "chicken", "lamb", "mutton", "goat", "prawn", "shrimp", "fish", "crab", "lobster", "egg", "mushroom", "chickpea", "lentil", "beef", "pork", "tofu", "soya", "keema", "potato", "broccoli", "kale", "beetroot", "aubergine", "baingan", "cauliflower"];
const ATTRIBUTE_RE = /\b(?:halal|kosher|organic|keto|paleo|low[- ]carb|low[- ]fat|low[- ]calorie|sugar[- ]free|diabetic[- ]friendly|msg|preservatives?|free[- ]range|grass[- ]fed|non[- ]gmo|locally sourced)\b/gi;
const INGREDIENT_RE = new RegExp(`\\b(${INGREDIENTS.join("|")})(?:e?s)?\\b`, "gi");

/** Words that say a dish can't be ordered now (D-25). */
// Removal or absence of an allergen, by the words for it (FM-027).
const absence = (words: string) => new RegExp(String.raw`\b(?:no longer (?:uses?|contains?|has|includes?|made with|cooked with)|without|removed|free (?:of|from)|not (?:made|cooked) with|(?:doesn't|does not|won't|will not|don't|do not) (?:contain|have|use|include)|(?:has|have) no|no)\s+(?:any\s+)?(?:\w+\s+)?(?:${words})\b|\b(?:${words})\w* (?:have|has) been (?:removed|taken out)\b|\b(?:${words})[- ]free\b`, "i");
const ABSENCE_OF = { nuts: absence(String.raw`nuts?|peanuts?|pistachios?|cashews?|almonds?|walnuts?`), dairy: absence(String.raw`dairy|milk|butter|cream|ghee|paneer|cheese|yog(?:h)?urt|curd|lactose`), egg: absence(String.raw`eggs?`) };
const UNAVAILABLE_WORDS = /\b(?:unavailable|not available|(?:is|are)n['’]t available|sold out|off the menu|not on the menu|not serving|not being served|not on today)\b/i;

/**
 * Claims in model prose that the menu data doesn't support, tied to the dish each is about (the nearest dish named
 * before it in the sentence, else after, else the only dish cited): allergen safety, diet labels, main ingredients.
 * Used for FAQ answers (D-21 audit: "Yes, the Mango Sorbet is safe", "the Dal Ember is vegan" were shown).
 */
export function claimProblems(text: string, dishes: MenuEntry[], menu: MenuEntry[], citedText = ""): string[] {
  const reasons: string[] = [];
  const sentencesAll = [...text.matchAll(/[^.!?]+[.!?]*/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  // A safety phrase counts unless the sentence negates it before it ("we can't guarantee … nut-free", "isn't safe").
  for (const m of text.matchAll(new RegExp(SAFETY_RE.source, "gi"))) {
    const sent = sentencesAll.find((s) => s.start <= m.index && m.index < s.end);
    const before = text.slice(sent?.start ?? 0, m.index);
    if (/\b(?:can't|cannot|can not|not|never|isn't|aren't|unable to|no guarantee|won't guarantee|don't guarantee)\b/i.test(before)) continue;
    reasons.push("promises allergen safety");
    break;
  }
  if (!reasons.includes("promises allergen safety") && suitabilityClaim(text)) reasons.push("promises allergen safety");
  // Attributes the menu data never states ("halal", "organic", "keto") must appear in a cited fact (D-21: "No. Our
  // chicken dishes are not halal." was shown with no fact about halal).
  for (const m of text.matchAll(ATTRIBUTE_RE)) if (!new RegExp(`\\b${m[0]}`, "i").test(citedText)) reasons.push(`"${m[0]}" is not in the facts`);
  // Popularity and reviews (D-26): only what a cited fact says ("Marked as a bestseller by the restaurant", a staff FAQ
  // or document); the data has no sales figures, ratings or reviews.
  const hype = hypeMatches(text);
  for (const h of hype) if (!isBestsellerClaim(h.claim) && !citedText.toLowerCase().includes(h.claim.toLowerCase())) reasons.push(`"${h.claim}" is not supported: there is no sales, popularity or review data`);
  // A bestseller claim: about a dish, only that dish's own mark counts (checked below, once the dishes are known);
  // about no dish, only a cited staff FAQ or document that says so.
  const bestsellerAt = hype.filter((h) => isBestsellerClaim(h.claim));
  const unsupportedBestseller = (h: { claim: string }) => reasons.push(`"${h.claim}" is not supported: there is no sales, popularity or review data`);
  // The cited dishes, and any other dish the answer names by its full name: a label claim is checked against the
  // dish's own labels whether or not the model cited it (D-24).
  const pool = [...new Set([...dishes, ...mentionsOf(text, menu, true, menu).map((m) => m.d)])];
  if (!pool.length) {
    for (const h of bestsellerAt) if (!/best[- ]?sell/i.test(citedText)) unsupportedBestseller(h);
    return [...new Set(reasons)];
  }
  const named = mentionsOf(text, pool, true, menu);
  // A dish marked unavailable may be named only in an answer that says so (D-25: when staff mark a dish unavailable,
  // "Yes, the Tandoori Pomfret is ₹895" would present it as orderable; its fact says "Currently unavailable.").
  const sentences = [...text.matchAll(/[^.!?]+[.!?]*/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const sentenceOf = (pos: number) => sentences.find((s) => s.start <= pos && pos < s.end) ?? { start: 0, end: text.length };
  // The sentence that names it must say so; a cited unavailable dish not named in words needs it anywhere (FM-006: "Yes,
  // the pomfret is ₹895." and "…unavailable… The Tandoori Pomfret is ₹895." were shown).
  const out = named.find((m) => !m.d.available && !UNAVAILABLE_WORDS.test(text.slice(sentenceOf(m.start).start, sentenceOf(m.start).end)));
  const outCited = dishes.find((d) => !d.available && !named.some((m) => m.d === d) && !UNAVAILABLE_WORDS.test(text));
  if (out || outCited) reasons.push(`${(out?.d ?? outCited)!.name} is currently unavailable`);
  // An allergen the dish's own labels list, said to be absent or removed ("no longer uses nuts", "made without
  // pistachio"): a safety promise against verified data (FM-027).
  for (const s0 of sentences) {
    const t = text.slice(s0.start, s0.end);
    const inIt = [...new Set(named.filter((m) => m.start >= s0.start && m.start < s0.end).map((m) => m.d))];
    const subjects = inIt.length ? inIt : pool.length === 1 ? pool : [];
    for (const d of subjects)
      for (const a of d.contains) {
        const hit = ABSENCE_OF[a as keyof typeof ABSENCE_OF]?.exec(t);
        // "It isn't dairy-free" is the honest answer, not a promise.
        if (hit && !/\b(?:isn't|is not|aren't|are not|not|never)\s+(?:\w+\s+){0,2}$/i.test(t.slice(0, hit.index))) reasons.push("promises allergen safety");
      }
  }
  // A price next to a dish's name must be that dish's menu price, whatever else is cited (FM-008: a document's "₹395"
  // for the Dal Ember was shown although the menu says ₹445).
  for (const p of priceSpans(text)) {
    const s1 = sentenceOf(p.start);
    const m = named.filter((x) => x.end <= p.start && x.start >= s1.start).at(-1);
    if (m && /^\s*(?:\(|,)?\s*(?:is|at|costs?|for|priced at|comes to|:|-|–|—)?\s*(?:only|just|about)?\s*$/i.test(text.slice(m.end, p.start)) && p.value !== m.d.price) reasons.push(`the answer gives ${m.d.name} the wrong price (₹${p.value})`);
  }
  const subjectAt = (pos: number): MenuEntry | null => {
    const sent = sentences.find((s) => s.start <= pos && pos < s.end) ?? { start: 0, end: text.length };
    const before = named.filter((m) => m.end <= pos && m.start >= sent.start).at(-1);
    const after = named.find((m) => m.start >= pos && m.start < sent.end);
    return (before ?? after)?.d ?? (pool.length === 1 ? pool[0] : null);
  };
  for (const h of bestsellerAt) {
    const d = subjectAt(h.index);
    if (d ? !d.bestseller : !/best[- ]?sell/i.test(citedText)) unsupportedBestseller(h);
  }
  for (const w of DIET_WORDS)
    for (const m of text.matchAll(w.re)) {
      const si = sentences.findIndex((s) => s.start <= m.index && m.index < s.end);
      const sent = sentences[si];
      if (NEGATED.test(text.slice(sent?.start ?? 0, m.index))) continue;
      // "These are gluten-free" names no dish: it is about every dish named in the sentence before (D-24 final run
      // LV-AUD-012: a bread pudding was called gluten-free to a coeliac guest that way).
      const inSentence = sent ? named.filter((n) => n.start >= sent.start && n.start < sent.end) : [];
      const prev = si > 0 ? sentences[si - 1] : null;
      const plural = !inSentence.length && prev ? [...new Set(named.filter((n) => n.start >= prev.start && n.start < prev.end).map((n) => n.d))] : [];
      // "…are vegan, as is the kulfi" / "so is the kulfi": the dish after "as is" shares the claim (FM-009).
      const echoed = sent ? named.filter((n) => n.start > m.index && n.start < sent.end && /\b(?:as|so)\s+(?:is|are)\s+(?:the\s+)?$/i.test(text.slice(m.index, n.start))).map((n) => n.d) : [];
      const subjects = [...new Set([...(plural.length > 1 ? plural : [subjectAt(m.index)].filter((d): d is MenuEntry => !!d)), ...echoed])];
      for (const d of subjects) if (!w.has(d)) reasons.push(`${d.name} is not ${w.label}`);
    }
  // A label given for the wrong reason: nuts, gluten, soy or sesame never make a dish non-vegan (D-24 final run
  // LV-REC-013: "contains nuts, so it isn't vegan" about a milk ice cream).
  for (const s of sentences) {
    const t = text.slice(s.start, s.end);
    if (/\b(?:isn't|is not|not)\s+(?:a\s+)?vegan\b/i.test(t) && /\bcontains?\s+(?:only\s+)?(?:pea|tree\s+)?nuts?\b|\bcontains?\s+(?:gluten|wheat|soy|sesame)\b/i.test(t) && !/\b(?:dairy|milk|cream|ghee|paneer|cheese|butter|yoghurt|yogurt|egg|honey|meat|chicken|lamb|fish|prawn)\b/i.test(t)) reasons.push("gives a reason that doesn't make a dish non-vegan");
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

const SPICE_NAMES = ["not spicy", "mild", "medium spicy", "hot"];
// Words that say nothing about why a dish suits the guest. A reply made only of these, dish names and prices ("Yellow
// Dal Tadka at ₹375, or Chana Pindi at ₹395.", "Try the Mango Sorbet at ₹245, you'll love it.") gives no reason (D-26).
// Whether what a reason says is true is checked elsewhere: attributes, ingredients, diet, allergens, hype and numbers.
const NO_REASON = new Set(
  "a an and at as be been but by can could do for go got has have here here's i i'd i'm if in is it it's its just like love maybe me might more must my of on one or our pick please really should so some something suggest suggestion that the their them then there there's these this those to too try us very want we we'd will with would you you'd you'll your again also another choice option great good nice perfect lovely delicious tasty amazing excellent wonderful fantastic best favourite favorite definitely enjoy recommend recommendation today tonight what which rupees priced price costs only dish dishes".split(" "),
);
/** Does the reply say anything about the dish beyond naming and pricing it? (D-26: every pick comes with a reason.) */
export function hasReason(reply: string, menu: MenuEntry[]): boolean {
  let rest = reply.toLowerCase().replace(/[’‘]/g, "'");
  for (const d of menu) rest = rest.replace(nameRe(d, true, menu), " ");
  return (rest.replace(/₹\s?[\d,]+(?:\.\d+)?/g, " ").match(/[a-z][a-z'-]*/g) ?? []).some((w) => !NO_REASON.has(w));
}

/** Why a chooser reply can't be shown (empty when it can). Exported for tests. */
export function validateChoice(raw: Choice, fit: MenuEntry[], all: Map<string, MenuEntry>, prefs: Prefs, grounding: GroundingContext, opts: { mustPick?: boolean; mayName?: string[]; guest?: string; relation?: Relation | null } = {}): { reasons: string[]; alternatives: string[]; pick: string | null } {
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
  const hype = hypeClaims(reply);
  if (choice.pick === null) {
    // The guest asked for a choice ("what would you recommend?", "surprise me"): a question back is not an answer
    // (D-24 audit LV-AUD-008: the chooser asked twice and the guest got a generic list).
    if (opts.mustPick) reasons.push("the guest asked you to choose, so pick one dish from the list instead of asking");
    // A clarifying question: no dish, no prices, no booking words, and no claims about food. Diet words are fine in a
    // question ("vegetarian or not?"), and so is "which one" (D-24 audit: both were rejected).
    const asked = reply.replace(/\b(which|this|that|the other|any) one\b|\bone of\b/gi, (_m, w: string | undefined) => (w ? `${w} it` : "some of"));
    if (reply && !(reply.includes("?") && smalltalkShowable(asked))) reasons.push("without a dish, the reply must be one short question with no prices or booking words");
    if (hype.length || SAFETY_RE.test(reply) || suitabilityClaim(reply) || mentionsOf(reply, menu, false, menu).length) reasons.push("without a dish, the question must not name or describe dishes");
    return { reasons, alternatives: [], pick: null };
  }
  const pick = all.get(choice.pick);
  if (!fitIds.has(choice.pick)) reasons.push(pick ? `${pick.name} ${unmet(pick, prefs) ?? "is not one of the dishes listed"}` : `"${raw.pick}" is not one of the listed IDs`);
  const alternatives = [...new Set(choice.alternatives)].filter((a) => a !== choice.pick && fitIds.has(a)).slice(0, 2);
  if (reasons.length && !fitIds.has(choice.pick)) return { reasons, alternatives, pick: choice.pick };
  const shown = [choice.pick, ...alternatives].map((x) => all.get(x)!);
  // The dish a "cheaper"/"another" request compares with may be named, and its own facts check what is said about it.
  const compared = (opts.mayName ?? []).flatMap((x) => (all.has(x) && !shown.some((d) => d.id === x) ? [all.get(x)!] : []));
  const claimable = [...shown, ...compared];
  const named = mentionsOf(reply, claimable, true, menu);
  if (!named.some((m) => m.d.id === choice.pick)) reasons.push(`the reply must name ${pick!.name}`);
  const g = checkGrounding(reply, claimable.map((d) => d.id), { ...grounding, sentIds: new Set([...fitIds, ...compared.map((d) => d.id)]) });
  if (!g.ok) reasons.push(g.reason === "price" ? `the reply has a price that is not on the menu (${g.detail})` : g.reason === "claim" || g.reason === "booking_state" ? "the reply must not talk about tables or bookings" : `the reply has an unsupported detail (${g.detail || g.reason})`);
  // Dish names, never internal IDs or slugs ("yellow-dal-tadka", "menu:dal-ember"; D-21 audit).
  const slug = menu.find((d) => new RegExp(`(?<![a-z0-9-])(?:menu:)?${escapeRe(d.id.slice(5))}(?![a-z0-9-])`, "i").test(reply) && d.id.slice(5).includes("-"));
  if (slug || /\bmenu:[a-z0-9-]+/i.test(reply)) reasons.push("the reply must use dish names, not IDs");
  // A dish named in the reply must be on the card (one dropped as an alternative, or never chosen, is not), except the
  // dish a "cheaper" or "another" request compares with ("cheaper than the Dal Ember"; D-24 audit LV-REC-005).
  for (const m of mentionsOf(reply, menu, false, menu)) if (!claimable.includes(m.d) && !named.some((n) => n.start <= m.start && m.end <= n.end)) reasons.push(`the reply names ${m.d.name}, which is not on the card`);
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
  // Popularity and reviews: the data has none. Only a dish the restaurant marks as a bestseller may be called one, and
  // a menu description never counts as evidence (D-26; it used to excuse the word).
  // A bestseller claim is allowed only about the dish it names, when that dish is marked (review of D-26: any marked
  // dish on the card used to excuse it).
  for (const h of hypeMatches(reply)) if (!(isBestsellerClaim(h.claim) && subjectAt(h.index).bestseller)) reasons.push(`"${h.claim}" is not supported: we have no sales, popularity or review data`);
  // A reason the guest can check (D-26): at least one word from the dish's own line besides its name (description,
  // labels, spice), or one of the guest's stated preferences.
  if (pick && !hasReason(reply, menu)) reasons.push(`say in a few words why the ${pick.name} suits the guest, using its description`);
  if (SAFETY_RE.test(reply)) reasons.push("the reply must not promise allergen safety");
  if (suitabilityClaim(reply)) reasons.push("the reply must not say a dish suits an allergy");
  // Attributes the menu never states (sugar-free, halal, keto…) only when a shown dish's description says so (D-24
  // audit: ATTRIBUTE_RE was applied to FAQ answers only).
  for (const m of reply.matchAll(ATTRIBUTE_RE)) if (!shown.some((d) => new RegExp(`\\b${escapeRe(m[0])}`, "i").test(d.description))) reasons.push(`"${m[0]}" is not supported by the menu`);
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

export type RecommendResult = { text: string; blocks: Block[]; cited: string[]; prefs: Prefs; recommended: string[]; /** D-26: a clarifying question asked this turn. */ asked?: "diet" | "course" };

/** Breads, plain rice and drinks: sides, not dish suggestions (biryanis are dishes). */
export const isSide = (d: MenuEntry) => d.course === "drinks" || (d.course === "breads-rice" && !/biryani/i.test(d.name));
const SIDE_WORDS = /\b(?:drinks?|beverages?|thirsty|lassi|chai|coffee|tea|soda|cooler|juice|breads?|naan|roti|paratha|rice|biryani|sides?)\b/i;
/** The guest asked for a choice, so the chooser must pick rather than ask (D-24 audit LV-AUD-008). */
const CHOOSE_WORDS = /\b(?:recommend\w*|suggest\w*|best|surprise|pick|choose|what should (?:i|we) (?:get|order|have|try|eat)|which (?:one|dish) should)\b/i;

const FOLLOW_UPS = (): Block => ({
  type: "quick_replies",
  chips: [
    { label: "Something cheaper", action: { type: "recommend", text: "Anything cheaper?" } as Action },
    { label: "Another option", action: { type: "recommend", text: "Show me another option" } as Action },
    { label: "Find a table", action: { type: "set_field", field: "branch", value: null } as Action },
  ],
});
const MENU_CHIP = (): Block => ({ type: "quick_replies", chips: [{ label: "Show me the menu", action: { type: "menu", course: null } }] });
// Answers to the clarifying question ("light or filling?"), so the guest can tap instead of typing. Each goes to the
// dish chooser (D-24: as an action, without the intent call); none of them picks a dish by itself.
export const ANSWER_CHIPS = (): Block => ({
  type: "quick_replies",
  chips: [
    { label: "A light snack", action: { type: "recommend", text: "A light snack" } },
    { label: "A filling main course", action: { type: "recommend", text: "A filling main course" } },
    { label: "Something vegetarian", action: { type: "recommend", text: "Something vegetarian" } },
    { label: "Surprise me", action: { type: "recommend", text: "Surprise me" } },
    { label: "Show me the menu", action: { type: "menu", course: null } },
  ],
});
/** The fixed question for "Help me find a dish" (D-24: no model call for a fixed chip). */
export const HELP_QUESTION = "Happy to help. What are you in the mood for?";

/**
 * D-26: the one clarifying question for a request that says nothing about the guest (no diet, budget, course, taste,
 * ingredient or allergy, nothing suggested yet): diet changes the answer most (13 of 48 dishes have meat). Asked once
 * per conversation; the answers are chips, and "Surprise me" skips it.
 */
export const DIET_QUESTION = "Happy to help. Any preference: vegetarian, vegan, or do you eat everything?";
export const DIET_CHIPS = (): Block => ({
  type: "quick_replies",
  chips: [
    { label: "Vegetarian", action: { type: "recommend", text: "Something vegetarian" } },
    { label: "Vegan", action: { type: "recommend", text: "Something vegan" } },
    { label: "I eat everything", action: { type: "recommend", text: "I eat everything" } },
    { label: "Surprise me", action: { type: "recommend", text: "Surprise me" } },
  ],
});
/** A question about safety or what is in a dish: the allergy note answers part of it, every time (review of D-28). */
export const SAFETY_QUESTION = /\b(?:safe|allerg\w*|ok(?:ay)? for (?:me|my|her|him|them|us)|can (?:i|she|he|they|we) (?:eat|have)|what's in|whats in|contain\w*|ingredients?|traces?|made with|cooked with)\b/i;
/** D-28: "something light" says how, not what: the meal type it applies to, when none is known yet. */
const APPETITE = /\b(?:light|lighter|filling|hearty|heavy|something small|something big)\b/i;
const courseQuestion = (filling: boolean): { text: string; blocks: Block[] } => ({
  text: filling ? "Happy to help. A filling main course, or a snack?" : "Happy to help. A light snack, a main course or a dessert?",
  blocks: [
    {
      type: "quick_replies",
      chips: filling
        ? [
            { label: "A main course", action: { type: "recommend", text: "A filling main course" } },
            { label: "A snack", action: { type: "recommend", text: "A filling snack" } },
          ]
        : [
            { label: "A light snack", action: { type: "recommend", text: "A light snack" } },
            { label: "A light main course", action: { type: "recommend", text: "A light main course" } },
            { label: "A light dessert", action: { type: "recommend", text: "A light dessert" } },
          ],
    },
  ],
});

// The guest hands the choice over, or has said something about what they want: no question (D-26).
const COURSE_FAMILY: Partial<Record<Course, Course[]>> = { mains: ["mains", "tandoor"], tandoor: ["mains", "tandoor"] };
const DELEGATE = /\b(?:surprise (?:me|us)|anything(?: is fine| works| goes)?|whatever|you (?:choose|pick|decide)|up to you|your (?:call|pick|choice)|(?:i |we )?trust you|you tell me|dealer'?s choice|chef'?s choice|no preference|not fussy|(?:i|we) eat (?:everything|anything|meat)|don't mind|doesn't matter)\b/i;
const TASTE = /\b(?:light|filling|hearty|heavy|snack|small|big|starter|share|sharing|comfort|healthy|fresh|crispy|creamy|tangy|sweet|savou?ry|grilled|smoky|rich|spicy|mild)\b/i;

/** One chip per constraint that can be lifted, each sent as words liftedPrefs reads as lifting it. */
function relaxChips(p: Prefs): Chip[] {
  const chip = (label: string, text: (typeof RECOMMEND_CHIP_TEXTS)[number]): Chip => ({ label, action: { type: "recommend", text } });
  return [
    ...(p.maxPrice !== null ? [chip("Any price", "Any price is fine")] : []),
    ...(p.diet.includes("vegan") ? [chip("Not only vegan", "Forget the vegan")] : p.diet.includes("vegetarian") ? [chip("Not only vegetarian", "Forget the vegetarian")] : []),
    ...(p.mild ? [chip("Spicy is fine", "Spicy is fine")] : []),
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
  const { prefs, added, inferred } = resolvePrefs(input.turn.prefs, input.context?.prefs, input.text, input.entries);
  input.trace.push({ action: "prefs", prefs, added, ...(inferred.length ? { inferred } : {}) });
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const previous = (input.context?.recommended ?? []).filter((id) => byId.has(id));
  // The chips send fixed texts, so "cheaper" and "another" never depend on the model alone. "Less spicy" and "spicier"
  // are read in code only (D-26; the model's relation has no word for them).
  const stated = explicitPrefs(input.text).relation ?? null;
  // Every relation is read from the guest's words or a chip's (FM-024); the model's is recorded as inferred.
  const relation: Relation | null = stated;
  // The dish "cheaper" is measured against: the last suggestion, else the first dish this conversation last showed.
  // The dish "cheaper" is measured against: the first dish last on screen, whichever kind of reply showed it (failure-mode
  // audit FM-004: after "how much is the Lamb Rogan Josh?", "anything cheaper?" compared with an older suggestion).
  const anchorId = [...(input.context?.shown ?? []), ...previous, ...(input.context?.lastCitedIds ?? [])].find((id) => byId.has(id)) ?? null;
  const last = anchorId ? byId.get(anchorId)! : null;
  const cheaperThan = relation === "cheaper" && last ? last.price : null;
  // "Less spicy" / "spicier" than the last dish (D-26), when its spice level is listed.
  // "Less spicy" than a dish that is already mild or not spicy: another mild dish (the "mild" preference it also sets),
  // not "nothing milder" (live LV-REC-014).
  const spiceBelow = relation === "milder" && last && last.spice !== null && last.spice >= 2 ? last.spice : null;
  const spiceAbove = relation === "spicier" && last && last.spice !== null ? last.spice : null;
  const spiceOk = (d: MenuEntry) => (spiceBelow === null || (d.spice !== null && d.spice < spiceBelow)) && (spiceAbove === null || (d.spice !== null && d.spice > spiceAbove));
  // Only dishes served at the guest's branch, when one is known (D-21 audit: Golf Course Road-only dishes were offered
  // for Hauz Khas).
  const eligible = (items: MenuEntry[], p: Prefs, o: { exclude?: string[]; cheaperThan?: number | null } = {}) => eligibleAll(items, p, { ...o, branch: input.branch }).filter(spiceOk);
  const asked = input.context?.asked ?? [];
  // A new constraint ("make it vegan") narrows the search: dishes shown before that meet it are fair game again, so
  // they are not excluded as "already suggested" (D-21 held-out LV-HOLD-012: the vegan alternatives were excluded).
  const before = input.context?.prefs ?? null;
  const tightened = !!before && (prefs.diet.some((d) => !before.diet.includes(d)) || prefs.avoid.some((a) => !before.avoid.includes(a)) || (prefs.maxPrice !== null && (before.maxPrice === null || prefs.maxPrice < before.maxPrice)) || (prefs.mild && !before.mild));
  // "Less spicy" / "spicier" also set a spice preference, but the dish they compare with is never offered again.
  const exclude = relation && (!tightened || relation === "milder" || relation === "spicier") ? previous : [];
  // D-28: the allergy note when it hasn't been shown for the allergies in force, or they are stated or change in this
  // message; not under every later suggestion (the constraint still filters every dish, and the same paragraph again
  // added nothing).
  const said = explicitPrefs(input.text);
  const newSafety = !input.context?.allergyNoted || !!said.allergy || !!said.avoid?.length || SAFETY_QUESTION.test(input.text) || (prefs.allergy && !before?.allergy) || prefs.avoid.some((a) => !(before?.avoid ?? []).includes(a));
  const allergyNote: Block[] = newSafety && (prefs.avoid.length || prefs.allergy) ? [{ type: "notice", tone: "info", text: ALLERGY_NOTE }] : [];
  const keep = (shown: string[]) => [...new Set([...shown, ...previous])].slice(0, 6);
  const done = (text: string, blocks: Block[]): RecommendResult => ({ text, blocks, cited: [], prefs, recommended: previous });

  // An allergen the labels don't cover: no dish can be checked against it, so the guest is sent to staff.
  const referral = unlistedReferral(prefs);
  if (referral) {
    input.trace.push({ action: "eligible", count: 0, none: "unlisted allergen" });
    return done(referral.text, referral.blocks);
  }

  // D-26: a request that says nothing about the guest gets one question first (once per conversation).
  const generic =
    !hasPrefs(prefs) && !prefs.allergy && !prefs.unlisted.length && !relation && !previous.length && !asked.includes("diet") && !DELEGATE.test(input.text) && !TASTE.test(input.text) && !liftedPrefs(input.text).diet.length && !foodWords(input.text, input.entries).length && !SIDE_WORDS.test(input.text);
  if (generic) {
    input.trace.push({ action: "ask_pref", args: { field: "diet" } });
    return { text: DIET_QUESTION, blocks: [DIET_CHIPS()], cited: [], prefs, recommended: previous, asked: "diet" };
  }
  // D-28: "something light" with no meal type known (no section stated, nothing suggested yet): one question about it,
  // instead of a mix of snacks and desserts that happen to share a label.
  // Only when nothing else is said: "light and not spicy for my kid" is answered at once (live LV-RET-001).
  // Gated on what is known about the guest, not on a section the model guessed (FM-003: a model-read "desserts" skipped
  // it). Preferences stated earlier count ("vegetarian under ₹300", then "which of those is light?": live LV-SAF-005
  // regressed when only this message was checked), and so does a list just shown that the message refers to.
  const saidNow = explicitPrefs(input.text);
  const saidSomething = !!(saidNow.diet?.length || saidNow.avoid?.length || saidNow.maxPrice !== undefined || saidNow.mild || saidNow.allergy || saidNow.spicy || saidNow.exclude?.length);
  const knownBefore = hasPrefs({ ...prefs, course: null }) || prefs.allergy;
  const refersToShown = !!input.context?.shown?.length && /\b(?:those|these|them|that list|the list|of the(?:se|m))\b/i.test(input.text);
  if (APPETITE.test(input.text) && courseIn(input.text) === null && !saidSomething && !knownBefore && !refersToShown && !relation && !previous.length && !asked.includes("course") && !DELEGATE.test(input.text) && !foodWords(input.text, input.entries).length) {
    input.trace.push({ action: "ask_pref", args: { field: "course" } });
    const q = courseQuestion(/\b(?:filling|hearty|heavy|something big)\b/i.test(input.text));
    return { ...q, cited: [], prefs, recommended: previous, asked: "course" };
  }

  // "Cheaper" and "another" stay in the last suggestion's section when the guest named none: a cheaper small plate, not
  // a bread. "Cheaper" never leaves it (nothing cheaper there is answered as such); "another" looks everywhere if the
  // section is used up. The section is not stored as a preference.
  // Mains and tandoor dishes are one family here: a cheaper main may come from the tandoor (live LV-POP-008: "nothing
  // cheaper" while a cheaper curry was on the card).
  const sameCourse = relation && prefs.course === null && last ? last.course : null;
  const family = sameCourse ? (COURSE_FAMILY[sameCourse] ?? [sameCourse]) : [];
  const scope: Prefs = sameCourse && family.length === 1 ? { ...prefs, course: sameCourse } : prefs;
  const inCourse = sameCourse ? eligible(input.entries, scope, { exclude, cheaperThan }).filter((d) => family.includes(d.course)) : [];
  const fitAll = sameCourse && (inCourse.length || cheaperThan !== null) ? inCourse : eligible(input.entries, prefs, { exclude, cheaperThan });
  // A side (bread, plain rice) or a drink is not a dish suggestion unless the guest asked for one or a section that has
  // them (chooser rule 2; D-24 audit: 4 of 39 cards led with a naan or a lime soda). Code decides it, so the chooser
  // reads fewer lines too.
  const askedForSides = prefs.course !== null || (sameCourse !== null && fitAll === inCourse) || SIDE_WORDS.test(input.text);
  const mains = askedForSides ? fitAll : fitAll.filter((d) => !isSide(d));
  const fit = mains.length ? mains : fitAll;
  if (!fit.length) {
    const what = family.length > 1 && cheaperThan !== null ? describePrefs(prefs).replace(/\bdishes\b/, "main dishes") : describePrefs(cheaperThan !== null ? scope : prefs);
    const any = eligible(input.entries, cheaperThan !== null ? scope : prefs).filter((d) => cheaperThan === null || !family.length || family.includes(d.course));
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
    if ((spiceBelow !== null || spiceAbove !== null) && last) {
      none = spiceBelow !== null ? "nothing milder" : "nothing spicier";
      input.trace.push({ action: "eligible", count: 0, none });
      return { text: `Nothing ${what === "dishes" ? "on the menu" : `among the ${what}`} is ${spiceBelow !== null ? "milder" : "spicier"} than the ${last.name} (${SPICE_NAMES[last.spice!]}).`, blocks: [...allergyNote, MENU_CHIP()], cited: [last.id], prefs, recommended: previous };
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
  // The dish the guest asked for by what's in it ("a fish dish from the tandoor") is on the menu but unavailable, and
  // nothing that fits has it: said first, so the suggestion isn't mistaken for it (live LV-GAP-015).
  // Section words ("tandoor", "dessert") are not what the dish is made of.
  const words = foodWords(input.text, input.entries).filter((w) => courseIn(w) === null);
  const has = (d: MenuEntry) => words.some((w) => new RegExp(`\\b${escapeRe(stemOf(w))}`).test(`${d.name} ${d.description}`.toLowerCase()));
  const out = words.length && !fit.some(has) ? input.entries.filter((d) => !d.available && has(d) && (prefs.course === null || d.course === prefs.course)) : [];
  const outNote = out.length ? `The ${out[0].name} is currently unavailable. ` : "";

  const relationLine =
    cheaperThan !== null && last
      ? `They want something cheaper than ${last.name} (₹${last.price}).`
      : spiceBelow !== null && last
        ? `They want something less spicy than ${last.name} (${SPICE_NAMES[last.spice!]}).`
        : relation === "milder" && last
          ? `They want something less spicy; the ${last.name} is already ${last.spice === null ? "not listed for spice" : SPICE_NAMES[last.spice]}, so suggest another mild dish and say it is mild.`
        : spiceAbove !== null && last
          ? `They want something spicier than ${last.name} (${SPICE_NAMES[last.spice!]}).`
          : relation === "another" && previous.length
            ? `They want something different from: ${previous.map((x) => byId.get(x)!.name).join(", ")}.`
            : null;
  if (sameCourse && fit === inCourse) input.trace.push({ action: "eligible", count: inCourse.length, none: `same section as ${last!.name}` });
  // A liking for spice guides the choice; it filters nothing (review of D-26: as a filter it emptied desserts and drinks).
  const prefsLine = [hasPrefs(prefs) ? describePrefs(prefs) : null, prefs.spicy ? "they like spicy food (medium or hot)" : null, prefs.allergy ? "they have a food allergy, so never call a dish safe or free of anything" : null].filter(Boolean).join("; ") || "none stated";
  const messages: LlmMessage[] = [
    { role: "system", content: buildChooserSystem(input.restaurant) },
    { role: "user", content: buildChooserUser({ prefs: prefsLine, relation: relationLine, history: input.history, dishes: shortlist(fit, input.relevant ?? []), guest: input.text }) },
  ];

  let lastPick: string | null = null;
  let alternatives: string[] = [];
  for (const attempt of [1, 2] as const) {
    // The turn is past its time budget: the code list instead of another model call, attempt 1 included (failure-mode
    // audit FM-025: the first chooser call always ran, after however long the intent call and its retry took).
    if (input.canRetry && !input.canRetry()) break;
    const r = await call(attempt, messages);
    if (!r.choice) {
      input.trace.push({ action: "recommend", attempt, result: r.code, pick: null, alternatives: [], rejected: [] });
      if (r.code !== "MODEL_INVALID_OUTPUT") break; // down or timed out: fall back without another call
      messages.push({ role: "assistant", content: r.content }, { role: "user", content: chooserCorrection(["it was not a valid JSON object for the schema"]) });
      continue;
    }
    // Only the dish compared with, and only while it still meets the preferences (review of D-24: a nut dish could be
    // named to a guest who had just said they're allergic to nuts).
    const compareWith = relation && last && unmet(last, { ...prefs, maxPrice: null }) === null ? [last.id] : [];
    // A question was already asked in this conversation (D-26): now the guest gets a dish, not another question.
    const v = validateChoice(r.choice, fit, byId, prefs, input.grounding, { mustPick: CHOOSE_WORDS.test(input.text) || asked.length > 0, mayName: compareWith, guest: input.text, relation });
    input.trace.push({ action: "recommend", attempt, result: v.reasons.length ? "rejected" : "ok", pick: r.choice.pick, alternatives: r.choice.alternatives, rejected: v.reasons });
    if (!v.reasons.length) {
      if (v.pick === null) return done(r.choice.reply.trim(), [...allergyNote, ANSWER_CHIPS()]);
      const shown = [v.pick, ...v.alternatives];
      return { text: `${outNote}${r.choice.reply.trim()}`, blocks: [{ type: "recommendation", lead: true, items: shown.map((x) => view(byId.get(x)!)) }, ...allergyNote, FOLLOW_UPS()], cited: shown, prefs, recommended: keep(shown) };
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
    // The reason is the dish's own description (D-26: the plain line gave none).
    return { text: `${outNote}I'd suggest the ${d.name} (₹${d.price}): ${d.description.charAt(0).toLowerCase()}${d.description.slice(1).replace(/[.\s]+$/, "")}.`, blocks: [{ type: "recommendation", lead: true, items: shown.map((x) => view(byId.get(x)!)) }, ...allergyNote, FOLLOW_UPS()], cited: shown, prefs, recommended: keep(shown) };
  }
  const few = relevantFirst(fit, input.relevant ?? []).slice(0, 3);
  return { text: hasPrefs(prefs) ? `Here are a few ${describePrefs(prefs, { cheaperThan })} to choose from.` : "Here are a few dishes to choose from.", blocks: [{ type: "recommendation", lead: false, items: few.map(view) }, ...allergyNote, FOLLOW_UPS()], cited: few.map((d) => d.id), prefs, recommended: keep(few.map((d) => d.id)) };
}
