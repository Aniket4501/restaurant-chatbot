import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { interpretEnvelope, ModelError, type ModelRequest, type RawEnvelope } from "@/lib/llm/client";
import { fakeModel, guestTextOf, unclearTurn } from "@/lib/llm/fake";
import { TURN_JSON_SCHEMA, TurnSchema, type Turn } from "@/lib/llm/schema";

const ROOT = path.resolve(__dirname, "../..");

describe("TurnSchema (§5.7, D-06)", () => {
  it("serialises to the canonical grammar fixture the probe validated", () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/turn.schema.json"), "utf8"));
    const strip = (s: Record<string, unknown>) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "$schema"));
    expect(JSON.stringify(strip(z.toJSONSchema(TurnSchema) as Record<string, unknown>))).toBe(JSON.stringify(strip(fixture)));
    expect(TURN_JSON_SCHEMA).toEqual(z.toJSONSchema(TurnSchema));
  });

  it("accepts partySize 0–999 so the grammar never rewrites 150 as 15; rejects other values", () => {
    const withParty = (p: unknown) => ({ ...unclearTurn(), booking: { ...unclearTurn().booking, partySize: p } });
    for (const p of [0, 1, 8, 150, 999, null]) expect(TurnSchema.safeParse(withParty(p)).success, String(p)).toBe(true);
    for (const p of [-1, 1000, 1.5, "4"]) expect(TurnSchema.safeParse(withParty(p)).success, String(p)).toBe(false);
  });
});

const env = (over: Partial<RawEnvelope>): RawEnvelope => ({
  status: 200,
  error: null,
  content: JSON.stringify(unclearTurn()),
  done_reason: "stop",
  thinking: null,
  prompt_eval_count: 3500,
  prompt_eval_cached_count: 3400,
  eval_count: 60,
  total_ms: 900,
  ...over,
});
const codeOf = (e: RawEnvelope) => {
  const r = interpretEnvelope(e, 8192);
  return r.ok ? "ok" : r.code;
};

describe("interpretEnvelope (§5.8, D-05)", () => {
  it("accepts a valid reply and keeps the metrics", () => {
    const r = interpretEnvelope(env({}), 8192);
    expect(r).toMatchObject({ ok: true, truncated: false, metrics: { prompt_eval_count: 3500, prompt_eval_cached_count: 3400, eval_count: 60, total_ms: 900, thinking_present: false } });
  });
  it("v3 (D-24): a null booking is valid and reaches code as an object of nulls", () => {
    const out = { intent: "faq", booking: null, prefs: null, answer: "Yes.", citedFactIds: ["faq:wifi"], answerable: true };
    const r = interpretEnvelope(env({ content: JSON.stringify(out) }), 8192);
    expect(r.ok && r.turn.booking).toEqual({ branch: null, date: null, time: null, timeWindow: null, partySize: null, ambiguity: null });
    // A filled booking passes through unchanged; a missing one is still a schema miss.
    const booking = { branch: "hauz-khas", date: "2026-10-17", time: "20:00", timeWindow: null, partySize: 2, ambiguity: null };
    const b = interpretEnvelope(env({ content: JSON.stringify({ ...out, intent: "booking", booking, answer: null, citedFactIds: [] }) }), 8192);
    expect(b.ok && b.turn.booking).toEqual(booking);
    const missing = Object.fromEntries(Object.entries(out).filter(([k]) => k !== "booking"));
    expect(codeOf(env({ content: JSON.stringify(missing) }))).toBe("MODEL_INVALID_OUTPUT");
  });

  it("maps HTTP status, never message text", () => {
    expect(codeOf(env({ status: 404, error: "model 'x' not found" }))).toBe("MODEL_NOT_PULLED");
    expect(codeOf(env({ status: 400, error: "invalid structured output grammar" }))).toBe("MODEL_INVALID_OUTPUT");
    expect(codeOf(env({ status: 500, error: "not found" }))).toBe("MODEL_UNAVAILABLE");
    expect(codeOf(env({ status: 503 }))).toBe("MODEL_UNAVAILABLE");
  });
  it("treats an over-budget prompt as CONTEXT_TOO_LARGE (num_ctx − 512)", () => {
    expect(codeOf(env({ prompt_eval_count: 7679 }))).toBe("ok");
    expect(codeOf(env({ prompt_eval_count: 7680 }))).toBe("CONTEXT_TOO_LARGE");
  });
  it("rejects thinking, done_reason length, empty, non-JSON and schema misses", () => {
    expect(codeOf(env({ thinking: "hmm" }))).toBe("MODEL_INVALID_OUTPUT");
    expect(interpretEnvelope(env({ thinking: "hmm" })).metrics.thinking_present).toBe(true);
    expect(codeOf(env({ done_reason: "length" }))).toBe("MODEL_INVALID_OUTPUT");
    expect(codeOf(env({ content: "  " }))).toBe("MODEL_INVALID_OUTPUT");
    expect(codeOf(env({ content: "Sure!" }))).toBe("MODEL_INVALID_OUTPUT");
    expect(codeOf(env({ content: JSON.stringify({ ...unclearTurn(), intent: "chat" }) }))).toBe("MODEL_INVALID_OUTPUT");
    const r = interpretEnvelope(env({ content: JSON.stringify({ intent: "faq" }) }));
    expect(r.ok ? "" : r.detail).toMatch(/^schema: booking/);
  });
  it("flags a 600-character answer as truncated", () => {
    const t: Turn = { ...unclearTurn(), intent: "faq", answer: "a".repeat(600) };
    expect(interpretEnvelope(env({ content: JSON.stringify(t) }))).toMatchObject({ ok: true, truncated: true });
    expect(interpretEnvelope(env({ content: JSON.stringify({ ...t, answer: "a".repeat(599) }) }))).toMatchObject({ ok: true, truncated: false });
  });
});

