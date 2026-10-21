import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminCancelHandler, adminListHandler } from "@/lib/api/admin";
import type { ApiDeps } from "@/lib/api/deps";
import { createReservation } from "@/lib/booking/create";
import { getAvailability } from "@/lib/booking/availability";
import { loadAvailabilityData } from "@/lib/booking/load";
import { loadConfig } from "@/lib/config";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { createLimiter } from "@/lib/http/ratelimit";
import { toInstant } from "@/lib/time/tz";
import { tempDb } from "./helpers/db";
import { testChatDeps } from "../helpers/chat-deps";

// AC-07 (API part), BR-13. Staff handlers need no sign-in (D-22); the proxy's host and origin checks are unit-tested.
const NOW = Date.parse("2026-10-17T10:00:00+05:30");
const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));
let t: ReturnType<typeof tempDb>;
let deps: ApiDeps;

beforeEach(() => {
  t = tempDb("admin");
  applySeed(t.db, seed, { now: NOW });
  deps = {
    db: () => t.db,
    now: () => NOW,
    config: () => loadConfig({ DATABASE_PATH: path.join(os.tmpdir(), "x.db") }),
    fetch: fetch,
    limits: { createsPerPhone: createLimiter({ limit: 100, windowMs: 60_000 }), createsGlobal: createLimiter({ limit: 100, windowMs: 60_000 }) },
    chat: testChatDeps(),
  };
});
afterEach(() => t.cleanup());

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const list = (qs: string) => adminListHandler(deps)(new Request(`http://127.0.0.1:3100/api/admin/reservations?${qs}`));
const cancel = (ref: string, body: unknown = { status: "cancelled" }) =>
  adminCancelHandler(deps)(new Request(`http://127.0.0.1:3100/api/admin/reservations/${ref}`, { ...json(body), method: "PATCH" }), { params: Promise.resolve({ ref }) });
const book = (time: string, phone: string, branch = "hauz-khas", party = 4) =>
  createReservation(t.db, { branch, startsAt: toInstant("2026-10-17", time, "Asia/Kolkata"), partySize: party, name: `Guest ${phone.slice(-2)}`, phone, note: "birthday" }, randomUUID(), NOW);

describe("admin reservations (AC-07, BR-13)", () => {
  it("needs no sign-in (D-22: staff pages have no password)", async () => {
    expect((await list("")).status).toBe(200);
    expect((await cancel("NE-00000000")).status).toBe(404);
  });
  it("lists today's bookings (branch zone) by time with name, time, party and status; totals count confirmed only", async () => {
    book("20:00", "9800000001");
    book("12:30", "9800000002", "gurugram", 2);
    const third = book("19:00", "9800000003");
    if ("reservation" in third) await cancel(third.reservation.ref);
    const res = await list("");
    const j = await res.json();
    expect(j.date).toBe("2026-10-17");
    expect(j.items.map((i: { timeLabel: string; status: string }) => `${i.timeLabel} ${i.status}`)).toEqual(["12:30 PM confirmed", "7:00 PM cancelled", "8:00 PM confirmed"]);
    expect(j.items[0]).toMatchObject({ guestName: "Guest 02", partySize: 2, branch: { slug: "gurugram" }, phone: "+919800000002", note: "birthday" });
    expect(j.totals).toEqual({ confirmed: 2, covers: 6 });
    expect(j.branches.map((b: { slug: string }) => b.slug)).toEqual(["hauz-khas", "gurugram"]);
  });
  it("filters by date, branch and status", async () => {
    book("20:00", "9800000001");
    book("12:30", "9800000002", "gurugram", 2);
    expect((await (await list("branch=gurugram")).json()).items).toHaveLength(1);
    expect((await (await list("date=2026-10-18")).json()).items).toHaveLength(0);
    expect((await (await list("status=cancelled")).json()).items).toHaveLength(0);
    expect((await list("date=tomorrow")).status).toBe(400);
  });
  it("cancels idempotently, 404s unknown refs, and reopens the slot", async () => {
    const r = book("20:00", "9800000001", "hauz-khas", 7); // only T6 fits 7
    if (!("reservation" in r)) throw new Error("booking failed");
    const open = () => {
      const a = getAvailability({ branch: "hauz-khas", date: "2026-10-17", partySize: 7, time: "20:00" }, loadAvailabilityData(t.db, ["2026-10-17"]), NOW);
      return a.ok && a.slots.some((s) => s.time === "20:00");
    };
    expect(open()).toBe(false);
    const first = await cancel(r.reservation.ref);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ changed: true, reservation: { status: "cancelled" } });
    expect(await (await cancel(r.reservation.ref)).json()).toMatchObject({ changed: false });
    expect(open()).toBe(true);
    expect((await cancel("NE-00000000")).status).toBe(404);
    expect((await cancel(r.reservation.ref, { status: "confirmed" })).status).toBe(400);
  });
});
