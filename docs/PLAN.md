# Implementation plan

Status: approved at G2 (2026-10-19) · Implements `docs/SPEC.md` with `docs/ARCHITECTURE.md` and decisions D-01…D-16. Each task ends with its tests green, `git diff` reviewed and one commit (`T-07: booking service`) on `build/reservation-bot` (§7.2).

22 tasks. Under D-01, T-01…T-17 need only G2 (fake model and fake embedder), and T-18 onward also need G2-M. **Critical path:** T-01 → T-02 → T-03 → T-05 → T-06 → T-07 → T-08 → T-14 → T-15 → T-16 → T-20 → T-21 → T-22. It is the longest chain in the dependency column; marked ✓. The chain T-05 → T-10 → T-11 → T-13 → T-14 is equally long and marked ≈. T-18 → T-19 also wait on the external G2-M gate and join at T-20.

| ID | Title | Phase | Depends on | Critical | Risk |
| --- | --- | --- | --- | --- | --- |
| T-01 | Scaffold and toolchain | 4 | G2, `vite` approval (D-07) | ✓ | med |
| T-02 | Config, env validation, clock | 4 | T-01 | ✓ | low |
| T-03 | DB client, migrations, schema tests | 4 | T-02 | ✓ | med |
| T-04 | Time utilities | 4 | T-01 | | low |
| T-05 | Seed data and loader | 4 | T-03, T-04 | ✓ | med |
| T-06 | Availability engine | 4 | T-04, T-05 | ✓ | med |
| T-07 | Booking service and race test | 4 | T-06 | ✓ | high |
| T-08 | Public APIs (availability, reservations, health) | 4 | T-07 | ✓ | med |
| T-09 | Admin auth, proxy, admin APIs | 4 | T-08 | | med |
| T-10 | Knowledge base and retrieval | 5 | T-05 | ≈ | med |
| T-11 | Model adapter, schema, fake, prompt builder, redaction | 5 | T-02, T-10 | ≈ | med |
| T-12 | Grounding, claims, hours rendering | 5 | T-10 | | med |
| T-13 | Turn pipeline and `/api/chat` | 5 | T-06, T-11, T-12 | ≈ | high |
| T-14 | Eval runner, invariants, D1 scripted suite | 5 | T-08, T-13 | ✓ | med |
| T-15 | E2E harness and `npm run verify` | 5 | T-09, T-13, T-14 | ✓ | med |
| T-16 | Guest chat UI | 5 | T-15 | ✓ | med |
| T-17 | Admin UI | 5 | T-15 | | low |
| T-18 | Ollama clients, `model:check`, `model:warm` | 6 | G2-M, T-13 | gate | med |
| T-19 | D2 dataset and live baseline | 6 | T-14, T-18 | gate | med |
| T-20 | QA and AI evaluation | 7 | T-16, T-17, T-19 | ✓ | med |
| T-21 | Independent review and hardening | 8 | T-20 | ✓ | med |
| T-22 | Final verification and delivery | 9 | T-21 | ✓ | low |

Your priorities map to tasks as follows:
1. Schema, migrations and seed data: T-03, T-05.
2. Chat UI and admin dashboard: T-16, T-17 (admin API in T-09).
3. Reservation APIs, availability and duplicate protection: T-06, T-07, T-08.
4. Knowledge base and retrieval interfaces: T-10.
5. LLM-free tests: inside every task, plus T-14 and T-15.
6. Model adapter interface: T-11.

## Phase 4: foundation and backend

