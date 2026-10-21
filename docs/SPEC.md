# Product spec: restaurant reservation chatbot

Status: approved at G1; amended at G2 (D-13, D-14) · 2026-10-19 · Sources: MASTER_PROMPT.md §4 (defaults), Phase 1 answers (2026-10-19). Items marked **(D-02)** come from that decision (approved at G1).

A guest can ask about the restaurant in their own words and book a real table in two steps. Staff can see and cancel bookings. Every confirmation maps to a saved row, and every number the bot states comes from the database.

## Users

- **Guest:** on a phone or laptop; wants a quick answer or a table without calling.
- **Staff (admin):** checks the day's bookings and cancels when a guest phones in.
- **Demo audience:** the interviewer, who may try to break the bot.

## Journeys

| ID | Journey | Must end with |
| --- | --- | --- |
| J1 | Asks hours, address or a policy, then a follow-up ("and Gurugram?") | Correct answer from stored facts; follow-up resolved from context |
| J2 | Asks about dishes, prices, dietary options | Correct items and prices from the menu table |
| J3 | Books: branch, date, party size (time optional) → sees real open times → taps one → confirm card repeats details, asks name and mobile → submits | Confirmation card with a reference, shown only after the row is saved |
| J4 | Asks for a full time | Nearest real alternatives: other times that day, the other branch, the next 2 days |
| J5 | Missing or vague details ("next Friday", "evening", "a few of us") | One clear question with chips; absolute dates on every chip |
| J6 | Double-tap, refresh, or lost network during submit | Exactly one booking; a retry shows the same booking |
| J7 | Same mobile books an overlapping time | If the name matches the existing booking: "You already have a table at 7:30 PM (ref …)". Otherwise: "This mobile already has a booking around this time. Please call {branch} on {phone}." (amended at G2, D-14) |
| J8 | Off-topic, unknown fact, prompt injection | Polite redirect, or "I don't have that" plus branch phone; nothing booked |
| J9 | Model slow, down, or returns junk | Short notice; booking still works through chips |
| J10 | Staff views a date, filters a branch, cancels a booking | List updates; slot becomes bookable again |
| J11 | Guest asks to cancel or change a booking in chat | Branch phone number (guest self-service is a non-goal) |
| J12 **(D-02)** | Asks in loose words ("something light and not spicy for my kid", "can I bring my dog?") | Relevant menu items or the right policy, retrieved and cited, with correct prices |

## Business rules

| ID | Rule | Value |
| --- | --- | --- |
| BR-01 | Restaurant | **Neem & Ember**, a fictional modern-Indian brand. Branches: Hauz Khas Village, New Delhi (`hauz-khas`) and Golf Course Road, Gurugram (`gurugram`). Time zone `Asia/Kolkata`. Fictional addresses and phone numbers |
| BR-02 | Hours | Lunch 12:00–15:30, dinner 19:00–23:00. Gurugram closed Monday lunch. A date exception replaces that date's weekly hours |
| BR-03 | Tables per branch | Two 2-tops (1–2), two 4-tops (2–4), one 6-top (4–6), one 8-top (6–8) |
| BR-04 | Sitting time | 90 min for 1–4 guests; 120 min for 5–8 |
| BR-05 | Slot grid, last seating | Every 30 min from opening; last start = close − sitting time |
| BR-06 | Lead time, horizon | No start within 60 min of now; up to 30 days ahead (branch-local dates) |
| BR-07 | Online party size | 1–8; 9+ gets the branch phone |
| BR-08 | Required to search | Branch, date, party size. Time or lunch/dinner only ranks results |
| BR-09 | Required to book | Chosen slot, name (2–80 chars), Indian mobile normalised to E.164; optional email, note ≤ 300 chars |
| BR-10 | Table choice | Smallest free table that fits |
| BR-11 | Duplicates | One mobile can't hold overlapping confirmed bookings at a branch; a retried request returns the same booking |
| BR-12 | Confirmation | Rendered only from a successful save response |
| BR-13 | Cancellation | Staff only, from admin; slot reopens immediately |
| BR-14 | Source of truth | Seed files in `data/seed/` load SQLite; the app reads only the database |
| BR-15 **(D-02)** | Retrieval | Branch, hours and exception facts are always in the prompt. Menu and FAQ facts are retrieved per turn: top 8 by hybrid lexical + semantic search. Without the embedding model, lexical only |

## Non-goals

Payments, guest accounts, SMS or email, guest self-cancel or modify, table joining, slot holds, waitlists, non-English languages, a vector-database server or extension, cloud deployment, admin editing of menu, FAQ or hours (edit seed files and reseed). Semantic retrieval itself moved into scope (D-02).

## Assumptions

- **A1** Demo date unknown, so seed exceptions use relative dates (`+5d`) and stay valid whenever the seed loads. Eval fixtures use absolute dates (§6.3).
- **A2** ~~Admin sign-in uses one shared password, `ADMIN_PASSWORD` in `.env.local`, which the user fills in (§5.9, §7.4).~~ Superseded by D-22: the staff pages have no password.
- **A3** Seed size: about 45 menu items across 6 categories and about 22 FAQ entries. That is enough that retrieval has to rank, not just return everything.
- **A4** English only, prices in whole rupees, one machine, one SQLite file on local disk.

