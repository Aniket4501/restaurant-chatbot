import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "@/lib/db/client";
import { immediate } from "@/lib/db/tx";
import { exceptionProblems, SeedSchema, type SeedData } from "@/lib/db/seed-schema";
import { windowsFor, type HoursException, type Service, type WeeklyHours } from "@/lib/booking/hours";
import { addLocalDays, DAY_KEYS, instantAtMinutes, localDateOf, todayLocal, weekdayOf, type LocalDate } from "@/lib/time/tz";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { rebuildLexical } from "@/lib/kb/index";

export const SEED_DIR = path.join(process.cwd(), "data", "seed");
const SEED_FILES = ["restaurant", "branches", "hours", "exceptions", "tables", "menu", "faq"] as const;

/** Read data/seed/<key>.json files into one seed object (same shape as evals/fixtures/base.json). */
export function readSeedDir(dir = SEED_DIR): unknown {
  return Object.fromEntries(SEED_FILES.map((k) => [k, JSON.parse(fs.readFileSync(path.join(dir, `${k}.json`), "utf8"))]));
}

export function parseSeed(raw: unknown): SeedData {
  return SeedSchema.parse(raw);
}

export type SeedConflict = { ref: string; branch: string; startsAt: number; reason: "table_inactive" | "table_size" | "outside_hours" };

export class SeedConflictError extends Error {
  constructor(readonly conflicts: SeedConflict[]) {
    super(`reseed would invalidate ${conflicts.length} confirmed future booking(s); re-run with --accept-conflicts to apply anyway`);
    this.name = "SeedConflictError";
  }
}

export class SeedValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`seed rejected after resolving relative dates: ${problems.join("; ")}`);
    this.name = "SeedValidationError";
  }
}

export type SeedReport = { anchorDate: LocalDate; counts: Record<string, number>; deactivated: { branches: string[]; tables: string[] }; conflicts: SeedConflict[] };

/**
 * Load a validated seed (D-14): an upsert keyed on natural keys in one IMMEDIATE transaction.
 * - Branches and tables a reservation may reference are deactivated, never deleted.
 * - Hours, exceptions, menu and FAQ rows are replaced (nothing references them).
 * - Relative dates ("+Nd") resolve against app_meta.seed_anchor_date, written on the first seed and reused.
 * - Confirmed future bookings that the new data would invalidate abort the load unless acceptConflicts.
 * - kb_fts is rebuilt from the new menu and FAQ rows in the same transaction.
 */