### T-01 Scaffold and toolchain
- **Files:** `package.json`, `package-lock.json`, `.npmrc`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `app/{layout,page}.tsx`, `app/globals.css`, `vitest.config.mts`, `playwright.config.ts`, `.gitignore`, `.env.example`
- **Steps (D-07):**
  - Scaffold with `create-next-app@16.4.2` into a temp dir with the D-07 flags, then copy the files in and merge `.gitignore` (keep `!.env.example`; add `next-env.d.ts`, `*.tsbuildinfo`, `.vitest/`, `coverage/`).
  - Name the package `restaurant-chatbot`, set `"engines": {"node": ">=26.0.0"}` and pin exact versions with `save-exact`.
  - Configure Tailwind via `@tailwindcss/postcss`, `tsconfig` `"types": ["node"]`, and `next.config` `agentRules: false` plus `experimental.agentUpgrade: false`.
  - Every `next` script uses `-H 127.0.0.1` and `NEXT_TELEMETRY_DISABLED=1`.
  - Define the §8 Phase 4 scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `db:*`, `kb:index`, `test*`, `eval*`, `model:*`, `setup`, `verify`, `verify:release`.
  - Configure Vitest projects `unit`/`integration`, and Playwright Chromium with two webServers on 3100 and 3101.
  - `npm install`; `npx playwright install chromium`.
- **Acceptance:** AC-13 (skeleton): lint, typecheck and build pass on the empty app; `vitest run` and `playwright test --list` work.
- **Tests:** a smoke unit test; `npm run lint && npm run typecheck && npm run build`.
- **Permissions:** npm installs and the Chromium download (approved at G1). `vite@8.3.4` needs G2 approval (H9).
- **Done when:** the commands above are green; the ESLint 10 peer warnings are recorded; no `^` ranges remain.

### T-02 Config, env validation and clock
- **Files:** `lib/config.ts`, `lib/time/now.ts`, `.env.example`, `tests/unit/config.test.ts`
- **Steps:**
  - Zod env: `DATABASE_PATH`, `LLM_PROVIDER`, `EMBED_PROVIDER`, `OLLAMA_BASE_URL` (loopback only), model names (no `*cloud`), `ADMIN_PASSWORD`/`ADMIN_SESSION_SECRET` rules, and the `E2E_TEST_MODE` guard (both fakes plus a temp DB).
  - BR-03…BR-07 constants and timeouts.
  - `getNow()` honouring `NOW_OVERRIDE` in test mode only (D-12, D-16).
- **Acceptance:** AC-14 (no secrets in code); the D-12 guard; D-16 env rules.
- **Tests:** unit tests for every refinement, plus a unit test that fails if `Date.now()`/`new Date()` appears outside `lib/time`.
- **Done when:** the guard refuses each bad combination in tests.

### T-03 DB client, migrations and schema tests
- **Files:** `lib/db/{client,migrate,tx}.ts`, `lib/db/migrations/001_init.sql` (the ARCHITECTURE appendix, verbatim), `tests/integration/schema.test.ts`
- **Steps:**
  - `openDb(path)`: `timeout: 5000`; WAL asserted with `{ simple: true }`; `foreign_keys = ON`; `synchronous = FULL`.
  - A lazy singleton for the app, and explicit handles for tests.
  - A typed `tx.immediate(fn)` that rejects Promise-returning callbacks.
  - Migrations in IMMEDIATE transactions, recorded in `schema_migrations`.
- **Acceptance:** G-1 groundwork; D-08; D-14 schema.
- **Tests:** port the 30 checks in `docs/research/2026-10-19-schema-check/` to better-sqlite3. They also assert `err.code` values (`SQLITE_CONSTRAINT_TRIGGER`, `SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CONSTRAINT_FOREIGNKEY`), which are Inferred in research (SQ-08). Check that the pragmas hold after reopening.
- **Risk:** this is the gate for better-sqlite3 13.0.3 (fallback 12.11.1, D-08).
- **Done when:** all 30 checks plus the pragma tests pass in Node.

