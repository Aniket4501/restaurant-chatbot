import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ActionSchema, AVOIDS, COURSES, DIETS, DraftSchema, MessageSchema } from "@/lib/chat/types";
import { ChooserSchema } from "@/lib/llm/chooser";
import { TurnSchema } from "@/lib/llm/schema";

// Eval case format (MASTER_PROMPT §6.3, D-12). One JSON object per line in evals/cases/*.jsonl. Unknown categories,
// keys and turn kinds are errors, so a typo can never silently skip a check.

/**
 * §6.2 categories, plus 21 `retrieval` (D-02), 22 `recommendation` (D-20) and, for D-21's quality areas,
 * `normalization` (noisy or informal input), `conversation` (multi-turn memory and follow-ups), `safety` (allergen,
 * diet and policy grounding, prompt and reasoning disclosure) and `ux` (response shape). evals/areas.ts groups them.
 */
export const CATEGORIES = [
  "faq",
  "menu",
  "hours",
  "booking_intent",
  "missing_info",
  "ambiguous_datetime",
  "invalid_input",
  "slot_unavailable",
  "valid_slot",
  "booking_success",
  "duplicate",
  "off_topic",
  "unsupported_fact",
  "injection",
  "malformed_output",
  "backend_failure",
  "conflicting_input",
  "false_claim",
  "retry_after_timeout",
  "context_loss",
  "retrieval",
  "recommendation",
  "normalization",
  "conversation",
  "safety",
  "ux",
] as const;
export type Category = (typeof CATEGORIES)[number];

const localStart = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "YYYY-MM-DDTHH:MM (branch-local)");

const SetupOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("book"), branch: z.string(), start: localStart, party: z.number().int(), name: z.string().optional(), phone: z.string().optional() }),
  z.strictObject({ op: z.literal("fill_tables"), branch: z.string(), start: localStart, party: z.number().int() }),
  /** Fault injection (§6.2 #16): availability reads throw, or the database write lock is held during submits. */
  z.strictObject({ op: z.literal("fault"), target: z.enum(["availability", "create_lock"]) }),
]);

