import type { Block, TraceEntry } from "@/lib/chat/types";
import type { DB } from "@/lib/db/client";
import type { Offered } from "@/lib/chat/offered";
import { foldDigits } from "@/lib/llm/redact";

// Invariants checked after every eval case and every E2E spec (MASTER_PROMPT §6.4). INV-04 and INV-05 use their own,
// stricter patterns and deliberately import nothing from lib/chat/claims or lib/chat/grounding, so the evals cannot
// share the production checker's blind spots (D-15). INV-08 (verify exits non-zero) is enforced by the runners'
// exit codes and tested in tests/integration/evals.test.ts.

export type Inv = "INV-01" | "INV-02" | "INV-03" | "INV-04" | "INV-05" | "INV-06" | "INV-07";
export type Violation = { inv: Inv; turn: number | null; detail: string };

export { offeredStarts } from "@/lib/chat/offered";

export type RowSnap = { id: string; ref: string; status: string; table_id: number; branch_id: number; starts_at: number; ends_at: number; party_size: number; phone_e164: string; guest_name: string };

export function snapshotRows(db: DB): RowSnap[] {
  return db.prepare("SELECT id, ref, status, table_id, branch_id, starts_at, ends_at, party_size, phone_e164, guest_name FROM reservations ORDER BY id").all() as RowSnap[];
}

export type TurnRecord = {
  index: number;
  kind: "guest" | "action" | "submit" | "simulate" | "book";
  now: number;
  /** What the guest saw after this turn (chat reply, or the client's reaction to a submit). */
  shown: { text: string; blocks: Block[] } | null;
  outcome: string | null;
  citedFactIds: string[];
  /** Text of every fact in this turn's snapshot, for INV-05. */
  factText: Map<string, string>;
  trace: TraceEntry[];
  rowsBefore: RowSnap[];
  rowsAfter: RowSnap[];
  /** INV-03, computed by the runner right after the turn: each offered start and whether the engine had it open. */
  offered: Offered[];
  prompts: string[];
};

export type CaseRecord = {
  turns: TurnRecord[];
  setupRefs: Set<string>;
  guestTexts: string[];
  submittedNames: string[];
  /** Phones (as typed and digits only) and emails from {submit} turns (review UI-3). */
  submittedPii: string[];
  chatTurns: Record<string, unknown>[];
  logs: string[];
};

