import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { loadFactSource, renderKbFacts, renderStaticFacts, type Fact } from "@/lib/kb/facts";
import { bookingClaim, smalltalkShowable, unsupportedBookingStateSentence } from "@/lib/chat/claims";
import { checkGrounding, dateSpans, type GroundingContext } from "@/lib/chat/grounding";
import { isHoursOnly, renderHoursAnswer, supersede } from "@/lib/chat/hours";

const ROOT = path.resolve(__dirname, "../..");
const NOW = Date.parse("2026-10-16T14:05:00+05:30"); // the probe's clock
const zoneOf = () => "Asia/Kolkata";

let facts: Map<string, Fact>;
let ctx: GroundingContext;
beforeAll(() => {
  const db = openDb(":memory:");
  migrate(db, NOW);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now: NOW });
  const src = loadFactSource(db);
  const all = [...renderStaticFacts(src, NOW), ...renderKbFacts(src)];
  facts = new Map(all.map((f) => [f.id, f]));
  ctx = { factsById: facts, sentIds: new Set(all.map((f) => f.id)), zoneOf };
});
const ground = (answer: string, cited: string[], over: Partial<GroundingContext> = {}) => {
  const r = checkGrounding(answer, cited, { ...ctx, ...over });
  return r.ok ? "ok" : r.reason;
};

describe("booking-claim filter (D-11): the 18 tuning strings, both directions", () => {
  // From scripts/claims-rescore.mjs; the first two are real qwen3.5:4b probe answers.
  const mustFlag = [
    "Yes, we have tables available for two tonight at 9 PM.",
    "Yes, tables are available for 2 guests on Monday night at Gurugram from 7:00 PM to 11:00 PM.",
    "There's a table available at 8 PM.",
    "We can seat you at 7:30.",
    "Your table is reserved.",
    "I've booked it for you.",
    "Tables free tonight at Hauz Khas!",
    "Booking confirmed for 4.",
  ];
  const mustPass = [
    "The Mango Sorbet is available at all branches.",
    "Golf Course Road has free valet parking from 12:00 PM to 11:00 PM.",
    "Golf Course Road has a private room for up to 16 guests. Please call the branch to arrange it.",
    "We hold your table for 15 minutes after the booking time.",
    "We have vegan options in every section of the menu.",
    "Golf Course Road has a covered terrace; ask for it in the booking note.",
    "Yes, free Wi-Fi is available at both branches.",
    "Tables are booked for 90 minutes for 1 to 4 guests and 2 hours for 5 to 8 guests.",
    "Walk-ins are welcome when a table is free. We recommend booking for Friday and Saturday dinner.",
    "I cannot confirm if a table is free. Please call the branch.",
  ];
  it.each(mustFlag)("flags: %s", (s) => expect(bookingClaim(s)).not.toBeNull());
  it.each(mustPass)("passes: %s", (s) => expect(bookingClaim(s)).toBeNull());
  it("checks each sentence on its own", () => {
    expect(bookingClaim("We are open until 11 PM. Your booking is confirmed.")).toBe("Your booking is confirmed.");
  });
});

describe("grounding: review M1 (a)–(e) give the fallback, the correct facts pass (D-15)", () => {
  it("(a) a bare wrong price", () => {
    expect(ground("The butter chicken is 745.", ["menu:old-delhi-butter-chicken"])).toBe("digits");
    expect(ground("The Old Delhi Butter Chicken is ₹645.", ["menu:old-delhi-butter-chicken"])).toBe("ok");
    expect(ground("The butter chicken is Rs. 745.", ["menu:old-delhi-butter-chicken"])).toBe("price");
  });
  it("(b) a time word the fact doesn't contain", () => {
    expect(ground("Dinner is served until midnight.", ["hours:hauz-khas:fri"])).toBe("number_word");
    expect(ground("Dinner is served until 11:00 PM.", ["hours:hauz-khas:fri"])).toBe("ok");
    expect(ground("Dinner is served until eleven.", ["hours:hauz-khas:fri"])).toBe("number_word");
  });
  it("(c) a wrong date", () => {
    expect(ground("Golf Course Road is closed on 28 October.", ["exception:gurugram:2026-10-27"])).toBe("date");
    expect(ground("Golf Course Road is closed all day on 27 October for kitchen maintenance.", ["exception:gurugram:2026-10-27"])).toBe("ok");
    expect(ground("It is closed on Tue 27 Oct 2026.", ["exception:gurugram:2026-10-27"])).toBe("ok");
    expect(ground("It is closed on the 28th.", ["exception:gurugram:2026-10-27"])).toBe("date");
  });
  it("(d) a wrong duration", () => {
    expect(ground("We hold your table for 30 minutes.", ["faq:late-arrival"])).toBe("digits");
    expect(ground("We hold your table for 15 minutes after the booking time.", ["faq:late-arrival"])).toBe("ok");
  });
  it("(e) a wrong count", () => {
    expect(ground("The private room seats up to 20.", ["faq:private-dining"])).toBe("digits");
    expect(ground("Golf Course Road has a private room for up to 16 guests.", ["faq:private-dining"])).toBe("ok");
  });
});

