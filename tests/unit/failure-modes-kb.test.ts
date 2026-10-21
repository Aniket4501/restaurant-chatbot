import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSeed } from "@/lib/db/seed";
import { contentWarnings, normalizeText } from "@/lib/kb/documents";
import nextConfig, { UNLOGGED_REQUESTS } from "@/next.config";

// Failure-mode audit (evals/failure-modes.json): knowledge-base, seed and logging regressions. Deterministic: no model.
const ROOT = path.resolve(__dirname, "../..");
const BASE = JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"));

describe("failure modes: knowledge text and the seed", () => {
  it("FM-048 a markdown document with thousands of blank lines is tidied at once; table separators still go", () => {
    const t0 = performance.now();
    const r = normalizeText(`# Notes\n\nCorkage is ₹1,000 a bottle.${"\n".repeat(4000)}Last line of the notes.`, { markdown: true });
    expect(performance.now() - t0).toBeLessThan(500); // 11.7 s before the fix on this input
    expect(r).toMatchObject({ ok: true });
    const table = normalizeText("| Day | Hours |\n| --- | :---: |\n| Mon | Closed for the weekly rest day |", { markdown: true });
    expect(table.ok && table.value).not.toMatch(/---/);
  });
  it("FM-034 a seed dish outside the menu sections is refused before anything is written", () => {
    const bad = { ...BASE, menu: [{ ...BASE.menu[0], category: "soups" }, ...BASE.menu.slice(1)] };
    expect(() => parseSeed(bad)).toThrow();
    expect(() => parseSeed(BASE)).not.toThrow();
  });
  it("FM-051 a phone number or email that isn't a branch's is flagged; the branch's own number is not", () => {
    const own = ["+911141550101", "+911244550202"];
    const w = (t: string) => contentWarnings(t, own).filter((x) => /isn't a branch's/.test(x));
    expect(w("The Diwali party organiser is Rohan Mehta, mobile +91 98110 22334.")).toHaveLength(1);
    expect(w("Questions? Write to rohan.mehta@example.com.")[0]).toMatch(/an email address/);
    expect(w("Call Hauz Khas on +91 11 4155 0101 to book the terrace.")).toEqual([]);
  });
  it("FM-053 staff booking searches (guest names in the query) are not written to the dev request log", () => {
    const ignore = (nextConfig.logging as { incomingRequests?: { ignore?: RegExp[] } }).incomingRequests?.ignore ?? [];
    expect(ignore).toBe(UNLOGGED_REQUESTS);
    expect(ignore.some((r) => r.test("/api/admin/reservations?date=2026-10-17&branch=all&status=all&q=Asha+Rao"))).toBe(true);
    expect(ignore.some((r) => r.test("/api/chat"))).toBe(false);
  });
});
