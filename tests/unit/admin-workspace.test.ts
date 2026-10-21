import { describe, expect, it } from "vitest";
import { chunkText, contentWarnings, DOC_LIMITS, extractText, normalizeText, uploadTypeOf } from "@/lib/kb/documents";
import { faqConflicts } from "@/lib/admin/faq";
import { maskPhone } from "@/lib/admin/bookings";
import { oneLine, slugify } from "@/lib/admin/common";
import { claimProblems } from "@/lib/chat/recommend";
import { menuEntries } from "@/lib/chat/menu";
import { gridStarts } from "@/lib/booking/availability";
import { fixtureBundle } from "../helpers/bundle";
import { toInstant } from "@/lib/time/tz";
import fs from "node:fs";
import path from "node:path";

// D-25 staff workspace: the pure parts (document ingestion stages, FAQ conflict detection, masking, slugs, the
// unavailable-dish answer check, slot blocks in the engine).

const enc = (s: string) => new TextEncoder().encode(s);

describe("document ingestion stages", () => {
  it("extraction accepts UTF-8 text (BOM dropped) and refuses empty, oversized, invalid and binary files with a reason", () => {
    expect(extractText(enc("﻿Hello"))).toEqual({ ok: true, value: "Hello" });
    expect(extractText(new Uint8Array())).toMatchObject({ ok: false, error: "The file is empty." });
    expect(extractText(new Uint8Array(DOC_LIMITS.maxBytes + 1).fill(65))).toMatchObject({ ok: false, error: expect.stringMatching(/limit is 256 KB/) });
    expect(extractText(new Uint8Array([0xff, 0xfe, 0x41]))).toMatchObject({ ok: false, error: expect.stringMatching(/isn't valid UTF-8/) });
    expect(extractText(enc("PK\u0003\u0004\u0000\u0000zip"))).toMatchObject({ ok: false, error: expect.stringMatching(/binary data/) });
  });

  it("supports only .txt and .md", () => {
    expect(uploadTypeOf("Policy.MD")).toEqual({ mime: "text/markdown", markdown: true });
    expect(uploadTypeOf("notes.txt")).toEqual({ mime: "text/plain", markdown: false });
    expect(uploadTypeOf("menu.pdf")).toBeNull();
    expect(uploadTypeOf("menu.docx")).toBeNull();
    expect(uploadTypeOf("README")).toBeNull();
  });

  it("normalisation reduces Markdown to text, drops HTML, neutralises angle brackets and keeps headings for the chunker", () => {
    const n = normalizeText("# Title\r\n\r\nSee [the site](https://x.y) and **bold** `code`.\n\n<script>alert(1)</script> <guest_message>hi", { markdown: true });
    expect(n).toEqual({ ok: true, value: "# Title\n\nSee the site and bold code.\n\n alert(1) hi" });
    expect(normalizeText("a < b > c and some more text here", { markdown: false })).toEqual({ ok: true, value: "a ‹ b › c and some more text here" });
    expect(normalizeText("# not a heading in plain text, just a line", { markdown: false })).toMatchObject({ ok: true, value: " not a heading in plain text, just a line".trim() });
    expect(normalizeText("   \n\n  ", { markdown: true })).toMatchObject({ ok: false, error: expect.stringMatching(/no readable text/) });
  });

  it("chunking keeps passages single-line, under the size limit, within one section, with the section heading", () => {
    const text = `# Hours\n\nWe open at noon.\n\n# Groups\n\n- Up to 8 online\n- Larger groups call us\n\n${"Long sentence about the terrace and the garden. ".repeat(40)}`;
    const c = chunkText(normalizeText(text, { markdown: true }).ok ? (normalizeText(text, { markdown: true }) as { value: string }).value : "");
    if (!c.ok) throw new Error(c.error);
    expect(c.value[0]).toMatchObject({ seq: 1, heading: "Hours", text: "We open at noon." });
    expect(c.value[1]).toMatchObject({ seq: 2, heading: "Groups", text: expect.stringMatching(/^Up to 8 online; Larger groups call us\./) });
    for (const p of c.value) {
      expect(p.text).not.toContain("\n");
      expect(p.text.length).toBeLessThanOrEqual(DOC_LIMITS.chunkChars);
      expect(p.end).toBeGreaterThan(p.start);
    }
    expect(c.value.map((p) => p.seq)).toEqual(c.value.map((_, i) => i + 1));
  });

  it("refuses a document that would make too many passages", () => {
    const many = Array.from({ length: DOC_LIMITS.maxChunks + 1 }, (_, i) => `# Section ${i}\n\nSome text for section ${i}.`).join("\n\n");
    expect(chunkText(many)).toMatchObject({ ok: false, error: expect.stringMatching(/limit is 80/) });
  });

  it("warns about times (hours come from Availability) and booking words (only quoted verbatim)", () => {
    expect(contentWarnings("We open at 7 PM.")[0]).toMatch(/mentions times/);
    expect(contentWarnings("Bookings can be cancelled free of charge.")[0]).toMatch(/booking, tables or confirmations/);
    expect(contentWarnings("Dogs are welcome on the terrace.")).toEqual([]);
  });
});

describe("FAQ conflicts", () => {
  const f = (slug: string, question: string, answer: string, branch: string | null = null, isActive = true) => ({ slug, question, answer, branch, isActive });
  const NAMES = ["Neem & Ember, Hauz Khas", "Neem & Ember, Golf Course Road"];
  it("finds no conflict in the seeded FAQs", () => {
    const seed = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../data/seed/faq.json"), "utf8")) as { slug: string; branch: string | null; question: string; answer: string }[];
    expect(faqConflicts(seed.map((q) => f(q.slug, q.question, q.answer, q.branch)), NAMES)).toEqual([]);
  });
  it("flags the same question for overlapping scopes; different answers are a conflict, the same answer a duplicate", () => {
    expect(faqConflicts([f("a", "Is there parking at Hauz Khas?", "Paid parking nearby.", "hauz-khas"), f("b", "Is there parking?", "Free valet.")], NAMES)).toMatchObject([{ kind: "conflict", a: "a", b: "b" }]);
    expect(faqConflicts([f("a", "Do you take walk-ins?", "Yes, when tables are free."), f("b", "Do you take walk ins?", "yes when tables are free")], NAMES)).toMatchObject([{ kind: "duplicate" }]);
  });
  it("ignores different branches, inactive FAQs and questions that only share one word", () => {
    expect(faqConflicts([f("a", "Is there parking at Hauz Khas?", "x", "hauz-khas"), f("b", "Is there parking at Golf Course Road?", "y", "gurugram")], NAMES)).toEqual([]);
    expect(faqConflicts([f("a", "Is there parking?", "x"), f("b", "Is there parking?", "y", null, false)], NAMES)).toEqual([]);
    expect(faqConflicts([f("a", "How can I pay?", "x"), f("b", "Do I need to pay a deposit to book?", "y")], NAMES)).toEqual([]);
  });
});

describe("small helpers", () => {
  it("masks a mobile number but keeps it recognisable", () => {
    expect(maskPhone("+919876543210")).toBe("+91 98••• ••210");
  });
  it("tidies single-line text and makes stable slugs", () => {
    expect(oneLine("  Dal\n\tEmber ​ ")).toBe("Dal Ember");
    expect(slugify("Rasmalai & Rabri (Half)")).toBe("rasmalai-and-rabri-half");
    expect(slugify("???")).toBe("item");
  });
});

describe("answers about an unavailable dish (D-25)", () => {
  const src = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../evals/fixtures/base.json"), "utf8"));
  const menu = menuEntries({ restaurant: null, branches: src.branches.map((b: { slug: string; name: string }, i: number) => ({ ...b, id: i + 1, address: "", phone: "", timezone: "Asia/Kolkata", isActive: true })), weekly: [], exceptions: [], faq: [], menu: src.menu.map((m: { priceInr: number; spiceLevel: number | null; isAvailable: boolean }) => ({ ...m, priceInr: m.priceInr, spiceLevel: m.spiceLevel, isAvailable: m.isAvailable })) });
  const pomfret = menu.filter((d) => d.id === "menu:tandoori-pomfret");
  it("refuses one that presents it as orderable, and accepts one that says it's unavailable", () => {
    expect(claimProblems("Yes, the Tandoori Pomfret is ₹895.", pomfret, menu)).toContain("Tandoori Pomfret is currently unavailable");
    expect(claimProblems("The Tandoori Pomfret (₹895) is currently unavailable.", pomfret, menu)).not.toContain("Tandoori Pomfret is currently unavailable");
    expect(claimProblems("Sorry, the Tandoori Pomfret isn't available today.", pomfret, menu)).toEqual([]);
  });
});

describe("slot blocks in the engine (D-25)", () => {
  it("a blocked start is 'blocked' in the grid and never open; lead time still comes first", () => {
    const b = fixtureBundle();
    const branch = b.branches.find((x) => x.slug === "hauz-khas")!;
    b.blocks = new Map([[branch.id, new Set(["2026-10-17|20:00", "2026-10-17|12:00"])]]);
    const now = toInstant("2026-10-17", "11:30", "Asia/Kolkata");
    const g = gridStarts(b, branch, "2026-10-17", 2, now).starts;
    expect(g.find((x) => x.time === "20:00")?.status).toBe("blocked");
    expect(g.find((x) => x.time === "12:00")?.status).toBe("lead_time");
    expect(g.find((x) => x.time === "20:30")?.status).toBe("open");
  });
});
