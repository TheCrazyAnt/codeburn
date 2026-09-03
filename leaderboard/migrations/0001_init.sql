-- CodeBurn leaderboard — initial schema (see API.md "D1 schema")

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,          -- = GitHub user id
  login           TEXT    NOT NULL,
  avatar_url      TEXT,
  lifetime_usd    REAL    NOT NULL DEFAULT 0,
  lifetime_tokens INTEGER NOT NULL DEFAULT 0,
  lifetime_calls  INTEGER NOT NULL DEFAULT 0,
  top_provider    TEXT,
  flagged         INTEGER NOT NULL DEFAULT 0,
  opt_out         INTEGER NOT NULL DEFAULT 0,
  app_version     TEXT,
  created_at      TEXT    NOT NULL,
  last_report_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,             -- SHA-256 hex of the bearer token
  user_id      INTEGER NOT NULL,
  created_at   TEXT    NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS monthly (
  user_id      INTEGER NOT NULL,
  month        TEXT    NOT NULL,                -- YYYY-MM
  usd          REAL    NOT NULL DEFAULT 0,
  tokens       INTEGER NOT NULL DEFAULT 0,
  calls        INTEGER NOT NULL DEFAULT 0,
  top_provider TEXT,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  received_at  TEXT    NOT NULL,
  month        TEXT    NOT NULL,
  month_usd    REAL    NOT NULL,
  lifetime_usd REAL    NOT NULL,
  flagged      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_monthly_month_usd   ON monthly (month, usd DESC);
CREATE INDEX IF NOT EXISTS idx_users_lifetime_usd  ON users (lifetime_usd DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_reports_user_id_id  ON reports (user_id, id);
