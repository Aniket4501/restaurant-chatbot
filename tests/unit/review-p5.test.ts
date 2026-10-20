import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applySetField, mergeExtracted, type FieldCtx } from "@/lib/chat/draft";
import { bookingClaim, smalltalkShowable } from "@/lib/chat/claims";
import { checkGrounding, type GroundingContext } from "@/lib/chat/grounding";
import { submitOutcome } from "@/lib/chat/submit";
import { branchInfo } from "@/lib/chat/templates";
import { emptyDraft, type Draft } from "@/lib/chat/types";
import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { phonesIn, timesIn } from "@/lib/kb/canonical";
import { loadFactSource, renderKbFacts, renderStaticFacts } from "@/lib/kb/facts";
import { maskText } from "@/lib/llm/redact";
import type { BookingFields } from "@/lib/llm/schema";
import { claimIn, guestPii } from "@/evals/invariants";

// Regression tests for the Phase 5 implementation review of T-10…T-17 (docs/REVIEW.md, "Phase 5"). Each one failed
// before its fix.

const ROOT = path.resolve(__dirname, "../..");
const NOW = Date.parse("2026-10-16T14:05:00+05:30");
let ctx: GroundingContext;
beforeAll(() => {
  const db = openDb(":memory:");
  migrate(db, NOW);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now: NOW });
  const src = loadFactSource(db);
  const all = [...renderStaticFacts(src, NOW), ...renderKbFacts(src)];
  ctx = { factsById: new Map(all.map((f) => [f.id, f])), sentIds: new Set(all.map((f) => f.id)), zoneOf: () => "Asia/Kolkata" };
});
const ground = (answer: string, cited: string[]) => {
  const r = checkGrounding(answer, cited, ctx);
  return r.ok ? "ok" : r.reason;
};

describe("RT-1/MB-1: a weekly fact cannot ground a date it names as an exception", () => {
  it("grounds an exception date mentioned with a weekly fact against the exception (D-10)", () => {
    expect(ground("Yes, Hauz Khas is open for dinner on Thu 22 Oct from 7:00 PM to 11:00 PM, and the Dal Ember is ₹445.", ["hours:hauz-khas:thu", "menu:dal-ember"])).toBe("time");
    expect(ground("Golf Course Road is open for lunch on Tue 27 Oct from 12:00 PM to 3:30 PM, with free valet parking.", ["hours:gurugram:tue", "faq:parking-gurugram"])).toBe("time");
  });
  it("still accepts general weekday answers and the exception's own hours", () => {
    expect(ground("On Thursdays Hauz Khas serves dinner from 7:00 PM to 11:00 PM, and the Dal Ember is ₹445.", ["hours:hauz-khas:thu", "menu:dal-ember"])).toBe("ok");
    expect(ground("On Thu 22 Oct Hauz Khas serves lunch from 12:00 PM to 3:30 PM, and the Dal Ember is ₹445.", ["hours:hauz-khas:thu", "menu:dal-ember"])).toBe("ok");
  });
});

describe("RT-2/MB-2: dotted times and range starts are canonicalised; unreadable times fail", () => {
  it("reads '7.30 pm', '7–11 PM' and 'from 3 to 11 PM'", () => {
    expect(timesIn("7.30 pm")).toEqual(new Set([1170]));
    expect(timesIn("dinner 7–11 PM")).toEqual(new Set([1140, 1380]));
    expect(timesIn("from 3 to 11 PM")).toEqual(new Set([900, 1380]));
    expect(timesIn("12–3:30 PM")).toEqual(new Set([720, 930]));
  });
  it("rejects wrong dotted or range times, and times it can't read", () => {
    expect(ground("Dinner at Hauz Khas on Fridays starts at 7.30 pm, and the Dal Ember is ₹445.", ["hours:hauz-khas:fri", "menu:dal-ember"])).toBe("time");
    expect(ground("Dinner at Hauz Khas runs from 3 to 11 PM on Fridays.", ["hours:hauz-khas:fri", "menu:dal-ember"])).toBe("time");
    expect(ground("Dinner at Hauz Khas starts at 7.30 on Fridays.", ["hours:hauz-khas:fri", "menu:dal-ember"])).toBe("time");
    expect(ground("Dinner at Hauz Khas runs 7.00 pm to 11.00 pm on Fridays.", ["hours:hauz-khas:fri", "menu:dal-ember"])).toBe("ok");
    expect(ground("Dinner at Hauz Khas runs 7–11 PM on Fridays.", ["hours:hauz-khas:fri", "menu:dal-ember"])).toBe("ok");
  });
});

