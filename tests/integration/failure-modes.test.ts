import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiDeps } from "@/lib/api/deps";
import { bookingItemHandlers } from "@/lib/api/admin-workspace";
import { reservationsHandler } from "@/lib/api/reservations";
import { createReservation } from "@/lib/booking/create";
import { submitOutcome } from "@/lib/chat/submit";
import { guardExtraction, largePartyStated, relativeDay } from "@/lib/chat/guards";
import { loadConfig } from "@/lib/config";
import { createLimiter } from "@/lib/http/ratelimit";
import { normalizeGuestMobile } from "@/lib/phone";
import { toInstant } from "@/lib/time/tz";
import { testChatDeps } from "../helpers/chat-deps";
import { noTurnLimit } from "@/lib/chat/ratelimit";
import { runTurn, type TurnDeps, type TurnInput } from "@/lib/chat/turn";
import { emptyDraft, type Block, type Draft, type TurnContext, type TurnReply } from "@/lib/chat/types";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { fakeEmbedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { indexKb } from "@/lib/kb/index";
import type { ChatMessage, ModelClient } from "@/lib/llm/client";
import { nullBooking } from "@/lib/llm/fake";
import type { Turn } from "@/lib/llm/schema";
import { tempDb } from "./helpers/db";

// Failure-mode audit (evals/failure-modes.json): full-turn regression tests on a temp database (never data/app.db)
// with a scripted model that records what it was sent. Each test name starts with its register ID. Fixed clock:
// Fri 16 Oct 2026, 2:00 PM, Asia/Kolkata.
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const SID = "4b7d0c9e-2f1a-4c3b-9d8e-7f6a5b4c3d2e";
const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));
let t: ReturnType<typeof tempDb>;
beforeEach(async () => {
  t = tempDb("fm");
  applySeed(t.db, seed, { now: NOW });
  await indexKb(t.db, renderKbFacts(loadFactSource(t.db)), fakeEmbedder(), NOW);
});
afterEach(() => t.cleanup());

/** A model that answers from a queue and records every request's messages. */
function recorder(replies: unknown[]): { model: ModelClient; sent: ChatMessage[][] } {
  const sent: ChatMessage[][] = [];
  const model: ModelClient = {
    provider: "fake",
    model: "fm",
    chat: async (req) => {
      sent.push(req.messages);
      const r = replies.shift();
      if (r === undefined) throw Object.assign(new Error("fake model: no reply left"), { name: "ScriptExhaustedError" });
      return { status: 200, error: null, content: JSON.stringify(r), done_reason: "stop", thinking: null, prompt_eval_count: 10, prompt_eval_cached_count: 0, eval_count: 10, total_ms: 1 };
    },
  };
  return { model, sent };
}
const deps = (model: ModelClient): TurnDeps => ({ db: t.db, model, embedder: fakeEmbedder(), limiter: noTurnLimit });
const say = (text: string, context?: Partial<TurnContext>, history: TurnInput["messages"] = [], draft: Draft | null = null): TurnInput => ({ now: NOW, sessionId: SID, messages: [...history, { role: "guest", content: text }], draft, context: context ? { lastCitedIds: [], ...context } : undefined });
const turn = (intent: Turn["intent"], o: Partial<Turn> = {}): Turn => ({ intent, booking: nullBooking(), prefs: null, answer: null, citedFactIds: [], answerable: true, ...o });
const recTurn = (prefs: Partial<NonNullable<Turn["prefs"]>> = {}): Turn => turn("recommend", { prefs: { diet: [], avoid: [], maxPrice: null, course: null, mild: false, allergy: false, relation: null, ...prefs } });
const block = <K extends Block["type"]>(r: TurnReply, type: K) => r.reply.blocks.find((b) => b.type === type) as Extract<Block, { type: K }> | undefined;

