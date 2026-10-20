import { describe, expect, it } from "vitest";
import { applySetField, mergeExtracted, validateField, type FieldCtx } from "@/lib/chat/draft";
import { createModelGate, GateFullError, turnLimiter } from "@/lib/chat/ratelimit";
import { fieldChips, phoneBranches } from "@/lib/chat/router";
import { branchInfo, T } from "@/lib/chat/templates";
import { emptyDraft, type Draft } from "@/lib/chat/types";
import { createLimiter } from "@/lib/http/ratelimit";
import type { BookingFields } from "@/lib/llm/schema";

const NOW = Date.parse("2026-10-16T14:05:00+05:30"); // Fri 16 Oct 2026
const HK = branchInfo({ slug: "hauz-khas", name: "Neem & Ember, Hauz Khas", address: "24 Hauz Khas Village", phone: "+911141550101", timezone: "Asia/Kolkata" });
const GG = branchInfo({ slug: "gurugram", name: "Neem & Ember, Golf Course Road", address: "Unit 3, Ember Court", phone: "+911244550202", timezone: "Asia/Kolkata" });
const ctx: FieldCtx = { now: NOW, zone: "Asia/Kolkata", branches: [HK, GG], allSlugs: new Set(["hauz-khas", "gurugram", "noida"]) };
const fields = (o: Partial<BookingFields>): BookingFields => ({ branch: null, date: null, time: null, timeWindow: null, partySize: null, ambiguity: null, ...o });
const draft = (o: Partial<Draft>): Draft => ({ ...emptyDraft(), ...o });

describe("validateField", () => {
  it("accepts only active branches, dates in the horizon, HH:MM times and 1–8 guests", () => {
    expect(validateField("branch", "gurugram", ctx)).toEqual({ ok: true, value: "gurugram" });
    expect(validateField("branch", "noida", ctx)).toEqual({ ok: false, issue: "branch_inactive" });
    expect(validateField("branch", "mumbai", ctx)).toEqual({ ok: false, issue: "bad_branch" });
    expect(validateField("date", "2026-10-16", ctx)).toMatchObject({ ok: true });
    expect(validateField("date", "2026-11-15", ctx)).toMatchObject({ ok: true }); // today + 30
    expect(validateField("date", "2026-11-16", ctx)).toEqual({ ok: false, issue: "past_horizon" });
    expect(validateField("date", "2026-10-15", ctx)).toEqual({ ok: false, issue: "past_date" });
    expect(validateField("date", "2026-02-30", ctx)).toEqual({ ok: false, issue: "bad_date" });
    expect(validateField("time", "19:30", ctx)).toMatchObject({ ok: true });
    expect(validateField("time", "25:00", ctx)).toEqual({ ok: false, issue: "bad_time" });
    expect(validateField("partySize", 4, ctx)).toEqual({ ok: true, value: 4 });
    expect(validateField("partySize", "4", ctx)).toEqual({ ok: true, value: 4 });
    expect(validateField("partySize", 0, ctx)).toEqual({ ok: false, issue: "bad_party" });
    expect(validateField("partySize", 9, ctx)).toEqual({ ok: false, issue: "large_party" });
    expect(validateField("partySize", 150, ctx)).toEqual({ ok: false, issue: "large_party" });
  });
});

describe("mergeExtracted (§5.7 merge rules, D-15)", () => {
  it("lets a non-null value overwrite and never lets null clear", () => {
    const r = mergeExtracted(draft({ branch: "hauz-khas", partySize: 2 }), fields({ date: "2026-10-17", partySize: 4 }), ctx);
    expect(r.draft).toEqual(draft({ branch: "hauz-khas", date: "2026-10-17", partySize: 4 }));
    expect(r.changed).toEqual(["date", "partySize"]);
  });
  it("merges partySize 0 like null", () => {
    const r = mergeExtracted(draft({ partySize: 4 }), fields({ partySize: 0 }), ctx);
    expect([r.draft.partySize, r.issues, r.changed]).toEqual([4, [], []]);
  });
  it("flags 9+ guests without storing them, and drops the old party size (latest value wins, review TP-3)", () => {
    const r = mergeExtracted(draft({ partySize: 4 }), fields({ partySize: 150 }), ctx);
    expect(r.largeParty).toBe(true);
    expect(r.draft.partySize).toBeNull();
  });
  it("records invalid values as issues and clears the field so the flow asks again (review TP-3)", () => {
    const r = mergeExtracted(draft({ date: "2026-10-17" }), fields({ date: "2026-12-25", branch: "mumbai" }), ctx);
    expect(r.issues).toEqual([
      { field: "branch", issue: "bad_branch" },
      { field: "date", issue: "past_horizon" },
    ]);
    expect(r.draft.date).toBeNull();
  });
  it("keeps only valid ambiguity candidates (no 0, no 9+) and asks only with two or more", () => {
    const r = mergeExtracted(draft({}), fields({ ambiguity: { field: "date", candidates: ["2026-10-23", "2026-10-30", "2026-12-25"] } }), ctx);
    expect(r.ambiguity).toEqual({ field: "date", candidates: ["2026-10-23", "2026-10-30"] });
    expect(mergeExtracted(draft({}), fields({ ambiguity: { field: "partySize", candidates: ["0", "4", "12"] } }), ctx).ambiguity).toBeNull();
    expect(mergeExtracted(draft({}), fields({ ambiguity: { field: "partySize", candidates: ["3", "4", "0"] } }), ctx).ambiguity).toEqual({ field: "partySize", candidates: ["3", "4"] });
  });
  it("does not set a field it is asking about", () => {
    const r = mergeExtracted(draft({}), fields({ date: "2026-10-23", ambiguity: { field: "date", candidates: ["2026-10-23", "2026-10-30"] } }), ctx);
    expect(r.draft.date).toBeNull();
  });
  it("drops a selected slot when the search changes, keeping the time preference", () => {
    const selected = draft({ branch: "hauz-khas", date: "2026-10-17", time: "20:00", partySize: 4, selected: { startsAt: 1 } });
    expect(mergeExtracted(selected, fields({ date: "2026-10-18" }), ctx).draft).toEqual({ ...selected, date: "2026-10-18", selected: null });
    expect(mergeExtracted(selected, fields({ date: "2026-10-17" }), ctx).draft.selected).toEqual({ startsAt: 1 }); // nothing changed
  });
});

