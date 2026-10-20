import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminCancelHandler, adminListHandler, adminSessionHandlers } from "@/lib/api/admin";
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

// AC-07 (API part), BR-13, D-16. Admin handlers re-check the cookie themselves (no proxy in these tests).
const NOW = Date.parse("2026-10-17T10:00:00+05:30");
const ENV = { ADMIN_PASSWORD: "correct horse battery", ADMIN_SESSION_SECRET: "ab".repeat(32) };
const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));
let t: ReturnType<typeof tempDb>;
let deps: ApiDeps;
let env: Record<string, string | undefined>;

beforeEach(() => {
  t = tempDb("admin");
  applySeed(t.db, seed, { now: NOW });
  env = { ...ENV };
  deps = {
    db: () => t.db,
    now: () => NOW,
    config: () => loadConfig({ DATABASE_PATH: path.join(os.tmpdir(), "x.db") }),
    fetch: fetch,
    adminEnv: () => env,
    limits: { createsPerPhone: createLimiter({ limit: 100, windowMs: 60_000 }), createsGlobal: createLimiter({ limit: 100, windowMs: 60_000 }), adminLogin: createLimiter({ limit: 5, windowMs: 60_000 }) },
    chat: testChatDeps(),
  };
});
afterEach(() => t.cleanup());

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const signIn = async (password = ENV.ADMIN_PASSWORD) => adminSessionHandlers(deps).POST(new Request("http://127.0.0.1:3100/api/admin/session", json({ password })));
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const list = (qs: string, cookie?: string) => adminListHandler(deps)(new Request(`http://127.0.0.1:3100/api/admin/reservations?${qs}`, { headers: cookie ? { cookie } : {} }));
const cancel = (ref: string, cookie?: string, body: unknown = { status: "cancelled" }) =>
  adminCancelHandler(deps)(new Request(`http://127.0.0.1:3100/api/admin/reservations/${ref}`, { ...json(body, cookie ? { cookie } : {}), method: "PATCH" }), { params: Promise.resolve({ ref }) });
const book = (time: string, phone: string, branch = "hauz-khas", party = 4) =>
  createReservation(t.db, { branch, startsAt: toInstant("2026-10-17", time, "Asia/Kolkata"), partySize: party, name: `Guest ${phone.slice(-2)}`, phone, note: "birthday" }, randomUUID(), NOW);

describe("admin sign-in (D-16)", () => {
  it("is disabled with 503 until both secrets are configured", async () => {
    env = {};
    expect((await signIn()).status).toBe(503);
    env = { ...ENV, ADMIN_SESSION_SECRET: "replace-with-output-of-openssl-rand-hex-32" };
    expect((await signIn()).status).toBe(503);
    expect((await list("")).status).toBe(503);
  });
  it("rejects a wrong password and sets an HttpOnly SameSite=Strict cookie on the right one", async () => {
    expect((await signIn("wrong password!!")).status).toBe(401);
    const res = await signIn();
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/^ne_admin=[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/);
  });
  it("limits sign-in attempts to 5 per minute", async () => {
    for (let i = 0; i < 5; i++) await signIn("wrong password!!");
    const res = await signIn();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
  it("revokes the cookie on sign-out", async () => {
    const cookie = cookieOf(await signIn());
    expect((await list("", cookie)).status).toBe(200);
    const out = await adminSessionHandlers(deps).DELETE();
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await list("", cookie)).status).toBe(401);
  });
});

describe("admin reservations (AC-07, BR-13)", () => {
  it("requires the cookie", async () => {
    expect((await list("")).status).toBe(401);
    expect((await list("", "ne_admin=forged.value")).status).toBe(401);
    expect((await cancel("NE-00000000")).status).toBe(401);
  });
  it("lists today's bookings (branch zone) by time with name, time, party and status; totals count confirmed only", async () => {
    const cookie = cookieOf(await signIn());
    book("20:00", "9800000001");
    book("12:30", "9800000002", "gurugram", 2);
    const third = book("19:00", "9800000003");
    if ("reservation" in third) await cancel(third.reservation.ref, cookie);
    const res = await list("", cookie);
    const j = await res.json();
    expect(j.date).toBe("2026-10-17");
    expect(j.items.map((i: { timeLabel: string; status: string }) => `${i.timeLabel} ${i.status}`)).toEqual(["12:30 PM confirmed", "7:00 PM cancelled", "8:00 PM confirmed"]);
    expect(j.items[0]).toMatchObject({ guestName: "Guest 02", partySize: 2, branch: { slug: "gurugram" }, phone: "+919800000002", note: "birthday" });
    expect(j.totals).toEqual({ confirmed: 2, covers: 6 });
    expect(j.branches.map((b: { slug: string }) => b.slug)).toEqual(["hauz-khas", "gurugram"]);
  });
  it("filters by date, branch and status", async () => {
    const cookie = cookieOf(await signIn());
    book("20:00", "9800000001");
    book("12:30", "9800000002", "gurugram", 2);
    expect((await (await list("branch=gurugram", cookie)).json()).items).toHaveLength(1);
    expect((await (await list("date=2026-10-18", cookie)).json()).items).toHaveLength(0);
    expect((await (await list("status=cancelled", cookie)).json()).items).toHaveLength(0);
    expect((await list("date=tomorrow", cookie)).status).toBe(400);
  });
  it("cancels idempotently, 404s unknown refs, and reopens the slot", async () => {
    const cookie = cookieOf(await signIn());
    const r = book("20:00", "9800000001", "hauz-khas", 7); // only T6 fits 7
    if (!("reservation" in r)) throw new Error("booking failed");
    const open = () => {
      const a = getAvailability({ branch: "hauz-khas", date: "2026-10-17", partySize: 7, time: "20:00" }, loadAvailabilityData(t.db, ["2026-10-17"]), NOW);
      return a.ok && a.slots.some((s) => s.time === "20:00");
    };
    expect(open()).toBe(false);
    const first = await cancel(r.reservation.ref, cookie);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ changed: true, reservation: { status: "cancelled" } });
    expect(await (await cancel(r.reservation.ref, cookie)).json()).toMatchObject({ changed: false });
    expect(open()).toBe(true);
    expect((await cancel("NE-00000000", cookie)).status).toBe(404);
    expect((await cancel(r.reservation.ref, cookie, { status: "confirmed" })).status).toBe(400);
  });
});
