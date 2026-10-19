import { z } from "zod";
import { DAY_KEYS, isLocalDate, isLocalTime } from "@/lib/time/tz";

// Seed file format (data/seed/*.json and evals/fixtures/base.json share it). Validated before anything
// touches the database; cross-file rules in superRefine (D-08 exception rules, references, uniqueness).

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase slug");
const hhmm = z.string().refine(isLocalTime, "zero-padded HH:MM");
const closeTime = z.string().refine((s) => s === "24:00" || isLocalTime(s), "zero-padded HH:MM or 24:00");
const zone = z.string().refine((tzName) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tzName });
    return true;
  } catch {
    return false;
  }
}, "IANA time zone");
/** Absolute YYYY-MM-DD, or relative "+Nd" resolved against the stored seed anchor date (D-14). */
const seedDate = z.string().refine((s) => isLocalDate(s) || /^\+(0|[1-9]\d{0,2})d$/.test(s), "YYYY-MM-DD or +Nd (no leading zeros)");
const service = z.enum(["lunch", "dinner"]);

export const SeedSchema = z
  .strictObject({
    fixtureVersion: z.number().int().optional(),
    restaurant: z.strictObject({ name: z.string().min(1), cuisine: z.string().min(1), about: z.string().min(1) }),
    branches: z
      .array(
        z.strictObject({
          slug,
          name: z.string().min(1),
          address: z.string().min(1),
          phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "E.164"),
          timezone: zone,
          isActive: z.boolean().default(true),
        }),
      )
      .min(1),
    hours: z.array(
      z
        .strictObject({ branch: slug, days: z.array(z.enum(DAY_KEYS)).min(1), service, opens: hhmm, closes: closeTime })
        .refine((h) => h.closes === "24:00" || h.closes > h.opens, "closes must be after opens"),
    ),
    exceptions: z.array(
      z
        .strictObject({
          branch: slug,
          date: seedDate,
          service: service.nullable(),
          isClosed: z.boolean(),
          opens: hhmm.nullable(),
          closes: closeTime.nullable(),
          note: z.string().nullable(),
        })
        .refine((e) => e.isClosed || (e.opens !== null && e.closes !== null && (e.closes === "24:00" || e.closes > e.opens)), "an open exception needs opens < closes")
        .refine((e) => e.service !== null || e.isClosed, "a whole-day exception can only be a closure"),
    ),
    tables: z
      .array(z.strictObject({ branch: slug, label: z.string().min(1), minSeats: z.number().int().min(1), maxSeats: z.number().int().min(1), isActive: z.boolean().default(true) }))
      .min(1),
    menu: z.array(
      z.strictObject({
        slug,
        category: slug,
        name: z.string().min(1),
        description: z.string().min(1),
        priceInr: z.number().int().positive(),
        dietary: z.array(z.enum(["vegetarian", "vegan", "gluten-free", "jain-available", "contains-dairy", "contains-nuts", "egg"])),
        spiceLevel: z.number().int().min(0).max(3).nullable(),
        branches: z.array(slug).min(1).nullable(),
        isAvailable: z.boolean(),
      }),
    ),
    faq: z.array(z.strictObject({ slug, branch: slug.nullable(), question: z.string().min(1), answer: z.string().min(1) })),
  })
  .superRefine((s, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const branches = new Set(s.branches.map((b) => b.slug));
    const dup = <T>(items: T[], key: (t: T) => string, path: string) => {
      const seen = new Set<string>();
      items.forEach((it, i) => {
        const k = key(it);
        if (seen.has(k)) issue([path, i], `duplicate ${k}`);
        seen.add(k);
      });
    };
    dup(s.branches, (b) => b.slug, "branches");
    dup(s.menu, (m) => m.slug, "menu");
    dup(s.faq, (f) => f.slug, "faq");
    dup(s.tables, (t) => `${t.branch}/${t.label}`, "tables");
    dup(s.hours.flatMap((h) => h.days.map((d) => ({ ...h, day: d }))), (h) => `${h.branch}/${h.day}/${h.service}`, "hours");
    const ref = (b: string | null, path: (string | number)[]) => {
      if (b !== null && !branches.has(b)) issue(path, `unknown branch ${b}`);
    };
    s.hours.forEach((h, i) => ref(h.branch, ["hours", i, "branch"]));
    s.tables.forEach((t, i) => {
      ref(t.branch, ["tables", i, "branch"]);
      if (t.maxSeats < t.minSeats) issue(["tables", i], "maxSeats < minSeats");
    });
    s.faq.forEach((f, i) => ref(f.branch, ["faq", i, "branch"]));
    s.menu.forEach((m, i) => {
      m.branches?.forEach((b, j) => ref(b, ["menu", i, "branches", j]));
      if (m.dietary.includes("vegan") && (m.dietary.includes("contains-dairy") || m.dietary.includes("egg"))) issue(["menu", i], "vegan item lists dairy or egg");
    });
    s.exceptions.forEach((e, i) => ref(e.branch, ["exceptions", i, "branch"]));
    // Weekly lunch and dinner windows must not overlap on a day (review AV-1).
    const byDay = new Map<string, { opens: string; closes: string }[]>();
    s.hours.forEach((h) => h.days.forEach((d) => byDay.set(`${h.branch}|${d}`, [...(byDay.get(`${h.branch}|${d}`) ?? []), h])));
    for (const [k, ws] of byDay) if (overlaps(ws)) issue(["hours"], `lunch and dinner overlap for ${k}`);
    // Exception rules on the dates as written; applySeed re-checks after resolving "+Nd" (review DB-1).
    for (const p of exceptionProblems(s.exceptions.map((e) => ({ ...e, key: `${e.branch}|${e.date}` })))) issue(["exceptions"], p);
  });

const minutes = (t: string) => (t === "24:00" ? 1440 : Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
function overlaps(ws: { opens: string; closes: string }[]): boolean {
  const sorted = [...ws].sort((a, b) => minutes(a.opens) - minutes(b.opens));
  return sorted.some((w, i) => i > 0 && minutes(w.opens) < minutes(sorted[i - 1].closes));
}

/**
 * D-08 exception rules per (branch, date) key: no whole-day row beside per-service rows, no duplicate service,
 * per-service rows list both services (otherwise the unlisted one is silently closed), open windows don't overlap.
 */
export function exceptionProblems(rows: { key: string; service: string | null; isClosed: boolean; opens: string | null; closes: string | null }[]): string[] {
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  const problems: string[] = [];
  for (const [k, rs] of byKey) {
    const services = rs.map((r) => r.service);
    if (new Set(services).size !== services.length) problems.push(`duplicate exception service for ${k}`);
    if (services.includes(null) && services.length > 1) problems.push(`whole-day exception beside per-service rows for ${k}`);
    if (!services.includes(null) && !(services.includes("lunch") && services.includes("dinner"))) problems.push(`per-service exceptions for ${k} must list both lunch and dinner`);
    const open = rs.filter((r) => !r.isClosed && r.opens && r.closes) as { opens: string; closes: string }[];
    if (overlaps(open)) problems.push(`open exception windows overlap for ${k}`);
  }
  return problems;
}

export type SeedData = z.infer<typeof SeedSchema>;
