import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ApiDeps } from "@/lib/api/deps";
import { reservationsHandler } from "@/lib/api/reservations";
import { createReservation } from "@/lib/booking/create";
import { noTurnLimit, openGate } from "@/lib/chat/ratelimit";
import { historyContent, submitOutcome, type SubmitBranch } from "@/lib/chat/submit";
import { branchInfo } from "@/lib/chat/templates";
import { runTurn, systemInputFor } from "@/lib/chat/turn";
import { emptyDraft, RECOMMEND_CHIP_LABEL, type Action, type Block, type ChatMessage, type Draft, type TraceEntry, type TurnContext, type TurnTiming } from "@/lib/chat/types";
import { loadConfig, MODEL } from "@/lib/config";
import { openDb, type DB } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { applySeed, parseSeed } from "@/lib/db/seed";
import { createLimiter } from "@/lib/http/ratelimit";
import { phonesIn, pricesIn, timesIn } from "@/lib/kb/canonical";
import { EmbedError, embedderFor, fakeEmbedder, type Embedder } from "@/lib/kb/embedder";
import { loadFactSource, renderKbFacts, renderStaticFacts } from "@/lib/kb/facts";
import { indexKb } from "@/lib/kb/index";
import { retrieveFacts } from "@/lib/kb/retrieve";
import type { ModelClient } from "@/lib/llm/client";
import { sequenceModel, type FakeReply } from "@/lib/llm/fake";
import { buildSystemPrompt, PROMPT_VERSION } from "@/lib/llm/prompt";
import { plantSnapshot } from "@/lib/llm/ollama";
import { buildChooserSystem, CHOOSER_JSON_SCHEMA, CHOOSER_VERSION } from "@/lib/llm/chooser";
import { TURN_JSON_SCHEMA } from "@/lib/llm/schema";
import { maskText } from "@/lib/llm/redact";
import { modelFor, OLLAMA_CHAT_READY } from "@/lib/llm/provider";
import { todayLocal, toInstant } from "@/lib/time/tz";
import { AREAS, areaOf } from "@/evals/areas";
import { CATEGORIES, loadCases, type EvalCase, type Expectation } from "@/evals/case";
import { checkCase, offeredStarts, snapshotRows, type CaseRecord, type TurnRecord, type Violation } from "@/evals/invariants";
import { checkThresholds, computeMetrics, type RetrievalMetrics, type Thresholds } from "@/evals/metrics";

// Eval runner (MASTER_PROMPT §6, D-12): `npm run eval:scripted` (D1, fake model) and `npm run eval` (D2, Ollama).
// Every case runs on a fresh temp database loaded from evals/fixtures/base.json, with the case's `now`. Chat turns go
// through runTurn; {submit} turns call the reservation route's handler as the ConfirmCard would, using the same
// submitOutcome mapping as the UI. Exits non-zero if any case fails or any invariant is violated (INV-08).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Where runs are kept (D-21: the dashboard reads them). EVALS_RESULTS_DIR points tests and side runs elsewhere. */
export const RESULTS_DIR = process.env.EVALS_RESULTS_DIR ? path.resolve(process.env.EVALS_RESULTS_DIR) : path.join(ROOT, "evals/results");
const ZONE = "Asia/Kolkata";

export type CaseResult = {
  id: string;
  category: string;
  severity: string;
  run: number;
  passed: boolean;
  /** D-21: "fail" = an expectation or invariant failed; "error" = the case could not run (setup or harness error). */
  status: "pass" | "fail" | "error";
  durationMs: number;
  /** What the case was scored against (case-level expect and forbidden outcomes), for the report and dashboard. */
  expect: { expect: Expectation | null; forbidden: string[]; notes: string | null; variantOf: string | null };
  failures: string[];
  violations: Violation[];
  /** Every expectation result, for the §6.5 metrics. */
  checks: Check[];
  /** INV-03 denominator: offered starts and how many the engine had open. */
  offered: { total: number; open: number };
  modelCalls: number;
  turns: {
    /** The case turn this entry belongs to (0-based). */
    index: number;
    kind: string;
    /** Masked guest text, the action, or "submit" (the transcript, §6.7). */
    input: string;
    reply: string;
    blocks: string[];
    cited: string[];
    outcome: string | null;
    intent: string | null;
    retrievalMode: string | null;
    latencyMs: number | null;
    modelMs: number | null;
    promptTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    /** D-24 stage timings (absent in runs before D-24). */
    timing?: TurnTiming | null;
    firstTryValid: boolean | null;
    /** D-21 debugging detail: the turn's trace (tool calls, validation results), booking state, retrieved fact IDs,
     * its own expectations and their results. Eval inputs are synthetic; names and phones are masked. */
    trace?: TraceEntry[];
    draft?: Omit<Draft, "selected"> & { selected: number | null };
    retrieved?: string[];
    expect?: Expectation | null;
    checks?: Check[];
  }[];
};

const SCRIPT_TOKENS: Record<string, FakeReply> = { "<<INVALID_JSON>>": "#fake:invalid", "<<TIMEOUT>>": "#fake:timeout", "<<DOWN>>": "#fake:down" };

function failingEmbedder(kind: "down" | "timeout"): Embedder {
  const base = fakeEmbedder();
  const err = () => new EmbedError(kind === "down" ? "EMBED_UNAVAILABLE" : "EMBED_TIMEOUT", `eval: embedder ${kind}`);
  return { ...base, digest: base.digest, embed: async () => Promise.reject(err()) };
}

/** The label of the chip a case's action stands for, as the guest's bubble shows it. */
function chipLabel(a: Action | { type: "select_slot"; branch: string; start: string }, branches: { slug: string; name: string }[]): string {
  if (a.type === "select_slot") return "start" in a ? a.start.slice(11) : "a time";
  if (a.type === "menu") return a.course ? a.course.replace(/-/g, " ") : "Show me the menu";
  if (a.type === "recommend") return RECOMMEND_CHIP_LABEL[a.text] ?? a.text;
  if (a.type === "hours") return "Opening hours";
  {
    if (a.value === null) return a.field === "branch" ? "Find a table" : `Change the ${a.field}`;
    if (a.field === "branch") return branches.find((b) => b.slug === a.value)?.name.split(", ").pop() ?? String(a.value);
    if (a.field === "partySize") return `${a.value} guests`;
  }
  return String(a.value);
}

/** A unique valid Indian mobile for synthetic guests (setup bookings and other-guest turns). */
const syntheticPhone = (i: number) => `+9190000${String(10000 + i).slice(-5)}`;

function deepMatch(actual: unknown, want: unknown): boolean {
  if (want === null || typeof want !== "object") return actual === want;
  if (Array.isArray(want)) return Array.isArray(actual) && want.length === actual.length && want.every((w, i) => deepMatch(actual[i], w));
  return !!actual && typeof actual === "object" && Object.entries(want).every(([k, w]) => deepMatch((actual as Record<string, unknown>)[k], w));
}

type TurnView = TurnRecord & { intent: string | null; draft: Draft; retrievalMode: string | null; submit: { status: number; code: string | null; ref: string | null } | null; modelCalls: number };

export type Check = { key: string; ok: boolean; detail: string };

function hasValue(text: string, v: string): boolean {
  if (/^\d{2}:\d{2}$/.test(v)) return timesIn(text).has(Number(v.slice(0, 2)) * 60 + Number(v.slice(3)));
  if (v.startsWith("₹")) return pricesIn(text).has(Number(v.slice(1)));
  if (v.startsWith("+")) return phonesIn(text).has(v);
  return text.includes(v);
}

