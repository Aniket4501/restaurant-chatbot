import { z } from "zod";

// The model's output contract (§5.7). partySize is 0–999 (D-06): the grammar must not coerce "150 people" into a
// smaller valid number; code decides what 0, 1–8 and 9+ mean. `z.toJSONSchema(TurnSchema)` is sent to Ollama as
// `format` and must equal evals/fixtures/turn.schema.json (the grammar the Phase 2 probe validated).

export const INTENTS = ["faq", "booking", "manage_booking", "off_topic", "smalltalk", "unclear"] as const;
export type Intent = (typeof INTENTS)[number];

export const ANSWER_MAX = 600;

export const TurnSchema = z.object({
  intent: z.enum(INTENTS),
  booking: z.object({
    branch: z.string().nullable(), // a slug from the branch list
    date: z.string().nullable(), // YYYY-MM-DD copied from the calendar
    time: z.string().nullable(), // HH:MM 24h
    timeWindow: z.enum(["lunch", "dinner"]).nullable(),
    partySize: z.number().int().min(0).max(999).nullable(), // D-06; code enforces 1–8, 9+ gets the phone
    ambiguity: z
      .object({
        field: z.enum(["branch", "date", "time", "partySize"]),
        candidates: z.array(z.string()).min(2).max(4),
      })
      .nullable(),
  }),
  answer: z.string().max(ANSWER_MAX).nullable(), // faq and smalltalk only
  citedFactIds: z.array(z.string()).max(8),
  answerable: z.boolean(),
});

export type Turn = z.infer<typeof TurnSchema>;
export type BookingFields = Turn["booking"];

/** The JSON schema sent as Ollama's `format` (and shown in the prompt). Computed once; it never changes at runtime. */
export const TURN_JSON_SCHEMA = z.toJSONSchema(TurnSchema) as Record<string, unknown>;
