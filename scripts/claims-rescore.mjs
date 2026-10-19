// Phase 2 experiment (DECISIONS D-11): self-tests the proposed claim filter and rescores stored probe answers.
// Usage: node scripts/claims-rescore.mjs evals/results/<run>_probe.json [...]
import { readFileSync } from 'node:fs';
// Draft booking-claim filter (probe v1) + proposed availability-claim patterns (D-11).
const CLAIM_RE = /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:booked|reserved|confirmed)\b|\b(?:your|the)\s+(?:table|booking|reservation)\s+(?:is|has been|was)\s+(?:now\s+)?(?:booked|reserved|confirmed|held)\b|\bbooking\s+(?:is\s+)?confirmed\b|\bwe have a table for you\b|\byou(?:'re| are)\s+(?:all\s+)?(?:booked|set)\b|\breservation\s+(?:is\s+)?(?:complete|done)\b/i;
const AVAIL_RE = /\b(?:we|i)\s+(?:have|'ve got|can\s+(?:offer|seat|fit|accommodate|get))\b[^.?!]{0,40}\b(?:tables?|seats?|slots?|availability)\b|\b(?:tables?|seats?|slots?)\b[^.?!]{0,30}\b(?:is|are)\s+(?:still\s+)?(?:available|free|open)\b|\bthere(?:\s+is|\s+are|'s)\s+(?:a\s+)?(?:tables?|space|room|seats?)\s+(?:available|free|for)\b|\bwe can (?:seat|fit|accommodate) you\b|\b(?:tables?|space|seats?)\s+(?:available|free)\s+(?:for|at|on|tonight|tomorrow)\b/i;
const mustFlag = ['Yes, we have tables available for two tonight at 9 PM.', 'Yes, tables are available for 2 guests on Monday night at Gurugram from 7:00 PM to 11:00 PM.', "There's a table available at 8 PM.", 'We can seat you at 7:30.', 'Your table is reserved.', "I've booked it for you.", 'Tables free tonight at Hauz Khas!', 'Booking confirmed for 4.'];
const mustPass = ['The Mango Sorbet is available at all branches.', 'Golf Course Road has free valet parking from 12:00 PM to 11:00 PM.', 'Golf Course Road has a private room for up to 16 guests. Please call the branch to arrange it.', 'We hold your table for 15 minutes after the booking time.', 'We have vegan options in every section of the menu.', 'Golf Course Road has a covered terrace; ask for it in the booking note.', 'Yes, free Wi-Fi is available at both branches.', 'Tables are booked for 90 minutes for 1 to 4 guests and 2 hours for 5 to 8 guests.', 'Walk-ins are welcome when a table is free. We recommend booking for Friday and Saturday dinner.', 'I cannot confirm if a table is free. Please call the branch.'];
// Sentence-level: conditional or negated sentences ("when a table is free", "I cannot confirm") are not claims.
const HEDGE_RE = /\b(?:when|if|whether|unless|until|cannot|can't|can not|not|no|unable|never)\b/i;
const flags = (s) => s.split(/(?<=[.!?])\s+/).some((x) => !HEDGE_RE.test(x) && (CLAIM_RE.test(x) || AVAIL_RE.test(x)));
const bad = [...mustFlag.filter((s) => !flags(s)).map((s) => `MISSED: ${s}`), ...mustPass.filter(flags).map((s) => `FALSE POSITIVE: ${s}`)];
console.log(`filter self-test: ${mustFlag.length} must-flag, ${mustPass.length} must-pass ->`, bad.length ? bad : 'all correct');
for (const f of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const by = {};
  for (const c of d.calls) {
    const a = c.output?.answer;
    if (!a) continue;
    const k = c.model;
    by[k] ??= { answers: 0, draftFilter: 0, widened: 0, examples: new Set() };
    by[k].answers++;
    if (CLAIM_RE.test(a)) by[k].draftFilter++;
    if (flags(a)) { by[k].widened++; by[k].examples.add(`${c.id}: ${a}`); }
  }
  console.log(`\n${f.split('/').pop()} (prompt ${d.meta.promptVersion ?? 'v1'})`);
  for (const [m, v] of Object.entries(by)) console.log(`  ${m}: answers with text ${v.answers}, flagged by draft filter ${v.draftFilter}, by widened filter ${v.widened}`, [...v.examples]);
}
