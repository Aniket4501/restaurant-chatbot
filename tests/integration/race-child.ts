import { randomUUID } from "node:crypto";
import { createReservation } from "@/lib/booking/create";
import { openDb } from "@/lib/db/client";
import { immediate } from "@/lib/db/tx";

// One racer in the AC-04 test. Opens its own connection, reports "ready", and on "go" tries to book the shared
// slot, either through the booking service ("service") or by inserting straight onto T5 to prove the trigger
// alone holds the invariant ("trigger").
// FM-012 (failure-mode audit): "replay" sends one shared idempotency key and body from every process (a retried
// submit); "same-guest" sends one guest's details with a new key each (a double tap that made new keys).
const [file, mode, idx, nowStr, startsAtStr, endsAtStr, sharedKey] = process.argv.slice(2);
const db = openDb(file);
const send = (m: unknown) => new Promise<void>((resolve) => process.send!(m, () => resolve()));

process.on("message", async (m: { type: string }) => {
  if (m.type !== "go") return;
  let result: { kind: "created" | "error"; status?: number; code?: string; message?: string; ref?: string };
  if (mode === "replay" || mode === "same-guest") {
    const r = createReservation(db, { branch: "hauz-khas", startsAt: Number(startsAtStr), partySize: 5, name: "Asha Rao", phone: "9876543210", email: null, note: null }, mode === "replay" ? sharedKey : randomUUID(), Number(nowStr));
    result = "reservation" in r ? { kind: "created", status: r.status, ref: r.reservation.ref } : { kind: "error", code: r.code };
  } else if (mode === "service") {
    const r = createReservation(
      db,
      { branch: "hauz-khas", startsAt: Number(startsAtStr), partySize: 5, name: `Racer ${idx}`, phone: `98${String(idx).padStart(8, "0")}`, email: null, note: null },
      randomUUID(),
      Number(nowStr),
    );
    result = "reservation" in r ? { kind: "created", status: r.status } : { kind: "error", code: r.code };
  } else {
    try {
      immediate(db, () =>
        db
          .prepare(`INSERT INTO reservations (id, ref, branch_id, table_id, guest_name, phone_e164, party_size, starts_at, ends_at, idempotency_key, request_hash, created_at)
            VALUES (?, ?, 1, (SELECT id FROM dining_tables WHERE branch_id = 1 AND label = 'T5'), ?, ?, 5, ?, ?, ?, 'h', 0)`)
          .run(randomUUID(), `NE-RACE${String(idx).padStart(4, "0")}`, `Racer ${idx}`, `+9198${String(idx).padStart(8, "0")}`, Number(startsAtStr), Number(endsAtStr), randomUUID()),
      );
      result = { kind: "created" };
    } catch (e) {
      const err = e as { code?: string; message: string };
      result = { kind: "error", code: err.code, message: err.message };
    }
  }
  const rows = (db.prepare("SELECT count(*) AS n FROM reservations WHERE status = 'confirmed'").get() as { n: number }).n;
  await send({ type: "done", result, rows });
  db.close();
  process.exit(0);
});

void send({ type: "ready" });
