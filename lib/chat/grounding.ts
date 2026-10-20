import { canonicalSpans, NUMBER_WORDS, numberWordRe, phonesIn, pricesIn, timesIn, UNREADABLE_TIME_RE } from "@/lib/kb/canonical";
import type { Fact } from "@/lib/kb/facts";
import { bookingClaim, unsupportedBookingStateSentence } from "@/lib/chat/claims";
import { supersede } from "@/lib/chat/hours";

// Grounding check for FAQ prose (§5.7, D-02, D-10, D-15; AC-08). An answer is shown only if every checkable token is
// supported by the facts it cites; any failure gives the fixed fallback. Order:
//  1. at least one cited ID; every ID exists and was sent to the model this turn (D-02)
//  2. weekly hours superseded by a cited same-weekday exception (D-10)
//  3. times, prices and phones canonicalised on both sides (minutes, rupees, E.164)
//  4. dates ("27 Oct", "Tue 27 Oct", "October 27th", "27th", 27/10, ISO) must be in the cited facts or IDs
//  5. every other digit run must appear as a digit run in the cited facts
//  6. time and number words (noon, midnight, o'clock, half past, quarter past/to, two…twenty, thirty…ninety,
//     hundred) must appear in the cited facts
//  7. no booking claim (D-11); booking-state sentences only verbatim from a cited fact (D-15)
// Known limit (README): unsupported claims without numbers or booking words ("the dal is vegan") are not caught; the
// abstain rule and hand review of eval answers cover those.

export type GroundingFailure =
  | "no_citation"
  | "unknown_citation"
  | "not_sent"
  | "time"
  | "price"
  | "phone"
  | "date"
  | "digits"
  | "number_word"
  | "claim"
  | "booking_state";

export type GroundingResult = { ok: true; citedIds: string[] } | { ok: false; reason: GroundingFailure; detail: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORD = "(?:st|nd|rd|th)?";
const DATE_RES: { re: RegExp; parts: (m: RegExpMatchArray) => { month: number | null; day: number } }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, parts: (m) => ({ month: Number(m[2]), day: Number(m[3]) }) },
  { re: new RegExp(`\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s+(\\d{4}))?`, "gi"), parts: (m) => ({ month: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, day: Number(m[1]) }) },
  { re: new RegExp(`\\b${MONTH}\\s+(\\d{1,2})${ORD}\\b(?:,?\\s+(\\d{4}))?`, "gi"), parts: (m) => ({ month: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, day: Number(m[2]) }) },
  { re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, parts: (m) => ({ month: Number(m[2]), day: Number(m[1]) }) }, // Indian DD/MM
  { re: /\b(\d{1,2})(?:st|nd|rd|th)\b/gi, parts: (m) => ({ month: null, day: Number(m[1]) }) },
];

type DateSpan = { start: number; end: number; month: number | null; day: number };

/** Date mentions, earliest first, without overlaps (the first pattern to claim a span wins). */
export function dateSpans(text: string): DateSpan[] {
  const out: DateSpan[] = [];
  for (const { re, parts } of DATE_RES)
    for (const m of text.matchAll(re)) {
      const span = { start: m.index, end: m.index + m[0].length, ...parts(m) };
      if (!out.some((o) => o.start < span.end && span.start < o.end)) out.push(span);
    }
  return out.sort((a, b) => a.start - b.start);
}

const blank = (text: string, spans: { start: number; end: number }[]) => {
  let s = text;
  for (const sp of spans) s = s.slice(0, sp.start) + " ".repeat(sp.end - sp.start) + s.slice(sp.end);
  return s;
};
const digitRuns = (text: string) => text.match(/\d+/g) ?? [];

export type GroundingContext = {
  /** Every fact in this turn's snapshot (static and retrievable). */
  factsById: Map<string, Fact>;
  /** IDs of the facts sent to the model this turn: the static prefix plus the retrieved facts. */
  sentIds: Set<string>;
  zoneOf: (slug: string) => string;
};

export function checkGrounding(answer: string, citedFactIds: string[], ctx: GroundingContext): GroundingResult {
  const fail = (reason: GroundingFailure, detail: string): GroundingResult => ({ ok: false, reason, detail });
  if (citedFactIds.length === 0) return fail("no_citation", "no cited fact");
  const unknown = citedFactIds.find((id) => !ctx.factsById.has(id));
  if (unknown) return fail("unknown_citation", unknown);
  const unsent = citedFactIds.find((id) => !ctx.sentIds.has(id));
  if (unsent) return fail("not_sent", unsent);

  const text = answer.normalize("NFKC");
  // D-10 (review RT-1): a weekly fact that names an exception on a date the answer mentions is replaced by that
  // exception, and the weekly fact's "Except …" pointers never ground anything themselves.
  const mentioned = dateSpans(text);
  const cited = [
    ...new Set(
      supersede(citedFactIds, ctx.zoneOf).flatMap((id) => {
        const f = ctx.factsById.get(id)!;
        if (f.kind !== "hours") return [id];
        const named = [...f.text.matchAll(/see (exception:[a-z0-9-]+:\d{4}-(\d{2})-(\d{2}))/g)].filter((m) => mentioned.some((d) => d.day === Number(m[3]) && (d.month === null || d.month === Number(m[2]))));
        return named.length ? named.map((m) => m[1]).filter((x) => ctx.factsById.has(x)) : [id];
      }),
    ),
  ];
  const groundText = (id: string) => {
    const f = ctx.factsById.get(id)!;
    return (f.kind === "hours" ? f.text.replace(/ Except .+$/, "") : f.text).normalize("NFKC");
  };
  const factText = cited.map(groundText).join("\n");

  const factTimes = timesIn(factText);
  const factPrices = pricesIn(factText);
  const factPhones = phonesIn(factText);
  const spans = canonicalSpans(text);
  for (const s of spans) {
    if (s.kind === "time" && !factTimes.has(s.value as number)) return fail("time", text.slice(s.start, s.end));
    if (s.kind === "price" && !factPrices.has(s.value as number)) return fail("price", text.slice(s.start, s.end));
    if (s.kind === "phone" && !factPhones.has(s.value as string)) return fail("phone", text.slice(s.start, s.end));
  }

  const rest = blank(text, spans);
  const unreadable = UNREADABLE_TIME_RE.exec(rest);
  if (unreadable) return fail("time", unreadable[0]); // e.g. "7.30" with no am/pm (review RT-2)
  const dates = dateSpans(rest);
  const idText = cited.join(" ");
  const factDates = dateSpans(`${factText}\n${idText}`);
  for (const d of dates) {
    const ok = factDates.some((f) => f.day === d.day && (d.month === null || f.month === d.month));
    if (!ok) return fail("date", rest.slice(d.start, d.end));
  }

  const factDigits = new Set(digitRuns(factText));
  const stray = digitRuns(blank(rest, dates)).find((r) => !factDigits.has(r));
  if (stray) return fail("digits", stray);

  const word = NUMBER_WORDS.find((w) => numberWordRe(w).test(text) && !numberWordRe(w).test(factText));
  if (word) return fail("number_word", word);

  const claim = bookingClaim(text);
  if (claim) return fail("claim", claim);
  const state = unsupportedBookingStateSentence(text, cited.map((id) => ctx.factsById.get(id)!.text));
  if (state) return fail("booking_state", state);

  return { ok: true, citedIds: cited };
}
