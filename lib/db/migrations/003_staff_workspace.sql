-- D-25 staff workspace: menu and FAQ edits, knowledge documents and their chunks, index jobs, slot blocks and a
-- change log. Additive only: every new column has a default, so existing rows (and the facts rendered from them)
-- are unchanged. Apply with `npm run db:migrate` (also run by db:seed, db:reset, the E2E reset and the eval runner).

-- Menu: "removed from the menu" (discontinued) hides an item from guests and the chatbot; is_available stays the
-- day-to-day "unavailable" flag. created_by tells seed rows from staff-created ones; updated_at marks staff edits.
ALTER TABLE menu_items ADD COLUMN is_listed INTEGER NOT NULL DEFAULT 1 CHECK (is_listed IN (0,1));
ALTER TABLE menu_items ADD COLUMN created_by TEXT NOT NULL DEFAULT 'seed' CHECK (created_by IN ('seed','staff'));
ALTER TABLE menu_items ADD COLUMN updated_at INTEGER;

-- FAQs: a category for browsing, an active flag (inactive answers never reach the chatbot), origin and edit time.
ALTER TABLE faq_entries ADD COLUMN category TEXT NOT NULL DEFAULT 'general'
  CHECK (category IN ('bookings','food','payment','facilities','house-rules','general'));
ALTER TABLE faq_entries ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1));
ALTER TABLE faq_entries ADD COLUMN created_by TEXT NOT NULL DEFAULT 'seed' CHECK (created_by IN ('seed','staff'));
ALTER TABLE faq_entries ADD COLUMN updated_at INTEGER;
-- Categories for the FAQs already seeded (data/seed/faq.json carries the same values for new databases).
UPDATE faq_entries SET category = CASE
  WHEN slug IN ('change-or-cancel','late-arrival','sitting-time','large-groups','walk-ins','booking-window','deposit') THEN 'bookings'
  WHEN slug IN ('allergies','vegan-options','jain-food','celebration-cake','alcohol-hauz-khas','alcohol-gurugram') THEN 'food'
  WHEN slug IN ('payment','service-charge') THEN 'payment'
  WHEN slug IN ('parking-hauz-khas','parking-gurugram','accessibility-hauz-khas','accessibility-gurugram','outdoor-seating','private-dining','wifi') THEN 'facilities'
  WHEN slug IN ('children','pets','dress-code') THEN 'house-rules'
  ELSE category END;

-- Knowledge documents (RAG sources added by staff). A document is the source; kb_chunks are the passages generated
-- from it, each a retrievable fact "doc:<slug>:<seq>" in kb_fts and fact_embeddings. Only active documents whose
-- ingestion succeeded (status 'ready') contribute facts.
CREATE TABLE kb_documents (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) <= 60),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('overview','branch','hours','reservations','cancellation','menu','payment','faq','other')),
  branch_id INTEGER REFERENCES branches(id),
  source TEXT NOT NULL CHECK (source IN ('article','upload')),
  filename TEXT,
  mime TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  raw_text TEXT,            -- the decoded upload or the article as written; NULL when the file couldn't be read as text
  content TEXT,             -- the normalised text that was chunked; NULL until extraction succeeds
  content_hash TEXT,        -- sha256 of content, to refuse a second copy of the same document
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('processing','ready','failed')),
  failed_stage TEXT CHECK (failed_stage IS NULL OR failed_stage IN ('extract','normalize','chunk')),
  error TEXT,
  embed_error TEXT,         -- the last embedding failure for this document's chunks; NULL once its vectors are stored
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ingested_at INTEGER,
  CHECK (status <> 'failed' OR (failed_stage IS NOT NULL AND error IS NOT NULL))
);
CREATE TABLE kb_chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  heading TEXT,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1200),
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL CHECK (char_end > char_start),
  UNIQUE (document_id, seq)
);

-- Index jobs: one row per ingestion (extract → normalise → chunk → keyword index) and per index refresh (embedding).
CREATE TABLE kb_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ingest','refresh')),
  document_id INTEGER REFERENCES kb_documents(id) ON DELETE SET NULL,
  document_title TEXT,
  trigger TEXT NOT NULL CHECK (length(trigger) <= 40),
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  stages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(stages)),
  summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX kb_jobs_created ON kb_jobs(created_at);

-- Slot blocks: staff close one start time at a branch on a date. The availability engine skips blocked starts and
-- the booking write path refuses them (lib/booking/availability.ts), so the chatbot and the admin agree.
CREATE TABLE slot_blocks (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(date) IS date),
  time TEXT NOT NULL CHECK (time GLOB '[0-2][0-9]:[0-5][0-9]' AND time < '24:00'),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 120),
  created_at INTEGER NOT NULL,
  UNIQUE (branch_id, date, time)
);

-- What staff changed, newest last (no guest names, phones or emails: bookings are named by reference only).
CREATE TABLE admin_changes (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  area TEXT NOT NULL CHECK (area IN ('menu','faq','knowledge','hours','exceptions','blocks','tables','branches','restaurant','bookings')),
  action TEXT NOT NULL CHECK (length(action) <= 40),
  target TEXT NOT NULL CHECK (length(target) <= 120),
  summary TEXT NOT NULL CHECK (length(summary) <= 300)
);
CREATE INDEX admin_changes_at ON admin_changes(at);
