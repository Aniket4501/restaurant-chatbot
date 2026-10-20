# Decisions

## D-01 Approve model selection separately from the build plan (2026-10-19, status: approved at G1; §8 wording edit pending with the user)
Context: The user wants all model-independent engineering done while `qwen3.5:9b` downloads. As written, §8 puts no application code before G2, and G2 includes `docs/MODEL_SELECTION.md` with measured probe numbers. So the booking engine, APIs, UI and tests would all wait on the download and the probe.
Decision: G2 approves the architecture, decisions and PLAN.md. A separate gate, G2-M, approves `docs/MODEL_SELECTION.md` and must pass before Phase 6. Phases 4–5 proceed after G2 using only the fake model and fake embedder. The Phase 2 probe runs once the approved models are pulled.
Alternatives: (a) keep §8 as written; (b) start code before G1: rejected, because it breaks H8 and the Kickoff rule.
Evidence: Phases 4–5 are specified against the fake model only (§8 Phase 5; §6.1 layers A–D1 use "none" or "fake") \[Verified: MASTER_PROMPT.md\].
Consequences: The prompt builder and schema are written before the real prompt size is measured. Mitigations: the prompt builder is pure and snapshot-tested, and the probe can still force a change before Phase 6. §8 is outside sections 4–6, so the user should edit it. Proposed wording for the G2 line in §8 Phase 3: "**Gate G2:** architecture, decisions, plan, reviewer findings. **Gate G2-M** (before Phase 6): `docs/MODEL_SELECTION.md` with measured numbers."

## D-02 Hybrid retrieval over menu and FAQ facts (2026-10-19, status: approved at G1; design detail at G2)
Context: The user brought "Semantic search / RAG" into scope, reversing the §4.3 non-goal.
Decision:
- Index one entry per `menu:` and `faq:` fact ID, using the rendered fact line.
- Lexical search: an SQLite FTS5 table. Semantic search: vectors from a local Ollama embedding model (`/api/embed`), stored as BLOBs in `fact_embeddings(fact_id, model, content_hash, dim, vector)`, with brute-force cosine in TypeScript. No vector-database server or extension.
- Each model turn retrieves the top 8 menu/FAQ facts by reciprocal-rank fusion, using the masked guest message plus the last guest turn. Branch, hours and exception facts stay in the static prompt prefix.
- `lib/kb/retrieve.ts` exposes `retrieveFacts(query, opts, deps) → { hits: { factId, score, source }[], mode: 'hybrid' | 'lexical' }`. The embedder has exactly two implementations, `ollama` and `fake`, mirroring 5.2.
- Embedding model down or not pulled → `mode: 'lexical'`, recorded in the trace; never a crash.
- The grounding check additionally requires every cited ID to be among the facts sent that turn.
- New eval category 21 `retrieval`: recall@8 of expected fact IDs, floor proposed 95% \[Guessing; set from the Phase 2 probe\]. The probe measures `qwen3-embedding:0.6b` against lexical-only search (the user chose one embedding candidate on 2026-10-19; `embeddinggemma:300m` dropped).
Alternatives: (a) all facts in every prompt, no retrieval (§5.7 default): simplest and best for prefix caching, but the prompt grows with the menu; (b) the `sqlite-vec` extension: an extra native dependency that this data size doesn't need; (c) an external vector DB: extra service, still a non-goal.
Evidence: about 67 menu+FAQ facts planned (SPEC A3), so brute force is trivial \[Inferred\]. FTS5 is compiled into better-sqlite3's bundled SQLite \[Unverified; verify in Phase 2\].
Consequences: One more model (~0.6 GB) and pull. The facts block after the static prefix is dynamic, so less of the prompt is cacheable, but the prompt is shorter \[Inferred; measure in probe\]. Seeding gains a `kb:index` step. New tests and an eval category. Changes the defaults in 4.3, 5.1, 5.3, 5.4, 5.7, 5.8, 6.2 and 6.5. All are in sections 4–6, so this entry is the change mechanism (§0).

## D-03 Node runtime (2026-10-19, status: approved at G1; done: Node 26.12.0, npm 11.20.0)
Context: Vitest 5.0.5 declares `node: ^22.12.0 || ^24.0.0 || >=26.0.0`, so the installed Homebrew Node 25.8.0 is excluded \[Verified: `npm view`\]. eslint 10, better-sqlite3 13 and @axe-core/playwright 4.14 accept 26 \[Verified\].
Decision: `brew upgrade node` → 26.12.0 \[Verified: `brew info`\].
Alternatives: `brew install node@24` → 24.22.0 LTS, keg-only, so it needs a PATH line in the user's shell profile \[Verified\]; or downgrade Vitest (deviates from §5.1).
Evidence: as above. Whether Node 26 has entered LTS yet \[Unverified\].
Consequences: Changes Node for every project on this Mac that uses Homebrew's `node`. Done 2026-10-19 with `HOMEBREW_NO_INSTALL_CLEANUP=1` (old kegs 25.8.0/25.6.1 kept); Homebrew also upgraded 7 libraries and the dependents mongosh 2.7.0→2.13.0 and mongodb-atlas-cli 1.53.0→1.59.3 \[Verified: brew output\]. Node 26's built-in `node:sqlite` (SQLite 3.54.1) has FTS5 \[Verified\], which the dependency-free probe uses.

## D-04 Pin TypeScript 6.0.3, not 7.x (2026-10-19, status: approved at G1)
Context: `typescript@latest` is 7.0.2, but `eslint-config-next` 16.4.2 depends on `typescript-eslint` ^8.56, whose latest (8.71.2) peers `typescript >=4.8.4 <6.1.0` \[Verified: `npm view`\].
Decision: pin `typescript` 6.0.3, the newest version inside that range \[Verified\].
Alternatives: TypeScript 7 with type-aware lint disabled, which loses lint coverage that AC-13 relies on.
Consequences: Revisit when typescript-eslint supports TypeScript 7. Phase 2 strengthened the evidence: TS 7.0.2 ships no compiler JS API, so typescript-eslint would fail to parse at all. `next build` type-checks with the project-local `tsc` CLI and auto-installs `typescript@^6.0.0` when TypeScript is missing \[Verified: research NX-20, NX-40, verifier "missed" note\].

