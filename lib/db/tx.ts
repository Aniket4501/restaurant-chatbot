import type { DB } from "@/lib/db/client";

type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Run `fn` in one BEGIN IMMEDIATE transaction (D-08). The write lock is taken up front, so a racing
 * writer waits up to the busy timeout instead of failing with SQLITE_BUSY_SNAPSHOT on upgrade (SQ-62).
 * - Refuses to nest: inside a transaction, better-sqlite3 turns .immediate() into a SAVEPOINT (SQ-04).
 * - The callback must be synchronous: an async callback doesn't type-check, and at runtime better-sqlite3
 *   throws and rolls back (SQ-05).
 */
export function immediate<T>(db: DB, fn: () => NotPromise<T>): NotPromise<T> {
  if (db.inTransaction) throw new Error("immediate(): already inside a transaction");
  return db.transaction(fn).immediate();
}
