import { z } from "zod";
import type { DB } from "@/lib/db/client";
import { FAQ_CATEGORIES, slug as slugSchema, type FaqCategory } from "@/lib/db/seed-schema";
import { branchShortName, loadFactSource, renderKbFacts } from "@/lib/kb/facts";
import { contentHash } from "@/lib/kb/index";
import { STOPWORDS } from "@/lib/kb/retrieve";
import { contentWarnings } from "@/lib/kb/documents";
import { AdminError, adminWrite, fieldError, line, notFound, ownPhones, parse, recentChanges, slugify, type ChangeRow } from "@/lib/admin/common";

// FAQ management (D-25) on faq_entries, the table the chatbot's faq:<slug> facts come from. An FAQ is a curated
// question and answer; knowledge documents (lib/admin/knowledge.ts) are longer sources split into passages. Both are
// retrieved the same way. Inactive FAQs never reach the chatbot. Slugs never change: they are the fact IDs.

export const FAQ_CATEGORY_LABEL: Record<FaqCategory, string> = { bookings: "Bookings", food: "Food and drink", payment: "Payment", facilities: "Facilities", "house-rules": "House rules", general: "General" };

export type AdminFaq = {
  slug: string;
  question: string;
  answer: string;
  category: FaqCategory;
  categoryLabel: string;
  branch: string | null;
  branchLabel: string | null;
  isActive: boolean;
  createdBy: "seed" | "staff";
  updatedAt: number | null;
  order: number;
};

type Row = { id: number; slug: string; question: string; answer: string; branch_id: number | null; category: FaqCategory; is_active: number; created_by: "seed" | "staff"; updated_at: number | null };

const branchMaps = (db: DB) => {
  const rows = db.prepare("SELECT id, slug, name, is_active FROM branches ORDER BY id").all() as { id: number; slug: string; name: string; is_active: number }[];
  return { byId: new Map(rows.map((b) => [b.id, b])), bySlug: new Map(rows.map((b) => [b.slug, b])) };
};

function toFaq(r: Row, byId: Map<number, { slug: string; name: string }>): AdminFaq {
  const b = r.branch_id === null ? null : byId.get(r.branch_id) ?? null;
  return {
    slug: r.slug,
    question: r.question,
    answer: r.answer,
    category: r.category,
    categoryLabel: FAQ_CATEGORY_LABEL[r.category] ?? r.category,
    branch: b?.slug ?? null,
    branchLabel: b ? branchShortName(b.name) : null,
    isActive: r.is_active === 1,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    order: r.id,
  };
}

// ---------- duplicates and conflicts ----------

const BRANCH_WORDS = (names: string[]) => new Set(names.flatMap((n) => (n.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1)).concat(["branch", "branches", "restaurant", "neem", "ember"]));
const tokensOf = (q: string, skip: Set<string>) => new Set((q.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t) && !skip.has(t)));
const sameAnswer = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export type FaqConflict = { kind: "duplicate" | "conflict"; a: string; b: string; message: string };

/**
 * Active FAQs that ask the same thing for overlapping scopes (both global, the same branch, or one global and one
 * branch). Same question words (branch names and stopwords aside) or at least two shared words covering 75% of the
 * shorter question. Different answers are a conflict for staff to resolve; nothing is resolved automatically.
 */
export function faqConflicts(faqs: Pick<AdminFaq, "slug" | "question" | "answer" | "branch" | "isActive">[], branchNames: string[]): FaqConflict[] {
  const skip = BRANCH_WORDS(branchNames);
  const active = faqs.filter((f) => f.isActive).map((f) => ({ ...f, toks: tokensOf(f.question, skip) }));
  const out: FaqConflict[] = [];
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.branch && b.branch && a.branch !== b.branch) continue;
      if (!a.toks.size || !b.toks.size) continue;
      const shared = [...a.toks].filter((t) => b.toks.has(t)).length;
      const equal = shared === a.toks.size && shared === b.toks.size;
      if (!equal && !(shared >= 2 && shared / Math.min(a.toks.size, b.toks.size) >= 0.75)) continue;
      const dup = sameAnswer(a.answer, b.answer);
      out.push({ kind: dup ? "duplicate" : "conflict", a: a.slug, b: b.slug, message: dup ? `"${a.question}" and "${b.question}" give the same answer: keep one.` : `"${a.question}" and "${b.question}" look like the same question with different answers. The chatbot may use either; edit or deactivate one.` });
    }
  return out;
}

