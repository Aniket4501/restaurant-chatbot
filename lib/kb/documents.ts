import { createHash } from "node:crypto";
import { hasBookingStateWords } from "@/lib/chat/claims";
import { timeSpans } from "@/lib/kb/canonical";
import { neutralise } from "@/lib/llm/redact";

// Knowledge document ingestion (D-25): extract → normalise → chunk. Pure functions; lib/admin/knowledge.ts stores the
// result and records each stage, and the index refresher embeds the passages. Only plain text and Markdown are
// accepted: the project has no PDF or Word parser, and adding one would need an approved dependency.

export const DOC_TYPES = ["overview", "branch", "hours", "reservations", "cancellation", "menu", "payment", "faq", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_TYPE_LABEL: Record<DocType, string> = {
  overview: "Restaurant overview",
  branch: "Branch information",
  hours: "Opening hours",
  reservations: "Reservation policy",
  cancellation: "Cancellation and changes",
  menu: "Menu and dietary guidance",
  payment: "Payment and dining policy",
  faq: "Questions and answers",
  other: "Other",
};

export const DOC_LIMITS = {
  /** Upload size. */
  maxBytes: 256 * 1024,
  /** Normalised text. */
  maxChars: 60_000,
  minChars: 20,
  maxChunks: 80,
  /** Target passage length: short enough that 3 passages fit any turn's prompt budget. */
  chunkChars: 500,
  headingChars: 80,
} as const;

/** File types read reliably without new dependencies: UTF-8 plain text and Markdown. */
export const UPLOAD_TYPES: Record<string, { mime: string; markdown: boolean }> = {
  ".txt": { mime: "text/plain", markdown: false },
  ".md": { mime: "text/markdown", markdown: true },
  ".markdown": { mime: "text/markdown", markdown: true },
};
export const uploadTypeOf = (filename: string) => UPLOAD_TYPES[(/\.[a-z0-9]+$/i.exec(filename)?.[0] ?? "").toLowerCase()] ?? null;

export type StageResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Extraction: the file's bytes as text. Refuses anything that isn't valid UTF-8 or looks binary. */
export function extractText(bytes: Uint8Array): StageResult<string> {
  if (bytes.byteLength === 0) return { ok: false, error: "The file is empty." };
  if (bytes.byteLength > DOC_LIMITS.maxBytes) return { ok: false, error: `The file is ${Math.ceil(bytes.byteLength / 1024)} KB; the limit is ${DOC_LIMITS.maxBytes / 1024} KB.` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "The file isn't valid UTF-8 text. Save it as UTF-8 (plain text or Markdown) and upload it again." };
  }
  text = text.replace(/^\uFEFF/, "");
  const control = (text.match(/[\u0000-\u0008\u000E-\u001F\u007F]/g) ?? []).length;
  if (text.includes("\u0000") || control > Math.max(2, text.length * 0.01)) return { ok: false, error: "The file contains binary data, so it can't be read as text." };
  return { ok: true, value: text };
}

/**
 * Normalisation: NFKC, Unix line ends, no control characters, Markdown syntax reduced to its text (headings stay as
 * "#" lines for the chunker), HTML tags dropped, and < > neutralised so a document can't imitate the prompt's fences.
 */