describe("grounding: citations, canonical tokens and booking words", () => {
  it("needs a citation that exists and was sent this turn (D-02)", () => {
    expect(ground("Yes.", [])).toBe("no_citation");
    expect(ground("Yes.", ["faq:karaoke"])).toBe("unknown_citation");
    expect(ground("We accept cards, UPI and cash.", ["faq:payment"], { sentIds: new Set(["faq:wifi"]) })).toBe("not_sent");
    expect(ground("We accept cards, UPI and cash.", ["faq:payment"])).toBe("ok");
  });
  it("matches times, prices and phones in any spelling", () => {
    expect(ground("Valet runs from 12 PM to 11 pm.", ["faq:parking-gurugram"])).toBe("ok");
    expect(ground("Valet runs from 12:00 to 23:00.", ["faq:parking-gurugram"])).toBe("ok");
    expect(ground("Valet runs until 10 PM.", ["faq:parking-gurugram"])).toBe("time");
    expect(ground("Call +91 11 4155 0101.", ["branch:hauz-khas"])).toBe("ok");
    expect(ground("Call 011-4155-0101.", ["branch:hauz-khas"])).toBe("ok");
    expect(ground("Call +91 11 4155 0102.", ["branch:hauz-khas"])).toBe("phone");
    expect(ground("Cakeage is ₹ 300 per cake.", ["faq:celebration-cake"])).toBe("ok");
  });
  it("rejects claims and unsupported booking-state sentences in FAQ prose", () => {
    expect(ground("Walk-ins are welcome, and we have a table for you.", ["faq:walk-ins"])).toBe("claim");
    expect(ground("You can reserve the terrace.", ["faq:outdoor-seating"])).toBe("booking_state");
    expect(ground("The private room seats up to 16.", ["faq:private-dining"])).toBe("booking_state"); // paraphrase with "seats"
  });
  it("lets walk-in and late-arrival FAQ text through verbatim", () => {
    expect(ground("Walk-ins are welcome when a table is free. We recommend booking for Friday and Saturday dinner.", ["faq:walk-ins"])).toBe("ok");
    expect(ground("We hold your table for 15 minutes after the booking time. Call the branch if you'll be later than that.", ["faq:late-arrival"])).toBe("ok");
    expect(ground("Tables are booked for 90 minutes for 1 to 4 guests and 2 hours for 5 to 8 guests.", ["faq:sitting-time"])).toBe("ok");
  });
  it("allows digit runs and number words that the cited facts contain", () => {
    expect(ground("The parking is about a 3-minute walk away.", ["faq:parking-hauz-khas"])).toBe("ok");
    expect(ground("We have two branches.", ["restaurant:about"])).toBe("ok"); // "two-branch" in the fact
    expect(ground("It's open in the afternoon.", ["hours:hauz-khas:fri"])).toBe("ok"); // "afternoon" is not "noon"
  });
});

describe("dates are canonicalised (D-15)", () => {
  it("reads the common spellings", () => {
    const d = (s: string) => dateSpans(s).map(({ month, day }) => [month, day]);
    expect(d("27 Oct")).toEqual([[10, 27]]);
    expect(d("Tue 27 Oct 2026")).toEqual([[10, 27]]);
    expect(d("October 27th, 2026")).toEqual([[10, 27]]);
    expect(d("27th of October")).toEqual([[10, 27]]);
    expect(d("the 27th")).toEqual([[null, 27]]);
    expect(d("27/10")).toEqual([[10, 27]]);
    expect(d("2026-10-27")).toEqual([[10, 27]]);
    expect(d("may we book? in march")).toEqual([]);
  });
});

