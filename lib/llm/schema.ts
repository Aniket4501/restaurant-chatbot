import { z } from "zod";

// The model's output contract (§5.7). partySize is 0–999 (D-06): the grammar must not coerce "150 people" into a
// smaller valid number; code decides what 0, 1–8 and 9+ mean. `z.toJSONSchema(TurnSchema)` is sent to Ollama as
// `format` and must equal evals/fixtures/turn.schema.json. v3 since D-24: `booking` is null unless the intent is
// "booking" (an object of six nulls was about a third of a short answer's generated tokens); interpretEnvelope turns
// a null booking back into nulls, so code always sees the object. v2 (D-20: "menu", "recommend", `prefs`) is kept as
// turn.schema.v2.json, and the v1 the Phase 2 probe validated as turn.schema.v1.json.

export const INTENTS = ["faq", "menu", "recommend", "booking", "manage_booking", "off_topic", "smalltalk", "unclear"] as const;
export type Intent = (typeof INTENTS)[number];

export const ANSWER_MAX = 600;

export const BookingSchema = z.object({
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
});

export const TurnSchema = z.object({
  intent: z.enum(INTENTS),
  booking: BookingSchema.nullable(), // D-24: null unless the intent is "booking"
  // D-20: the guest's active food preferences for "recommend" and "menu" turns, else null. Code validates them.
  prefs: z
    .object({
      diet: z.array(z.enum(["vegetarian", "vegan", "gluten-free", "jain"])).max(4),
      avoid: z.array(z.enum(["dairy", "nuts", "egg"])).max(3),
      maxPrice: z.number().int().min(0).max(100000).nullable(),
      course: z.enum(["small-plates", "tandoor", "mains", "breads-rice", "desserts", "drinks"]).nullable(),
      mild: z.boolean(),
      allergy: z.boolean(),
      relation: z.enum(["cheaper", "another"]).nullable(),
    })
    .nullable(),
  answer: z.string().max(ANSWER_MAX).nullable(), // faq and smalltalk only
  citedFactIds: z.array(z.string()).max(8),
  answerable: z.boolean(),
});

/** A turn as the model writes it (v3: booking may be null). */
export type TurnOut = z.infer<typeof TurnSchema>;
export type BookingFields = z.infer<typeof BookingSchema>;
/** A turn as code sees it, after interpretEnvelope: booking is always the object (nulls when the model sent null). */
export type Turn = Omit<TurnOut, "booking"> & { booking: BookingFields };
export const nullBooking = (): BookingFields => ({ branch: null, date: null, time: null, timeWindow: null, partySize: null, ambiguity: null });

/** The JSON schema sent as Ollama's `format` (and shown in the prompt). Computed once; it never changes at runtime. */
export const TURN_JSON_SCHEMA = z.toJSONSchema(TurnSchema) as Record<string, unknown>;
