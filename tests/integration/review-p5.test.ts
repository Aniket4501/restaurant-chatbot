import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReservation } from "@/lib/booking/create";
import { noTurnLimit } from "@/lib/chat/ratelimit";
import { runTurn } from "@/lib/chat/turn";
import { emptyDraft, type Draft } from "@/lib/chat/types";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { fakeEmbedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { indexKb } from "@/lib/kb/index";
import { fakeModel, nullBooking } from "@/lib/llm/fake";
import type { Turn } from "@/lib/llm/schema";
import { toInstant } from "@/lib/time/tz";
import { tempDb } from "./helpers/db";

// Regression tests for the Phase 5 review (docs/REVIEW.md, "Phase 5"): TP-2 and the server half of UI-1.
const NOW = Date.parse("2026-10-16T14:05:00+05:30");
const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));
let t: ReturnType<typeof tempDb>;
beforeEach(async () => {
  t = tempDb("p5");
  applySeed(t.db, seed, { now: NOW });
  await indexKb(t.db, renderKbFacts(loadFactSource(t.db)), fakeEmbedder(), NOW);
});
afterEach(() => t.cleanup());

const smalltalk = (answer: string): Turn => ({ intent: "smalltalk", booking: nullBooking(), prefs: null, answer, citedFactIds: [], answerable: true });
const turn = (text: string, draft: Draft, reply: Turn) =>
  runTurn({ now: NOW, sessionId: "8c2f6f1e-6b61-4d5b-9d8e-1f2a3b4c5d6e", messages: [{ role: "guest", content: text }], draft }, { db: t.db, model: fakeModel({ script: { [text]: reply } }), embedder: fakeEmbedder(), limiter: noTurnLimit });
const SAT_8PM = toInstant("2026-10-17", "20:00", "Asia/Kolkata");

describe("TP-2: the pending-confirm wording follows the reply actually sent", () => {
  it("replaces prose whenever the reply carries a confirm card, even if the incoming draft had no selection", async () => {
    const d: Draft = { ...emptyDraft(), branch: "hauz-khas", date: "2026-10-17", time: "20:00", partySize: 4, selected: null };
    const r = await turn("thanks", d, smalltalk("You're welcome! Enjoy your evening."));
    expect(r.reply.blocks.some((b) => b.type === "confirm")).toBe(true);
    expect(r.reply.text).toBe("Your table isn't booked yet. Tap Confirm to finish.");
  });

  it("UI-1: never says 'tap Confirm' without a card; a notice says the selected time is gone", async () => {
    // Party of 7: only the 8-top fits. The guest's selected 8 PM slot is then taken.
    const d: Draft = { ...emptyDraft(), branch: "hauz-khas", date: "2026-10-17", time: "20:00", partySize: 7, selected: { startsAt: SAT_8PM } };
    const other = createReservation(t.db, { branch: "hauz-khas", startsAt: SAT_8PM, partySize: 7, name: "Other Guest", phone: "98100 00001" }, crypto.randomUUID(), NOW);
    expect("reservation" in other).toBe(true);
    const r = await turn("did it go through?", d, smalltalk("Thanks for waiting!"));
    expect(r.reply.blocks.some((b) => b.type === "confirm")).toBe(false);
    expect(r.reply.text).toBe("Thanks for waiting!");
    expect(JSON.stringify(r.reply.blocks)).not.toMatch(/isn't booked yet|Tap Confirm/);
    expect(r.reply.blocks.find((b) => b.type === "notice")).toMatchObject({ text: expect.stringMatching(/^8:00 PM isn't available\./) });
    expect(r.draft.selected).toBeNull();
  });
});
