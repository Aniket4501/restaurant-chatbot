import { z } from "zod";
import { RULES } from "@/lib/config";
import type { Intent } from "@/lib/llm/schema";
import { isLocalDate, isLocalTime } from "@/lib/time/tz";

// The /api/chat contract (§5.7, §5.9, D-13, D-15). The server is stateless: the client sends back the draft and
// context it was given, and every field is re-validated strictly, so a forged draft can only describe a booking
// request, never create one (bookings go through POST /api/reservations, which re-checks everything).

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);

export const DraftSchema = z.strictObject({
  branch: slug.nullable(),
  date: z.string().refine(isLocalDate, "YYYY-MM-DD").nullable(),
  time: z.string().refine(isLocalTime, "HH:MM").nullable(),
  timeWindow: z.enum(["lunch", "dinner"]).nullable(),
  partySize: z.number().int().min(RULES.onlinePartyMin).max(RULES.onlinePartyMax).nullable(),
  /** The slot behind a shown confirm card (D-15 pending-confirm rule). */
  selected: z.strictObject({ startsAt: z.number().int() }).nullable(),
});
export type Draft = z.infer<typeof DraftSchema>;
export const emptyDraft = (): Draft => ({ branch: null, date: null, time: null, timeWindow: null, partySize: null, selected: null });

export const FIELDS = ["branch", "date", "time", "timeWindow", "partySize"] as const;
export type Field = (typeof FIELDS)[number];

/** Menu sections, as in the seed (D-20). */
export const COURSES = ["small-plates", "tandoor", "mains", "breads-rice", "desserts", "drinks"] as const;
export type Course = (typeof COURSES)[number];
/** Verified dietary tags a guest can ask for, and the allergens the menu labels (contains-*). */
export const DIETS = ["vegetarian", "vegan", "gluten-free", "jain"] as const;
export const AVOIDS = ["dairy", "nuts", "egg"] as const;
/** Allergens the menu labels don't cover (D-20 review): a guest who states one is sent to staff, never recommended a dish. */
export const UNLISTED = ["shellfish", "fish", "seafood", "soy", "sesame", "mustard", "mushroom", "coconut", "other"] as const;

/**
 * Food chips with a fixed meaning (D-24). Sent as an action, they skip the intent call: "Help me find a dish" gets its
 * question with no model call, and the others go straight to the dish chooser, which still validates every pick.
 * Typed text always takes the model path.
 */
export const RECOMMEND_CHIP_TEXTS = ["Help me find a dish", "Recommend something vegetarian", "Anything cheaper?", "Show me another option", "Something light", "Something filling", "Something vegetarian", "Surprise me", "Any price is fine", "Forget the vegan", "Forget the vegetarian", "Spicy is fine", "Something vegan", "I eat everything", "A light snack", "A light main course", "A light dessert", "A filling main course", "A filling snack"] as const;
export const HELP_CHIP_TEXT = "Help me find a dish";
/** The label each food chip shows (and the guest's bubble says) when it differs from its text. */
export const RECOMMEND_CHIP_LABEL: Partial<Record<(typeof RECOMMEND_CHIP_TEXTS)[number], string>> = { "Anything cheaper?": "Something cheaper", "Show me another option": "Another option", "Any price is fine": "Any price", "Forget the vegan": "Not only vegan", "Forget the vegetarian": "Not only vegetarian" };

export const ActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("set_field"), field: z.enum(FIELDS), value: z.union([z.string().max(64), z.number().int().min(0).max(999), z.null()]) }),
  z.strictObject({ type: z.literal("select_slot"), branch: slug, startsAt: z.number().int() }),
  /** Browse the menu: no section gives the list of sections (D-20). No model call. */
  z.strictObject({ type: z.literal("menu"), course: z.enum(COURSES).nullable() }),
  /** A food chip with a fixed meaning (D-24). */
  z.strictObject({ type: z.literal("recommend"), text: z.enum(RECOMMEND_CHIP_TEXTS) }),
  /**
   * The "Opening hours" chip (D-24), and D-27's branch chips: a branch ("all" for every branch) and a date keep what an
   * hours question asked about. No model call.
   */
  z.strictObject({
    type: z.literal("hours"),
    branch: z.union([slug, z.literal("all")]).optional(),
    date: z.string().refine(isLocalDate, "YYYY-MM-DD").optional(),
    dates: z.array(z.string().refine(isLocalDate, "YYYY-MM-DD")).max(3).optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    meal: z.enum(["lunch", "dinner"]).optional(),
  }),
]);

