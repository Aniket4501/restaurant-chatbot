import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noTurnLimit } from "@/lib/chat/ratelimit";
import { runTurn, type TurnDeps, type TurnInput } from "@/lib/chat/turn";
import type { Block, TurnContext, TurnReply } from "@/lib/chat/types";
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
const say = (text: string, context?: Partial<TurnContext>, history: TurnInput["messages"] = []): TurnInput => ({ now: NOW, sessionId: SID, messages: [...history, { role: "guest", content: text }], draft: null, context: context ? { lastCitedIds: [], ...context } : undefined });
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
