import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { loadFactSource, renderStaticFacts } from "@/lib/kb/facts";
import { hoursAnswer, readHoursQuestion, type HoursAnswer } from "@/lib/chat/hours-card";
import type { Block, HoursFocus, HoursSection } from "@/lib/chat/types";

// D-27 regression tests: what an hours question is about, and the card built from the hours tables. Fixed clock:
// Fri 16 Oct 2026, 2:00 PM in Asia/Kolkata (the branches' zone), whatever zone the machine is in. Fixture exceptions:
// Hauz Khas Thu 22 Oct dinner closed (private event), Golf Course Road Tue 27 Oct closed all day, Hauz Khas Sat 31 Oct
// dinner to 11:30 PM. Golf Course Road has no lunch on Mondays. Assertions are on facts and structure, not wording.
const ROOT = path.resolve(__dirname, "../..");
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const ZONE = "Asia/Kolkata";
let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  migrate(db, NOW);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now: NOW });
});

const ask = (text: string, o: { focus?: HoursFocus | null; draftBranch?: string | null; now?: number } = {}): HoursAnswer => {
  const src = loadFactSource(db);
  const known = new Set(renderStaticFacts(src, o.now ?? NOW).map((f) => f.id));
  return hoursAnswer(readHoursQuestion(text, o.now ?? NOW, ZONE, src.branches, o), src, o.now ?? NOW, { known });
};
const card = (a: HoursAnswer): HoursSection[] => (a.blocks.find((b) => b.type === "hours") as Extract<Block, { type: "hours" }> | undefined)?.sections ?? [];
const row = (s: HoursSection, label: string) => s.rows.find((r) => r.label === label);
/** Everything the guest reads: the line and the card. */
const seen = (a: HoursAnswer) => [a.text, ...card(a).flatMap((s) => [s.branch, s.subtitle, s.special ?? "", ...s.rows.map((r) => `${r.label} ${r.value} ${r.note ?? ""}`)])].join("\n");

