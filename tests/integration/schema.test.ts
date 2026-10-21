import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb, type DB } from "@/lib/db/client";
import { migrate, MIGRATIONS_DIR } from "@/lib/db/migrate";
import { immediate } from "@/lib/db/tx";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { sqlError, tempDb } from "./helpers/db";

// The 30 behaviour checks from docs/research/2026-10-19-schema-check/, ported to better-sqlite3 13.0.3
// (bundled SQLite). They also pin the extended error codes the booking service maps (D-08; SQ-08 was Inferred).

const H = 3_600_000;
let t: ReturnType<typeof tempDb>;
let db: DB;
let ins: Database.Statement;

beforeEach(() => {
  t = tempDb("schema");
  db = t.db;
  db.exec(`INSERT INTO restaurant VALUES (1, 'Neem & Ember', 'Modern Indian', 'fictional');
    INSERT INTO branches (id, slug, name, address, phone) VALUES (1, 'hauz-khas', 'HK', 'a', '+911141550101'), (2, 'gurugram', 'GG', 'b', '+911244550202');
    INSERT INTO dining_tables (id, branch_id, label, min_seats, max_seats) VALUES (1, 1, 'T1', 1, 2), (2, 1, 'T5', 4, 6), (3, 2, 'T1', 1, 2);`);
  ins = db.prepare(`INSERT INTO reservations (id, ref, branch_id, table_id, guest_name, phone_e164, party_size, starts_at, ends_at, idempotency_key, request_hash, created_at)
    VALUES (@id, @ref, @branch, @table, @name, @phone, @party, @start, @end, @key, 'h', 0)`);
});
afterEach(() => t.cleanup());

const row = (o: Partial<Record<string, unknown>> = {}) => ({
  id: "r1", ref: "NE-AAAAAAA1", branch: 1, table: 2, name: "Asha", phone: "+919876543210", party: 4, start: 10 * H, end: 11.5 * H, key: "k1", ...o,
});

