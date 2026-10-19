import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { availabilityHandler } from "@/lib/api/availability";
import type { ApiDeps } from "@/lib/api/deps";
import { healthHandler } from "@/lib/api/health";
import { reservationsHandler } from "@/lib/api/reservations";
import { loadConfig } from "@/lib/config";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { createLimiter } from "@/lib/http/ratelimit";
import { toInstant } from "@/lib/time/tz";
import { tempDb } from "./helpers/db";

// §5.9 contracts through the real handlers (the route files only bind them to default deps).
const NOW = Date.parse("2026-10-16T14:00:00+05:30");
const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));
let t: ReturnType<typeof tempDb>;
let deps: ApiDeps;
let fetchImpl: typeof fetch;

beforeEach(() => {
  t = tempDb("api");
  applySeed(t.db, seed, { now: NOW });
  fetchImpl = (async () => Response.json({ models: [{ name: "qwen3.5:9b", digest: "d63f830f" }, { name: "qwen3-embedding:0.6b", digest: "ac6da0df" }] })) as typeof fetch;
  deps = {
    db: () => t.db,
    now: () => NOW,
    config: () => loadConfig({ DATABASE_PATH: path.join(os.tmpdir(), "x.db") }),
    fetch: (...a) => fetchImpl(...a),
    adminEnv: () => ({}),
    limits: { createsPerPhone: createLimiter({ limit: 5, windowMs: 60_000 }), createsGlobal: createLimiter({ limit: 30, windowMs: 60_000 }), adminLogin: createLimiter({ limit: 5, windowMs: 60_000 }) },
  };
});
afterEach(() => t.cleanup());

const get = (qs: string) => availabilityHandler(deps)(new Request(`http://127.0.0.1:3100/api/availability?${qs}`));
const post = (body: unknown, key: string | null = randomUUID(), headers: Record<string, string> = {}) =>
  reservationsHandler(deps)(
    new Request("http://127.0.0.1:3100/api/reservations", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const booking = (o: Record<string, unknown> = {}) => ({ branch: "hauz-khas", startsAt: toInstant("2026-10-17", "20:00", "Asia/Kolkata"), partySize: 4, name: "Asha Rao", phone: "98765 43210", ...o });

describe("GET /api/availability", () => {
  it("returns slots with ISO times in the branch offset and labels", async () => {
    const res = await get("branch=hauz-khas&date=2026-10-17&party=4&time=20:00");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = await res.json();
    expect(j.reason).toBeNull();
    expect(j.slots.map((s: { time: string }) => s.time)).toEqual(["19:00", "19:30", "20:00", "20:30", "21:00", "21:30"]);
    expect(j.slots.find((s: { time: string }) => s.time === "20:00")).toMatchObject({ startsAt: "2026-10-17T20:00:00+05:30", label: "8:00 PM", dateLabel: "Sat 17 Oct", service: "dinner" });
  });
  it.each([
    ["date=2026-02-30&branch=hauz-khas&party=2", "date"],
    ["branch=hauz-khas&date=2026-10-17&party=two", "party"],
    ["branch=hauz-khas&date=2026-10-17&party=2&time=8pm", "time"],
    ["branch=noida&date=2026-10-17&party=2", "branch"],
    ["branch=hauz-khas&date=2026-10-17&party=9", "party"],
    ["branch=hauz-khas&date=2026-12-31&party=2", "date"],
  ])("rejects %s with 400 VALIDATION on %s", async (qs, field) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error.code).toBe("VALIDATION");
    expect(Object.keys(j.error.fields)).toContain(field);
  });
});

describe("POST /api/reservations", () => {
  it("creates (201), replays (200) and never echoes the guest's phone or email", async () => {
    const key = randomUUID();
    const first = await post(booking({ email: "asha@example.com" }), key);
    expect(first.status).toBe(201);
    const j = await first.json();
    expect(j.reservation).toMatchObject({ status: "confirmed", startsAtIso: "2026-10-17T20:00:00+05:30", timeLabel: "8:00 PM", partySize: 4 });
    const text = JSON.stringify(j);
    expect(text).not.toContain("9876543210");
    expect(text).not.toContain("asha@example.com");
    const again = await post(booking({ email: "asha@example.com" }), key);
    expect(again.status).toBe(200);
    expect((await again.json()).reservation.ref).toBe(j.reservation.ref);
  });
  it("requires a UUID Idempotency-Key", async () => {
    const res = await post(booking(), null);
    expect(res.status).toBe(400);
    expect((await res.json()).error.fields).toEqual({ idempotencyKey: "must be a UUID" });
  });
  it("rejects non-JSON bodies, malformed JSON and bodies over 16 KB", async () => {
    expect((await post("branch=x", randomUUID(), { "content-type": "application/x-www-form-urlencoded" })).status).toBe(400);
    expect((await post("{not json", randomUUID())).status).toBe(400);
    expect((await post(booking({ note: "x".repeat(17_000) }))).status).toBe(413);
  });
  it("returns 422 for a reused key with a different body", async () => {
    const key = randomUUID();
    await post(booking(), key);
    const res = await post(booking({ partySize: 3 }), key);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_MISMATCH");
  });
  it("returns typed 409 bodies: SLOT_TAKEN with ISO alternatives, DUPLICATE_BOOKING with the existing booking", async () => {
    for (const phone of ["9800000001", "9800000002", "9800000003"]) expect((await post(booking({ phone }))).status).toBe(201);
    const taken = await (await post(booking({ phone: "9800000004" }))).json();
    expect(taken.error.code).toBe("SLOT_TAKEN");
    expect(taken.error.alternatives[0].startsAt).toMatch(/^2026-10-1\dT\d\d:\d\d:00\+05:30$/);
    const dup = await (await post(booking({ phone: "9800000001", name: "Asha Rao", startsAt: toInstant("2026-10-17", "20:30", "Asia/Kolkata") }))).json();
    expect(dup.error).toMatchObject({ code: "DUPLICATE_BOOKING", existing: { branch: "hauz-khas", label: "8:00 PM" } });
  });
  it("returns 409 SLOT_UNAVAILABLE with a reason", async () => {
    const res = await post(booking({ startsAt: toInstant("2026-10-22", "20:00", "Asia/Kolkata") }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "closed" });
  });
  it("limits creates to 5 per minute per phone (429 with retry-after)", async () => {
    for (let i = 0; i < 5; i++) await post(booking({ startsAt: toInstant("2026-10-18", "19:00", "Asia/Kolkata") }));
    const res = await post(booking({ startsAt: toInstant("2026-10-19", "19:00", "Asia/Kolkata") }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
  });
  it("applies the global cap across phones", async () => {
    deps.limits.createsGlobal = createLimiter({ limit: 2, windowMs: 60_000 });
    await post(booking({ phone: "9800000021" }));
    await post(booking({ phone: "9800000022" }));
    expect((await post(booking({ phone: "9800000023" }))).status).toBe(429);
  });
});

describe("GET /api/health", () => {
  it("reports DB, reachability and digests without secrets", async () => {
    const res = await healthHandler(deps)();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, db: { ok: true, schema: ["001_init"] }, model: { reachable: true, digests: { "qwen3.5:9b": "d63f830f" } } });
    expect(JSON.stringify(j)).not.toMatch(/ADMIN|SECRET|PASSWORD/i);
  });
  it("returns 503 when Ollama is unreachable", async () => {
    fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const res = await healthHandler(deps)();
    expect(res.status).toBe(503);
    expect((await res.json()).model.reachable).toBe(false);
  });
});
