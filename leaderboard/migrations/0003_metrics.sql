-- CodeBurn leaderboard — metric dimension (see API.md addendum "metrics").
-- Boards can rank by spend (usd), model output tokens (output) or the user's
-- streak of consecutive active days (streak). Output tokens are stored per
-- period next to the totals; streak / active days are per-user scalars.

ALTER TABLE weekly  ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monthly ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users   ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users   ADD COLUMN streak_days   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users   ADD COLUMN active_days   INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_weekly_week_output   ON weekly  (week, output_tokens DESC);
CREATE INDEX IF NOT EXISTS idx_monthly_month_output ON monthly (month, output_tokens DESC);
CREATE INDEX IF NOT EXISTS idx_users_output_tokens  ON users   (output_tokens DESC);
CREATE INDEX IF NOT EXISTS idx_users_streak_days    ON users   (streak_days DESC);