// D-26/D-27 blocks, read loosely so the same checks run on code that predates them (a baseline worktree).
type LooseBlock = { type: string; [k: string]: unknown };
type HoursSection = { branch: string; title?: string; subtitle?: string | null; rows: { label: string; value: string; closed?: boolean; note?: string | null }[]; note?: string | null };
type PlanItem = { id: string; name: string; price: number; qty: number; labels?: string[]; contains?: string[] };
const hoursOf = (blocks: unknown[]): HoursSection[] => (blocks as LooseBlock[]).flatMap((b) => (b.type === "hours" ? ((b.sections as HoursSection[]) ?? []) : []));
const planOf = (blocks: unknown[]): { items: PlanItem[]; subtotal: number; budget: number | null } | null => {
  const b = (blocks as LooseBlock[]).find((x) => x.type === "meal_plan");
  return b ? { items: (b.items as PlanItem[]) ?? [], subtotal: Number(b.subtotal), budget: (b.budget as number | null) ?? null } : null;
};
/** The fixture menu's prices: the authority a plan's prices are checked against. */
const FIXTURE_PRICES = new Map((JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "base.json"), "utf8")).menu as { slug: string; priceInr: number }[]).map((m) => [`menu:${m.slug}`, m.priceInr]));

/** One result per expectation key (the §6.5 metrics are computed from these). */
type MenuView = Extract<Block, { type: "recommendation" }>["items"][number];
const leadOf = (blocks: Block[] | undefined): MenuView | null => {
  const b = blocks?.find((x) => x.type === "recommendation");
  return b && b.type === "recommendation" && b.lead ? (b.items[0] ?? null) : null;
};
/** Why a shown dish fails a case's constraints, from the card's own data (which comes from the menu table). */
function unmetShown(i: MenuView, s: NonNullable<NonNullable<Expectation["recommend"]>["satisfies"]>): string | null {
  const label = { vegetarian: ["Vegetarian", "Vegan"], vegan: ["Vegan"], "gluten-free": ["Gluten-free"], jain: ["Jain option"] } as const;
  for (const d of s.diet ?? []) if (!label[d].some((l) => i.labels.includes(l))) return `is not ${d}`;
  for (const a of s.avoid ?? []) if (i.contains.includes(a)) return `contains ${a}`;
  if (s.maxPrice !== undefined && i.price > s.maxPrice) return `costs ₹${i.price} > ₹${s.maxPrice}`;
  if (s.course !== undefined && i.course !== s.course) return `is ${i.course}, not ${s.course}`;
  if (s.mild && (i.spice === null || i.spice > 1)) return "is not mild";
  return null;
}

/**
 * D-21 response-shape checks on every reply, whatever the case: fact IDs, JSON, prompt tags or internal list wording
 * shown to the guest, and the same text shown twice (the D-20 duplicate card, the degraded notice). These fail the case.
 */
const LEAK_ID = /\b(?:menu|faq|branch|hours|exception|restaurant|doc):[a-z0-9][a-z0-9-]+/i;
const LEAK_JSON = /[{}]|"[a-zA-Z_]+"\s*:/;
const INTERNAL = /cheapest first|\(\d+ available\)|(?:^|\n)\s*[QA]:\s|citedFactIds|answerable|<\/?(?:guest_message|history)>|\bmodel_call\b|\bprefs\b/i;
export function checkUx(t: Pick<TurnView, "index" | "shown" | "kind">): Check[] {
  if (!t.shown) return [];
  const blocks = t.shown.blocks ?? [];
  const visible = [t.shown.text, ...blocks.flatMap((b) => (b.type === "notice" ? [b.text] : []))].filter(Boolean);
  const out: Check[] = [];
  const check = (key: string, ok: boolean, detail: string) => out.push({ key: `ux.${key}`, ok, detail: `turn ${t.index + 1}: ${detail}` });
  const leak = visible.map((s) => LEAK_ID.exec(s)?.[0] ?? null).find(Boolean);
  check("leak", !leak, `shows an internal fact ID (${leak})`);
  const json = visible.find((s) => LEAK_JSON.test(s));
  check("json", !json, `shows JSON or braces: "${json?.slice(0, 60)}"`);
  const internal = visible.map((s) => INTERNAL.exec(s)?.[0] ?? null).find(Boolean);
  check("internal", !internal, `shows internal wording (${internal})`);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const texts = visible.map(norm).filter((s) => s.length >= 20);
  const sentences = norm(t.shown.text).split(/(?<=[.!?])\s+/).filter((s) => s.length >= 20);
  const dup = texts.find((s, i) => texts.indexOf(s) !== i) ?? sentences.find((s, i) => sentences.indexOf(s) !== i);
  check("duplicate", !dup, `shows the same text twice: "${dup?.slice(0, 60)}"`);
  return out;
}