// ---------- reads ----------

export function listFaqs(db: DB): { items: AdminFaq[]; conflicts: FaqConflict[]; counts: { total: number; active: number; inactive: number } } {
  const { byId } = branchMaps(db);
  const items = (db.prepare("SELECT * FROM faq_entries ORDER BY id").all() as Row[]).map((r) => toFaq(r, byId));
  const conflicts = faqConflicts(items, [...byId.values()].map((b) => b.name));
  return { items, conflicts, counts: { total: items.length, active: items.filter((i) => i.isActive).length, inactive: items.filter((i) => !i.isActive).length } };
}

export type FaqDetail = {
  faq: AdminFaq;
  fact: { id: string; text: string } | null;
  index: { keyword: "current" | "stale" | "missing" | "not_indexed"; vector: "current" | "stale" | "missing" | "not_indexed" | "unknown" };
  warnings: string[];
  conflicts: FaqConflict[];
  changes: ChangeRow[];
};

/** `digest`: the embedding model in use (null when it didn't answer). */
export function faqDetail(db: DB, slug: string, digest: string | null): FaqDetail {
  const { byId } = branchMaps(db);
  const r = db.prepare("SELECT * FROM faq_entries WHERE slug = ?").get(slug) as Row | undefined;
  if (!r) throw notFound("FAQ");
  const faq = toFaq(r, byId);
  const fact = renderKbFacts(loadFactSource(db)).find((f) => f.id === `faq:${slug}`) ?? null;
  let keyword: FaqDetail["index"]["keyword"] = "not_indexed";
  let vector: FaqDetail["index"]["vector"] = "not_indexed";
  if (fact) {
    const fts = db.prepare("SELECT body FROM kb_fts WHERE fact_id = ?").get(fact.id) as { body: string } | undefined;
    keyword = !fts ? "missing" : fts.body === fact.text.normalize("NFKC") ? "current" : "stale";
    // Only vectors from the embedding model in use count (failure-mode audit FM-032: an old model's vector showed
    // "current" while retrieval was keyword-only); with no answer from the model the state is unknown.
    const rows = digest === null ? [] : (db.prepare("SELECT content_hash FROM fact_embeddings WHERE fact_id = ? AND model_digest = ?").all(fact.id, digest) as { content_hash: string }[]);
    vector = digest === null ? "unknown" : rows.length === 0 ? "missing" : rows.some((x) => x.content_hash === contentHash(fact)) ? "current" : "stale";
  }
  return {
    faq,
    fact: fact ? { id: fact.id, text: fact.text } : null,
    index: { keyword, vector },
    warnings: contentWarnings(faq.answer, ownPhones(db)),
    conflicts: listFaqs(db).conflicts.filter((c) => c.a === slug || c.b === slug),
    changes: recentChanges(db, { area: "faq", target: slug, limit: 10 }),
  };
}

// ---------- writes ----------

const Fields = {
  question: line("a question", 5, 200),
  answer: line("an answer", 2, 500),
  category: z.enum(FAQ_CATEGORIES, { error: "Choose a category" }),
  branch: slugSchema.nullable(),
  isActive: z.boolean(),
};
export const FaqCreateSchema = z.strictObject({ ...Fields, isActive: Fields.isActive.default(true) });
export const FaqPatchSchema = z.strictObject({
  question: Fields.question.optional(),
  answer: Fields.answer.optional(),
  category: Fields.category.optional(),
  branch: Fields.branch.optional(),
  isActive: Fields.isActive.optional(),
});

function branchIdOf(db: DB, slug: string | null): number | null {
  if (slug === null) return null;
  const b = db.prepare("SELECT id, is_active FROM branches WHERE slug = ?").get(slug) as { id: number; is_active: number } | undefined;
  if (!b || b.is_active !== 1) throw fieldError("branch", `Unknown or inactive branch: ${slug}`);
  return b.id;
}

