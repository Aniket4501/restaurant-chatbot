import type { FactSource } from "@/lib/kb/facts";
import { branchShortName } from "@/lib/kb/facts";
import { COURSES, type Block, type Course, type MenuItemView, type Prefs } from "@/lib/chat/types";

// The menu as guests see it, and the deterministic half of recommendations (D-20).
// - Dish views come only from the menu table: names, prices, labels and descriptions are never model text.
// - `eligible` applies the guest's stated constraints to verified data (labels, allergens, price, course, spice,
//   availability). It filters; it never ranks. Choosing among the dishes that fit is the model's job (lib/chat/recommend.ts).
// - A missing label means unknown: only a dish labelled vegan counts as vegan, only one not labelled with an allergen
//   passes "avoid", and the guest is always told that labels don't make a dish allergen-safe.

export const COURSE_LABEL: Record<Course, string> = { "small-plates": "Small plates", tandoor: "Tandoor", mains: "Mains", "breads-rice": "Breads and rice", desserts: "Desserts", drinks: "Drinks" };
const COURSE_NOUN: Record<Course, string> = { "small-plates": "small plates", tandoor: "tandoor dishes", mains: "main courses", "breads-rice": "breads or rice dishes", desserts: "desserts", drinks: "drinks" };

/** A menu row with the verified data the filters need; `view` strips it to what the guest sees. */
export type MenuEntry = MenuItemView & { available: boolean; dietary: string[]; branches: string[] | null };
export const view = (e: MenuEntry): MenuItemView => ({ id: e.id, name: e.name, course: e.course, courseLabel: e.courseLabel, price: e.price, description: e.description, labels: e.labels, contains: e.contains, spice: e.spice, scope: e.scope });

/** Every dish served at an active branch, available or not, in menu order. */
export function menuEntries(src: FactSource): MenuEntry[] {
  const active = new Map(src.branches.filter((b) => b.isActive).map((b) => [b.slug, b.name]));
  const out: MenuEntry[] = [];
  for (const m of src.menu) {
    const scope = m.branches?.filter((s) => active.has(s)) ?? null;
    if (!(COURSES as readonly string[]).includes(m.category) || (scope !== null && scope.length === 0)) continue;
    const d = m.dietary;
    const course = m.category as Course;
    out.push({
      id: `menu:${m.slug}`,
      name: m.name,
      course,
      courseLabel: COURSE_LABEL[course],
      price: m.priceInr,
      description: m.description,
      labels: [d.includes("vegan") ? "Vegan" : d.includes("vegetarian") ? "Vegetarian" : null, d.includes("gluten-free") ? "Gluten-free" : null, d.includes("jain-available") ? "Jain option" : null].filter((x): x is string => !!x),
      contains: [d.includes("contains-dairy") ? "dairy" : null, d.includes("contains-nuts") ? "nuts" : null, d.includes("egg") ? "egg" : null].filter((x): x is string => !!x),
      spice: m.spiceLevel ?? null,
      scope: scope ? `${scope.map((s) => branchShortName(active.get(s)!)).join(" and ")} only` : null,
      available: m.isAvailable,
      dietary: d,
      branches: scope, // null: every branch
    });
  }
  return out;
}

/** Why a dish fails the stated constraints, or null if it satisfies all of them (verified data only). */
export function unmet(item: MenuEntry, prefs: Prefs): string | null {
  const d = item.dietary;
  if (!item.available) return "unavailable";
  for (const want of prefs.diet) {
    if (want === "vegetarian" && !(d.includes("vegetarian") || d.includes("vegan"))) return "not vegetarian";
    if (want === "vegan" && !d.includes("vegan")) return "not vegan";
    if (want === "gluten-free" && !d.includes("gluten-free")) return "not labelled gluten-free";
    if (want === "jain" && !d.includes("jain-available")) return "no Jain option";
  }
  for (const a of prefs.avoid) if (item.contains.includes(a)) return `contains ${a}`;
  if (prefs.maxPrice !== null && item.price > prefs.maxPrice) return `over ₹${prefs.maxPrice}`;
  if (prefs.course !== null && item.course !== prefs.course) return `not one of the ${COURSE_NOUN[prefs.course]}`;
  if (prefs.mild && item.spice === null) return "spice level not listed";
  if (prefs.mild && (item.spice ?? 0) > 1) return "too spicy";
  return null;
}

