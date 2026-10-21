# Status
Phase: 7 — QA and AI evaluation (DONE) + D-19 demo scope + D-20 + D-21 (eval framework, dashboard, improvements)   Gate pending: none (G1, G2, G2-M approved 2026-10-19; G3 not triggered)   Updated: 2026-10-21
Current task: none. D-24 delivered (testing, quality and latency campaign): live 216 → 221/232, scripted 103 → 107/107, warm lookups 2.8 → 2.0 s p50, recommendations 4.8 → 3.9 s p50 (bench); docs/EVAL_REPORT.md D-24 section
D-20 (user, 2026-10-20): LLM-chosen recommendations validated by code, preference memory, menu browsing, one reply per action, no duplicate fact card. 46955af = D-20 (1/2)
D-20 review (docs/research/2026-10-20-d20-review.json): 48 confirmed findings, 42 fixed with a test, 6 partly fixed or deliberately unchanged (listed in the file and in DECISIONS D-20 amendment)
D-21 (user, 2026-10-21): eval framework (9 quality areas, suites, reports, baseline comparison), /admin/evals dashboard, +85 framework cases and +36 audit cases (24 scripted, 12 live), improvements measured against the baseline
D-21 baseline (56297b8, evals/baseline.json): scripted 73/75, live 173/187, 0 invariant violations, recovery gate 0.80 (duplicate availability message)
D-21 audit (read-only workflow): 32 confirmed findings, each a case; see DECISIONS D-21 improvements
D-21 final (24437ac): scripted 100/100; live 206/211, 0 invariant violations, 16/16 gates; the 187 baseline cases 173 → 186; audit live 2/12 → 11/12, scripted 0/24 → 25/25; held-out 7/12 → 9/12 (LV-HOLD-009/012 fixed after scoring, verified on 11 targeted live cases)
Remaining (D-24 final, all failing safe): LV-HOLD-010 meta request + question still off_topic; LV-GAP-002 / LV-GRD-011 fallback where labels answer (egg, vegan paneer); LV-RES-002 past date without the reason; LV-REC-010 allergy dessert request answered with the warning only; LV-AUD-008 group recommendation falls back to a list; LV-GAP-006/007/016 long chain, abandon by text, 'the second one'; LV-MENU-003 cheapest-main intent; LV-GAP-015 unavailable dish not mentioned; cold start 14 s after an Ollama restart; the bench and other servers share Ollama (stop them before benchmarking); release run ×3 not repeated
Last verification (2026-10-21, D-24 final c0f40f2): `npm run verify` 9/9 (unit 454, integration 240, D1 107/107, E2E 36/36); live full 221/232, 0 invariant violations, 16/16 gates (results file *_d24-final-c0f40f2.json); bench final-quiet and final-chips
Earlier (2026-10-21, D-22 + D-23): `npm run verify` 9/9 (unit 437, integration 222, D1 100/100, E2E 32/32). Read-only review (3 reviewers, 8 skeptics): 6 confirmed findings, all fixed (warm-up had its own gate in the built server, CLI eval runs not detected, embedder warmed under EMBED_PROVIDER=fake, two stale docs, two dropped proxy host cases); the warm-up round test fails when the gate is bypassed or held for the whole round
Earlier verification (2026-10-20):
- After the review fixes: unit 424, integration 212, D1 70/70, E2E 27/27 (each run separately; `npm run verify` result in the D-20 (2/2) commit message)
- Mutation checks: each new D1 case (SC-REC-007, 014, 015, 016) and E2E guard test (reload replay, chips during a submit, in-flight flag) fails when its fix is removed; the unmutated build passes
- Live D2 × 1 of the review fixes (8c6d6f6, d20-try3): 107/107, 0 invariant violations, every metric 1.0 except retrieval (floors met); recommendation p50/p95 7.4/8.7 s at load average 10
- User walkthrough (2026-10-20): "Help me find a dish" timed out while the release run used the model, and the degraded message showed twice. Fixed: message once with menu and Find a table chips; answer chips for clarifying questions; chooser c5; "cheaper" stays in the section. Release run stopped; rerun pending
- Live D2 × 1 before the review fixes: d20-try1 102/107, d20-try2 106/107 (one model timeout), 0 invariant violations, thresholds met. Recommendation p50/p95 9.6/13.6 s in try2; the shortlist (c3) brought warm recommendations to about 3–4 s in probes
- Release at ab5d2b5 (T-20): `npm run verify:release` 11/11, D2 276/276; superseded once the D-20 release run completes
Local run: dev server on 127.0.0.1:3005 (`npm run dev -- -p 3005`) while tests rebuild `.next`; switch back to `npm run start -- -p 3005` after the last build. 3000-3002 are used by other projects
Demo data: bookings NE-XSP39FY6 and NE-FS2SXF3Q remain in data/app.db (cancel in admin, or `npm run db:reset && npm run kb:index`)
Not done (would need a decision to resume): Phase 8 independent review of the restyle and D-17 addendum; the rest of Phase 9 (fresh-clone check AC-11, final report)
Notes:
- `.env.local` may still hold the old ADMIN_* values; they are ignored since D-22 (no staff password)
- Latency on this shared machine is noisy; identical repeated prompts hit the prefix cache, so run 1 is reported separately
- New eval-case guest texts need `npx tsx scripts/kb-embed-fixture.ts` (Ollama) for real vectors under the fake embedder
Open questions / blockers:
- `.claude/settings.json` still missing (user will add); §8 wording edit for D-01 pending (user); docs/MODEL_ADAPTER.md ready for review
- Not changed in D-20: "under ₹400" includes ₹400 dishes; recommendation latency mixes one- and three-call turns (report-only, no threshold without approval)
Approved installs: G1 list (Node 26.12.0, qwen3.5:9b, qwen3-embedding:0.6b done); npm packages per SPEC + vite@8.3.4 (installed in T-01); Playwright Chromium (already cached)
Quarantined tests: none
