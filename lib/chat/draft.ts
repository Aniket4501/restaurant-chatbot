import { RULES } from "@/lib/config";
import type { BookingFields } from "@/lib/llm/schema";
import { daysBetween, isLocalDate, isLocalTime, todayLocal } from "@/lib/time/tz";
import type { BranchInfo } from "@/lib/chat/templates";
import type { Draft, Field } from "@/lib/chat/types";

// Draft merge rules (§5.7, D-06, D-15). Values come only from the latest guest message (the model is told so).
// A valid non-null value overwrites; null never clears; partySize 0 merges like null; 9+ is not stored and gets the
// branch-phone template. Changing branch, date, party size or time drops a selected slot but keeps the time
// preference, so availability re-runs with it. Every value, chip and ambiguity candidate is validated here.

export type FieldIssue = "bad_branch" | "branch_inactive" | "bad_date" | "past_date" | "past_horizon" | "bad_time" | "bad_party" | "large_party";

export type FieldCtx = { now: number; zone: string; branches: BranchInfo[]; allSlugs: Set<string> };

type Value = string | number | null;

/** Validate one field value for the draft. partySize 0 is `bad_party` (ask again); 9+ is `large_party`. */
export function validateField(field: Field, value: Value, ctx: FieldCtx): { ok: true; value: Draft[Field] } | { ok: false; issue: FieldIssue } {
  switch (field) {
    case "branch":
      if (typeof value !== "string") return { ok: false, issue: "bad_branch" };
      if (ctx.branches.some((b) => b.slug === value)) return { ok: true, value };
      return { ok: false, issue: ctx.allSlugs.has(value) ? "branch_inactive" : "bad_branch" };
    case "date": {
      if (typeof value !== "string" || !isLocalDate(value)) return { ok: false, issue: "bad_date" };
      const offset = daysBetween(todayLocal(ctx.now, ctx.zone), value);
      if (offset < 0) return { ok: false, issue: "past_date" };
      if (offset > RULES.horizonDays) return { ok: false, issue: "past_horizon" };
      return { ok: true, value };
    }
    case "time":
      return typeof value === "string" && isLocalTime(value) ? { ok: true, value } : { ok: false, issue: "bad_time" };
    case "timeWindow":
      return value === "lunch" || value === "dinner" ? { ok: true, value } : { ok: false, issue: "bad_time" };
    case "partySize": {
      const n = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : value;
      if (typeof n !== "number" || !Number.isInteger(n) || n < RULES.onlinePartyMin) return { ok: false, issue: "bad_party" };
      if (n > RULES.onlinePartyMax) return { ok: false, issue: "large_party" };
      return { ok: true, value: n };
    }
  }
}

/** A slot selection no longer matches the draft once any search field changes, the meal included (review TP-1). */
function withSelection(prev: Draft, next: Draft): Draft {
  const changed = prev.branch !== next.branch || prev.date !== next.date || prev.partySize !== next.partySize || prev.time !== next.time || prev.timeWindow !== next.timeWindow;
  return changed ? { ...next, selected: null } : next;
}

/**
 * The latest stated value wins (§5.7; review TP-1, TP-3):
 * - a new meal stated without a time replaces the old time preference ("make it lunch instead");
 * - a value we can't use (9+ guests, a date outside the horizon, an inactive branch) clears that field, so the flow asks
 *   again instead of offering the old slot.
 */
function latestWins(prev: Draft, next: Draft, statedTime: boolean, rejected: Field[], clearTime = false): Draft {
  const out = { ...next };
  // `clearTime`: the guest named a meal or a relative change ("lunch is better after all", "an hour later") and no
  // clock time, so the old time no longer stands, even if the meal is the one stored (failure-mode audit FM-014).
  if (!statedTime && ((next.timeWindow !== prev.timeWindow && next.timeWindow !== null) || clearTime)) out.time = null;
  for (const f of rejected) if (f === "branch" || f === "date" || f === "partySize") (out as Record<Field, unknown>)[f] = null;
  return out;
}

export type MergeResult = {
  draft: Draft;
  /** Fields the guest gave that failed validation (the first one is asked about). */
  issues: { field: Field; issue: FieldIssue }[];
  /** Validated candidates when the guest's value had several readings (≥ 2 survive, else ignored). */
  ambiguity: { field: Field; candidates: string[] } | null;
  largeParty: boolean;
  changed: Field[];
};

