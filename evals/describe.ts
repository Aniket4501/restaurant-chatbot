import type { Expectation } from "@/evals/case";

// D-21: expectations in words, for the report and the dashboard (pure: the client imports it too).

/** A short, readable statement of what a case expects (the explorer's "Expected" column). */
export function describeExpect(e: Expectation | null | undefined): string[] {
  if (!e) return [];
  const out: string[] = [];
  if (e.intent !== undefined) out.push(`intent ${Array.isArray(e.intent) ? e.intent.join(" or ") : e.intent}`);
  if (e.outcome) out.push(`outcome ${e.outcome}`);
  if (e.draft) out.push(`booking ${Object.entries(e.draft).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`);
  if (e.mustCite?.length) out.push(`cites ${e.mustCite.join(", ")}`);
  if (e.mustCiteAny?.length) out.push(`cites one of ${e.mustCiteAny.join(", ")}`);
  if (e.mustIncludeValues?.length) out.push(`shows ${e.mustIncludeValues.join(", ")}`);
  if (e.mustNotIncludeValues?.length) out.push(`never shows ${e.mustNotIncludeValues.join(", ")}`);
  if (e.mustAbstain !== undefined) out.push(e.mustAbstain ? "abstains (fallback)" : "answers from the facts");
  if (e.recommend) {
    const r = e.recommend;
    if (r.shown !== undefined) out.push(r.shown ? "a dish card" : "no dish card");
    if (r.satisfies) out.push(`dishes meet ${Object.entries(r.satisfies).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ")}`);
    if (r.anyOf) out.push(`lead is one of ${r.anyOf.join(", ")}`);
    if (r.leadIfShown) out.push(`any lead is one of ${r.leadIfShown.join(", ")}`);
    if (r.notIds) out.push(`never shows ${r.notIds.join(", ")}`);
    if (r.cheaperThanTurn) out.push(`cheaper than turn ${r.cheaperThanTurn}'s lead`);
    if (r.differentFromTurn) out.push(`different from turn ${r.differentFromTurn}'s lead`);
  }
  if (e.menuShown !== undefined) out.push(e.menuShown ? "a menu list" : "no menu list");
  if (e.blocks?.length) out.push(`blocks ${e.blocks.join(", ")}`);
  if (e.fieldRequest) out.push(`asks for ${e.fieldRequest}`);
  if (e.slotsInclude?.length) out.push(`offers ${e.slotsInclude.join(" ")}`);
  if (e.reservationsCreated !== undefined) out.push(`${e.reservationsCreated} reservations created`);
  if (e.submitStatus !== undefined) out.push(`submit HTTP ${e.submitStatus}${e.submitCode ? ` ${e.submitCode}` : ""}`);
  if (e.modelCalls !== undefined) out.push(`${e.modelCalls} model calls`);
  for (const re of e.replyMustMatch ?? []) out.push(`reply matches /${re}/`);
  for (const re of e.replyMustNotMatch ?? []) out.push(`reply never matches /${re}/`);
  return out;
}