const SYSTEM = "rules\n\nExamples:\n<guest_message>hi there!</guest_message>\n{}";
const req = (guest: string, attempt: 1 | 2 = 1, retrieved = "menu:dal-ember | Dal Ember (mains), ₹445."): ModelRequest => ({
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Current time: x\n\nMenu and policy facts that may be relevant (each line: ID | fact):\n${retrieved}\n\n<guest_message>${guest}</guest_message>` },
  ],
  format: TURN_JSON_SCHEMA,
  attempt,
});
async function outcome(guest: string, attempt: 1 | 2 = 1, script = {}) {
  try {
    const r = interpretEnvelope(await fakeModel({ script }).chat(req(guest, attempt)));
    return r.ok ? r.turn : r.code;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelError);
    return (e as ModelError).code;
  }
}

describe("fake model (D-12)", () => {
  it("reads the guest text from the user message fence, not the examples", () => {
    expect(guestTextOf(req("table for 2"))).toBe("table for 2");
  });
  it("maps every directive to the error path a real model would take", async () => {
    expect(await outcome("hi #fake:down")).toBe("MODEL_UNAVAILABLE");
    expect(await outcome("‹‹DOWN››")).toBe("MODEL_UNAVAILABLE"); // <<DOWN>> after the fence is neutralised
    expect(await outcome("hi #fake:timeout")).toBe("MODEL_TIMEOUT");
    expect(await outcome("#fake:not_pulled")).toBe("MODEL_NOT_PULLED");
    expect(await outcome("#fake:length")).toBe("MODEL_INVALID_OUTPUT");
    expect(await outcome("#fake:thinking")).toBe("MODEL_INVALID_OUTPUT");
    expect(await outcome("#fake:empty")).toBe("MODEL_INVALID_OUTPUT");
    expect(await outcome("#fake:context")).toBe("CONTEXT_TOO_LARGE");
    expect(await outcome("#fake:invalid")).toBe("MODEL_INVALID_OUTPUT");
    expect(await outcome("#fake:invalid", 2)).toBe("MODEL_INVALID_OUTPUT");
    expect(await outcome("#fake:invalid_once", 1)).toBe("MODEL_INVALID_OUTPUT");
    expect(await outcome("#fake:invalid_once", 2)).toEqual(unclearTurn());
  });
  it("produces a booking claim citing the first retrieved fact (#fake:claim)", async () => {
    expect(await outcome("is the dal vegan? #fake:claim")).toMatchObject({ intent: "faq", answer: "Good news, I've booked your table for tonight.", citedFactIds: ["menu:dal-ember"] });
  });
  it("replays scripted replies by exact guest text, per attempt, and defaults to unclear", async () => {
    const faq: Turn = { ...unclearTurn(), intent: "faq", answer: "Yes.", citedFactIds: ["faq:pets"] };
    const script = { "can I bring my dog": faq, "two tries": ["#fake:invalid", faq], "server error": { raw: { status: 500, error: "boom" } } };
    expect(await outcome("can I bring my dog", 1, script)).toEqual(faq);
    expect(await outcome("two tries", 1, script)).toBe("MODEL_INVALID_OUTPUT");
    expect(await outcome("two tries", 2, script)).toEqual(faq);
    expect(await outcome("server error", 1, script)).toBe("MODEL_UNAVAILABLE");
    expect(await outcome("something else", 1, script)).toEqual(unclearTurn());
  });
  it("reports a plausible prompt_eval_count from the prompt size", async () => {
    const e = await fakeModel().chat(req("hi"));
    expect(e.prompt_eval_count).toBe(Math.ceil((SYSTEM.length + req("hi").messages[1].content.length) / 3));
  });
});
