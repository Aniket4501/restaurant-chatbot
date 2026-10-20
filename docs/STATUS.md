# Status
Phase: 6 — Local model integration (DONE)   Gate pending: none (G1, G2, G2-M approved 2026-10-19; G3 not triggered)   Updated: 2026-10-20
Current task: none. Next is Phase 7 (T-20 QA and AI evaluation)   Branch: build/reservation-bot   Last commit: see `git log -1`
Last verification (2026-10-20, end of Phase 6):
- `npm run verify` → 9/9 steps passed (unit 267, tz ×2, integration 209, D1 39/39 with 0 violations, build, E2E 21/21, invariant report)
- `npm run model:check` → passed (qwen3.5:9b d63f830f28d5 and qwen3-embedding:0.6b ac6da0dfba84, local, MLX, think:false honoured, index 86/86)
- D2 baseline `npm run eval -- --runs 3 --label baseline` → 225/243 case-runs (92.6%), 0 invariant violations, every §6.5 gate and floor met (evals/results/2026-10-20T09-18-11-078Z_qwen3.5-9b_baseline.json; summary in docs/MODEL_SELECTION.md "Phase 6 live baseline")
- Hosted-provider grep over lib/app/components/scripts/evals/package.json/proxy.ts → no matches
Phase 6 exit (§8): model:check passes; the model meets the §6.5 floors; misses listed below for Phase 7; no hosted-provider code
Done in Phase 6:
- T-18 Ollama chat client, model:check, model:warm; 5 live smoke conversations (evals/results/*_smoke.json)
- T-19 eval metrics and thresholds (evals/metrics.ts), D2 dataset (evals/cases/live-d2.jsonl, 76 cases + 5 smoke), single-run trial and 3-run baseline committed
For Phase 7 (T-20) — the 6 cases that fail in every run (details in docs/MODEL_SELECTION.md):
- LV-SMOKE-04 kulfi called vegan (model, non-numeric claim; grounding can't see it)
- LV-BK-007 "the 28th" → 4 Nov (model extraction); LV-CONF-001 meal change re-extracted from history (model); LV-CONF-002 "make that 4 people" → manage_booking (model)
- LV-INV-004 out-of-horizon date gets a reasonless "Which date?" (prompt/app design)
- LV-FAQ-006 correct cake answer replaced by the fallback (D-15 verbatim rule for booking words; its measured precision cost)
- Latency: p95 4.43 s booking / 4.91 s FAQ under shared-machine load (target 4 s, AC-12 is a target); run 1 booking p95 3.63 s
- Each fix in Phase 7 starts as a regression case (§6.6); prompt changes re-run D1 and the affected D2 categories at 1 run, then the full D2 at 3 runs before exit
Notes:
- Latency on this shared machine is noisy (load average 14–25, ~22 GB swap); identical repeated prompts hit the prefix cache, so run 1 is reported separately
- New eval-case guest texts need `npx tsx scripts/kb-embed-fixture.ts` (Ollama) for real vectors under the fake embedder
- Case-format additions beyond §6.3 are listed in evals/case.ts ({book} turns, fault op, select_slot with a local start, history/draft before turn 1, extra expectation keys)
README known limits to include (Phase 9): non-numeric unsupported claims (§5.7; seen live in LV-SMOKE-04); hedged claims (D-11); grounding checks that each price exists in the cited facts, not which item it belongs to (review RT-4)
Open questions / blockers:
- `.claude/settings.json` still missing (user will add)
- §8 wording edit for D-01 pending (user)
- docs/MODEL_ADAPTER.md is ready for your review (T-11 "done when")
Approved installs: G1 list (Node 26.12.0, qwen3.5:9b, qwen3-embedding:0.6b done); npm packages per SPEC + vite@8.3.4 (installed in T-01); Playwright Chromium (already cached)
Quarantined tests: none
