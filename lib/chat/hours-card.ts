import { dateSpans } from "@/lib/chat/grounding";
import type { Block, Chip, HoursFocus, HoursSection } from "@/lib/chat/types";
import type { FactSource } from "@/lib/kb/facts";
import { formatPhone } from "@/lib/phone";
import { RULES } from "@/lib/config";
import { horizonDates } from "@/lib/time/calendar";
import { addLocalDays, dayKeyOf, dayLabel, isLocalDate, minutesOf, timeLabelOf, todayLocal, weekdayOf, type LocalDate } from "@/lib/time/tz";

// Opening-hours answers as a card (D-27). The question is read for its branch, date and meal; the rows come from the
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

export type HoursQuestion = {
  /** Branch slugs asked about; null when none is named or known (asked only if the branches' hours differ). */
  branches: string[] | null;
  /** The dates asked about (at most three, in order); none for the regular weekly hours. */
  dates: LocalDate[];
  /** A weekday asked about in general ("on Mondays"), for the weekly view. */
  weekday: number | null;
  meal: Service | null;
  /** "Open now?", "still open?" */
  now: boolean;
};

const short = (b: Branch) => b.name.split(", ").pop()!;

/** Branches named in the text, by name or slug ("Golf Course Road", "gurugram"; "Gurgaon" is the city's old name). */
export function branchesNamed(text: string, branches: Branch[]): string[] {
  const t = ` ${text.toLowerCase().replace(/\bgurgaon\b/g, "gurugram").replace(/[^a-z0-9]+/g, " ")} `;
  return branches.filter((b) => b.isActive && [short(b), b.slug.replace(/-/g, " ")].some((n) => t.includes(` ${n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `))).map((b) => b.slug);
}