/** Which reason to give when no ambiguity reading is usable: the most useful one first (D-17). */
const ISSUE_RANK: FieldIssue[] = ["large_party", "past_horizon", "branch_inactive", "past_date", "bad_party", "bad_date", "bad_branch", "bad_time"];

/** Merge the model's extracted booking fields into the draft. */
export function mergeExtracted(draft: Draft, booking: BookingFields, ctx: FieldCtx, opts: { clearTime?: boolean } = {}): MergeResult {
  let ambiguity: MergeResult["ambiguity"] = null;
  let unusable: { field: Field; issue: FieldIssue } | null = null;
  let clearAsk: Field | null = null;
  if (booking.ambiguity) {
    const field = booking.ambiguity.field as Field;
    const unique = [...new Set(booking.ambiguity.candidates)];
    const checked = unique.map((c) => validateField(field, c, ctx));
    const candidates = unique.filter((_, i) => checked[i].ok);
    const bad = checked.flatMap((c) => (c.ok ? [] : [c.issue]));
    if (candidates.length >= 2) ambiguity = { field, candidates };
    // Fewer than two usable readings (D-17): never keep the old value as if nothing was said.
    // - any 9+ reading of the party is a large party ("8 or 9 of us");
    // - no usable reading is treated like one bad value, with the reason ranked, not taken from the first candidate
    //   ("30 December" in either year: past the horizon; D2 LV-INV-004);
    // - one usable reading of branch, date or party clears that field, so the flow asks plainly.
    else if (field === "partySize" && bad.includes("large_party")) unusable = { field, issue: "large_party" };
    else if (candidates.length === 0 && bad.length) unusable = { field, issue: ISSUE_RANK.find((r) => bad.includes(r)) ?? bad[0] };
    else if (candidates.length === 1 && (field === "branch" || field === "date" || field === "partySize")) clearAsk = field;
  }
  const next: Draft = { ...draft };
  const issues: MergeResult["issues"] = [];
  const changed: Field[] = [];
  let largeParty = false;
  for (const field of ["branch", "date", "time", "timeWindow", "partySize"] as const) {
    const raw = booking[field];
    if (raw === null || (field === "partySize" && raw === 0)) continue; // null never clears; 0 merges like null (D-15)
    if (ambiguity?.field === field) continue; // ask instead of guessing
    const v = validateField(field, raw, ctx);
    if (!v.ok) {
      if (v.issue === "large_party") largeParty = true;
      else issues.push({ field, issue: v.issue });
      continue;
    }
    if (next[field] !== v.value) {
      (next as Record<Field, unknown>)[field] = v.value;
      changed.push(field);
    }
  }
  if (unusable && !changed.includes(unusable.field) && !issues.some((i) => i.field === unusable.field)) {
    if (unusable.issue === "large_party") largeParty = true;
    else issues.push(unusable);
  }
  const rejected: Field[] = [...issues.map((i) => i.field), ...(largeParty ? (["partySize"] as Field[]) : [])];
  if (clearAsk && booking[clearAsk] === null && !changed.includes(clearAsk)) rejected.push(clearAsk);
  return { draft: withSelection(draft, latestWins(draft, next, booking.time !== null, rejected, opts.clearTime)), issues, ambiguity, largeParty, changed };
}

/** A chip or form action. Unlike model extraction, an explicit null clears the field ("change date"). */
export function applySetField(draft: Draft, field: Field, value: Value, ctx: FieldCtx): MergeResult {
  if (value === null) {
    const next = { ...draft, [field]: null } as Draft;
    return { draft: withSelection(draft, next), issues: [], ambiguity: null, largeParty: false, changed: draft[field] === null ? [] : [field] };
  }
  const v = validateField(field, value, ctx);
  if (!v.ok) {
    const largeParty = v.issue === "large_party";
    return { draft: withSelection(draft, latestWins(draft, draft, true, [field])), issues: largeParty ? [] : [{ field, issue: v.issue }], ambiguity: null, largeParty, changed: [] };
  }
  const next = { ...draft, [field]: v.value } as Draft;
  return { draft: withSelection(draft, latestWins(draft, next, field === "time", [])), issues: [], ambiguity: null, largeParty: false, changed: draft[field] === v.value ? [] : [field] };
}

/** True once the guest has started a booking (any search field set). */
export const bookingInProgress = (d: Draft) => d.branch !== null || d.date !== null || d.partySize !== null;
