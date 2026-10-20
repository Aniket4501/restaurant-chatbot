import { describe, expect, it } from "vitest";
import { openStatus } from "@/lib/chat/identity";

// The guest header's open/closed pill (mobile-first redesign, 2026-10-20): computed from today's windows, never fixed text.
const LUNCH = { opensMin: 12 * 60, closesMin: 15 * 60 + 30 };
const DINNER = { opensMin: 19 * 60, closesMin: 23 * 60 };

describe("openStatus", () => {
  it.each([
    [11 * 60, { open: false, text: "Opens at 12:00 PM" }],
    [12 * 60, { open: true, text: "Open now · until 3:30 PM" }],
    [15 * 60 + 29, { open: true, text: "Open now · until 3:30 PM" }],
    [15 * 60 + 30, { open: false, text: "Opens at 7:00 PM" }],
    [22 * 60 + 59, { open: true, text: "Open now · until 11:00 PM" }],
    [23 * 60, { open: false, text: "Closed for today" }],
  ])("at minute %i", (now, want) => expect(openStatus([DINNER, LUNCH], now)).toEqual(want));
  it("says closed today when there are no services (a whole-day exception)", () => {
    expect(openStatus([], 13 * 60)).toEqual({ open: false, text: "Closed today" });
  });
});