const normQ = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function createFaq(db: DB, now: number, raw: unknown): AdminFaq {
  const input = parse(FaqCreateSchema, raw);
  return adminWrite(db, now, { reindex: true }, () => {
    const branchId = branchIdOf(db, input.branch);
    // A repeated submit is refused, never stored twice: the same question for the same scope already exists.
    const existing = (db.prepare("SELECT slug, question FROM faq_entries WHERE branch_id IS ?").all(branchId) as { slug: string; question: string }[]).find((f) => normQ(f.question) === normQ(input.question));
    if (existing) throw new AdminError(409, "CONFLICT", "This question is already in the FAQs for that scope.", { existing: existing.slug });
    let slug = slugify(input.question);
    if (db.prepare("SELECT 1 FROM faq_entries WHERE slug = ?").get(slug)) {
      let n = 2;
      while (db.prepare("SELECT 1 FROM faq_entries WHERE slug = ?").get(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    db.prepare("INSERT INTO faq_entries (slug, question, answer, branch_id, category, is_active, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'staff', ?)").run(slug, input.question, input.answer, branchId, input.category, input.isActive ? 1 : 0, now);
    const faq = toFaq(db.prepare("SELECT * FROM faq_entries WHERE slug = ?").get(slug) as Row, branchMaps(db).byId);
    return { result: faq, change: { area: "faq", action: "created", target: slug, summary: `Added "${faq.question}"${faq.isActive ? "" : " (inactive)"}` } };
  });
}

export function updateFaq(db: DB, now: number, slug: string, raw: unknown): { faq: AdminFaq; changed: boolean; summary: string } {
  const patch = parse(FaqPatchSchema, raw);
  return adminWrite<{ faq: AdminFaq; changed: boolean; summary: string }>(db, now, { reindex: true }, () => {
    const row = db.prepare("SELECT * FROM faq_entries WHERE slug = ?").get(slug) as Row | undefined;
    if (!row) throw notFound("FAQ");
    const { byId } = branchMaps(db);
    const before = toFaq(row, byId);
    const branchId = patch.branch === undefined ? row.branch_id : branchIdOf(db, patch.branch);
    const next = { question: patch.question ?? row.question, answer: patch.answer ?? row.answer, category: patch.category ?? row.category, branchId, isActive: patch.isActive ?? row.is_active === 1 };
    if (patch.question !== undefined || patch.branch !== undefined) {
      const clash = (db.prepare("SELECT slug, question FROM faq_entries WHERE branch_id IS ? AND slug <> ?").all(branchId, slug) as { slug: string; question: string }[]).find((f) => normQ(f.question) === normQ(next.question));
      if (clash) throw new AdminError(409, "CONFLICT", "Another FAQ already asks this question for that scope.", { existing: clash.slug });
    }
    const parts: string[] = [];
    if (next.question !== row.question) parts.push("question");
    if (next.answer !== row.answer) parts.push("answer");
    if (next.category !== row.category) parts.push(`category ${FAQ_CATEGORY_LABEL[row.category]} → ${FAQ_CATEGORY_LABEL[next.category]}`);
    if (next.branchId !== row.branch_id) parts.push("scope");
    if (next.isActive !== (row.is_active === 1)) parts.push(next.isActive ? "activated" : "deactivated");
    const summary = parts.join("; ") || "no change";
    if (!parts.length) return { result: { faq: before, changed: false, summary }, change: null };
    db.prepare("UPDATE faq_entries SET question = ?, answer = ?, category = ?, branch_id = ?, is_active = ?, updated_at = ? WHERE slug = ?").run(next.question, next.answer, next.category, next.branchId, next.isActive ? 1 : 0, now, slug);
    const faq = toFaq(db.prepare("SELECT * FROM faq_entries WHERE slug = ?").get(slug) as Row, byId);
    const action = parts.length === 1 && (parts[0] === "activated" || parts[0] === "deactivated") ? parts[0] : "edited";
    return { result: { faq, changed: true, summary }, change: { area: "faq", action, target: slug, summary: `"${faq.question}": ${summary}` } };
  });
}
