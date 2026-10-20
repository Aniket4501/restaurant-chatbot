import type { Fact } from "@/lib/kb/facts";
import { DAY_KEYS, weekdayOf } from "@/lib/time/tz";

// Opening-hours answers (D-10). In probe v2 both models answered "open 7–11 PM" for a date whose exception closes
// dinner, citing the exception and the weekly fact, and said "yes" to a Monday lunch that the cited fact says is
// closed. So an FAQ answer that cites only branch/hours/exception facts is rendered from those facts, never from
// model prose, and an exception always supersedes the weekly hours for its weekday.

const HOURS_ID = /^hours:([a-z0-9-]+):(mon|tue|wed|thu|fri|sat|sun)$/;
const EXCEPTION_ID = /^exception:([a-z0-9-]+):(\d{4}-\d{2}-\d{2})$/;

export const isHoursFactId = (id: string) => /^(branch|hours|exception):/.test(id);

/** True if the answer cites at least one fact and only branch, hours or exception facts. */
export const isHoursOnly = (cited: string[]) => cited.length > 0 && cited.every(isHoursFactId);

/**
 * Drop `hours:<slug>:<weekday>` when an `exception:<slug>:<date>` on that weekday is also cited (D-10).
 * De-duplicates and keeps the cited order.
 */
export function supersede(cited: string[], zoneOf: (slug: string) => string): string[] {
  const exceptionDays = new Set<string>();
  for (const id of cited) {
    const m = EXCEPTION_ID.exec(id);
    if (m) exceptionDays.add(`${m[1]}:${DAY_KEYS[weekdayOf(m[2], zoneOf(m[1]))]}`);
  }
  return [...new Set(cited)].filter((id) => {
    const m = HOURS_ID.exec(id);
    return !m || !exceptionDays.has(`${m[1]}:${m[2]}`);
  });
}

/** A fact's text as the guest reads it: weekly facts lose the "see exception:…" pointers, exceptions read naturally. */
export function guestHoursText(f: Fact): string {
  if (f.kind === "hours") return f.text.replace(/ Except (.+)\.$/, (_m, list: string) => ` Special hours on ${list.split("; ").map((x) => x.split(": see ")[0]).join(" and ")}.`);
  if (f.kind === "exception") return f.text.replace(/^(.+?) on (.+?) \(special hours replacing the usual ones\): /, "Special hours at $1 on $2: ");
  return f.text;
}

/**
 * The guest-facing answer for an hours-only FAQ turn: the cited facts after `supersede`, in guest wording. A weekly
 * fact that names in-horizon exceptions is followed by those exceptions, so "hours on Thursdays" also says what
 * changes on Thu 22 Oct. Returns the fact IDs shown (for the info card and the trace).
 */
export function renderHoursAnswer(cited: string[], factsById: Map<string, Fact>, zoneOf: (slug: string) => string): { text: string; factIds: string[] } {
  const shown: string[] = [];
  const add = (id: string) => {
    if (factsById.has(id) && !shown.includes(id)) shown.push(id);
  };
  for (const id of supersede(cited, zoneOf)) {
    add(id);
    const f = factsById.get(id);
    if (f?.kind === "hours") for (const m of f.text.matchAll(/see (exception:[a-z0-9-]+:\d{4}-\d{2}-\d{2})/g)) add(m[1]);
  }
  return { text: shown.map((id) => guestHoursText(factsById.get(id)!)).join(" "), factIds: shown };
}