function checkExpect(e: Expectation | undefined, t: TurnView, ctx: { createdRefs: () => string[]; refOfTurn: (i: number) => string | null; leadOfTurn?: (i: number) => MenuView | null; guestTexts?: string[]; planOfTurn?: (i: number) => { subtotal: number } | null }): Check[] {
  if (!e) return [];
  const out: Check[] = [];
  const blocks = t.shown?.blocks ?? [];
  // What the guest reads: the reply plus the dishes shown in cards and lists (D-20 answers list questions with a list
  // from the menu table), so "must show Mango Sorbet" and "must not show Kulfi" judge what is on screen. D-26/D-27:
  // also the rows of an hours card and the items of a meal plan.
  const dishes = blocks.flatMap((b) => (b.type === "recommendation" ? b.items : b.type === "menu_list" ? b.groups.flatMap((g) => g.items) : []));
  const sections = hoursOf(blocks);
  const plan = planOf(blocks);
  const text = [
    t.shown?.text ?? "",
    ...dishes.map((d) => `${d.name} ₹${d.price}`),
    ...sections.flatMap((h) => [`${h.branch}${h.subtitle ? ` ${h.subtitle}` : ""}`, ...h.rows.map((r) => `${r.label}: ${r.value}${r.note ? ` (${r.note})` : ""}`), ...(h.note ? [h.note] : [])]),
    ...(plan ? plan.items.map((i) => `${i.qty} × ${i.name} ₹${i.price}`) : []),
  ].join("\n");
  const slots = blocks.find((b) => b.type === "slots") as Extract<Block, { type: "slots" }> | undefined;
  const check = (key: string, ok: boolean, detail: string) => out.push({ key, ok, detail: `turn ${t.index + 1}: ${detail}` });
  if (e.intent !== undefined) {
    const want = Array.isArray(e.intent) ? e.intent : [e.intent];
    check("intent", want.includes(t.intent as string), `intent ${t.intent} ∉ ${want.join("|")}`);
  }
  if (e.outcome !== undefined) check("outcome", t.outcome === e.outcome, `outcome ${t.outcome} ≠ ${e.outcome}`);
  if (e.actions) {
    let i = 0;
    const missing: string[] = [];
    for (const want of e.actions) {
      while (i < t.trace.length && !(t.trace[i].action === want.name && (!want.args || deepMatch((t.trace[i] as { args?: unknown }).args, want.args)))) i++;
      if (i >= t.trace.length) missing.push(`${want.name}${want.args ? ` ${JSON.stringify(want.args)}` : ""}`);
      else i++;
    }
    check("actions", missing.length === 0, `missing action ${missing.join("; ")} (trace: ${t.trace.map((x) => x.action).join(", ")})`);
  }
  if (e.noActions) {
    const bad = e.noActions.filter((n) => t.trace.some((x) => x.action === n));
    check("noActions", bad.length === 0, `unexpected action ${bad.join(", ")}`);
  }
  if (e.draft) check("draft", deepMatch(t.draft, e.draft), `draft ${JSON.stringify(t.draft)} does not match ${JSON.stringify(e.draft)}`);
  if (e.blocks) {
    const miss = e.blocks.filter((b) => !blocks.some((x) => x.type === b));
    check("blocks", miss.length === 0, `no ${miss.join(", ")} block (got ${blocks.map((x) => x.type).join(", ") || "none"})`);
  }
  if (e.fieldRequest) check("fieldRequest", blocks.some((x) => x.type === "field_request" && x.field === e.fieldRequest), `no field_request for ${e.fieldRequest}`);
  const offered = slots?.groups.flatMap((g) => g.slots.map((s) => s.time)) ?? [];
  if (e.slotsInclude) check("slotsInclude", e.slotsInclude.every((x) => offered.includes(x)), `slots ${e.slotsInclude.filter((x) => !offered.includes(x)).join(" ")} not offered (${offered.join(" ")})`);
  if (e.slotsExclude) check("slotsExclude", !e.slotsExclude.some((x) => offered.includes(x)), `slot ${e.slotsExclude.filter((x) => offered.includes(x)).join(" ")} offered`);
  if (e.alternativesMin !== undefined) check("alternativesMin", (slots?.alternatives.length ?? 0) >= e.alternativesMin, `alternatives ${slots?.alternatives.length ?? 0} < ${e.alternativesMin}`);
  if (e.mustCite) check("mustCite", e.mustCite.every((id) => t.citedFactIds.includes(id)), `did not cite ${e.mustCite.filter((id) => !t.citedFactIds.includes(id)).join(", ")} (cited ${t.citedFactIds.join(", ") || "none"})`);
  if (e.mustCiteAny) check("mustCiteAny", e.mustCiteAny.some((id) => t.citedFactIds.includes(id)), `cited none of ${e.mustCiteAny.join(", ")} (cited ${t.citedFactIds.join(", ") || "none"})`);
  if (e.mustIncludeValues) check("mustIncludeValues", e.mustIncludeValues.every((v) => hasValue(text, v)), `reply lacks ${e.mustIncludeValues.filter((v) => !hasValue(text, v)).join(", ")}`);
  if (e.mustNotIncludeValues) check("mustNotIncludeValues", !e.mustNotIncludeValues.some((v) => hasValue(text, v)), `reply includes ${e.mustNotIncludeValues.filter((v) => hasValue(text, v)).join(", ")}`);
  // "abstain" (an unknown fact must get the fallback) and "answer" (a known one must not) are scored separately.
  // "answer" is credited only for an actual answer (review): an FAQ or hours answer, a menu list or a dish card, not
  // a code-built no-match line or the section chips.
  const answered = t.outcome === "faq_answer" || t.outcome === "hours_answer" || (t.outcome === "menu" && blocks.some((x) => x.type === "menu_list")) || (t.outcome === "recommend" && blocks.some((x) => x.type === "recommendation"));
  if (e.mustAbstain !== undefined) check(e.mustAbstain ? "abstain" : "answer", e.mustAbstain ? t.outcome === "faq_fallback" : answered, e.mustAbstain ? `did not abstain (outcome ${t.outcome})` : `no answer shown (outcome ${t.outcome})`);
  if (e.reservationsCreated !== undefined) check("reservationsCreated", ctx.createdRefs().length === e.reservationsCreated, `reservations created ${ctx.createdRefs().length} ≠ ${e.reservationsCreated}`);
  for (const re of e.replyMustMatch ?? []) check("replyMustMatch", new RegExp(re, "i").test(text), `reply does not match /${re}/: "${text.slice(0, 100)}"`);
  for (const re of e.replyMustNotMatch ?? []) check("replyMustNotMatch", !new RegExp(re, "i").test(text), `reply matches /${re}/`);
  if (e.replyMaxChars !== undefined) check("replyLength", (t.shown?.text ?? "").length <= e.replyMaxChars, `reply is ${(t.shown?.text ?? "").length} characters (at most ${e.replyMaxChars})`);
  if (e.retrievalMode !== undefined) check("retrievalMode", t.retrievalMode === e.retrievalMode, `retrieval ${t.retrievalMode} ≠ ${e.retrievalMode}`);
  if (e.modelCalls !== undefined) check("modelCalls", t.modelCalls === e.modelCalls, `model calls ${t.modelCalls} ≠ ${e.modelCalls}`);
  if (e.submitStatus !== undefined) check("submitStatus", t.submit?.status === e.submitStatus, `submit status ${t.submit?.status} ≠ ${e.submitStatus}`);
  if (e.submitCode !== undefined) check("submitCode", (t.submit?.code ?? null) === e.submitCode, `submit code ${t.submit?.code} ≠ ${e.submitCode}`);
  if (e.recommend) {
    const r = e.recommend;
    const items = dishes; // every dish on screen, in cards and lists (review)
    const lead = leadOf(t.shown?.blocks);
    if (r.shown !== undefined) check("recommend.shown", (lead !== null) === r.shown, r.shown ? "no recommendation shown" : `a recommendation was shown (${lead?.id})`);
    if (r.satisfies) {
      // One check per turn, whatever the number of dishes shown (review: recommendationValidity was weighted by dishes).
      const bad = items.flatMap((i) => {
        const why = unmetShown(i, r.satisfies!);
        return why ? [`${i.id} ${why}`] : [];
      });
      // The code's "X is already the cheapest of the …" line shows no dish by design: nothing to check.
      if (items.length || !/ is already the cheapest of the /.test(t.shown?.text ?? "")) check("recommend.constraints", items.length > 0 && !bad.length, items.length ? bad.join("; ") : "no dish shown to check");
    }
    if (r.anyOf) check("recommend.lead", !!lead && r.anyOf.includes(lead.id), `lead dish ${lead?.id ?? "none"} not in ${r.anyOf.join(", ")}`);
    if (r.leadIfShown && lead) check("recommend.lead", r.leadIfShown.includes(lead.id), `lead dish ${lead.id} not in ${r.leadIfShown.join(", ")}`);
    if (r.notIds) check("recommend.constraints", !items.some((i) => r.notIds!.includes(i.id)), `shows one of ${r.notIds.join(", ")}`);
    if (r.cheaperThanTurn !== undefined) {
      const prev = ctx.leadOfTurn?.(r.cheaperThanTurn - 1) ?? null;
      // A cheaper lead, or (no card) the code's own statement that the earlier dish is already the cheapest that fits:
      // that is the correct answer when nothing cheaper exists (D-21 baseline: LV-REC-005 and LV-CONV-001 failed on it).
      const honest = !lead && !!prev && new RegExp(`^The ${prev.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(₹${prev.price}\\) is already the cheapest`).test(t.shown?.text ?? "");
      check("recommend.relation", (!!lead && !!prev && lead.price < prev.price) || honest, `lead ${lead?.id ?? "none"} (₹${lead?.price}) is not cheaper than turn ${r.cheaperThanTurn}'s ${prev?.id ?? "none"} (₹${prev?.price})`);
    }
    if (r.differentFromTurn !== undefined) {
      const prev = ctx.leadOfTurn?.(r.differentFromTurn - 1) ?? null;
      check("recommend.relation", !!lead && !!prev && lead.id !== prev.id, `lead ${lead?.id ?? "none"} repeats turn ${r.differentFromTurn}'s ${prev?.id ?? "none"}`);
    }
  }
  if (e.mealPlan) {
    const m = e.mealPlan;
    if (m.shown !== undefined) check("mealPlan.shown", !!plan === m.shown, m.shown ? "no meal plan shown" : "a meal plan was shown");
    if (plan && (m.maxTotal !== undefined || m.minItems !== undefined || m.satisfies)) {
      const wrong = plan.items.filter((i) => FIXTURE_PRICES.get(i.id) !== i.price).map((i) => `${i.id} ₹${i.price} (menu ₹${FIXTURE_PRICES.get(i.id) ?? "none"})`);
      const sum = plan.items.reduce((n, i) => n + i.price * i.qty, 0);
      check("mealPlan.prices", !wrong.length && sum === plan.subtotal, wrong.length ? `wrong prices: ${wrong.join(", ")}` : `subtotal ₹${plan.subtotal} ≠ items ₹${sum}`);
      if (m.maxTotal !== undefined) check("mealPlan.budget", plan.subtotal <= m.maxTotal, `subtotal ₹${plan.subtotal} > ₹${m.maxTotal}`);
      if (m.cheaperThanTurn !== undefined) {
        const prev = ctx.planOfTurn?.(m.cheaperThanTurn - 1) ?? null;
        check("mealPlan.relation", !!prev && plan.subtotal < prev.subtotal, `subtotal ₹${plan.subtotal} is not below turn ${m.cheaperThanTurn}'s ₹${prev?.subtotal ?? "none"}`);
      }
      if (m.minItems !== undefined) check("mealPlan.items", plan.items.reduce((n, i) => n + i.qty, 0) >= m.minItems, `${plan.items.length} items < ${m.minItems}`);
      if (m.satisfies) {
        const label = { vegetarian: ["Vegetarian", "Vegan"], vegan: ["Vegan"], "gluten-free": ["Gluten-free"], jain: ["Jain option"] } as const;
        const bad = plan.items.flatMap((i) => [...(m.satisfies!.diet ?? []).filter((d) => !label[d].some((l) => (i.labels ?? []).includes(l))).map((d) => `${i.id} is not ${d}`), ...(m.satisfies!.avoid ?? []).filter((a) => (i.contains ?? []).includes(a)).map((a) => `${i.id} contains ${a}`)]);
        check("mealPlan.constraints", !bad.length, bad.join("; "));
      }
    } else if (m.maxTotal !== undefined || m.satisfies) check("mealPlan.budget", false, "no meal plan to check");
  }
  if (e.hours) {
    if (e.hours.shown !== undefined) check("hours.shown", sections.length > 0 === e.hours.shown, e.hours.shown ? "no hours card shown" : "an hours card was shown");
    if (e.hours.branches) {
      const got = [...new Set(sections.map((h) => h.branch))].sort();
      check("hours.branches", JSON.stringify(got) === JSON.stringify([...e.hours.branches].sort()), `hours for ${got.join(", ") || "no branch"}, expected ${e.hours.branches.join(", ")}`);
    }
  }
  if (e.notice) {
    const shownNotice = blocks.some((b) => b.type === "notice");
    check("notice", shownNotice === e.notice.shown, e.notice.shown ? "no notice shown" : `a notice was shown: "${(blocks.find((b) => b.type === "notice") as { text?: string } | undefined)?.text?.slice(0, 60)}"`);
  }
  if (e.prefsInForce) {
    const last = [...t.trace].reverse().find((x) => x.action === "prefs") as { prefs?: unknown } | undefined;
    check("prefsInForce", !!last && deepMatch(last.prefs, e.prefsInForce), `preferences ${JSON.stringify(last?.prefs ?? null)} don't match ${JSON.stringify(e.prefsInForce)}`);
  }
  if (e.pricesConsistent) {
    const allowed = new Set<number>([...dishes.map((d) => d.price), ...(plan ? [plan.subtotal, ...plan.items.map((i) => i.price), ...plan.items.map((i) => i.price * i.qty)] : []), ...(plan?.budget ? [plan.budget] : []), ...(ctx.guestTexts ?? []).flatMap((g) => [...pricesIn(g), ...(g.match(/\b\d{2,5}\b/g) ?? []).map(Number)])]);
    const named = new Map([...FIXTURE_PRICES].map(([id, p]) => [id, p]));
    for (const id of t.citedFactIds ?? []) if (named.has(id)) allowed.add(named.get(id)!);
    const bad = [...pricesIn(t.shown?.text ?? "")].filter((p) => !allowed.has(p));
    check("pricesConsistent", !bad.length, `the reply quotes ${bad.map((p) => `₹${p}`).join(", ")}, which is no price on screen, the plan total or a budget the guest gave`);
  }
  if (e.menuShown !== undefined) check("menuShown", (t.shown?.blocks.some((x) => x.type === "menu_list") ?? false) === e.menuShown, e.menuShown ? "no menu list shown" : "a menu list was shown");
  if (e.sameRefAsTurn !== undefined) check("sameRefAsTurn", !!t.submit?.ref && t.submit.ref === ctx.refOfTurn(e.sameRefAsTurn - 1), `ref ${t.submit?.ref} ≠ turn ${e.sameRefAsTurn}'s ${ctx.refOfTurn(e.sameRefAsTurn - 1)}`);
  return out;
}

