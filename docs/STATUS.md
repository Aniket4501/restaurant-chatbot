# Status
Phase: 7 — QA and AI evaluation (DONE) + two-hour demo scope (D-19)   Gate pending: none (G1, G2, G2-M approved 2026-10-19; G3 not triggered)   Updated: 2026-10-20
Current task: none. Demo scope (D-19) delivered: restyled chat and admin, README, eval report   Branch: build/reservation-bot   Last commit: see `git log -1`
Last verification (2026-10-20):
- Release at ab5d2b5 (clean tree at start): `npm run verify:release` → 11/11 steps (unit 332, tz ×2, integration 209, D1 48/48, build, E2E 21/21, invariants, model:check, D2 × 3). D2 276/276 case-runs, 0 invariant violations, every §6.5 metric 1.0 except retrieval (hybrid recall 0.950, lexical hit 0.867; floors met). evals/results/2026-10-20T12-16-30-311Z_qwen3.5-9b.json
- After the release (UI restyle, large-party check): see the final commit message for `npm run verify` and the 1-run D2 (`*_final-check.json`)
- Live walkthrough (production build, real models, data/app.db): FAQ answered from facts, unknown → fallback, chip booking NE-XSP39FY6 and typed booking NE-FS2SXF3Q confirmed, both shown in admin. These two demo bookings remain in data/app.db (cancel in admin, or `npm run db:reset && npm run kb:index`)
- Latency: FAQ p95 5.3 s in the last release (machine loaded by concurrent builds and E2E), 3.9 s on a quiet machine (d9fa131); AC-12 target 4 s
Done in Phase 7 (T-20): prompt v4, D-17 extraction checks, D-15 amendments, 16 review findings fixed, docs/EVAL_REPORT.md
D-19 (user, 2026-10-20): two-hour demo scope. Chat, booking and a single-page admin, restyled (off-white, forest green, sage), three quick actions, README. Supersedes D-18's admin extras (staff booking, search, stats, extra pages); nothing removed
Mobile-first redesign (user, 2026-10-20; D-19 amendment): phone frame on larger screens, scrolling hero with live open status, branch cards, previous/next day in the slot picker. npm run verify 9/9 (unit 350, integration 209, D1 50/50, E2E 21/21)
Local run: `npm run start -- -p 3005` (3000-3002 are used by other projects), .env.local created with generated admin values
Not done (out of the D-19 scope, would need a decision to resume): Phase 8 independent review of the restyle and the D-17 large-party addendum; the rest of Phase 9 (fresh-clone check AC-11, final report)
Notes:
- `.env.local` exists (created 2026-10-20 with generated admin values, git-ignored); see the password with `grep ADMIN_PASSWORD .env.local`
- Latency on this shared machine is noisy; identical repeated prompts hit the prefix cache, so run 1 is reported separately
- New eval-case guest texts need `npx tsx scripts/kb-embed-fixture.ts` (Ollama) for real vectors under the fake embedder
Open questions / blockers:
- `.claude/settings.json` still missing (user will add); §8 wording edit for D-01 pending (user); docs/MODEL_ADAPTER.md ready for review
Approved installs: G1 list (Node 26.12.0, qwen3.5:9b, qwen3-embedding:0.6b done); npm packages per SPEC + vite@8.3.4 (installed in T-01); Playwright Chromium (already cached)
Quarantined tests: none