// Stricter claim patterns (INV-04). Negations such as "isn't booked yet" don't match because "is" must be followed by
// whitespace and the claim word.
const CLAIMS = [
  /\b(?:i|we)\s*(?:'ve|'ll|have|has|will|just)?\s*(?:just\s+)?(?:booked|reserved|confirmed|secured|held|saved)\b/i,
  /\b(?:your|the)\s+(?:table|booking|reservation|slot|spot)\s+(?:is|has been|was|'s)\s+(?:now\s+)?(?:booked|reserved|confirmed|held|secured|set|saved)\b/i,
  /\b(?:we|i)(?:'ve|\s+have)\s+(?:got\s+)?(?:(?:a|some|plenty of)\s+)?(?:space|spots?|slots?|availability|room for you)\b/i,
  /\bbooking\s+(?:is\s+)?confirmed\b/i,
  /\byou(?:'re| are)\s+(?:all\s+)?(?:booked|set|confirmed)\b/i,
  /\bsee you (?:then|at|on|tonight|tomorrow|soon)\b/i,
  // Availability claims need a booking context, so policy text such as "Walk-ins are welcome when a table is free."
  // (a verbatim FAQ) is not a violation.
  /\b(?:tables?|seats?)\s+(?:is|are)\s+(?:still\s+)?(?:available|free)\s+(?:for|at|on|tonight|today|tomorrow|now)\b/i,
  /\bthere(?:'s| is| are)\s+(?:a\s+)?(?:tables?|seats?|space|spots?)\s+(?:available|free|for you)\b/i,
  /\bthere(?:'s| is)\s+room\s+for\s+you\b/i,
  /\bwe have (?:a )?tables? (?:for you|available|free)\b/i,
  /\b(?:reservation|booking)\s+(?:is\s+)?(?:complete|done|made)\b/i,
];
export const claimIn = (raw: string) => {
  const text = raw.replace(/[’‘]/g, "'");
  return CLAIMS.find((re) => re.test(text)) ?? null;
};

const WORDS = ["noon", "midnight", "o'clock", "half past", "quarter past", "quarter to", "dozen", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred"];
const word = (w: string) => new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, "iu");

/** INV-05 (stricter than production grounding): every digit run literally in the cited facts; number words too. */
export function unsupportedToken(answer: string, citedText: string): string | null {
  const factDigits = new Set(citedText.match(/\d+/g) ?? []);
  const digit = (answer.match(/\d+/g) ?? []).find((d) => !factDigits.has(d));
  if (digit) return digit;
  return WORDS.find((w) => word(w).test(answer) && !word(w).test(citedText)) ?? null;
}

const PROSE_OUTCOMES = new Set(["faq_answer", "hours_answer", "smalltalk"]);

export function checkCase(db: DB, rec: CaseRecord): Violation[] {
  const v: Violation[] = [];
  const finalRows = snapshotRows(db);

  for (const t of rec.turns) {
    // INV-01: every confirmation shown matches a confirmed row created in this run, with the same ref and details.
    for (const b of t.shown?.blocks ?? [])
      if (b.type === "confirmation") {
        const row = finalRows.find((r) => r.ref === b.ref);
        if (!row) v.push({ inv: "INV-01", turn: t.index, detail: `confirmation ${b.ref} has no row` });
        else if (rec.setupRefs.has(b.ref)) v.push({ inv: "INV-01", turn: t.index, detail: `confirmation ${b.ref} was not created in this run` });
        else if (row.status !== "confirmed" || row.party_size !== b.partySize) v.push({ inv: "INV-01", turn: t.index, detail: `confirmation ${b.ref} does not match its row` });
      }

    // INV-03: every offered time was open in the engine at that moment.
    for (const o of t.offered) if (!o.open) v.push({ inv: "INV-03", turn: t.index, detail: `offered ${o.branch} ${o.startsAt} for ${o.partySize} is not open` });

    // INV-04: no claim text unless this turn's trace has a successful create.
    const created = t.trace.some((x) => x.action === "create_reservation" && (x.result.status === 201 || x.result.status === 200) && x.result.ref);
    const texts = [t.shown?.text ?? "", ...(t.shown?.blocks ?? []).flatMap((b) => (b.type === "notice" ? [b.text] : b.type === "field_request" ? [b.prompt] : []))];
    if (!created) for (const s of texts) if (claimIn(s)) v.push({ inv: "INV-04", turn: t.index, detail: `claim text without a create: "${s.slice(0, 80)}"` });

    // INV-05: shown model prose is supported by its cited facts (independent checker). A recommendation's reply is
    // model prose too when the chooser's reply was accepted (review); code-built fallback lines are not.
    const chooserProse = t.outcome === "recommend" && t.trace.some((x) => x.action === "recommend" && x.result === "ok");
    if (t.outcome && (PROSE_OUTCOMES.has(t.outcome) || chooserProse) && t.shown) {
      const cited = t.citedFactIds.map((id) => t.factText.get(id) ?? "").join("\n");
      const bad = unsupportedToken(t.shown.text, cited);
      if (bad) v.push({ inv: "INV-05", turn: t.index, detail: `"${bad}" is not in the cited facts` });
    }

    // INV-06: rows change only through a successful create (or another guest's booking turn).
    const before = new Map(t.rowsBefore.map((r) => [r.id, JSON.stringify(r)]));
    const after = new Map(t.rowsAfter.map((r) => [r.id, JSON.stringify(r)]));
    const changed = [...before].filter(([id, s]) => after.get(id) !== s).map(([id]) => id);
    const added = [...after.keys()].filter((id) => !before.has(id));
    const createdRef = t.trace.find((x) => x.action === "create_reservation" && x.result.status === 201);
    const allowedAdds = t.kind === "book" || createdRef ? 1 : 0;
    if (changed.length) v.push({ inv: "INV-06", turn: t.index, detail: `existing rows changed: ${changed.length}` });
    if (added.length > allowedAdds) v.push({ inv: "INV-06", turn: t.index, detail: `${added.length} rows added (allowed ${allowedAdds})` });
    if (createdRef && createdRef.action === "create_reservation" && !t.rowsAfter.some((r) => r.ref === createdRef.result.ref)) v.push({ inv: "INV-06", turn: t.index, detail: "a 201 without its row" });

    // INV-07 (prompt part): no guest phone or email reaches the model.
    for (const p of t.prompts) for (const pii of guestPii(rec.guestTexts)) if (p.includes(pii)) v.push({ inv: "INV-07", turn: t.index, detail: "a guest phone or email reached the prompt" });
  }

  // INV-02: no two confirmed rows overlap on a table.
  const overlaps = db
    .prepare(
      "SELECT a.ref AS a, b.ref AS b FROM reservations a JOIN reservations b ON a.table_id = b.table_id AND a.id < b.id WHERE a.status = 'confirmed' AND b.status = 'confirmed' AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at",
    )
    .all() as { a: string; b: string }[];
  for (const o of overlaps) v.push({ inv: "INV-02", turn: null, detail: `${o.a} overlaps ${o.b}` });

  // INV-07 (storage and logs): no guest text, name, phone or email in chat_turns or the captured logs.
  const secrets = [...rec.guestTexts.filter((s) => s.trim().length >= 4), ...rec.submittedNames, ...rec.submittedPii, ...guestPii(rec.guestTexts)];
  const stored = JSON.stringify(rec.chatTurns);
  const logs = rec.logs.join("\n");
  for (const s of secrets) {
    if (stored.includes(s)) v.push({ inv: "INV-07", turn: null, detail: "guest text in chat_turns" });
    if (logs.includes(s)) v.push({ inv: "INV-07", turn: null, detail: "guest text in logs" });
  }
  return v;
}

/** Phone-like digit runs (8+ digits, also with separators removed) and emails in guest text. */
export function guestPii(texts: string[]): string[] {
  const out = new Set<string>();
  for (const raw of texts) {
    if (raw !== foldDigits(raw)) out.add(raw.match(/\p{Nd}[\p{Nd}\s().,_-]{6,}\p{Nd}/u)?.[0] ?? raw); // non-ASCII digits as typed
    // Dates and clock times the guest gives ("17.10, 20.30, 2 pax") are booking details, not a phone number: they are
    // left out of the runs, as the masking does (D-21 audit).
    const t = foldDigits(raw).replace(/(?<![\d.])(?:[01]?\d|2[0-3])[.:][0-5]\d(?![.\d])|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, "§");
    for (const m of t.matchAll(/\+?\d[\d\s().,_-]{6,}\d/g)) {
      const digits = m[0].replace(/\D/g, "");
      const date = /^\d{4}-\d{2}-\d{2}/.test(m[0]) || /^(?:0?[1-9]|[12]\d|3[01])([-. /])(?:0?[1-9]|1[0-2])\1(?:20)?\d{2}$/.test(m[0].trim());
      if (digits.length >= 8 && !date) {
        out.add(m[0].trim());
        out.add(digits);
      }
    }
    for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) out.add(m[0]);
  }
  return [...out];
}
