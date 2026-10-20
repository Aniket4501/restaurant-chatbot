# Architecture

Status: approved at G2 (2026-10-19) · Implements `docs/SPEC.md`. Decisions D-01…D-16 in `docs/DECISIONS.md`. Review: `docs/REVIEW.md` (49 findings, all dispositioned). Evidence IDs refer to `docs/research/`.

One local Next.js process serves the guest chat, the admin page and the JSON APIs on `127.0.0.1`. SQLite on local disk is the only store. A local Ollama model reads each guest message and returns validated JSON: an intent, booking fields, or an FAQ answer citing fact IDs. It has no tools, no database access and no write path. Code decides availability, writes bookings, renders hours answers, and checks every number and claim the guest sees.

## Components

```text
Browser ─ guest chat (/), admin (/admin; data loaded client-side via the admin API)
   │  JSON over fetch; confirmation cards are built only from POST /api/reservations responses
   ▼
proxy.ts ─ Host/Origin/Content-Type checks on /api/* and /admin/*; admin cookie gate (D-16)
   ▼
Next.js 16.4 on 127.0.0.1 (route handlers + server components; DB opened lazily; `await connection()` before reads; one getNow())
   ├─ POST /api/chat ──► runTurn(input, deps{db, model, embedder, rateLimiter, clock})
   │                       ├─► retrieveFacts ──► SQLite FTS5 (kb_fts) + dot product over fact_embeddings
   │                       │         └─────────► Ollama /api/embed  qwen3-embedding:0.6b  (masked query only)
   │                       ├─► Ollama /api/chat  qwen3.5:9b, JSON-schema format, think:false   (no DB access)
   │                       └─► router ──► availability engine (pure) ◄── loadAvailabilityData ◄── SQLite
   ├─ GET  /api/availability ──► engine
   ├─ POST /api/reservations ──► booking service: one IMMEDIATE transaction ──► SQLite (+ overlap triggers)
   ├─ /api/admin/* ──► requireAdmin() ──► repo ──► SQLite
   └─ GET  /api/health ──► DB ping, Ollama reachability, model digests, index coverage (no secrets)
```

## Boundary

| Component | Owns | Never does |
| --- | --- | --- |
| Chat model (Ollama) | Classify intent; extract booking fields from the latest message; write short FAQ answers citing fact IDs | Read or write the DB; decide availability; confirm bookings; see guest phone or email |
| Embedder (Ollama) | Turn the masked guest message into a query vector | See phones, emails or the draft. Typed names can reach it; it is local. |
| `retrieveFacts` | Pick the 8 most relevant menu/FAQ/aggregate facts (hybrid, or lexical when the embedder or index coverage fails) | Decide what the guest is told |
| `runTurn` | Mask input, enforce caps, build the prompt, call the model, validate, route, render templates and hours answers, apply grounding and claim rules, write trace and metrics | Trust any model field without validation |
| Availability engine | Pure function: hours + exceptions + tables + bookings + `now` → open slots and alternatives | Read the clock or call the model |
| Booking service | Idempotent, transactional create; idempotent cancel | Return success unless the row is committed |
| SQLite | Single writer; STRICT reservations; triggers reject overlaps; FKs keep tables in their branch | — |
| UI | Render messages and blocks; render confirmations only from the save response; lock the form while a submit outcome is unknown | Decide availability |

## Data model

Twelve tables plus one FTS5 index (full DDL in the appendix). They are tested on SQLite 3.54.1: 30 behaviour checks in `docs/research/2026-10-19-schema-check/`. Instants are INTEGER epoch ms (UTC). Branch-local dates are `YYYY-MM-DD`, and times are zero-padded `HH:MM`. `weekday` 0 = Sunday.