Phase 2 evidence below cites claim IDs (NX-, SQ-, OL-, ZD-/DT-/PH-) from `docs/research/2026-10-19-phase2-verification.json`. Four read-only researchers produced 167 claims; an adversarial verifier per area re-checked all 67 critical ones (66 confirmed, 1 refuted and corrected).

## D-05 Ollama request settings for qwen3.5 on the MLX runner (2026-10-19, status: approved at G2, 2026-10-19)
Context: Both qwen3.5 models run on Ollama's MLX runner, not llama.cpp (OL-09). Several §5.8 assumptions behave differently there.
Decision:
- Always send `think: false`. Omitting it turns thinking on (the default), which gives empty content and `done_reason: "length"` (OL-15, OL-16, verifier note).
- Send `truncate: false`, keep `num_ctx: 8192` and keep `CONTEXT_TOO_LARGE` as an app-level prompt budget. On MLX, num_ctx is a soft load-time value and prompts are never truncated (OL-10, OL-11).
- Treat `done_reason === "length"`, empty content or non-empty `message.thinking` as `MODEL_INVALID_OUTPUT` (retry once, then degrade). Treat an `answer` of exactly 600 characters as truncated and use the fallback (ZD-07, corrected).
- Keep the Modelfile sampling parameters. Send only §5.8's options (`temperature: 0, seed: 42, num_ctx: 8192, num_predict: 400`); temperature 0 makes decoding greedy. A/B result: the `presence_penalty: 0, repeat_last_n: 0` override (OL-19, OL-20) never helped. Booking extraction with the override vs without: 9b 18/30 vs 18/30 (v1), 15/18 vs 16/18 (v2 retrieval), 16/18 vs 17/18 (v2 all-facts); 4b 15/30 vs 21/30 (v1). Files: `evals/results/2026-10-19T14-36-59-733Z_probe.json`, `…14-49-11-215Z_probe.json`.
- Keep `seed: 42`, but credit repeatability to greedy decoding at temperature 0 (OL-21).
- `model:warm` plants a prefix-cache snapshot at the static-prompt boundary: two requests that diverge at the first token of the user turn. The cache resumes only at snapshot offsets (OL-22, OL-23). It also warms the embedder.
- Every `/api/embed` call sends `keep_alive` and `truncate: false` (OL-31; the server default keep_alive is 5m).
- `model:check` reads the digest from `/api/tags`; reads capabilities and `thinking.values` from `/api/show`; reports `/api/ps` `runner` and `context_length`; and runs a schema round-trip that fails on HTTP 400 "invalid structured output grammar" (OL-13, OL-17, OL-18).
- Map `MODEL_NOT_PULLED` on HTTP 404, not on message text (OL-34).
- Evals and the probe run serially, with exclusive access (one runner slot; OLLAMA_NUM_PARALLEL 1).
- Replace the "100% GPU" selection criterion with a system-memory floor. On unified memory `size_vram == size` always, and MLX snapshot memory grows with distinct prompts (OL-24, OL-25, OL-30).
Alternatives: keep §5.8 as written. That leaves the thinking-related failures unhandled. A penalty override was tested and rejected (above).
Evidence: live calls on 2026-10-19 plus Ollama 0.40.5 source (claims above) \[Verified\]. Probe A/B as above \[Verified: measured\].
Consequences: Changes 5.8 client details and the §8 Phase 2 selection rule (GPU → memory). Also changes the plan's caching rationale: put no dynamic text before the static boundary.

## D-06 partySize bounds in TurnSchema (2026-10-19, status: approved at G2, 2026-10-19)
Context: Grammar-constrained decoding enforces schema bounds. "Table for 150" comes back as 15 and "0 people" as 1, both still Zod-valid. On 4b with a compact prompt the bounded integer can stall into `done_reason: "length"` (ZD-07 corrected, ZD-08). Out-of-range values can also come back as free-string ambiguity candidates.
Decision (proposed): `partySize: z.number().int().min(0).max(999).nullable()`. Code still decides: 0 → ask again, 1–8 → book, 9+ → branch phone. Ambiguity candidates for `partySize` must pass the same validation. The fixture is regenerated by script (`evals/fixtures/experiments/turn.schema.partySize-0-999.json`, sha256 1305731e…, differs from the base only at minimum/maximum).
Alternatives: keep 1–99 (current fixture, sha256 c42ef47f…).
Evidence (probe v1, 3 runs each, `edge/*` conditions):
- qwen3.5:9b, "Table for 150 people on Saturday": 150 in 3/3 with 0–999; with 1–99 it came back as 15 in 3/3, twice with invented ambiguity candidates 15–18.
- "a table for 25 tomorrow evening": 25 on both schemas.
- "we are 0 people": null on both.
- qwen3.5:4b returned null for 150 on both schemas.
- No `done_reason: length` stalls in any of the 36 edge calls \[Verified: measured\].
With 1–99, a 150-guest request becomes a 15-guest one, which code then routes to "call the branch" for the wrong reason.
Consequences: Changes §5.7. Eval cases for 150 and 0 guests are added in Phase 6. Applied at G2: `evals/fixtures/turn.schema.json` is now the 0–999 grammar (sha256 1305731e…). The previous 1–99 fixture used by probe runs before 15:17 is kept as `evals/fixtures/experiments/turn.schema.partySize-1-99.json` (sha256 c42ef47f…).