### T-04 Time utilities
- **Files:** `lib/time/{tz,calendar,format}.ts`, `tests/unit/time.test.ts`
- **Steps (D-09):** build TZDates from numeric parts only and pass `in: tz(zone)` everywhere; compute branch-local today, weekday, horizon and the 31-day calendar; format `h:mm a` and `EEE d MMM`.
- **Acceptance:** BR-05, BR-06.
- **Tests:** unit tests, plus `test:unit:tz` under `TZ=UTC` and `TZ=America/New_York`, including US/UK DST dates inside the horizon.
- **Done when:** both TZ runs are green.

### T-05 Seed data and loader
- **Files:** `data/seed/*.json` (demo Neem & Ember data, relative exception dates), `lib/db/seed.ts`, `scripts/seed.ts`, `tests/integration/seed.test.ts`
- **Steps:**
  - Zod-validate the seed files, including the exception loader rules and the restaurant row.
  - Resolve relative dates against `app_meta.seed_anchor_date`.
  - Reseed is an upsert by natural keys in one IMMEDIATE transaction, with a conflict report (D-14).
  - `db:migrate`, `db:seed`, and `db:reset`, which refuses any path but the dev DB.
- **Acceptance:** BR-01…BR-03, BR-14.
- **Tests:** `base.json` loads; reseed is idempotent; a conflicting reseed aborts; bad exception combinations are rejected; the anchor is reused.
- **Done when:** the tests are green and `npm run db:reset && npm run db:seed` works on the dev DB.

### T-06 Availability engine
- **Files:** `lib/booking/{availability,load}.ts`, `tests/unit/availability.test.ts`
- **Steps:** implement §5.5 steps 1–8 (windows, grid, lead time, fit, rank, reason, alternatives) as a pure function with injected `now`.
- **Acceptance:** BR-02…BR-08, BR-10; AC-03 basis; 100% availability accuracy (§6.5).
- **Tests:** table-driven fixtures:
  - weekly hours and Gurugram's closed Monday lunch;
  - 22 Oct dinner closure, 27 Oct full closure, 31 Oct extended dinner;
  - last seating for 1–4 vs 5–8 guests;
  - lead time at the boundary (59, 60, 61 min);
  - horizon day 30 vs 31;
  - smallest table; alternatives at the other branch and over the next 2 days.
- **Done when:** every fixture matches its expected slots exactly.

### T-07 Booking service and race test
- **Files:** `lib/booking/{create,cancel,errors,ref,hash}.ts`, `tests/integration/{booking,race}.test.ts`, `tests/integration/race-child.ts`
- **Steps:**
  - §5.6 steps 1–5 with D-08/D-14: re-lookup on any constraint error; typed `SLOT_TAKEN`/`SLOT_UNAVAILABLE`/`DUPLICATE_BOOKING`; the J7 name rule if approved; ref generation with retry.
  - Idempotent cancel.
- **Acceptance:** AC-04, AC-05, AC-06; BR-09 (required fields, E.164 mobile, name and note lengths), BR-11 (duplicates); G-1…G-4.
- **Tests:**
  - Idempotent replay (200, one row); key reused with a different body (422).
  - Duplicate guest (409 with existing); rule failure at now+59 min (409 `SLOT_UNAVAILABLE` with alternatives ≥ 1, 0 rows).
  - Ref collision → 201; `SQLITE_BUSY` → 503.
  - The 20-process race ×10 (1 created, 19 `SLOT_TAKEN`, no BUSY), plus a trigger-only variant (19 `TABLE_OVERLAP`).
- **Done when:** all green, the race test passes 10/10, and the test timeout is 120 s.

### T-08 Public APIs
- **Files:** `app/api/availability/route.ts`, `app/api/reservations/route.ts`, `app/api/health/route.ts`, `lib/http/*`, `tests/integration/api-*.test.ts`
- **Steps:**
  - Zod bodies, an `Idempotency-Key` UUID, and the typed 409 bodies.
  - Create rate limits (5 per minute per phone plus a global cap).
  - `await connection()` before every read.
  - Health reports DB, Ollama reachability, model digests and index coverage.
