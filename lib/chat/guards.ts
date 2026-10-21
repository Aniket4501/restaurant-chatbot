import { RULES } from "@/lib/config";
import type { TraceEntry } from "@/lib/chat/types";
import { foldDigits } from "@/lib/llm/redact";
import type { Turn } from "@/lib/llm/schema";
import { weekdayDate } from "@/lib/time/calendar";
import { addLocalDays, todayLocal, weekdayOf } from "@/lib/time/tz";

// Deterministic checks on the model's extracted booking fields, applied in runTurn before the merge (D-17).
// - Time: a model time (or time ambiguity candidate) is kept only if the guest's latest message states that hour as a
//   clock time. A bare number is not a clock time: "make it lunch for 2 instead" must not become 12:00 (§5.7: values
//   come only from the latest message; D2 LV-CONF-001 and the T-20 review).
// - Weekday: one plain weekday and no other date words sets the date to that weekday's first date after today, the
//   date the prompt's Weekdays list gives (D2 LV-CLAIM-001, where "Monday night" came back as Tuesday).
// Both read the masked text, the same text the model saw.

const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const W = WORDS.join("|");
const TEENS: Record<string, number> = { thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, "twenty one": 21, "twenty two": 22, "twenty three": 23 };
const PREP = "at|around|by|after|before|about|till|until|from|past|to|half";
const NOT_A_TIME = "(?!\\s*(?:people|persons?|guests?|pax|adults?|kids?|children|of us|ppl|seats?|covers?|st\\b|nd\\b|rd\\b|th\\b))";
const hourOfWord = (w: string) => WORDS.indexOf(w) + 1;
const h12 = (h: number) => h % 12 || 12;