Changes from §5.4:
- **Connection settings (D-08).** PRAGMAs live in `openDb()`: WAL asserted, `foreign_keys=ON`, `synchronous=FULL`, 5 s busy timeout.
- **Integrity (D-08).** Update triggers exclude `OLD.id`. A composite FK keeps each reservation's table in its branch. Time, date and boolean CHECKs are stricter.
- **Reservations (D-14).** The table is `STRICT`, with `id NOT NULL`, an E.164 phone CHECK, name and note lengths, and the `NE-` + 8 Crockford base32 ref format.
- **New tables.** `restaurant` (single row) and `app_meta` (seed anchor date) (D-13, D-14).
- **Retrieval (D-02, D-13).** `kb_fts`, plus `fact_embeddings` keyed by model digest.
- **Metrics.** `chat_turns` gains enumerated `intent`/`outcome` plus `retrieval_mode` and `retrieval_ms`.

Seed files (`data/seed/*.json`, same shape as `evals/fixtures/base.json`) are the source of truth:
- **Validation.** The loader validates them with Zod. It rejects a whole-day exception beside per-service rows, and a per-service exception set that omits a service.
- **Reseeding** is an upsert keyed on natural keys, in one IMMEDIATE transaction. Referenced tables are deactivated, never deleted. Relative dates resolve against `app_meta.seed_anchor_date`. Conflicts with confirmed future bookings abort unless accepted (D-14).
- **Indexing.** `kb:index` rebuilds `kb_fts`, re-embeds facts whose content hash changed, deletes rows for removed facts, and exits non-zero if any embed fails (D-13).

## Booking write path and guarantees

`createReservation(db, input, key, now)` asserts `!db.inTransaction`, then runs one synchronous `db.transaction(fn).immediate()`:
1. Look up the idempotency key. Same `request_hash` → 200 with the row; different → 422 `IDEMPOTENCY_MISMATCH`.
2. Re-validate with the engine's rules. Any failure → 409 `SLOT_UNAVAILABLE` `{ reason, alternatives }` (D-14).
3. Check for a guest overlap → 409 `DUPLICATE_BOOKING` `{ existing: { startsAt, label, branch, ref? } }`. Under the proposed J7 amendment, the time and ref are returned only when the submitted name matches.
4. Pick the smallest free fitting table. None → 409 `SLOT_TAKEN` `{ alternatives }`, computed after the transaction.
5. Generate the ref with an existence check (up to 5 retries), insert, and let the triggers re-check. Commit → 201 with the saved row.

**Error handling.** On any `SQLITE_CONSTRAINT*` error, the code repeats step 1 after rollback before mapping `TABLE_OVERLAP`/`GUEST_OVERLAP`, because BEFORE INSERT triggers fire before UNIQUE checks (SQ-24). `SQLITE_BUSY*` → 503 "nothing was booked". Anything else → 500, never a confirmation. Creates are rate-limited: 5 per minute per phone, plus a global cap.

**The client** stores `{key, body}` before POSTing. While the outcome is unknown it locks the ConfirmCard and offers only "Retry" (same key) or "Start over", which replays the key first. It clears the entry on any 2xx, on 4xx, on 503, or when the slot or draft changes (D-14).

**Guarantees:**
- **G-1:** no two confirmed bookings overlap on a table.
- **G-2:** one key creates at most one booking.
- **G-3:** a confirmation is shown only after commit.
- **G-4:** one mobile can't hold overlapping bookings at a branch.

Phase 2 reproduced the race design: 20 processes → 1 created and 19 `SLOT_TAKEN`, 10 of 10 runs (SQ-60). **Limits:** one database file on one machine's local disk; multi-host deployment would need Postgres with an exclusion constraint.

## Chat turn pipeline