- **Acceptance:** §5.9 contracts; AC-05, AC-06 (API level); BR-09 validation errors as 400 `VALIDATION` with `fields`.
- **Tests:** contract tests calling the route handlers directly against a temp DB.
- **Done when:** every documented status code is covered.

### T-09 Admin auth, proxy and admin APIs
- **Files:** `lib/auth/admin-session.ts`, `proxy.ts`, `app/api/admin/session/route.ts`, `app/api/admin/reservations/route.ts`, `app/api/admin/reservations/[ref]/route.ts`, tests
- **Steps (D-16):**
  - Signed cookie `{v, iat, exp, epoch}` with `timingSafeEqual` and sign-out revocation.
  - Sign-in limited to 5 per minute; `requireAdmin()` in every handler.
  - Host/Origin/Content-Type checks in the proxy.
- **Acceptance:** AC-07 (API); BR-13; S2–S12 items.
- **Tests:** tampered, expired and post-sign-out cookies; no cookie → 401; wrong Host → 403; a cross-origin POST is rejected; cancel is idempotent.
- **Done when:** green. Phase 4 exit (§8): `npm run test:unit && npm run test:unit:tz && npm run test:integration` green, including AC-04/05/06.

## Phase 5: conversational experience and frontend (fake model)

### T-10 Knowledge base and retrieval
- **Files:** `lib/kb/{facts,canonical,retrieve,index,embedder}.ts`, `scripts/kb-index.ts`, `evals/fixtures/embeddings.json`, tests
- **Steps (D-02, D-13):**
  - Fact rendering byte-compatible with the probe, including branch scope and availability; `restaurant:`, `menu-cat:` and `menu-diet:` aggregate facts.
  - The FTS5 sanitiser with stopwords and NFKC; hybrid RRF; index coverage → lexical.
  - `lastCitedIds` carry-over; the embedder interface (`ollama`, `fake`).
  - The fake replays stored real vectors. `embeddings.json` is generated once with the approved `qwen3-embedding:0.6b` by a script; if G2-M is pending, hash vectors are used.
- **Acceptance:** BR-15; AC-15 (Layer A golden top-8); AC-16 (unit).
- **Tests:** the SQ-41 raw strings never throw; golden top-8 lists for R01–R30 under the fake; a missing vector → lexical; a stale row is deleted; aggregate facts are complete.
- **Done when:** green, and the golden lists are committed.

### T-11 Model adapter, schema, fake, prompt builder, redaction
- **Files:** `lib/llm/{schema,client,fake,prompt,redact}.ts`, `docs/MODEL_ADAPTER.md`, tests
- **Steps:**
  - `TurnSchema` with the approved partySize bounds (D-06).
  - The `ModelClient` and `Embedder` interfaces, documented: inputs, raw envelope, error codes, timeouts. Exactly two implementations each (`ollama`, `fake`), with no hosted SDK.
  - The fake returns raw envelopes with the D-12 directives.
  - A pure `buildPrompt()` matching probe prompt v2, with a neutralised fence and a JSON `<history>` block.
  - Redaction: libphonenumber `/max` plus a fallback for runs of 8 or more digits, applied to every role.
- **Acceptance:** your priority 6; D-05, D-06, D-15 (fence, masking); INV-07 groundwork.
- **Tests:**
  - `JSON.stringify(z.toJSONSchema(TurnSchema))` equals the canonical fixture (ignoring `$schema`).
  - A prompt snapshot, and a static-prefix stability test (no dynamic text before the boundary).
  - Redaction cases, including typo'd and foreign numbers; fence break-out neutralised.
- **Done when:** green, and `MODEL_ADAPTER.md` is reviewed.

### T-12 Grounding, claims and hours rendering
- **Files:** `lib/chat/{grounding,claims,hours}.ts`, tests
- **Steps:**
  - D-10: hours-only answers rendered from facts; an exception supersedes the weekday's hours; weekly facts list their exceptions.
  - D-11/D-15: claim and booking-state rules, sentence-level hedging; the residual digit-run, date and number-word rules.
