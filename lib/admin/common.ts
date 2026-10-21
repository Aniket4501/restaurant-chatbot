import { z } from "zod";
import type { DB } from "@/lib/db/client";
import type { ErrorCode } from "@/lib/booking/errors";
import { loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { rebuildLexical } from "@/lib/kb/index";

// Shared pieces of the staff workspace (D-25): a typed error the API maps to a response, the change log, and the one
// write path every edit of chatbot data goes through.

/** A refused staff action. The API turns it into `{ error: { code, message, ...extra } }` with this status. */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export const notFound = (what: string) => new AdminError(404, "NOT_FOUND", `${what} not found.`);

/** 400 with one message per field, from a zod error (first issue per top-level field). */
export function invalid(error: z.ZodError, message = "Please check the highlighted fields."): AdminError {
  const fields: Record<string, string> = {};
  for (const i of error.issues) fields[String(i.path[0] ?? "body")] ??= i.message;
  return new AdminError(400, "VALIDATION", message, { fields });
}

export const fieldError = (field: string, message: string) => new AdminError(400, "VALIDATION", message, { fields: { [field]: message } });

/** Parse with a zod schema or throw a 400. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(r.error);
  return r.data;
}

/** Single-line text as staff type it: NFKC, no control characters, whitespace collapsed, trimmed. */
export const oneLine = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A required single-line string between min and max characters (after tidying). */
export const line = (label: string, min: number, max: number) =>
  z
    .string({ error: `Enter ${label}` })
    .transform(oneLine)
    .pipe(
      z
        .string()
        .min(min, min <= 1 ? `Enter ${label}` : `${label[0].toUpperCase()}${label.slice(1)} needs at least ${min} characters`)
        .max(max, `${label[0].toUpperCase()}${label.slice(1)} can be up to ${max} characters`),
    );

/** "Dal Ember (half)" → "dal-ember-half". */
export function slugify(s: string, max = 60): string {
  const out = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return out || "item";
}

export type ChangeArea = "menu" | "faq" | "knowledge" | "hours" | "exceptions" | "blocks" | "tables" | "branches" | "restaurant" | "bookings";
export type Change = { area: ChangeArea; action: string; target: string; summary: string };

/** Append to the change log (inside the caller's transaction). Never pass guest names, phones or emails. */
export function logChange(db: DB, now: number, c: Change): void {
  db.prepare("INSERT INTO admin_changes (at, area, action, target, summary) VALUES (?, ?, ?, ?, ?)").run(now, c.area, c.action.slice(0, 40), c.target.slice(0, 120), c.summary.slice(0, 300));
}

export type ChangeRow = Change & { id: number; at: number };
export function recentChanges(db: DB, opts: { limit?: number; area?: ChangeArea; target?: string } = {}): ChangeRow[] {
  return db
    .prepare(`SELECT id, at, area, action, target, summary FROM admin_changes WHERE (? IS NULL OR area = ?) AND (? IS NULL OR target = ?) ORDER BY id DESC LIMIT ?`)
    .all(opts.area ?? null, opts.area ?? null, opts.target ?? null, opts.target ?? null, opts.limit ?? 20) as ChangeRow[];
}

/**
 * The write path for anything the chatbot reads (D-25): one IMMEDIATE transaction that applies the edit, logs it and,
 * when the retrievable facts may have changed, rebuilds the keyword index from the same snapshot before commit, so the
 * very next chat turn searches the new text. Embeddings are refreshed after commit by the index refresher.
 */
export function adminWrite<T>(db: DB, now: number, opts: { reindex: boolean }, fn: () => { result: T; change: Change | null }): T {
  if (db.inTransaction) throw new Error("adminWrite(): already inside a transaction");
  return db
    .transaction(() => {
      const { result, change } = fn();
      if (change) logChange(db, now, change);
      if (opts.reindex) rebuildLexical(db, renderKbFacts(loadFactSource(db)));
      return result;
    })
    .immediate();
}