/** The hours (1–12) the text states as clock times. */
export function clockHours(raw: string): Set<number> {
  const t = foldDigits(raw)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/-/g, " ");
  const out = new Set<number>();
  const add = (h: number, to = false) => {
    if (!Number.isInteger(h) || h < 0 || h > 23) return;
    out.add(h12(h));
    if (to) out.add(h12(h - 1)); // "quarter to nine" is 8:45
  };
  for (const m of t.matchAll(/(?<![\d.:/])(\d{1,2})[:.](\d{2})(?![.\d])/g)) if (Number(m[2]) < 60) add(Number(m[1]));
  for (const m of t.matchAll(/(?<![\d.:/])(\d{1,2})\s*(?:am|pm|a\.m\.?|p\.m\.?|o\s?'?\s?clock|ish|hrs?|h|baje)\b/g)) add(Number(m[1]));
  // "7 30 pm" (a space for the colon) and "8 in the evening" / "9 at night" (D-21 audit).
  for (const m of t.matchAll(/(?<![\d.:/])(\d{1,2})\s+[0-5]\d\s*(?:am|pm|a\.m\.?|p\.m\.?)\b/g)) add(Number(m[1]));
  for (const m of t.matchAll(/(?<![\d.:/])(\d{1,2})\s+(?:in the (?:evening|morning|afternoon)|at night|tonight)\b/g)) add(Number(m[1]));
  for (const m of t.matchAll(/(?<![\d.:/])(\d{3,4})\s*(?:hrs?|hours|h)\b/g)) add(Math.floor(Number(m[1]) / 100));
  for (const m of t.matchAll(new RegExp(`\\b(${PREP})\\s+(?:like\\s+|maybe\\s+|roughly\\s+)?(\\d{1,2})(?![\\d:./])${NOT_A_TIME}`, "g"))) add(Number(m[2]), m[1] === "to");
  for (const m of t.matchAll(new RegExp(`\\b(${W})\\s*(?:ish|o\\s?'?\\s?clock|am|pm|a\\.m\\.?|p\\.m\\.?|baje)\\b`, "g"))) add(hourOfWord(m[1]));
  for (const m of t.matchAll(new RegExp(`\\b(${W})\\s+(?:thirty|fifteen|forty five|forty|o five)\\b`, "g"))) add(hourOfWord(m[1]));
  for (const m of t.matchAll(new RegExp(`\\b(${PREP})\\s+(?:like\\s+)?(${W})\\b${NOT_A_TIME}`, "g"))) add(hourOfWord(m[2]), m[1] === "to");
  for (const m of t.matchAll(/\b(thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?: one| two| three)?)\s+hundred\b/g)) add(TEENS[m[1]]);
  for (const m of t.matchAll(new RegExp(`\\b(${W})\\s+hundred\\b`, "g"))) add(hourOfWord(m[1]));
  if (/\b(?:noon|midday|midnight)\b/.test(t)) add(12);
  return out;
}

/**
 * The one clock time the message states unambiguously ("8 PM", "7:30pm", "20:30"), as HH:MM, or null. A bare "at 8" is
 * not unambiguous (morning or evening), and two different times are not one (D-21: the model returned no time for
 * "Do you have a table available at 8 PM?").
 */
export function statedClockTime(raw: string): string | null {
  const t = foldDigits(raw).toLowerCase();
  const found = new Set<string>();
  const fmt = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  for (const x of t.matchAll(/(?<![\d.:/])(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.?|p\.m\.?)(?![a-z])/g)) {
    const h = Number(x[1]);
    const m = Number(x[2] ?? 0);
    if (h < 1 || h > 12 || m > 59) continue;
    found.add(fmt(x[3].startsWith("p") ? (h % 12) + 12 : h % 12, m));
  }
  for (const x of t.matchAll(/(?<![\d.:/])(1[3-9]|2[0-3])[:.]([0-5]\d)(?![.\d])/g)) found.add(fmt(Number(x[1]), Number(x[2])));
  return found.size === 1 ? [...found][0] : null;
}

/** Whether the guest's message states the hour of `time` (HH:MM) as a clock time. */
export function timeStated(time: string, text: string): boolean {
  return clockHours(text).has(h12(Number(time.slice(0, 2))));
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// Words that make a weekday more than a plain weekday ("may" is left out: it is usually the verb).
// Negated or relative wording ("except Saturday", "the day before Sunday", "no wait", "nahi") makes it more than a plain
// weekday too: the guard abstains and the model's reading stands (D-21 audit).
const OTHER_DATE_WORDS =
  /\b(?:next|after|before|following|last|every|weekend|today|tonight|tomorrow|tomm?orr?ow|tmrw|tmr|kal|parso|week|fortnight|except|instead|not|nahi|wait|other than|apart from|january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b|\d{1,2}\s*(?:st|nd|rd|th)\b|\d{1,2}\s*[/-]\s*\d{1,2}|\d{4}-\d{2}-\d{2}|\b\d{1,2}\.\d{1,2}\.(?:20)?\d{2}\b|\b(?:1\d|2\d|3[01])\.(?:0?[1-9]|1[0-2])\b(?!\s*(?:am|pm))/;

/** The weekday (0 = Sunday) when the text names exactly one plain weekday and no other date words, else null. */
export function plainWeekday(raw: string): number | null {
  const t = foldDigits(raw).toLowerCase();
  const named = new Set([...t.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)].map((m) => m[1]));
  if (named.size !== 1 || OTHER_DATE_WORDS.test(t)) return null;
  const day = [...named][0];
  // "Saturday 24" or "Monday the 26" without a suffix is a date too.
  if (new RegExp(`\\b${day}\\s*,?\\s*(?:the\\s+)?\\d{1,2}\\b(?!\\s*(?:am|pm|[:.]\\d|people|guests?|pax|of us|o'?clock))`).test(t)) return null;
  return DAYS.indexOf(day);
}

// "20 people", "party of 12", "a group of 15 guests", "twenty people", "a dozen of us". Only an explicit count with a
// people word counts, and the last one stated is the one that stands ("we were 10, now just 6 of us").
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, dozen: 12, "a dozen": 12 };
const COUNT = `\\d{1,3}|a dozen|${Object.keys(COUNT_WORDS).filter((k) => k !== "a dozen").join("|")}`;
const PARTY_RE = new RegExp(`\\b(?:party|group|table)\\s+(?:of|for)\\s+(${COUNT})\\b|\\b(${COUNT})\\s*(?:people|persons|guests|pax|adults|of us)\\b|\\b(${COUNT})\\s+(?:colleagues|friends|coworkers|co-workers|family members|relatives|teammates)\\b(\\s+and\\s+(?:i|me|myself)\\b)?`, "gi");
const BOOKING_CUE_RE = /\b(?:book\w*|reserv\w*|table|seat\w*|come|coming|visit)\b/i;

/** The party size stated with a people word ("2 people", "two of us", "a group of 5"), the last one stated, or null. */
export function partyStated(raw: string): number | null {
  const t = foldDigits(raw).toLowerCase();
  const m = [...t.matchAll(PARTY_RE)].at(-1);
  const word = m ? (m[1] ?? m[2] ?? m[3]) : null;
  const n = (word === null ? NaN : /^\d/.test(word) ? Number(word) : (COUNT_WORDS[word] ?? NaN)) + (m?.[4] ? 1 : 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A party above the online limit stated in a booking message (BR-07: 9+ gets the branch phone), or null. The model
 * sometimes answers "can I book for 20 people?" as an FAQ, or drops the 20 (live walkthrough, 2026-10-20).
 */
export function largePartyStated(raw: string): number | null {
  const t = foldDigits(raw).toLowerCase();
  const m = [...t.matchAll(PARTY_RE)].at(-1);
  const word = m ? (m[1] ?? m[2] ?? m[3]) : null;
  // "my 12 colleagues and I" is 13 (D-21 held-out LV-HOLD-009).
  const n = (word === null ? NaN : /^\d/.test(word) ? Number(word) : (COUNT_WORDS[word] ?? NaN)) + (m?.[4] ? 1 : 0);
  return n > RULES.onlinePartyMax && BOOKING_CUE_RE.test(t) ? n : null;
}

const MONTHS = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/;
const ANY_DAY = /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tonight|tomorrow|next|week|weekend)\b/;

const NOT_A_DATE = "(?!\\s+(?:birthday|anniversary|floor|time|row|year|place|wedding|edition|street|avenue|cross|main|sector|block|phase|of us)\\b)";
const RELATIVE = /\b(?:after|before|not|except|instead|other than|apart from|nahi)\b/;

/**
 * The day number when the text names exactly one day of the month in a date phrase ("on the 28th", "the 3rd") and no
 * month, weekday or relative wording, else null. Any other ordinal ("my daughter's 18th birthday", "1st floor") is not
 * a date (D-21 audit).
 */
export function plainDayOfMonth(raw: string): number | null {
  const t = foldDigits(raw).toLowerCase();
  const ordinals = [...t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\b/g)];
  const dated = [...t.matchAll(new RegExp(`(?:\\bon\\s+(?:the\\s+)?|\\bthe\\s+)(\\d{1,2})(?:st|nd|rd|th)\\b${NOT_A_DATE}`, "g"))].map((m) => Number(m[1]));
  if (ordinals.length !== 1 || dated.length !== 1 || dated[0] < 1 || dated[0] > 31 || MONTHS.test(t) || ANY_DAY.test(t) || RELATIVE.test(t)) return null;
  return dated[0];
}

/** The first date from today (inclusive) within the horizon with this day number: rule 2's reading of "the 28th". */
function dayOfMonthDate(now: number, zone: string, day: number): string | null {
  const today = todayLocal(now, zone);
  for (let i = 0; i <= 31; i++) {
    const d = addLocalDays(today, i, zone);
    if (Number(d.slice(8, 10)) === day) return d;
  }
  return null;
}

/** Apply the D-17 checks to a model turn. Returns the corrected turn and the trace entries for what changed. */
export function guardExtraction(turn: Turn, text: string, now: number, zone: string): { turn: Turn; trace: TraceEntry[] } {
  const trace: TraceEntry[] = [];
  let b = turn.booking;
  // A booking message with one unambiguous clock time the model left out: code fills it in.
  const clock = turn.intent === "booking" && b.time === null && b.ambiguity?.field !== "time" ? statedClockTime(text) : null;
  if (clock) {
    b = { ...b, time: clock };
    trace.push({ action: "correct_field", field: "time", reason: "stated" });
  }
  if (b.time !== null && !timeStated(b.time, text)) {
    b = { ...b, time: null };
    trace.push({ action: "ignore_field", field: "time", reason: "not_stated" });
  }
  if (b.ambiguity?.field === "time") {
    const kept = b.ambiguity.candidates.filter((c) => /^\d{2}:\d{2}$/.test(c) && timeStated(c, text));
    if (kept.length < b.ambiguity.candidates.length) {
      b = { ...b, ambiguity: kept.length >= 2 ? { field: "time", candidates: kept } : null };
      trace.push({ action: "ignore_field", field: "time", reason: "not_stated" });
    }
  }
  // BR-07, enforced: a booking message for 9+ people always gets the large-party reply, whatever the model returned.
  const large = largePartyStated(text);
  let intent = turn.intent;
  if (large !== null && intent !== "recommend" && intent !== "menu" && (intent !== "booking" || b.partySize !== large)) {
    if (intent !== "booking") b = { ...b, ambiguity: null };
    intent = "booking";
    b = { ...b, partySize: large };
    trace.push({ action: "correct_field", field: "partySize", reason: "large_party" });
  }
  // A day of the month on its own (rule 2): code reads it the same way every time (D-17; D2 LV-BK-007 regressed on v5).
  const dom = intent === "booking" ? plainDayOfMonth(text) : null;
  const domDate = dom === null ? null : dayOfMonthDate(now, zone, dom);
  if (domDate && (b.date !== domDate || b.ambiguity?.field === "date")) {
    b = { ...b, date: domDate, ambiguity: b.ambiguity?.field === "date" ? null : b.ambiguity };
    trace.push({ action: "correct_field", field: "date", reason: "day_of_month" });
  }
  const wd = intent === "booking" ? plainWeekday(text) : null;
  if (wd !== null && wd !== weekdayOf(todayLocal(now, zone), zone)) {
    const date = weekdayDate(now, zone, wd);
    if (b.date !== date || b.ambiguity?.field === "date") {
      b = { ...b, date, ambiguity: b.ambiguity?.field === "date" ? null : b.ambiguity };
      trace.push({ action: "correct_field", field: "date", reason: "weekday" });
    }
  }
  if (intent !== turn.intent) return { turn: { ...turn, intent, booking: b, answer: null, citedFactIds: [], answerable: true }, trace };
  return { turn: b === turn.booking ? turn : { ...turn, booking: b }, trace };
}
