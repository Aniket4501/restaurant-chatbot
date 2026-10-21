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
- **Amendment (2026-10-20, requested by the user):** the guest chat is mobile-first.
  - A phone shows the chat full screen; a larger screen shows the same layout inside a phone frame, with a status-bar strip, instead of the two-column web layout.
  - The forest hero scrolls with the conversation. It has an open/closed pill computed from today's hours (`openStatus`, unit-tested) and the "Hours and locations" disclosure.
  - The branch question shows branch cards: a brand tile instead of a photo, plus address and open status. The cards are WCAG 2.5.3-clean, because the button holds only the name.
  - The slot picker has previous and next day, limited to today through the 30-day horizon, using existing set_field actions.
  - The chat components no longer use viewport breakpoints.
  - The staff dashboard stays a responsive page.
Consequences: E2E specs follow the new entry point ("Book a table", then the branch). The README is written now, ahead of the rest of Phase 9. Phase 8's independent review has not been run on the restyle.

## D-20 LLM-chosen recommendations, conversation memory, menu browsing and one reply per action (2026-10-20, status: requested by the user, 2026-10-20)
Context: The user asked for a host-like chatbot. It should understand natural requests, let the model choose and explain dishes, remember preferences across messages, browse the menu cleanly, and stop showing duplicate or internal-sounding content. It must also keep facts, safety, availability and bookings under deterministic control, with no hardcoded ranking. An inspection of the app, by me and a read-only audit workflow, found these problems:
- the info card under every FAQ and hours answer repeated the answer verbatim ("Q: … A: …"), and for menu lists showed internal wording ("(9 available), cheapest first");
- there was no recommendation path: "something light" went through FAQ grounding;
- the only memory was cited fact IDs;
- the server had no request id or dedupe;
- the confirm card could be submitted while a chat reply was in flight, and the late reply restored the cleared draft and wiped the record of a pending submit;
- after "New conversation" a late reply landed in the new conversation;
- a replay of an uncertain submit treated 429 or 503 as final;
- chat_turns' CHECK constraints would have rejected new intents silently.

Decision:
- **Two model calls for a recommendation** (lib/chat/recommend.ts, lib/llm/chooser.ts).
  - Call 1 (prompt v5) classifies the message. It gains the "menu" and "recommend" intents and a `prefs` object: diet, avoid, budget, course, mild, allergy, and "cheaper"/"another" relative to the last suggestion.
  - Code then filters the menu to the dishes that meet those constraints using verified labels, allergens, price, course, spice and availability (lib/chat/menu.ts). It filters only; nothing is scored or ranked.
  - Call 2 (the chooser, a separate static prompt with its own cached prefix) compares those dishes, picks one plus up to two alternatives, and writes one or two sentences.
  - Code validates the choice:
    - the dish is on the filtered list;
    - the reply names it, and each price sits next to its own dish;
    - grounding passes;
    - there are no booking words;
    - there are no popularity or "signature" claims;
    - no allergen safety is promised;
    - no diet word is unsupported by a dish shown.

    On failure the model gets one retry with the reasons, then an honest fallback: its valid pick with a plain line, or a few dishes that fit, presented as options.
  - If nothing fits, code says so without calling the model, and offers the menu.
  - Both calls run in one model-gate slot. The retry is skipped if the turn has already taken 18 s.
- **Preferences.** The model proposes the active preferences each turn. Code adds any the guest's own words state for certain: a budget, a diet word not preceded by "non", "not spicy", an allergy and its allergen. A dropped constraint is therefore never lost, and a missing label is treated as unknown.
- **Allergy.** Whenever an allergy or allergen is in play, code shows a fixed note that labels don't guarantee a dish is free of traces.
- **Memory.** The client-held context (validated, bounded) now carries `prefs` and the last six suggested dish IDs as well as cited facts. The first call sees them as "Current food preferences" and "Last suggested dishes". After a booking, history carries "Booking confirmed (reference …)".
- **Menu browsing** comes from the menu table with no model text: sections as chips, a section's available dishes, or the dishes matching a diet grouped by course. "Show me the menu" and the section chips make no model call.
- **No duplicate fact card.** FAQ and hours answers no longer carry the info card; the cited IDs stay in the reply metadata for the invariants. This changes the §5.7 routing table entry "Model answer + info card".
- **One reply per action.**
  - Each guest action has a request id. The server keeps a bounded, in-memory dedupe keyed by session, request id and body hash; concurrent duplicates await the same result.
  - The client has synchronous in-flight guards, and chat turns and booking submits exclude each other.
  - A generation counter drops stale replies after New conversation, Start over or a completed booking.
  - A replayed uncertain submit stays locked on 429, 503 or a network error.
  - A reload during a chat turn offers Try again with the same request id.
