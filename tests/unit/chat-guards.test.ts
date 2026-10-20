import { describe, expect, it } from "vitest";
import { guardExtraction, largePartyStated, plainDayOfMonth, plainWeekday, timeStated } from "@/lib/chat/guards";
import { nullBooking } from "@/lib/llm/fake";
import type { Turn } from "@/lib/llm/schema";
import { weekdayDate } from "@/lib/time/calendar";

// D-17: deterministic checks on the model's extracted booking fields, applied before the merge.
const NOW = Date.parse("2026-10-16T14:00:00+05:30"); // Fri 16 Oct 2026, 2:00 PM IST
const ZONE = "Asia/Kolkata";
const booking = (o: Partial<Turn["booking"]>, intent: Turn["intent"] = "booking"): Turn => ({ intent, booking: { ...nullBooking(), ...o }, prefs: null, answer: null, citedFactIds: [], answerable: true });

describe("timeStated: the model's hour must be a clock time in the guest's message", () => {
  it.each([
    ["table at 8", "20:00"],
    ["8pm please", "20:00"],
    ["19:30 works", "19:30"],
    ["around seven", "19:00"],
    ["half past seven", "19:30"],
    ["at noon", "12:00"],
    ["midday works", "12:00"],
    ["quarter to nine", "20:45"],
    ["at ８pm", "20:00"],
    ["can we do nineish instead?", "21:00"],
    ["8-ish is fine", "20:00"],
    ["eight thirty", "20:30"],
    ["nineteen hundred hours", "19:00"],
    ["half 8 please", "20:30"],
    ["1930 hrs for 2", "19:30"],
    ["Book this coming Saturday 8pm for 2 at Golf Course Road", "20:00"],
    ["4 of us, saturday 1pm, golf course road", "13:00"],
    ["I'd like to book for 7 on the 28th at 7", "19:00"],
    ["could we get a table for six at hauz khas on thursday around 8:30?", "20:30"],
    ["Is there space for 2 tonight around 9?", "21:00"],
    ["Book me in for one person at 12:30 on Sunday", "12:30"],
    ["Book Hauz Khas for 8 people on 29 October at 1 pm", "13:00"],
    ["Reserve a table for 3 at 7:30 pm on Wednesday", "19:30"],
  ])("keeps %s → %s", (text, time) => expect(timeStated(time, text)).toBe(true));

  it.each([
    ["actually make it lunch for 2 instead", "12:00"], // review (high): a party size is not a clock time
    ["Can I book for two this Sunday evening at the Gurugram one?", "19:00"],
    ["lunch for 6 on the 24th", "12:00"],
    ["table for 4 on 2 November, dinner", "19:00"],
    ["actually make it lunch instead", "12:00"], // D2 LV-CONF-001
    ["same time works", "20:00"],
    ["for 3 at 7:30", "20:00"], // the guest said 7, not 8
    ["up to eight people at Hauz Khas", "20:00"],
    ["we are 7 people, dinner", "19:00"],
    ["call me on [phone]", "20:00"],
  ])("drops %s → %s", (text, time) => expect(timeStated(time, text)).toBe(false));
});

describe("plainWeekday: exactly one weekday and no other date words", () => {
  it.each([
    ["Is there a table for 2 on Monday night in Gurugram", 1],
    ["book a table for 2 at Golf Course Road this Saturday at 7pm", 6],
    ["Could I get a table for 3 on Wednesday evening?", 3],
    ["Book this coming Saturday 8pm for 2", 6],
    ["Can I book for two this Sunday evening at the Gurugram one?", 0],
  ])("%s → %i", (text, wd) => expect(plainWeekday(text)).toBe(wd));

  it.each(["next Monday for 4", "Monday 26th please", "Saturday or Sunday", "this weekend, Saturday", "Monday next week", "Sunday 25 October", "every Sunday", "tomorrow, Saturday", "Sundays are busy", "dinner on the 3rd", "Saturday 24/10"])(
    "%s → null",
    (text) => expect(plainWeekday(text)).toBeNull(),
  );
});

describe("weekdayDate", () => {
  it("is the first date after today with that weekday, as in the prompt's Weekdays list", () => {
    expect(weekdayDate(NOW, ZONE, 1)).toBe("2026-10-19");
    expect(weekdayDate(NOW, ZONE, 6)).toBe("2026-10-17");
    expect(weekdayDate(NOW, ZONE, 5)).toBe("2026-10-23");
  });
});

