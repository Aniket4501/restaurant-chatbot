import { z } from "zod";
import type { DB } from "@/lib/db/client";
import { DIETARY_TAGS, slug as slugSchema } from "@/lib/db/seed-schema";
import { COURSE_LABEL, menuEntries, view } from "@/lib/chat/menu";
import { COURSES, type Course, type MenuItemView } from "@/lib/chat/types";
import { branchShortName, loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { contentHash } from "@/lib/kb/index";
import { AdminError, adminWrite, fieldError, line, notFound, parse, recentChanges, slugify, type ChangeRow } from "@/lib/admin/common";

// Menu management (D-25) on the one menu table the chatbot reads (menu_items). Fields are the ones the data model has:
// name, description, price in rupees, category (which is also the course), dietary and allergen labels, spice level,
// branch scope and availability. There is no ingredient list or popularity data, and none is invented.
// States: "available"; "unavailable" (is_available = 0: still listed, the chatbot says so and never suggests it);
// "removed" (is_listed = 0: discontinued, invisible to guests and the chatbot). Slugs never change once created,
// because the chatbot's fact IDs (menu:<slug>) and stored vectors are keyed by them.

export type MenuStatus = "available" | "unavailable" | "removed";
export const MENU_STATUSES: readonly MenuStatus[] = ["available", "unavailable", "removed"];

export type AdminMenuItem = {
  slug: string;
  name: string;
  category: Course;
  categoryLabel: string;
  description: string;
  priceInr: number;
  dietary: string[];
  spiceLevel: number | null;
  branches: string[] | null;
  /** "Golf Course Road only", or null when every branch serves it. */
  scopeLabel: string | null;
  status: MenuStatus;
  /** D-26: the restaurant's own bestseller mark, the only popularity evidence the chatbot may cite. */
  bestseller: boolean;
  createdBy: "seed" | "staff";
  updatedAt: number | null;
  order: number;
};

type Row = { id: number; slug: string; category: string; name: string; description: string; price_inr: number; dietary: string; spice_level: number | null; branch_slugs: string | null; is_available: number; is_listed: number; is_bestseller: number; created_by: "seed" | "staff"; updated_at: number | null };

function toItem(r: Row, branchNames: Map<string, string>): AdminMenuItem {
  const branches = r.branch_slugs ? (JSON.parse(r.branch_slugs) as string[]) : null;
  const category = (COURSES as readonly string[]).includes(r.category) ? (r.category as Course) : ("mains" as Course);
  return {
    slug: r.slug,
    name: r.name,
    category,
    categoryLabel: COURSE_LABEL[category],
    description: r.description,
    priceInr: r.price_inr,
    dietary: JSON.parse(r.dietary) as string[],
    spiceLevel: r.spice_level,
    branches,
    scopeLabel: branches ? `${branches.map((s) => branchShortName(branchNames.get(s) ?? s)).join(" and ")} only` : null,
    status: r.is_listed === 0 ? "removed" : r.is_available === 1 ? "available" : "unavailable",
    bestseller: r.is_bestseller === 1,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    order: r.id,
  };
}

const branchNames = (db: DB) => new Map((db.prepare("SELECT slug, name FROM branches").all() as { slug: string; name: string }[]).map((b) => [b.slug, b.name]));

export function listMenu(db: DB): { items: AdminMenuItem[]; counts: Record<MenuStatus | "listed" | "total", number>; byCategory: { category: Course; label: string; listed: number; available: number }[] } {
  const names = branchNames(db);
  const items = (db.prepare("SELECT * FROM menu_items ORDER BY id").all() as Row[]).map((r) => toItem(r, names));
  const counts = { total: items.length, listed: 0, available: 0, unavailable: 0, removed: 0 };
  for (const i of items) {
    counts[i.status]++;
    if (i.status !== "removed") counts.listed++;
  }
  const byCategory = COURSES.map((c) => ({
    category: c,
    label: COURSE_LABEL[c],
    listed: items.filter((i) => i.category === c && i.status !== "removed").length,
    available: items.filter((i) => i.category === c && i.status === "available").length,
  }));
  return { items, counts, byCategory };
}

function rowBySlug(db: DB, slug: string): Row | undefined {
  return db.prepare("SELECT * FROM menu_items WHERE slug = ?").get(slug) as Row | undefined;
}

export type MenuItemDetail = {
  item: AdminMenuItem;
  /** The chatbot's fact for this dish, exactly as the model reads it; null when removed. */
  fact: { id: string; text: string } | null;
  /** The dish card a guest sees in the chat; null when removed or unavailable (the chat never shows it then). */
  guestCard: MenuItemView | null;
  /** List facts (a section or a dietary list) that name this dish. */
  listedIn: string[];
  index: { keyword: "current" | "stale" | "missing" | "not_indexed"; vector: "current" | "stale" | "missing" | "not_indexed" };
  changes: ChangeRow[];
};

export function menuItemDetail(db: DB, slug: string): MenuItemDetail {
  const r = rowBySlug(db, slug);
  if (!r) throw notFound("Menu item");
  const item = toItem(r, branchNames(db));
  const src = loadFactSource(db);
  const facts = renderKbFacts(src);
  const fact = facts.find((f) => f.id === `menu:${slug}`) ?? null;
  const entry = menuEntries(src).find((e) => e.id === `menu:${slug}`);
  const named = new RegExp(`(?:^|[:;,] )${r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[ ,.])`);
  const listedIn = facts.filter((f) => (f.kind === "menu-cat" || f.kind === "menu-diet") && named.test(f.text)).map((f) => f.id);
  let keyword: MenuItemDetail["index"]["keyword"] = "not_indexed";
  let vector: MenuItemDetail["index"]["vector"] = "not_indexed";
  if (fact) {
    const fts = db.prepare("SELECT body FROM kb_fts WHERE fact_id = ?").get(fact.id) as { body: string } | undefined;
    keyword = !fts ? "missing" : fts.body === (fact.indexText ?? fact.text).normalize("NFKC") ? "current" : "stale";
    const rows = db.prepare("SELECT content_hash FROM fact_embeddings WHERE fact_id = ?").all(fact.id) as { content_hash: string }[];
    vector = rows.length === 0 ? "missing" : rows.some((x) => x.content_hash === contentHash(fact)) ? "current" : "stale";
  }
  return {
    item,
    fact: fact ? { id: fact.id, text: fact.text } : null,
    guestCard: entry && entry.available ? view(entry) : null,
    listedIn,
    index: { keyword, vector },
    changes: recentChanges(db, { area: "menu", target: slug, limit: 10 }),
  };
}

const Dietary = z
  .array(z.enum(DIETARY_TAGS, { error: "Unknown dietary label" }))
  .max(DIETARY_TAGS.length)
  .transform((d) => [...new Set(d)])
  .refine((d) => !(d.includes("vegan") && d.includes("vegetarian")), "Choose vegan or vegetarian, not both")
  .refine((d) => !(d.includes("vegan") && (d.includes("contains-dairy") || d.includes("egg"))), "A vegan dish can't contain dairy or egg");

const Fields = {
  name: line("a name", 2, 80),
  description: line("a description", 5, 300),
  category: z.enum(COURSES, { error: "Choose a category" }),
  priceInr: z.number({ error: "Enter a price in rupees" }).int("Use whole rupees").min(1, "The price must be at least ₹1").max(100_000, "The price can be at most ₹1,00,000"),
  dietary: Dietary,
  spiceLevel: z.number().int().min(0, "Spice level is 0 to 3").max(3, "Spice level is 0 to 3").nullable(),
  branches: z.array(slugSchema).min(1, "Choose at least one branch, or all branches").max(20).nullable(),
  bestseller: z.boolean(),
};

export const MenuCreateSchema = z.strictObject({ ...Fields, bestseller: Fields.bestseller.default(false), slug: slugSchema.max(60).optional(), status: z.enum(["available", "unavailable"]).default("available") });
export const MenuPatchSchema = z.strictObject({
  name: Fields.name.optional(),
  description: Fields.description.optional(),
  category: Fields.category.optional(),
  priceInr: Fields.priceInr.optional(),
  dietary: Fields.dietary.optional(),
  spiceLevel: Fields.spiceLevel.optional(),
  branches: Fields.branches.optional(),
  bestseller: Fields.bestseller.optional(),
  status: z.enum(MENU_STATUSES).optional(),
});

function checkBranches(db: DB, branches: string[] | null | undefined): string[] | null | undefined {
  if (!branches) return branches;
  const active = new Set((db.prepare("SELECT slug FROM branches WHERE is_active = 1").all() as { slug: string }[]).map((b) => b.slug));
  const unknown = branches.find((b) => !active.has(b));
  if (unknown) throw fieldError("branches", `Unknown or inactive branch: ${unknown}`);
  const unique = [...new Set(branches)];
  // Every active branch is the same as "all branches": store null so a new branch would serve it too.
  return unique.length === active.size ? null : unique;
}

const SPICE_WORDS = ["not spicy", "mild", "medium", "hot"];
const describeChange = (before: AdminMenuItem, after: AdminMenuItem): string => {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`name "${before.name}" → "${after.name}"`);
  if (before.priceInr !== after.priceInr) parts.push(`price ₹${before.priceInr} → ₹${after.priceInr}`);
  if (before.category !== after.category) parts.push(`category ${before.categoryLabel} → ${after.categoryLabel}`);
  if (before.description !== after.description) parts.push("description");
  if (JSON.stringify(before.dietary) !== JSON.stringify(after.dietary)) parts.push("labels");
  if (before.spiceLevel !== after.spiceLevel) parts.push(`spice ${before.spiceLevel === null ? "not listed" : SPICE_WORDS[before.spiceLevel]} → ${after.spiceLevel === null ? "not listed" : SPICE_WORDS[after.spiceLevel]}`);
  if (JSON.stringify(before.branches) !== JSON.stringify(after.branches)) parts.push(`branches ${before.scopeLabel ?? "all"} → ${after.scopeLabel ?? "all"}`);
  if (before.status !== after.status) parts.push(`${before.status} → ${after.status}`);
  if (before.bestseller !== after.bestseller) parts.push(after.bestseller ? "marked as a bestseller" : "bestseller mark removed");
  return parts.join("; ") || "no change";
};