describe("RT-3: a phone fallback never maps a malformed number onto a real one", () => {
  it("canonicalises only 10 digits, optionally after 0, 91 or +91", () => {
    expect(phonesIn("+91 7 124 455 0202")).not.toContain("+911244550202");
    for (const s of ["Call +91 111 4155 0101.", "Call +1 11 4155 0101.", "Call 99 11 4155 0101."]) expect(ground(s, ["branch:hauz-khas"]), s).toBe("phone");
    expect(ground("Call 011 4155 0101.", ["branch:hauz-khas"])).toBe("ok");
  });
});

describe("MB-3/MB-4: claims and smalltalk", () => {
  it("smalltalk with number or time words gets the fixed greeting", () => {
    expect(smalltalkShowable("You're welcome! Hauz Khas serves dinner until eleven tonight.")).toBe(false);
    expect(smalltalkShowable("Most mains are about four hundred rupees.")).toBe(false);
    expect(smalltalkShowable("Thanks for stopping by!")).toBe(true);
  });
  it("catches 've got, curly apostrophes and space/room/spot availability claims", () => {
    for (const s of ["We've got availability tonight.", "Good news, there’s space for you tonight.", "You’re all booked.", "Lovely! There’s room for you this evening.", "We have space for you tonight.", "Your spot is saved for tonight."]) {
      expect(bookingClaim(s), s).not.toBeNull();
      expect(claimIn(s), `INV-04: ${s}`).not.toBeNull();
    }
    expect(smalltalkShowable("Lovely! Your spot is saved for tonight.")).toBe(false);
  });
});

describe("MB-5/MB-6: masking keeps typed dates and catches other phone spellings", () => {
  it("keeps DD-MM-YYYY style dates", () => {
    for (const s of ["table for 4 on 22-10-2026 at 8pm", "on 22.10.2026", "on 22 10 2026", "on 31/10/2026"]) expect(maskText(s), s).toBe(s);
    expect(guestPii(["table for 4 on 22-10-2026"])).toEqual([]);
  });
  it("masks phones written with commas, underscores or Indian-script digits", () => {
    expect(maskText("my number is 98765,43210")).toBe("my number is [phone]");
    expect(maskText("my number is 98765_43210")).toBe("my number is [phone]");
    expect(maskText("मेरा नंबर ९८७६५४३२१० है")).toBe("मेरा नंबर [phone] है");
    expect(guestPii(["मेरा नंबर ९८७६५४३२१० है"]).length).toBeGreaterThan(0);
  });
});

const HK = branchInfo({ slug: "hauz-khas", name: "Neem & Ember, Hauz Khas", address: "24 HKV", phone: "+911141550101", timezone: "Asia/Kolkata" });
const fctx: FieldCtx = { now: NOW, zone: "Asia/Kolkata", branches: [HK], allSlugs: new Set(["hauz-khas"]) };
const fields = (o: Partial<BookingFields>): BookingFields => ({ branch: null, date: null, time: null, timeWindow: null, partySize: null, ambiguity: null, ...o });
const picked = (o: Partial<Draft> = {}): Draft => ({ ...emptyDraft(), branch: "hauz-khas", date: "2026-10-17", time: "20:00", partySize: 4, selected: { startsAt: 1 }, ...o });

describe("TP-1/TP-3: the latest stated value wins", () => {
  it("a new meal without a time drops the old time and selection", () => {
    expect(mergeExtracted(picked(), fields({ timeWindow: "lunch" }), fctx).draft).toMatchObject({ time: null, timeWindow: "lunch", selected: null });
    expect(applySetField(picked(), "timeWindow", "lunch", fctx).draft).toMatchObject({ time: null, selected: null });
    expect(mergeExtracted(picked(), fields({ timeWindow: "dinner", time: "21:00" }), fctx).draft).toMatchObject({ time: "21:00", timeWindow: "dinner", selected: null });
  });
  it("a rejected party size, date or branch clears the old value and selection", () => {
    expect(mergeExtracted(picked(), fields({ partySize: 12 }), fctx).draft).toMatchObject({ partySize: null, selected: null });
    expect(mergeExtracted(picked(), fields({ date: "2026-11-30" }), fctx).draft).toMatchObject({ date: null, selected: null });
  });
});

describe("TP-4: a 409 with no alternatives doesn't promise times", () => {
  it("says to pick another date and gives the branch phone", () => {
    const b = { slug: "hauz-khas", name: "Neem & Ember, Hauz Khas", short: "Hauz Khas", phoneLabel: "+91 11 4155 0101" };
    for (const code of ["SLOT_TAKEN", "SLOT_UNAVAILABLE"]) {
      const o = submitOutcome({ status: 409, body: { error: { code, message: "x", reason: "closed", alternatives: [] } } }, { branch: b, branches: [b], date: "2026-10-17", partySize: 4 });
      expect(o.text, code).not.toMatch(/Here are/);
      expect(o.text, code).toContain("Hauz Khas on +91 11 4155 0101");
      expect(o.blocks).toEqual([]);
    }
  });
});
