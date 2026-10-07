-- Per-entity cooldown after an upstream HTTP 429 (rate limit).
--
-- A 429 is transient: the entity stays 'pending' and no failed attempt is
-- counted. Without a cooldown the same (oldest) entity would be picked again
-- on the very next poll, so one throttled row could hold up the whole queue
-- and be retried forever. Each 429 records when the entity may be tried again
-- and how many 429s it has hit in a row; the worker skips rows still cooling
-- down and turns an unbroken series into a real failure past a ceiling.
--
-- Kept out of `entities` on purpose: an update there bumps updated_at, which
-- feeds recency ranking and sync, and a throttle is not a content change.
CREATE TABLE entity_rate_limit_deferrals (
  entity_id uuid NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('enrichment', 'extraction')),
  consecutive_rate_limits integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  PRIMARY KEY (entity_id, phase)
);

CREATE INDEX idx_entity_rate_limit_deferrals_next_attempt
  ON entity_rate_limit_deferrals (phase, next_attempt_at);
