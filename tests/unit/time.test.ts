import { describe, expect, it } from "vitest";
import { calendarLines, horizonDates, weekdayLines } from "@/lib/time/calendar";
import {
  addLocalDays,
  dayKeyOf,
  dayLabel,
  dayLabelLong,
  daysBetween,
  instantAtMinutes,
  isLocalDate,
  isLocalTime,
  localDateOf,
  localTimeOf,
  minutesOf,
  nowLine,
  timeLabel,
  timeLabelOf,
  timeOfMinutes,
  toInstant,
  todayLocal,
  weekdayOf,
} from "@/lib/time/tz";

// Runs unchanged under TZ=UTC and TZ=America/New_York (npm run test:unit:tz): every expectation below is
// about branch-local time, so the process zone must not matter (D-09).
const IST = "Asia/Kolkata";
const NOW = Date.parse("2026-10-16T14:05:00+05:30"); // Fri 16 Oct 2026, 2:05 PM IST (probe `now`)

describe("validation", () => {
  it.each(["2026-10-23", "2028-02-29", "2026-12-31"])("accepts date %s", (d) => expect(isLocalDate(d)).toBe(true));
  it.each(["2026-02-30", "2026-02-29", "2026-13-01", "2026-1-05", "tomorrow", "2026-10-23 ", "20261023", "2026-10-23T00:00", 20261023])(
    "rejects date %s",
    (d) => expect(isLocalDate(d)).toBe(false),
  );
  it.each(["00:00", "09:05", "23:59"])("accepts time %s", (t) => expect(isLocalTime(t)).toBe(true));
  it.each(["9:00", "24:00", "12:60", "7pm", "", "12:00:00"])("rejects time %s", (t) => expect(isLocalTime(t)).toBe(false));
  it("allows 24:00 only as a closing time in minutesOf", () => {
    expect(minutesOf("24:00")).toBe(1440);
    expect(minutesOf("19:30")).toBe(1170);
    expect(() => minutesOf("25:00")).toThrow(RangeError);
    expect(timeOfMinutes(1170)).toBe("19:30");
    expect(() => timeOfMinutes(1440)).toThrow(RangeError);
  });
  it("refuses to build an instant from an invalid date instead of rolling it over", () => {
    expect(() => toInstant("2026-02-30", "19:30", IST)).toThrow(RangeError);
  });
});

describe("instants and local dates", () => {
  it("builds the branch-local instant from parts (DT-01)", () => {
    expect(toInstant("2026-10-23", "19:30", IST)).toBe(1792764000000);
    expect(new Date(toInstant("2026-10-23", "19:30", IST)).toISOString()).toBe("2026-10-23T14:00:00.000Z");
    expect(instantAtMinutes("2026-10-23", 1170, IST)).toBe(1792764000000);
    expect(instantAtMinutes("2026-10-23", 1440, IST)).toBe(toInstant("2026-10-24", "00:00", IST));
  });
  it("derives today from an injected now (DT-07)", () => {
    expect(todayLocal(Date.parse("2026-10-19T20:00:00Z"), IST)).toBe("2026-10-20");
    expect(todayLocal(NOW, IST)).toBe("2026-10-16");
    expect(localTimeOf(NOW, IST)).toBe("14:05");
    expect(localDateOf(Date.parse("2026-10-16T18:29:59Z"), IST)).toBe("2026-10-16");
    expect(localDateOf(Date.parse("2026-10-16T18:30:00Z"), IST)).toBe("2026-10-17");
  });
  it("uses 0 = Sunday in the branch zone (DT-04)", () => {
    expect(weekdayOf("2026-10-23", IST)).toBe(5);
    expect(weekdayOf(localDateOf(Date.parse("2026-10-23T20:00:00Z"), IST), IST)).toBe(6);
    expect(dayKeyOf("2026-10-19", IST)).toBe("mon");
    expect(dayKeyOf("2026-10-18", IST)).toBe("sun");
  });
  it("adds days across month ends and over the US/UK DST weekends", () => {
    expect(addLocalDays("2026-10-31", 1, IST)).toBe("2026-11-01");
    expect(addLocalDays("2026-10-24", 2, IST)).toBe("2026-10-26");
    expect(addLocalDays("2026-10-31", 2, "America/New_York")).toBe("2026-11-02");
    expect(daysBetween("2026-10-16", "2026-11-15")).toBe(30);
  });
});

