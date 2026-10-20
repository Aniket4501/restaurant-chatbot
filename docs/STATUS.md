# Status
Phase: 6 — Local model integration   Gate pending: none (G1, G2, G2-M approved 2026-10-19)   Updated: 2026-10-20
Current task: T-19 D2 dataset and live baseline (next)   Branch: build/reservation-bot   Last commit: see `git log -1`
Last verification (2026-10-20, after the Phase 5 review fixes):
- `npm run verify` → 9/9 steps passed: lint, typecheck, test:unit (257), test:unit:tz (257 ×2), test:integration (209), eval:scripted (39/39, 0 invariant violations), build, test:e2e (21/21 with the §6.4 invariants after every spec; axe on every UI state), invariant report
- Phase 5 exit (§8): the full primary journey works through the built app with the fake model (chips-only and typed-only booking; admin sees and cancels it); `npm run verify` green
Done in Phase 5:
- T-10 knowledge base and retrieval (D-13 amendment approved 2026-10-20): lib/kb/*, kb:index, real-vector embeddings fixture, golden top-8 lists (tests/golden/retrieval-top8.json)
- T-11 model adapter (lib/llm/*, docs/MODEL_ADAPTER.md); prompt v3 = probe v2 plus the approved D-10/D-13/D-15 changes only
- T-12 grounding, claims and hours (lib/chat/{grounding,claims,hours}.ts)
- T-13 runTurn and POST /api/chat (lib/chat/*, lib/api/chat.ts); /api/health reports index coverage
- T-14 eval runner, invariants INV-01…07, thresholds.json, 39 D1 cases (evals/)
- T-15 E2E harness (two servers, reset route, invariants after every spec) and `npm run verify`
- T-16 guest UI and T-17 admin UI (components/, app/); OWN-2 (admin epoch per bundle) found and fixed in T-17
- Phase 5 review of T-10…T-17 (docs/REVIEW.md "Phase 5"): 16 of 20 findings valid (14 distinct), all fixed with regression tests
Done in Phase 6:
- T-18: lib/llm/ollama.ts (D-05 body, error mapping, plantSnapshot), provider wired (OLLAMA_CHAT_READY), scripts/model-check.ts and model-warm.ts. `npm run model:check` passed live (qwen3.5:9b d63f830f28d5 and qwen3-embedding:0.6b ac6da0dfba84, both local; MLX; think:false honoured; warm round-trip 1166 ms with 3301/3306 cached; index 86/86). Hosted-provider grep: no matches
- Live smoke (5 conversations, evals/cases/live-smoke.jsonl; transcripts in evals/results/2026-10-20T09-05-30-328Z_qwen3.5-9b_smoke.json): 4/5 pass, 0 invariant violations. LV-SMOKE-04 fails repeatably: the model calls Ember Pistachio Kulfi vegan (it contains dairy and nuts); grounding accepts it because the prices are real (known limit on non-numeric claims). The first smoke run (09-03-46Z) also had a cold-prefill timeout at load average 25; the live runner now warms the prefix for the cases' date before scoring
Phase 6 notes (T-19):
- Latency under this shared machine's load is noisy (load average 14–25, ~22 GB swap in use); identical repeated prompts hit the prefix cache, so report run 1 separately
- Measure in D2 before tuning: D-15 makes any FAQ sentence with booking words (book, table, seat, slot, spot…) verbatim-only; smalltalk is now very strict (no numbers, money or availability words); the prompt's smalltalk example contains "bookings", so it always gets the fixed greeting
- New eval-case guest texts need `npx tsx scripts/kb-embed-fixture.ts` (Ollama) for real vectors under the fake embedder
- Case-format additions beyond §6.3 are listed in evals/case.ts ({book} turns, fault setup op, select_slot with a local start, extra expectation keys)
README known limits to include (Phase 9): non-numeric unsupported claims (§5.7); hedged claims (D-11); grounding checks that each price exists in the cited facts, not which item it belongs to (review RT-4)
Open questions / blockers:
- `.claude/settings.json` still missing (user will add)
- §8 wording edit for D-01 pending (user)
- docs/MODEL_ADAPTER.md is ready for your review (T-11 "done when")
Approved installs: G1 list (Node 26.12.0, qwen3.5:9b, qwen3-embedding:0.6b done); npm packages per SPEC + vite@8.3.4 (installed in T-01); Playwright Chromium (already cached)
Quarantined tests: none
