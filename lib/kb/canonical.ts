import { findPhones } from "@/lib/phone";

// Canonical forms for the grounding check (§5.7, D-15): times → minutes since midnight, prices → whole rupees,
// phones → E.164. Both the answer and the cited facts go through the same functions, so "11 PM", "11:00 pm"
// and "23:00" match. Spans let the grounding check blank these out before checking the remaining digit runs.
// Time words (noon, midnight, half past …) are deliberately not canonicalised: D-15 rejects them unless the
// cited facts contain the word itself.

export type Span<T> = { start: number; end: number; value: T };

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;

/** "7:30 PM", "7pm", "11 p.m.", "19:30" → minutes since midnight. Impossible values ("13 pm", "7:75 pm") are skipped. */
export function timeSpans(text: string): Span<number>[] {
  const out: Span<number>[] = [];
  for (const m of text.matchAll(TIME_RE)) {
    let value: number;
    if (m[1]) {
      const h = Number(m[1]);
      const min = Number(m[2] ?? 0);
      if (h < 1 || h > 12 || min > 59) continue;
      value = ((h % 12) + (/p/i.test(m[3]) ? 12 : 0)) * 60 + min;
    } else value = Number(m[4]) * 60 + Number(m[5]);
    out.push({ start: m.index, end: m.index + m[0].length, value });
  }
  return out;
}

// Digit groups allow both "1,200" and Indian "1,20,000"; a trailing comma ("₹420, and") is never part of the price.
const PRICE_RE = /(?:₹|\brs\.?|\binr)\s*(\d+(?:,\d{2,3})*)(?:\.(\d{1,2}))?|\b(\d+(?:,\d{2,3})*)(?:\.(\d{1,2}))?\s*(?:rupees|inr)\b/gi;

/** "₹1,200", "Rs. 420", "420 rupees", "INR 95" → rupees (a non-zero paise part stays fractional, so it never matches). */
export function priceSpans(text: string): Span<number>[] {
  const out: Span<number>[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const whole = Number((m[1] ?? m[3]).replace(/,/g, ""));
    const paise = m[2] ?? m[4];
    out.push({ start: m.index, end: m.index + m[0].length, value: whole + (paise ? Number(paise) / 10 ** paise.length : 0) });
  }
  return out;
}

/** Phone numbers → E.164: libphonenumber (`/max`, India default) plus a fallback for other runs of 10+ digits. */
export function phoneSpans(text: string): Span<string>[] {
  const out: Span<string>[] = findPhones(text).map((p) => ({ start: p.start, end: p.end, value: p.e164 }));
  for (const m of text.matchAll(/\+?\d[\d\s-]{8,}\d/g)) {
    const start = m.index;
    const end = start + m[0].length;
    if (out.some((s) => s.start < end && start < s.end)) continue;
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10 || /\d{4}-\d{2}-\d{2}/.test(m[0])) continue; // "2026-10-22 19:30" is a date and a time, not a phone
    out.push({ start, end, value: digits.length <= 13 ? `+91${digits.slice(-10)}` : `+${digits}` });
  }
  return out.sort((a, b) => a.start - b.start);
}

export const timesIn = (text: string) => new Set(timeSpans(text).map((s) => s.value));
export const pricesIn = (text: string) => new Set(priceSpans(text).map((s) => s.value));
export const phonesIn = (text: string) => new Set(phoneSpans(text).map((s) => s.value));

/** All canonicalised spans, earliest first; overlapping spans keep the first (phones before prices before times). */
export function canonicalSpans(text: string): (Span<number | string> & { kind: "phone" | "price" | "time" })[] {
  const all = [
    ...phoneSpans(text).map((s) => ({ ...s, kind: "phone" as const })),
    ...priceSpans(text).map((s) => ({ ...s, kind: "price" as const })),
    ...timeSpans(text).map((s) => ({ ...s, kind: "time" as const })),
  ];
  const kept: typeof all = [];
  for (const s of all) if (!kept.some((k) => k.start < s.end && s.start < k.end)) kept.push(s);
  return kept.sort((a, b) => a.start - b.start);
}
