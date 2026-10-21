import { describePrefs, hasPrefs, servedAt, unmet, view, type MenuEntry } from "@/lib/chat/menu";
import { courseIn, DIET_CHIPS, DIET_QUESTION } from "@/lib/chat/recommend";
import type { Block, Chip, Course, Prefs, TraceEntry, TurnContext } from "@/lib/chat/types";

// Popularity, review and evidence questions (D-26). "What is your best seller?", "most popular dessert?", "which dish
// has the best reviews?", "do you have sales data for that?" are factual questions, not requests to choose. The data
// has no sales figures, ratings or reviews; the only evidence is a dish staff mark as a bestseller in the admin. So
// they are answered in code from that mark: the marked dishes that fit the question, or an honest "we don't keep
// that" with an offer to suggest something instead. Nothing here infers popularity from a description, a price or
// the model's judgment. "What's your best dish?" is not one of these: it is subjective, so it takes the
// recommendation path.

export type EvidenceKind = "sales" | "reviews" | "evidence";

const SALES = /\b(?:(?:best|top|biggest)[- ]?(?:[a-z]+[- ]){0,2}?sell(?:er|ers|ing)|sells? (?:the )?(?:most|best)|most (?:popular|ordered|loved|liked|requested|famous)|popular(?:ity)?|(?:fan|guest|customer|crowd)(?:'s|s')? favou?rites?|signature (?:dish|dishes)|what (?:do|does) (?:most )?(?:people|guests|everyone|customers|others) (?:usually |normally |mostly |tend to )?(?:order|get|eat|like|choose|pick))\b/i;
const REVIEWS = /\b(?:reviews?|reviewed|ratings?|rated|stars?)\b/i;
const EVIDENCE = /\b(?:sales (?:data|figures|numbers|records)|data (?:to (?:support|back)|behind|for that)|any (?:data|evidence|proof)|how do you know|based on what|what (?:is|'s) that based on|is that (?:really )?(?:popular|a bestseller|true|right))\b/i;

/** The kind of popularity question the message asks, or null. */
export function evidenceQuestion(text: string): EvidenceKind | null {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  if (EVIDENCE.test(t)) return "evidence";
  if (REVIEWS.test(t) && /\b(?:best|top|highest|good|great|which|what|any|most|well)\b/.test(t)) return "reviews";
  if (SALES.test(t)) return "sales";
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

  // "Is the butter chicken popular?": about one dish.
  const named = input.entries.filter((e) => new RegExp(`\\b${e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(input.text));
  if (named.length === 1 && input.kind !== "evidence") {
    const d = named[0];
    if (d.bestseller) return { text: `Yes: the restaurant marks the ${d.name} as a bestseller.`, blocks: [card([d])], cited: [d.id], recommended: [d.id] };
    return { text: `We don't keep sales figures, ratings or reviews, so I can't say how popular the ${d.name} is. The restaurant hasn't marked it as a bestseller.`, blocks: [], cited: [d.id] };
  }

  if (input.kind === "evidence") {
    const lastId = input.context?.recommended?.[0] ?? null;
    const last = lastId ? input.entries.find((e) => e.id === lastId) ?? null : null;
    const why = last
      ? ` I suggested the ${last.name} because ${hasPrefs(input.prefs) ? `it fits what you asked for (${describePrefs(input.prefs)})` : "its menu description matched your request"}${last.bestseller ? ", and the restaurant marks it as a bestseller" : ""}.`
      : " My suggestions come from the menu and what you tell me.";
    return { text: `No, we don't keep sales or popularity figures, ratings or reviews.${why}`, blocks: [], cited: last ? [last.id] : [] };
  }

  if (input.kind === "reviews") {
    const head = `We don't collect reviews or ratings, so I can't say which ${w} is rated best.`;
    if (fit.length) return { text: `${head} The restaurant does mark ${names(fit.slice(0, 3))} as ${fit.length === 1 ? "a bestseller" : "bestsellers"}.`, blocks: [card(fit)], cited: fit.slice(0, 3).map((d) => d.id), recommended: fit.slice(0, 3).map((d) => d.id) };
    const o = offer();
    return { text: `${head}${o.text}`, blocks: o.blocks, cited: [], asked: o.asked };
  }

  // Sales and popularity.
  if (fit.length) {
    const among = p.course || p.diet.length ? `Of the ${w}${w.endsWith("sh") ? "es" : "s"}, the` : "The";
    const shown = fit.slice(0, 3);
    return { text: `${among} restaurant marks ${names(shown)} as ${shown.length === 1 ? "a bestseller" : "bestsellers"}.`, blocks: [card(shown)], cited: shown.map((d) => d.id), recommended: shown.map((d) => d.id) };
  }
  const o = offer();
  if (marked.length) return { text: `None of the dishes the restaurant marks as bestsellers is ${article(w)}.${o.text}`, blocks: o.blocks, cited: [], asked: o.asked };
  return { text: `We don't keep sales or popularity figures, so I can't say which ${w} sells best.${o.text}`, blocks: o.blocks, cited: [], asked: o.asked };
}
