import { describe, expect, it } from "vitest";
import { canonicalSpans, phonesIn, priceSpans, pricesIn, timesIn } from "@/lib/kb/canonical";

const set = <T>(...v: T[]) => new Set(v);

describe("times → minutes since midnight", () => {
  it("matches 12-hour and 24-hour spellings of the same time (§5.7)", () => {
    for (const s of ["11 PM", "11:00 pm", "23:00", "11pm", "11 p.m.", "11:00 P.M."]) expect(timesIn(s), s).toEqual(set(1380));
    expect(timesIn("7:30 PM")).toEqual(set(1170));
    expect(timesIn("12 am")).toEqual(set(0));
    expect(timesIn("12 pm")).toEqual(set(720));
    expect(timesIn("lunch 12:00 PM–3:30 PM; dinner 7:00 PM–11:00 PM")).toEqual(set(720, 930, 1140, 1380));
  });
  it("skips impossible values and words; time words are left for the D-15 word rule", () => {
    expect(timesIn("13 pm, 7:75 pm, 0 am, 24:00")).toEqual(set());
    expect(timesIn("at noon or midnight, half past seven")).toEqual(set());
    expect(timesIn("7 amazing dishes")).toEqual(set());
  });
});

describe("prices → whole rupees", () => {
  it("reads ₹, Rs, INR and rupees, with Western or Indian digit groups", () => {
    expect(pricesIn("₹645")).toEqual(set(645));
    expect(pricesIn("Rs. 420 or Rs.420 or rs 420")).toEqual(set(420));
    expect(pricesIn("420 rupees, INR 95, 95 INR")).toEqual(set(420, 95));
    expect(pricesIn("₹1,200 and ₹1,20,000")).toEqual(set(1200, 120000));
    expect(pricesIn("₹420.00")).toEqual(set(420));
    expect(pricesIn("₹420.50")).toEqual(set(420.5)); // never equals a whole-rupee fact price
  });
  it("ends a price before a trailing comma or full stop", () => {
    const text = "Dal Ember is ₹445, and naan ₹110.";
    expect(priceSpans(text).map((s) => text.slice(s.start, s.end))).toEqual(["₹445", "₹110"]);
  });
  it("ignores bare numbers (the residual digit rule handles them)", () => {
    expect(pricesIn("seats 16 guests")).toEqual(set());
  });
});

describe("phones → E.164", () => {
  it("normalises branch landlines and mobiles however they are written", () => {
    expect(phonesIn("+91 11 4155 0101")).toEqual(set("+911141550101"));
    expect(phonesIn("011 4155 0101")).toEqual(set("+911141550101"));
    expect(phonesIn("call +91 124 455 0202 today")).toEqual(set("+911244550202"));
    expect(phonesIn("98765 43210")).toEqual(set("+919876543210"));
  });
  it("falls back for other 10+ digit runs; shorter runs are not phones", () => {
    expect(phonesIn("ref 1234-5678-9012")).toEqual(set("+913456789012")); // last 10 digits
    expect(phonesIn("table 12, party of 6")).toEqual(set());
  });
});

describe("canonicalSpans", () => {
  it("returns non-overlapping spans in text order", () => {
    const text = "Call +91 11 4155 0101 before 7 PM; mains from ₹375.";
    const spans = canonicalSpans(text);
    expect(spans.map((s) => [s.kind, text.slice(s.start, s.end), s.value])).toEqual([
      ["phone", "+91 11 4155 0101", "+911141550101"],
      ["time", "7 PM", 1140],
      ["price", "₹375", 375],
    ]);
  });
});