export function applySeed(db: DB, seed: SeedData, opts: { now: number; acceptConflicts?: boolean }): SeedReport {
  const zone = seed.branches[0].timezone;
  return immediate(db, () => {
    const anchorRow = db.prepare("SELECT value FROM app_meta WHERE key = 'seed_anchor_date'").get() as { value: string } | undefined;
    const anchorDate = anchorRow?.value ?? todayLocal(opts.now, zone);
    if (!anchorRow) db.prepare("INSERT INTO app_meta (key, value) VALUES ('seed_anchor_date', ?)").run(anchorDate);
    const resolve = (d: string): LocalDate => (d.startsWith("+") ? addLocalDays(anchorDate, Number(d.slice(1, -1)), zone) : d);
    // Re-check the D-08 exception rules on the resolved dates: "+4d" and "2026-10-20" may be the same day (review DB-1).
    const problems = exceptionProblems(seed.exceptions.map((e) => ({ ...e, key: `${e.branch}|${resolve(e.date)}` })));
    if (problems.length) throw new SeedValidationError(problems);

    db.prepare("INSERT INTO restaurant (id, name, cuisine, about) VALUES (1, @name, @cuisine, @about) ON CONFLICT(id) DO UPDATE SET name = excluded.name, cuisine = excluded.cuisine, about = excluded.about").run(seed.restaurant);

    const upsertBranch = db.prepare(`INSERT INTO branches (slug, name, address, phone, timezone, is_active) VALUES (@slug, @name, @address, @phone, @timezone, @active)
      ON CONFLICT(slug) DO UPDATE SET name = excluded.name, address = excluded.address, phone = excluded.phone, timezone = excluded.timezone, is_active = excluded.is_active`);
    for (const b of seed.branches) upsertBranch.run({ ...b, active: b.isActive ? 1 : 0 });
    const seedSlugs = seed.branches.map((b) => b.slug);
    const goneBranches = (db.prepare(`SELECT slug FROM branches WHERE is_active = 1 AND slug NOT IN (${seedSlugs.map(() => "?").join(",")})`).all(...seedSlugs) as { slug: string }[]).map((r) => r.slug);
    for (const s of goneBranches) db.prepare("UPDATE branches SET is_active = 0 WHERE slug = ?").run(s);
    const branchId = new Map((db.prepare("SELECT id, slug FROM branches").all() as { id: number; slug: string }[]).map((r) => [r.slug, r.id]));

    db.prepare("DELETE FROM service_hours").run();
    const insHours = db.prepare("INSERT INTO service_hours (branch_id, weekday, service, opens, closes) VALUES (?, ?, ?, ?, ?)");
    for (const h of seed.hours) for (const d of h.days) insHours.run(branchId.get(h.branch), DAY_KEYS.indexOf(d), h.service, h.opens, h.closes);

    db.prepare("DELETE FROM hours_exceptions").run();
    const insEx = db.prepare("INSERT INTO hours_exceptions (branch_id, date, service, is_closed, opens, closes, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const e of seed.exceptions) insEx.run(branchId.get(e.branch), resolve(e.date), e.service, e.isClosed ? 1 : 0, e.opens, e.closes, e.note);

    const upsertTable = db.prepare(`INSERT INTO dining_tables (branch_id, label, min_seats, max_seats, is_active) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(branch_id, label) DO UPDATE SET min_seats = excluded.min_seats, max_seats = excluded.max_seats, is_active = excluded.is_active`);
    for (const t of seed.tables) upsertTable.run(branchId.get(t.branch), t.label, t.minSeats, t.maxSeats, t.isActive ? 1 : 0);
    const keep = new Set(seed.tables.map((t) => `${branchId.get(t.branch)}/${t.label}`));
    const goneTables: string[] = [];
    for (const t of db.prepare("SELECT d.id, d.branch_id, d.label, b.slug FROM dining_tables d JOIN branches b ON b.id = d.branch_id WHERE d.is_active = 1").all() as { id: number; branch_id: number; label: string; slug: string }[]) {
      if (!keep.has(`${t.branch_id}/${t.label}`)) {
        db.prepare("UPDATE dining_tables SET is_active = 0 WHERE id = ?").run(t.id);
        goneTables.push(`${t.slug}/${t.label}`);
      }
    }

    const upsertMenu = db.prepare(`INSERT INTO menu_items (slug, category, name, description, price_inr, dietary, spice_level, branch_slugs, is_available)
      VALUES (@slug, @category, @name, @description, @priceInr, @dietary, @spiceLevel, @branches, @available)
      ON CONFLICT(slug) DO UPDATE SET category = excluded.category, name = excluded.name, description = excluded.description, price_inr = excluded.price_inr,
        dietary = excluded.dietary, spice_level = excluded.spice_level, branch_slugs = excluded.branch_slugs, is_available = excluded.is_available`);
    for (const m of seed.menu) upsertMenu.run({ ...m, dietary: JSON.stringify(m.dietary), branches: m.branches ? JSON.stringify(m.branches) : null, available: m.isAvailable ? 1 : 0 });
    const menuSlugs = seed.menu.map((m) => m.slug);
    db.prepare(`DELETE FROM menu_items WHERE slug NOT IN (${menuSlugs.map(() => "?").join(",") || "''"})`).run(...menuSlugs);

    const upsertFaq = db.prepare(`INSERT INTO faq_entries (slug, question, answer, branch_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET question = excluded.question, answer = excluded.answer, branch_id = excluded.branch_id`);
    for (const f of seed.faq) upsertFaq.run(f.slug, f.question, f.answer, f.branch ? branchId.get(f.branch) : null);
    const faqSlugs = seed.faq.map((f) => f.slug);
    db.prepare(`DELETE FROM faq_entries WHERE slug NOT IN (${faqSlugs.map(() => "?").join(",") || "''"})`).run(...faqSlugs);

    // The lexical index always matches the seeded menu and FAQ (D-13); kb:index adds the embeddings.
    rebuildLexical(db, renderKbFacts(loadFactSource(db)));

    db.prepare("INSERT INTO app_meta (key, value) VALUES ('seed_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      createHash("sha256").update(JSON.stringify(seed)).digest("hex").slice(0, 16),
    );

    const conflicts = findConflicts(db, opts.now);
    if (conflicts.length && !opts.acceptConflicts) throw new SeedConflictError(conflicts);

    const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return {
      anchorDate,
      counts: Object.fromEntries(["branches", "service_hours", "hours_exceptions", "dining_tables", "menu_items", "faq_entries"].map((t) => [t, count(t)])),
      deactivated: { branches: goneBranches, tables: goneTables },
      conflicts,
    };
  });
}

/** Confirmed bookings from `now` on that the current tables, hours and exceptions no longer support. */
export function findConflicts(db: DB, now: number): SeedConflict[] {
  const rows = db
    .prepare(`SELECT r.ref, r.branch_id, r.party_size, r.starts_at, r.ends_at, b.slug, b.timezone, b.is_active AS branch_active,
        t.is_active AS table_active, t.min_seats, t.max_seats
      FROM reservations r JOIN branches b ON b.id = r.branch_id JOIN dining_tables t ON t.id = r.table_id
      WHERE r.status = 'confirmed' AND r.ends_at > ?`)
    .all(now) as {
    ref: string; branch_id: number; party_size: number; starts_at: number; ends_at: number; slug: string; timezone: string;
    branch_active: number; table_active: number; min_seats: number; max_seats: number;
  }[];
  const weeklyStmt = db.prepare("SELECT weekday, service, opens, closes FROM service_hours WHERE branch_id = ?");
  const exStmt = db.prepare("SELECT date, service, is_closed, opens, closes, note FROM hours_exceptions WHERE branch_id = ? AND date = ?");
  const out: SeedConflict[] = [];
  for (const r of rows) {
    const base = { ref: r.ref, branch: r.slug, startsAt: r.starts_at };
    if (!r.table_active || !r.branch_active) {
      out.push({ ...base, reason: "table_inactive" });
      continue;
    }
    if (r.party_size < r.min_seats || r.party_size > r.max_seats) {
      out.push({ ...base, reason: "table_size" });
      continue;
    }
    const date = localDateOf(r.starts_at, r.timezone);
    const weekly = weeklyStmt.all(r.branch_id) as WeeklyHours[];
    const ex = (exStmt.all(r.branch_id, date) as { date: string; service: Service | null; is_closed: number; opens: string | null; closes: string | null; note: string | null }[]).map(
      (e): HoursException => ({ date: e.date, service: e.service, isClosed: e.is_closed === 1, opens: e.opens, closes: e.closes, note: e.note }),
    );
    const midnight = instantAtMinutes(date, 0, r.timezone);
    const startMin = (r.starts_at - midnight) / 60_000;
    const endMin = (r.ends_at - midnight) / 60_000;
    const fits = windowsFor(date, weekdayOf(date, r.timezone), weekly, ex).some((w) => startMin >= w.opensMin && endMin <= w.closesMin);
    if (!fits) out.push({ ...base, reason: "outside_hours" });
  }
  return out;
}