- **Acceptance:** AC-08 logic; INV-04, INV-05; H6.
- **Tests:**
  - The 18 claim strings from `scripts/claims-rescore.mjs`, in both directions.
  - Review cases M1 (a)–(e); HF4 and F04 outputs replayed (both must give the fallback or the rendered hours).
  - Walk-in and late-arrival FAQ text passes.
- **Done when:** green.

### T-13 Turn pipeline and `/api/chat`
- **Files:** `lib/chat/{turn,router,draft,templates,ratelimit}.ts`, `app/api/chat/route.ts`, tests
- **Steps:**
  - `runTurn(input, deps)` per the ARCHITECTURE pipeline: caps, masking, retrieval, prompt, model call, validation and retry, routing, templates.
  - Pending-confirm prose replacement; `answerable=false` → fallback; both-branch templates.
  - partySize 0 merges like null; draft merge rules.
  - The rate limiter in deps; a `chat_turns` row per turn.
- **Acceptance:** J1, J2, J5, J8, J9, J11, J12 logic; AC-09 and AC-10 (logic); D-15.
- **Tests:** unit tests for draft merge, routing per intent, templates with and without a branch, and the limiter with an injected clock; handler tests for caps (413, 400) and 429.
- **Done when:** green.

### T-14 Eval runner, invariants and D1 scripted suite
- **Files:** `evals/{run,invariants}.ts`, `evals/cases/scripted-*.jsonl`, `evals/thresholds.json`, `evals/fixtures/*`
- **Steps:**
  - The runner executes `{guest}`, `{action}`, `{submit}` and `{simulate}` turns through `runTurn` and the reservation handler on a fresh temp DB per case.
  - It supports `embedder: down | timeout` and the `retrievalMode` expectation key, and rejects unknown categories.
  - `INV-01…INV-08`, with INV-05 using an independent stricter checker. `thresholds.json` comes from §6.5 plus the D-13 retrieval floors.
- **Acceptance:** D1 = 100%; categories 5, 8, 10, 15, 16, 18, 19, 20 scripted; AC-02 via INV-01 on every case; INV-08 (verify exits non-zero on failure).
- **Tests:** `npm run eval:scripted` green; a deliberately failing case makes it exit non-zero.
- **Done when:** green.

### T-15 E2E harness and `npm run verify`
- **Files:** `playwright.config.ts`, `tests/e2e/fixtures.ts`, `app/api/__test/reset/route.ts`, `scripts/verify.ts`
- **Steps (D-12):**
  - `workers: 1`; a reset before each spec; a second low-limit server.
  - `TEST_TRACE_PATH` and captured logs; invariants checked after every spec.
  - `verify` = lint, typecheck, test:unit, test:unit:tz, test:integration, eval:scripted, build, test:e2e and the invariant report. One line per step; non-zero on any failure.
- **Acceptance:** AC-13; INV-08.
- **Tests:** a smoke spec, plus the 429 spec against the low-limit server.
- **Done when:** `npm run verify` is green on the skeleton UI.

### T-16 Guest chat UI
- **Files:** `components/chat/*`, `app/page.tsx`
- **Steps:**
  - §5.10, using the frontend-design skill where available: an identity panel from the `restaurant` and branch rows; message list, chips, slot picker, confirm card, confirmation card, info and notice blocks.
  - The pending-submit lock (D-14) and `sessionStorage` persistence.
  - Degraded and loading states; a "scripted model" badge under the fake provider.
- **Acceptance:** AC-01, AC-02 (INV-01 after every spec), AC-10, BR-12 (confirmation card built only from the save response), J3–J9, J11; accessibility rules.
- **Tests:** Playwright for J3 chips-only and typed-only (AC-01), J4, J6 (double tap, reload, lost response), J7, J9 and AC-10 fault injection; axe on every state.
- **Done when:** green under `verify`.

