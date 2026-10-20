# Status
Phase: 7 — QA and AI evaluation (IN PROGRESS)   Gate pending: none (G1, G2, G2-M approved 2026-10-19; G3 not triggered)   Updated: 2026-10-20
Current task: T-20 (fixes committed in d9fa131; review fixes and docs/EVAL_REPORT.md pending)   Branch: build/reservation-bot   Last commit: see `git log -1`
Last verification (2026-10-20, at d9fa131, clean tree):
- `npm run verify:release` → 11/11 steps passed (lint, typecheck, unit 272, unit tz ×2, integration 209, D1 42/42, build, E2E 21/21, invariants, model:check, D2 × 3)
- D2: 264/273 case-runs (96.7%), 0 invariant violations, every §6.5 gate and floor met (evals/results/2026-10-20T10-21-07-607Z_qwen3.5-9b.json). Same 81 cases as the baseline: 237/243 (baseline 225/243)
- Latency p95 3.58 s booking / 3.89 s FAQ (load average 2.3–4.5)
- Failing in all 3 runs: LV-FAQ-006 and LV-REG-008 (D-15 verbatim rule on "booking note"; needs a decision), LV-CLAIM-001 (regression from v4: "Monday night" read as Tue 20 Oct; passed 3/3 on v3)
T-20 review (read-only workflow, 8 agents; verdicts in the workflow journal, to save as docs/research/2026-10-20-t20-review.json) — confirmed, to fix before T-20 closes:
- HIGH statesClockTime accepts any digit or number word, so an invented time survives when the message has a party size or date ("make it lunch for 2 instead" → 12:00 confirm card). Fix: the model's hour must be supported by a clock expression in the message
- HIGH category facts label vegan dishes only "vegan"; "which X are vegetarian" can drop them. Fix: vegan items also say vegetarian
- HIGH LV-CLAIM-001 is a v4 regression, not flaky; report it so
- MEDIUM: '-ish' and compound time words dropped; one usable ambiguity candidate keeps the old value; rule 1 "confirmed booking" is not observable after a booking (empty success text); runner provenance read at the end of the run
- LOW: reason ranking for unusable ambiguity; time ambiguity bypasses the guard; untagged model names in ollamaState; weak expectations in LV-REG-005/006/008/009, LV-BK-001; Keema assertion loosened to a regex (H7)
- Refuted: today's weekday maps to next week; prompt quotes the failing cases; past day-and-month mapped to next year
New request (2026-10-20): redesign the guest chat UI and the admin dashboard after two user mockups ("Olivia Kitchen & Bar" style). Scope questions asked; nothing built yet. Changes §5.10 and possibly §4.3/BR-01, so it needs a DECISIONS entry before work starts
Notes:
- Latency on this shared machine is noisy; identical repeated prompts hit the prefix cache, so run 1 is reported separately
- New eval-case guest texts need `npx tsx scripts/kb-embed-fixture.ts` (Ollama) for real vectors under the fake embedder
- Draft EVAL_REPORT is in the session scratchpad (EVAL_REPORT.md); it must be updated after the review fixes
README known limits to include (Phase 9): non-numeric unsupported claims (§5.7); hedged claims (D-11); grounding checks that each price exists in the cited facts, not which item it belongs to (review RT-4)
Open questions / blockers:
- D-15 "booking note" decision (LV-FAQ-006, LV-REG-008)
- UI redesign scope (brand, photos, dashboard extras, order)
- `.claude/settings.json` still missing (user will add); §8 wording edit for D-01 pending (user); docs/MODEL_ADAPTER.md ready for review
Approved installs: G1 list (Node 26.12.0, qwen3.5:9b, qwen3-embedding:0.6b done); npm packages per SPEC + vite@8.3.4 (installed in T-01); Playwright Chromium (already cached)
Quarantined tests: none
