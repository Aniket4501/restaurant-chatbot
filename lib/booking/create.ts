import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { RULES } from "@/lib/config";
import type { DB } from "@/lib/db/client";
import { immediate } from "@/lib/db/tx";
import { alternativesFor, checkStart, getAvailability, type Slot } from "@/lib/booking/availability";
import { loadAvailabilityData } from "@/lib/booking/load";
import { MESSAGES, type BookingError, type ExistingBooking, type UnavailableReason } from "@/lib/booking/errors";
import { randomRef } from "@/lib/booking/ref";
import { viewByKey, viewByRef, type ReservationView } from "@/lib/booking/view";
import { normalizeGuestMobile } from "@/lib/phone";
import { dayLabelLong, localDateOf, localTimeOf, timeLabel } from "@/lib/time/tz";

// Booking write path (MASTER_PROMPT §5.6 with D-08 and D-14). Guarantees G-1…G-4 rest on: one synchronous
// IMMEDIATE transaction (single writer, lock taken up front), the engine's own rules for re-validation, and the
// overlap triggers as a backstop.

export const CreateBodySchema = z.object({
  branch: z.string().min(1),
  // Any instant that formats as a normal date; the engine decides the rest (review BI-3).
  startsAt: z.number().int().min(Date.UTC(2000, 0, 1), "Invalid time").max(Date.UTC(2100, 0, 1), "Invalid time"),
  partySize: z.number().int().min(RULES.onlinePartyMin, "Please choose how many guests"),
  name: z
    .string()
    // Zero-width joiners are part of Malayalam, Marathi and some Hindi spellings (failure-mode audit FM-040); other
    // format characters (bidi overrides, BOM) and controls are refused.
    .refine((s) => !/(?![\u200C\u200D])[\p{Cc}\p{Cf}]/u.test(s.replace(/[\t\n\r]/g, " ")), "Please use letters, spaces and punctuation only")
    .transform((s) => s.trim().replace(/\s+/g, " "))
    .pipe(
      z
        .string()
        .min(RULES.nameMin, "Please enter your name")
        .max(RULES.nameMax, "That name is too long")
        .refine((s) => (s.match(/\p{L}/gu) ?? []).length >= 2, "Please enter your name"),
    ),
  phone: z.string().transform((s, ctx) => {
    const e164 = normalizeGuestMobile(s);
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "Please enter a valid Indian mobile number" });
      return z.NEVER;
    }
    return e164;
  }),
  // A blank optional email means "no email" (review BI-1).
  email: z
    .preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().toLowerCase().pipe(z.email("Please enter a valid email")).nullable().optional())
    .transform((v) => v ?? null),
  note: z
    .string()
    .trim()
    .max(RULES.noteMax, `Notes can be up to ${RULES.noteMax} characters`)
    .nullable()
    .optional()
    .transform((v) => v || null),
});
export type CreateBody = z.infer<typeof CreateBodySchema>;

export type CreateResult = { status: 201 | 200; reservation: ReservationView } | BookingError;