describe("hours answers are rendered from facts; exceptions win (D-10)", () => {
  it("supersedes weekly hours with a same-weekday exception only", () => {
    expect(supersede(["exception:hauz-khas:2026-10-22", "hours:hauz-khas:thu", "hours:hauz-khas:fri", "hours:gurugram:thu"], zoneOf)).toEqual([
      "exception:hauz-khas:2026-10-22",
      "hours:hauz-khas:fri",
      "hours:gurugram:thu",
    ]);
    expect(supersede(["hours:hauz-khas:thu", "hours:hauz-khas:thu"], zoneOf)).toEqual(["hours:hauz-khas:thu"]);
  });

  it("HF4: the probe's 'open for dinner on 22 Oct' becomes the exception's closed-for-dinner hours", () => {
    // qwen3.5:9b and 4b, evals/results/2026-10-19T14-49-11-215Z_probe.json
    const cited = ["exception:hauz-khas:2026-10-22", "hours:hauz-khas:thu"];
    expect(isHoursOnly(cited)).toBe(true);
    const r = renderHoursAnswer(cited, facts, zoneOf);
    expect(r).toEqual({
      text: "Special hours at Hauz Khas on Thu 22 Oct 2026: lunch 12:00 PM–3:30 PM; closed for dinner (Regular lunch; Closed for a private event).",
      factIds: ["exception:hauz-khas:2026-10-22"],
    });
    // Had the prose been checked instead, it would also fail: 7–11 PM is not in the exception.
    expect(ground("Hauz Khas is open for dinner on Thursday 22 October from 7:00 PM to 11:00 PM.", cited)).toBe("time");
  });

  it("HF4 variant citing only the weekly fact still shows the exception", () => {
    const r = renderHoursAnswer(["hours:hauz-khas:thu"], facts, zoneOf);
    expect(r.factIds).toEqual(["hours:hauz-khas:thu", "exception:hauz-khas:2026-10-22"]);
    expect(r.text).toBe(
      "Hauz Khas on Thursdays: lunch 12:00 PM–3:30 PM; dinner 7:00 PM–11:00 PM. Special hours on Thu 22 Oct 2026. Special hours at Hauz Khas on Thu 22 Oct 2026: lunch 12:00 PM–3:30 PM; closed for dinner (Regular lunch; Closed for a private event).",
    );
  });

  it("F04: the probe's false 'yes, open for Monday lunch' becomes the closed-for-lunch fact", () => {
    const cited = ["hours:gurugram:mon"];
    expect(renderHoursAnswer(cited, facts, zoneOf).text).toBe("Golf Course Road on Mondays: closed for lunch; dinner 7:00 PM–11:00 PM.");
    expect(ground("Yes, Golf Course Road is open for lunch on Monday from 12:00 PM to 3:30 PM.", cited)).toBe("time");
  });

  it("mixed answers keep prose but are grounded against the superseded facts", () => {
    expect(isHoursOnly(["menu:dal-ember", "hours:hauz-khas:thu"])).toBe(false);
    expect(ground("The Dal Ember is ₹445, and Hauz Khas serves dinner until 11:00 PM on Thursdays.", ["menu:dal-ember", "hours:hauz-khas:thu"])).toBe("ok");
    expect(ground("The Dal Ember is ₹445, and Hauz Khas serves dinner until 11:00 PM on Thursdays.", ["menu:dal-ember", "hours:hauz-khas:thu", "exception:hauz-khas:2026-10-22"])).toBe("time");
  });
});

describe("smalltalk and booking-state words (D-15)", () => {
  it("shows plain greetings only", () => {
    expect(smalltalkShowable("Hello! I can help with bookings, opening hours, our branches and the menu.")).toBe(false); // "bookings"
    expect(smalltalkShowable("Hello! How can I help you today?")).toBe(true);
    for (const s of ["You're all set!", "See you soon!", "We'll hold it for you.", "Thanks, we have 2 branches.", "Your reservation is confirmed."]) expect(smalltalkShowable(s), s).toBe(false);
  });
  it("accepts a booking-state sentence only verbatim from a cited fact", () => {
    const late = "We hold your table for 15 minutes after the booking time. Call the branch if you'll be later than that.";
    expect(unsupportedBookingStateSentence("we hold your table for 15 minutes after the booking time", [late])).toBeNull();
    expect(unsupportedBookingStateSentence("Your table is held for 15 minutes.", [late])).toBe("Your table is held for 15 minutes.");
    expect(unsupportedBookingStateSentence("Parking is free.", [late])).toBeNull();
  });
  it("does not count 'booking note' as a booking-state word (D-15 amendment, 2026-10-20; D2 LV-FAQ-006, LV-REG-008)", () => {
    const cake = "Yes, you can bring a celebration cake. There is a ₹300 cakeage charge per cake. Mention it in the booking note.";
    expect(unsupportedBookingStateSentence("Please mention it in the booking note.", [cake])).toBeNull();
    expect(unsupportedBookingStateSentence("Please mention this in your booking notes.", [cake])).toBeNull();
    // Every other state word keeps the word-for-word rule.
    expect(unsupportedBookingStateSentence("Add it to your booking note and we'll hold your table.", [cake])).toBe("Add it to your booking note and we'll hold your table.");
    expect(unsupportedBookingStateSentence("Mention it when booking.", [cake])).toBe("Mention it when booking.");
  });
  it("does not count venue seating phrases unless the sentence also speaks of availability (D-15 amendment; D2 LV-REG-008)", () => {
    const outdoor = "Golf Course Road has a covered terrace; ask for it in the booking note and we'll try to seat you there. Hauz Khas has indoor seating only.";
    expect(unsupportedBookingStateSentence("Yes, Golf Course Road has a covered terrace for outdoor seating.", [outdoor])).toBeNull();
    expect(unsupportedBookingStateSentence("Hauz Khas has indoor seating, and rooftop seating is not offered.", [outdoor])).toBeNull();
    for (const s of ["We have outdoor seating available for you tonight.", "Outdoor seating is free at 8 PM.", "We can seat you on the terrace.", "Terrace seats are available."])
      expect(unsupportedBookingStateSentence(s, [outdoor]), s).toBe(s);
  });
});