describe("guardExtraction (D-17)", () => {
  it("replaces a misread weekday date and records it (D2 LV-CLAIM-001: Monday read as Tue 20 Oct)", () => {
    const r = guardExtraction(booking({ branch: "gurugram", date: "2026-10-20", partySize: 2 }), "Is there a table for 2 on Monday night in Gurugram", NOW, ZONE);
    expect(r.turn.booking.date).toBe("2026-10-19");
    expect(r.trace).toEqual([{ action: "correct_field", field: "date", reason: "weekday" }]);
  });

  it("fills a missing weekday date and replaces a weekday ambiguity", () => {
    expect(guardExtraction(booking({ partySize: 2 }), "dinner on Sunday for two", NOW, ZONE).turn.booking.date).toBe("2026-10-18");
    const r = guardExtraction(booking({ ambiguity: { field: "date", candidates: ["2026-10-17", "2026-10-24"] } }), "this Saturday please", NOW, ZONE);
    expect(r.turn.booking).toMatchObject({ date: "2026-10-17", ambiguity: null });
  });

  it("leaves today's weekday, 'next' weekdays and non-booking intents to the model", () => {
    expect(guardExtraction(booking({ date: "2026-10-16" }), "this Friday at 8", NOW, ZONE).turn.booking.date).toBe("2026-10-16");
    expect(guardExtraction(booking({ date: "2026-10-26" }), "next Monday for 4", NOW, ZONE).turn.booking.date).toBe("2026-10-26");
    expect(guardExtraction(booking({ date: "2026-10-20" }, "faq"), "are you open on Monday?", NOW, ZONE).turn.booking.date).toBe("2026-10-20");
  });

  it("drops a time the guest did not state, and time ambiguity candidates likewise", () => {
    const r = guardExtraction(booking({ time: "12:00", timeWindow: "lunch", partySize: 2 }), "actually make it lunch for 2 instead", NOW, ZONE);
    expect(r.turn.booking).toMatchObject({ time: null, timeWindow: "lunch", partySize: 2 });
    expect(r.trace).toEqual([{ action: "ignore_field", field: "time", reason: "not_stated" }]);
    const a = guardExtraction(booking({ timeWindow: "lunch", ambiguity: { field: "time", candidates: ["12:00", "13:00"] } }), "actually make it lunch instead", NOW, ZONE);
    expect(a.turn.booking.ambiguity).toBeNull();
    const k = guardExtraction(booking({ ambiguity: { field: "time", candidates: ["19:00", "19:30", "20:00"] } }), "around 7 or 7:30?", NOW, ZONE);
    expect(k.turn.booking.ambiguity).toEqual({ field: "time", candidates: ["19:00", "19:30"] });
  });

  it("keeps a stated time untouched and records nothing", () => {
    const r = guardExtraction(booking({ branch: "gurugram", date: "2026-10-17", time: "19:30", partySize: 2 }), "table for 2 at Golf Course Road tomorrow at 7:30pm", NOW, ZONE);
    expect(r.trace).toEqual([]);
    expect(r.turn.booking.time).toBe("19:30");
  });
});

describe("large parties (BR-07, enforced in code; live walkthrough 2026-10-20)", () => {
  it.each([
    ["Can I book a table for 20 people tomorrow?", 20],
    ["we'd like to reserve for a party of 12 on Saturday", 12],
    ["table for 15 guests at Hauz Khas", 15],
    ["can 10 of us come for dinner?", 10],
  ])("%s → %i", (text, n) => expect(largePartyStated(text)).toBe(n));
  it.each(["table for 8 people", "Can you seat a large group?", "we have 20 people in our office", "for 2 people at 8", "Book for 4 guests on the 20th"])("%s → null", (text) => expect(largePartyStated(text)).toBeNull());

  it("turns an FAQ answer to 'book for 20 people' into the large-party booking path", () => {
    const faq: Turn = { intent: "faq", booking: nullBooking(), prefs: null, answer: "For groups of 9 or more guests, please call the branch directly.", citedFactIds: ["faq:large-groups"], answerable: true };
    const r = guardExtraction(faq, "Can I book a table for 20 people tomorrow?", NOW, ZONE);
    expect(r.turn).toMatchObject({ intent: "booking", answer: null, citedFactIds: [], booking: { partySize: 20 } });
    expect(r.trace).toContainEqual({ action: "correct_field", field: "partySize", reason: "large_party" });
  });
  it("fills a dropped large party and leaves a correct one alone", () => {
    expect(guardExtraction(booking({ date: "2026-10-17" }), "Can I book a table for 20 people tomorrow?", NOW, ZONE).turn.booking.partySize).toBe(20);
    expect(guardExtraction(booking({ partySize: 12 }), "table for 12 people at Hauz Khas", NOW, ZONE).trace).toEqual([]);
  });
});

describe("plain day of the month (D-17: rule 2, 'the 28th' is the first calendar date with that day)", () => {
  it.each([
    ["I'd like to book for 7 on the 28th at 7", 28],
    ["dinner for 2 on the 3rd at Hauz Khas", 3],
    ["table on the 1st please", 1],
  ])("%s → %i", (text, d) => expect(plainDayOfMonth(text)).toBe(d));
  it.each(["on 28th October", "Wednesday the 28th", "the 28th or the 29th", "between the 3rd and 5th", "28 people", "next week on the 28th"])("%s → null", (text) => expect(plainDayOfMonth(text)).toBeNull());
  it("corrects a misread day of the month, counting today, and leaves a right one alone", () => {
    const r = guardExtraction(booking({ date: "2026-11-04", partySize: 7 }), "I'd like to book for 7 on the 28th at 7", NOW, ZONE);
    expect(r.turn.booking.date).toBe("2026-10-28");
    expect(r.trace).toContainEqual({ action: "correct_field", field: "date", reason: "day_of_month" });
    expect(guardExtraction(booking({ date: "2026-11-03" }), "dinner for 2 on the 3rd", NOW, ZONE).trace).toEqual([]);
    expect(guardExtraction(booking({ date: null }), "lunch on the 16th", NOW, ZONE).turn.booking.date).toBe("2026-10-16");
  });
});

