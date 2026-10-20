import { findPhones } from "@/lib/phone";

// Masking (§5.7 step 3, D-15). Every string the server receives is masked once at the start of runTurn, whatever its
// role, so retrieval, the prompt, the trace and chat_turns only ever see masked text:
// - emails → "[email]"
// - phone numbers libphonenumber finds (`/max`, India default; also foreign numbers) → "[phone]"
// - any other run of 8+ digits with separators (typo'd or partial numbers, card numbers) → "[phone]",
//   except ISO dates (2026-10-22) and clock times (19:30), which booking needs
// `<` and `>` are neutralised to ‹ › so no input can open or close a prompt tag (D-15 fence).

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// ISO dates, clock times and day-month-year dates with one separator (22-10-2026, 22.10.2026, 22 10 2026): booking
// needs them, and the 8+ digit fallback would otherwise mask them (review MB-5).
const PROTECT_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|(?<!\d)\d{1,2}:\d{2}(?!\d)|(?<!\d)(?:0?[1-9]|[12]\d|3[01])([-. /])(?:0?[1-9]|1[0-2])\1(?:20)?\d{2}(?!\d)/g;
const DIGIT_RUN_RE = /\+?\d(?:[\d\s().,_-]*\d)?/g; // commas and underscores separate digits too (review MB-6)
const HOLD = "\uE000"; // private-use placeholder: not a digit, never part of a phone match

/** Every Unicode decimal digit (Devanagari ९, Bengali ৯, fullwidth ９ …) as its ASCII digit, one character each (review MB-6). */
export function foldDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (d) => {
    if (d >= "0" && d <= "9") return d;
    // Unicode encodes each script's digits as a contiguous 0–9 run (some runs are back to back, like the maths digits),
    // so the value is the distance from the start of the run, modulo 10.
    const cp = d.codePointAt(0)!;
    let start = cp;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}

export function neutralise(s: string): string {
  return s.replace(/</g, "‹").replace(/>/g, "›");
}

/** Mask emails and phone-like digit runs, then neutralise angle brackets. Idempotent. */
export function maskText(input: string): string {
  const held: string[] = [];
  let s = foldDigits(input).replace(EMAIL_RE, "[email]").replace(PROTECT_RE, (m) => {
    held.push(m);
    return HOLD;
  });
  const phones = findPhones(s);
  for (const p of [...phones].sort((a, b) => b.start - a.start)) s = `${s.slice(0, p.start)}[phone]${s.slice(p.end)}`;
  s = s.replace(DIGIT_RUN_RE, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (digits < 8) return m;
    const lead = /^\s*/.exec(m)![0];
    const trail = /\s*$/.exec(m)![0];
    return `${lead}[phone]${trail}`;
  });
  let i = 0;
  s = s.replace(new RegExp(HOLD, "g"), () => held[i++]);
  return neutralise(s);
}

export type Message = { role: "guest" | "assistant"; content: string };

/** Mask every message, whatever its role (client-supplied assistant text is untrusted too). */
export function maskMessages<M extends Message>(messages: M[]): M[] {
  return messages.map((m) => ({ ...m, content: maskText(m.content) }));
}
