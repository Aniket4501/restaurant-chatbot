# Status
Phase: 5 — Conversational experience and frontend (fake model)   Gate pending: none (G1, G2, G2-M approved 2026-10-19)   Updated: 2026-10-20
Current task: T-17 Admin UI (next)   Branch: build/reservation-bot   Last commit: see `git log -1`
Last verification (2026-10-20, after T-16):
- `npm run verify` → 9/9 steps passed: lint, typecheck, test:unit (245), test:unit:tz (245 ×2), test:integration (207), eval:scripted (36/36, 0 violations), build, test:e2e (16/16 with invariants; 11 guest-UI specs with axe on every state), invariant report
- A deliberately failing step makes verify exit 1 (tests/integration/verify.test.ts); a throwaway spec booking outside the recorded API failed on INV-06 as intended
Done in Phase 5:
- T-10 knowledge base and retrieval: lib/kb/{facts,canonical,embedder,index,retrieve}.ts, kb:index, embeddings fixture (real vectors), golden top-8 lists (tests/golden/retrieval-top8.json). D-13 amendment (aggregate index text, ≤2 aggregates per turn) approved by the user 2026-10-20
- T-11 model adapter: lib/llm/{schema,client,fake,prompt,redact}.ts, docs/MODEL_ADAPTER.md (for your review). TurnSchema = canonical grammar (sha 1305731e); prompt v3 = probe v2 plus the approved D-10/D-13/D-15 changes only (diffed against evals/fixtures/probe-prompt.v2.json); golden prompt snapshot tests/golden/prompt-v3.txt
- T-12 grounding: lib/chat/{grounding,claims,hours}.ts. 18 D-11 strings both directions; M1 (a)–(e) fail and their correct versions pass; HF4/F04 probe outputs render the exception / closed-for-lunch facts (and would also fail grounding as prose)
- T-13 turn pipeline: lib/chat/{types,draft,router,templates,ratelimit,turn}.ts, lib/api/chat.ts, app/api/chat/route.ts, lib/llm/provider.ts; health reports index coverage. Mutation-checked: removing masking, the pending-confirm rule or the partySize-0 rule each fails tests
- T-14 evals: evals/{case,invariants,run}.ts, evals/thresholds.json, 36 D1 cases in evals/cases/scripted-*.jsonl (every T-14 category ≥ 2), lib/chat/submit.ts (client reaction to a submit, shared with the UI). Mutations of the pending-confirm rule, booking prose and availability each fail D1 cases; INV-04's independent checker flags leaked claims on its own
- T-15 harness: playwright.config.ts (servers 3100 + low-limit 3101, test mode, temp DBs and logs under test-results/e2e, outputDir test-results/playwright), tests/e2e/{env,fixtures,invariants}.ts (reset before, §6.4 invariants after every spec), POST /api/__test/reset (404 outside test mode), scripts/{e2e-prepare,verify}.ts; test:e2e builds first
- T-16 guest UI: app/page.tsx (identity panel + chat, server clock and DB), components/{IdentityPanel,chat/*}.tsx, lib/chat/identity.ts. Design: ash surface, wood-smoke identity panel, neem-green accent, system serif/sans (no font download). Specs: J3 chips-only and typed-only, J4, J6 double tap / lost response + Retry / reload replay, J7 both messages, AC-10 model down, chat error retry, J12 + reload persistence, phone layout
Carried forward:
- T-18: model:check reports index coverage (D-13; /api/health does since T-13); replace the placeholder Ollama chat client in lib/llm/provider.ts
- End of Phase 5: independent review of T-10…T-17 before the Phase 5 exit (as done for T-03…T-07)
- Note for Phase 6/7: under D-15 any FAQ sentence with booking words (book, table, seat…) must be verbatim from a cited fact, so paraphrased policy answers fall back; and the prompt's smalltalk example ("…help with bookings…") always gets the fixed greeting. Measure in D2 before tuning
- New eval-case guest texts need `npx tsx scripts/kb-embed-fixture.ts` (Ollama) so the fake embedder has real vectors for them (done for the 36 D1 cases)
- Case-format additions beyond §6.3 (evals/case.ts): {book} turns (another guest books), setup op `fault` (availability | create_lock), select_slot with a local `start`, expectation keys outcome/noActions/fieldRequest/replyMustMatch/modelCalls/submitStatus/submitCode/sameRefAsTurn
Open questions / blockers:
- `.claude/settings.json` still missing (user will add)
- §8 wording edit for D-01 pending (user)
Approved installs: G1 list (Node 26.12.0, qwen3.5:9b, qwen3-embedding:0.6b done); npm packages per SPEC + vite@8.3.4 (installed in T-01); Playwright Chromium (already cached)
Quarantined tests: none