## D-07 Scaffold and toolchain details (2026-10-19, status: approved at G2, 2026-10-19)
Context: Phase 2 checked §5.1 against create-next-app 16.4.2 and current packages.
Decision:
- **Scaffold in a temp dir and copy.** `create-next-app` cannot scaffold into this repo: the folder name "Restraunt Chatbot" fails npm-name rules, and `CLAUDE.md`, `evals/` and `scripts/` are not on its empty-folder allowlist (NX-02, NX-03). It also silently overwrites `.gitignore` (NX-04). Run `npx --yes create-next-app@16.4.2 <tmp>/restaurant-chatbot --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --no-react-compiler --no-cache-components --no-agents-md --no-agent-feedback --use-npm --skip-install --disable-git --yes`. Then copy the config and app files and merge `.gitignore`, keeping `!.env.example`. Name the package `restaurant-chatbot`.
- **Cache Components, AGENTS.md and agent upgrades stay off.** The scaffold enables Cache Components and AGENTS.md by default, and `next dev` rewrites AGENTS.md when it detects Claude Code (NX-06, NX-29, NX-30). `next.config.ts` sets `agentRules: false` and `experimental: { agentUpgrade: false }`.
- **Tailwind via `@tailwindcss/postcss` 4.3.3 with `postcss.config.mjs`**, as §5.1 says and as both the Next and Tailwind docs describe. This replaces the scaffold's new `@tailwindcss/turbopack` default (NX-10).
- **ESLint 10.13.0** with eslint-config-next 16.4.2. ESLint 9 has been EOL since 2026-08-06, and the Next docs say eslint-config-next supports 10 but some plugins show peer warnings (NX-44 to NX-47). Never enable strict-peer-deps. Fallback: 9.39.5.
- **Exact pins.** `npm install --save-exact` plus a project `.npmrc` with `save-exact=true`; commit `package-lock.json`. Pins: next 16.4.2, react/react-dom 19.3.1, typescript 6.0.3, @types/node **26.6.5** (the scaffold's ^20 conflicts with Vitest 5's peer range, NX-51), @types/react/-dom 19.3.0, plus the rest of the SPEC install list.
- **New package needing H9 approval:** `vite` 8.3.4 as an explicit devDependency. Vitest 5 made it a required peer (NX-50).
- **tsconfig** adds `"types": ["node"]` (TS 6 defaults `types` to `[]`, NX-42). Add `typecheck: "next typegen && tsc --noEmit"`.
- **Local-only binding.** `next dev -H 127.0.0.1` / `next start -H 127.0.0.1` (the default binds 0.0.0.0, NX-26). Playwright `webServer` uses the built app on `127.0.0.1:3100` with `reuseExistingServer: false`, so E2E can never attach to a dev server running the real model (NX-61).
- **Request-time reads.** Every Server Component or GET handler that reads SQLite or the clock calls `await connection()` first, and the DB opens lazily, never at module import (NX-27, Verified by the verifier from the Next docs).
- **Vitest.** Projects `unit` and `integration` run with `vitest run --project …`. Keep the default `forks` pool so `TZ=` takes effect. Integration uses `fileParallelism: false` and a 120 s timeout. Concurrency children use `fork(child, [], { execArgv: ['--import', 'tsx'] })` (NX-52, NX-53, NX-58).
Alternatives: hand-write the roughly 8 config files from the verified template contents, which avoids running the scaffolder at all.
Consequences: Updates the §5.1 tooling row and adds `vite` to the install list. `package.json` gains `"engines": { "node": ">=26.0.0" }`. Verified in T-01 (2026-10-19): `npm install` reported 3 `ERESOLVE overriding peer dependency` warnings (the ESLint 10 plugin peers), and `npm run lint` works. npm 11.20's allowScripts policy skipped the `esbuild` and `unrs-resolver` postinstall scripts; both work without them (tsx/esbuild transform and resolver load tested), so no scripts were approved. The Playwright 1.64.1 browsers (chromium/headless-shell 1248, ffmpeg 1013) were already in the shared cache.

## D-08 SQLite schema and write-path hardening (2026-10-19, status: approved at G2, 2026-10-19)
Context: The §5.4 DDL was run on SQLite 3.51.0 and 3.54.1, and the 20-process race was reproduced (SQ-20 to SQ-27, SQ-60 to SQ-62). The design holds, with these fixes.
Decision:
- **Pragmas.** All PRAGMAs live in `openDb()`, never in migrations: `new Database(path, { timeout: 5000 })`; `db.pragma('journal_mode = WAL', { simple: true }) === 'wal'` asserted; `foreign_keys = ON`; `synchronous = FULL`. The WAL default would otherwise silently become NORMAL after the first reopen (SQ-35, SQ-54, verifier note). Migrations are DDL only, each in `db.transaction(…).immediate()`.
- **Update triggers.** BEFORE UPDATE triggers exclude `r.id <> OLD.id`, not NEW.id (SQ-28; tested artifact).
- **Stricter checks.** `GLOB '[0-2][0-9]:[0-5][0-9]'` time CHECKs, `date(date) IS date` date CHECKs and `is_closed IN (0,1)` (tested artifact).
- **Branch consistency.** `UNIQUE (branch_id, id)` on dining_tables, and `FOREIGN KEY (branch_id, table_id)` on reservations, so a table from the other branch is rejected (SQ-33).
- **Error mapping.** On any `SQLITE_CONSTRAINT*`, after rollback, first repeat the idempotency-key lookup (same hash → 200 with the row; different → `IDEMPOTENCY_MISMATCH`). Only then map `TABLE_OVERLAP` → `SLOT_TAKEN` and `GUEST_OVERLAP` → `DUPLICATE_BOOKING`. BEFORE INSERT triggers fire before UNIQUE checks, so a same-key replay surfaces as GUEST_OVERLAP (SQ-24). Tests never assert which trigger wins when both conditions hold.
- **Transaction safety.** `createReservation` asserts `!db.inTransaction`; nested `.immediate()` silently becomes a SAVEPOINT (SQ-04). A typed transaction helper rejects Promise-returning callbacks (SQ-05; `@types/better-sqlite3` accepts them).
- **Exception loader rule (added in Phase 2).** A date with per-service exception rows must list both services; otherwise the unlisted service would be closed silently under the "an exception replaces all weekly rows" semantics.
- **Search table.** FTS5: `kb_fts USING fts5(fact_id UNINDEXED, body, tokenize = 'porter unicode61 remove_diacritics 2')`, queried only through the tested sanitiser (NFKC, `/[\p{L}\p{N}]+/gu` tokens, quoted, OR-joined, at most 16) and ordered by `bm25(kb_fts), fact_id`. The SQ-41 raw strings become must-not-throw unit tests. FTS5 is compiled into better-sqlite3 13.0.3 (SQ-10), which resolves D-02's Unverified item.
- **Race test assertions.** The race test additionally asserts no `SQLITE_BUSY`/`UNAVAILABLE`, and that every loser saw 1 row. A second race variant skips the app checks and expects 19 `TABLE_OVERLAP` (SQ-61).
Alternatives: AFTER INSERT overlap triggers, so that UNIQUE fires first (verifier note). Not needed given the re-lookup rule.
Evidence: tested artifacts in the research file \[Verified on system SQLite\]. T-01: better-sqlite3 13.0.3 loads its N-API prebuild on Node 26.12.0, with bundled SQLite 3.53.4 and FTS5 working \[Verified\]. T-03: on that bundled SQLite, `tests/integration/schema.test.ts` (33 tests) pins the exact `err.code`/`err.message` the error mapping relies on: `SQLITE_CONSTRAINT_TRIGGER` with messages `TABLE_OVERLAP`/`GUEST_OVERLAP`; `SQLITE_CONSTRAINT_UNIQUE` with `UNIQUE constraint failed: reservations.idempotency_key` and `…reservations.ref`; `SQLITE_CONSTRAINT_FOREIGNKEY`, `_NOTNULL`, `_DATATYPE` and `_CHECK`. This turns SQ-08 from Inferred into Verified. better-sqlite3 13.0.3 itself was not loaded (installs are forbidden in Phase 2), so the Phase 4 error-mapping tests and race in Node are the gate. Fallback: 12.11.1, not "12.12.0", which doesn't exist (verifier).
Consequences: Changes 5.4 DDL details and 5.6 error mapping.

