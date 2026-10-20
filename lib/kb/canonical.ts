import { findPhones } from "@/lib/phone";

// Canonical forms for the grounding check (§5.7, D-15): times → minutes since midnight, prices → whole rupees,
// phones → E.164. Both the answer and the cited facts go through the same functions, so "11 PM", "11:00 pm"
// and "23:00" match. Spans let the grounding check blank these out before checking the remaining digit runs.
// Time words (noon, midnight, half past …) are deliberately not canonicalised: D-15 rejects them unless the
// cited facts contain the word itself.

export type Span<T> = { start: number; end: number; value: T };

const MERIDIEM = "(a\\.?m\\.?|p\\.?m\\.?)(?![a-z])";
// "7.30 pm" and "7:30 pm" both read; a bare range start takes the end's meridiem ("7–11 PM", "from 3 to 11 PM"),
// flipped when it can't be the same half of the day ("11 to 3 PM" is 11 AM). Review RT-2/MB-2.
const RANGE_RE = new RegExp(`\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*(?:-|–|—|to|till|until)\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MERIDIEM}`, "dgi"); // d: group indices, for the start time's own span
const TIME_RE = new RegExp(`\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MERIDIEM}|\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b`, "gi");

const twelve = (h: number, min: number, pm: boolean) => ((h % 12) + (pm ? 12 : 0)) * 60 + min;
const valid12 = (h: number, min: number) => h >= 1 && h <= 12 && min <= 59;

/** "7:30 PM", "7.30 pm", "7pm", "11 p.m.", "19:30", and both ends of "7–11 PM" → minutes since midnight. Impossible values are skipped. */
export function timeSpans(text: string): Span<number>[] {
  const out: Span<number>[] = [];
  for (const m of text.matchAll(RANGE_RE)) {
    const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3]), Number(m[4] ?? 0)];
    if (!valid12(h1, m1) || !valid12(h2, m2)) continue;
    const pm = /p/i.test(m[5]);
    const samehalf = h1 % 12 <= h2 % 12;
    const startGroup = m.indices![1]!;
    const [start, end] = [startGroup[0], (m.indices![2] ?? startGroup)[1]];
    out.push({ start, end, value: twelve(h1, m1, samehalf ? pm : !pm) });
  }
  for (const m of text.matchAll(TIME_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    let value: number;
    if (m[1]) {
      const h = Number(m[1]);
      const min = Number(m[2] ?? 0);
      if (!valid12(h, min)) continue;
      value = twelve(h, min, /p/i.test(m[3]));
    } else value = Number(m[4]) * 60 + Number(m[5]);
    if (out.some((o) => o.start < end && start < o.end)) continue;
    out.push({ start, end, value });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Time-shaped text that no canonical form covers ("7.30" without am/pm, "13 pm"): grounding rejects it (review RT-2). */
export const UNREADABLE_TIME_RE = new RegExp(`\\b\\d{1,2}[.:]\\d{2}\\b|\\b\\d{1,2}(?:[.:]\\d{2})?\\s*${MERIDIEM}`, "i");

/** D-15's time and number words; shown prose may use them only if its cited facts do. */
export const NUMBER_WORDS = [
  "noon", "midnight", "o'clock", "half past", "quarter past", "quarter to",
  ...["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"],
  ...["thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred"],
];
export const numberWordRe = (w: string) => new RegExp(`(?<![\\p{L}])${w.replace(/'/g, "['’]")}(?![\\p{L}])`, "iu");

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
    // Exactly 10 digits, optionally after 0, 91 or +91; anything else can never match a real number (review RT-3).
    const local = digits.length === 10 ? digits : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : null;
    out.push({ start, end, value: local ? `+91${local}` : `invalid:${digits}` });
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