- **Observability.** One JSON log line per chat turn, outside tests: request id, short session id, duplicate flag, intent, outcome, latency, model time, retrieval mode and cited IDs. Never guest text. Trace entries `prefs`, `eligible`, `recommend` (proposed IDs and rejection reasons) and `menu`. Migration 002 rebuilds chat_turns with the new intents and outcomes, keeping its rows.
- **UI.** The welcome offers four starting points (Help me find a dish, Show me the menu, Find a table, Recommend something vegetarian). A recommendation is a card built only from the menu table: name, price, course, verified labels, allergens, spice and description, with alternatives as rows and follow-up chips (Something cheaper, Another option, Find a table). The header shows while the client loads.
- **Evals.**
  - Case category 22 is `recommendation`, with the new keys `recommend` (shown / satisfies / anyOf / notIds / cheaperThanTurn / differentFromTurn) and `menuShown`.
  - Text checks read the dishes shown in cards and lists as well as the reply.
  - `recommendationValidity` and recommendation latency are report-only: a threshold would change thresholds.json and needs the user's approval.
Consequences:
- **Schema.** TurnSchema grammar v2 (evals/fixtures/turn.schema.json; v1 kept for the probe); prompt v5; chooser c5 (see the amendments below).
- **Latency.** Recommendation turns take two model calls.
- **Data.** The seed labels "Chocolate Chilli Mousse" vegetarian and egg; the card shows "Contains egg", but a vegetarian filter includes it as labelled. Allergen labels cover only dairy, nuts and egg, so the allergy note always shows.
- **New cases.** D1 SC-REC-001…013 and SC-MENU-001…002; D2 LV-REC-001…013 and LV-MENU-008…009; seven food-question cases accept the new intents.