describe("labels", () => {
  it.each([
    ["19:30", "7:30 PM"],
    ["12:00", "12:00 PM"],
    ["00:30", "12:30 AM"],
    ["24:00", "12:00 AM"],
    ["23:00", "11:00 PM"],
  ])("formats %s as %s", (t, label) => expect(timeLabelOf(t)).toBe(label));
  it("formats instants and dates in the branch zone", () => {
    expect(timeLabel(1792764000000, IST)).toBe("7:30 PM");
    expect(dayLabel("2026-10-23", IST)).toBe("Fri 23 Oct");
    expect(dayLabelLong("2026-10-22", IST)).toBe("Thu 22 Oct 2026");
    expect(nowLine(NOW, IST)).toBe("Fri 16 Oct 2026, 2:05 PM, Asia/Kolkata");
  });
});

describe("calendar", () => {
  it("spans today plus 30 days (BR-06)", () => {
    const h = horizonDates(NOW, IST, 30);
    expect(h).toHaveLength(31);
    expect(h[0]).toBe("2026-10-16");
    expect(h[30]).toBe("2026-11-15");
  });
  it("renders the prompt calendar exactly as probe prompt v2 did", () => {
    const lines = calendarLines(NOW, IST);
    expect(lines).toHaveLength(31);
    expect(lines.slice(0, 3)).toEqual(["Fri 16 Oct = 2026-10-16 (today)", "Sat 17 Oct = 2026-10-17 (tomorrow)", "Sun 18 Oct = 2026-10-18"]);
    expect(lines[30]).toBe("Sun 15 Nov = 2026-11-15");
  });
});

describe("test:unit:tz harness", () => {
  it("runs in the process zone that TZ requested (forks pool)", () => {
    const offset = new Date(Date.parse("2026-10-16T12:00:00Z")).getTimezoneOffset();
    if (process.env.TZ === "UTC") expect(offset).toBe(0);
    if (process.env.TZ === "America/New_York") expect(offset).toBe(240);
  });
});

describe("DST-safe instants (review AV-4)", () => {
  it.each([
    ["Europe/London", "2026-10-25"],
    ["America/New_York", "2026-03-08"],
    ["America/New_York", "2026-11-01"],
  ])("builds %s %s wall-clock times from parts, not midnight + minutes", (zone, date) => {
    for (const time of ["12:00", "19:00", "23:30"]) {
      const at = instantAtMinutes(date, minutesOf(time), zone);
      expect(at).toBe(toInstant(date, time, zone));
      expect(localTimeOf(at, zone)).toBe(time);
      expect(localDateOf(at, zone)).toBe(date);
    }
  });
  it("rejects minutes outside 0–1440", () => {
    expect(() => instantAtMinutes("2026-10-17", 1441, IST)).toThrow(RangeError);
    expect(() => instantAtMinutes("2026-10-17", -1, IST)).toThrow(RangeError);
    expect(() => instantAtMinutes("2026-10-17", 1.5, IST)).toThrow(RangeError);
  });
});

describe("weekdayLines (prompt v4 weekday list)", () => {
  it("lists the first date after today for each weekday, from tomorrow, on the branch-local calendar", () => {
    // Sun 18 Oct 2026, 11:50 PM IST (18:20 UTC): tomorrow is Monday 19 Oct in Asia/Kolkata.
    const lines = weekdayLines(Date.parse("2026-10-18T18:20:00Z"), "Asia/Kolkata");
    expect(lines).toEqual(["Monday = 2026-10-19", "Tuesday = 2026-10-20", "Wednesday = 2026-10-21", "Thursday = 2026-10-22", "Friday = 2026-10-23", "Saturday = 2026-10-24", "Sunday = 2026-10-25"]);
  });
});