describe("connection settings (D-08)", () => {
  it("uses WAL, foreign keys and synchronous=FULL, and keeps them after reopening", () => {
    const check = (d: DB) => ({
      journal: d.pragma("journal_mode", { simple: true }),
      fk: d.pragma("foreign_keys", { simple: true }),
      sync: d.pragma("synchronous", { simple: true }),
      timeout: d.pragma("busy_timeout", { simple: true }),
    });
    expect(check(db)).toEqual({ journal: "wal", fk: 1, sync: 2, timeout: 5000 });
    db.close();
    const again = openDb(t.file);
    expect(check(again)).toEqual({ journal: "wal", fk: 1, sync: 2, timeout: 5000 });
    again.close();
  });
  it("bundles SQLite with FTS5 (D-02)", () => {
    expect((db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v).toMatch(/^3\.\d+/);
    expect(() => db.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(x)")).not.toThrow();
  });
});

describe("migrations", () => {
  it("records each migration once and is idempotent", () => {
    expect((db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map((r) => r.version)).toEqual(["001_init", "002_chat_turns_food", "003_staff_workspace", "004_bestseller"]);
    expect(migrate(db, 1)).toEqual([]);
  });
  it("002 keeps existing chat_turns rows and accepts the menu and recommend intents (D-20)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    fs.copyFileSync(path.join(MIGRATIONS_DIR, "001_init.sql"), path.join(dir, "001_init.sql"));
    const old = openDb(":memory:");
    migrate(old, 1, dir);
    old.prepare("INSERT INTO chat_turns (id, session_id, intent, outcome, created_at) VALUES ('a', 's', 'faq', 'faq_answer', 1)").run();
    expect(() => old.prepare("INSERT INTO chat_turns (id, session_id, intent, outcome, created_at) VALUES ('b', 's', 'recommend', 'recommend', 2)").run()).toThrow(/CHECK/);
    expect(migrate(old, 2)).toEqual(["002_chat_turns_food", "003_staff_workspace", "004_bestseller"]);
    old.prepare("INSERT INTO chat_turns (id, session_id, intent, outcome, created_at) VALUES ('b', 's', 'recommend', 'recommend', 2)").run();
    old.prepare("INSERT INTO chat_turns (id, session_id, intent, outcome, created_at) VALUES ('c', 's', 'menu', 'menu', 3)").run();
    expect(old.prepare("SELECT id, intent FROM chat_turns ORDER BY created_at").all()).toEqual([{ id: "a", intent: "faq" }, { id: "b", intent: "recommend" }, { id: "c", intent: "menu" }]);
    old.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("creates the seventeen tables and the FTS5 index (D-25 adds documents, passages, jobs, slot blocks and the change log)", () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kb_fts_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(["admin_changes", "app_meta", "branches", "chat_turns", "dining_tables", "fact_embeddings", "faq_entries", "hours_exceptions", "kb_chunks", "kb_documents", "kb_fts", "kb_jobs", "menu_items", "reservations", "restaurant", "schema_migrations", "service_hours", "slot_blocks"]);
  });
  it("003 on an existing seeded database keeps every row and fact, and gives the seeded FAQs their categories (D-25)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    for (const f of ["001_init.sql", "002_chat_turns_food.sql"]) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    const old = openDb(":memory:");
    migrate(old, 1, dir);
    const seed = parseSeed(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8")));
    // The pre-003 seed loader wrote FAQs without a category column; insert the same rows the old way.
    const id = (slug: string) => (old.prepare("SELECT id FROM branches WHERE slug = ?").get(slug) as { id: number } | undefined)?.id ?? null;
    for (const b of seed.branches) old.prepare("INSERT INTO branches (slug, name, address, phone, timezone, is_active) VALUES (?, ?, ?, ?, ?, 1)").run(b.slug, b.name, b.address, b.phone, b.timezone);
    for (const m of seed.menu) old.prepare("INSERT INTO menu_items (slug, category, name, description, price_inr, dietary, spice_level, branch_slugs, is_available) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(m.slug, m.category, m.name, m.description, m.priceInr, JSON.stringify(m.dietary), m.spiceLevel, m.branches ? JSON.stringify(m.branches) : null, m.isAvailable ? 1 : 0);
    for (const f of seed.faq) old.prepare("INSERT INTO faq_entries (slug, question, answer, branch_id) VALUES (?, ?, ?, ?)").run(f.slug, f.question, f.answer, f.branch ? id(f.branch) : null);
    expect(migrate(old, 2)).toEqual(["003_staff_workspace", "004_bestseller"]);
    // The same retrievable facts as a database built fresh from the same seed: 003 and 004 change no fact text.
    const fresh = openDb(":memory:");
    migrate(fresh, 2);
    applySeed(fresh, seed, { now: Date.parse("2026-10-16T14:00:00+05:30") });
    expect(renderKbFacts(loadFactSource(old))).toEqual(renderKbFacts(loadFactSource(fresh)));
    fresh.close();
    expect(old.prepare("SELECT count(*) AS n FROM menu_items WHERE is_listed = 1 AND created_by = 'seed' AND updated_at IS NULL").get()).toEqual({ n: 48 });
    expect(old.prepare("SELECT count(*) AS n FROM faq_entries WHERE category = 'general'").get()).toEqual({ n: 0 });
    // 004 (D-26): nothing is marked a bestseller until staff mark it, and only a marked dish's fact says so.
    expect(old.prepare("SELECT count(*) AS n FROM menu_items WHERE is_bestseller = 0").get()).toEqual({ n: 48 });
    expect(renderKbFacts(loadFactSource(old)).some((f) => /bestseller/i.test(f.text))).toBe(false);
    old.prepare("UPDATE menu_items SET is_bestseller = 1 WHERE slug = 'dal-ember'").run();
    expect(renderKbFacts(loadFactSource(old)).filter((f) => /bestseller/i.test(f.text)).map((f) => f.id)).toEqual(["menu:dal-ember"]);
    expect(() => old.prepare("UPDATE menu_items SET is_bestseller = 2 WHERE slug = 'dal-ember'").run()).toThrow(/CHECK/);
    old.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("overlap triggers and keys (G-1, G-4)", () => {
  it("accepts a valid booking", () => {
    expect(sqlError(() => ins.run(row()))).toBeNull();
  });
  it("rejects a table overlap with SQLITE_CONSTRAINT_TRIGGER 'TABLE_OVERLAP'", () => {
    ins.run(row());
    expect(sqlError(() => ins.run(row({ id: "r2", ref: "NE-AAAAAAA2", key: "k2", phone: "+919811111111", start: 11 * H, end: 12.5 * H })))).toEqual({ code: "SQLITE_CONSTRAINT_TRIGGER", message: "TABLE_OVERLAP" });
  });
  it("rejects the same guest on another table with 'GUEST_OVERLAP'", () => {
    ins.run(row());
    expect(sqlError(() => ins.run(row({ id: "r3", ref: "NE-AAAAAAA3", key: "k3", table: 1, party: 2, start: 11 * H, end: 12.5 * H })))).toEqual({ code: "SQLITE_CONSTRAINT_TRIGGER", message: "GUEST_OVERLAP" });
  });
  it("allows back-to-back sittings (half-open intervals)", () => {
    ins.run(row());
    expect(sqlError(() => ins.run(row({ id: "r4", ref: "NE-AAAAAAA4", key: "k4", start: 11.5 * H, end: 13 * H })))).toBeNull();
  });
  it("lets the guest trigger fire before UNIQUE on a same-key replay (SQ-24)", () => {
    ins.run(row());
    expect(sqlError(() => ins.run(row({ id: "r5", ref: "NE-AAAAAAA5" })))?.message).toBe("GUEST_OVERLAP");
  });
  it("reports a duplicate idempotency key as SQLITE_CONSTRAINT_UNIQUE", () => {
    ins.run(row());
    expect(sqlError(() => ins.run(row({ id: "r6", ref: "NE-AAAAAAA6", table: 1, party: 2, phone: "+919999999999", start: 50 * H, end: 51 * H })))).toEqual({
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "UNIQUE constraint failed: reservations.idempotency_key",
    });
  });
  it("reports a duplicate ref as SQLITE_CONSTRAINT_UNIQUE on reservations.ref", () => {
    ins.run(row());
    expect(sqlError(() => ins.run(row({ id: "r7", key: "k7", table: 1, party: 2, phone: "+919999999998", start: 60 * H, end: 61 * H })))).toEqual({
      code: "SQLITE_CONSTRAINT_UNIQUE",
      message: "UNIQUE constraint failed: reservations.ref",
    });
  });
  it("rejects a table from the other branch with SQLITE_CONSTRAINT_FOREIGNKEY", () => {
    expect(sqlError(() => ins.run(row({ table: 3, party: 2, start: 80 * H, end: 81 * H })))?.code).toBe("SQLITE_CONSTRAINT_FOREIGNKEY");
  });
  it("frees the slot when a booking is cancelled", () => {
    ins.run(row());
    db.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = 1 WHERE id = 'r1'").run();
    expect(sqlError(() => ins.run(row({ id: "r8", ref: "NE-AAAAAAA8", key: "k8", phone: "+919822222222" })))).toBeNull();
  });
  it("blocks re-confirming a cancelled booking into an overlap (update trigger)", () => {
    ins.run(row());
    db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = 'r1'").run();
    ins.run(row({ id: "r8", ref: "NE-AAAAAAA8", key: "k8", phone: "+919822222222" }));
    expect(sqlError(() => db.prepare("UPDATE reservations SET status = 'confirmed' WHERE id = 'r1'").run())).toEqual({ code: "SQLITE_CONSTRAINT_TRIGGER", message: "TABLE_OVERLAP" });
  });
  it("allows a primary-key change (update triggers exclude OLD.id)", () => {
    ins.run(row());
    expect(sqlError(() => db.prepare("UPDATE reservations SET id = 'r1b' WHERE id = 'r1'").run())).toBeNull();
  });
});

describe("STRICT reservations and CHECKs (D-14)", () => {
  it.each([
    ["a NULL id", { id: null }, "SQLITE_CONSTRAINT_NOTNULL"],
    ["a TEXT timestamp", { start: "2026-10-17T14:30:00.000Z" }, "SQLITE_CONSTRAINT_DATATYPE"],
    ["a spaced phone", { phone: "+91 98765 43213" }, "SQLITE_CONSTRAINT_CHECK"],
    ["a ref outside Crockford base32", { ref: "NE-7K3M9QIL" }, "SQLITE_CONSTRAINT_CHECK"],
    ["a 1-character name", { name: "A" }, "SQLITE_CONSTRAINT_CHECK"],
    ["party size 9", { party: 9 }, "SQLITE_CONSTRAINT_CHECK"],
    ["ends before it starts", { end: 9 * H }, "SQLITE_CONSTRAINT_CHECK"],
  ])("rejects %s", (_label, over, code) => {
    expect(sqlError(() => ins.run(row(over)))?.code).toBe(code);
  });
  it("rejects a 301-character note", () => {
    expect(sqlError(() => db.prepare("INSERT INTO reservations (id, ref, branch_id, table_id, guest_name, phone_e164, party_size, starts_at, ends_at, idempotency_key, request_hash, created_at, note) VALUES ('n', 'NE-AAAAAAAN', 1, 2, 'Asha', '+919876543210', 4, 0, 1, 'kn', 'h', 0, ?)").run("x".repeat(301)))?.code).toBe("SQLITE_CONSTRAINT_CHECK");
  });
});

describe("hours, menu, metrics and retrieval tables", () => {
  const err = (sql: string) => sqlError(() => db.exec(sql))?.code;
  it("rejects unpadded times and accepts a 24:00 close", () => {
    expect(err("INSERT INTO service_hours VALUES (1, 1, 'lunch', '9:00', '15:30')")).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(err("INSERT INTO service_hours VALUES (1, 2, 'dinner', '19:00', '24:00')")).toBeUndefined();
  });
  it("rejects impossible exception dates and whole-day openings", () => {
    expect(err("INSERT INTO hours_exceptions (branch_id, date, service, is_closed) VALUES (1, '2026-02-30', 'lunch', 1)")).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(err("INSERT INTO hours_exceptions (branch_id, date, service, is_closed, opens, closes) VALUES (1, '2026-10-22', NULL, 0, '12:00', '15:00')")).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(err("INSERT INTO hours_exceptions (branch_id, date, service, is_closed) VALUES (1, '2026-10-22', 'dinner', 1)")).toBeUndefined();
  });
  it("requires JSON diet tags", () => {
    expect(err("INSERT INTO menu_items (slug, category, name, description, price_inr, dietary) VALUES ('x', 'c', 'n', 'd', 100, 'vegan')")).toBe("SQLITE_CONSTRAINT_CHECK");
  });
  it("keeps one restaurant row", () => {
    expect(err("INSERT INTO restaurant VALUES (2, 'x', 'y', 'z')")).toBe("SQLITE_CONSTRAINT_CHECK");
  });
  it("enumerates chat_turns intent and outcome", () => {
    expect(err("INSERT INTO chat_turns (id, session_id, intent, outcome, created_at) VALUES ('t1', 's', 'faq', 'whatever', 0)")).toBe("SQLITE_CONSTRAINT_CHECK");
    expect(err("INSERT INTO chat_turns (id, session_id, intent, outcome, retrieval_mode, created_at) VALUES ('t2', 's', 'faq', 'faq_answer', 'hybrid', 0)")).toBeUndefined();
  });
  it("keys embeddings by model digest and checks the blob length", () => {
    const put = db.prepare("INSERT INTO fact_embeddings VALUES (?, 'qwen3-embedding:0.6b', ?, 'h', 4, ?, 0)");
    expect(sqlError(() => put.run("faq:pets", "ac6da0df", Buffer.alloc(16)))).toBeNull();
    expect(sqlError(() => put.run("faq:pets", "ffff0000", Buffer.alloc(16)))).toBeNull();
    expect(sqlError(() => put.run("faq:wifi", "ac6da0df", Buffer.alloc(15)))?.code).toBe("SQLITE_CONSTRAINT_CHECK");
  });
  it("answers a sanitised FTS5 query", () => {
    db.prepare("INSERT INTO kb_fts (fact_id, body) VALUES (?, ?)").run("faq:pets", "Q: Can I bring my dog? A: Well-behaved dogs are welcome on the terrace.");
    const hit = db.prepare("SELECT fact_id FROM kb_fts WHERE kb_fts MATCH ? ORDER BY bm25(kb_fts), fact_id").all('"bring" OR "dog"') as { fact_id: string }[];
    expect(hit[0]?.fact_id).toBe("faq:pets");
  });
});

describe("immediate() transaction helper (D-08)", () => {
  it("refuses to nest", () => {
    expect(() => immediate(db, () => immediate(db, () => 1))).toThrow(/already inside a transaction/);
  });
  it("rolls back on error", () => {
    expect(() =>
      immediate(db, () => {
        ins.run(row());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.prepare("SELECT count(*) AS n FROM reservations").get()).toEqual({ n: 0 });
  });
  it("rejects async callbacks at compile time and at runtime", () => {
    // @ts-expect-error an async callback must not type-check (NotPromise<Promise<…>> is never)
    expect(() => immediate(db, async () => ins.run(row()))).toThrow(/cannot return a promise/);
    expect(db.prepare("SELECT count(*) AS n FROM reservations").get()).toEqual({ n: 0 });
  });
});
