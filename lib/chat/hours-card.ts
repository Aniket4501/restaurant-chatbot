import { RULES } from "@/lib/config";
import { dateSpans } from "@/lib/chat/grounding";
import type { Block, Chip, HoursFocus, HoursSection } from "@/lib/chat/types";
import type { FactSource } from "@/lib/kb/facts";
import { formatPhone } from "@/lib/phone";
import { horizonDates } from "@/lib/time/calendar";
import { addLocalDays, dayKeyOf, dayLabel, dayLabelLong, isLocalDate, minutesOf, timeLabelOf, todayLocal, weekdayOf, type LocalDate } from "@/lib/time/tz";

// Opening-hours answers as a card (D-27). The question is read for its branch, dates and meal; the rows come from the
// structured weekly hours and the exceptions for that branch and date only (an exception never applies to another
// branch or date); the reply is a short line that answers the question without repeating the times. The model still
// decides that a message is an hours question (it cites hours facts); this module decides what to show. All date math
// is in the branch time zone, with `now` passed in.

type Branch = FactSource["branches"][number];
type Service = "lunch" | "dinner";
const SERVICES: Service[] = ["lunch", "dinner"];
const SERVICE_LABEL: Record<Service, string> = { lunch: "Lunch", dinner: "Dinner" };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const PLURAL_DAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const cap = (x: string) => x[0].toUpperCase() + x.slice(1);

export type HoursQuestion = {
  /** Branch slugs asked about; null when none is named or known (both are compared; asked only past two branches). */
  branches: string[] | null;
  /** The dates asked about (at most three, in order); none for the regular weekly hours. */
  dates: LocalDate[];
  /** Days of the week asked about in general ("on Mondays", "every Tuesday"), for the weekly view. */
  weekdays: number[];
  /** "This week": the weekly view, with the special hours of the next seven days noted. */
  week?: boolean;
  meal: Service | null;
  /** "Open now?", "still open?" */
  now: boolean;
};