## D-09 Time-zone and phone library usage (2026-10-19, status: approved at G2, 2026-10-19)
Decision:
- **Branch-local times.** Construct them only from numeric parts: `new TZDate(y, m-1, d, hh, mm, zone)`, or `parse(…, { in: tz(zone) })`. Never construct a TZDate from a string; offset-less strings are read in the process zone (DT-02). Validate dates before constructing, because invalid parts roll over (DT-03). Every date-fns call passes `{ in: tz(zone) }` (verifier). Weekday = `getDay` in the branch zone (DT-04). Do not compare resolved zone names: Node 26 reports Asia/Kolkata as "Asia/Calcutta".
- **Phones.** A single server-only module imports the default export of `libphonenumber-js/max`. Mobile check: `country === 'IN' && isValid() && ['MOBILE','FIXED_LINE_OR_MOBILE'].includes(getType())`; store `.number` (PH-01 to PH-03). The same module does phone finding for grounding and masking, because `/mobile` misses landlines (PH-04).
Consequences: Fixes the import path and API shape for 5.1/5.7; the TZ test runs enforce them.

## D-10 Opening-hours answers are rendered from facts; exceptions supersede weekly hours (2026-10-19, status: approved at G2, 2026-10-19)
Context: In probe v2, qwen3.5:9b and 4b both answered "Is Hauz Khas open for dinner on Thursday 22 October?" with "open 7:00 PM–11:00 PM". The 22 Oct exception says dinner is closed. Both cited the exception and the weekly Thursday fact. The §5.7 grounding check passed, because the times do appear in the weekly fact. Separately, F04 ("open for lunch on Monday at Golf Course Road?") got a false "yes, 12:00 PM–3:30 PM" from both models in every run. The grounding check caught that only because the times weren't in the cited fact; a times-free "yes" would have been shown. 4b also produced availability claims framed as hours answers (H03, D-11).
Decision:
- **Hours answers come from facts.** When a `faq` answer cites only `branch:`/`hours:`/`exception:` facts, the guest sees text rendered from those facts (the info card's wording), not model prose.
- **Exceptions win.** Before rendering or grounding, any `hours:<slug>:<weekday>` cited alongside an `exception:<slug>:<date>` for that weekday is dropped.
- **Weekly facts name their exceptions.** Weekly hours facts list the in-horizon exception dates for that weekday ("except Thu 22 Oct 2026: see exception:hauz-khas:2026-10-22"), so the model sees the exception when it reads the weekly fact.
- Answers that mix hours with menu or FAQ facts keep model prose and the full grounding check, with exception facts superseding weekly facts as above.
Alternatives: (a) prompt changes only. Rejected: both models repeated the error identically across runs. (b) Answer every hours question from the availability engine. More code, and the facts already carry the data.
Evidence: probe v2 calls HF4 and F04 (`evals/results/2026-10-19T14-49-11-215Z_probe.json`) \[Verified: measured\].
Consequences: Changes 5.7 routing for hours-only FAQ answers and the grounding rules. Adds the HF4/F04 patterns to the eval `hours` category (§6.2 #3) and unit tests for the supersede rule.

## D-11 Booking-claim filter also blocks availability claims, sentence by sentence (2026-10-19, status: approved at G2, 2026-10-19)
Context: §5.7's claim filter lists confirmation phrases ("I've booked", "booking confirmed"). In probe v2, qwen3.5:4b answered booking-like questions it had misread as FAQs with "Yes, we have tables available for two tonight at 9 PM" and "Yes, tables are available for 2 guests on Monday night". The draft filter flagged neither. One of them used only times present in the cited fact, so the grounding check would have let it through, breaking H6/INV-04.
Decision: `lib/chat/claims.ts` splits shown model text into sentences. It ignores hedged sentences (when, if, whether, unless, until, cannot, can't, not, no, unable, never). It rejects any remaining sentence that matches a confirmation pattern, or an availability pattern: "we have/can offer/can seat … table(s)/seats/slots", "table(s)/seats … is/are available/free/open", "there is a table/space available", "we can seat you". The 18 strings used to tune it become unit tests in both directions: 8 must be flagged (including the two 4b outputs), and 10 must pass ("available at all branches", "free valet parking", "when a table is free", "We hold your table for 15 minutes", …).
Evidence: rescoring all 219 stored probe answers flags exactly the 6 real 4b availability claims and nothing else; 0 of 99 qwen3.5:9b answers flagged \[Verified: `node scripts/claims-rescore.mjs evals/results/2026-10-19T14-36-59-733Z_probe.json evals/results/2026-10-19T14-49-11-215Z_probe.json`\].
Known limit: a claim inside a hedged sentence ("we have tables if you come at 9") is not caught. Defense in depth covers it: booking intents never show model prose, D-10 removes prose from hours answers, prompt rule 5, and the eval `false_claim` category. Stated in the README.
Consequences: Widens §5.7's filter definition; unit tests in Phase 5.

The next five entries resolve the Phase 2 independent review (`docs/REVIEW.md`, "Phase 2"). Finding IDs are prefixed by lens: T = traceability/testability, R = reservation integrity, M = model boundary/grounding, S = security/privacy.

## D-12 Deterministic test hooks for the embedder, faults, clock, DB and traces (2026-10-19, status: approved at G2, 2026-10-19)
Context: The review found that Layer C/D1 results would depend on the machine (T1), and that AC-10/AC-16 faults could not be injected (T1, T11). It also found that the clock override missed Server Components (T8), E2E specs shared one DB and fixed limits (T9), `runTurn` rate-limited evals (T10), invariants had no data to check after E2E (T7, T12), and the test guard did not protect `data/app.db` (S4).
Decision:
- **Fake providers in test mode.** `EMBED_PROVIDER = ollama | fake`, alongside `LLM_PROVIDER`. `E2E_TEST_MODE=1` refuses to start unless both are `fake`, and `DATABASE_PATH` is set, resolves to something other than `data/app.db`, and sits under `os.tmpdir()` or `test-results/`. If `DATABASE_PATH` is `data/app.db`, every test hook is ignored.
- **The fake embedder** returns vectors precomputed from the real embedder and stored in `evals/fixtures/embeddings.json`, plus a hash-based vector for unseen text, so hybrid ranking is reproducible offline.
- **Fault directives.** `#fake:embed_down` and `#fake:embed_timeout` for the embedder. The fake model returns a raw envelope `{status, content, done_reason, thinking, prompt_eval_count}`, with directives and tokens `#fake:down`/`<<DOWN>>`, `#fake:not_pulled`, `#fake:length`, `#fake:thinking`, `#fake:empty` and `#fake:context`. The eval case format gains `"embedder": "down" | "timeout"` and the expectation key `retrievalMode`. `lib/llm/ollama.ts` error mapping gets Layer A tests with a stubbed `fetch` (ECONNREFUSED, HTTP 404, HTTP 400 "invalid structured output grammar").
- **One clock.** A server-only `getNow()` honours `NOW_OVERRIDE` and is used by route handlers, Server Components and the admin default date. The browser takes "today" from the server. A unit test fails if `Date.now()` or `new Date()` appears outside `lib/time`.
- **Injected dependencies.** `runTurn(input, deps)` takes `deps = { db, model, embedder, rateLimiter, clock }`. The route handler supplies the IP-keyed limiter, and the eval runner passes a no-op limiter. `createReservation(db, input, key, now)` takes its DB handle explicitly.
- **E2E isolation.** Playwright runs with `workers: 1`. A test-only `POST /api/__test/reset` (404 unless `E2E_TEST_MODE=1`) reloads `evals/fixtures/base.json` into a fresh temp DB before each spec. A second webServer on port 3101, with low limits, serves the 429 and login-throttle specs.
- **Trace file.** With `E2E_TEST_MODE=1`, each turn appends `{sessionId, now, blocks, citedFactIds, trace, maskedPrompt}` to `TEST_TRACE_PATH`, and webServer stdout/stderr are piped to a file that INV-07 scans. INV-01 is checked against the row's state when the confirmation was rendered: a later admin cancel is allowed if `cancelled_at` comes after the render. For E2E, INV-04 is defined as "claim text appears only in a confirmation block whose ref matches a 201/200 response captured in the same test".
Consequences: Extends the §5.8 test hooks and §6.3 case format; adds a fixtures file and a test-only route.

## D-13 Retrieval and fact completeness (2026-10-19, status: approved at G2, 2026-10-19)
Context: Menu fact lines as specified dropped branch scope and availability (T4, M6). Top-8 retrieval cannot answer "cheapest" or "all vegan" questions correctly (M5). Lexical fallback without stopword removal crowds out menu items (M10). Follow-ups lost their referent after one turn (M12). Missing or stale embeddings were invisible (T13, M11). The restaurant name and cuisine had no table (T5). The AC-15 floor was unset and its Layer A check could not reach it (T2).
Decision:
- **Fact text.** Fact lines are rendered byte-compatibly with the probe: menu lines end with "<Branch> only." and "Currently unavailable." where they apply, and FAQ lines carry "(<Branch>)". A single-row `restaurant` table feeds a `restaurant:` fact in the static prefix, the prompt role line and the identity panel.
- **Aggregate facts.** `menu-cat:<category>` lists every available item with its price, sorted by price; `menu-diet:<tag>` lists every item with that diet tag. Both are indexed like other facts, so list and superlative questions retrieve one complete, citable fact.
- **Lexical query.** The FTS5 query removes a fixed English stopword list before the 16-token cap, falling back to unfiltered tokens if nothing remains. This is what the probe did.
- **Follow-up context.** The server returns `context.lastCitedIds` with the draft. On the next turn those IDs, validated against the snapshot, are added to the retrieved set before the top-8 fill.
- **Index coverage.** `retrieveFacts` reports `hybrid` only if every current menu/FAQ fact has an embedding row for the configured model digest with a matching `content_hash`; otherwise `lexical`, with a reason. `kb:index` deletes rows for removed facts and exits non-zero if any embed fails. `/api/health` and `model:check` report index coverage. Embeddings are keyed by model digest.
- **SPEC amendment for AC-15** (needs approval):
  - D2 floors from the measured probe: hybrid hit@8 = 100% (30/30) and recall@8 ≥ 0.90 (measured 0.947).
  - Layer A becomes a deterministic regression test: the golden top-8 lists for the 30 labelled queries under the fake embedder must match exactly, not a rate.
  - The lexical-only mode has a measured floor: hit@8 ≥ 0.85 (measured 0.867 on v1 fact lines).
Evidence: probe retrieval metrics; reviewer experiments (lexical 0/14 vegan items for "which of your dishes are vegan" without stopword removal) \[Verified by reviewer and skeptic\].
Consequences: New fact ID prefixes `restaurant:`, `menu-cat:` and `menu-diet:`. Schema adds `restaurant` and `fact_embeddings.model_digest` (appendix). Changes the retrieval evals.

**T-10 implementation note and amendment (2026-10-20, status: amendment approved by the user, 2026-10-20).**
Measured with real `qwen3-embedding:0.6b` vectors (`evals/fixtures/embeddings.json`, digest ac6da0dfba84) over the 86 retrievable facts of `base.json`: the 30 probe queries (R01–R30) plus 10 new list questions that only an aggregate answers completely (`evals/fixtures/retrieval-aggregates.json`, A01–A10). Script: `tests/unit/kb-retrieve.test.ts`; live re-check on the dev DB with the Ollama embedder gave identical top-8 lists for all 40 queries.

| Variant | R01–R30 hybrid hit@8 / recall@8 | R01–R30 lexical hit@8 / recall@8 | A01–A10 hybrid hit@8 | A01–A10 lexical hit@8 |
| --- | --- | --- | --- | --- |
| As approved: aggregates indexed by their full text | 1.000 / 0.947 | 0.867 / 0.828 | 0.5 | 0.1 |
| Proposed: short index text, at most 2 aggregates per turn | 1.000 / 0.950 | 0.867 / 0.828 | 1.0 | 1.0 |
| Short index text, cap 1 | 1.000 / 0.958 | 0.867 / 0.828 | 0.9 | 0.9 |
| Short index text, cap 3 | 1.000 / 0.942 | 0.867 / 0.828 | 1.0 | 1.0 |
| Short index text, no cap | 0.967 / 0.933 (R18 lost) | 0.867 / 0.828 | 1.0 | 1.0 |

- **Change to "Both are indexed like other facts" (approved):** aggregates are indexed (FTS5 and embeddings) by a one-sentence description, e.g. "Vegan: every vegan (plant-based) option, with prices, cheapest to most expensive.", while the prompt and grounding use the full list. A 35-item list ranks poorly on bm25 (length normalisation) and its vector is diluted, so as approved the aggregates were found for only 5 of 10 list questions (1 of 10 lexically), which misses this decision's purpose (M5, M10).
- **Addition (approved):** at most 2 aggregates per turn (`LIMITS.retrievalAggregateMax`). Without a cap, "seafood dishes" (R18) retrieved only aggregates and failed the hybrid hit@8 = 100% floor. The cap also bounds prompt size (aggregates are up to ~1,500 characters).
- **Within the approved decision (no approval needed):** carried `lastCitedIds` are capped at 4 (`LIMITS.retrievalCarryMax`), so every turn still retrieves at least 4 new facts; `applySeed` rebuilds `kb_fts` in its own transaction, so the lexical index always matches the seed; RRF ties keep lexical-then-semantic first-seen order, as the probe did; the restaurant fact is `restaurant:about`; the D-10 exception note on weekly hours facts is rendered by `lib/kb/facts.ts`. Aggregate headings avoid the word "dishes" ("Vegan (14 available)…"): with "Vegan dishes" labels, probe hybrid recall@8 fell to 0.931.

## D-14 Booking API contract and write-path details (2026-10-19, status: approved at G2, 2026-10-19)
Context: Six reservation-integrity findings and two security findings: R1–R6, T6, S1/S5.
Decision:
- **Schema.** `reservations` is `STRICT`, with `id TEXT NOT NULL PRIMARY KEY`, a phone CHECK `+91` followed by 10 digits, name length 2–80 and note length ≤ 300 (R1). Tested: a TEXT timestamp, a NULL id and a spaced phone are all rejected (`docs/research/2026-10-19-schema-check/`).
- **Typed error bodies (T6, R4).**
  - `DUPLICATE_BOOKING`: `{ existing: { startsAt, label, branch, ref? } }`; the J7 text is built from `existing.startsAt`, never from the request.
  - `SLOT_TAKEN` and the new `SLOT_UNAVAILABLE`: `{ reason, alternatives[] }`, where `reason` is one of `lead_time | closed | past_horizon | off_grid | party_size | branch_inactive`.
  Every step-2 re-validation failure returns 409 `SLOT_UNAVAILABLE` with fresh alternatives; party 9+ gets the branch-phone template.
- **Booking references (R6).** Format `NE-` plus 8 Crockford base32 characters (40 bits), enforced by a CHECK. Generated inside the transaction, with an existence check and up to 5 retries; a `reservations.ref` UNIQUE failure triggers regenerate-and-retry.
- **Pending submit on the client (R2).** While a submit's outcome is unknown (network error or 500), the ConfirmCard fields and the slot and chip actions are locked. The guest can only "Retry" (same key) or "Start over", which first replays the key to learn the outcome. The pending entry is cleared on 503 (nothing was committed) and whenever branch, date, time or party changes. On reload it is replayed only if the restored card body matches.
- **Reseed (R3).** Reseed is an upsert keyed on natural keys, in one IMMEDIATE transaction. Tables referenced by a reservation are never deleted (set `is_active=0`). Relative seed dates resolve against `app_meta.seed_anchor_date`, written on first seed and reused afterwards. Reseed lists any confirmed future bookings that conflict with the new hours and aborts unless `--accept-conflicts` is passed. `db:reset` (dev DB only) rebuilds from scratch.
- **SPEC amendment for J7 (S1, R5; needs approval).** The existing booking's time and ref are returned only when the submitted name, trimmed and case-folded, matches the existing row. Otherwise the reply is generic: "This mobile already has a booking around this time. Please call {branch} on {phone}." Rationale: anyone who knows a mobile number could otherwise read that person's booking time and ref without authentication.
- **Rate limits (S5).** `POST /api/reservations` allows 5 creates per minute per phone, plus a global cap (429 `RATE_LIMITED`). Per-IP keys come from the socket address only, never `X-Forwarded-For`; on a 127.0.0.1-only server that bucket is global, which is documented. `sessionId` must be a UUID, and limiter state lives in a bounded LRU. At most 1 model call runs at a time, with a small queue; beyond it, 429.
Consequences: Extends §5.6/§5.9 contracts and the client submit logic; schema changes in the appendix.

## D-15 Prompt and grounding hardening (2026-10-19, status: approved at G2, 2026-10-19)
Context: The grounding check ignored bare numbers, dates and durations (M1). Smalltalk after a confirm card could imply a booking (M2, high). History and body size were uncapped and the budget was checked only after the model call (M8, S6). The `<guest_message>` fence could be escaped and history sat outside it (M9, S7). `answerable=false` was not routed (M14). Masking missed typo'd numbers and the previous turn (M15, S10). No rule chose a branch phone when no branch was known (T14, M16). partySize 0 could overwrite a draft (M13).
Decision:
- **Grounding** (`lib/chat/grounding.ts`): after canonicalising times, prices and phones, every other digit run in the answer must appear in the cited facts' normalised text. Dates ("27 Oct", "Tue 27 Oct", "27th", ISO) are canonicalised and must appear in cited facts or IDs. The time and number words noon, midnight, o'clock, half past, quarter past/to and two…twenty, thirty…ninety, hundred are rejected unless the cited facts contain them. INV-05 uses an independent, stricter checker in `evals/invariants.ts`.
- **Booking-state wording (extends D-11).** While the draft has a selected slot or a confirm block and no successful create, any smalltalk or FAQ prose is replaced with "Your table isn't booked yet. Tap Confirm to finish." At other times, smalltalk containing booking-state words (book*, reserv*, confirm*, table, seat, "all set", "see you", hold/held, "expect you") shows the fixed greeting. An FAQ sentence with booking-state words is rejected unless it appears verbatim in a cited fact, which keeps "We hold your table for 15 minutes…" working.
- **Input caps.** The `/api/chat` Zod body allows ≤ 8 messages, roles `guest | assistant`, guest content ≤ 500 characters and assistant content ≤ 600. Bodies over 16 KB get 413 before parsing. Draft fields are validated strictly (slug, ISO date, HH:MM, enum, integer). A character-based prompt budget is checked before the model call (`CONTEXT_TOO_LARGE` pre-call, `prompt_eval_count` as backstop). On an over-budget turn, retry once with history trimmed to 2 messages, then degrade with chips.
- **Prompt fence.** `<` and `>` are neutralised in every guest- or client-originated string. History is rendered as one JSON-encoded `<history>` data block, and prompt rule 6 is extended to cover it; client-supplied assistant text is data, never instructions. New D2 injection cases cover tag break-out, forged assistant history and a forged draft.
- **Routing.** `intent=faq` with `answerable=false` always shows the fixed fallback.
- **Masking.** Every server-received string is masked once at the start of `runTurn`, whatever its role. A fallback masks any run of ≥ 8 digits with separators, excluding ISO dates and HH:MM. Retrieval, prompt and trace see only masked text. ARCHITECTURE no longer claims the embedder never sees names; typed names can reach the local embedder.
- **Branch phones.** When exactly one branch is not known, the fallback, manage-booking and 9+ templates list both branches' names and phones.
- **partySize 0** (D-06) merges like null and never overwrites a draft value, and it is dropped from ambiguity candidates.
Consequences: Widens §5.7. Adds unit, D1 and D2 cases for every item above.
- **Amendment (2026-10-20, approved by the user, T-20):** the phrase "booking note" no longer counts as a booking-state word. It names a form field, not a booking state. In D2, correct answers about cakes (LV-FAQ-006) and outdoor seating (LV-REG-008) were replaced by the fallback only because the model wrote "Please mention it in your booking note" instead of copying the fact word for word. Every other state word keeps the word-for-word rule. The D-11 claim filter and the independent INV-04 checker are unchanged.
- **Amendment (2026-10-20, approved by the user, T-20):** venue seating phrases ("indoor", "outdoor", "terrace", "covered" or "rooftop" seating) are not booking-state words either. After the booking-note change, LV-REG-008 still showed the fallback because "a covered terrace for outdoor seating" contains "seating". Safeguard: a sentence that uses an exempted phrase and also speaks of availability ("available", "availability", "free", "for you") still counts as booking state, so "We have outdoor seating available for you tonight" must be word for word; D-11 alone would not catch it.

## D-16 Network, admin and telemetry hardening (2026-10-19, status: approved at G2, 2026-10-19)
Context: Security review findings S2, S3, S8, S9, S11 and S12.
Decision:
- **Local model only.** `OLLAMA_BASE_URL` must be http with host 127.0.0.1, localhost or ::1 (Zod refine). Model names ending in `cloud` are rejected. `model:check` fails if `/api/show` or `/api/tags` marks the model remote. The README starts Ollama with cloud features off; the exact switch is to be verified in Phase 6 \[Unverified: `OLLAMA_NO_CLOUD`\].
- **Admin secrets.** `ADMIN_SESSION_SECRET` (≥ 32 random bytes) is the HMAC key, separate from `ADMIN_PASSWORD` (≥ 12 characters). Both are validated at startup: present, not the `.env.example` placeholder, and secret ≠ password. If either fails, `/admin` and `/api/admin/*` return 503 and the log names the variable, never its value.
- **Admin cookie.** The cookie payload `{v, iat, exp = iat + 8h, epoch}` is HMAC-SHA256 signed and checked with `crypto.timingSafeEqual` plus `exp > now`. Sign-out bumps an in-memory epoch. The password is compared as `timingSafeEqual(sha256(input), sha256(expected))`.
- **Request checks in `proxy.ts`** (`/api/:path*`, `/admin/:path*`): the Host must be `127.0.0.1:<port>` or `localhost:<port>` (else 403); non-GET requests need `Origin` equal to the app's own origin; JSON endpoints require `Content-Type: application/json`.
- **`requireAdmin()`** runs at the top of every admin route handler and the admin page/layout. Admin data loads client-side through the admin API; there are no Server Actions for admin mutations.
- **Telemetry.** `NEXT_TELEMETRY_DISABLED=1` in every npm script that runs `next`. Next.js telemetry would otherwise make an unapproved external call (§7.4).
Consequences: Extends §5.9 and the security section.

## D-17 Deterministic checks on extracted booking fields (2026-10-20, status: approved by the user, 2026-10-20)
Context: The T-20 baseline and review found three ways the model's extraction reaches the draft unchecked:
- a clock time the guest never gave ("make it lunch instead" came back as 12:00, then a confirm card);
- a weekday read as the wrong date: "Monday night" as Tue 20 Oct (LV-CLAIM-001, a regression from prompt v4), "this Saturday" (tomorrow) as the Saturday after;
- an ambiguity whose readings are mostly or all unusable, which kept the old value or gave no reason.

The first version of the time check (d9fa131) accepted any digit or number word, so a party size let an invented time through (review, high).
Decision (`lib/chat/guards.ts`, applied in `runTurn` before the merge):
- **Time.** A model time, or a time ambiguity candidate, is kept only if the guest's latest masked message states that hour as a clock time. Clock times are "8pm", "8:30", "at 7", "around 9", "half 8", "quarter to nine", "nineish", "nineteen hundred", noon and midnight. Bare numbers ("for 2", "the 28th") don't count. Anything else is dropped (trace `ignore_field`). This implements §5.7 "values come only from the latest guest message"; no approval needed.
- **Weekday (approved by the user, 2026-10-20).** If a booking message names exactly one plain weekday ("Monday", "this Monday", "on Monday", "this coming Monday") and no other date words, code sets the date to that weekday's first date after today, the same date the prompt's Weekdays list gives. Other date words are "next", "after", "following", "last", "every", today, tonight, tomorrow, weekend, a month name, or a day number. A model date that disagrees is replaced (trace `correct_field`). A weekday that is today's weekday is left to the model, because "this Friday" said on a Friday is ambiguous.
- **Ambiguity.** With exactly one usable reading, the old value is cleared and the field is asked plainly. A party ambiguity with any 9+ reading gets the large-party reply. With no usable reading, the reason is chosen by priority (large party, past the horizon, inactive branch, past date, then the rest), not by candidate order. This is within §5.7 ("if one message contradicts itself, ask").
Consequences: Unit tests for each pattern, both positive and negative. D1 cases SC-REG-006…009; D2 cases that state a meal without a clock time now expect `time: null` and no confirm card.
- **Addendum (2026-10-20, within BR-07, no approval needed):** a booking message that states 9 or more people ("for 20 people", "party of 12") always gets the large-party reply with the branch phone, whatever intent or party size the model returned (trace `correct_field` with reason `large_party`). In the live walkthrough, "Can I book a table for 20 people tomorrow?" was answered as an FAQ and D-15 replaced the answer with the generic fallback; another time the model dropped the 20 and asked for the branch. Cases SC-REG-013 and SC-REG-014.

## D-18 Guest chat and admin dashboard redesign (2026-10-20, status: approved by the user, 2026-10-20; build after T-20, before Phase 8)
Context: The user supplied two mockups, an "Olivia Kitchen & Bar" mobile chat and a reservations dashboard, and asked for the UI to look like them. Answers on 2026-10-20:
- copy the look only;
- no photos;
- all four dashboard extras;
- finish T-20 first.

Decision:
- **Brand and data.** Keep Neem & Ember, its two branches, menu and hours (BR-01 unchanged), so seed data and every eval case stay valid. Take the mockups' layout, dark green and cream palette, serif headings, cards, slot grid and selection summary.
- **No photos.** A botanical line illustration and colour treatment in SVG and CSS. Nothing is downloaded; icons are hand-written inline SVG and fonts are system stacks. No new packages.
- **Guest chat:**
  - a hero header with today's open status from the hours data;
  - quick actions (book a table, menu, opening hours, locations);
  - branch cards with address and today's hours;
  - a slot grid grouped by lunch and dinner, with a date navigator;
  - a "Your selection" summary, then details, then Confirm.

  The confirmation is still built only from a 201/200 response (H6, BR-12).
- **Admin extras (scope change):**
  - search by name, phone or reference; sortable columns; paging; a booking detail panel;
  - stat cards from real data (total, guests, confirmed, cancelled, vs the same day last week);
  - staff "New reservation" for phone and walk-in guests through the same engine and write path, with a `channel` column (web, phone, walk-in) added by migration. This extends the §4.1 staff journey and AC-07, and needs the same tests as the guest path;
  - read-only Tables, Menu and Opening hours pages. Editing stays a non-goal (§4.3).
- **Left out, because there is no data or feature behind them:** pending, completed and no-show statuses (bookings are confirmed or cancelled); floor plan; settings; notifications; attachments; "Most popular" badges; read receipts.
Consequences: New tasks in docs/PLAN.md before Phase 8. Every E2E and axe check is updated, and the invariants still run after every spec.

## D-19 Scope reduction for a two-hour demo (2026-10-20, status: requested by the user, 2026-10-20; supersedes D-18's admin extras)
Context: The user set a two-hour deadline. They asked for a polished, working demo of exactly three things: a mobile-first customer chat, the reservation flow, and a single-page admin reservations dashboard. Plus a README covering setup, architecture, model choice and known limitations.
Decision:
- **Keep and reuse.** Everything already built and verified stays: Next.js, SQLite, the Ollama `qwen3.5:9b` setup, the booking engine, the grounding and the existing hybrid retrieval. Nothing is removed or rebuilt.
- **Restyle.** Warm off-white, deep forest green, restrained sage accents, the existing serif and sans system stacks, subtle borders, phone-first.
- **Chat.** Three quick actions: Menu, Opening hours, and Book a table, which needs no model call.
- **Admin.** The existing single page, restyled: date selector defaulting to today, compact booking and guest counts, and a table of time, guest, party, branch and status with cancel. On phones, party and status sit under the time.
- **Dropped from D-18:** staff "New reservation" with a channel migration, search, sorting and paging, stat cards against last week, and the read-only Tables, Menu and Hours pages. The open walk-in lead-time question (BR-06) is moot.
Consequences: E2E specs follow the new entry point ("Book a table", then the branch). The README is written now, ahead of the rest of Phase 9. Phase 8's independent review has not been run on the restyle.

