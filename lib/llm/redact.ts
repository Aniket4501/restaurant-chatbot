import { findPhones } from "@/lib/phone";

// Masking (§5.7 step 3, D-15). Every string the server receives is masked once at the start of runTurn, whatever its
// role, so retrieval, the prompt, the trace and chat_turns only ever see masked text:
// - emails → "[email]"
// - phone numbers libphonenumber finds (`/max`, India default; also foreign numbers) → "[phone]"
// - any other run of 8+ digits with separators (typo'd or partial numbers, card numbers) → "[phone]",
//   except ISO dates (2026-10-22) and clock times (19:30), which booking needs
// `<` and `>` are neutralised to ‹ › so no input can open or close a prompt tag (D-15 fence).

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PROTECT_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|(?<!\d)\d{1,2}:\d{2}(?!\d)/g; // also inside 2026-10-22T19:30
const DIGIT_RUN_RE = /\+?\d(?:[\d\s().-]*\d)?/g;
const HOLD = "\uE000"; // private-use placeholder: not a digit, never part of a phone match

export function neutralise(s: string): string {
  return s.replace(/</g, "‹").replace(/>/g, "›");
}

/** Mask emails and phone-like digit runs, then neutralise angle brackets. Idempotent. */
export function maskText(input: string): string {
  const held: string[] = [];
  let s = input.replace(EMAIL_RE, "[email]").replace(PROTECT_RE, (m) => {
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