`runTurn` is the single entry point for `POST /api/chat` and the eval runner:
1. **Validate the body (D-15):** at most 8 messages, roles `guest | assistant`, guest content ≤ 500 characters and assistant content ≤ 600, body ≤ 16 KB, strict draft. Rate limits come from `deps` (IP-keyed in the route, no-op in evals).
2. **Chip or slot actions** are handled deterministically, with no model call.
3. **Mask every string** once, whatever its role: phones (libphonenumber `/max` plus a fallback for runs of 8 or more digits) and emails. Neutralise `<` and `>`.
4. **Retrieve.** `retrieveFacts(masked latest + previous guest turn)` → top 8, plus `context.lastCitedIds` from the previous turn (D-13).
5. **Build the prompt.** The static system part comes first, byte-identical for the day: rules, schema, branch list, restaurant/branch/hours/exception facts, compact JSON examples, the 31-day calendar. The dynamic user part follows: time, retrieved facts, the draft (no PII), the history as one JSON `<history>` block, then `<guest_message>`. A character budget is checked before the call.
6. **Call `/api/chat`** with the D-05 settings: `think: false`, `truncate: false`, `temperature 0`, `num_ctx 8192`, `num_predict 400`, Modelfile sampling otherwise.
7. **Validate** with Zod. Invalid output, `done_reason: "length"`, empty content, thinking, or a 600-character answer → one corrective retry, then the degraded reply with chips.
8. **Route by intent (§5.7):**
   - FAQ answers citing only branch/hours/exception facts are rendered from those facts, and an exception supersedes that weekday's hours (D-10).
   - `answerable=false` → fixed fallback (D-15).
   - Booking turns show templates only.
9. **Check every shown model sentence** with the grounding rules (D-15: times, prices, phones, other digit runs, dates, number words) and the claim rules (D-11/D-15: confirmation and availability patterns, booking-state words). Any failure → fixed fallback. While a confirm card is pending, prose is replaced with "Your table isn't booked yet. Tap Confirm to finish." With no single known branch, templates list both branches' phones.
10. **Write the `chat_turns` metrics row**, and the test trace in test mode.

## Retrieval (D-02, D-13)

**Index.** One entry per menu item, FAQ, and aggregate fact (`menu-cat:<category>` price-sorted lists, `menu-diet:<tag>` lists). Index text is the rendered fact line, including branch scope ("Golf Course Road only.") and availability ("Currently unavailable."). Aggregates are indexed by a one-sentence description instead, and at most 2 are retrieved per turn (D-13 T-10 amendment, approved 2026-10-20). `applySeed` rebuilds `kb_fts`; `kb:index` adds the embeddings.

**Search.**
- **Lexical:** FTS5 with the tested sanitiser (NFKC, stopwords removed, quoted OR terms, at most 16), ordered by `bm25`.
- **Semantic:** 1024-dim normalised `qwen3-embedding:0.6b` vectors. Documents are embedded raw; queries as `Instruct: <task>\nQuery:<text>`.
- **Fusion:** reciprocal-rank fusion (k = 60), top 8.

**Lexical mode** is used when the embedder fails or times out, or when any current fact lacks an embedding for the configured digest and content hash. The reason is recorded in the trace and `chat_turns`.

**Measured** (30 labelled queries): hybrid hit@8 100% and recall@8 0.947; lexical 0.867 and 0.828.

## API

The §5.9 endpoints, plus D-14's typed 409 bodies (`SLOT_TAKEN`, `SLOT_UNAVAILABLE`, `DUPLICATE_BOOKING`) and a test-only `POST /api/__test/reset`, which returns 404 unless `E2E_TEST_MODE=1`. All bodies are Zod-validated. Errors use `{ error: { code, message, fields? } }`, with the typed extras above.

## Failure handling

| Failure | Detected by | Guest sees | State |
| --- | --- | --- | --- |
| Ollama down / model not pulled | connection refused / HTTP 404 | Degraded notice + chips | Unchanged |
| Model timeout (15 s) or invalid output twice | AbortController / Zod + D-05 checks | Degraded notice + chips | Draft unchanged |
| Answer ungrounded, truncated, claims a booking, or marked unanswerable | grounding and claim rules, 600-char check, `answerable` | Fixed fallback with branch phone(s) | — |
| Embedder down or slow, or index incomplete | error / timeout / coverage check | Nothing visible (lexical retrieval) | `retrieval_mode=lexical` |
| Prompt over budget | pre-call estimate, then `prompt_eval_count` | One retry with trimmed history, then degraded + chips | `CONTEXT_TOO_LARGE` metric |
| Slot taken, rule failed, or duplicate guest at submit | IMMEDIATE txn checks, triggers | Fresh alternatives / the existing booking (or a generic message) | No row |
| Busy DB beyond 5 s | `SQLITE_BUSY*` | "Nothing was booked", retry | No row |
| Response lost after commit | client replays the same key; form locked meanwhile | The same booking (200) | One row |

