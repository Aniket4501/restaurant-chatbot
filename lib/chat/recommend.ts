import { checkGrounding, type GroundingContext } from "@/lib/chat/grounding";
import { smalltalkShowable } from "@/lib/chat/claims";
import { ALLERGY_NOTE, describePrefs, eligible, hasPrefs, unmet, view, type MenuEntry } from "@/lib/chat/menu";
import { AVOIDS, DIETS, noPrefs, PrefsSchema, type Action, type Block, type Prefs, type TraceEntry, type TurnContext } from "@/lib/chat/types";
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

const NEGATION = /\b(?:no|not|non|isn't|aren't|without|never)\b|n't\b/i;

/** Constraints the guest's own words state for certain (D-20): code adds them if the model's prefs left them out. */
export function explicitPrefs(raw: string): Partial<Prefs> {
  const t = foldDigits(raw).toLowerCase().replace(/[’‘]/g, "'");
  const out: Partial<Prefs> = {};
  const budget = /\b(?:under|below|less than|within|up ?to|max(?:imum)?|no more than|not more than|budget(?: of| is)?)\s*(?:₹|rs\.?\s*|inr\s*)?(\d{2,5})\b|(?:₹|rs\.?\s*)(\d{2,5})\s*(?:or less|max|tops)\b/.exec(t);
  if (budget) out.maxPrice = Number(budget[1] ?? budget[2]);
  const diet: Prefs["diet"] = [];
  if (/(?<!non[- ]?)\bvegan\b/.test(t)) diet.push("vegan");
  if (/(?<!non[- ]?)\bvegetarian\b|\bpure veg\b|(?<!non[- ]?)\bveg (?:options?|dishes|food|only)\b/.test(t)) diet.push("vegetarian");
  if (/\bgluten[- ]free\b|\bno gluten\b|\bcoeliac\b|\bceliac\b/.test(t)) diet.push("gluten-free");
  if (/\bjain\b/.test(t)) diet.push("jain");
  if (diet.length) out.diet = diet;
  if (/\bnot (?:too |very |that |so )?spicy\b|\bmild\b|\bless spicy\b|\bno spice\b|\bnon[- ]spicy\b/.test(t)) out.mild = true;
  const allergy = /\ballerg(?:y|ic|ies)\b|\banaphyla/.test(t);
  if (allergy) out.allergy = true;
  const avoid: Prefs["avoid"] = [];
  if (/\b(?:pea)?nuts?\b|\bcashews?\b|\balmonds?\b|\bpistachios?\b/.test(t) && (allergy || /\b(?:no|without|free|avoid|can't|cannot)\b/.test(t))) avoid.push("nuts");
  if (/\bdairy\b|\blactose\b|\bmilk\b/.test(t) && (allergy || /\b(?:no|without|free|avoid|can't|cannot)\b/.test(t))) avoid.push("dairy");
  if (/\beggs?\b/.test(t) && (allergy || /\b(?:no|without|free|avoid|can't|cannot)\b/.test(t))) avoid.push("egg");
  if (avoid.length) out.avoid = avoid;
  return out;
}

/** Active preferences after this turn: the model's proposal (or the previous ones), plus anything stated for certain. */
export function resolvePrefs(model: Turn["prefs"], previous: Prefs | null | undefined, text: string): { prefs: Prefs; added: string[] } {
  const base: Prefs = model ? PrefsSchema.parse({ diet: [...new Set(model.diet)], avoid: [...new Set(model.avoid)], maxPrice: model.maxPrice && model.maxPrice > 0 ? model.maxPrice : null, course: model.course, mild: model.mild, allergy: model.allergy }) : { ...(previous ?? noPrefs()) };
  const ex = explicitPrefs(text);
  const added: string[] = [];
  for (const d of ex.diet ?? [])
    if (!base.diet.includes(d)) {
      base.diet.push(d);
      added.push(d);
    }
  for (const a of ex.avoid ?? [])
    if (!base.avoid.includes(a)) {
      base.avoid.push(a);
      added.push(`no ${a}`);
    }
  if (ex.maxPrice !== undefined && base.maxPrice !== ex.maxPrice) {
    base.maxPrice = ex.maxPrice;
    added.push(`up to ₹${ex.maxPrice}`);
  }
  if (ex.mild && !base.mild) {
    base.mild = true;
    added.push("mild");
  }
  if (ex.allergy && !base.allergy) {
    base.allergy = true;
    added.push("allergy");
  }
  base.diet = DIETS.filter((d) => base.diet.includes(d));
  base.avoid = AVOIDS.filter((a) => base.avoid.includes(a));
  return { prefs: base, added };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Claims the menu can't support (rule 4 of the chooser prompt), unless the dish's own description says so.
const HYPE_RE = /\b(?:most popular|popular|best[- ]?sell\w*|favou?rites?|signature|chef'?s (?:special|choice|pick|recommendation)|award[- ]winning|famous|highly rated|top[- ]rated|must[- ]try|crowd[- ]pleaser)\b/i;
// Allergen safety can't be confirmed from labels (ALLERGY_NOTE).
const SAFETY_RE = /\b(?:nut|peanut|allergen|allergy)[- ]free\b|\b(?:allergy|allergen)[- ]safe\b|\bsafe for (?:people with |anyone with |your |an? )?(?:\w+ )?allerg/i;
// A diet word in a sentence that isn't negated must be true of at least one dish shown.
const DIET_WORDS: { re: RegExp; label: string; has: (d: MenuEntry) => boolean }[] = [
  { re: /\bvegan\b/i, label: "vegan", has: (d) => d.dietary.includes("vegan") },
  { re: /\bvegetarian\b/i, label: "vegetarian", has: (d) => d.dietary.includes("vegetarian") || d.dietary.includes("vegan") },
  { re: /\bgluten[- ]free\b/i, label: "labelled gluten-free", has: (d) => d.dietary.includes("gluten-free") },
  { re: /\bjain\b/i, label: "a Jain option", has: (d) => d.dietary.includes("jain-available") },
  { re: /\b(?:dairy|egg)[- ]free\b/i, label: "vegan (the only dishes known to be dairy- and egg-free)", has: (d) => d.dietary.includes("vegan") },
];

/** Why a chooser reply can't be shown (empty when it can). Exported for tests. */
export function validateChoice(raw: Choice, fit: MenuEntry[], all: Map<string, MenuEntry>, prefs: Prefs, grounding: GroundingContext): { reasons: string[]; alternatives: string[]; pick: string | null } {
  // Dishes are listed by slug; "dal-ember" and "menu:dal-ember" both mean the dish (a format, not a fact).
  const id = (s: string) => (s.startsWith("menu:") ? s : `menu:${s}`);
  const choice: Choice = { ...raw, pick: raw.pick === null ? null : id(raw.pick.trim()), alternatives: raw.alternatives.map((a) => id(a.trim())) };
  const reasons: string[] = [];
  const fitIds = new Set(fit.map((d) => d.id));
  const reply = choice.reply.trim();
  if (!reply) reasons.push("the reply is empty");
  if (choice.pick === null) {
    // A clarifying question: no dish, no prices, no booking words.
    if (reply && !(reply.includes("?") && smalltalkShowable(reply))) reasons.push("without a dish, the reply must be one short question with no prices or booking words");
    return { reasons, alternatives: [], pick: null };
  }
  const pick = all.get(choice.pick);
  if (!fitIds.has(choice.pick)) reasons.push(pick ? `${pick.name} ${unmet(pick, prefs) ?? "is not one of the dishes listed"}` : `"${raw.pick}" is not one of the listed IDs`);
  const alternatives = [...new Set(choice.alternatives)].filter((a) => a !== choice.pick && fitIds.has(a)).slice(0, 2);
  if (reasons.length) return { reasons, alternatives, pick: choice.pick };
  const shown = [choice.pick, ...alternatives].map((id) => all.get(id)!);
  const n = norm(reply);
  const named = norm(pick!.name);
  const words = named.split(" ");
  if (!n.includes(named) && !(words.length >= 2 && n.includes(words.slice(0, 2).join(" ")))) reasons.push(`the reply must name ${pick!.name}`);
  const g = checkGrounding(reply, shown.map((d) => d.id), { ...grounding, sentIds: fitIds });
  if (!g.ok) reasons.push(g.reason === "price" ? `the reply has a price that is not on the menu (${g.detail})` : g.reason === "claim" || g.reason === "booking_state" ? "the reply must not talk about tables or bookings" : `the reply has an unsupported detail (${g.detail || g.reason})`);
  // Each price must sit with its own dish (review: grounding only checks that a price exists somewhere in the
  // cited facts). Per clause, the dishes named and the prices given are paired in order.
  for (const clause of reply.split(/[.;!?]|,\s+(?:or|and|but)\s+/)) {
    const nc = norm(clause);
    const at = (d: MenuEntry) => {
      const full = nc.indexOf(norm(d.name));
      return full >= 0 ? full : nc.indexOf(norm(d.name).split(" ").slice(0, 2).join(" "));
    };
    const names = shown
      .map((d) => ({ d, at: at(d) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at);
    const prices = priceSpans(clause).map((s) => s.value);
    if (names.length && prices.length === names.length) {
      for (let i = 0; i < names.length; i++) if (prices[i] !== names[i].d.price) reasons.push(`the reply gives ${names[i].d.name} the wrong price (₹${prices[i]})`);
    } else if (names.length === 1 && prices.some((v) => v !== names[0].d.price)) reasons.push(`the reply gives ${names[0].d.name} a price that isn't its own`);
  }
  const hype = HYPE_RE.exec(reply);
  if (hype && !shown.some((d) => d.description.toLowerCase().includes(hype[0].toLowerCase()))) reasons.push(`"${hype[0]}" is not supported by the menu`);
  if (SAFETY_RE.test(reply)) reasons.push("the reply must not promise allergen safety");
  for (const s of reply.split(/(?<=[.!?])\s+/)) {
    if (NEGATION.test(s)) continue;
    for (const w of DIET_WORDS) if (w.re.test(s) && !shown.some(w.has)) reasons.push(`no dish shown is ${w.label}`);
  }
  return { reasons: [...new Set(reasons)], alternatives, pick: choice.pick };
}

export type ChooserCall = (attempt: 1 | 2, messages: LlmMessage[]) => Promise<{ choice: Choice | null; code: string; content: string }>;

export type RecommendResult = { text: string; blocks: Block[]; cited: string[]; prefs: Prefs; recommended: string[] };

const FOLLOW_UPS = (): Block => ({
  type: "quick_replies",
  chips: [
    { label: "Something cheaper", text: "Anything cheaper?" },
    { label: "Another option", text: "Show me another option" },
    { label: "Find a table", action: { type: "set_field", field: "branch", value: null } as Action },
  ],
});

/**
 * A "recommend" turn after the first model call. `call` runs the chooser through the model gate; it is never called
 * when no dish fits, so an impossible request is answered honestly without a model call.
 */
export async function recommendTurn(
  input: { turn: Turn; text: string; history: { role: "guest" | "assistant"; content: string }[]; context: Partial<TurnContext> | undefined; entries: MenuEntry[]; restaurant: string; grounding: GroundingContext; trace: TraceEntry[]; canRetry?: () => boolean },
  call: ChooserCall,
): Promise<RecommendResult> {
  const { prefs, added } = resolvePrefs(input.turn.prefs, input.context?.prefs, input.text);
  input.trace.push({ action: "prefs", prefs, added });
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const previous = (input.context?.recommended ?? []).filter((id) => byId.has(id));
  const relation = input.turn.prefs?.relation ?? null;
  const last = previous.length ? byId.get(previous[0])! : null;
  const cheaperThan = relation === "cheaper" && last ? last.price : null;
  const exclude = relation === "another" || relation === "cheaper" ? previous : [];
  const fit = eligible(input.entries, prefs, { exclude, cheaperThan });
  const allergyNote: Block[] = prefs.avoid.length || prefs.allergy ? [{ type: "notice", tone: "info", text: ALLERGY_NOTE }] : [];
  const keep = (shown: string[]) => [...new Set([...shown, ...previous])].slice(0, 6);

  if (!fit.length) {
    const what = describePrefs(prefs, { cheaperThan });
    const none = relation === "another" && eligible(input.entries, prefs, { cheaperThan }).length ? "already suggested every dish that fits" : "no dish fits";
    input.trace.push({ action: "eligible", count: 0, none });
    const text = none === "no dish fits" ? `We don't have any ${what} on the menu.${hasPrefs(prefs) ? " Want me to relax one of those?" : ""}` : `That's every ${what.replace(/^dishes$/, "dish")} we have. Want to try something different?`;
    return { text, blocks: [...allergyNote, { type: "quick_replies", chips: [{ label: "Show me the menu", action: { type: "menu", course: null } }] }], cited: [], prefs, recommended: previous };
  }
  input.trace.push({ action: "eligible", count: fit.length, none: null });

  const relationLine = cheaperThan !== null && last ? `They want something cheaper than ${last.name} (₹${last.price}).` : relation === "another" && previous.length ? `They want something different from: ${previous.map((id) => byId.get(id)!.name).join(", ")}.` : null;
  const messages: LlmMessage[] = [
    { role: "system", content: buildChooserSystem(input.restaurant) },
    { role: "user", content: buildChooserUser({ prefs: hasPrefs(prefs) ? describePrefs(prefs) : "none stated", relation: relationLine, history: input.history, dishes: fit, guest: input.text }) },
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
      if (v.pick === null) return { text: r.choice.reply.trim(), blocks: [...allergyNote, { type: "quick_replies", chips: [{ label: "Show me the menu", action: { type: "menu", course: null } }] }], cited: [], prefs, recommended: previous };
      const shown = [v.pick, ...v.alternatives];
      return { text: r.choice.reply.trim(), blocks: [{ type: "recommendation", lead: true, items: shown.map((id) => view(byId.get(id)!)) }, ...allergyNote, FOLLOW_UPS()], cited: shown, prefs, recommended: keep(shown) };
    }
    if (v.pick && fit.some((d) => d.id === v.pick)) {
      lastPick = v.pick;
      alternatives = v.alternatives;
    }
    messages.push({ role: "assistant", content: r.content }, { role: "user", content: chooserCorrection(v.reasons) });
  }

  // Fallbacks, in code and honest about it: the model's valid pick with a plain line, or a few dishes that fit.
  if (lastPick) {
    const d = byId.get(lastPick)!;
    const shown = [lastPick, ...alternatives];
    return { text: `I'd suggest the ${d.name} (₹${d.price}).`, blocks: [{ type: "recommendation", lead: true, items: shown.map((id) => view(byId.get(id)!)) }, ...allergyNote, FOLLOW_UPS()], cited: shown, prefs, recommended: keep(shown) };
  }
  const few = fit.slice(0, 3);
  return { text: hasPrefs(prefs) ? `Here are a few ${describePrefs(prefs, { cheaperThan })} to choose from.` : "Here are a few dishes to choose from.", blocks: [{ type: "recommendation", lead: false, items: few.map(view) }, ...allergyNote, FOLLOW_UPS()], cited: few.map((d) => d.id), prefs, recommended: keep(few.map((d) => d.id)) };
}