describe("D-27 opening-hours answers", () => {
  it("1. 'What are your timings?' with a known branch gives that branch's regular hours; with none, one question", () => {
    const known = ask("What are your timings?", { draftBranch: "gurugram" });
    expect(card(known).map((s) => s.branch)).toEqual(["Golf Course Road"]);
    expect(row(card(known)[0], "Lunch")).toMatchObject({ value: "12:00 PM – 3:30 PM", note: "Mondays: closed" });
    const unknown = ask("What are your timings?");
    expect(card(unknown)).toEqual([]);
    expect(unknown.asked).toBe(true);
    expect(unknown.text).toMatch(/Hauz Khas/);
    expect(unknown.text).toMatch(/Golf Course Road/);
    expect((unknown.blocks[0] as Extract<Block, { type: "quick_replies" }>).chips.map((c) => c.label)).toEqual(["Hauz Khas", "Golf Course Road", "Both branches"]);
  });

  it("2. 'What time does Hauz Khas open?': Hauz Khas only, its regular week", () => {
    const a = ask("What time does Hauz Khas open?");
    expect(card(a)).toEqual([{ branch: "Hauz Khas", subtitle: "Every day", special: null, rows: [{ label: "Lunch", value: "12:00 PM – 3:30 PM", closed: false, note: null }, { label: "Dinner", value: "7:00 PM – 11:00 PM", closed: false, note: null }], note: null }]);
    expect(seen(a)).not.toMatch(/Golf Course Road/);
  });

  it("3. 'What are your timings tomorrow?': that date (Sat 17 Oct); the branches agree, so no question", () => {
    const a = ask("What are your timings tomorrow?");
    expect(a.asked).toBe(false);
    expect(card(a)).toHaveLength(1);
    expect(card(a)[0]).toMatchObject({ subtitle: "Tomorrow, Sat 17 Oct", special: null });
    expect(a.cited.sort()).toEqual(["hours:gurugram:sat", "hours:hauz-khas:sat"]);
  });

  it("4. a special dinner closure replaces the usual dinner on that date only", () => {
    const a = ask("Are you open for dinner on 22 October at Hauz Khas?");
    const s = card(a)[0];
    expect(s).toMatchObject({ branch: "Hauz Khas", subtitle: "Thu 22 Oct", special: expect.any(String) });
    expect(row(s, "Lunch")).toMatchObject({ value: "12:00 PM – 3:30 PM", note: null }); // unchanged: no "Regular lunch" note
    expect(row(s, "Dinner")).toMatchObject({ value: "Closed", closed: true, note: "Closed for a private event" });
    expect(seen(a)).not.toMatch(/7:00 PM|11:00 PM/);
    expect(a.text).toMatch(/closed for dinner/i);
    // The exception belongs to Hauz Khas: Golf Course Road keeps its usual dinner that day.
    expect(row(card(ask("Is Golf Course Road open for dinner on 22 October?"))[0], "Dinner")).toMatchObject({ value: "7:00 PM – 11:00 PM", closed: false });
  });

  it("5. extended dinner hours show the extension, with its note", () => {
    const s = card(ask("What are the hours at Hauz Khas on 31 October?"))[0];
    expect(row(s, "Dinner")).toMatchObject({ value: "7:00 PM – 11:30 PM", note: "Extended dinner hours" });
    expect(s.special).not.toBeNull();
  });

  it("6. a branch closed all day reads as closed, with no usual hours", () => {
    const a = ask("Is Golf Course Road open on 27 October?");
    expect(card(a)[0].rows).toEqual([{ label: "All day", value: "Closed", closed: true, note: "Closed all day for kitchen maintenance" }]);
    expect(a.text).toMatch(/closed all day/i);
    expect(seen(a)).not.toMatch(/12:00 PM|7:00 PM/);
  });

  it("7. 'What about Golf Course Road?' after Hauz Khas switches branch and keeps the date", () => {
    const first = ask("What are your timings tomorrow at Hauz Khas?");
    const next = ask("What about Golf Course Road?", { focus: first.focus });
    expect(card(next).map((s) => [s.branch, s.subtitle])).toEqual([["Golf Course Road", "Tomorrow, Sat 17 Oct"]]);
    expect(seen(next)).not.toMatch(/Hauz Khas/);
  });

  it("8. both branches: a compact section each, no special dates", () => {
    const a = ask("What are the opening hours of both branches?");
    expect(card(a).map((s) => s.branch)).toEqual(["Hauz Khas", "Golf Course Road"]);
    expect(seen(a)).not.toMatch(/22 Oct|27 Oct|31 Oct|private event|maintenance|Extended/);
  });

  it("9. missing or conflicting hours: no guess", () => {
    db.prepare("DELETE FROM service_hours WHERE branch_id = (SELECT id FROM branches WHERE slug = 'gurugram')").run();
    const missing = ask("What time does Golf Course Road open?");
    expect(card(missing)).toEqual([]);
    expect(missing.text).toMatch(/can't confirm/);
    expect(missing.text).toContain("+91 124 455 0202");
    // Special hours that contradict each other: the schema allows one whole-day entry and one per service, so a
    // whole-day closure can sit next to lunch opening hours on the same date. Neither is picked.
    const hk = (db.prepare("SELECT id FROM branches WHERE slug = 'hauz-khas'").get() as { id: number }).id;
    db.prepare("INSERT INTO hours_exceptions (branch_id, date, service, is_closed, opens, closes, note) VALUES (?, '2026-10-22', NULL, 1, NULL, NULL, 'Closed all day')").run(hk);
    const conflict = ask("What are the hours at Hauz Khas on 22 October?");
    expect(row(card(conflict)[0], "Lunch")).toMatchObject({ value: "Not confirmed", closed: false, note: expect.stringMatching(/check with the branch/) });
    expect(row(card(conflict)[0], "Dinner")).toMatchObject({ value: "Closed", closed: true }); // both entries agree
    expect(conflict.text).toMatch(/check with Hauz Khas/);
    expect(conflict.text).not.toMatch(/closed all day/i);
  });

  it("10. follow-ups keep the branch for a new date, and the date for a new branch", () => {
    const hk = ask("What time does Hauz Khas open?");
    const date = ask("And on 22 October?", { focus: hk.focus });
    expect(card(date).map((s) => [s.branch, s.subtitle])).toEqual([["Hauz Khas", "Thu 22 Oct"]]);
    expect(row(card(date)[0], "Dinner")?.closed).toBe(true);
    // A new hours question names its own day: the old date is not carried into it.
    expect(card(ask("What are your opening hours?", { focus: date.focus }))[0].subtitle).toBe("Every day");
  });

  it("11. long notes and every row stay structured (the UI wraps them; see the E2E mobile check)", () => {
    db.prepare("UPDATE hours_exceptions SET note = ? WHERE date = '2026-10-22'").run("Closed for a private event booked by a large wedding party; the bar stays open for residents of the neighbouring hotel only");
    const s = card(ask("Hauz Khas on 22 October?"))[0];
    expect(row(s, "Dinner")?.note).toMatch(/^Closed for a private event booked/);
    expect(s.rows.every((r) => typeof r.value === "string" && r.value.length <= 24)).toBe(true);
  });

  it("12. unrelated special dates never appear: today, tomorrow, a weekday, regular hours", () => {
    for (const q of ["Are you open tonight at Golf Course Road?", "What are your timings tomorrow at Hauz Khas?", "What time does Hauz Khas open?", "Is Golf Course Road open on Mondays?", "Are you open right now?"]) {
      const a = ask(q);
      expect(seen(a), q).not.toMatch(/22 Oct|27 Oct|31 Oct|private event|maintenance|Extended|Regular lunch/);
      expect(a.cited.some((id) => id.startsWith("exception:")), q).toBe(false);
    }
  });

  it("answers several days asked together, and notes a coming special day for a weekday in general", () => {
    // "On Tuesday" is the coming Tuesday (20 Oct), not every Tuesday: the 27 Oct closure isn't that day.
    const two = ask("Is Golf Course Road open tomorrow and on Tuesday?");
    expect(card(two).map((s) => s.subtitle)).toEqual(["Tomorrow, Sat 17 Oct", "Tue 20 Oct"]);
    expect(seen(two)).not.toMatch(/27 Oct|maintenance/);
    const special = ask("Are you open on 22 October and 31 October at Hauz Khas?");
    expect(card(special).map((s) => s.special !== null)).toEqual([true, true]);
    // "On Saturdays": the usual Saturday, then the coming Saturday that differs, for that branch only.
    const saturdays = card(ask("What are your hours on Saturdays at Hauz Khas?"))[0];
    expect(saturdays).toMatchObject({ subtitle: "Saturdays", note: "Special hours on Sat 31 Oct: dinner 7:00 PM – 11:30 PM (Extended dinner hours)." });
    expect(card(ask("What are your hours on Saturdays at Golf Course Road?"))[0].note).toBeNull();
    expect(card(ask("Is Golf Course Road open on Tuesdays?"))[0].note).toBe("Special hours on Tue 27 Oct: closed all day.");
  });

  it("reads today, tonight, now and a weekday in the branch's zone, from the clock passed in", () => {
    // 11:30 PM on Fri 16 Oct in Kolkata is 6 PM UTC: "today" is still the 16th there.
    const late = Date.parse("2026-10-16T23:30:00+05:30");
    expect(card(ask("Are you open today at Hauz Khas?", { now: late }))[0].subtitle).toBe("Today, Fri 16 Oct");
    expect(ask("Is Hauz Khas open right now?", { now: late }).text).toMatch(/closed right now/);
    expect(ask("Is Hauz Khas open right now?").text).toMatch(/^Yes, Hauz Khas is open right now/);
    expect(card(ask("Are you open on Tuesday at Golf Course Road?"))[0].subtitle).toBe("Tue 20 Oct");
    expect(ask("Is Golf Course Road open for lunch on Monday?").text).toMatch(/closed for lunch/);
  });

  it("never shows raw data: every value is a time range, Closed or Not confirmed, and the line repeats no times", () => {
    for (const q of ["What time does Hauz Khas open?", "Are you open for dinner on 22 October at Hauz Khas?", "What are the opening hours of both branches?", "Is Golf Course Road open on 27 October?"]) {
      const a = ask(q);
      for (const s of card(a)) for (const r of s.rows) expect(r.value, q).toMatch(/^(?:\d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M|Closed|Not confirmed)$/);
      expect(a.text, q).not.toMatch(/\d{1,2}:\d{2}|[{}[\]]|exception:|hours:/);
    }
  });
});