describe("applySetField (chips)", () => {
  it("lets an explicit null clear a field ('change date')", () => {
    expect(applySetField(draft({ date: "2026-10-17" }), "date", null, ctx).draft.date).toBeNull();
  });
  it("validates chip values like typed ones", () => {
    expect(applySetField(draft({}), "partySize", 9, ctx).largeParty).toBe(true);
    expect(applySetField(draft({}), "branch", "mumbai", ctx).issues).toEqual([{ field: "branch", issue: "bad_branch" }]);
  });
});

describe("chips and templates", () => {
  it("puts an absolute date on every date chip (J5)", () => {
    expect(fieldChips("date", ctx).map((c) => c.label)).toEqual(["Today, Fri 16 Oct", "Tomorrow, Sat 17 Oct", "Sun 18 Oct", "Mon 19 Oct", "Tue 20 Oct", "Wed 21 Oct", "Thu 22 Oct"]);
    expect(fieldChips("date", ctx, ["2026-10-23", "2026-10-30"]).map((c) => c.label)).toEqual(["Fri 23 Oct", "Fri 30 Oct"]);
  });
  it("offers 1–8 guests plus '9 or more'", () => {
    const chips = fieldChips("partySize", ctx);
    expect(chips.map((c) => c.label)).toEqual(["1 guest", "2 guests", "3 guests", "4 guests", "5 guests", "6 guests", "7 guests", "8 guests", "9 or more"]);
    expect(chips.at(-1)).toMatchObject({ action: { type: "set_field", field: "partySize", value: 9 } });
  });
  it("names one branch when known, else both (D-15)", () => {
    expect(T.fallback(phoneBranches(ctx, "gurugram"))).toBe("I don't have that information. You can call Golf Course Road on +91 124 455 0202.");
    expect(T.fallback(phoneBranches(ctx, null, "mumbai"))).toBe("I don't have that information. You can call Hauz Khas on +91 11 4155 0101 or Golf Course Road on +91 124 455 0202.");
    expect(T.manageBooking(phoneBranches(ctx, "hauz-khas"))).toBe("To change or cancel, please call Hauz Khas on +91 11 4155 0101.");
  });
});

describe("turn limiter and model gate (D-14)", () => {
  it("allows 20 turns per minute per session and per address, with an injected clock", () => {
    const lim = turnLimiter(createLimiter({ limit: 20, windowMs: 60_000 }), createLimiter({ limit: 20, windowMs: 60_000 }));
    for (let i = 0; i < 20; i++) expect(lim.allow("a", NOW + i).ok).toBe(true);
    expect(lim.allow("a", NOW + 30)).toEqual({ ok: false, retryAfterMs: 60_000 - 30 });
    expect(lim.allow("b", NOW + 30).ok).toBe(false); // the shared address bucket is full too
    expect(lim.allow("a", NOW + 60_000).ok).toBe(true);
  });
  it("runs one model call at a time, queues up to 4 in order, and refuses the rest", async () => {
    const gate = createModelGate({ concurrency: 1, maxQueue: 4 });
    const order: number[] = [];
    let release!: () => void;
    const first = gate.run(() => new Promise<void>((r) => (release = r)).then(() => order.push(0)));
    const queued = [1, 2, 3, 4].map((i) => gate.run(async () => void order.push(i)));
    expect([gate.active, gate.waiting]).toEqual([1, 4]);
    await expect(gate.run(async () => 5)).rejects.toBeInstanceOf(GateFullError);
    release();
    await Promise.all([first, ...queued]);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect([gate.active, gate.waiting]).toEqual([0, 0]);
  });
});
