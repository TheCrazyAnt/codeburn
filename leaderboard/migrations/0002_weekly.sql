-- CodeBurn leaderboard — "week" board (see API.md "D1 schema").
-- One row per (user, ISO week); upserted by POST /v1/report when the client
-- sends the optional week slice. `week` is the client's local calendar week
-- keyed as ISO 8601 "YYYY-Www" (e.g. 2026-W36).

CREATE TABLE IF NOT EXISTS weekly (
  user_id      INTEGER NOT NULL,
  week         TEXT    NOT NULL,                -- YYYY-Www
  usd          REAL    NOT NULL DEFAULT 0,
  tokens       INTEGER NOT NULL DEFAULT 0,
  calls        INTEGER NOT NULL DEFAULT 0,
  top_provider TEXT,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (user_id, week)
);

CREATE INDEX IF NOT EXISTS idx_weekly_week_usd ON weekly (week, usd DESC);
