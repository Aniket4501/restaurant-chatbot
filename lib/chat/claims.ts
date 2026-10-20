// Booking-claim and booking-state rules for any model prose shown to the guest (H6, INV-04).
// - D-11: split into sentences; skip hedged ones (when, if, not, cannot, …); reject a sentence that confirms a
//   booking ("I've booked", "booking confirmed") or claims availability ("tables are available", "we can seat you").
//   Patterns are the ones tuned on all 219 stored probe answers (scripts/claims-rescore.mjs): 6 real 4b claims
//   flagged, 0 of 99 qwen3.5:9b answers.
// - D-15: booking-state words (book*, reserv*, confirm*, table, seat, all set, see you, hold/held, expect you) make
//   smalltalk show the fixed greeting, and an FAQ sentence containing them must appear verbatim in a cited fact.
// Known limit (README): a claim inside a hedged sentence ("we have tables if you come at 9") is not caught; booking
// intents never show model prose, hours answers are rendered from facts (D-10), and the eval false_claim category
// covers the rest.

const CLAIM_RE =
  /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:booked|reserved|confirmed)\b|\b(?:your|the)\s+(?:table|booking|reservation)\s+(?:is|has been|was)\s+(?:now\s+)?(?:booked|reserved|confirmed|held)\b|\bbooking\s+(?:is\s+)?confirmed\b|\bwe have a table for you\b|\byou(?:'re| are)\s+(?:all\s+)?(?:booked|set)\b|\breservation\s+(?:is\s+)?(?:complete|done)\b/i;
const AVAIL_RE =
  /\b(?:we|i)\s+(?:have|'ve got|can\s+(?:offer|seat|fit|accommodate|get))\b[^.?!]{0,40}\b(?:tables?|seats?|slots?|availability)\b|\b(?:tables?|seats?|slots?)\b[^.?!]{0,30}\b(?:is|are)\s+(?:still\s+)?(?:available|free|open)\b|\bthere(?:\s+is|\s+are|'s)\s+(?:a\s+)?(?:tables?|space|room|seats?)\s+(?:available|free|for)\b|\bwe can (?:seat|fit|accommodate) you\b|\b(?:tables?|space|seats?)\s+(?:available|free)\s+(?:for|at|on|tonight|tomorrow)\b/i;
const HEDGE_RE = /\b(?:when|if|whether|unless|until|cannot|can't|can not|not|no|unable|never)\b/i;
const BOOKING_STATE_RE = /\b(?:book\w*|reserv\w*|confirm\w*|tables?|seats?|seated|seating|all set|see you|hold|holds|holding|held|expect you)\b/i;

/** Sentences as the D-11 filter sees them. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const isClaim = (s: string) => !HEDGE_RE.test(s) && (CLAIM_RE.test(s) || AVAIL_RE.test(s));

/** The first sentence that confirms a booking or claims availability, or null (D-11). */
export function bookingClaim(text: string): string | null {
  return sentences(text).find(isClaim) ?? null;
}

export const hasBookingStateWords = (text: string) => BOOKING_STATE_RE.test(text);

const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();

/**
 * FAQ prose (D-15): the first sentence with booking-state words that is not verbatim (ignoring case, spacing and the
 * final full stop) in one of the cited facts' text, or null. "We hold your table for 15 minutes…" passes when
 * faq:late-arrival is cited; "We hold your table for 30 minutes" does not.
 */
export function unsupportedBookingStateSentence(text: string, citedTexts: string[]): string | null {
  const facts = citedTexts.map(norm);
  return sentences(text).find((s) => hasBookingStateWords(s) && !facts.some((f) => f.includes(norm(s)))) ?? null;
}

/** Smalltalk prose is shown only with no digits, no claim and no booking-state words (§5.7, D-15). */
export function smalltalkShowable(text: string): boolean {
  return !/\d/.test(text) && !bookingClaim(text) && !hasBookingStateWords(text);
}