## Security and privacy boundaries

- **Network:** the server binds `127.0.0.1` only. `proxy.ts` checks Host, Origin and Content-Type. `OLLAMA_BASE_URL` must be a loopback http URL, and cloud model names are rejected. `NEXT_TELEMETRY_DISABLED=1` is set in every script. No hosted provider exists in code (H1, H2, D-16).
- **Admin:** `ADMIN_PASSWORD` (≥ 12 characters) and a separate `ADMIN_SESSION_SECRET` (≥ 32 bytes) are validated at startup; without them admin returns 503. The cookie holds an HMAC-SHA256-signed `{iat, exp, epoch}` payload, is httpOnly and SameSite=Strict, lasts 8 h, and is checked with `timingSafeEqual`. Sign-out revokes it. Sign-in allows 5 attempts per minute. `requireAdmin()` runs in every admin handler and on the admin page, and admin uses no Server Actions.
- **Model containment:** guest and history text are data (neutralised fence, JSON history). The model has no tools, and its output is schema-validated. Booking turns are templated, hours answers are rendered from facts, and grounding and claim rules run on all other prose. Injection, forged-history and forged-draft cases run in the evals.
- **PII:** phones and emails are masked in every message before retrieval and the prompt. Guest text, names, phones and emails never enter `chat_turns` or logs. Guest data lives only in `reservations`, readable through admin. `DUPLICATE_BOOKING` reveals another booking's time and ref only on a name match (proposed J7 amendment).
- **Abuse limits:** 20 turns per minute per session and per socket address (global on loopback, documented). Bounded limiter state. 5 creates per minute per phone plus a global cap. One model call in flight at a time, with a small queue.
- **Rendering:** React escapes all text; model text is never rendered as HTML.

## Testability (D-12)

- **Test mode:** `E2E_TEST_MODE=1` requires `LLM_PROVIDER=fake`, `EMBED_PROVIDER=fake`, and a temp `DATABASE_PATH` that is not `data/app.db`; otherwise every test hook is ignored.
- **Fakes:** the fake model returns raw envelopes with fault directives (down, not_pulled, timeout, invalid, length, thinking, empty, context, claim). The fake embedder replays stored real vectors and supports down/timeout directives.
- **Clock and isolation:** one `getNow()` honours `NOW_OVERRIDE`. Playwright runs `workers: 1`, with a reset route before each spec and a second low-limit server for the 429 specs.
- **Traces:** in test mode each turn writes its blocks, citations, trace and masked prompt to `TEST_TRACE_PATH`, and server logs are captured, so INV-01…INV-08 can be checked after every E2E test.

## Model and runtime

`qwen3.5:9b` (digest `d63f830f28d5…`) with prompt v2 and the retrieval layout. It meets the selection floors (intent 100%, extraction 88.9%, schema 100%, warm p95 3.79 s), with details and caveats in `docs/MODEL_SELECTION.md` (approved at G2-M per D-01). Runtime: Node 26.12.0, Ollama 0.40.5 (MLX runner for qwen3.5, llama.cpp for the embedder), 24 GB unified memory.

## Appendix: schema

Proposed DDL: MASTER_PROMPT §5.4 + D-08 + D-02 + review fixes (D-13, D-14, D-15). This is the exact file `docs/research/2026-10-19-schema-check/schema.sql`. It is applied with `foreign_keys=ON` on SQLite 3.54.1 (Node 26 `node:sqlite`), and `check-behaviour.mjs` (19 checks) and `check-review-fixes.mjs` (11 checks) pass. The Phase 4 better-sqlite3 tests (bundled SQLite 3.53.4) are the gate.