/** SHA-256 of the normalised body (§5.6): same key + same hash = a retry; same key + different hash = misuse. */
export function requestHash(b: CreateBody): string {
  const normalized = [b.branch, new Date(b.startsAt).toISOString(), b.partySize, b.name, b.phone, b.email ?? "", b.note ?? ""].join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

const casefold = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");

export type CreateDeps = { newRef?: () => string; newId?: () => string };

export type TxOutcome =
  | { kind: "created" | "replayed"; ref: string }
  | { kind: "mismatch" }
  | { kind: "unavailable"; reason: UnavailableReason }
  | { kind: "taken" }
  | { kind: "duplicate"; existing: ExistingBooking | null }
  | { kind: "validation"; field: string; message: string };

/**
 * Create a reservation. `raw` is the parsed JSON body; `key` the Idempotency-Key header (UUID).
 * Returns 201 (created) or 200 (replay of the same key and body) with the saved row, or a typed error.
 */
export function createReservation(db: DB, raw: unknown, key: string, now: number, deps: CreateDeps = {}): CreateResult {
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[String(i.path[0] ?? "body")] ??= i.message;
    return { code: "VALIDATION", status: 400, message: "Please check the highlighted fields.", fields };
  }
  if (!z.uuid().safeParse(key).success) return { code: "VALIDATION", status: 400, message: "Missing or invalid Idempotency-Key header.", fields: { idempotencyKey: "must be a UUID" } };
  key = key.toLowerCase(); // one canonical spelling per UUID (review BI-5)
  const body = parsed.data;
  const hash = requestHash(body);
  const newRef = deps.newRef ?? randomRef;
  const newId = deps.newId ?? randomUUID;

  let outcome: TxOutcome;
  // An error thrown inside the transaction is rolled back, so the guest can be told nothing was booked; only an error at
  // or after COMMIT leaves the outcome unknown (failure-mode audit FM-037: every error was "we couldn't confirm").
  let rolledBack = false;
  try {
    outcome = immediate(db, (): TxOutcome => {
      try {
        // 1. Idempotency lookup.
        const prior = viewByKey(db, key);
        if (prior) return prior.requestHash === hash ? { kind: "replayed", ref: prior.ref } : { kind: "mismatch" };
        // 2. Re-validate with the engine's rules, on a snapshot read inside the write lock.
        const bundle = loadAvailabilityData(db, [localDateOf(body.startsAt, branchZone(db, body.branch))]);
        const check = checkStart(bundle, body.branch, body.partySize, body.startsAt, now);
        if (!check.ok) {
          if (check.reason === "unknown_branch") return { kind: "validation", field: "branch", message: "Unknown branch" };
          if (check.reason !== "full") return { kind: "unavailable", reason: check.reason };
        }
        const branch = bundle.branches.find((b) => b.slug === body.branch)!;
        const endsAt = body.startsAt + RULES.sittingMinutes(body.partySize) * 60_000;
        // 3. Guest overlap before table choice (§5.6): a guest who already holds the last table hears about it.
        const dup = duplicateOf(db, branch.id, branch.slug, branch.timezone, body, endsAt);
        if (dup) return dup;
        // 4. Smallest free fitting table.
        if (!check.ok) return { kind: "taken" };
        const table = pickTableFresh(db, branch.id, body.partySize, body.startsAt, endsAt);
        if (!table) return { kind: "taken" };
        // 5. Reference (collision-checked inside the lock) and insert; the triggers re-check overlaps.
        let ref = newRef();
        for (let i = 0; i < 5 && db.prepare("SELECT 1 FROM reservations WHERE ref = ?").get(ref); i++) ref = newRef();
        db.prepare(
          `INSERT INTO reservations (id, ref, branch_id, table_id, guest_name, phone_e164, email, note, party_size, starts_at, ends_at, status, source, idempotency_key, request_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'chat', ?, ?, ?)`,
        ).run(newId(), ref, branch.id, table, body.name, body.phone, body.email, body.note, body.partySize, body.startsAt, endsAt, key, hash, now);
        return { kind: "created", ref };
      } catch (inner) {
        rolledBack = true;
        throw inner;
      }
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code?.startsWith("SQLITE_BUSY")) return { code: "UNAVAILABLE", status: 503, message: MESSAGES.UNAVAILABLE };
    if (err.code?.startsWith("SQLITE_CONSTRAINT")) {
      try {
        outcome = mapConstraintError(db, err, key, hash, body);
      } catch (unmapped) {
        if (!rolledBack) throw unmapped;
        console.error(JSON.stringify({ event: "reservation_error", stage: "rolled_back", code: err.code ?? "unknown" }));
        return { code: "UNAVAILABLE", status: 503, message: MESSAGES.UNAVAILABLE };
      }
    } else if (rolledBack) {
      console.error(JSON.stringify({ event: "reservation_error", stage: "rolled_back", code: err.code ?? (e as Error).name }));
      return { code: "UNAVAILABLE", status: 503, message: MESSAGES.UNAVAILABLE };
    } else throw e;
  }
  return toResult(db, outcome, body, now);
}

/** Smallest free fitting table by direct query, so the choice uses exactly the rows the triggers will check. */
function pickTableFresh(db: DB, branchId: number, party: number, startsAt: number, endsAt: number): number | null {
  const row = db
    .prepare(
      `SELECT t.id FROM dining_tables t
       WHERE t.branch_id = ? AND t.is_active = 1 AND t.min_seats <= ? AND ? <= t.max_seats
         AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.table_id = t.id AND r.status = 'confirmed' AND r.starts_at < ? AND ? < r.ends_at)
       ORDER BY t.max_seats, t.min_seats, length(t.label), t.label LIMIT 1`,
    )
    .get(branchId, party, party, endsAt, startsAt) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * D-08: on any constraint error, first repeat the idempotency lookup (BEFORE INSERT triggers fire before UNIQUE,
 * so a same-key replay can surface as GUEST_OVERLAP, SQ-24). Only then map trigger messages. Tests never rely on
 * which trigger fires first when both conditions hold.
 */
export function mapConstraintError(db: DB, err: { code?: string; message?: string }, key: string, hash: string, body: CreateBody): TxOutcome {
  const prior = viewByKey(db, key);
  if (prior) return prior.requestHash === hash ? { kind: "replayed", ref: prior.ref } : { kind: "mismatch" };
  if (err.message === "TABLE_OVERLAP") return { kind: "taken" };
  if (err.message === "GUEST_OVERLAP") {
    const b = db.prepare("SELECT id, timezone FROM branches WHERE slug = ?").get(body.branch) as { id: number; timezone: string } | undefined;
    const endsAt = body.startsAt + RULES.sittingMinutes(body.partySize) * 60_000;
    return (b && duplicateOf(db, b.id, body.branch, b.timezone, body, endsAt)) || { kind: "duplicate", existing: null };
  }
  throw Object.assign(new Error(`unmapped constraint error: ${err.code}`), { cause: err });
}

/**
 * Guest overlap (§5.6 step 3, BR-11). J7 (D-14): reveal a booking only if its name matches the submitted one, checking
 * every overlapping booking on that mobile (review BI-4), so a stranger who knows the number learns nothing.
 */
function duplicateOf(db: DB, branchId: number, slug: string, zone: string, body: CreateBody, endsAt: number): TxOutcome | null {
  const rows = db
    .prepare("SELECT ref, guest_name, starts_at FROM reservations WHERE branch_id = ? AND phone_e164 = ? AND status = 'confirmed' AND starts_at < ? AND ? < ends_at ORDER BY starts_at")
    .all(branchId, body.phone, endsAt, body.startsAt) as { ref: string; guest_name: string; starts_at: number }[];
  if (!rows.length) return null;
  const mine = rows.find((r) => casefold(r.guest_name) === casefold(body.name));
  return { kind: "duplicate", existing: mine ? existingView(mine.ref, slug, mine.starts_at, zone) : null };
}

function branchZone(db: DB, slug: string): string {
  return (db.prepare("SELECT timezone FROM branches WHERE slug = ?").get(slug) as { timezone: string } | undefined)?.timezone ?? RULES.timezone;
}

function existingView(ref: string, branch: string, startsAt: number, zone: string): ExistingBooking {
  return { ref, branch, startsAt, label: timeLabel(startsAt, zone), dateLabel: dayLabelLong(localDateOf(startsAt, zone), zone) };
}

function toResult(db: DB, o: TxOutcome, body: CreateBody, now: number): CreateResult {
  switch (o.kind) {
    case "created":
    case "replayed":
      return { status: o.kind === "created" ? 201 : 200, reservation: viewByRef(db, o.ref)! };
    case "mismatch":
      return { code: "IDEMPOTENCY_MISMATCH", status: 422, message: MESSAGES.IDEMPOTENCY_MISMATCH };
    case "validation":
      return { code: "VALIDATION", status: 400, message: "Please check the highlighted fields.", fields: { [o.field]: o.message } };
    case "duplicate":
      return { code: "DUPLICATE_BOOKING", status: 409, message: MESSAGES.DUPLICATE_BOOKING, existing: o.existing };
    case "taken":
      return { code: "SLOT_TAKEN", status: 409, message: MESSAGES.SLOT_TAKEN, alternatives: freshAlternatives(db, body, now) };
    case "unavailable":
      return { code: "SLOT_UNAVAILABLE", status: 409, message: MESSAGES.SLOT_UNAVAILABLE, reason: o.reason, alternatives: o.reason === "party_size" ? [] : freshAlternatives(db, body, now) };
  }
}

/** Computed after the transaction (§5.6 step 4): the day's nearest open times, then the engine's alternatives. */
function freshAlternatives(db: DB, body: CreateBody, now: number): Slot[] {
  const zone = branchZone(db, body.branch);
  const date = localDateOf(body.startsAt, zone);
  const q = { branch: body.branch, date, partySize: body.partySize, time: localTimeOf(body.startsAt, zone) };
  const bundle = loadAvailabilityData(db, [date]);
  const r = getAvailability(q, bundle, now);
  // An inactive branch still gets the other branch's times (review AV-2).
  const candidates = r.ok ? [...r.slots, ...r.alternatives] : r.error === "branch_inactive" ? alternativesFor(bundle, q, now) : [];
  const seen = new Set<string>();
  return candidates.filter((s) => s.startsAt !== body.startsAt || s.branch !== body.branch).filter((s) => {
    const k = `${s.branch}|${s.startsAt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