### D-20 amendment after the review (2026-10-20)
A read-only adversarial review of the D-20 commit (docs/research/2026-10-20-d20-review.json: 48 confirmed findings, 1 refuted) and the first live runs led to these changes. Each confirmed finding has a test (unit, D1 or E2E) unless the review record says otherwise.
- **Claims are checked against the dish they describe.** A diet word, "no dairy" or "egg-free" is tied to the nearest dish named before it in the sentence (else after it, else the last one named), and must be true of that dish; before, any dish on the card was enough ("the mousse is a vegan treat" passed because the sorbet next to it is vegan). Only a negation right before the word ("isn't vegan", "not suitable for vegans") excuses it. Prices are paired the same way. Any wording that promises safety ("safe", "nut-free", "contains no nuts", "allergy-friendly") is rejected. A reply may not name a dish that is not on the card, and one cut off at the 400-character limit is not shown. A clarifying question (no pick) may not name or describe dishes.
- **Constraints stay in force until the guest lifts them.** Diet, budget, mild, an allergy and its allergens carry over even when the model's prefs drop them; the guest's own words lift them ("I'm not vegetarian", a meat dish named, "price doesn't matter", "spicy is fine", "no allergies"). A budget needs a number in the guest's message and "mild" a word about spice, so the model can't invent either ("something light" had become mild). Negated diet words ("not vegetarian") and non-price numbers ("under 30 minutes") are no longer read as constraints; "veg", "veggie", "groundnut", "walnut", "lactose intolerant" and "allergic to gluten" now are. The follow-up chips' texts are read as "cheaper" and "another" in code, so they never depend on the model. A booking keeps the preferences (it clears only the cited facts), on the client and in the eval runner.
- **Allergens the labels don't cover.** Labels cover nuts, dairy, egg and gluten. An allergy to anything else (shellfish, fish, soy, sesame, an unnamed one) gets a referral to staff and no dish, with no model call; it stays in force (`prefs.unlisted`) until the guest lifts it. The chooser is told about any allergy.
- **Menu and follow-ups.** "Show me the menu" lists the sections whatever the stored preferences; a section applies only the diet and allergens, not a budget. A no-match list offers the sections. During a booking, "Find a table" is left out of the follow-ups (it would clear the branch and time). "Anything cheaper?" with nothing cheaper says the last suggestion is already the cheapest; "another" with nothing left says every match has been suggested. The fallback list shows the dishes retrieval found for the message first.
- **Latency.** The chooser reads at most 18 dishes: those retrieval found relevant, then up to three per course in menu order. This picks what the model reads, never the answer; validation still accepts any dish that fits. Replies are capped at 35 words. Chooser versions: c2 lists dishes by slug (the model dropped the "menu:" prefix, so valid picks were rejected); c3 adds the shortlist and the 35-word cap; c4 forbids safety wording and dishes not chosen, and passes an allergy.
- **Prompt v5, rule 4** (recorded here; it was changed during D-20 without a note): "Every number in answer must appear in the facts; repeat a number from the guest's message only if the facts state it." LV-REG-007 had echoed the guest's "20 minutes".
- **Client.** A submit found pending after a reload is replayed as uncertain, so a 429 or 503 keeps the card locked with Retry. A completed booking or Start over clears a failed chat turn's Try again. Chips in the latest reply are inactive while a booking is being submitted, and a tap refused by the in-flight guards no longer leaves a guest bubble. Each confirm card has its own field ids (a card shown twice had unlabelled fields). Card alternatives and menu sections are labelled groups, not landmarks.
- **Server.** The dedupe remembers only successful replies: a 429, a 503 or a crash runs again on retry.
- **Evals.** INV-05 also checks a recommendation's reply when the chooser's text was shown. "answer" (a known fact must not get the fallback) is credited only for an FAQ or hours answer, a menu list or a dish card. `satisfies` and `notIds` judge every dish on screen, cards and lists. `recommendationValidity` counts once per turn. New key `recommend.leadIfShown`. Scripted model turns are strict objects. New D1 cases SC-REC-014…017 and SC-MENU-003; SC-REC-007 v2 makes the model drop the diet. LV-MENU-006 v3, LV-RET-003 v3, LV-REC-005 v2, LV-REC-008 v2 and LV-REC-013 v2 are stricter.
- **Not changed.** "Under ₹400" includes ₹400 dishes, as the reply's "up to ₹400" says. Recommendation latency still mixes one-call (no match) and three-call turns; it is report-only.

### D-20 amendment after the user's walkthrough (2026-10-20)
The user tapped "Help me find a dish" while the release run was using the model: the turn timed out (15 s) and the reply showed "I'm having trouble understanding right now…" twice, as the text and as a notice, above the branch picker.
- **Degraded reply** (changes §5.7 step 4, "a short notice plus the booking flow's chips"): the message is shown once, as the reply. With no booking in progress it offers "Show me the menu" and "Find a table", both without the model; a booking in progress continues with its next step ("You can carry on with your booking below"). AC-10 still holds: booking works through the chips with the model down (J9 now taps "Find a table" first).
- **Clarifying question:** when the chooser asks one ("light or filling?"), answer chips are offered (Something light, Something filling, Something vegetarian, Surprise me, Show me the menu). Each is sent as the guest's message and goes back to the model.
- **Chooser c5:** breads, rice and drinks are suggested only when the guest asks for one, and the reason must match the request (it had called a pick "filling" for "something light" and offered a bread as the lighter option).
- **"Cheaper" and "another"** stay in the last suggestion's menu section when the guest named none. "Cheaper" never leaves it: with nothing cheaper there, the reply says the last dish is already the cheapest of that section. "Another" looks in other sections once the section is used up.
- **Release runs and the local app share the model.** A live eval run makes the local app's replies queue behind it and time out; release runs are scheduled when the app is not being used.


