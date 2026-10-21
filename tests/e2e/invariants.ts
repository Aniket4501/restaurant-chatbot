import fs from "node:fs";
import Database from "better-sqlite3";
import { loadFactSource, renderKbFacts, renderStaticFacts } from "@/lib/kb/facts";
import { claimIn, guestPii, unsupportedToken, type Violation } from "@/evals/invariants";
import { dayLabelLong, localDateOf, timeLabel } from "@/lib/time/tz";

// The §6.4 invariants after an E2E spec (D-12), from what the spec observed (network responses, rendered DOM) and what
// the server recorded (its database, the TEST_TRACE_PATH lines and its log). INV-04 is checked as D-12 defines it for
// E2E: claim text may appear only inside a confirmation card whose ref came from a 201/200 response in this test.

export type Observed = {
  reservationResponses: { status: number; ref: string | null; at: number }[];
  cancelResponses: { status: number; ref: string }[];
  renderedConfirmationRefs: string[];
  /** Each rendered card's text by reference, to compare its details with the saved row (FM-038). */
  renderedConfirmationText: Record<string, string>;
  /** Page text outside confirmation cards, collected at the end of the spec. */
  pageTextOutsideConfirmations: string;
  /** Strings the spec typed that must never be logged or reach a prompt (names, phones, emails, messages). */
  pii: string[];
};

type TraceLine = { text: string; outcome: string; citedFactIds: string[]; offered: { branch: string; startsAt: number; open: boolean }[]; maskedPrompt: { system: string; user: string } | null };

export function checkE2E(files: { db: string; trace: string; log: string; logOffset: number }, now: number, o: Observed): Violation[] {
  const v: Violation[] = [];
  const db = new Database(files.db, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare("SELECT r.ref, r.status, r.cancelled_at, r.starts_at, r.party_size, r.guest_name, b.name AS branch_name, b.timezone FROM reservations r JOIN branches b ON b.id = r.branch_id")
      .all() as { ref: string; status: string; cancelled_at: number | null; starts_at: number; party_size: number; guest_name: string; branch_name: string; timezone: string }[];
    const created = new Set(o.reservationResponses.filter((r) => (r.status === 201 || r.status === 200) && r.ref).map((r) => r.ref!));
    const cancelled = new Set(o.cancelResponses.filter((r) => r.status === 200).map((r) => r.ref));
    for (const ref of o.renderedConfirmationRefs) {
      const row = rows.find((r) => r.ref === ref);
      if (!created.has(ref)) v.push({ inv: "INV-01", turn: null, detail: `rendered ${ref} without a 201/200 in this test` });
      else if (!row || (row.status !== "confirmed" && !cancelled.has(ref))) v.push({ inv: "INV-01", turn: null, detail: `rendered ${ref} has no matching row` });
      else {
        // Failure-mode audit FM-038: the card must show the saved row's branch, date, time, party and name.
        const text = o.renderedConfirmationText[ref] ?? "";
        const want = [row.branch_name, dayLabelLong(localDateOf(row.starts_at, row.timezone), row.timezone), timeLabel(row.starts_at, row.timezone), String(row.party_size), row.guest_name];
        const missing = want.filter((w) => !text.includes(w));
        if (missing.length) v.push({ inv: "INV-01", turn: null, detail: `rendered ${ref} does not show its row's ${missing.length} detail(s)` });
      }
    }
    const overlaps = db
      .prepare("SELECT a.ref AS a, b.ref AS b FROM reservations a JOIN reservations b ON a.table_id = b.table_id AND a.id < b.id WHERE a.status = 'confirmed' AND b.status = 'confirmed' AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at")
      .all() as { a: string; b: string }[];
    for (const x of overlaps) v.push({ inv: "INV-02", turn: null, detail: `${x.a} overlaps ${x.b}` });
    for (const r of rows) {
      if (!created.has(r.ref)) v.push({ inv: "INV-06", turn: null, detail: `row ${r.ref} was not created by a 201 in this test` });
      if (r.status === "cancelled" && !cancelled.has(r.ref)) v.push({ inv: "INV-06", turn: null, detail: `row ${r.ref} cancelled without an admin cancel` });
    }

    const lines = fs.existsSync(files.trace) ? (fs.readFileSync(files.trace, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as TraceLine[]) : [];
    const src = loadFactSource(db as never);
    const facts = new Map([...renderStaticFacts(src, now), ...renderKbFacts(src)].map((f) => [f.id, f.text]));
    lines.forEach((l, i) => {
      for (const off of l.offered) if (!off.open) v.push({ inv: "INV-03", turn: i, detail: `offered ${off.branch} ${off.startsAt} was not open` });
      if (claimIn(l.text)) v.push({ inv: "INV-04", turn: i, detail: `claim in chat reply: "${l.text.slice(0, 80)}"` });
      if (["faq_answer", "hours_answer", "smalltalk"].includes(l.outcome)) {
        const bad = unsupportedToken(l.text, l.citedFactIds.map((id) => facts.get(id) ?? "").join("\n"));
        if (bad) v.push({ inv: "INV-05", turn: i, detail: `"${bad}" is not in the cited facts` });
      }
      const prompt = l.maskedPrompt ? `${l.maskedPrompt.system}\n${l.maskedPrompt.user}` : "";
      for (const p of guestPii(o.pii)) if (prompt.includes(p)) v.push({ inv: "INV-07", turn: i, detail: "a guest phone or email reached the prompt" });
    });
    if (claimIn(o.pageTextOutsideConfirmations)) v.push({ inv: "INV-04", turn: null, detail: "claim text outside a confirmation card" });

    const log = fs.existsSync(files.log) ? fs.readFileSync(files.log, "utf8").slice(files.logOffset) : "";
    const stored = JSON.stringify(db.prepare("SELECT * FROM chat_turns").all());
    for (const p of [...o.pii.filter((s) => s.trim().length >= 4), ...guestPii(o.pii)]) {
      if (log.includes(p)) v.push({ inv: "INV-07", turn: null, detail: "guest data in the server log" });
      if (p.trim().length >= 8 && stored.includes(p)) v.push({ inv: "INV-07", turn: null, detail: "guest data in chat_turns" });
    }
  } finally {
    db.close();
  }
  return v;
}