/** A scripted model reply: a turn, an envelope, a fake directive, or the §6.3 tokens. */
/** A scripted turn; cases written before D-20 may leave out prefs (null). */
const ScriptTurn = z.strictObject({ ...TurnSchema.shape, prefs: TurnSchema.shape.prefs.default(null) });
const ScriptReply = z.union([ScriptTurn, ChooserSchema, z.strictObject({ raw: z.record(z.string(), z.unknown()) }), z.enum(["<<INVALID_JSON>>", "<<TIMEOUT>>", "<<DOWN>>"]), z.string().regex(/^#fake:[a-z_]+$/)]);

const Expect = z.strictObject({
  /** One intent, or a list of acceptable ones (e.g. an injection may be off_topic or unclear). */
  intent: z.union([z.string().nullable(), z.array(z.string()).min(1)]).optional(),
  outcome: z.string().optional(),
  actions: z.array(z.strictObject({ name: z.string(), args: z.record(z.string(), z.unknown()).optional() })).optional(),
  noActions: z.array(z.string()).optional(),
  draft: z.record(z.string(), z.unknown()).optional(),
  blocks: z.array(z.string()).optional(),
  fieldRequest: z.string().optional(),
  slotsInclude: z.array(z.string()).optional(),
  slotsExclude: z.array(z.string()).optional(),
  alternativesMin: z.number().int().optional(),
  mustCite: z.array(z.string()).optional(),
  mustCiteAny: z.array(z.string()).min(1).optional(),
  mustIncludeValues: z.array(z.string()).optional(),
  /** Canonical values that must NOT appear (times "19:00", prices "₹645", phones "+91…"). */
  mustNotIncludeValues: z.array(z.string()).optional(),
  mustAbstain: z.boolean().optional(),
  reservationsCreated: z.number().int().optional(),
  replyMustMatch: z.array(z.string()).optional(),
  replyMustNotMatch: z.array(z.string()).optional(),
  /** D-21: the reply text (not cards or lists) is at most this long, for intents that need a short answer. */
  replyMaxChars: z.number().int().min(20).optional(),
  retrievalMode: z.enum(["hybrid", "lexical", "none"]).optional(),
  modelCalls: z.number().int().optional(),
  submitStatus: z.number().int().optional(),
  submitCode: z.string().nullable().optional(),
  sameRefAsTurn: z.number().int().optional(),
  /**
   * D-20: the recommendation card this turn shows (it comes from the menu table, so these check facts, not wording).
   * Any defensible dish passes: `satisfies` checks every dish shown against the stated constraints, `anyOf` lists the
   * acceptable lead dishes when only a few are.
   */
  recommend: z
    .strictObject({
      shown: z.boolean().optional(),
      satisfies: z.strictObject({ maxPrice: z.number().int().optional(), diet: z.array(z.enum(DIETS)).optional(), course: z.enum(COURSES).optional(), avoid: z.array(z.enum(AVOIDS)).optional(), mild: z.boolean().optional() }).optional(),
      anyOf: z.array(z.string()).min(1).optional(),
      /** When a dish card is shown, its lead is one of these (for questions an FAQ answer may also answer). */
      leadIfShown: z.array(z.string()).min(1).optional(),
      notIds: z.array(z.string()).optional(),
      cheaperThanTurn: z.number().int().min(1).optional(),
      differentFromTurn: z.number().int().min(1).optional(),
    })
    .optional(),
  /** D-20: a menu list (section or dietary list) is shown. */
  menuShown: z.boolean().optional(),
  /**
   * D-26: a meal plan for a party with a budget. Each item's price is checked against the fixture menu, the subtotal
   * against the item prices, and the subtotal against `maxTotal`; `satisfies` checks every item's labels.
   */
  mealPlan: z
    .strictObject({
      shown: z.boolean().optional(),
      maxTotal: z.number().int().optional(),
      minItems: z.number().int().min(1).optional(),
      /** The subtotal is lower than the plan shown at this (1-based) turn. */
      cheaperThanTurn: z.number().int().min(1).optional(),
      satisfies: z.strictObject({ diet: z.array(z.enum(DIETS)).optional(), avoid: z.array(z.enum(AVOIDS)).optional() }).optional(),
    })
    .optional(),
  /** D-27: an opening-hours card is shown, for exactly these branches (short names), when given. */
  hours: z.strictObject({ shown: z.boolean().optional(), branches: z.array(z.string()).optional() }).optional(),
  /** D-26: whether a notice (the allergy note, a warning) is shown under the reply. */
  notice: z.strictObject({ shown: z.boolean() }).optional(),
  /** D-26: the food preferences in force after this turn (the last "prefs" trace entry), matched key by key. */
  prefsInForce: z.record(z.string(), z.unknown()).optional(),
  /**
   * D-26: every ₹ amount in the reply text is the price of a dish on screen or in the plan, the plan's subtotal, or a
   * budget the guest stated, so a reply never quotes a price that contradicts the menu or the budget.
   */
  pricesConsistent: z.boolean().optional(),
});
export type Expectation = z.infer<typeof Expect>;

const SelectAction = z.strictObject({ type: z.literal("select_slot"), branch: z.string(), start: localStart });
const Turn = z.union([
  z.strictObject({ guest: z.string(), expect: Expect.optional() }),
  z.strictObject({ action: z.union([ActionSchema, SelectAction]), expect: Expect.optional() }),
  z.strictObject({ submit: z.strictObject({ name: z.string(), phone: z.string(), email: z.string().optional(), note: z.string().optional() }), expect: Expect.optional() }),
  z.strictObject({ simulate: z.enum(["lost_response", "reload"]), expect: Expect.optional() }),
  /** Another guest books through the API between turns (e.g. the slot is taken before submit). */
  z.strictObject({ book: z.strictObject({ branch: z.string(), start: localStart, party: z.number().int(), phone: z.string().optional() }), expect: Expect.optional() }),
]);
export type CaseTurn = z.infer<typeof Turn>;

export const CaseSchema = z.strictObject({
  id: z.string().regex(/^[A-Z0-9][A-Z0-9-]*$/),
  version: z.number().int(),
  category: z.enum(CATEGORIES),
  severity: z.enum(["critical", "major", "minor"]),
  mode: z.enum(["scripted", "live"]),
  source: z.enum(["spec", "review", "regression", "probe", "audit"]).optional(),
  /** D-21: a noisy variant (typos, Hinglish, spacing, Unicode) of another case; its intent should match that case's. */
  variantOf: z.string().regex(/^[A-Z0-9][A-Z0-9-]*$/).optional(),
  notes: z.string().optional(),
  now: z.string().regex(/[+-]\d\d:\d\d$|Z$/, "ISO instant with an offset"),
  fixture: z.literal("base"),
  embedder: z.enum(["down", "timeout"]).optional(),
  /** Client state before turn 1, as a (possibly forged) client would send it (D-15 forged history and draft cases). */
  history: z.array(MessageSchema).max(7).optional(),
  draft: DraftSchema.optional(),
  setup: z.array(SetupOp).optional(),
  modelScript: z.array(ScriptReply).optional(),
  turns: z.array(Turn).min(1),
  expect: Expect.optional(),
  forbidden: z.array(z.enum(["reservation_created", "booking_claim_text", "slot_not_in_engine_output"])).optional(),
});
export type EvalCase = z.infer<typeof CaseSchema>;

/** Every case in a directory, validated; throws with file:line on the first problem. Duplicate IDs are errors. */
export function loadCases(dir: string): EvalCase[] {
  const out: EvalCase[] = [];
  const seen = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    fs.readFileSync(path.join(dir, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line.trim()) return;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          throw new Error(`${f}:${i + 1}: not valid JSON`);
        }
        const r = CaseSchema.safeParse(raw);
        if (!r.success) throw new Error(`${f}:${i + 1}: ${r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
        if (seen.has(r.data.id)) throw new Error(`${f}:${i + 1}: duplicate case id ${r.data.id}`);
        seen.add(r.data.id);
        out.push(r.data);
      });
  }
  return out;
}
