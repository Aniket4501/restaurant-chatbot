import type { DB } from "@/lib/db/client";
import { formatPhone } from "@/lib/phone";
import { DAY_KEYS, dayLabelLong, timeLabelOf, weekdayOf, type LocalDate } from "@/lib/time/tz";
import { horizonDates } from "@/lib/time/calendar";
import { RULES } from "@/lib/config";

// ID-tagged facts (§5.7, D-13), rendered from the database in the 12-hour and ₹ formats the bot answers in.
// Text is byte-compatible with the Phase 2 probe (scripts/model-probe.mjs, prompt v2), which is what the model
// was selected on; tests compare against its --dump-facts output. Additions since the probe: the restaurant
// fact, menu-cat/menu-diet aggregates (D-13), and weekly hours facts naming their exceptions (D-10).

export type FactKind = "restaurant" | "branch" | "hours" | "exception" | "menu" | "faq" | "menu-cat" | "menu-diet";
export type Fact = {
  id: string;
  kind: FactKind;
  /** What the model sees and what answers are grounded against. */
  text: string;
  /**
   * What FTS5 and the embedder index, if not `text`. Only aggregates set it: a full 35-item list ranks poorly on
   * bm25 (length normalisation) and its vector is diluted, so they are indexed by a short description instead
   * (T-10 measurement, see DECISIONS D-13 note).
   */
  indexText?: string;
};

export type FactSource = {
  restaurant: { name: string; cuisine: string; about: string } | null;
  branches: { id: number; slug: string; name: string; address: string; phone: string; timezone: string; isActive: boolean }[];
  weekly: { branchId: number; weekday: number; service: "lunch" | "dinner"; opens: string; closes: string }[];
  exceptions: { branchId: number; date: LocalDate; service: "lunch" | "dinner" | null; isClosed: boolean; opens: string | null; closes: string | null; note: string | null }[];
  menu: {
    slug: string;
    category: string;
    name: string;
    description: string;
    priceInr: number;
    dietary: string[];
    spiceLevel: number | null;
    branches: string[] | null;
    isAvailable: boolean;
  }[];
  faq: { slug: string; question: string; answer: string; branchId: number | null }[];
};