/**
 * The guest's active food preferences, carried between turns (D-20). The model proposes them each turn; code adds
 * any it can read for certain in the guest's own words and validates every recommendation against them.
 */
export const PrefsSchema = z.strictObject({
  diet: z.array(z.enum(DIETS)).max(4),
  avoid: z.array(z.enum(AVOIDS)).max(3),
  maxPrice: z.number().int().min(1).max(100_000).nullable(),
  course: z.enum(COURSES).nullable(),
  mild: z.boolean(),
  allergy: z.boolean(),
  unlisted: z.array(z.enum(UNLISTED)).max(UNLISTED.length).default([]),
  /** D-26: the guest likes it spicy (medium or hot). Never set together with mild. */
  spicy: z.boolean().default(false),
  /** D-26: ingredients the guest doesn't want ("not paneer"), only words found in the menu's names or descriptions. */
  exclude: z.array(z.string().regex(/^[a-z]{3,24}$/)).max(5).default([]),
});
export type Prefs = z.infer<typeof PrefsSchema>;
export const noPrefs = (): Prefs => ({ diet: [], avoid: [], maxPrice: null, course: null, mild: false, allergy: false, unlisted: [], spicy: false, exclude: [] });

/** Bounded conversation memory the client sends back (D-13, D-20). Item IDs are re-checked against the menu. */
export const ContextSchema = z.strictObject({
  lastCitedIds: z.array(z.string().max(100)).max(8),
  prefs: PrefsSchema.nullable().optional(),
  /** Dishes suggested so far in this conversation, most recent first ("another", "cheaper"). */
  recommended: z.array(z.string().max(100)).max(6).optional(),
  /** D-26: clarifying questions already asked in this conversation, so none is asked twice. */
  asked: z.array(z.enum(["diet", "course", "plan_diet"])).max(4).optional(),
  /** Dishes last on screen, in display order (cards, menu lists, plans, dishes an answer cited): "cheaper" and "the second one" refer to these (FM-004). */
  shown: z.array(z.string().regex(/^menu:[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100)).max(8).optional(),
  /** D-28: the allergy note has been shown for the allergies now in force (shown again only when they change). */
  allergyNoted: z.boolean().optional(),
  /** D-28: the meal being planned for a group: party, total budget, what they eat, and the last plan's total and dishes. */
  plan: z
    .strictObject({
      party: z.number().int().min(1).max(12),
      budget: z.number().int().min(1).max(200_000),
      basis: z.enum(["total", "per_person"]),
      diet: z.enum(["vegetarian", "vegan", "any", "mixed", "mixed_vegan"]).nullable(),
      subtotal: z.number().int().min(0).nullable(),
      // Dish IDs only: the client sends this back, and it reaches the planner prompt (failure-mode audit FM-026).
      items: z.array(z.string().regex(/^menu:[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100)).max(10),
    })
    .optional(),
  /** D-27: what the last hours answer was about, for a follow-up ("what about Golf Course Road?"). */
  hours: z.strictObject({ branches: z.array(slug).max(8), date: z.string().refine(isLocalDate, "YYYY-MM-DD").nullable() }).optional(),
});
export type HoursFocus = NonNullable<z.infer<typeof ContextSchema>["hours"]>;
export type PlanFocus = NonNullable<z.infer<typeof ContextSchema>["plan"]>;
export type TurnContext = z.infer<typeof ContextSchema>;
export type Action = z.infer<typeof ActionSchema>;

export const MessageSchema = z.strictObject({ role: z.enum(["guest", "assistant"]), content: z.string() });
export type ChatMessage = z.infer<typeof MessageSchema>;

/** POST /api/chat body (D-15 caps). Sizes over 16 KB are refused with 413 before parsing (readJson). */
export const ChatBodySchema = z
  .strictObject({
    sessionId: z.uuid(),
    messages: z.array(MessageSchema).max(8),
    draft: DraftSchema.nullable(),
    action: ActionSchema.optional(),
    context: ContextSchema.optional(),
    /** One id per guest action; a repeat of the same id gets the same reply, with no second model call (D-20). */
    requestId: z.uuid().optional(),
  })
  .superRefine((b, ctx) => {
    b.messages.forEach((m, i) => {
      const max = m.role === "guest" ? 500 : 600;
      if (m.content.length > max) ctx.addIssue({ code: "custom", path: ["messages", i, "content"], message: `at most ${max} characters` });
    });
    if (!b.action) {
      const last = b.messages.at(-1);
      if (!last || last.role !== "guest" || !last.content.trim()) ctx.addIssue({ code: "custom", path: ["messages"], message: "the last message must be the guest's (or send an action)" });
    }
  });
export type ChatBody = z.infer<typeof ChatBodySchema>;

/** A chip either performs an action (no model call) or sends text as the guest's next message. */
export type Chip = { label: string; action: Action } | { label: string; text: string };

export type SlotChip = {
  label: string;
  branch: string;
  branchName: string;
  date: string;
  dateLabel: string;
  time: string;
  service: "lunch" | "dinner";
  startsAt: string; // ISO with the branch offset
  startsAtMs: number;
  action: Action;
};

/** One branch in an hours card (D-27): a row per service; a note only where the hours differ from the usual ones. */
export type HoursSection = { branch: string; subtitle: string; special: string | null; rows: { label: string; value: string; closed: boolean; note: string | null }[]; /** "On Saturdays": a coming Saturday with special hours. */ note: string | null };

export type Block =
  | { type: "quick_replies"; chips: Chip[] }
  | { type: "field_request"; field: Field; prompt: string; chips: Chip[] }
  | {
      type: "slots";
      heading: string; // "Sat 24 Oct · Hauz Khas · 4 guests" (§5.10)
      branch: string;
      date: string;
      partySize: number;
      reason: null | "closed" | "no_more_today" | "fully_booked" | "time_unavailable";
      groups: { service: "lunch" | "dinner"; slots: SlotChip[] }[];
      alternatives: SlotChip[];
    }
  | {
      type: "confirm";
      branch: string;
      branchName: string;
      address: string;
      phone: string;
      date: string;
      dateLabel: string;
      time: string;
      timeLabel: string;
      startsAt: string;
      startsAtMs: number;
      partySize: number;
      sittingMinutes: number;
    }
  | { type: "info"; factIds: string[]; items: { id: string; text: string }[] }
  /** Dishes from the menu table (D-20): `lead` means items[0] is the suggestion and the rest are alternatives. */
  | { type: "recommendation"; lead: boolean; items: MenuItemView[] }
  /** A menu section, or dishes matching the guest's preferences, grouped by course (D-20). */
  | { type: "menu_list"; groups: { course: Course; label: string; items: MenuItemView[] }[] }
  | { type: "notice"; tone: "info" | "warning"; text: string }
  /** D-28: a meal for a group within a budget: dishes from the menu table, quantities, and the total code worked out. */
  | { type: "meal_plan"; party: number; budget: number; budgetBasis: "total" | "per_person"; items: (MenuItemView & { qty: number })[]; subtotal: number; caveats: string[] }
  /** D-27: opening hours for a branch and a date (or its regular week), from the hours tables; no prose times. */
  | { type: "hours"; sections: HoursSection[] }
  /** Added by the client, and only from a 201/200 reservation response (BR-12, §5.7). Never sent by /api/chat. */
  | {
      type: "confirmation";
      ref: string;
      status: "confirmed" | "cancelled";
      branchName: string;
      address: string;
      phone: string;
      dateLabel: string;
      timeLabel: string;
      partySize: number;
      guestName: string;
    };

/** A dish as the guest sees it, built only from the menu table (never from model text). */
export type MenuItemView = {
  id: string;
  name: string;
  course: Course;
  courseLabel: string;
  price: number;
  description: string;
  /** Verified labels: "Vegan", "Vegetarian", "Gluten-free", "Jain option". */
  labels: string[];
  /** Labelled allergens: "dairy", "nuts", "egg". */
  contains: string[];
  /** 0 not spicy … 3 hot; null when the menu doesn't say (never shown as "not spicy"). */
  spice: number | null;
  /** "Golf Course Road only", or null when served at every branch. */
  scope: string | null;
};

export type Outcome =
  | "faq_answer"
  | "recommend"
  | "menu"
  | "hours_answer"
  | "faq_fallback"
  | "ask_field"
  | "slots"
  | "confirm"
  | "redirect"
  | "manage_redirect"
  | "smalltalk"
  | "clarify"
  | "degraded"
  | "rate_limited"
  | "action";

/** Backend actions in order (§5.7 `trace`); the eval runner asserts on these. Never contains guest text. */
export type TraceEntry =
  | { action: "retrieve"; mode: "hybrid" | "lexical"; reason: string | null; ids: string[] }
  | { action: "model_call"; attempt: 1 | 2; result: "ok" | string }
  | { action: "check_availability"; args: { branch: string; date: string; partySize: number; time: string | null; window: string | null }; result: string; slots: number; alternatives: number }
  | { action: "ask_field"; field: Field; reason?: string }
  /** A model value the guest's latest message doesn't state, dropped before the merge (§5.7). */
  | { action: "ignore_field"; field: Field; reason: "not_stated" }
  /** A model value replaced by a deterministic reading of the guest's message (D-17). */
  | { action: "correct_field"; field: Field; reason: "weekday" | "day_of_month" | "large_party" | "stated" | "relative_day" }
  | { action: "intent_skipped"; reason: "evidence" }
  /** Food preferences in force after this turn (D-20); `added` lists what code read from the guest's own words. */
  | { action: "prefs"; prefs: Prefs; added: string[]; /** D-28: what the model proposed that the guest didn't state (not applied). */ inferred?: string[] }
  /** The menu filtered by the preferences (D-20): how many dishes fit, and why none did. */
  | { action: "eligible"; count: number; none: string | null }
  /** One chooser call: the dish ids it proposed, and why code rejected the proposal (empty when valid). */
  | { action: "recommend"; attempt: 1 | 2; result: "ok" | string; pick: string | null; alternatives: string[]; rejected: string[] }
  | { action: "menu"; course: Course | null; items: number }
  | { action: "confirm"; branch: string; startsAt: number }
  | { action: "answer_faq"; ids: string[]; rendered: boolean }
  | { action: "fallback_unknown"; reason: string }
  | { action: "redirect"; kind: "off_topic" | "manage_booking" | "large_party" }
  | { action: "smalltalk"; shown: boolean }
  | { action: "clarify" }
  /** D-26: one clarifying question about the guest's preferences, asked by code. */
  | { action: "ask_pref"; args: { field: "diet" | "course" | "plan_diet" } }
  /** D-28: a planning request read in code, and each planner attempt with what code found wrong. */
  | { action: "plan_scope"; party: number; budget: number; diet: string; dishes: number; least: number | null }
  | { action: "plan"; attempt: 1 | 2; result: string; items: string[]; subtotal: number | null; rejected: string[] }
  /** D-26: a popularity, review or evidence question, answered from the data the restaurant has (bestseller marks). */
  | { action: "evidence"; args: { kind: "sales" | "reviews" | "evidence"; bestsellers: number } }
  | { action: "pending_confirm" }
  | { action: "degraded"; code: string }
  | { action: "rate_limited" }
  | { action: "metrics_write_failed" }
  | { action: "availability_error" }
  /** Recorded by the eval runner for {submit} turns (§5.7). */
  | { action: "create_reservation"; result: { status: number; code: string | null; ref: string | null } };

export type TurnReply = {
  status: "ok" | "rate_limited";
  retryAfterMs?: number;
  reply: { text: string; blocks: Block[] };
  draft: Draft;
  intent: Intent | null;
  context: TurnContext;
  trace: TraceEntry[];
  meta: {
    outcome: Outcome;
    degraded: boolean;
    retrievalMode: "hybrid" | "lexical" | "none";
    retrievalReason: string | null;
    citedFactIds: string[];
    model: string;
    promptVersion: string | null;
    latencyMs: number;
    modelMs: number | null;
    retrievalMs: number | null;
    promptTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    /** Where the turn's time went (D-24), in ms. `otherMs` is the rest: validation, routing and formatting. */
    timing: TurnTiming;
  };
};

export type TurnTiming = {
  setupMs: number;
  retrievalMs: number | null;
  promptMs: number | null;
  /** Waiting for the model gate (another session's call, or a warm-up step). */
  queueMs: number | null;
  /** The Ollama /api/ps check (D-23). */
  statusMs: number | null;
  /** The turn model's calls, including a corrective retry. */
  turnModelMs: number | null;
  /** The recommendation chooser's calls (D-20). */
  chooserMs: number | null;
  otherMs: number;
  /** Model calls made (turn, retries, chooser). */
  calls: number;
  /** Ollama's split, summed over the calls (null with the fake model). */
  loadMs: number | null;
  promptEvalMs: number | null;
  evalMs: number | null;
  /** Tokens generated and prompt tokens read (not cached), summed over the calls. */
  evalTokens: number | null;
  uncachedPromptTokens: number | null;
};
