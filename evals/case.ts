import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ActionSchema } from "@/lib/chat/types";
import { TurnSchema } from "@/lib/llm/schema";

// Eval case format (MASTER_PROMPT §6.3, D-12). One JSON object per line in evals/cases/*.jsonl. Unknown categories,
// keys and turn kinds are errors, so a typo can never silently skip a check.

/** §6.2 categories, plus 21 `retrieval` (D-02). */
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
const ScriptReply = z.union([TurnSchema, z.strictObject({ raw: z.record(z.string(), z.unknown()) }), z.enum(["<<INVALID_JSON>>", "<<TIMEOUT>>", "<<DOWN>>"]), z.string().regex(/^#fake:[a-z_]+$/)]);

const Expect = z.strictObject({
  intent: z.string().nullable().optional(),
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
  mustIncludeValues: z.array(z.string()).optional(),
  mustAbstain: z.boolean().optional(),
  reservationsCreated: z.number().int().optional(),
  replyMustMatch: z.array(z.string()).optional(),
  replyMustNotMatch: z.array(z.string()).optional(),
  retrievalMode: z.enum(["hybrid", "lexical", "none"]).optional(),
  modelCalls: z.number().int().optional(),
  submitStatus: z.number().int().optional(),
  submitCode: z.string().nullable().optional(),
  sameRefAsTurn: z.number().int().optional(),
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
  source: z.enum(["spec", "review", "regression", "probe"]).optional(),
  notes: z.string().optional(),
  now: z.string().regex(/[+-]\d\d:\d\d$|Z$/, "ISO instant with an offset"),
  fixture: z.literal("base"),
  embedder: z.enum(["down", "timeout"]).optional(),
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
