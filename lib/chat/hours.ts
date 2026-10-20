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
export function renderHoursAnswer(cited: string[], factsById: Map<string, Fact>, zoneOf: (slug: string) => string, mentioned: (date: string) => boolean = () => true): { text: string; factIds: string[] } {
  const shown: string[] = [];
  const add = (id: string) => {
    if (factsById.has(id) && !shown.includes(id)) shown.push(id);
  };
  // An exception replaces its weekday's usual hours only when the guest asks about its date; "on Saturdays" in general
  // keeps the usual hours and lists the exception after them (D-21 audit: only the one-off 31 Oct hours were shown).
  const replacing = cited.filter((id) => {
    const m = EXCEPTION_ID.exec(id);
    return !m || mentioned(m[2]);
  });
  for (const id of supersede(replacing, zoneOf)) {
    add(id);
    const f = factsById.get(id);
    if (f?.kind === "hours") for (const m of f.text.matchAll(/see (exception:[a-z0-9-]+:\d{4}-\d{2}-\d{2})/g)) add(m[1]);
  }
  for (const id of cited) if (EXCEPTION_ID.test(id)) add(id);
  return { text: compact(shown, factsById), factIds: shown };
}

const DAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * The facts in guest wording, with a branch's weekly hours grouped by identical hours ("Hauz Khas, every day: …";
 * "Golf Course Road, Tuesday to Sunday: …; Monday: …") when three or more of its weekdays are shown (D-21: the full
 * week for both branches was 913 characters). Exceptions follow, once each.
 */
function compact(ids: string[], factsById: Map<string, Fact>): string {
  const weekly = new Map<string, { branch: string; day: string; hours: string }[]>();
  for (const id of ids) {
    const m = HOURS_ID.exec(id);
    const f = factsById.get(id)!;
    const parts = /^(.+?) on \w+: (.+?)(?: Except .+)?$/.exec(f.text);
    if (m && parts) weekly.set(m[1], [...(weekly.get(m[1]) ?? []), { branch: parts[1], day: m[2], hours: parts[2].replace(/\.$/, "") }]);
  }
  const grouped = new Set([...weekly].filter(([, days]) => days.length >= 3).map(([slug]) => slug));
  const out: string[] = [];
  const done = new Set<string>();
  for (const id of ids) {
    const m = HOURS_ID.exec(id);
    if (m && grouped.has(m[1])) {
      if (done.has(m[1])) continue;
      done.add(m[1]);
      const days = weekly.get(m[1])!;
      const byHours = new Map<string, string[]>();
      for (const d of [...days].sort((a, b) => WEEK.indexOf(a.day) - WEEK.indexOf(b.day))) byHours.set(d.hours, [...(byHours.get(d.hours) ?? []), d.day]);
      const groups = [...byHours].sort((a, b) => b[1].length - a[1].length).map(([hours, ds]) => `${dayRange(ds)}: ${hours}`);
      out.push(`${days[0].branch}, ${groups.join("; ")}.`);
    } else if (m) out.push(factsById.get(id)!.text.replace(/ Except .+$/, "")); // its exceptions follow in full
    else out.push(guestHoursText(factsById.get(id)!));
  }
  return out.join(" ");
}

function dayRange(days: string[]): string {
  if (days.length === 7) return "every day";
  const idx = days.map((d) => WEEK.indexOf(d)).sort((a, b) => a - b);
  // A run of consecutive days, also across the week's end ("Tuesday to Sunday").
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && idx.length >= 3) return `${DAY_NAMES[WEEK[idx[0]]]} to ${DAY_NAMES[WEEK[idx.at(-1)!]]}`;
  return idx.map((i) => DAY_NAMES[WEEK[i]]).join(", ");
}