/** One block as a transcript line: its type plus what the guest saw (times, the card, the ref, the notice). */
function blockLine(b: Block): string {
  switch (b.type) {
    case "slots":
      return `slots ${b.heading}: ${b.groups.flatMap((g) => g.slots.map((x) => x.time)).join(" ")}${b.alternatives.length ? ` | other: ${b.alternatives.map((a) => a.label).join(", ")}` : ""}`;
    case "confirm":
      return `confirm ${b.branch} ${b.date} ${b.time} x${b.partySize}`;
    case "confirmation":
      return `confirmation ${b.ref}`;
    case "notice":
      return `notice: ${b.text}`;
    case "recommendation":
      return `${b.lead ? "recommend" : "options"} ${b.items.map((i) => `${i.id} ₹${i.price}`).join(", ")}`;
    case "menu_list":
      return `menu ${b.groups.map((g) => `${g.course}: ${g.items.map((i) => i.id).join(" ")}`).join(" | ")}`;
    case "info":
      return `info ${b.factIds.join(", ")}`;
    case "field_request":
      return `ask ${b.field}: ${b.chips.map((c) => c.label).join(" / ")}`;
    case "quick_replies":
      return `chips: ${b.chips.map((c) => c.label).join(" / ")}`;
  }
  // D-26/D-27 blocks, read loosely (see hoursOf / planOf).
  const loose = b as unknown as LooseBlock;
  if (loose.type === "hours") return `hours ${hoursOf([loose]).map((h) => `${h.branch}${h.subtitle ? ` (${h.subtitle})` : ""}: ${h.rows.map((r) => `${r.label} ${r.value}`).join(", ")}`).join(" | ")}`;
  if (loose.type === "meal_plan") {
    const p = planOf([loose])!;
    return `plan ${p.items.map((i) => `${i.qty}x ${i.id} ₹${i.price}`).join(", ")} = ₹${p.subtotal}${p.budget ? ` (budget ₹${p.budget})` : ""}`;
  }
  return loose.type;
}

/**
 * A seeded, retrieval-indexed fixture database to copy for each case, so the live embedder indexes the 86 facts once
 * per run instead of once per case. Returns its path; the caller removes the directory.
 */
export async function prepareTemplate(embedder: Embedder | null, now: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-eval-template-"));
  const file = path.join(dir, "template.db");
  const db = openDb(file);
  migrate(db, now);
  applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now });
  if (embedder) await indexKb(db, renderKbFacts(loadFactSource(db)), embedder, now, { signal: AbortSignal.timeout(300_000) });
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return file;
}

