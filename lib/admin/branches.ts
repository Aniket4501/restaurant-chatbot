import { z } from "zod";
import type { DB } from "@/lib/db/client";
import { findConflicts, newConflicts } from "@/lib/booking/conflicts";
import { branchShortName } from "@/lib/kb/facts";
import { formatPhone, normalizeIndianPhone } from "@/lib/phone";
import { dayLabelLong, localDateOf, timeLabel, timeLabelOf, todayLocal } from "@/lib/time/tz";
import { AdminError, adminWrite, line, notFound, parse } from "@/lib/admin/common";
import { specialDates, weeklyHours } from "@/lib/admin/availability";

// Branches and restaurant-wide details (D-25). Branch rows feed the chatbot's branch facts, the hours facts' names,
// the "X only" scope of dishes and the "(X)" prefix of branch FAQs, so edits rebuild the keyword index. Slugs and
// time zones are fixed: fact IDs, bookings and all time arithmetic depend on them. Nothing here is invented: every
// field shown is a stored value.

export type BranchSummary = {
  slug: string;
  name: string;
  shortName: string;
  address: string;
  phone: string;
  phoneLabel: string;
  timezone: string;
  isActive: boolean;
  counts: { tables: number; seats: number; menuOnlyHere: number; faqs: number; documents: number; upcomingBookings: number };
  hours: { label: string; lunch: string; dinner: string }[];
  specialDates: { date: string; label: string; summary: string }[];
};

export type RestaurantInfo = { name: string; cuisine: string; about: string };

export function restaurantInfo(db: DB): RestaurantInfo {
  return (db.prepare("SELECT name, cuisine, about FROM restaurant WHERE id = 1").get() as RestaurantInfo | undefined) ?? { name: "", cuisine: "", about: "" };
}

export function listBranches(db: DB, now: number): { restaurant: RestaurantInfo; branches: BranchSummary[]; menuEverywhere: number; globalFaqs: number; globalDocuments: number } {
  const rows = db.prepare("SELECT id, slug, name, address, phone, timezone, is_active FROM branches ORDER BY id").all() as { id: number; slug: string; name: string; address: string; phone: string; timezone: string; is_active: number }[];
  const menu = db.prepare("SELECT branch_slugs FROM menu_items WHERE is_listed = 1").all() as { branch_slugs: string | null }[];
  const fmt = (w: { opens: string; closes: string } | null) => (w ? `${timeLabelOf(w.opens)} to ${timeLabelOf(w.closes)}` : "Closed");
  const branches = rows.map((b) => {
    const tables = db.prepare("SELECT count(*) AS n, coalesce(sum(max_seats), 0) AS seats FROM dining_tables WHERE branch_id = ? AND is_active = 1").get(b.id) as { n: number; seats: number };
    return {
      slug: b.slug,
      name: b.name,
      shortName: branchShortName(b.name),
      address: b.address,
      phone: b.phone,
      phoneLabel: formatPhone(b.phone),
      timezone: b.timezone,
      isActive: b.is_active === 1,
      counts: {
        tables: tables.n,
        seats: tables.seats,
        menuOnlyHere: menu.filter((m) => m.branch_slugs && (JSON.parse(m.branch_slugs) as string[]).includes(b.slug)).length,
        faqs: (db.prepare("SELECT count(*) AS n FROM faq_entries WHERE branch_id = ? AND is_active = 1").get(b.id) as { n: number }).n,
        documents: (db.prepare("SELECT count(*) AS n FROM kb_documents WHERE branch_id = ? AND is_active = 1").get(b.id) as { n: number }).n,
        upcomingBookings: (db.prepare("SELECT count(*) AS n FROM reservations WHERE branch_id = ? AND status = 'confirmed' AND starts_at >= ?").get(b.id, now) as { n: number }).n,
      },
      hours: weeklyHours(db, b.slug).map((d) => ({ label: d.label, lunch: fmt(d.lunch), dinner: fmt(d.dinner) })),
      specialDates: specialDates(db, now, b.slug)
        .slice(0, 5)
        .map((s) => ({ date: s.date, label: s.label, summary: s.closedAllDay ? "Closed all day" : `Lunch ${fmt(s.lunch).toLowerCase()}, dinner ${fmt(s.dinner).toLowerCase()}${s.note ? ` (${s.note})` : ""}` })),
    };
  });
  return {
    restaurant: restaurantInfo(db),
    branches,
    menuEverywhere: menu.filter((m) => !m.branch_slugs).length,
    globalFaqs: (db.prepare("SELECT count(*) AS n FROM faq_entries WHERE branch_id IS NULL AND is_active = 1").get() as { n: number }).n,
    globalDocuments: (db.prepare("SELECT count(*) AS n FROM kb_documents WHERE branch_id IS NULL AND is_active = 1").get() as { n: number }).n,
  };
}