/** Everything facts are rendered from, read in seed order (row id). */
export function loadFactSource(db: DB): FactSource {
  const restaurant = db.prepare("SELECT name, cuisine, about FROM restaurant WHERE id = 1").get() as FactSource["restaurant"] | undefined;
  const branches = (db.prepare("SELECT id, slug, name, address, phone, timezone, is_active FROM branches ORDER BY id").all() as (Omit<FactSource["branches"][number], "isActive"> & { is_active: number })[]).map(
    ({ is_active, ...b }) => ({ ...b, isActive: is_active === 1 }),
  );
  const weekly = (db.prepare("SELECT branch_id, weekday, service, opens, closes FROM service_hours").all() as { branch_id: number; weekday: number; service: "lunch" | "dinner"; opens: string; closes: string }[]).map(
    (r) => ({ branchId: r.branch_id, weekday: r.weekday, service: r.service, opens: r.opens, closes: r.closes }),
  );
  const exceptions = (
    db.prepare("SELECT branch_id, date, service, is_closed, opens, closes, note FROM hours_exceptions ORDER BY id").all() as {
      branch_id: number;
      date: string;
      service: "lunch" | "dinner" | null;
      is_closed: number;
      opens: string | null;
      closes: string | null;
      note: string | null;
    }[]
  ).map((r) => ({ branchId: r.branch_id, date: r.date, service: r.service, isClosed: r.is_closed === 1, opens: r.opens, closes: r.closes, note: r.note }));
  const menu = (
    db.prepare("SELECT slug, category, name, description, price_inr, dietary, spice_level, branch_slugs, is_available FROM menu_items ORDER BY id").all() as {
      slug: string;
      category: string;
      name: string;
      description: string;
      price_inr: number;
      dietary: string;
      spice_level: number | null;
      branch_slugs: string | null;
      is_available: number;
    }[]
  ).map((r) => ({
    slug: r.slug,
    category: r.category,
    name: r.name,
    description: r.description,
    priceInr: r.price_inr,
    dietary: JSON.parse(r.dietary) as string[],
    spiceLevel: r.spice_level,
    branches: r.branch_slugs ? (JSON.parse(r.branch_slugs) as string[]) : null,
    isAvailable: r.is_available === 1,
  }));
  const faq = (db.prepare("SELECT slug, question, answer, branch_id FROM faq_entries ORDER BY id").all() as { slug: string; question: string; answer: string; branch_id: number | null }[]).map((r) => ({
    slug: r.slug,
    question: r.question,
    answer: r.answer,
    branchId: r.branch_id,
  }));
  return { restaurant: restaurant ?? null, branches, weekly, exceptions, menu, faq };
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // the probe lists Monday first
const SPICE = ["not spicy", "mild", "medium spicy", "hot"];
const CATEGORY: Record<string, string> = { "small-plates": "small plates", tandoor: "tandoor", mains: "mains", "breads-rice": "breads and rice", desserts: "desserts", drinks: "drinks" };
const categoryLabel = (c: string) => CATEGORY[c] ?? c.replace(/-/g, " ");

/** "Hauz Khas" from "Neem & Ember, Hauz Khas" (the part after the last comma, as the probe does). */
export const branchShortName = (name: string) => name.split(", ").pop()!;

function dietText(d: string[]): string {
  const base = d.includes("vegan") ? "Vegan" : d.includes("vegetarian") ? "Vegetarian" : "Non-vegetarian";
  const extra = [d.includes("gluten-free") && "gluten-free", d.includes("jain-available") && "Jain option available"].filter(Boolean);
  const contains = [d.includes("contains-dairy") && "dairy", d.includes("contains-nuts") && "nuts", d.includes("egg") && "egg"].filter(Boolean);
  return [base, ...extra].join(", ") + (contains.length ? `; contains ${contains.join(", ")}` : "") + ".";
}

type Window = { service: "lunch" | "dinner"; opens: string; closes: string };
function serviceText(windows: Window[]): string {
  const by = new Map(windows.map((w) => [w.service, w]));
  return (["lunch", "dinner"] as const)
    .map((s) => {
      const w = by.get(s);
      return w ? `${s} ${timeLabelOf(w.opens)}–${timeLabelOf(w.closes)}` : `closed for ${s}`;
    })
    .join("; ");
}

/**
 * Prompt-prefix facts: restaurant, branches, weekly hours and every exception in the 30-day horizon (§5.7).
 * Active branches only. Depends on `now` through the horizon, so it is stable for the day.
 */
export function renderStaticFacts(src: FactSource, now: number): Fact[] {
  const facts: Fact[] = [];
  const active = src.branches.filter((b) => b.isActive);
  if (src.restaurant) {
    const r = src.restaurant;
    const names = active.map((b) => branchShortName(b.name));
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "none");
    facts.push({ id: "restaurant:about", kind: "restaurant", text: `${r.name}. Cuisine: ${r.cuisine}. ${sentence(r.about)} Branches: ${list}.` });
  }
  for (const b of active) facts.push({ id: `branch:${b.slug}`, kind: "branch", text: `${b.name}. Address: ${b.address}. Phone: ${formatPhone(b.phone)}.` });

  const inHorizon = new Map<number, Map<LocalDate, FactSource["exceptions"]>>();
  for (const b of active) {
    const dates = new Set(horizonDates(now, b.timezone, RULES.horizonDays));
    const byDate = new Map<LocalDate, FactSource["exceptions"]>();
    for (const e of src.exceptions) if (e.branchId === b.id && dates.has(e.date)) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
    inHorizon.set(b.id, new Map([...byDate].sort(([a], [c]) => (a < c ? -1 : 1))));
  }

  for (const b of active) {
    for (const wd of WEEK_ORDER) {
      const windows = src.weekly.filter((h) => h.branchId === b.id && h.weekday === wd);
      // D-10: name this weekday's exceptions so the model sees them when it reads the weekly fact.
      const except = [...inHorizon.get(b.id)!.keys()].filter((d) => weekdayOf(d, b.timezone) === wd).map((d) => `${dayLabelLong(d, b.timezone)}: see exception:${b.slug}:${d}`);
      const text = `${branchShortName(b.name)} on ${DAY_NAMES[wd]}s: ${serviceText(windows)}.${except.length ? ` Except ${except.join("; ")}.` : ""}`;
      facts.push({ id: `hours:${b.slug}:${DAY_KEYS[wd]}`, kind: "hours", text });
    }
  }

  const rows: { b: (typeof active)[number]; date: LocalDate; ex: FactSource["exceptions"] }[] = [];
  for (const b of active) for (const [date, ex] of inHorizon.get(b.id)!) rows.push({ b, date, ex });
  rows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.b.id - y.b.id));
  const serviceOrder = (s: string | null) => (s === null ? 0 : s === "lunch" ? 1 : 2);
  for (const { b, date, ex } of rows) {
    const sorted = [...ex].sort((x, y) => serviceOrder(x.service) - serviceOrder(y.service));
    const notes = [...new Set(sorted.map((r) => r.note).filter(Boolean))].join("; ");
    const whole = sorted.some((r) => r.service === null);
    const body = whole ? "closed all day" : serviceText(sorted.filter((r) => !r.isClosed).map((r) => ({ service: r.service!, opens: r.opens!, closes: r.closes! })));
    facts.push({
      id: `exception:${b.slug}:${date}`,
      kind: "exception",
      text: `${branchShortName(b.name)} on ${dayLabelLong(date, b.timezone)} (special hours replacing the usual ones): ${body}${notes ? ` (${notes})` : ""}.`,
    });
  }
  return facts;
}

