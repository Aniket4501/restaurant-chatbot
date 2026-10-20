# Status
Phase: 5 — Conversational experience and frontend (fake model)   Gate pending: none (G1, G2, G2-M approved 2026-10-19)   Updated: 2026-10-20
Current task: T-12 Grounding, claims and hours rendering (next)   Branch: build/reservation-bot   Last commit: see `git log -1`
Last verification (2026-10-20, after T-11):
- `npx vitest run` → 349/349; `npm run test:unit:tz` → 193/193 under TZ=UTC and TZ=America/New_York
- `npm run lint` clean; `npm run typecheck` ok
- Live: `npm run db:seed && npm run kb:index` on data/app.db with Ollama qwen3-embedding:0.6b → 86 facts embedded, rerun 86 unchanged; live hybrid top-8 identical to the golden lists for all 40 labelled queries
Done in Phase 5:
- T-10 knowledge base and retrieval: lib/kb/{facts,canonical,embedder,index,retrieve}.ts, kb:index, embeddings fixture (real vectors), golden top-8 lists (tests/golden/retrieval-top8.json). D-13 amendment (aggregate index text, ≤2 aggregates per turn) approved by the user 2026-10-20
- T-11 model adapter: lib/llm/{schema,client,fake,prompt,redact}.ts, docs/MODEL_ADAPTER.md (for your review). TurnSchema = canonical grammar (sha 1305731e); prompt v3 = probe v2 plus the approved D-10/D-13/D-15 changes only (diffed against evals/fixtures/probe-prompt.v2.json); golden prompt snapshot tests/golden/prompt-v3.txt
Carried forward:
- T-13: /api/health and model:check report index coverage (D-13); runTurn passes masked latest + previous guest turn via retrievalQuery()
- End of Phase 5: independent review of T-10…T-17 before the Phase 5 exit (as done for T-03…T-07)
- New eval-case guest texts need `npx tsx scripts/kb-embed-fixture.ts` (Ollama) so the fake embedder has real vectors for them
Open questions / blockers:
- `.claude/settings.json` still missing (user will add)
- §8 wording edit for D-01 pending (user)
Approved installs: G1 list (Node 26.12.0, qwen3.5:9b, qwen3-embedding:0.6b done); npm packages per SPEC + vite@8.3.4 (installed in T-01); Playwright Chromium (already cached)
Quarantined tests: none