export function normalizeText(raw: string, opts: { markdown: boolean }): StageResult<string> {
  let t = raw.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  t = t.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");
  if (opts.markdown) {
    t = t
      .replace(/^```.*$/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/gm, "$1$2")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "- ")
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
      .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/gm, "")
      .replace(/\|/g, " ");
  } else t = t.replace(/^#+(?=\s)/gm, (m) => m.replace(/#/g, "")); // a "#" in plain text is not a heading
  t = t.replace(/<\/?[a-z][^>\n]*>/gi, " ");
  t = neutralise(t);
  t = t
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (t.replace(/[#\s-]/g, "").length < DOC_LIMITS.minChars) return { ok: false, error: "The document has no readable text (it needs at least a sentence or two)." };
  if (t.length > DOC_LIMITS.maxChars) return { ok: false, error: `The document is ${t.length.toLocaleString("en-IN")} characters after tidying; the limit is ${DOC_LIMITS.maxChars.toLocaleString("en-IN")}. Split it into smaller documents.` };
  return { ok: true, value: t };
}

export type Chunk = { seq: number; heading: string | null; text: string; start: number; end: number };

type Para = { heading: string | null; text: string; start: number; end: number };

/** Paragraphs (blank-line separated, lines joined), each under its nearest "#" heading. Offsets are into `text`. */
function paragraphs(text: string): Para[] {
  const out: Para[] = [];
  let heading: string | null = null;
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  for (const m of text.matchAll(re)) {
    const block = m[0];
    const lines = block.split("\n");
    let offset = m.index;
    let buf: string[] = [];
    let bufStart = -1;
    const flush = (end: number) => {
      const joined = buf.join(" ").replace(/\s+/g, " ").trim();
      if (joined) out.push({ heading, text: joined, start: bufStart, end });
      buf = [];
      bufStart = -1;
    };
    for (const l of lines) {
      const h = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
      if (h) {
        flush(offset);
        heading = h[1].replace(/\s+/g, " ").slice(0, DOC_LIMITS.headingChars);
      } else {
        // List items become sentences of one passage: "- Free for children" → "Free for children;".
        const item = /^- (.*)$/.exec(l.trim());
        if (bufStart < 0) bufStart = offset;
        buf.push(item ? `${item[1].replace(/[.;,]?$/, ";")}` : l.trim());
      }
      offset += l.length + 1;
    }
    flush(m.index + block.length);
  }
  return out.map((p) => ({ ...p, text: p.text.replace(/;$/, ".") }));
}

/** Split text longer than `max` at sentence ends, then at word boundaries. */
function pieces(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?;])\s+/);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > max) {
      if (cur) out.push(cur);
      cur = "";
      let rest = s;
      while (rest.length > max) {
        const cut = rest.lastIndexOf(" ", max);
        const at = cut > max / 2 ? cut : max;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
    } else if ((cur ? `${cur} ${s}` : s).length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Chunking: paragraphs packed into passages of up to DOC_LIMITS.chunkChars characters, never across a heading, each a
 * single line (the prompt lists one fact per line). A passage keeps its section heading for context.
 */
export function chunkText(text: string): StageResult<Chunk[]> {
  const max = DOC_LIMITS.chunkChars;
  const chunks: Omit<Chunk, "seq">[] = [];
  let cur: Omit<Chunk, "seq"> | null = null;
  for (const p of paragraphs(text)) {
    for (const piece of pieces(p.text, max)) {
      if (cur && cur.heading === p.heading && cur.text.length + 1 + piece.length <= max) {
        cur.text = `${cur.text} ${piece}`;
        cur.end = p.end;
      } else {
        if (cur) chunks.push(cur);
        cur = { heading: p.heading, text: piece, start: p.start, end: p.end };
      }
    }
  }
  if (cur) chunks.push(cur);
  if (!chunks.length) return { ok: false, error: "No passages could be made from this document." };
  if (chunks.length > DOC_LIMITS.maxChunks) return { ok: false, error: `This document makes ${chunks.length} passages; the limit is ${DOC_LIMITS.maxChunks}. Split it into smaller documents.` };
  return { ok: true, value: chunks.map((c, i) => ({ ...c, seq: i + 1, end: Math.max(c.end, c.start + 1) })) };
}

export const contentHashOf = (content: string) => createHash("sha256").update(content).digest("hex");

/**
 * What staff should know about a document's text before relying on it (the chatbot's checks, D-11/D-15):
 * - times: opening hours come from Availability, so a document's times can contradict the hours answers;
 * - booking words: an answer sentence about booking, tables or confirmation is shown only if it copies a cited fact
 *   word for word, so paraphrased booking rules fall back to "I don't have that information".
 */
export function contentWarnings(text: string): string[] {
  const out: string[] = [];
  if (timeSpans(text).length) out.push("It mentions times. Opening hours and booking times come from Availability, so if they differ the chatbot can give conflicting answers.");
  if (hasBookingStateWords(text)) out.push("It talks about booking, tables or confirmations. The chatbot only shows such a sentence when it repeats the document word for word, so keep those sentences short and clear.");
  return out;
}