/** Ends with a full stop unless it already ends with sentence punctuation. */
function sentence(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// `about` feeds only the index text of the aggregate (never shown to the model).
const DIETS: { tag: string; label: string; about: string; has: (d: string[]) => boolean }[] = [
  { tag: "vegetarian", label: "Vegetarian, including vegan", about: "every vegetarian (veg, meat-free) option, including vegan ones", has: (d) => d.includes("vegetarian") || d.includes("vegan") },
  { tag: "vegan", label: "Vegan", about: "every vegan (plant-based) option", has: (d) => d.includes("vegan") },
  { tag: "gluten-free", label: "Gluten-free", about: "every gluten-free option", has: (d) => d.includes("gluten-free") },
  { tag: "jain-available", label: "Jain option available", about: "every item with a Jain option (made without onion, garlic or root vegetables)", has: (d) => d.includes("jain-available") },
  { tag: "contains-nuts", label: "Contains nuts", about: "every item that contains nuts", has: (d) => d.includes("contains-nuts") },
  { tag: "contains-dairy", label: "Contains dairy", about: "every item that contains dairy (milk, cream, paneer, yoghurt or ghee)", has: (d) => d.includes("contains-dairy") },
  { tag: "egg", label: "Contains egg", about: "every item that contains egg", has: (d) => d.includes("egg") },
];
const CATEGORY_ABOUT: Record<string, string> = {
  "small-plates": "every small plate (starters, appetisers and snacks)",
  tandoor: "everything from the tandoor (grills, kebabs and tikkas)",
  mains: "every main (main course curries)",
  "breads-rice": "every bread and rice (naan, roti, paratha, rice and biryani)",
  desserts: "every dessert (sweets)",
  drinks: "every drink (beverages)",
};
const indexTextFor = (label: string, about: string) => `${label}: ${about}, with prices, cheapest to most expensive.`;

/**
 * Retrievable facts (D-02, D-13): one per menu item and FAQ, plus aggregates so list and superlative questions
 * ("cheapest dessert", "everything vegan") retrieve one complete, citable fact. Time-independent.
 * Items and FAQs scoped only to inactive branches are left out.
 */
export function renderKbFacts(src: FactSource): Fact[] {
  const active = new Map(src.branches.filter((b) => b.isActive).map((b) => [b.slug, b]));
  const activeById = new Map(src.branches.filter((b) => b.isActive).map((b) => [b.id, b]));
  const facts: Fact[] = [];
  const menu = src.menu
    .map((m) => ({ ...m, scope: m.branches?.filter((s) => active.has(s)) ?? null }))
    .filter((m) => m.scope === null || m.scope.length > 0);
  const scopeText = (scope: string[] | null) => (scope ? `${scope.map((s) => branchShortName(active.get(s)!.name)).join(" and ")} only` : "");

  for (const m of menu) {
    const where = m.scope ? ` ${scopeText(m.scope)}.` : "";
    const avail = m.isAvailable ? "" : " Currently unavailable.";
    facts.push({
      id: `menu:${m.slug}`,
      kind: "menu",
      text: `${m.name} (${categoryLabel(m.category)}), ₹${m.priceInr}. ${m.description}. ${dietText(m.dietary)} Spice: ${SPICE[m.spiceLevel ?? 0]}.${where}${avail}`,
    });
  }
  for (const q of src.faq) {
    if (q.branchId !== null && !activeById.has(q.branchId)) continue;
    const scope = q.branchId === null ? "" : `(${branchShortName(activeById.get(q.branchId)!.name)}) `;
    facts.push({ id: `faq:${q.slug}`, kind: "faq", text: `${scope}Q: ${q.question} A: ${q.answer}` });
  }

  type Item = (typeof menu)[number];
  const cheapestFirst = (items: Item[]) => [...items].sort((a, b) => a.priceInr - b.priceInr || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Category lists name each item's diet (review of D2 LV-SMOKE-04: with prices but no diets, the model guessed that
  // a dessert was vegan); diet lists name each item's category.
  const diet = (m: Item) => dietText(m.dietary).replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
  const entry = (m: Item, withCategory: boolean) =>
    withCategory
      ? `${m.name} (${categoryLabel(m.category)}) ₹${m.priceInr}${m.scope ? ` (${scopeText(m.scope)})` : ""}`
      : `${m.name} ₹${m.priceInr} (${diet(m)}${m.scope ? `; ${scopeText(m.scope)}` : ""})`;
  const listText = (label: string, items: Item[], withCategory: boolean) => {
    const open = cheapestFirst(items.filter((m) => m.isAvailable));
    const off = items.filter((m) => !m.isAvailable).map((m) => m.name);
    const head = open.length ? `${label} (${open.length} available), cheapest first: ${open.map((m) => entry(m, withCategory)).join("; ")}.` : `${label}: none available right now.`;
    return `${head}${off.length ? ` Currently unavailable: ${off.join(", ")}.` : ""}`;
  };

  const categories = [...new Set(menu.map((m) => m.category))];
  for (const c of categories) {
    const label = categoryLabel(c);
    const heading = `${label[0].toUpperCase()}${label.slice(1)} on the menu`;
    facts.push({
      id: `menu-cat:${c}`,
      kind: "menu-cat",
      text: listText(heading, menu.filter((m) => m.category === c), false),
      indexText: indexTextFor(heading, CATEGORY_ABOUT[c] ?? `every ${label}`),
    });
  }
  for (const d of DIETS) {
    const items = menu.filter((m) => d.has(m.dietary));
    if (items.length) facts.push({ id: `menu-diet:${d.tag}`, kind: "menu-diet", text: listText(d.label, items, true), indexText: indexTextFor(d.label, d.about) });
  }
  return facts;
}

/** The text FTS5 and the embedder see for a fact. */
export const indexedText = (f: Fact) => f.indexText ?? f.text;

/** "menu:dal-ember | Dal Ember (mains), ₹495. …" — one line of the prompt's facts blocks. */
export const factLine = (f: Fact) => `${f.id} | ${f.text}`;
