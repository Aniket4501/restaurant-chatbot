// D-21: the quality areas the report and the dashboard group results by. Each eval category belongs to exactly one
// area; a case's area is its category's. Areas are for reading results, not for gating (gates: evals/thresholds.json).

export type AreaKey = "normalization" | "understanding" | "grounding" | "recommendations" | "conversation" | "reservations" | "safety" | "ux" | "reliability";

export const AREAS: { key: AreaKey; label: string; categories: string[]; about: string }[] = [
  { key: "normalization", label: "Input normalization", categories: ["normalization"], about: "Typos, informal English, Hinglish, spacing, capitals, numbers as words, Unicode: the same request should be understood the same way." },
  { key: "understanding", label: "Intent and entities", categories: ["booking_intent", "ambiguous_datetime", "conflicting_input", "missing_info", "off_topic"], about: "Which intent the message has and which booking details it states, including dates, times, corrections and ambiguity." },
  { key: "grounding", label: "Retrieval and grounding", categories: ["faq", "menu", "hours", "retrieval", "unsupported_fact"], about: "Answers come from stored facts: the right facts are cited, prices and hours are exact, unknown facts get the fallback." },
  { key: "recommendations", label: "Recommendations", categories: ["recommendation"], about: "The model picks a real, available dish that meets every stated constraint, explains it from menu data, or says honestly that nothing fits." },
  { key: "conversation", label: "Conversation and follow-ups", categories: ["conversation", "context_loss"], about: "Multi-turn memory: follow-ups, pronouns, corrections, rejected suggestions and topic changes keep the right state." },
  { key: "reservations", label: "Reservations", categories: ["valid_slot", "slot_unavailable", "booking_success", "duplicate", "invalid_input", "false_claim"], about: "Availability, slot choice, invalid input, duplicates and confirmations that match a saved row." },
  { key: "safety", label: "Safety and policy", categories: ["safety", "injection"], about: "No unsupported allergen or diet claims, no invented policies, resistance to prompt injection, no prompt or reasoning disclosure." },
  { key: "ux", label: "Response quality", categories: ["ux"], about: "Concise replies, no duplicated text, no menu dumps, no raw IDs, JSON or internal wording." },
  { key: "reliability", label: "Reliability and recovery", categories: ["malformed_output", "backend_failure", "retry_after_timeout"], about: "Model down, timeouts, invalid output, failed reads and writes: the guest gets a clear message and booking still works." },
];

const BY_CATEGORY = new Map(AREAS.flatMap((a) => a.categories.map((c) => [c, a.key] as const)));

/** The area a category belongs to; an unknown category (from an older results file) is reported under "other". */
export function areaOf(category: string): AreaKey | "other" {
  return BY_CATEGORY.get(category) ?? "other";
}