describe("failure modes: conversation and grounding (full turns)", () => {
  it("FM-004 'anything cheaper?' after a question about a dish compares with that dish, and the prompt numbers what was shown", async () => {
    const a = recorder([turn("faq", { answer: "The Lamb Rogan Josh is ₹745.", citedFactIds: ["menu:lamb-rogan-josh"] })]);
    const first = await runTurn(say("How much is the Lamb Rogan Josh?", { recommended: ["menu:dal-ember"] }), deps(a.model));
    expect(first.context.shown).toEqual(["menu:lamb-rogan-josh"]);
    const b = recorder([recTurn({ relation: "cheaper" }), { pick: "chicken-chettinad", alternatives: [], reply: "The Chicken Chettinad at ₹625 is a peppery Chettinad curry." }]);
    await runTurn(say("Anything cheaper?", first.context), deps(b.model));
    expect(b.sent[0][1].content).toContain('Dishes last shown to the guest, in order ("the second one" is number 2): 1. Lamb Rogan Josh (₹745)');
    expect(b.sent[1][1].content).toContain("They want something cheaper than Lamb Rogan Josh (₹745).");
  });
  it("FM-003 'something light' gets the meal-type question even when the model guessed a section", async () => {
    const m = recorder([recTurn({ course: "desserts" })]);
    const r = await runTurn(say("I want something light."), deps(m.model));
    expect(r.reply.text).toBe("Happy to help. A light snack, a main course or a dessert?");
    expect(m.sent).toHaveLength(1); // no chooser call
  });
  it("FM-007 a mixed answer on a special date can't use the weekly dinner hours; the guest gets the day's card", async () => {
    const q = "Is Hauz Khas open for dinner on 22 October, and is there parking?";
    const m = recorder([turn("faq", { answer: "Yes, Hauz Khas serves dinner from 7:00 PM to 11:00 PM, and there is paid public parking at the village entrance.", citedFactIds: ["hours:hauz-khas:thu", "faq:parking-hauz-khas"] })]);
    const r = await runTurn(say(q), deps(m.model));
    expect(r.reply.text).not.toMatch(/7:00 PM/);
    expect(block(r, "hours")?.sections[0].rows.find((x) => x.label === "Dinner")).toMatchObject({ value: "Closed" });
  });
  it("FM-023 a grounded answer about a dish's spice is kept, not replaced by 'we don't collect reviews'", async () => {
    const q = "What's the spice rating of the Chicken Chettinad?";
    const m = recorder([turn("faq", { answer: "The Chicken Chettinad is hot.", citedFactIds: ["menu:chicken-chettinad"] })]);
    const r = await runTurn(say(q), deps(m.model));
    expect(r.meta.outcome).toBe("faq_answer");
    expect(r.reply.text).toBe("The Chicken Chettinad is hot.");
  });
  it("FM-021 'nothing with nuts' filters nut dishes out of what the chooser may pick, and the allergy note shows", async () => {
    const m = recorder([recTurn({ avoid: ["nuts"], course: "mains" }), { pick: "paneer-lababdar", alternatives: [], reply: "The Paneer Lababdar at ₹525 is paneer in a rich tomato gravy." }, { pick: "dal-ember", alternatives: [], reply: "The Dal Ember at ₹445 is black lentils slow-cooked overnight." }]);
    const r = await runTurn(say("Nothing with nuts in it, a main?"), deps(m.model));
    expect(m.sent[1][1].content).not.toContain("paneer-lababdar |");
    expect(block(r, "recommendation")?.items[0].id).toBe("menu:dal-ember");
  });
  it("FM-022 'my friend has no allergies' keeps the guest's own nut allergy for the next suggestion", async () => {
    const ctx = { prefs: { diet: [], avoid: ["nuts" as const], maxPrice: null, course: null, mild: false, allergy: true, unlisted: [], spicy: false, exclude: [] }, allergyNoted: true };
    const m = recorder([recTurn({ course: "desserts" }), { pick: "coconut-jaggery-payasam", alternatives: [], reply: "The Coconut Jaggery Payasam at ₹265 is rice pudding with coconut milk." }]);
    const r = await runTurn(say("My friend has no allergies, what dessert would she like?", ctx), deps(m.model));
    expect(r.context.prefs).toMatchObject({ avoid: ["nuts"], allergy: true });
    expect(m.sent[1][1].content).not.toContain("pistachio-kulfi |");
  });
});

