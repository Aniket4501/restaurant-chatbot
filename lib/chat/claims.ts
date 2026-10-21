import { NUMBER_WORDS, numberWordRe } from "@/lib/kb/canonical";

// Booking-claim and booking-state rules for any model prose shown to the guest (H6, INV-04).
// - D-11: split into sentences; skip hedged ones (when, if, not, cannot, …); reject a sentence that confirms a
//   booking ("I've booked", "booking confirmed") or claims availability ("tables are available", "we can seat you").
//   Patterns are the ones tuned on all 219 stored probe answers (scripts/claims-rescore.mjs): 6 real 4b claims
//   flagged, 0 of 99 qwen3.5:9b answers.
// - D-15: booking-state words (book*, reserv*, confirm*, table, seat, all set, see you, hold/held, expect you) make
//   smalltalk show the fixed greeting, and an FAQ sentence containing them must appear verbatim in a cited fact.
//   "Booking note" (a form field) and venue seating phrases ("outdoor seating") are not among them.
// Known limit (README): a claim inside a hedged sentence ("we have tables if you come at 9") is not caught; booking
// intents never show model prose, hours answers are rendered from facts (D-10), and the eval false_claim category
// covers the rest.

const CLAIM_RE =
  /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:booked|reserved|confirmed)\b|\b(?:your|the)\s+(?:table|booking|reservation|spot|slot)\s+(?:is|has been|was)\s+(?:now\s+)?(?:booked|reserved|confirmed|held|saved|secured)\b|\bbooking\s+(?:is\s+)?confirmed\b|\bwe have a table for you\b|\byou(?:'re| are)\s+(?:all\s+)?(?:booked|set)\b|\breservation\s+(?:is\s+)?(?:complete|done)\b/i;
// Review MB-4: "We've got …" is reachable now ("\s+" no longer precedes "'ve"), and space, spots, slots and
// availability count as availability nouns. "room" counts only in "there's room …", so "we have a private room" passes.
const AVAIL_RE =
  /\b(?:we|i)(?:\s+have|'ve(?:\s+got)?|\s+can\s+(?:offer|seat|fit|accommodate|get))\b[^.?!]{0,40}\b(?:tables?|seats?|slots?|spots?|space|availability)\b|\b(?:tables?|seats?|slots?|spots?)\b[^.?!]{0,30}\b(?:is|are)\s+(?:still\s+)?(?:available|free|open)\b|\bthere(?:\s+is|\s+are|'s)\s+(?:a\s+)?(?:tables?|space|room|seats?|spots?)\s+(?:available|free|for)\b|\bwe can (?:seat|fit|accommodate) you\b|\b(?:tables?|space|seats?|spots?)\s+(?:available|free)\s+(?:for|at|on|tonight|tomorrow)\b/i;
const HEDGE_RE = /\b(?:when|if|whether|unless|until|cannot|can't|can not|not|no|unable|never)\b/i;
const BOOKING_STATE_RE = /\b(?:book\w*|reserv\w*|confirm\w*|tables?|seats?|seated|seating|all set|see you|hold|holds|holding|held|expect you|slots?|spots?)\b/i;
// Smalltalk is stricter (review MB-3/MB-4): it has no facts to ground against, so it may not mention space, rooms,
// availability, money or any number at all.
const SMALLTALK_STATE_RE = /\b(?:space|room|availability|available|rupees?|rs)\b|₹/i;

/** Curly apostrophes read as straight ones, so "you’re" can't slip past a pattern (review MB-4). */
const fold = (s: string) => s.replace(/[’‘]/g, "'");

/** Sentences as the D-11 filter sees them. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const isClaim = (raw: string) => {
  const s = fold(raw);
  return !HEDGE_RE.test(s) && (CLAIM_RE.test(s) || AVAIL_RE.test(s));
};

/** The first sentence that confirms a booking or claims availability, or null (D-11). */
export function bookingClaim(text: string): string | null {
  return sentences(text).find(isClaim) ?? null;
}

// D-15 amendments (approved by the user, 2026-10-20): "booking note" names a form field and "outdoor seating" (indoor,
// terrace, covered, rooftop) describes the venue, so neither is a booking-state word. Correct answers about cakes and
// the terrace were replaced by the fallback (D2 LV-FAQ-006, LV-REG-008). A sentence that uses one of these phrases and
// also speaks of availability ("outdoor seating available for you") still counts, since D-11 would not catch it.
const VENUE_RE = /\b(?:booking\s+notes?|(?:indoor|outdoor|terrace|covered|rooftop)\s+seating)\b/gi;
const AVAILABILITY_RE = /\b(?:available|availability|free|for you)\b/i;
export const hasBookingStateWords = (text: string) => {
  const t = fold(text);
  const rest = t.replace(VENUE_RE, " ");
  return BOOKING_STATE_RE.test(rest) || (rest !== t && AVAILABILITY_RE.test(rest));
};

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

/** Smalltalk prose is shown only with no digits or number words, no claim and no booking-state words (§5.7, D-15). */
export function smalltalkShowable(text: string): boolean {
  const t = fold(text);
  return !/\p{Nd}/u.test(t) && !bookingClaim(t) && !hasBookingStateWords(t) && !SMALLTALK_STATE_RE.test(t) && !NUMBER_WORDS.some((w) => numberWordRe(w).test(t)) && !/\bone\b/i.test(t) && !hypeClaims(t).length;
}

/**
 * Popularity, review and ranking claims (D-20; widened in D-26). The data has no sales figures, ratings or reviews; the
 * restaurant's own bestseller mark (or a staff FAQ or document that says so) is the only support for any of them.
 */
export const HYPE_RE =
  /\b(?:most popular|popular(?:ity)?|best[- ]?sell(?:er|ers|ing)|top[- ]sell(?:er|ers|ing)|(?:our|the) top (?:seller|pick|choice|dish)|favou?rites?|signature|chef'?s (?:special|choice|pick|recommendation|speciality|specialty)|chef recommends|award[- ]winning|famous|highly (?:rated|recommended)|top[- ]rated|best[- ]rated|well[- ]reviewed|(?:great|good|rave|glowing|excellent|amazing|five[- ]star) reviews?|reviews? (?:say|rave)|must[- ]try|crowd[- ]pleaser|speciality|specialty|house (?:special|classic|favou?rite)|everyone(?:'s)? (?:loves?|favou?rite|orders)|(?:much|well|most)[- ]loved|beloved|loved by|guests (?:love|adore|rave)|people (?:love|order)|customers love|go-to|most ordered|most requested|always a hit|sells out|iconic|(?:our|the) (?:best|top) (?:dish|dishes|seller))\b/gi;
// "We don't track what's popular", "I can't say which is the bestseller": an honest statement, not a claim.
// An honest statement about the data, not a claim: a negator that governs knowing or keeping it ("we don't track
// what's popular", "I can't say which is the bestseller", "no sales data", "it isn't marked as a bestseller"). Review
// of D-26: "which", "if", "any" and a bare "can't" ("you can't go wrong with our most popular dish") let claims through.
const HYPE_NEGATED = /\b(?:(?:don't|do not|doesn't|does not|didn't|can't|cannot|can not|unable to|never|won't)\s+(?:\w+\s+){0,2}(?:track|keep|know|say|tell|have|record|collect|claim|call|rank|measure|mark)|(?:hasn't|haven't|has not|have not|isn't|is not|aren't|are not|wasn't|not)\s+(?:\w+\s+){0,2}(?:marked|listed|known|ranked|rated|tracked|recorded)|no (?:sales|data|popularity|reviews?|ratings?|figures|records|way to (?:know|tell|say)))\b[^.!?]{0,40}$/i;

/** The popularity claims a reply makes (negated mentions left out), with where each starts. */
export function hypeMatches(text: string): { claim: string; index: number }[] {
  const t = fold(text);
  return [...t.matchAll(HYPE_RE)].filter((m) => !HYPE_NEGATED.test(t.slice(Math.max(0, m.index - 60), m.index).split(/[.!?]/).pop() ?? "")).map((m) => ({ claim: m[0], index: m.index }));
}

/** The popularity claims a reply makes (negated mentions left out), in order. */
export function hypeClaims(text: string): string[] {
  return hypeMatches(text).map((m) => m.claim);
}

/** True when the claim is about bestsellers ("bestseller", "best-selling"), the one kind a staff mark can support. */
export const isBestsellerClaim = (claim: string) => /best[- ]?sell/i.test(claim);