const short = (b: Branch) => b.name.split(", ").pop()!;
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Branches named in the text: by name, slug, a unique first word of the name ("Golf Course", "Hauz"), or "Gurgaon"
 * (the city's old name). Active branches only.
 */
export function branchesNamed(text: string, branches: Branch[]): string[] {
  const t = ` ${words(text.replace(/\bgurgaon\b/gi, "gurugram"))} `;
  const active = branches.filter((b) => b.isActive);
  const first = (b: Branch) => words(short(b)).split(" ")[0];
  return active
    .filter((b) => {
      if ([short(b), b.slug.replace(/-/g, " ")].some((n) => t.includes(` ${words(n)} `))) return true;
      const f = first(b);
      return f.length >= 4 && active.filter((o) => first(o) === f).length === 1 && t.includes(` ${f} `);
    })
    .map((b) => b.slug);
}

/** The next date on or after today with this day of month (and month, if given), or null if there is none. */
function resolveDay(span: { day: number; month: number | null }, today: LocalDate): LocalDate | null {
  const [y, m, d] = today.split("-").map(Number);
  const make = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-${String(span.day).padStart(2, "0")}`;
  const valid = (s: string) => isLocalDate(s) && new Date(`${s}T12:00:00Z`).getUTCDate() === span.day;
  if (span.month !== null) {
    for (const yy of [y, y + 1]) {
      const pick = make(yy, span.month);
      if (valid(pick) && pick >= today) return pick;
    }
    return null;
  }
  // "The 31st": this month if still ahead, else the next month that has that day (review of D-27: it gave up).
  for (let i = 0; i < 12; i++) {
    const mm = ((m - 1 + i) % 12) + 1;
    const yy = y + Math.floor((m - 1 + i) / 12);
    const pick = make(yy, mm);
    if (valid(pick) && (i > 0 || span.day >= d)) return pick;
  }
  return null;
}

/** What an hours question asks about. A follow-up ("what about Golf Course Road?", "and on the 22nd?") keeps the rest. */
export function readHoursQuestion(text: string, now: number, zone: string, branches: Branch[], o: { focus?: HoursFocus | null; draftBranch?: string | null } = {}): HoursQuestion {
  // "Open 24/7?" is no date (review of D-27: it read as 24 July).
  const t = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\b24\s*[/x]\s*7\b/g, "all hours");
  const today = todayLocal(now, zone);
  const active = branches.filter((b) => b.isActive).map((b) => b.slug);
  const focusBranches = (o.focus?.branches ?? []).filter((s) => active.includes(s));
  const draftBranch = o.draftBranch && active.includes(o.draftBranch) ? o.draftBranch : null;
  let named = branchesNamed(t, branches);
  // "The other branch": the active branches the last answer wasn't about.
  if (!named.length && focusBranches.length && /\b(?:the )?other (?:branch|location|one|outlet|place|restaurant)\b/.test(t)) named = active.filter((s) => !focusBranches.includes(s));
  // "Both" or "all branches" only when no branch is named (review of D-27: "both" in any sense overrode a named one).
  const all = !named.length && /\b(?:both|all|each|every|either)\s+(?:of\s+(?:your|the)\s+)?(?:branch|branches|location|locations|outlet|outlets|restaurants?)\b|\bboth (?:are|open|of them)\b/.test(t);

  const explicit = dateSpans(t)
    .map((s) => resolveDay(s, today))
    .filter((d): d is LocalDate => d !== null);
  const found: LocalDate[] = [];
  const isNow = /\b(?:right now|open now|now open|still open|at the moment|currently open|open currently)\b/.test(t);
  if (isNow || /\b(?:today|tonight|this (?:evening|afternoon|morning))\b/.test(t)) found.push(today);
  if (/\bday after tomorrow\b/.test(t)) found.push(addLocalDays(today, 2, zone));
  else if (/\btomorrow\b/.test(t)) found.push(addLocalDays(today, 1, zone));
  if (/\bthis weekend\b/.test(t)) {
    const wd = weekdayOf(today, zone);
    for (const target of [6, 0]) {
      const diff = (target - wd + 7) % 7;
      if (wd === 0 && target === 6) continue; // on a Sunday, "this weekend" is today
      found.push(addLocalDays(today, diff, zone));
    }
  }
  found.push(...explicit);
  // "On Mondays", "every Tuesday": a day of the week in general. "On Saturday", "this Sunday", "next Tuesday": the next
  // one, unless a date given with it already is that day ("Saturday 31 October" is one date; review of D-27).
  const weekdays: number[] = [];
  WEEKDAYS.forEach((w, i) => {
    if (new RegExp(`\\b${w}s\\b|\\bevery ${w}\\b`).test(t)) weekdays.push(i);
    else if (new RegExp(`\\b${w}\\b`).test(t) && !explicit.some((d) => weekdayOf(d, zone) === i)) {
      const diff = (i - weekdayOf(today, zone) + 7) % 7;
      const d = addLocalDays(today, new RegExp(`\\bnext\\s+${w}\\b`).test(t) && diff === 0 ? 7 : diff, zone);
      if (!found.includes(d)) found.push(d);
    }
  });
  const dates = [...new Set(found)].sort().slice(0, 3);
  const meal: Service | null = /\blunch\b|\bafternoon\b/.test(t) ? "lunch" : /\bdinner\b|\bsupper\b|\btonight\b|\bevening\b/.test(t) ? "dinner" : null;
  // The branch carries over from the last hours answer; the date only for a follow-up that names none ("what about
  // Golf Course Road?"), not for a new question ("what are your hours?").
  const followUp = /^(?:and|what about|how about|same for)\b/.test(t.trim()) || !/\b(?:hours|timings?|open|opens|opening|close|closes|closing)\b/.test(t);
  const general = !dates.length && !weekdays.length;
  return {
    branches: all ? active : named.length ? named : focusBranches.length ? focusBranches : draftBranch ? [draftBranch] : null,
    dates: dates.length ? dates : general && followUp && o.focus?.date && isLocalDate(o.focus.date) ? [o.focus.date] : [],
    weekdays: dates.length ? [] : weekdays,
    week: general && /\bthis week\b/.test(t),
    meal,
    now: isNow,
  };
}

type DayRow = { service: Service; value: string; closed: boolean; regular: string; note: string | null };
const UNCONFIRMED = "Not confirmed";
const range = (opens: string | null, closes: string | null) => (opens && closes ? `${timeLabelOf(opens)} – ${timeLabelOf(closes)}` : null);

/** One branch's two services on one date: the weekly hours, replaced by that branch's exceptions for that date. */
function dayRows(src: FactSource, b: Branch, date: LocalDate): { rows: DayRow[]; closedAllDay: boolean; special: boolean; usedException: boolean } {
  const wd = weekdayOf(date, b.timezone);
  const exs = src.exceptions.filter((e) => e.branchId === b.id && e.date === date);
  const whole = exs.find((e) => e.service === null && e.isClosed);
  const rows = SERVICES.map((service): DayRow => {
    const w = src.weekly.find((x) => x.branchId === b.id && x.weekday === wd && x.service === service);
    const regular = w ? `${timeLabelOf(w.opens)} – ${timeLabelOf(w.closes)}` : "Closed";
    // Special hours that disagree for the same service (or a whole-day closure next to opening hours) are not
    // resolved by picking one: the row says the hours aren't confirmed.
    const mine = exs.filter((x) => x.service === service || x.service === null);
    const values = new Set(mine.map((x) => (x.isClosed ? "Closed" : (range(x.opens, x.closes) ?? regular))));
    if (values.size > 1) return { service, value: UNCONFIRMED, closed: false, regular, note: "Special hours for this day disagree; please check with the branch." };
    const e = whole ?? exs.find((x) => x.service === service);
    if (!e) return { service, value: regular, closed: !w, regular, note: null };
    const value = e.isClosed ? "Closed" : (range(e.opens, e.closes) ?? regular);
    // A note only where the hours change ("Regular lunch" on an unchanged row says nothing).
    return { service, value, closed: e.isClosed || value === "Closed", regular, note: value !== regular ? e.note : null };
  });
  return { rows, closedAllDay: rows.every((r) => r.closed), special: rows.some((r) => r.value !== r.regular), usedException: exs.length > 0 };
}

/** Days of the week as a range or list: "every day", "Tuesday to Sunday", "Mondays", "Saturdays and Sundays". */
function daysText(days: number[]): string {
  if (days.length === 7) return "every day";
  if (days.length === 1) return PLURAL_DAY[days[0]];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const idx = days.map((d) => order.indexOf(d)).sort((a, b) => a - b);
  const name = (i: number) => cap(WEEKDAYS[order[i]]);
  if (idx.every((v, i) => i === 0 || v === idx[i - 1] + 1) && idx.length >= 3) return `${name(idx[0])} to ${name(idx.at(-1)!)}`;
  return join(idx.map((i) => PLURAL_DAY[order[i]]));
}

/** A branch's regular week (or some days of it) as rows: each service's usual hours, the days that differ as a note. */
function weekRows(src: FactSource, b: Branch, days: number[]): { rows: HoursSection["rows"]; subtitle: string } {
  const rows = SERVICES.map((service) => {
    const byValue = new Map<string, number[]>();
    for (const d of days) {
      const w = src.weekly.find((x) => x.branchId === b.id && x.weekday === d && x.service === service);
      const v = w ? `${timeLabelOf(w.opens)} – ${timeLabelOf(w.closes)}` : "Closed";
      byValue.set(v, [...(byValue.get(v) ?? []), d]);
    }
    const [main, ...rest] = [...byValue].sort((a, b) => b[1].length - a[1].length);
    const note = rest.length ? rest.map(([v, ds]) => `${daysText(ds)}: ${v === "Closed" ? "closed" : v}`).join("; ") : null;
    return { label: SERVICE_LABEL[service], value: main[0], closed: main[0] === "Closed", note };
  });
  return { rows, subtitle: days.length < 7 ? daysText(days) : rows.some((r) => r.note) ? "Regular weekly hours" : "Every day" };
}

const sameRows = (a: HoursSection["rows"], b: HoursSection["rows"]) => JSON.stringify(a) === JSON.stringify(b);
// The reply line names the day without calendar numbers (the card shows the date): every number in an hours reply must
// be in its cited facts (INV-05), and a weekly fact has no dates.
const when = (date: LocalDate, today: LocalDate, zone: string) => {
  const ahead = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  return ahead > 1 && ahead < 7 ? `on ${cap(WEEKDAYS[weekdayOf(date, zone)])}` : "on that date";
};
// A date in another year shows the year: "20 October" asked on 22 Oct 2026 is answered for 2027 (failure-mode audit FM-035).
const subtitleOf = (date: LocalDate, today: LocalDate, zone: string) =>
  date === today ? `Today, ${dayLabel(date, zone)}` : date === addLocalDays(today, 1, zone) ? `Tomorrow, ${dayLabel(date, zone)}` : date.slice(0, 4) !== today.slice(0, 4) ? dayLabelLong(date, zone) : dayLabel(date, zone);
function join(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

export type HoursAnswer = { text: string; blocks: Block[]; cited: string[]; focus: HoursFocus; asked: boolean };

/**
 * The answer to an hours question: a card per branch (both, compactly, when none is known), or with more than two
 * branches whose hours differ, one question about the branch. `contact`: the guest also asked for an address or phone.
 */
export function hoursAnswer(q: HoursQuestion, src: FactSource, now: number, o: { known?: Set<string>; contact?: boolean } = {}): HoursAnswer {
  const active = src.branches.filter((b) => b.isActive);
  const zone = active[0]?.timezone ?? RULES.timezone;
  const today = todayLocal(now, zone);
  const cited: string[] = [];
  const cite = (id: string) => (!o.known || o.known.has(id)) && !cited.includes(id) && cited.push(id);
  const noteFor = (b: Branch, dates: LocalDate[]) =>
    dates
      .map((d) => {
        cite(`exception:${b.slug}:${d}`);
        const r = dayRows(src, b, d);
        return `Special hours on ${dayLabel(d, b.timezone)}: ${r.closedAllDay ? "closed all day" : r.rows.filter((x) => x.value !== x.regular).map((x) => `${SERVICE_LABEL[x.service].toLowerCase()} ${x.value === "Closed" ? "closed" : x.value}${x.note ? ` (${x.note})` : ""}`).join("; ")}.`;
      })
      .join(" ") || null;

  const sectionFor = (b: Branch, date: LocalDate | null): { section: HoursSection; day: ReturnType<typeof dayRows> | null } => {
    if (date) {
      const day = dayRows(src, b, date);
      cite(day.usedException ? `exception:${b.slug}:${date}` : `hours:${b.slug}:${dayKeyOf(date, b.timezone)}`);
      if (day.usedException) cite(`hours:${b.slug}:${dayKeyOf(date, b.timezone)}`);
      const rows = day.closedAllDay && day.rows.every((r) => r.value === "Closed") && day.special ? [{ label: "All day", value: "Closed", closed: true, note: day.rows.find((r) => r.note)?.note ?? null }] : day.rows.map((r) => ({ label: SERVICE_LABEL[r.service], value: r.value, closed: r.closed, note: r.note }));
      return { section: { branch: short(b), subtitle: subtitleOf(date, today, b.timezone), special: day.special ? "Special hours this day" : null, rows, note: null }, day };
    }
    const days = q.weekdays.length ? q.weekdays : [0, 1, 2, 3, 4, 5, 6];
    for (const d of days) cite(`hours:${b.slug}:${DAY_KEYS[d]}`);
    const w = weekRows(src, b, days);
    // "On Saturdays": the usual Saturday, and a note for a coming Saturday with special hours (that branch, the booking
    // horizon). "This week": the special hours of the next seven days. The whole week in general: no special dates.
    const coming = q.weekdays.length
      ? horizonDates(now, b.timezone, RULES.horizonDays).filter((d) => q.weekdays.includes(weekdayOf(d, b.timezone)))
      : q.week
        ? horizonDates(now, b.timezone, 7)
        : [];
    const note = noteFor(b, coming.filter((d) => src.exceptions.some((e) => e.branchId === b.id && e.date === d)));
    return { section: { branch: short(b), subtitle: w.subtitle, special: null, rows: w.rows, note }, day: null };
  };

  const asked = q.branches ? active.filter((b) => q.branches!.includes(b.slug)) : active;
  const focus: HoursFocus = { branches: q.branches ?? [], date: q.dates[0] ?? null };
  if (!asked.length) return { text: "That branch isn't open to guests at the moment.", blocks: [], cited, focus, asked: false };
  // A branch with no weekly hours on record: nothing to show and nothing to guess (no hours is not "closed").
  const missing = asked.filter((b) => !src.weekly.some((w) => w.branchId === b.id));
  if (missing.length) {
    for (const b of missing) cite(`branch:${b.slug}`);
    return { text: `${join(missing.map(short))} ${missing.length > 1 ? "don't" : "doesn't"} have opening hours on record yet, so I can't confirm them. Please call ${join(missing.map((b) => `${short(b)} on ${formatPhone(b.phone)}`))}.`, blocks: [], cited, focus, asked: false };
  }
  const days = q.dates.length ? q.dates : [null];
  const built = asked.flatMap((b) => days.map((d) => ({ b, date: d, ...sectionFor(b, d) })));
  const perBranch = (d: LocalDate | null) => built.filter((x) => x.date === d);
  const unknown = !q.branches && asked.length > 1;
  const identical = days.every((d) => perBranch(d).every((x) => sameRows(x.section.rows, perBranch(d)[0].section.rows) && x.section.note === null));

  // No branch known: with two branches, both are shown compactly (a comparison answers at once); past two whose hours
  // differ, one question with a chip per branch that keeps everything else asked (live LV-UX-002; review of D-27).
  if (unknown && !identical && active.length > 2) {
    const keep = { ...(q.dates.length ? { dates: q.dates } : {}), ...(q.weekdays.length ? { weekdays: q.weekdays } : {}), ...(q.meal ? { meal: q.meal } : {}) };
    const chips: Chip[] = [...active.map((b): Chip => ({ label: short(b), action: { type: "hours", branch: b.slug, ...keep } })), { label: "All branches", action: { type: "hours", branch: "all", ...keep } }];
    return { text: `Which branch? Our branches keep different hours.`, blocks: [{ type: "quick_replies", chips }], cited, focus, asked: true };
  }

  const combined = unknown && identical;
  const sections = combined ? days.map((d) => ({ ...perBranch(d)[0].section, branch: asked.length === 2 ? "Both branches" : "All branches" })) : built.map((x) => x.section);
  const names = combined ? (asked.length === 2 ? "both branches" : "all our branches") : join(asked.map(short));
  const plural = asked.length > 1;
  const be = plural ? "are" : "is";
  let text: string;
  if (q.dates.length > 1) {
    text = built.some((x) => x.day!.special) ? `${join([...new Set(built.filter((x) => x.day!.special).map((x) => short(x.b)))])} ${built.filter((x) => x.day!.special).length > 1 && plural ? "have" : "has"} special hours on one of those days.` : `Here are the hours at ${names} for those days.`;
  } else if (!q.dates.length) {
    const where = plural ? (combined ? `at ${names}` : "at both branches") : `at ${names}`;
    text = q.weekdays.length ? `Here are the usual hours ${where} on ${daysText(q.weekdays)}.` : q.week ? `Here are this week's hours ${where}.` : `Here are the regular opening hours ${where}.`;
  } else {
    const date = q.dates[0];
    const w = date === today && q.meal === "dinner" ? "tonight" : when(date, today, zone);
    const byBranch = asked.map((b) => ({ b, d: built.find((x) => x.b === b)!.day! }));
    const say = (pred: (d: (typeof byBranch)[number]["d"]) => boolean) => byBranch.filter((x) => pred(x.d)).map((x) => short(x.b));
    if (byBranch.some((x) => x.d.rows.some((r) => r.value === UNCONFIRMED))) text = `The special hours ${w} aren't clear in our records, so please check with ${join(say((d) => d.rows.some((r) => r.value === UNCONFIRMED)))} before you go.`;
    else if (q.now && date === today) {
      const mins = minutesOf(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now));
      // Open now: a service today, or last night's that runs past midnight.
      const yesterday = addLocalDays(today, -1, zone);
      const openNow = (b: Branch, d: (typeof byBranch)[number]["d"]) => d.rows.some((r) => !r.closed && inRange(r.value, mins)) || dayRows(src, b, yesterday).rows.some((r) => !r.closed && inRange(r.value, mins + 1440));
      const open = byBranch.filter((x) => openNow(x.b, x.d)).map((x) => short(x.b));
      text = open.length === asked.length ? `Yes, ${names} ${be} open right now.` : !open.length ? `${cap(names)} ${be} closed right now. ${plural ? "Their" : "Its"} hours for today are below.` : `${join(open)} is open right now; ${join(asked.map(short).filter((n) => !open.includes(n)))} is closed.`;
    } else if (byBranch.every((x) => x.d.closedAllDay)) text = `${cap(names)} ${be} closed all day ${w}.`;
    else if (q.meal) {
      const shut = say((d) => d.rows.find((r) => r.service === q.meal)!.closed);
      text = !shut.length ? `Yes, ${names} ${be} open for ${q.meal} ${w}.` : shut.length === asked.length ? `${cap(names)} ${be} closed for ${q.meal} ${w}.` : `${join(shut)} is closed for ${q.meal} ${w}; ${join(asked.map(short).filter((n) => !shut.includes(n)))} is open.`;
    } else {
      const closed = say((d) => d.closedAllDay);
      const special = say((d) => d.special && !d.closedAllDay);
      text = closed.length ? `${join(closed)} is closed all day ${w}.` : special.length ? `${join(special)} ${special.length > 1 ? "have" : "has"} special hours ${w}.` : `Here are the hours at ${names} ${w}.`;
    }
  }
  // Asked with an address or phone ("where is it and when do you open?"): those lines too, from the branch facts
  // (review of D-27: the hours card dropped them).
  if (o.contact) {
    const lines = asked.map((b) => {
      cite(`branch:${b.slug}`);
      return `${short(b)}: ${b.address}, ${formatPhone(b.phone)}.`;
    });
    text = `${text} ${lines.join(" ")}`;
  }
  return { text, blocks: [{ type: "hours", sections }], cited, focus, asked: false };
}

function inRange(value: string, mins: number): boolean {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM) – (\d{1,2}):(\d{2}) (AM|PM)$/.exec(value);
  if (!m) return false;
  const at = (h: string, mm: string, ap: string) => ((Number(h) % 12) + (ap === "PM" ? 12 : 0)) * 60 + Number(mm);
  const a = at(m[1], m[2], m[3]);
  let b = at(m[4], m[5], m[6]);
  if (b <= a) b += 1440; // closes after midnight
  return mins >= a && mins < b;
}
