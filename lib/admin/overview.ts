import { RULES } from "@/lib/config";
import type { DB } from "@/lib/db/client";
import { findConflicts } from "@/lib/booking/conflicts";
import { branchShortName } from "@/lib/kb/facts";
import { addLocalDays, dayLabelLong, localDateOf, timeLabel, toInstant, todayLocal } from "@/lib/time/tz";
import { recentChanges, type ChangeRow } from "@/lib/admin/common";
import { listFaqs } from "@/lib/admin/faq";
import { knowledgeOverview } from "@/lib/admin/knowledge";
import { listMenu } from "@/lib/admin/menu";

// The staff landing page (D-25): today's bookings, what's next, and the health of the data the chatbot answers from.
// Every number is a count of stored rows or a check run now; warnings are raised only by a real condition.

export type Warning = { tone: "bad" | "warn"; title: string; detail: string; href: string };

export type Overview = {
  today: string;
  todayLabel: string;
  bookings: {
    today: { confirmed: number; covers: number; cancelled: number; byBranch: { slug: string; name: string; confirmed: number; covers: number }[] };
    next: { ref: string; timeLabel: string; partySize: number; branch: string; guestName: string }[];
    nextDays: { date: string; label: string; confirmed: number; covers: number }[];
  };
  menu: { listed: number; available: number; unavailable: number; removed: number; lastChange: ChangeRow | null };
  faqs: { active: number; inactive: number; conflicts: number; lastChange: ChangeRow | null };
  knowledge: { documents: number; searchable: number; keywordOnly: number; failed: number; mode: "hybrid" | "keyword"; reason: string | null; refreshPending: boolean; lastRefreshStatus: string | null };
  warnings: Warning[];
  changes: ChangeRow[];
};

export function overview(db: DB, now: number, digest: { value: string | null; error: string | null }, model: string | null): Overview {
  const zone = RULES.timezone;
  const today = todayLocal(now, zone);
  const from = toInstant(today, "00:00", zone);
  const to = toInstant(addLocalDays(today, 1, zone), "00:00", zone);
  const branches = db.prepare("SELECT slug, name FROM branches WHERE is_active = 1 ORDER BY id").all() as { slug: string; name: string }[];
  const dayRows = db
    .prepare("SELECT r.ref, r.status, r.party_size, r.starts_at, r.guest_name, b.slug, b.name FROM reservations r JOIN branches b ON b.id = r.branch_id WHERE r.starts_at >= ? AND r.starts_at < ? ORDER BY r.starts_at")
    .all(from, to) as { ref: string; status: string; party_size: number; starts_at: number; guest_name: string; slug: string; name: string }[];
  const confirmed = dayRows.filter((r) => r.status === "confirmed");
  const next = confirmed.filter((r) => r.starts_at >= now - 30 * 60_000).slice(0, 6).map((r) => ({ ref: r.ref, timeLabel: timeLabel(r.starts_at, zone), partySize: r.party_size, branch: branchShortName(r.name), guestName: r.guest_name }));
  const nextDays = Array.from({ length: 6 }, (_, i) => addLocalDays(today, i + 1, zone)).map((date) => {
    const rows = db.prepare("SELECT party_size FROM reservations WHERE status = 'confirmed' AND starts_at >= ? AND starts_at < ?").all(toInstant(date, "00:00", zone), toInstant(addLocalDays(date, 1, zone), "00:00", zone)) as { party_size: number }[];
    return { date, label: dayLabelLong(date, zone).replace(/ \d{4}$/, ""), confirmed: rows.length, covers: rows.reduce((n, r) => n + r.party_size, 0) };
  });

  const menu = listMenu(db);
  const faqs = listFaqs(db);
  const kb = knowledgeOverview(db, now, digest, model);
  const warnings: Warning[] = [];

  // Bookings the current hours or tables no longer support (after an hours change staff confirmed, say).
  const conflicts = findConflicts(db, now);
  if (conflicts.length)
    warnings.push({
      tone: "bad",
      title: `${conflicts.length} upcoming ${conflicts.length === 1 ? "booking doesn't" : "bookings don't"} fit the current hours or tables`,
      detail: conflicts
        .slice(0, 3)
        .map((c) => `${c.ref} on ${dayLabelLong(localDateOf(c.startsAt, zone), zone)} at ${timeLabel(c.startsAt, zone)}`)
        .join("; "),
      href: "/admin/availability",
    });
  for (const d of kb.documents.filter((x) => x.state === "failed").slice(0, 3)) warnings.push({ tone: "bad", title: `"${d.title}" couldn't be added to the knowledge base`, detail: d.error ?? "Ingestion failed.", href: `/admin/knowledge/${d.id}` });
  for (const d of kb.documents.filter((x) => x.embedError && x.state === "keyword_only").slice(0, 3)) warnings.push({ tone: "warn", title: `"${d.title}" has no semantic vectors`, detail: d.embedError ?? "", href: `/admin/knowledge/${d.id}` });
  const lastRefresh = kb.index.lastRefresh;
  if (lastRefresh?.status === "failed" && !kb.index.refreshPending) warnings.push({ tone: "warn", title: "The last index refresh failed", detail: lastRefresh.error ?? "", href: "/admin/knowledge" });
  if (kb.index.mode === "keyword" && !kb.index.refreshPending && lastRefresh?.status !== "failed") warnings.push({ tone: "warn", title: "Chatbot search is keyword-only", detail: kb.index.reason ?? "", href: "/admin/knowledge" });
  if (faqs.conflicts.some((c) => c.kind === "conflict")) warnings.push({ tone: "warn", title: `${faqs.conflicts.filter((c) => c.kind === "conflict").length} FAQ ${faqs.conflicts.length === 1 ? "pair asks" : "pairs ask"} the same question with different answers`, detail: faqs.conflicts[0].message, href: "/admin/faqs" });
  if (faqs.conflicts.some((c) => c.kind === "duplicate")) warnings.push({ tone: "warn", title: "Duplicate FAQs", detail: faqs.conflicts.find((c) => c.kind === "duplicate")!.message, href: "/admin/faqs" });

  const lastOf = (area: "menu" | "faq") => recentChanges(db, { area, limit: 1 })[0] ?? null;
  return {
    today,
    todayLabel: dayLabelLong(today, zone),
    bookings: {
      today: {
        confirmed: confirmed.length,
        covers: confirmed.reduce((n, r) => n + r.party_size, 0),
        cancelled: dayRows.length - confirmed.length,
        byBranch: branches.map((b) => {
          const rs = confirmed.filter((r) => r.slug === b.slug);
          return { slug: b.slug, name: branchShortName(b.name), confirmed: rs.length, covers: rs.reduce((n, r) => n + r.party_size, 0) };
        }),
      },
      next,
      nextDays,
    },
    menu: { listed: menu.counts.listed, available: menu.counts.available, unavailable: menu.counts.unavailable, removed: menu.counts.removed, lastChange: lastOf("menu") },
    faqs: { active: faqs.counts.active, inactive: faqs.counts.inactive, conflicts: faqs.conflicts.length, lastChange: lastOf("faq") },
    knowledge: { documents: kb.counts.documents, searchable: kb.counts.searchable, keywordOnly: kb.counts.keywordOnly, failed: kb.counts.failed, mode: kb.index.mode, reason: kb.index.reason, refreshPending: kb.index.refreshPending, lastRefreshStatus: lastRefresh?.status ?? null },
    warnings,
    changes: recentChanges(db, { limit: 8 }),
  };
}