const Phone = z
  .string({ error: "Enter a phone number" })
  .transform((s, ctx) => {
    const e164 = normalizeIndianPhone(s.trim());
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "Enter a valid Indian phone number, for example +91 11 4155 0101" });
      return z.NEVER;
    }
    return e164;
  });

export const BranchPatchSchema = z.strictObject({
  name: line("a branch name", 3, 80).optional(),
  address: line("an address", 5, 200).optional(),
  phone: Phone.optional(),
  isActive: z.boolean().optional(),
  confirm: z.boolean().optional(),
});

export function updateBranch(db: DB, now: number, slug: string, raw: unknown): { changed: boolean; summary: string; accepted: { ref: string; dateLabel: string; timeLabel: string }[] } {
  const patch = parse(BranchPatchSchema, raw);
  return adminWrite<{ changed: boolean; summary: string; accepted: { ref: string; dateLabel: string; timeLabel: string }[] }>(db, now, { reindex: true }, () => {
    const b = db.prepare("SELECT id, slug, name, address, phone, timezone, is_active FROM branches WHERE slug = ?").get(slug) as { id: number; name: string; address: string; phone: string; timezone: string; is_active: number } | undefined;
    if (!b) throw notFound("Branch");
    if (patch.name && patch.name !== b.name && db.prepare("SELECT 1 FROM branches WHERE lower(name) = lower(?) AND id <> ?").get(patch.name, b.id)) throw new AdminError(409, "CONFLICT", "Another branch already has that name.");
    const active = patch.isActive ?? b.is_active === 1;
    if (!active && b.is_active === 1 && (db.prepare("SELECT count(*) AS n FROM branches WHERE is_active = 1").get() as { n: number }).n <= 1) throw new AdminError(409, "CONFLICT", "At least one branch must stay active: the chatbot needs a branch to take bookings for.");
    const parts: string[] = [];
    if (patch.name && patch.name !== b.name) parts.push(`name "${b.name}" → "${patch.name}"`);
    if (patch.address && patch.address !== b.address) parts.push("address");
    if (patch.phone && patch.phone !== b.phone) parts.push(`phone ${formatPhone(b.phone)} → ${formatPhone(patch.phone)}`);
    if (active !== (b.is_active === 1)) parts.push(active ? "activated" : "deactivated");
    if (!parts.length) return { result: { changed: false, summary: "no change", accepted: [] }, change: null };
    const before = findConflicts(db, now);
    db.prepare("UPDATE branches SET name = ?, address = ?, phone = ?, is_active = ? WHERE id = ?").run(patch.name ?? b.name, patch.address ?? b.address, patch.phone ?? b.phone, active ? 1 : 0, b.id);
    const added = newConflicts(before, findConflicts(db, now));
    const accepted = added.map((c) => ({ ref: c.ref, dateLabel: dayLabelLong(localDateOf(c.startsAt, b.timezone), b.timezone), timeLabel: timeLabel(c.startsAt, b.timezone) }));
    if (added.length && !patch.confirm) throw new AdminError(409, "CONFLICT", `${added.length} confirmed ${added.length === 1 ? "booking is" : "bookings are"} at this branch from ${todayLocal(now, b.timezone)} on. Nothing was saved. Confirm to deactivate anyway (the bookings stay booked; contact the guests).`, { conflicts: accepted });
    const summary = parts.join("; ");
    return { result: { changed: true, summary, accepted }, change: { area: "branches", action: parts.length === 1 && /activated$/.test(parts[0]) ? parts[0] : "edited", target: slug, summary: `${branchShortName(patch.name ?? b.name)}: ${summary}` } };
  });
}

export const RestaurantSchema = z.strictObject({
  name: line("the restaurant name", 2, 60).optional(),
  cuisine: line("the cuisine", 3, 120).optional(),
  about: line("a description", 10, 400).optional(),
});

export function updateRestaurant(db: DB, now: number, raw: unknown): { changed: boolean; summary: string } {
  const patch = parse(RestaurantSchema, raw);
  return adminWrite<{ changed: boolean; summary: string }>(db, now, { reindex: true }, () => {
    const r = restaurantInfo(db);
    const next = { name: patch.name ?? r.name, cuisine: patch.cuisine ?? r.cuisine, about: patch.about ?? r.about };
    const parts = (["name", "cuisine", "about"] as const).filter((k) => next[k] !== r[k]);
    if (!parts.length) return { result: { changed: false, summary: "no change" }, change: null };
    db.prepare("UPDATE restaurant SET name = ?, cuisine = ?, about = ? WHERE id = 1").run(next.name, next.cuisine, next.about);
    const summary = parts.map((p) => (p === "about" ? "description" : p)).join(", ");
    return { result: { changed: true, summary }, change: { area: "restaurant", action: "edited", target: "restaurant", summary: `Restaurant details: ${summary}` } };
  });
}
