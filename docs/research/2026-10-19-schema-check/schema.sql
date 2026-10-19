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