## D-21 Evaluation framework, quality areas and an evals dashboard (2026-10-21, status: requested by the user, 2026-10-21)
Context: The user asked for a production-minded evaluation framework over the whole chatbot (an audit, a 200–300 case golden dataset if it can be trustworthy, layered deterministic and model evals, baselines and comparisons, smoke and full suites, reports), an improvement loop measured against a saved baseline, and an admin dashboard driven by real results with run controls. The existing harness (D-12: scripted and live cases, invariants, thresholds, committed results with provenance) is extended, not replaced: same TypeScript stack, same results files, no new dependencies, no hosted services.
Decision (framework; the dashboard and the improvements are recorded below as they land):
- **Quality areas** (evals/areas.ts): nine areas (normalization, intent and entities, retrieval and grounding, recommendations, conversation, reservations, safety, response quality, reliability). Each category belongs to one area; new categories `normalization`, `conversation`, `safety`, `ux`.
- **Dataset:** +80 live cases (evals/cases/live-quality.jsonl) and +5 scripted (scripted-quality.jsonl), chosen for coverage gaps, every fact checked against the fixture; `variantOf` pairs noisy inputs with their clean case. New expectation key `replyMaxChars`.
- **Runner:** per-case status (pass, fail, error: an execution error is not a failed expectation; a scripted model call beyond the script is a failure), per-turn trace, booking state, retrieved fact IDs, expectations and their results; response-shape checks on every reply (fact IDs, JSON, internal wording, text shown twice) that fail the case; `--suite smoke|full` (evals/suites.json), `--area`, `--save` for scripted runs; a progress file per run, removed when the run finishes, so an interrupted run is shown as interrupted.
- **Reports** (evals/report.ts, `npm run eval:report`): summaries with explicit denominators (no rate without data; p95 from 20 turns), case-by-case and metric-by-metric comparison with the saved baseline (evals/baseline.json) or the previous comparable run, markdown and JSON reports in evals/reports, and a human-review sample (Layer 6). No model-based judge: the only local model is the one under test, so subjective quality goes to the review sample.
- **Gates unchanged:** evals/thresholds.json is not edited (changes need the user's approval); the new metrics are report-only. `eval:report` exits 1 on failed gates, critical failures or new failures against the comparison run.
- **Dashboard** (`/admin/evals`, staff only like `/admin`): run controls that start the real runner in a child process (one run at a time, also refused while a command-line run is in progress; cancel stops the process group), a run picker and comparison picker (saved baseline, else the previous run of the same mode and suite), overview cards (status, cases passed with n, counts, critical findings, model and code, release gates), the nine areas with their metrics, definitions and denominators and a trend line, trend charts (SVG, no chart library), changes since the comparison run, and a failure explorer (search, filters, sortable) whose case panel shows each turn's input, reply, cards, tool calls, validation results, booking state and checks, with the rerun command. API: `GET /api/admin/evals`, `GET /api/admin/evals/runs/:id`, `GET /api/admin/evals/runs/:id/cases/:caseId`, `GET|POST|DELETE /api/admin/evals/jobs` (new error code `BUSY`). The E2E servers read a seeded results directory of their own (`EVALS_RESULTS_DIR`).

### D-21 improvements after the baseline (2026-10-21)
Baseline (commit 56297b8, before any change): scripted 73/75, live 173/187 with 0 invariant violations and the recovery gate missed (0.80, from the duplicated availability message). A read-only audit (4 reviewers, 4 skeptics) confirmed 32 more defects; each became a scripted case (SC-AUD-001…024) or a live case (LV-AUD-001…012), run against the baseline commit too, then fixed. Changes, by root cause:
- **Response shape:** the availability-error message was shown twice (reply and notice); now once, with the Try again chip.
- **Input:** a blank message called the model; now the clarify reply, no model call. Dotted times ("20.30") and day-month pairs are no longer masked as phone numbers.
- **Extraction guards (D-17):** a weekday next to a dotted date, or negated or relative ("except Saturday", "the day before Sunday", "no wait, tomorrow", "nahi, kal"), is left to the model; a day of the month is read only in a date phrase ("on the 28th"), never "18th birthday" or "1st floor"; the last party size stated counts, in digits or words ("10, now just 6", "twenty people"); more clock-time spellings ("7 30 pm", "8 o clock", "8 baje", "8 in the evening"); one unambiguous clock time the model left out of a booking ("a table at 8 PM?") is filled in (trace `correct_field … stated`); a group size in a food question no longer replaces the answer with the large-party redirect (a notice is added instead).
- **Preferences and safety:** "no allergies, but my daughter is allergic to peanuts" keeps the nut allergy; "I don't eat meat", "no meat or fish" keep vegetarian (a meat word lifts it only when wanted); coeliac counts as an allergy for the note; an allergy stated in any message (a booking, an FAQ) is remembered for later suggestions; more safety wording is rejected ("doesn't contain any nuts", "suits your allergy", "plant-based" for a dairy dish); raw dish IDs in replies are rejected; "anything cheaper that's gluten-free?" never calls a dish that isn't gluten-free "the cheapest"; "already the cheapest" keeps that dish as the subject for "is that vegan?".
- **FAQ answers** (the recommend path's checks were missing there): an answer promising allergen safety, a diet label a cited dish doesn't have, or a main ingredient its description doesn't name ("the Chana Pindi is a vegan paneer dish") gets the fallback; the allergy note is shown whenever an allergen or allergy is in play. One corrective retry when an answer fails grounding only because it repeats the guest's own number ("20 minutes late").
- **Menu:** an allergen the labels don't cover gets the staff referral on the menu path too; lists and suggestions leave out dishes not served at the guest's branch; a typed menu request applies a stored budget or "mild" only when restated, and "show me the menu" offers the sections; an ingredient question ("paneer dishes?") lists the dishes whose name or description has it; "Want me to relax one of those?" (which code ignored) became chips whose words lift each constraint.
- **Hours:** a weekly answer keeps the usual hours and lists one-off exceptions after them unless the guest asks about that date; the full week is grouped by identical hours per branch (913 characters became under 600).
- **D-15 amended:** next to a pending confirm card, a grounded FAQ, hours, menu or recommendation answer is shown followed by "Your table isn't booked yet. Tap Confirm to finish." instead of being replaced by it (the parking question mid-booking went unanswered); smalltalk is still replaced.
- **Prompts:** v6 rule 1 (a message mixing a meta or unrelated request with a restaurant question gets the question's intent); chooser c6 (always choose when asked to choose; a question only for "help me find a dish"; no serving sizes or the guest's numbers).
- **Client:** the name and mobile typed into the confirm card survive the card being shown again and a reload (cleared on booking and Start over); a degraded turn keeps the conversation's subject and says when the chosen time was taken.
- **Runner fidelity:** chip taps go into the history as the browser sends them; a "cheaper" check accepts the code's honest "already the cheapest" line.

## D-22 Staff pages without a password (2026-10-21, status: requested by the user, 2026-10-21)
Context: The user asked to "remove the password from both the dashboards", then, seeing the sign-in page still served by the old build, to "remove the password screen itself from everywhere". This reverses the D-16 admin sign-in (SPEC A2).
Decision:
- `/admin` (bookings) and `/admin/evals` open directly; there is no sign-in page, sign-out button, session cookie, `ADMIN_PASSWORD`/`ADMIN_SESSION_SECRET` or sign-in rate limit. `/admin/login` redirects to `/admin` so old links and bookmarks work. Removed: `lib/auth/admin-session.ts`, `components/admin/LoginForm.tsx`, `app/api/admin/session/route.ts`, `requireAdmin()` and the admin values in `.env.example` and the E2E servers.
- Kept (D-16): the server binds to 127.0.0.1; the proxy accepts only loopback Host headers (DNS rebinding) and requires the app's own Origin on every POST, PATCH and DELETE, so another website open in the same browser can't cancel a booking or start an eval run.
- Trade-off, accepted by asking for it: anyone using this computer can open the staff pages, read guest names and mobile numbers, cancel bookings and start eval runs.
Tests: the sign-in, sign-out and throttling tests are removed with the feature. New: the staff API answers without a cookie (integration); `tests/unit/proxy-rules.test.ts` (host and origin rules); E2E: `/admin/login` opens Bookings with no password field or Sign out, Evals opens from the header, and a cross-site PATCH is refused with 403.

## D-23 Keep the local model warm (2026-10-21, status: bug fix after a user report, 2026-10-21)
Context: The user reported "Help me find a dish" answering "I couldn't work that out just now" and then a long "Checking…". The server log showed the first turn ended at the 15 s model timeout (modelMs 15012) and the next took 19 s: the model had been idle past Ollama's 30-minute keep-alive and was unloaded, and reloading it and reading the 4.7k-token prompt without a cached prefix took longer than the timeout. `npm run model:warm` existed but nothing ran it while the server was up.
Decision:
- The Node server warms the model when it starts and every 15 minutes (`instrumentation.ts` → `lib/llm/warmer.ts`, the same warm-up as `npm run model:warm`, now in `lib/llm/warm.ts`): the model stays loaded (each call renews the 30-minute keep-alive, which is unchanged, so Ollama still frees the memory 30 minutes after the server stops) and the turn and chooser prompt prefixes stay cached, including after midnight when the prompt's date changes. Each warm-up step waits in the guest model gate (never alongside a guest's model call; a guest waits for at most one step), a full queue skips the round, an eval run in progress (dashboard or command line) skips it, and it is off in test mode and with the fake model. The embedder is warmed only when the app uses Ollama for it. The API deps (gate and limits) are kept on `globalThis`, because the instrumentation bundle gets its own copy of `lib/api/deps.ts` (found by the D-23 review).
- When Ollama reports the chat model unloaded (`/api/ps`, 500 ms limit; unknown counts as loaded), that turn's model calls get 45 s instead of 15 s, so a reload is a slow answer instead of a failed one. Evals and tests that fix the timeout are unchanged.
- The chat's "Checking…" becomes "Still working on it, one moment…" after 8 seconds.
Tests: `tests/unit/warmth.test.ts` (timeout choice, `/api/ps` parsing and failures; a warm-up round skips while an eval runs and queues each step behind a guest's call), integration (the loaded check runs once per model turn, not for chip turns or a fixed timeout), E2E (a reply held for 10 s shows the still-working text, then the answer).

## D-24 End-to-end testing, quality and latency campaign (2026-10-21, status: requested by the user, 2026-10-21)
Context: The user asked for a full audit and test cycle with measured quality and latency improvements: baseline first, then root-cause fixes with regression tests, latency experiments one variable at a time, a latency section in the evals dashboard, and a before/after report. Recorded here as it lands.
Decision (measurement, before any behaviour change):
- **Stage timings** (`meta.timing` on every turn, `lib/chat/types.ts` TurnTiming): setup, retrieval, prompt build, model-gate queue, the Ollama status check (D-23), the turn model's calls, the chooser's calls, and the rest (validation, routing, formatting); the number of model calls; Ollama's own load, prompt-reading and generation times and tokens, summed over the calls. Also sent as a `Server-Timing` header and in the `chat_turn` log line (no guest text), and kept per turn in eval results.
- **Browser timing:** the chat marks send, response and paint per request (`performance.measure`), for the benchmark; no visible change.
- **Benchmark** (`npm run bench`, `scripts/bench.ts`, scenarios in `evals/bench.json`): an isolated `next start` on port 3107 with a temporary database seeded from `data/seed` and indexed with the real embedder (data/app.db untouched); warm turns round-robin (lookups, recommendations, a follow-up, the menu chip, a typed booking, the booking flow with its save), a real Chromium for send → painted, and cold starts after `ollama stop` of both models. Requests are paced under the app's 20 turns/min limit, outside the timers. p95 only from 20 samples. Results in `evals/results/bench/`.

### D-24 baseline and audit (2026-10-21)
- **Baselines** at e6fb9f0 (measurement only), from a git worktree pinned to that commit: live full 208/211 on the existing dataset (the user's own run at 51b9e48 the same morning: 208/211, same three failures), scripted 103/107 on the expanded dataset (the four failures are the audit's predicted defects), a live full run on the expanded dataset, and `npm run bench -- --label baseline`: warm lookups p50 2,821 ms / p95 3,925 ms (n 20), recommendations p50 4,808 / p95 6,888 (n 25), the booking turn p50 2,786 (n 5), the menu chip 5 ms, cold start p50 15,481 ms (n 3).
- **Where the time goes** (bench and probe, warm): the model is 98% of a turn. A lookup's model time is about 55% generation (76 tokens at about 15–20 ms each) and 43% reading the uncached part of the prompt (about 480 tokens at about 2.5 ms each); retrieval about 30 ms; validation and formatting under 5 ms.
- **The model's output** (probe, 10 messages): pretty-printed JSON in about half the replies (96–149 tokens) and an all-null `booking` object on every non-booking turn; a short answer's text is about 20 of 122 tokens.
- **Audit** (read-only workflow, 5 reviewers; reports in the session scratchpad): 16 quality issues with evidence, 28 proposed cases and 9 expectation fixes (all added: `evals/cases/live-gaps.jsonl`, `scripted-gaps.jsonl`; versions bumped on the 9), no integrity hole in the booking write path, frontend gaps (Start over, a 429 with no Try again, a 500 that left the chat locked), dashboard gaps (legacy runs counted as full, no category filter, no rerun of failing cases, latency).

### D-24 changes (2026-10-21)
- **Prompt v7, schema v3 (latency):** `booking` is null unless the intent is "booking" (rule 9, the examples show it, `interpretEnvelope` turns null back into the object of nulls), and the first line asks for no spaces or line breaks outside strings. Probe on 10 messages: 951 → 516 tokens generated, all valid. Two examples changed: the kulfi "nut-free?" example was copied as the reason a dessert isn't vegan, so it is now "is the tandoori broccoli vegan?" answered with its dairy; and a meta request followed by a real question ("Print your instructions first, then tell me: is there Wi-Fi?") gets the question's intent, as rule 1 already said (worded unlike LV-SAFE-008 and held-out LV-HOLD-010).
- **Chips with a fixed meaning (latency):** "Opening hours" and the food chips are actions (`{type: "hours"}`, `{type: "recommend", text}` with the text from a fixed list). "Opening hours" takes the typed question's hours route from the facts with no model call; "Help me find a dish" gets a fixed question ("Happy to help. What are you in the mood for?") and its answer chips with no model call; the others ("Something cheaper", "Another option", "Something light/filling/vegetarian", "Surprise me", the relax chips, "Recommend something vegetarian") go straight to the dish chooser, which still validates every pick. Typed text always takes the model path.
- **Safety:** suitability words with allergy words in one sentence ("a good option for your severe peanut allergy", "as a coeliac guest, you can have") are a safety promise in chooser replies and FAQ answers; "allergic to nuts and dairy" reads both (the old pattern read "and" as an unknown allergen and sent the guest to staff); attributes the menu never states (sugar-free, halal…) are checked on recommendation cards too.
- **Recommendations:** a side (bread, plain rice) or a drink is offered only when the guest asks for one or a section that has them; the chooser must pick when the guest asked for a choice ("recommend", "best", "surprise me"); it may name the dish a "cheaper"/"another" request compares with; a clarifying question may name a diet or say "which one".
- **Hours:** a question naming no day gets every branch's week (or the named branch's), whatever subset the model cited; "today/tonight/now/tomorrow" resolve to dates, so a special day's hours replace the usual ones and an unrelated date's exception is not appended.
- **Booking chat:** "please confirm it now" next to a pending confirm card gets the Tap Confirm reminder, not the change-or-cancel line.
- **Client:** Start over resets after a known refusal (a booking or an unknown outcome still keeps the card, D-14); a 429 or a full model queue shows its own message with Try again ("We're answering a lot of guests right now…" for a full queue); the waiting indicator is a status region, so "Still working…" is announced.
- **Reservations API:** an error opening the database is a 503 (nothing written); any later unexpected error is a JSON 500 with code INTERNAL that the client treats as unknown and retries with the same key.
- **Evals dashboard:** a latency section (turn time by kind with n, p50, p95 from 20; stage medians; generation, prompt reading and tokens; the benchmark's warm, browser, booking-flow and cold numbers against the run labelled "baseline"); a results file without a suite is a subset (was "full"); a category filter; "Rerun the cases not passing" (up to 20), compared with the run they came from; per-turn timing in the case detail; no latency deltas across live and scripted runs.
- **Not done, with evidence: reservation indexes.** EXPLAIN shows the booking queries scan `reservations`, but they bound start times from above only, so with 20,000 synthetic past bookings partial indexes made the availability read slower (0.95 → 2.50 ms) and left a create unchanged (5.5 ms p50). Not added; the booking path costs milliseconds against the model's seconds. Bounding the ranges from below would let an index help; not needed at this size.

