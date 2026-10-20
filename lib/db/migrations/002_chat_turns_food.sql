-- D-20: chat_turns accepts the "menu" and "recommend" intents and outcomes. SQLite can't change a CHECK constraint
-- in place, so the metrics table is rebuilt and its rows copied (metrics only, no guest text, as in 001).
CREATE TABLE chat_turns_v2 (        -- metrics only: no guest text, names, phones or emails
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  intent TEXT CHECK (intent IS NULL OR intent IN ('faq','menu','recommend','booking','manage_booking','off_topic','smalltalk','unclear')),
  outcome TEXT NOT NULL CHECK (outcome IN ('faq_answer','hours_answer','faq_fallback','recommend','menu','ask_field','slots','confirm',
    'redirect','manage_redirect','smalltalk','clarify','degraded','rate_limited','action')), model TEXT,
  prompt_version TEXT, retrieval_mode TEXT CHECK (retrieval_mode IN ('hybrid','lexical','none')),
  latency_ms INTEGER, model_ms INTEGER, retrieval_ms INTEGER, prompt_tokens INTEGER, cached_tokens INTEGER,
  output_tokens INTEGER, created_at INTEGER NOT NULL
);
INSERT INTO chat_turns_v2 SELECT id, session_id, intent, outcome, model, prompt_version, retrieval_mode, latency_ms, model_ms, retrieval_ms, prompt_tokens, cached_tokens, output_tokens, created_at FROM chat_turns;
DROP TABLE chat_turns;
ALTER TABLE chat_turns_v2 RENAME TO chat_turns;