/** Served at this branch (a dish with no branch list is served at both). */
export const servedAt = (i: MenuEntry, branch: string | null | undefined) => !branch || !i.branches || i.branches.includes(branch);

/** The dishes that satisfy the constraints, in menu order (no ranking); at the guest's branch when one is known. */
export function eligible(items: MenuEntry[], prefs: Prefs, opts: { exclude?: string[]; cheaperThan?: number | null; branch?: string | null } = {}): MenuEntry[] {
  const exclude = new Set(opts.exclude ?? []);
  return items.filter((i) => !exclude.has(i.id) && unmet(i, prefs) === null && (opts.cheaperThan == null || i.price < opts.cheaperThan) && servedAt(i, opts.branch));
}

/**
 * An allergy the labels don't cover (shellfish, fish, soy, sesame…): no dish can be checked against it, so the guest is
 * sent to staff, on the menu path as on the recommendation path (D-21 audit: menus listed the prawn curry).
 */
export function unlistedReferral(prefs: Prefs): { text: string; blocks: Block[] } | null {
  if (!prefs.unlisted.length) return null;
  const named = prefs.unlisted.filter((u) => u !== "other");
  return {
    text: `Our menu labels only cover nuts, dairy, egg and gluten, not ${named.length ? named.join(" or ") : "that allergen"}, so I can't suggest a dish around your allergy. Please ask your server, who can check each dish with the kitchen.`,
    blocks: [{ type: "notice", tone: "info", text: ALLERGY_NOTE }, { type: "quick_replies", chips: [{ label: "Show me the menu", action: { type: "menu", course: null } }] }],
  };
}

// Words that say nothing about a dish ("do you have any dishes?"), left out of an ingredient search.
const NOT_FOOD = new Set(["menu", "menus", "dish", "dishes", "food", "foods", "item", "items", "have", "with", "what", "which", "your", "you", "any", "anything", "something", "some", "show", "see", "list", "please", "there", "options", "option", "serve", "available", "today", "tonight", "would", "like", "want", "could", "the", "and", "for", "are", "can", "get", "all", "full", "whole", "made", "contain", "contains", "do"]);