describe("failure modes: booking details (FM-013, FM-014, FM-036, FM-042)", () => {
  const ZONE = "Asia/Kolkata";
  const booking = (o: Partial<Turn["booking"]>) => turn("booking", { booking: { ...nullBooking(), ...o } });
  const sat8 = toInstant("2026-10-17", "20:00", ZONE);
  const held: Draft = { ...emptyDraft(), branch: "hauz-khas", date: "2026-10-17", partySize: 2, timeWindow: "lunch", time: "20:00", selected: { startsAt: sat8 } };

  it("FM-036 'a table for 9:30' or 'for 12 noon' is a time, not 9 or 12 guests", () => {
    for (const t of ["Can I get a table for 9:30 tonight at Hauz Khas?", "Can I book a table for 12 noon on Saturday?", "Book a table for 10 pm tomorrow", "Table for 9.30 tomorrow"]) expect(largePartyStated(t), t).toBeNull();
    expect(largePartyStated("A table for 10 on Saturday at 8")).toBe(10);
    expect(largePartyStated("Book for a party of 10 at 9:30")).toBe(10);
  });
  it("FM-036 mid-flow 'move it to a table for 9:30' keeps the party of 2 and offers 9:30 PM", async () => {
    const m = recorder([booking({ time: "21:30" })]);
    const r = await runTurn(say("Could we move it to a table for 9:30 pm instead?", undefined, [], { ...held, timeWindow: "dinner" }), deps(m.model));
    expect(r.draft.partySize).toBe(2);
    expect(block(r, "confirm")).toMatchObject({ partySize: 2, timeLabel: "9:30 PM" });
  });
  it("FM-013 code's reading of a clock time and of today/tomorrow wins over a misread", () => {
    const g = guardExtraction(booking({ time: "19:00", date: "2026-10-18", partySize: 2 }), "Table for 2 tomorrow at 7:30 pm", NOW, ZONE);
    expect(g.turn.booking).toMatchObject({ time: "19:30", date: "2026-10-17" });
    expect(g.trace).toContainEqual({ action: "correct_field", field: "date", reason: "relative_day" });
    expect(guardExtraction(booking({ time: "08:00" }), "dinner at 8 pm tonight", NOW, ZONE).turn.booking).toMatchObject({ time: "20:00", date: "2026-10-16" });
    expect(relativeDay("the day after tomorrow at 8")).toBe(2);
    for (const t of ["tomorrow or Saturday", "not tomorrow, Sunday", "tomorrow next week", "today, no wait, tomorrow", "after tomorrow", "17 October, tomorrow"]) expect(relativeDay(t), t).toBeNull();
  });
  it("FM-014 'lunch is better after all' with an evening time held drops the old time and offers lunch times, not the old card", async () => {
    const m = recorder([booking({ timeWindow: "lunch" })]);
    const r = await runTurn(say("Lunch is better after all.", undefined, [], held), deps(m.model));
    expect(block(r, "confirm")).toBeUndefined();
    expect(r.draft.time).toBeNull();
    expect(block(r, "slots")?.groups.map((g) => g.service)).toEqual(["lunch"]);
  });
  it("FM-014 'an hour later' with the model's time dropped doesn't show the same 8 PM card again", async () => {
    const m = recorder([booking({ time: "21:00" })]);
    const r = await runTurn(say("Make it an hour later.", undefined, [], { ...held, timeWindow: "dinner" }), deps(m.model));
    expect(block(r, "confirm")).toBeUndefined();
    expect(r.draft.time).toBeNull();
    // Not every "later" is a time change.
    const k = recorder([booking({})]);
    const kept = await runTurn(say("I'll tell you the name later.", undefined, [], { ...held, timeWindow: "dinner" }), deps(k.model));
    expect(kept.draft.time).toBe("20:00");
  });
  it("FM-042 a lunch time at Golf Course Road on a Monday says there is no lunch that day", async () => {
    const m = recorder([booking({ branch: "gurugram", date: "2026-10-19", time: "13:00", partySize: 2 })]);
    const r = await runTurn(say("Lunch at 1 pm on Monday 19 October at Golf Course Road for 2"), deps(m.model));
    expect(r.reply.text).toMatch(/has no open lunch times on/);
    expect(r.reply.text).not.toMatch(/1:00 PM isn't available/);
  });
});

describe("failure modes: booking writes and the API (FM-011, FM-037, FM-039, FM-040, FM-041, FM-050)", () => {
  let api: ApiDeps;
  beforeEach(() => {
    api = {
      db: () => t.db,
      now: () => NOW,
      config: () => loadConfig({ DATABASE_PATH: path.join(os.tmpdir(), "x.db") }),
      fetch: (async () => Response.json({ models: [] })) as typeof fetch,
      limits: { createsPerPhone: createLimiter({ limit: 5, windowMs: 60_000 }), createsGlobal: createLimiter({ limit: 30, windowMs: 60_000 }) },
      chat: testChatDeps(),
    };
  });
  const body = (o: Record<string, unknown> = {}) => ({ branch: "hauz-khas", startsAt: toInstant("2026-10-17", "20:00", "Asia/Kolkata"), partySize: 2, name: "Asha Rao", phone: "98765 43210", ...o });
  const post = (b: unknown, key = randomUUID()) =>
    reservationsHandler(api)(new Request("http://127.0.0.1:3100/api/reservations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(b) }));
  const rows = () => (t.db.prepare("SELECT count(*) AS n FROM reservations").get() as { n: number }).n;
  const ctx = { branch: { slug: "hauz-khas", short: "Hauz Khas", phone: "+911140000000", phoneLabel: null }, branches: [], date: "2026-10-17", partySize: 2 };

  it("FM-037/FM-011 a write that fails inside the transaction answers 503 'nothing was booked', and the client neither confirms nor locks", async () => {
    t.db.exec("CREATE TRIGGER fm_fail BEFORE INSERT ON reservations BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
    const res = await post(body());
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error.code).toBe("UNAVAILABLE");
    expect(rows()).toBe(0);
    const out = submitOutcome({ status: res.status, body: j }, ctx as never);
    expect(out).toMatchObject({ ref: null, unknown: false, clearPending: true });
    expect(out.blocks.some((b) => b.type === "confirmation")).toBe(false);
    // A thrown error inside the transaction (not a constraint) is rolled back too.
    t.db.exec("DROP TRIGGER fm_fail;");
    const r = createReservation(t.db, body(), randomUUID(), NOW, { newId: () => { throw new Error("simulated id failure"); } });
    expect(r).toMatchObject({ code: "UNAVAILABLE", status: 503 });
    expect(rows()).toBe(0);
  });
  it("FM-019 a booking's response and a duplicate's refusal never echo the guest's mobile or email; a stranger's name gets no details", async () => {
    const saved = await (await post(body({ email: "asha@example.com", note: "window seat" }))).text();
    expect(saved).not.toMatch(/98765|43210|asha@example\.com/);
    const stranger = await (await post(body({ name: "Someone Else" }))).json();
    expect(stranger.error.code).toBe("DUPLICATE_BOOKING");
    expect(JSON.stringify(stranger)).not.toMatch(/NE-[A-Z0-9]{8}|8:00 PM|Asha/);
  });
  it("FM-040 names spelt with zero-width joiners are accepted; bidi overrides are still refused", () => {
    expect(createReservation(t.db, body({ name: "ലക്ഷ്മി മേനോന്\u200d" }), randomUUID(), NOW)).toHaveProperty("reservation");
    expect(createReservation(t.db, body({ name: "Asha \u202eoaR", startsAt: toInstant("2026-10-18", "20:00", "Asia/Kolkata") }), randomUUID(), NOW)).toMatchObject({ code: "VALIDATION" });
  });
  it("FM-041 '+91' typed again after the field's '+91' prefix is the same mobile; a number starting 91 still works", () => {
    for (const p of ["+91 +91 98765 43210", "+91 919876543210", "+919876543210", "98765 43210"]) expect(normalizeGuestMobile(p), p).toBe("+919876543210");
    expect(normalizeGuestMobile("91987 65432")).toBe("+919198765432");
    expect(normalizeGuestMobile("+91 +91 12345")).toBeNull();
  });
  it("FM-050 malformed requests don't use up a guest's limit, and a saved booking's retry is answered after the limit", async () => {
    for (let i = 0; i < 6; i++) expect((await post(body({ name: "" }))).status).toBe(400);
    const key = randomUUID();
    expect((await post(body(), key)).status).toBe(201);
    for (let i = 0; i < 4; i++) await post(body({ startsAt: toInstant("2026-10-18", "13:00", "Asia/Kolkata") + i * 86_400_000 }));
    expect((await post(body({ startsAt: toInstant("2026-10-23", "13:00", "Asia/Kolkata") }))).status).toBe(429);
    const replay = await post(body(), key);
    expect(replay.status).toBe(200);
  });
  it("FM-039 a staff cancel whose change-log write fails is rolled back; the retry cancels and logs exactly once", async () => {
    const r = createReservation(t.db, body(), randomUUID(), NOW);
    if (!("reservation" in r)) throw new Error(r.code);
    const ref = r.reservation.ref;
    const patch = () => bookingItemHandlers(api).PATCH(new Request(`http://127.0.0.1:3100/api/admin/reservations/${ref}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) }), { params: Promise.resolve({ ref }) });
    t.db.exec("CREATE TRIGGER fm_log_fail BEFORE INSERT ON admin_changes BEGIN SELECT RAISE(ABORT, 'simulated log failure'); END;");
    expect((await patch()).status).toBe(500);
    expect((t.db.prepare("SELECT status FROM reservations WHERE ref = ?").get(ref) as { status: string }).status).toBe("confirmed");
    t.db.exec("DROP TRIGGER fm_log_fail;");
    const ok = await patch();
    expect(ok.status).toBe(200);
    expect((await ok.json()).changed).toBe(true);
    expect((t.db.prepare("SELECT count(*) AS n FROM admin_changes WHERE target = ? AND action = 'cancelled'").get(ref) as { n: number }).n).toBe(1);
  });
});

describe("failure modes: turn time (FM-025)", () => {
  /** The scripted model, with a clock that moves on `stepMs` per model call. */
  const slow = (replies: unknown[], stepMs: number) => {
    const rec = recorder(replies);
    let clock = 0;
    const model: ModelClient = { ...rec.model, chat: async (req) => ((clock += stepMs), rec.model.chat(req)) };
    return { sent: rec.sent, deps: { ...deps(model), elapsed: () => clock } as TurnDeps };
  };
  it("FM-025 past the turn's budget, the dish chooser isn't called: the guest gets the code's list", async () => {
    const m = slow([recTurn({ diet: ["vegetarian"], course: "mains" }), { pick: "dal-ember", alternatives: [], reply: "The Dal Ember at ₹445." }], 19_000);
    const r = await runTurn(say("Something vegetarian, a main please"), m.deps);
    expect(m.sent).toHaveLength(1);
    expect(r.reply.text).toMatch(/^Here are a few/);
    expect(block(r, "recommendation")?.items.length).toBeGreaterThan(0);
  });
  it("FM-025 past the budget, invalid model output gets no corrective retry", async () => {
    const m = slow(["not json at all", turn("faq", { answer: "Yes.", citedFactIds: ["faq:pets"] })], 19_000);
    await runTurn(say("can I bring my dog?"), m.deps);
    expect(m.sent).toHaveLength(1);
  });
  it("FM-025 within the budget both still happen", async () => {
    const m = slow([recTurn({ diet: ["vegetarian"], course: "mains" }), { pick: "dal-ember", alternatives: [], reply: "The Dal Ember at ₹445 is black lentils slow-cooked overnight." }], 1_000);
    const r = await runTurn(say("Something vegetarian, a main please"), m.deps);
    expect(m.sent).toHaveLength(2);
    expect(block(r, "recommendation")?.items[0].id).toBe("menu:dal-ember");
  });
});

