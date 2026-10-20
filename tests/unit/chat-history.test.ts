import { describe, expect, it } from "vitest";
import { historyContent } from "@/lib/chat/submit";
import type { Block } from "@/lib/chat/types";

// Prompt v4 rule 1 sends a change to a confirmed booking to manage_booking, so the model has to be able to see that a
// booking was confirmed. The success text is empty (the booked wording lives only in the card, INV-04), so history
// carries a line built from the confirmation block (T-20 review).
const confirmation: Block = { type: "confirmation", ref: "NE-7KQ2M9", status: "confirmed", branchName: "Neem & Ember, Hauz Khas", address: "24 Hauz Khas Village", phone: "+91 11 4155 0101", dateLabel: "Sat 17 Oct", timeLabel: "8:00 PM", partySize: 4, guestName: "Asha Rao" };

describe("historyContent", () => {
  it("turns a confirmation card into a history line with no guest data", () => {
    const line = historyContent("", [confirmation]);
    expect(line).toBe("Booking confirmed (reference NE-7KQ2M9): Sat 17 Oct, 8:00 PM, 4 guests.");
    expect(line).not.toMatch(/Asha|\+91/);
  });
  it("keeps ordinary text, and gives nothing for an empty reply without a card", () => {
    expect(historyContent("Which branch would you like?", [])).toBe("Which branch would you like?");
    expect(historyContent("", [])).toBe("");
    expect(historyContent("", undefined)).toBe("");
  });
});