/** The words of the message that appear in dish names or descriptions ("paneer", "prawns"): an ingredient search. */
export function foodWords(text: string, items: MenuEntry[]): string[] {
  const hay = items.map((i) => `${i.name} ${i.description}`.toLowerCase());
  const words = [...new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter((w) => !NOT_FOOD.has(w));
  const stem = (w: string) => w.replace(/(?:es|s)$/, "");
  return words.filter((w) => hay.some((h) => new RegExp(`\\b${stem(w)}`).test(h)));
}

/** "mild vegan main courses without nuts, up to ₹200": the honest no-match reply and the prompt's preference line. */
export function describePrefs(prefs: Prefs, opts: { cheaperThan?: number | null } = {}): string {
  const diet = prefs.diet.map((d) => (d === "jain" ? "Jain-friendly" : d)).join(", ");
  const parts = [`${prefs.mild ? "mild " : ""}${diet ? `${diet} ` : ""}${prefs.course ? COURSE_NOUN[prefs.course] : "dishes"}`];
  if (prefs.avoid.length) parts.push(`without ${prefs.avoid.join(" or ")}`);
  if (prefs.maxPrice !== null) parts.push(`up to ₹${prefs.maxPrice}`);
  if (opts.cheaperThan != null) parts.push(`under ₹${opts.cheaperThan}`);
  return parts.join(", ");
}

export const hasPrefs = (p: Prefs) => p.diet.length > 0 || p.avoid.length > 0 || p.maxPrice !== null || p.course !== null || p.mild;
/** The allergy note applies: an allergen to avoid, an allergy, or a medical gluten-free need (the kitchen handles gluten). */
export const needsAllergyNote = (p: Prefs) => p.avoid.length > 0 || p.allergy;

/** The safety line shown whenever an allergen or allergy is in play (FAQ "allergies"; never left to the model). */
export const ALLERGY_NOTE = "Menu labels only list the main allergens, and our kitchen handles nuts, dairy, gluten and shellfish, so we can't guarantee any dish is free of traces. Please tell your server about any allergy.";

/**
 * Menu browsing (D-20), no model involved: with no section and no preferences, the list of sections; otherwise the
 * matching dishes grouped by course. Unavailable dishes are left out of lists.
 */
export function menuStep(items: MenuEntry[], prefs: Prefs, course: Course | null, opts: { branch?: string | null; words?: string[] } = {}): { text: string; blocks: Block[]; shown: number; cited: string[] } {
  const p: Prefs = { ...prefs, course: course ?? prefs.course };
  const sections: Block = { type: "quick_replies", chips: COURSES.filter((c) => items.some((i) => i.course === c)).map((c) => ({ label: COURSE_LABEL[c], action: { type: "menu" as const, course: c } })) };
  const referral = unlistedReferral(p);
  if (referral) return { ...referral, shown: 0, cited: [] };
  const words = opts.words ?? [];
  // An ingredient question ("do you have paneer dishes?", D-21 audit): the dishes whose name or description has it.
  if (words.length && p.course === null) {
    const stem = (w: string) => w.replace(/(?:es|s)$/, "");
    const found = eligible(items, { ...p, course: null }, { branch: opts.branch }).filter((i) => words.some((w) => new RegExp(`\\b${stem(w)}`).test(`${i.name} ${i.description}`.toLowerCase())));
    const note: Block[] = p.avoid.length || p.allergy ? [{ type: "notice", tone: "info", text: ALLERGY_NOTE }] : [];
    if (!found.length) return { text: `We don't have any ${hasPrefs(p) ? `${describePrefs(p)} ` : "dishes "}with ${words.join(" or ")} on the menu right now.`, blocks: [...note, sections], shown: 0, cited: [] };
    const groups = COURSES.map((c) => ({ course: c, label: COURSE_LABEL[c], items: found.filter((i) => i.course === c).map(view) })).filter((g) => g.items.length);
    return { text: `Here's what we have with ${words.join(" or ")}.`, blocks: [{ type: "menu_list", groups }, ...note], shown: found.length, cited: found.slice(0, 8).map((d) => d.id) };
  }
  if (!hasPrefs(p)) return { text: "Which part of the menu would you like to see?", blocks: [sections], shown: 0, cited: [] };
  const fit = eligible(items, p, { branch: opts.branch });
  const note: Block[] = needsAllergyNote(p) ? [{ type: "notice", tone: "info", text: ALLERGY_NOTE }] : [];
  // Nothing fits: the sections are offered, so the guest is never left without a way on.
  if (!fit.length) return { text: `We don't have any ${describePrefs(p)} on the menu right now.`, blocks: [...note, sections], shown: 0, cited: [] };
  const groups = COURSES.map((c) => ({ course: c, label: COURSE_LABEL[c], items: fit.filter((i) => i.course === c).map(view) })).filter((g) => g.items.length);
  const sectionOnly = p.course !== null && !p.diet.length && !p.avoid.length && p.maxPrice === null && !p.mild;
  const text = sectionOnly ? `Here are our ${COURSE_NOUN[p.course!]}.` : `Here's what we have: ${describePrefs(p)}.`;
  // The dishes listed are this turn's facts, so a follow-up ("is the first one spicy?") can be answered (D-13 carry).
  return { text, blocks: [{ type: "menu_list", groups }, ...note], shown: fit.length, cited: fit.slice(0, 8).map((d) => d.id) };
}
