# Status
Phase: 5 — Conversational experience and frontend (fake model)   Gate pending: none (G1, G2, G2-M approved 2026-10-19)   Updated: 2026-10-20
Current task: T-11 Model adapter, schema, fake, prompt builder, redaction (next)   Branch: build/reservation-bot   Last commit: see `git log -1`
Last verification (2026-10-20, after T-10):
- `npx vitest run` → 320/320; `npm run test:unit:tz` → 164/164 under TZ=UTC and TZ=America/New_York
- `npm run lint` clean; `npm run typecheck` ok
- Live: `npm run db:seed && npm run kb:index` on data/app.db with Ollama qwen3-embedding:0.6b → 86 facts embedded, rerun 86 unchanged; live hybrid top-8 identical to the golden lists for all 40 labelled queries
Done in Phase 5:
- T-10 knowledge base and retrieval: lib/kb/{facts,canonical,embedder,index,retrieve}.ts, kb:index, embeddings fixture (real vectors), golden top-8 lists (tests/golden/retrieval-top8.json). D-13 amendment (aggregate index text, ≤2 aggregates per turn) approved by the user 2026-10-20
Carried forward:
- T-13: /api/health and model:check report index coverage (D-13); runTurn passes masked latest + previous guest turn via retrievalQuery()
- End of Phase 5: independent review of T-10…T-17 before the Phase 5 exit (as done for T-03…T-07)
- New eval-case guest texts need `npx tsx scripts/kb-embed-fixture.ts` (Ollama) so the fake embedder has real vectors for them
Open questions / blockers:
- `.claude/settings.json` still missing (user will add)
- §8 wording edit for D-01 pending (user)
Approved installs: G1 list (Node 26.12.0, qwen3.5:9b, qwen3-embedding:0.6b done); npm packages per SPEC + vite@8.3.4 (installed in T-01); Playwright Chromium (already cached)
Quarantined tests: none