/** The next date with this day of month (and month, if given) from today, or null if no such date. */
function resolveDay(span: { day: number; month: number | null }, today: LocalDate): LocalDate | null {
  const [y, m, d] = today.split("-").map(Number);
  const make = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-${String(span.day).padStart(2, "0")}`;
  const valid = (s: string) => isLocalDate(s) && new Date(`${s}T12:00:00Z`).getUTCDate() === span.day;
  if (span.month !== null) {
    const same = make(y, span.month);
    const pick = span.month > m || (span.month === m && span.day >= d) ? same : make(y + 1, span.month);
    return valid(pick) ? pick : null;
  }
  const pick = span.day >= d ? make(y, m) : m === 12 ? make(y + 1, 1) : make(y, m + 1);
  return valid(pick) ? pick : null;
}

/** What an hours question asks about. A follow-up ("what about Golf Course Road?", "and on the 22nd?") keeps the rest. */
export function readHoursQuestion(text: string, now: number, zone: string, branches: Branch[], o: { focus?: HoursFocus | null; draftBranch?: string | null } = {}): HoursQuestion {
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const today = todayLocal(now, zone);
  const named = branchesNamed(text, branches);
  const all = /\b(?:both|all|each|every|either)\s+(?:of\s+(?:your|the)\s+)?(?:branch|branches|location|locations|outlet|outlets|restaurants?)\b|\bboth\b/.test(t);
  const found: LocalDate[] = [];
  let weekday: number | null = null;
  const isNow = /\b(?:right now|open now|now open|still open|at the moment|currently open|open currently)\b/.test(t);
  if (isNow || /\b(?:today|tonight|this (?:evening|afternoon|morning))\b/.test(t)) found.push(today);
  if (/\bday after tomorrow\b/.test(t)) found.push(addLocalDays(today, 2, zone));
  else if (/\btomorrow\b/.test(t)) found.push(addLocalDays(today, 1, zone));
  for (const span of dateSpans(text)) {
    const d = resolveDay(span, today);
    if (d) found.push(d);
  }
  // "On Mondays" asks about a day of the week in general; "on Saturday", "this Sunday" mean the next one.
  const plural = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}s\\b`).test(t));
  WEEKDAYS.forEach((w, i) => {
    if (!new RegExp(`\\b${w}\\b`).test(t)) return;
    const diff = (i - weekdayOf(today, zone) + 7) % 7;
    const d = addLocalDays(today, new RegExp(`\\bnext\\s+${w}\\b`).test(t) && diff === 0 ? 7 : diff, zone);
    if (!found.includes(d)) found.push(d);
  });
  if (plural >= 0 && !found.length) weekday = plural;
  const dates = [...new Set(found)].sort().slice(0, 3);
  const meal: Service | null = /\blunch\b|\bafternoon\b/.test(t) ? "lunch" : /\bdinner\b|\bsupper\b|\btonight\b|\bevening\b/.test(t) ? "dinner" : null;
  const focus = o.focus ?? null;
  // The branch carries over from the last hours answer; the date only for a follow-up that names none ("what about
  // Golf Course Road?"), not for a new question ("what are your hours?").
  const followUp = /^(?:and|what about|how about|same for)\b/.test(t.trim()) || !/\b(?:hours|timings?|open|opens|opening|close|closes|closing)\b/.test(t);
  return {
    branches: all ? branches.filter((b) => b.isActive).map((b) => b.slug) : named.length ? named : focus?.branches.length ? focus.branches : o.draftBranch ? [o.draftBranch] : null,
    dates: dates.length ? dates : weekday === null && followUp && focus?.date ? [focus.date] : [],
    weekday,
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

/** Days of the week as a range or list: "every day", "Tuesday to Sunday", "Mondays". */
function daysText(days: number[]): string {
  if (days.length === 7) return "every day";
  if (days.length === 1) return PLURAL_DAY[days[0]];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const idx = days.map((d) => order.indexOf(d)).sort((a, b) => a - b);
  const name = (i: number) => WEEKDAYS[order[i]][0].toUpperCase() + WEEKDAYS[order[i]].slice(1);
  if (idx.every((v, i) => i === 0 || v === idx[i - 1] + 1) && idx.length >= 3) return `${name(idx[0])} to ${name(idx.at(-1)!)}`;
  return idx.map((i) => PLURAL_DAY[order[i]]).join(", ");
}

/** A branch's regular week as rows: each service's usual hours, with the days that differ as a note. */
function weekRows(src: FactSource, b: Branch, only: number | null): { rows: HoursSection["rows"]; subtitle: string } {
  const days = only === null ? [0, 1, 2, 3, 4, 5, 6] : [only];
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
  return { rows, subtitle: only !== null ? PLURAL_DAY[only] : rows.some((r) => r.note) ? "Regular weekly hours" : "Every day" };
}

const sameRows = (a: HoursSection["rows"], b: HoursSection["rows"]) => JSON.stringify(a) === JSON.stringify(b);
// The reply line names the day without calendar numbers (the card shows the date): every number in an hours reply must
// be in its cited facts (INV-05), and a weekly fact has no dates.
const when = (date: LocalDate, today: LocalDate, zone: string) => {
  const ahead = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  return ahead > 1 && ahead < 7 ? `on ${WEEKDAYS[weekdayOf(date, zone)][0].toUpperCase()}${WEEKDAYS[weekdayOf(date, zone)].slice(1)}` : "on that date";
};
const subtitleOf = (date: LocalDate, today: LocalDate, zone: string) => (date === today ? `Today, ${dayLabel(date, zone)}` : date === addLocalDays(today, 1, zone) ? `Tomorrow, ${dayLabel(date, zone)}` : dayLabel(date, zone));
const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export type HoursAnswer = { text: string; blocks: Block[]; cited: string[]; focus: HoursFocus; asked: boolean };

/** The answer to an hours question: a card per branch, or one question about the branch when it matters. */
export function hoursAnswer(q: HoursQuestion, src: FactSource, now: number, o: { known?: Set<string> } = {}): HoursAnswer {
  const active = src.branches.filter((b) => b.isActive);
  const zone = active[0]?.timezone ?? "Asia/Kolkata";
  const today = todayLocal(now, zone);
  const cited: string[] = [];
  const cite = (id: string) => (!o.known || o.known.has(id)) && !cited.includes(id) && cited.push(id);

  const sectionFor = (b: Branch, date: LocalDate | null): { section: HoursSection; day: ReturnType<typeof dayRows> | null } => {
    if (date) {
      const day = dayRows(src, b, date);
      cite(day.usedException ? `exception:${b.slug}:${date}` : `hours:${b.slug}:${dayKeyOf(date, b.timezone)}`);
      if (day.usedException) cite(`hours:${b.slug}:${dayKeyOf(date, b.timezone)}`);
      const rows = day.closedAllDay && day.rows.every((r) => r.value === "Closed") && day.special ? [{ label: "All day", value: "Closed", closed: true, note: day.rows.find((r) => r.note)?.note ?? null }] : day.rows.map((r) => ({ label: SERVICE_LABEL[r.service], value: r.value, closed: r.closed, note: r.note }));
      return { section: { branch: short(b), subtitle: subtitleOf(date, today, b.timezone), special: day.special ? "Special hours this day" : null, rows, note: null }, day };
    }
    for (const d of q.weekday !== null ? [q.weekday] : [0, 1, 2, 3, 4, 5, 6]) cite(`hours:${b.slug}:${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d]}`);
    const w = weekRows(src, b, q.weekday);
    // "On Saturdays": the usual Saturday, and a short note for a coming Saturday with special hours (that branch, the
    // booking horizon). A question about the whole week gets no special dates.
    let note: string | null = null;
    if (q.weekday !== null) {
      const coming = horizonDates(now, b.timezone, RULES.horizonDays).filter((d) => weekdayOf(d, b.timezone) === q.weekday && src.exceptions.some((e) => e.branchId === b.id && e.date === d));
      note = coming.length
        ? coming
            .map((d) => {
              cite(`exception:${b.slug}:${d}`);
              const r = dayRows(src, b, d);
              return `Special hours on ${dayLabel(d, b.timezone)}: ${r.closedAllDay ? "closed all day" : r.rows.filter((x) => x.value !== x.regular).map((x) => `${SERVICE_LABEL[x.service].toLowerCase()} ${x.value === "Closed" ? "closed" : x.value}${x.note ? ` (${x.note})` : ""}`).join("; ")}.`;
            })
            .join(" ")
        : null;
    }
    return { section: { branch: short(b), subtitle: w.subtitle, special: null, rows: w.rows, note }, day: null };
  };

  const asked = q.branches ? active.filter((b) => q.branches!.includes(b.slug)) : active;
  const focus: HoursFocus = { branches: q.branches ?? [], date: q.dates[0] ?? null };
  // A branch with no weekly hours on record: nothing to show and nothing to guess (no hours is not "closed").
  const missing = asked.filter((b) => !src.weekly.some((w) => w.branchId === b.id));
  if (missing.length) {
    for (const b of missing) cite(`branch:${b.slug}`);
    return { text: `${join(missing.map(short))} ${missing.length > 1 ? "don't" : "doesn't"} have opening hours on record yet, so I can't confirm them. Please call ${join(missing.map((b) => `${short(b)} on ${formatPhone(b.phone)}`))}.`, blocks: [], cited, focus, asked: false };
  }
  const days = q.dates.length ? q.dates : [null];
  const built = asked.flatMap((b) => days.map((d) => ({ b, date: d, ...sectionFor(b, d) })));
  const perBranch = (d: LocalDate | null) => built.filter((x) => x.date === d);

  // No branch named or known and the branches' hours differ for what was asked: one question, with each branch and
  // "both" as chips (the date is kept). Identical hours need no question.
  const combined = !q.branches && asked.length > 1;
  if (combined && days.some((d) => !perBranch(d).every((x) => sameRows(x.section.rows, perBranch(d)[0].section.rows) && x.section.note === null))) {
    const date = q.dates.length === 1 ? q.dates[0] : null;
    const chips: Chip[] = [
      ...active.map((b): Chip => ({ label: short(b), action: { type: "hours", branch: b.slug, ...(date ? { date } : {}) } })),
      { label: "Both branches", action: { type: "hours", branch: "all", ...(date ? { date } : {}) } },
    ];
    return { text: `Which branch? ${join(active.map(short))} keep different hours${date ? ` ${when(date, today, zone)}` : ""}.`, blocks: [{ type: "quick_replies", chips }], cited, focus, asked: true };
  }

  const sections = combined ? days.map((d) => ({ ...perBranch(d)[0].section, branch: "Both branches" })) : built.map((x) => x.section);
  const names = combined ? "both branches" : join(asked.map(short));
  const cap = (x: string) => x[0].toUpperCase() + x.slice(1);
  const plural = asked.length > 1;
  let text: string;
  if (q.dates.length > 1) {
    const dayInfo = built.map((x) => x.day!);
    text = dayInfo.some((d) => d.special) ? `${cap(names)} ${plural ? "have" : "has"} special hours on one of those days.` : `Here are the hours at ${names} for those days.`;
  } else if (!q.dates.length) text = q.weekday !== null ? `Here are the usual hours ${plural ? "at both branches" : `at ${names}`} on ${PLURAL_DAY[q.weekday]}.` : `Here are the regular opening hours ${plural ? "at both branches" : `at ${names}`}.`;
  else {
    const date = q.dates[0];
    const w = date === today && q.meal === "dinner" ? "tonight" : when(date, today, zone);
    const dayInfo = built.map((x) => x.day!);
    const be = plural ? "are" : "is";
    if (dayInfo.some((d) => d.rows.some((r) => r.value === UNCONFIRMED))) text = `The special hours ${w} aren't clear in our records, so please check with ${names} before you go.`;
    else if (dayInfo.every((d) => d.closedAllDay)) text = `${cap(names)} ${be} closed all day ${w}.`;
    else if (q.now && date === today) {
      const mins = minutesOf(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now));
      const openNow = (d: (typeof dayInfo)[number]) => d.rows.some((r) => !r.closed && /–/.test(r.value) && inRange(r.value, mins));
      const open = built.filter((x) => openNow(x.day!)).map((x) => short(x.b));
      text = open.length === built.length ? `Yes, ${names} ${be} open right now.` : open.length === 0 ? `${cap(names)} ${be} closed right now. ${plural ? "Their" : "Its"} hours for today are below.` : `${join(open)} is open right now; ${join(built.filter((x) => !open.includes(short(x.b))).map((x) => short(x.b)))} is closed.`;
    } else if (q.meal) {
      const open = dayInfo.every((d) => !d.rows.find((r) => r.service === q.meal)!.closed);
      const shut = dayInfo.every((d) => d.rows.find((r) => r.service === q.meal)!.closed);
      text = open ? `Yes, ${names} ${be} open for ${q.meal} ${w}.` : shut ? `${cap(names)} ${be} closed for ${q.meal} ${w}.` : `Here are the hours ${w}; ${q.meal} differs by branch.`;
    } else text = dayInfo.some((d) => d.special) ? `${cap(names)} ${plural ? "have" : "has"} special hours ${w}.` : `Here are the hours at ${names} ${w}.`;
  }
  return { text, blocks: [{ type: "hours", sections }], cited, focus, asked: false };
}

function inRange(range: string, mins: number): boolean {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM) – (\d{1,2}):(\d{2}) (AM|PM)$/.exec(range);
  if (!m) return false;
  const at = (h: string, mm: string, ap: string) => ((Number(h) % 12) + (ap === "PM" ? 12 : 0)) * 60 + Number(mm);
  const a = at(m[1], m[2], m[3]);
  let b = at(m[4], m[5], m[6]);
  if (b <= a) b += 1440; // closes after midnight
  return mins >= a && mins < b;
}