## Source of truth

`data/seed/*.json` → SQLite (`data/app.db`) → fact snapshot with IDs (`branch:`, `hours:`, `exception:`, `menu:`, `faq:`). Embeddings are derived from those rows and keyed by content hash, so a reseed re-indexes only what changed **(D-02)**. The model never reads the database. It sees only the facts sent in its prompt.

## Acceptance criteria

| ID | Criterion | Check |
| --- | --- | --- |
| AC-01 | J3 completes with chips only, and with typed text only | Playwright, fake model |
| AC-02 | Every confirmation shown matches a saved confirmed row with the same reference | INV-01 after every E2E test and eval case |
| AC-03 | Every offered time is open per the availability engine at that moment | INV-03 |
| AC-04 | 20 simultaneous attempts on the last fitting table → exactly 1 booking, 0 server errors, 10 runs in a row | Integration test, 20 separate processes |
| AC-05 | Same idempotency key replayed → same booking, one row | Integration test |
| AC-06 | Same mobile, overlapping time → duplicate message; the existing time and reference are shown only when the name matches (D-14) | Integration test + E2E |
| AC-07 | Admin opens on today; shows name, date, time, party size, status; filters by date and branch; cancel reopens the slot | Playwright |
| AC-08 | No time, price or phone number in a shown answer that isn't in its cited facts; unknown facts get the fallback | D2 live eval + grounding checker (INV-05) |
| AC-09 | Off-topic and injection attempts create no booking and expose no admin data | D2 live eval + database assertion |
| AC-10 | Model timeout, malformed output and model-down still allow booking through chips | Playwright fault injection + D1 |
| AC-11 | A fresh clone reaches a working demo using only the README's commands | Phase 9 clean-checkout run |
| AC-12 | Warm turn latency p50/p95 measured and reported; target p95 ≤ 4 s on this Mac (M4 Pro, 24 GB) | Eval report (target, not a promise) |
| AC-13 | Lint, type check, build and all deterministic suites pass | `npm run verify` |
| AC-14 | No secrets, `.env` files, database files or guest text committed or logged | Phase 9 scan + INV-07 |
| AC-15 **(D-02, D-13)** | Retrieval returns the expected fact IDs for labelled questions. Live hybrid: hit@8 = 100% and recall@8 ≥ 0.90. Lexical-only: hit@8 ≥ 0.85 | Layer A: golden top-8 lists under the fake embedder must match exactly; D2: live floors |
| AC-16 **(D-02)** | Embedding model down or not pulled → lexical-only retrieval, answers still grounded, booking unaffected | D1 + Playwright fault injection |

## Install list for G1

Nothing below is installed until approved, except `qwen3.5:9b`, which was approved and started on 19 Oct.

| Item | Version / size | When | Why |
| --- | --- | --- | --- |
| Node upgrade (D-03) | Recommended: `brew upgrade node` → 26.12.0. Alternative: `brew install node@24` → 24.22.0 (keg-only, needs a PATH change) | Phase 2 | Vitest 5.0.5 requires `^22.12 \|\| ^24 \|\| >=26`; current 25.8.0 is excluded \[Verified: `npm view`\] |
| `qwen3.5:9b` | 7.6 GB download (library: 6.6–7.6 GB) | Pulling now | Primary chat model hypothesis |
| `qwen3.5:4b` | 4.0 GB | Installed 18 Oct | Fallback / comparison |
| `qwen3-embedding:0.6b` (D-02) | 639 MB, 32K context | Phase 2 | Embedding candidate 1 |
| `embeddinggemma:300m` (D-02) | 622 MB, 2K context | Phase 2 | Embedding candidate 2 |
| npm (Phase 4, exact pins) | `next` 16.4.2 (via `create-next-app` 16.4.2), `react`/`react-dom` 19.3.1, `typescript` **6.0.3** (D-04), `@types/node` matching the Node line, `@types/react`/`@types/react-dom` 19.3.0, `eslint` 10.13.0, `eslint-config-next` 16.4.2, `tailwindcss` + `@tailwindcss/postcss` 4.3.3, `better-sqlite3` 13.0.3, `@types/better-sqlite3` 9.6.0, `zod` 4.6.7, `date-fns` 4.4.0, `@date-fns/tz` 1.5.0, `libphonenumber-js` 1.13.15, `vitest` 5.0.5, `@playwright/test` 1.64.1, `@axe-core/playwright` 4.14.0, `tsx` 4.23.15 | Phase 4 | §5.1 stack, versions from `npm view` on 19 Oct \[Verified\]. No new package for D-02 |
| `npx playwright install chromium` | Size printed at install \[Unverified; roughly 150–300 MB\] | Phase 4 | E2E |
| Xcode CLT | Already present | Not needed | better-sqlite3 ships a darwin-arm64 prebuild \[Verified\] |