```sql
-- Proposed schema: MASTER_PROMPT §5.4 + D-08 hardening + D-02 retrieval tables + Phase 2 review fixes (D-13, D-14, D-15).
-- Connection setup lives in openDb(), not here: timeout 5000, journal_mode=WAL (asserted), foreign_keys=ON, synchronous=FULL.
CREATE TABLE restaurant (           -- single row; name and cuisine for the prompt role line, identity panel and restaurant: fact (D-13)
  id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, cuisine TEXT NOT NULL, about TEXT NOT NULL
);
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- seed_anchor_date, seed_version (D-14 reseed)
CREATE TABLE branches (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  address TEXT NOT NULL, phone TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
CREATE TABLE service_hours (
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  service TEXT NOT NULL CHECK (service IN ('lunch','dinner')),
  opens TEXT NOT NULL CHECK (opens GLOB '[0-2][0-9]:[0-5][0-9]' AND opens < '24:00'),
  closes TEXT NOT NULL CHECK (closes GLOB '[0-2][0-9]:[0-5][0-9]' AND closes <= '24:00'),
  CHECK (closes > opens),
  PRIMARY KEY (branch_id, weekday, service)
);
-- Any exception row for a date replaces ALL weekly rows for that date. service NULL = whole day (closure only).
-- Loader rules (D-08): no whole-day row beside per-service rows; per-service rows must list both services.
CREATE TABLE hours_exceptions (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date) IS date),
  service TEXT CHECK (service IN ('lunch','dinner')),
  is_closed INTEGER NOT NULL CHECK (is_closed IN (0,1)),
  opens TEXT CHECK (opens IS NULL OR (opens GLOB '[0-2][0-9]:[0-5][0-9]' AND opens < '24:00')),
  closes TEXT CHECK (closes IS NULL OR (closes GLOB '[0-2][0-9]:[0-5][0-9]' AND closes <= '24:00')),
  note TEXT,
  CHECK (is_closed = 1 OR (opens IS NOT NULL AND closes IS NOT NULL AND closes > opens)),
  CHECK (service IS NOT NULL OR is_closed = 1)
);
CREATE UNIQUE INDEX hours_exc_service ON hours_exceptions(branch_id, date, service) WHERE service IS NOT NULL;
CREATE UNIQUE INDEX hours_exc_day ON hours_exceptions(branch_id, date) WHERE service IS NULL;
CREATE TABLE dining_tables (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id), label TEXT NOT NULL,
  min_seats INTEGER NOT NULL CHECK (min_seats >= 1), max_seats INTEGER NOT NULL CHECK (max_seats >= min_seats),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  UNIQUE (branch_id, label), UNIQUE (branch_id, id)
);
-- STRICT: a TEXT timestamp or NULL id would otherwise silently disable the overlap triggers (D-14).
CREATE TABLE reservations (
  id TEXT NOT NULL PRIMARY KEY, ref TEXT NOT NULL UNIQUE CHECK (ref GLOB 'NE-[0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z][0-9A-HJKMNP-TV-Z]'),
  branch_id INTEGER NOT NULL REFERENCES branches(id), table_id INTEGER NOT NULL,
  guest_name TEXT NOT NULL CHECK (length(guest_name) BETWEEN 2 AND 80),
  phone_e164 TEXT NOT NULL CHECK (phone_e164 GLOB '+91[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  email TEXT, note TEXT CHECK (note IS NULL OR length(note) <= 300),
  party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 8),
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  source TEXT NOT NULL DEFAULT 'chat', idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, cancelled_at INTEGER,
  FOREIGN KEY (branch_id, table_id) REFERENCES dining_tables(branch_id, id)
) STRICT;
CREATE INDEX reservations_branch_start ON reservations(branch_id, starts_at);
-- Defense in depth: the database rejects overlaps even if a code path skips the check.
CREATE TRIGGER no_table_overlap_ins BEFORE INSERT ON reservations WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'TABLE_OVERLAP') WHERE EXISTS (
    SELECT 1 FROM reservations r WHERE r.table_id = NEW.table_id AND r.status = 'confirmed'
      AND r.starts_at < NEW.ends_at AND NEW.starts_at < r.ends_at);
END;
CREATE TRIGGER no_guest_overlap_ins BEFORE INSERT ON reservations WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'GUEST_OVERLAP') WHERE EXISTS (
    SELECT 1 FROM reservations r WHERE r.branch_id = NEW.branch_id AND r.phone_e164 = NEW.phone_e164
      AND r.status = 'confirmed' AND r.starts_at < NEW.ends_at AND NEW.starts_at < r.ends_at);
END;
-- Update companions exclude the row being updated by OLD.id (D-08). Row-level triggers see a half-updated
-- table during multi-row UPDATEs; the app never bulk-shifts bookings.
CREATE TRIGGER no_table_overlap_upd BEFORE UPDATE ON reservations WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'TABLE_OVERLAP') WHERE EXISTS (
    SELECT 1 FROM reservations r WHERE r.id <> OLD.id AND r.table_id = NEW.table_id AND r.status = 'confirmed'
      AND r.starts_at < NEW.ends_at AND NEW.starts_at < r.ends_at);
END;
CREATE TRIGGER no_guest_overlap_upd BEFORE UPDATE ON reservations WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'GUEST_OVERLAP') WHERE EXISTS (
    SELECT 1 FROM reservations r WHERE r.id <> OLD.id AND r.branch_id = NEW.branch_id AND r.phone_e164 = NEW.phone_e164
      AND r.status = 'confirmed' AND r.starts_at < NEW.ends_at AND NEW.starts_at < r.ends_at);
END;
CREATE TABLE menu_items (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, category TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL, price_inr INTEGER NOT NULL CHECK (price_inr > 0),
  dietary TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dietary)), spice_level INTEGER CHECK (spice_level BETWEEN 0 AND 3),
  branch_slugs TEXT CHECK (branch_slugs IS NULL OR json_valid(branch_slugs)),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0,1))
);
CREATE TABLE faq_entries (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, question TEXT NOT NULL, answer TEXT NOT NULL,
  branch_id INTEGER REFERENCES branches(id)
);
-- D-02 retrieval. kb_fts is rebuilt from menu_items/faq_entries inside the kb:index transaction.
CREATE VIRTUAL TABLE kb_fts USING fts5(fact_id UNINDEXED, body, tokenize = 'porter unicode61 remove_diacritics 2');
-- Keyed by model digest (from /api/tags), not tag name; hybrid mode requires a row with the current content_hash
-- for every current menu/FAQ fact, else retrieval reports lexical (D-13).
CREATE TABLE fact_embeddings (
  fact_id TEXT NOT NULL, model TEXT NOT NULL, model_digest TEXT NOT NULL, content_hash TEXT NOT NULL,
  dim INTEGER NOT NULL CHECK (dim > 0), vector BLOB NOT NULL CHECK (length(vector) = dim * 4),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (fact_id, model_digest)
);
CREATE TABLE chat_turns (           -- metrics only: no guest text, names, phones or emails
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  intent TEXT CHECK (intent IS NULL OR intent IN ('faq','booking','manage_booking','off_topic','smalltalk','unclear')),
  outcome TEXT NOT NULL CHECK (outcome IN ('faq_answer','hours_answer','faq_fallback','ask_field','slots','confirm',
    'redirect','manage_redirect','smalltalk','clarify','degraded','rate_limited','action')), model TEXT,
  prompt_version TEXT, retrieval_mode TEXT CHECK (retrieval_mode IN ('hybrid','lexical','none')),
  latency_ms INTEGER, model_ms INTEGER, retrieval_ms INTEGER, prompt_tokens INTEGER, cached_tokens INTEGER,
  output_tokens INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
```