const sameName = (db: DB, name: string, category: string, except: string | null) =>
  db.prepare("SELECT slug FROM menu_items WHERE lower(name) = lower(?) AND category = ? AND is_listed = 1 AND (? IS NULL OR slug <> ?)").get(name, category, except, except) as { slug: string } | undefined;

/** Create a dish (D-25). A second submit of the same dish is refused (same name in the same section), never duplicated. */
export function createMenuItem(db: DB, now: number, raw: unknown): AdminMenuItem {
  const input = parse(MenuCreateSchema, raw);
  const branches = checkBranches(db, input.branches) ?? null;
  return adminWrite(db, now, { reindex: true }, () => {
    const dup = sameName(db, input.name, input.category, null);
    if (dup) throw new AdminError(409, "CONFLICT", `"${input.name}" is already on the menu in ${COURSE_LABEL[input.category]}.`, { existing: dup.slug });
    let slug = input.slug ?? slugify(input.name);
    if (rowBySlug(db, slug)) {
      if (input.slug) throw fieldError("slug", "That ID is already used by another dish");
      let n = 2;
      while (rowBySlug(db, `${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    db.prepare(
      `INSERT INTO menu_items (slug, category, name, description, price_inr, dietary, spice_level, branch_slugs, is_available, is_listed, is_bestseller, created_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'staff', ?)`,
    ).run(slug, input.category, input.name, input.description, input.priceInr, JSON.stringify(input.dietary), input.spiceLevel, branches ? JSON.stringify(branches) : null, input.status === "available" ? 1 : 0, input.bestseller ? 1 : 0, now);
    const item = toItem(rowBySlug(db, slug)!, branchNames(db));
    return { result: item, change: { area: "menu", action: "created", target: slug, summary: `Added "${item.name}" (${item.categoryLabel}, ₹${item.priceInr})` } };
  });
}

/** Edit a dish, or change its status (D-25). Returns the item and whether anything changed. */
export function updateMenuItem(db: DB, now: number, slug: string, raw: unknown): { item: AdminMenuItem; changed: boolean; summary: string } {
  const patch = parse(MenuPatchSchema, raw);
  const branches = patch.branches === undefined ? undefined : checkBranches(db, patch.branches);
  return adminWrite<{ item: AdminMenuItem; changed: boolean; summary: string }>(db, now, { reindex: true }, () => {
    const row = rowBySlug(db, slug);
    if (!row) throw notFound("Menu item");
    const names = branchNames(db);
    const before = toItem(row, names);
    const next = {
      name: patch.name ?? before.name,
      category: patch.category ?? before.category,
      description: patch.description ?? before.description,
      priceInr: patch.priceInr ?? before.priceInr,
      dietary: patch.dietary ?? before.dietary,
      spiceLevel: patch.spiceLevel === undefined ? before.spiceLevel : patch.spiceLevel,
      branches: branches === undefined ? before.branches : branches,
      status: patch.status ?? before.status,
      bestseller: patch.bestseller ?? before.bestseller,
    };
    const d = next.dietary;
    if (d.includes("vegan") && (d.includes("contains-dairy") || d.includes("egg"))) throw fieldError("dietary", "A vegan dish can't contain dairy or egg");
    if (next.status !== "removed" && (patch.name !== undefined || patch.category !== undefined || before.status === "removed")) {
      const dup = sameName(db, next.name, next.category, slug);
      if (dup) throw new AdminError(409, "CONFLICT", `"${next.name}" is already on the menu in ${COURSE_LABEL[next.category]}.`, { existing: dup.slug });
    }
    const after: AdminMenuItem = { ...before, ...next, categoryLabel: COURSE_LABEL[next.category], scopeLabel: next.branches ? `${next.branches.map((s) => branchShortName(names.get(s) ?? s)).join(" and ")} only` : null };
    const summary = describeChange(before, after);
    if (summary === "no change") return { result: { item: before, changed: false, summary }, change: null };
    db.prepare(
      `UPDATE menu_items SET name = ?, category = ?, description = ?, price_inr = ?, dietary = ?, spice_level = ?, branch_slugs = ?, is_available = ?, is_listed = ?, is_bestseller = ?, updated_at = ? WHERE slug = ?`,
    ).run(next.name, next.category, next.description, next.priceInr, JSON.stringify(next.dietary), next.spiceLevel, next.branches ? JSON.stringify(next.branches) : null, next.status === "available" ? 1 : 0, next.status === "removed" ? 0 : 1, next.bestseller ? 1 : 0, now, slug);
    const item = toItem(rowBySlug(db, slug)!, names);
    const action = before.status !== after.status && summary === `${before.status} → ${after.status}` ? `marked ${after.status}` : "edited";
    return { result: { item, changed: true, summary }, change: { area: "menu", action, target: slug, summary: `"${item.name}": ${summary}` } };
  });
}