export async function runCase(c: EvalCase, opts: { mode: "scripted" | "live"; run?: number; model?: ModelClient; embedder?: Embedder | null; template?: string } = { mode: "scripted" }): Promise<CaseResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-eval-"));
  const file = path.join(dir, "app.db");
  const failures: string[] = [];
  const logs: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  let db: DB | null = null;
  const t0 = Date.now();
  const result: CaseResult = {
    id: c.id,
    category: c.category,
    severity: c.severity,
    run: opts.run ?? 1,
    passed: false,
    status: "fail",
    durationMs: 0,
    expect: { expect: c.expect ?? null, forbidden: c.forbidden ?? [], notes: c.notes ?? null, variantOf: c.variantOf ?? null },
    failures,
    violations: [],
    checks: [],
    offered: { total: 0, open: 0 },
    modelCalls: 0,
    turns: [],
  };
  let errored = false;
  try {
    console.log = console.warn = console.error = console.info = capture;
    const now = Date.parse(c.now);
    const baseEmbedder = opts.mode === "live" ? (opts.embedder ?? null) : fakeEmbedder();
    if (opts.template) {
      fs.copyFileSync(opts.template, file);
      db = openDb(file);
    } else {
      db = openDb(file);
      migrate(db, now);
      applySeed(db, parseSeed(JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/base.json"), "utf8"))), { now });
      if (baseEmbedder) await indexKb(db, renderKbFacts(loadFactSource(db)), baseEmbedder, now, { signal: AbortSignal.timeout(300_000) });
    }
    const embedder = c.embedder ? failingEmbedder(c.embedder) : baseEmbedder;

    // Setup.
    const setupRefs = new Set<string>();
    let synth = 0;
    const bookAs = (branch: string, start: string, party: number, phone?: string, name = "Setup Guest") => {
      const [date, time] = start.split("T");
      return createReservation(db!, { branch, startsAt: toInstant(date, time, ZONE), partySize: party, name, phone: phone ?? syntheticPhone(synth++) }, randomUUID(), now);
    };
    let faultAvailability = false;
    let faultCreateLock = false;
    for (const op of c.setup ?? []) {
      if (op.op === "fault") {
        if (op.target === "availability") faultAvailability = true;
        else faultCreateLock = true;
        continue;
      }
      if (op.op === "book") {
        const r = bookAs(op.branch, op.start, op.party, op.phone, op.name);
        if (!("reservation" in r)) throw new Error(`setup book failed: ${r.code}`);
        setupRefs.add(r.reservation.ref);
      } else {
        for (let i = 0; i < 20; i++) {
          const r = bookAs(op.branch, op.start, op.party);
          if (!("reservation" in r)) break;
          setupRefs.add(r.reservation.ref);
        }
      }
    }

    const scripted = opts.mode === "scripted" ? sequenceModel((c.modelScript ?? []).map((r) => (typeof r === "string" && SCRIPT_TOKENS[r]) || r) as FakeReply[]) : null;
    const model = scripted ?? opts.model!;
    const branches = db.prepare("SELECT slug, name, address, phone, timezone FROM branches WHERE is_active = 1 ORDER BY id").all() as { slug: string; name: string; address: string; phone: string; timezone: string }[];
    const submitBranches: SubmitBranch[] = branches.map(branchInfo).map((b) => ({ slug: b.slug, name: b.name, short: b.short, phoneLabel: b.phoneLabel }));
    const apiDeps = (handle: DB): ApiDeps => ({
      db: () => handle,
      now: () => now,
      config: () => loadConfig({ DATABASE_PATH: file }),
      fetch: (...a) => fetch(...a),
      limits: { createsPerPhone: createLimiter({ limit: 1000, windowMs: 60_000 }), createsGlobal: createLimiter({ limit: 1000, windowMs: 60_000 }) },
      chat: { model: () => model, embedder: () => embedder, limiter: noTurnLimit, gate: openGate },
    });

    // Client state, as the browser keeps it.
    let draft: Draft = c.draft ?? emptyDraft();
    let context: TurnContext = { lastCitedIds: [] };
    let history: ChatMessage[] = c.history ? [...c.history] : [];
    let lastConfirm: Extract<Block, { type: "confirm" }> | null = null;
    let lastSubmit: { key: string; body: Record<string, unknown>; card: Extract<Block, { type: "confirm" }> } | null = null;
    const records: TurnView[] = [];
    const bookTurnRefs = new Set<string>();
    const guestTexts: string[] = [];
    const submittedNames: string[] = [];
    const submittedPii: string[] = [];
    const createdRefs = () => snapshotRows(db!).map((r) => r.ref).filter((r) => !setupRefs.has(r) && !bookTurnRefs.has(r));

    const doSubmit = async (key: string, body: Record<string, unknown>, card: Extract<Block, { type: "confirm" }>, lock: boolean) => {
      let handle = db!;
      let locker: DB | null = null;
      if (lock) {
        locker = openDb(file);
        locker.prepare("BEGIN IMMEDIATE").run();
        handle = openDb(file, { timeoutMs: 50 });
      }
      try {
        const res = await reservationsHandler(apiDeps(handle))(new Request("http://127.0.0.1/api/reservations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) }));
        const json = await res.json();
        return { status: res.status, json, outcome: submitOutcome({ status: res.status, body: json }, { branch: submitBranches.find((b) => b.slug === card.branch)!, branches: submitBranches, date: card.date, partySize: card.partySize }) };
      } finally {
        if (locker) {
          locker.prepare("ROLLBACK").run();
          locker.close();
          handle.close();
        }
      }
    };

    for (const [index, turn] of c.turns.entries()) {
      const rowsBefore = snapshotRows(db);
      const prompts: string[] = [];
      let shown: TurnRecord["shown"] = null;
      let outcome: string | null = null;
      let intent: string | null = null;
      let citedFactIds: string[] = [];
      let trace: TraceEntry[] = [];
      let retrievalMode: string | null = null;
      let submit: TurnView["submit"] = null;
      const kind = (Object.keys(turn).find((k) => k !== "expect") ?? "guest") as TurnRecord["kind"];
      const facts = (() => {
        const src = loadFactSource(db!);
        return new Map([...renderStaticFacts(src, now), ...renderKbFacts(src)].map((f) => [f.id, f.text]));
      })();
      const chat = async (input: { messages: ChatMessage[]; action?: Action }) => {
        const r = await runTurn(
          { now, sessionId: "00000000-0000-4000-8000-000000000000", messages: input.messages, draft, action: input.action, context },
          { db: db!, model, embedder, limiter: noTurnLimit, gate: openGate, onPrompt: (p) => prompts.push(`${p.system}\n${p.user}`), loadBundle: faultAvailability ? () => { throw new Error("eval fault: availability read failed"); } : undefined },
        );
        shown = r.reply;
        outcome = r.meta.outcome;
        intent = r.intent;
        citedFactIds = r.meta.citedFactIds;
        trace = r.trace;
        retrievalMode = r.meta.retrievalMode;
        draft = r.draft;
        context = r.context;
        const confirm = r.reply.blocks.find((b) => b.type === "confirm") as Extract<Block, { type: "confirm" }> | undefined;
        if (confirm) lastConfirm = confirm;
        else if (!r.draft.selected) lastConfirm = null;
        const last = input.messages.at(-1);
        result.turns.push({
          index,
          kind,
          input: input.action ? JSON.stringify(input.action) : maskText(last?.content ?? ""),
          reply: r.reply.text,
          blocks: r.reply.blocks.map(blockLine),
          cited: r.meta.citedFactIds,
          outcome,
          intent,
          retrievalMode,
          latencyMs: r.meta.latencyMs,
          modelMs: r.meta.modelMs,
          promptTokens: r.meta.promptTokens,
          cachedTokens: r.meta.cachedTokens,
          outputTokens: r.meta.outputTokens,
          timing: r.meta.timing,
          firstTryValid: r.trace.some((x) => x.action === "model_call") ? (r.trace.find((x) => x.action === "model_call") as { result: string }).result === "ok" : null,
        });
        return r;
      };

      if ("guest" in turn) {
        guestTexts.push(turn.guest);
        history = [...history, { role: "guest" as const, content: turn.guest }].slice(-8);
        const r = await chat({ messages: history });
        history = [...history, { role: "assistant" as const, content: historyContent(r.reply.text, r.reply.blocks).slice(0, 600) }].filter((m) => m.content).slice(-7);
      } else if ("action" in turn) {
        const a = turn.action;
        const action: Action = "start" in a ? { type: "select_slot", branch: a.branch, startsAt: toInstant(a.start.slice(0, 10), a.start.slice(11), ZONE) } : a;
        // As the browser does: the chip's label goes into the history as the guest's message, and the reply after it
        // (D-21 audit: action-then-text cases ran the model without them).
        const label = chipLabel(a, branches);
        history = [...history, { role: "guest" as const, content: label }].slice(-8);
        const r = await chat({ messages: history, action });
        history = [...history, { role: "assistant" as const, content: historyContent(r.reply.text, r.reply.blocks).slice(0, 600) }].filter((m) => m.content).slice(-7);
      } else if ("submit" in turn) {
        if (!lastConfirm) throw new Error(`turn ${index + 1}: {submit} without a confirm card`);
        const card: Extract<Block, { type: "confirm" }> = lastConfirm;
        submittedNames.push(turn.submit.name);
        submittedPii.push(turn.submit.phone, turn.submit.phone.replace(/\D/g, ""), ...(turn.submit.email ? [turn.submit.email] : []));
        const body = { branch: card.branch, startsAt: card.startsAtMs, partySize: card.partySize, name: turn.submit.name, phone: turn.submit.phone, email: turn.submit.email ?? null, note: turn.submit.note ?? null };
        // The client reuses a key only to retry an identical body (§5.9).
        const prev: { key: string; body: Record<string, unknown> } | null = lastSubmit;
        const key: string = prev && JSON.stringify(prev.body) === JSON.stringify(body) ? prev.key : randomUUID();
        const lock = faultCreateLock && !records.some((x) => x.kind === "submit");
        const r = await doSubmit(key, body, card, lock);
        const ref = (r.json as { reservation?: { ref: string } }).reservation?.ref ?? null;
        submit = { status: r.status, code: (r.json as { error?: { code?: string } }).error?.code ?? null, ref };
        trace = [{ action: "create_reservation", result: submit }];
        shown = { text: r.outcome.text, blocks: r.outcome.blocks };
        outcome = "submit";
        lastSubmit = { key, body, card }; // remembered so a lost response or reload can replay it
        result.turns.push({ index, kind, input: `submit (HTTP ${r.status})`, reply: r.outcome.text, blocks: r.outcome.blocks.map(blockLine), cited: [], outcome: "submit", intent: null, retrievalMode: null, latencyMs: null, modelMs: null, promptTokens: null, cachedTokens: null, outputTokens: null, firstTryValid: null });
        if (r.outcome.clearDraft) {
          draft = emptyDraft();
          lastConfirm = null;
          context = { ...context, lastCitedIds: [] }; // as the client does: food preferences stay (review)
        }
        history = [...history, { role: "assistant" as const, content: historyContent(r.outcome.text, r.outcome.blocks) }].filter((m) => m.content).slice(-7);
      } else if ("simulate" in turn) {
        // A lost response or a reload with a pending submit: the client replays the same key and body (D-14).
        if (lastSubmit) {
          const r = await doSubmit(lastSubmit.key, lastSubmit.body, lastSubmit.card, false);
          const ref = (r.json as { reservation?: { ref: string } }).reservation?.ref ?? null;
          submit = { status: r.status, code: (r.json as { error?: { code?: string } }).error?.code ?? null, ref };
          trace = [{ action: "create_reservation", result: submit }];
          shown = { text: r.outcome.text, blocks: r.outcome.blocks };
          outcome = "submit";
          result.turns.push({ index, kind, input: `${turn.simulate}: replay (HTTP ${r.status})`, reply: r.outcome.text, blocks: r.outcome.blocks.map(blockLine), cited: [], outcome: "submit", intent: null, retrievalMode: null, latencyMs: null, modelMs: null, promptTokens: null, cachedTokens: null, outputTokens: null, firstTryValid: null });
          if (r.outcome.clearDraft) {
            draft = emptyDraft();
            lastConfirm = null;
            context = { ...context, lastCitedIds: [] };
          }
        }
      } else if ("book" in turn) {
        const r = bookAs(turn.book.branch, turn.book.start, turn.book.party, turn.book.phone ?? syntheticPhone(500 + index), "Other Guest");
        if (!("reservation" in r)) throw new Error(`turn ${index + 1}: {book} failed: ${r.code}`);
        bookTurnRefs.add(r.reservation.ref);
        result.turns.push({ index, kind, input: `another guest books ${turn.book.branch} ${turn.book.start} for ${turn.book.party}`, reply: "", blocks: [], cited: [], outcome: null, intent: null, retrievalMode: null, latencyMs: null, modelMs: null, promptTokens: null, cachedTokens: null, outputTokens: null, firstTryValid: null });
      }

      const rec: TurnView = {
        index,
        kind,
        now,
        shown,
        outcome,
        citedFactIds,
        factText: facts,
        trace,
        rowsBefore,
        rowsAfter: snapshotRows(db),
        offered: shown ? offeredStarts(db, (shown as { blocks: Block[] }).blocks, now) : [],
        prompts,
        intent,
        draft,
        retrievalMode,
        submit,
        modelCalls: trace.filter((x) => x.action === "model_call" || x.action === "recommend" || (x.action as string) === "plan").length, // the chooser and the meal planner are model calls too (D-20, D-26)
      };
      records.push(rec);
      result.modelCalls += rec.modelCalls;
      result.offered.total += rec.offered.length;
      result.offered.open += rec.offered.filter((o) => o.open).length;
      const turnChecks = [...checkExpect(turn.expect, rec, { createdRefs, refOfTurn: (i) => records[i]?.submit?.ref ?? null, leadOfTurn: (i) => leadOf(records[i]?.shown?.blocks), guestTexts: [...guestTexts], planOfTurn: (i) => planOf(records[i]?.shown?.blocks ?? []) }), ...checkUx(rec)];
      result.checks.push(...turnChecks);
      failures.push(...turnChecks.filter((x) => !x.ok).map((x) => x.detail));
      const entry = result.turns.findLast((x) => x.index === index);
      if (entry) {
        entry.trace = trace;
        entry.draft = { ...draft, selected: draft.selected?.startsAt ?? null };
        entry.retrieved = trace.flatMap((x) => (x.action === "retrieve" ? x.ids : []));
        entry.expect = turn.expect ?? null;
        entry.checks = turnChecks;
      }
    }

    const last = records.at(-1)!;
    const caseChecks = checkExpect(c.expect, last, { createdRefs, refOfTurn: (i) => records[i]?.submit?.ref ?? null, leadOfTurn: (i) => leadOf(records[i]?.shown?.blocks), guestTexts: [...guestTexts], planOfTurn: (i) => planOf(records[i]?.shown?.blocks ?? []) }).map((x) => ({ ...x, detail: x.detail.replace(/^turn \d+:/, "case:") }));
    result.checks.push(...caseChecks);
    failures.push(...caseChecks.filter((x) => !x.ok).map((x) => x.detail));
    for (const fb of c.forbidden ?? []) {
      if (fb === "reservation_created" && createdRefs().length) failures.push(`forbidden: reservation_created (${createdRefs().length})`);
    }
    if (scripted && scripted.remaining() > 0) failures.push(`modelScript has ${scripted.remaining()} unused replies`);

    const rec: CaseRecord = {
      turns: records,
      setupRefs: new Set([...setupRefs, ...bookTurnRefs]),
      guestTexts: guestTexts.filter((g) => g.trim().length >= 8),
      submittedNames,
      submittedPii,
      chatTurns: db.prepare("SELECT * FROM chat_turns").all() as Record<string, unknown>[],
      logs,
    };
    result.violations = checkCase(db, rec);
    // The other forbidden outcomes are the invariants' business; a case that names them gets a named failure too.
    for (const [fb, inv] of [["booking_claim_text", "INV-04"], ["slot_not_in_engine_output", "INV-03"]] as const)
      if (c.forbidden?.includes(fb) && result.violations.some((v) => v.inv === inv)) failures.push(`forbidden: ${fb}`);
  } catch (e) {
    // A scripted case whose model script ran out means the app called the model more than the case expects: that is
    // the app's behaviour (a failure), not a harness error.
    if ((e as { name?: string })?.name === "ScriptExhaustedError") failures.push(`unexpected model call: ${(e as Error).message}`);
    else {
      errored = true;
      failures.push(`error: ${(e as Error).message}`);
    }
  } finally {
    Object.assign(console, saved);
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  result.passed = failures.length === 0 && result.violations.length === 0;
  result.status = errored ? "error" : result.passed ? "pass" : "fail";
  result.durationMs = Date.now() - t0;
  return result;
}

/**
 * AC-15 (D-13), live: hit@8 and recall@8 over the 30 labelled probe queries (R01–R30) with the run's embedder (hybrid)
 * and with none (lexical), on the run's template database.
 */
export async function measureRetrieval(template: string, embedder: Embedder | null): Promise<RetrievalMetrics> {
  const queries = (JSON.parse(fs.readFileSync(path.join(ROOT, "evals/fixtures/probe-messages.json"), "utf8")) as { retrieval: { query: string; relevant: string[] }[] }).retrieval;
  const db = openDb(template);
  const facts = renderKbFacts(loadFactSource(db));
  const score = async (e: Embedder | null) => {
    let hit = 0;
    let recall = 0;
    let hybrid = true;
    for (const q of queries) {
      const r = await retrieveFacts(q.query, {}, { db, facts, embedder: e, timeoutMs: 30_000 });
      if (r.mode !== "hybrid") hybrid = false;
      const top = r.hits.map((h) => h.factId);
      const found = q.relevant.filter((id) => top.includes(id)).length;
      if (found) hit++;
      recall += found / Math.min(q.relevant.length, 8);
    }
    return { hitAt8: hit / queries.length, recallAt8: recall / queries.length, hybrid };
  };
  const h = embedder ? await score(embedder) : null;
  const l = await score(null);
  db.close();
  return { queries: queries.length, hybrid: h && h.hybrid ? { hitAt8: h.hitAt8, recallAt8: h.recallAt8 } : null, lexical: { hitAt8: l.hitAt8, recallAt8: l.recallAt8 } };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function sh(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

type OllamaModelState = { name: string; digest: string | null; loaded: boolean; sizeBytes: number | null; vramBytes: number | null; gpuShare: number | null; contextLength: number | null };

/** Run metadata from Ollama (§6.6 model digest and Ollama version; §6.5 `ollama ps` size and GPU share). Never throws. */
async function ollamaState(baseUrl: string, names: string[]): Promise<{ version: string | null; models: OllamaModelState[] }> {
  type Listed = { name?: string; model?: string; digest?: string; size?: number; size_vram?: number; context_length?: number };
  const get = async <T,>(p: string): Promise<T | null> => {
    try {
      const r = await fetch(`${baseUrl}${p}`, { signal: AbortSignal.timeout(5000) });
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const [version, tags, ps] = await Promise.all([get<{ version?: string }>("/api/version"), get<{ models?: Listed[] }>("/api/tags"), get<{ models?: Listed[] }>("/api/ps")]);
  // "qwen3.5" and "qwen3.5:latest" are the same model (review: an untagged name reported "not loaded").
  const norm = (n: string | undefined) => (n ? (n.includes(":") ? n : `${n}:latest`).toLowerCase() : "");
  const find = (list: { models?: Listed[] } | null, name: string) => list?.models?.find((m) => norm(m.name) === norm(name) || norm(m.model) === norm(name));
  return {
    version: version?.version ?? null,
    models: names.map((name) => {
      const p = find(ps, name);
      return {
        name,
        digest: (p?.digest ?? find(tags, name)?.digest)?.slice(0, 12) ?? null,
        loaded: !!p,
        sizeBytes: p?.size ?? null,
        vramBytes: p?.size_vram ?? null,
        gpuShare: p?.size ? (p.size_vram ?? 0) / p.size : null,
        contextLength: p?.context_length ?? null,
      };
    }),
  };
}

async function main(): Promise<number> {
  const mode = arg("mode");
  if (mode !== "scripted" && mode !== "live") {
    console.error("usage: tsx evals/run.ts --mode scripted|live [--suite smoke|full] [--case ID,ID] [--category slug] [--area key] [--runs N] [--save] [--label L] [--cases DIR] [--out FILE]");
    return 2;
  }
  const suite = arg("suite") ?? "full";
  if (suite !== "smoke" && suite !== "full") {
    console.error(`unknown suite ${suite} (smoke|full)`);
    return 2;
  }
  const area = arg("area");
  if (area && !AREAS.some((a) => a.key === area)) {
    console.error(`unknown area ${area} (${AREAS.map((a) => a.key).join("|")})`);
    return 2;
  }
  const casesDir = path.resolve(arg("cases") ?? path.join(ROOT, "evals/cases"));
  const category = arg("category");
  if (category && !(CATEGORIES as readonly string[]).includes(category)) {
    console.error(`unknown category ${category}`);
    return 2;
  }
  if (mode === "live" && !OLLAMA_CHAT_READY) {
    console.error("eval --mode live needs the Ollama chat client (T-18). Nothing was run.");
    return 2;
  }
  const only = arg("case")?.split(",");
  const runs = Number(arg("runs") ?? "1");
  let cases: EvalCase[];
  try {
    cases = loadCases(casesDir);
  } catch (e) {
    console.error(`eval: ${(e as Error).message}`);
    return 2;
  }
  // Provenance is read before anything runs, so a commit or edit during a long run can't relabel it (T-20 review).
  const provenance = () => ({
    gitSha: sh("git", ["rev-parse", "--short", "HEAD"]),
    // Uncommitted changes outside evals/results mean gitSha alone does not identify the code that ran.
    gitDirty: (sh("git", ["status", "--porcelain"]) ?? "").split("\n").some((l) => l.trim() && !l.includes("evals/results/")),
    datasetHash: createHash("sha256")
      .update(fs.readdirSync(casesDir).filter((n) => n.endsWith(".jsonl")).sort().map((n) => fs.readFileSync(path.join(casesDir, n), "utf8")).join("\n"))
      .digest("hex")
      .slice(0, 16),
  });
  const atStart = provenance();
  // D-21 suites: "smoke" is the short list in evals/suites.json (a few cases per area); "full" is every case.
  const smoke = new Set((JSON.parse(fs.readFileSync(path.join(ROOT, "evals/suites.json"), "utf8")) as { smoke: string[] }).smoke);
  const unknown = only?.filter((id) => !cases.some((c) => c.id === id)) ?? [];
  if (unknown.length) {
    console.error(`eval: unknown case ${unknown.join(", ")}`);
    return 2;
  }
  cases = cases.filter((c) => c.mode === mode && (suite === "full" || smoke.has(c.id)) && (!category || c.category === category) && (!area || areaOf(c.category) === area) && (!only || only.includes(c.id)));
  if (!cases.length) {
    console.error(`eval: no ${mode} cases selected`);
    return 2;
  }
  // The first line says how much will run (the dashboard's progress bar reads it).
  console.log(`eval:${mode} ${suite}: ${cases.length} cases${runs > 1 ? ` x ${runs} runs` : ""}`);
  let model: ModelClient | undefined;
  let embedder: Embedder | null = null;
  let ollama: { baseUrl: string; names: string[] } | null = null;
  if (mode === "live") {
    const config = loadConfig({ ...process.env, LLM_PROVIDER: "ollama", EMBED_PROVIDER: "ollama", E2E_TEST_MODE: undefined });
    model = modelFor(config);
    embedder = embedderFor(config);
    ollama = { baseUrl: config.ollamaBaseUrl, names: [config.chatModel, config.embedModel] };
  }
  const results: CaseResult[] = [];
  const started = new Date();
  // Progress, one line per case, so an interrupted run can still be inspected (D-21: shown as incomplete, never as a
  // finished run). The first line is the run's header.
  const save = mode === "live" || process.argv.includes("--save");
  const partial = save ? path.join(RESULTS_DIR, `${started.toISOString().replace(/[:.]/g, "-")}_${mode}${suite === "smoke" ? "_smoke" : ""}.partial.jsonl`) : null;
  if (partial) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  if (partial) fs.writeFileSync(partial, `${JSON.stringify({ header: { mode, suite, selection: { case: only ?? null, category: category ?? null, area: area ?? null }, startedAt: started.toISOString(), gitSha: atStart.gitSha, gitDirty: atStart.gitDirty, datasetHash: atStart.datasetHash, selected: cases.map((c) => c.id), runs, pid: process.pid } })}\n`);
  const template = await prepareTemplate(mode === "live" ? embedder : fakeEmbedder(), Date.parse(cases[0].now));
  let warmup: unknown = null;
  // Warm the prefix for the cases' own date, so a measured turn isn't a cold prefill (§6.5 reports cold load
  // separately). The static prompt changes with the branch-local day, so a case on another day is planted before it,
  // and the usual day again after it (D-24: one case on 17 Oct evicted the cache and the next 8 turns timed out).
  const plants: { day: string; shots: unknown[] }[] = [];
  let plantedDay: string | null = null;
  const plantFor = async (now: number) => {
    const cfg = loadConfig({ ...process.env, LLM_PROVIDER: "ollama", EMBED_PROVIDER: "ollama", E2E_TEST_MODE: undefined });
    const tdb = openDb(template);
    const sysIn = systemInputFor(tdb, now);
    tdb.close();
    const day = todayLocal(now, sysIn.zone);
    if (day === plantedDay) return;
    const shots = [
      ...(await plantSnapshot({ baseUrl: cfg.ollamaBaseUrl, model: cfg.chatModel, system: buildSystemPrompt(sysIn), format: TURN_JSON_SCHEMA, timeoutMs: MODEL.warmTimeoutMs })),
      // The recommendation chooser's own static prefix (D-20).
      ...(await plantSnapshot({ baseUrl: cfg.ollamaBaseUrl, model: cfg.chatModel, system: buildChooserSystem(sysIn.restaurant.name), format: CHOOSER_JSON_SCHEMA, timeoutMs: MODEL.warmTimeoutMs })),
    ];
    plants.push({ day, shots });
    plantedDay = day;
    console.log(`warm-up for ${day} (not scored): ${JSON.stringify(shots)}`);
  };
  if (mode === "live") {
    await plantFor(Date.parse(cases[0].now));
    warmup = plants[0].shots;
  }
  for (let run = 1; run <= runs; run++)
    for (const c of cases) {
      // A failed re-plant only costs that case a cold prefill; it never stops the run (review of D-24).
      if (mode === "live") await plantFor(Date.parse(c.now)).catch((e: Error) => console.log(`warm-up for ${c.id} failed (not scored): ${e.message}`));
      const r = await runCase(c, { mode, run, model, embedder, template });
      results.push(r);
      if (partial) fs.appendFileSync(partial, `${JSON.stringify(r)}\n`);
      const why = [...r.failures, ...r.violations.map((v) => `${v.inv}${v.turn !== null ? ` turn ${v.turn + 1}` : ""}: ${v.detail}`)];
      console.log(`${r.passed ? "PASS" : "FAIL"} ${c.id} ${c.category}${runs > 1 ? ` run ${run}` : ""}${why.length ? `\n     ${why.join("\n     ")}` : ""}`);
    }
  const retrieval = mode === "live" ? await measureRetrieval(template, embedder) : null;
  const ollamaMeta = ollama ? await ollamaState(ollama.baseUrl, ollama.names) : null; // after the runs, so `ps` shows what was loaded
  fs.rmSync(path.dirname(template), { recursive: true, force: true });
  const passed = results.filter((r) => r.passed).length;
  const metrics = computeMetrics(results, retrieval);
  const subset = !!(only || category || area) || suite !== "full";
  const thresholdLines = mode === "live" && !subset ? checkThresholds(metrics, JSON.parse(fs.readFileSync(path.join(ROOT, "evals/thresholds.json"), "utf8")) as Thresholds) : [];
  const fmt = (v: number | null) => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(3));
  if (mode === "live") {
    console.log(`latency booking p50/p95 ${fmt(metrics.latency.booking.p50)}/${fmt(metrics.latency.booking.p95)} ms (run 1: ${fmt(metrics.latency.firstRunBooking.p50)}/${fmt(metrics.latency.firstRunBooking.p95)}), faq ${fmt(metrics.latency.faq.p50)}/${fmt(metrics.latency.faq.p95)} ms (run 1: ${fmt(metrics.latency.firstRunFaq.p50)}/${fmt(metrics.latency.firstRunFaq.p95)}); prompt max ${fmt(metrics.tokens.promptMax)} tokens`);
    if (metrics.latency.recommend.n || metrics.recommendationValidity.n)
      console.log(`recommendations (report only): p50/p95 ${fmt(metrics.latency.recommend.p50)}/${fmt(metrics.latency.recommend.p95)} ms over ${metrics.latency.recommend.n} turns; checks passed ${fmt(metrics.recommendationValidity.value)} (n ${metrics.recommendationValidity.n})`);
    if (retrieval) console.log(`retrieval (${retrieval.queries} labelled queries): hybrid hit@8 ${fmt(retrieval.hybrid?.hitAt8 ?? null)} recall@8 ${fmt(retrieval.hybrid?.recallAt8 ?? null)}; lexical hit@8 ${fmt(retrieval.lexical.hitAt8)} recall@8 ${fmt(retrieval.lexical.recallAt8)}`);
    if (ollamaMeta)
      console.log(
        `ollama ${ollamaMeta.version ?? "?"}: ${ollamaMeta.models.map((m) => `${m.name} ${m.digest ?? "?"} ${m.loaded ? `${((m.sizeBytes ?? 0) / 2 ** 30).toFixed(1)} GiB, ${Math.round((m.gpuShare ?? 0) * 100)}% GPU, ctx ${m.contextLength ?? "?"}` : "not loaded"}`).join("; ")}`,
      );
    if (subset) console.log("subset run (--suite smoke, --case, --category or --area): thresholds not applied");
    for (const l of thresholdLines) console.log(`${l.ok ? "✓" : "✗"} ${l.metric.padEnd(30)} ${fmt(l.value).padStart(7)}  (${l.want})${l.override ? `  override: ${l.override}` : ""}`);
  }
  const violations = results.reduce((n, r) => n + r.violations.length, 0);
  const atEnd = provenance();
  const finished = new Date();
  const meta = {
    kind: `eval-${mode}`,
    formatVersion: 2,
    mode,
    suite,
    selection: { case: only ?? null, category: category ?? null, area: area ?? null },
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    gitSha: atStart.gitSha,
    gitDirty: atStart.gitDirty,
    // True if the commit, the tree or the cases changed while the run was going.
    changedDuringRun: JSON.stringify(atStart) !== JSON.stringify(atEnd),
    promptVersion: PROMPT_VERSION,
    chooserVersion: CHOOSER_VERSION,
    dataset: { dir: path.relative(ROOT, casesDir), hash: atStart.datasetHash, cases: cases.length },
    node: process.version,
    chip: os.cpus()[0]?.model ?? null,
    ramBytes: os.totalmem(),
    numCtx: MODEL.numCtx,
    temperature: MODEL.temperature,
    seed: MODEL.seed,
    runs,
    model: model?.model ?? "fake-sequence",
    ollama: ollamaMeta,
    warmup,
    warmupByDay: plants,
    loadAverage: os.loadavg(),
  };
  const label = arg("label") ? `_${arg("label")!.replace(/[^a-z0-9-]+/gi, "-")}` : "";
  // Live runs are always kept; a scripted run is kept with --save (the dashboard and eval:smoke/full do), else it goes
  // to test-results/ only (verify runs it on every change).
  const stamp = started.toISOString().replace(/[:.]/g, "-");
  const out = path.resolve(arg("out") ?? (save ? path.join(RESULTS_DIR, `${stamp}_${mode === "live" ? (model?.model ?? "model").replace(/[^a-z0-9.]+/gi, "-") : "scripted"}${suite === "smoke" ? "_smoke" : ""}${label}.json`) : path.join(ROOT, "test-results/evals/scripted-latest.json")));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const errored = results.filter((r) => r.status === "error").length;
  fs.writeFileSync(out, `${JSON.stringify({ meta, summary: { cases: results.length, passed, failed: results.length - passed - errored, errored, invariantViolations: violations }, metrics, thresholds: thresholdLines, results }, null, 1)}\n`);
  if (partial) fs.rmSync(partial, { force: true }); // complete: the full file replaces the progress file
  console.log(`eval:${mode} ${passed}/${results.length} passed, ${violations} invariant violations → ${path.relative(ROOT, out)}`);
  // Scripted (D1) gates on 100% and no violations; a full live run gates on evals/thresholds.json (§6.5).
  if (mode === "live") return subset ? (violations === 0 ? 0 : 1) : thresholdLines.every((l) => l.ok) ? 0 : 1;
  return passed === results.length && violations === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