### T-17 Admin UI
- **Files:** `components/admin/*`, `app/admin/page.tsx`, `app/admin/login/page.tsx`
- **Steps:** a date navigator from `getNow()`, a branch filter, totals, a time-sorted table with status pills, a cancel dialog (never `window.confirm`), skeleton/empty/error states and a 30 s refresh.
- **Acceptance:** AC-07, J10, BR-13.
- **Tests:** Playwright: a chat booking appears in admin, cancel reopens the slot, sign-in throttling; axe.
- **Done when:** green. Phase 5 exit (§8): the full primary journey works through the app with the fake model, and `npm run verify` is green.

## Phase 6: local model integration (after G2-M)

### T-18 Ollama clients, `model:check` and `model:warm`
- **Files:** `lib/llm/ollama.ts`, `lib/kb/embedder-ollama.ts`, `scripts/{model-check,model-warm}.ts`
- **Steps:**
  - D-05 request settings and error mapping (404 → `MODEL_NOT_PULLED`, connection refused → `MODEL_UNAVAILABLE`, timeouts).
  - `model:check` reports version, digests, capabilities, `thinking.values`, runner and context length, a schema round-trip and remote detection.
  - `model:warm` plants the static-prefix snapshot and warms the embedder.
- **Acceptance:** §5.8; D-16 local-only.
- **Tests:** Layer A with stubbed `fetch`; live `npm run model:check` passes; 5 live smoke conversations recorded, masked.
- **Done when:** `model:check` is green and `grep` proves no hosted provider exists.

### T-19 D2 dataset and live baseline
- **Files:** `evals/cases/live-*.jsonl` (about 60+ cases over the 20 categories plus `retrieval`), `evals/results/*`
- **Steps:**
  - Add the probe regressions as `"source":"regression"` cases: B02, H05, F04, HF4, the B07/H03 claims, 150 and 0 guests.
  - Add the review cases: cheapest main, all vegan, pronoun follow-up, fence break-out, forged history.
  - Run the baseline at 3 runs in the background, under demo conditions (other dev servers closed).
- **Acceptance:** AC-08, AC-09, AC-12, AC-15 (D2).
- **Tests:** `npm run eval -- --runs 3`.
- **Done when:** the baseline is committed, and the floors are met or the misses listed for Phase 7.

## Phases 7–9

### T-20 QA and AI evaluation
- **Steps:** run every layer; fix failures with at most 2 attempts each, writing a regression case first; prompt and example work; the full D2 at 3 runs; write `docs/EVAL_REPORT.md`.
- **Acceptance:** §6.5 thresholds; G3 if any is missed.

### T-21 Independent review and hardening
- **Steps:** `/code-review` on the full diff; the `independent-reviewer` checklists (§8 Phase 8); a Phase 8 section in `docs/REVIEW.md`; fix critical and high findings and add regression tests.
- **Acceptance:** no open critical or high finding without approval.

### T-22 Final verification and delivery
- **Steps:** `npm run verify:release`; a clean-checkout run from a temp clone (AC-11; asks before writing outside the repo); demo screenshots at 390 and 1280 px; a secret and stray-file scan; `README.md`, `docs/DEMO.md`, the final report.
- **Acceptance:** AC-11, AC-14; the definition of done (§9).

## Open items that affect the plan

- `.claude/settings.json` (the §7.4 deny rules) and a git identity are still missing. Commits per task cannot happen until the identity is set, and the deny rules should be in place before Phase 4 installs.
- §8 of `MASTER_PROMPT.md` still describes a single G2. D-01 asks you to edit it so later sessions see G2-M.
- `vite@8.3.4` (D-07) is a new package needing approval, as are the two SPEC amendments: J7 (D-14) and AC-15 floors (D-13).
