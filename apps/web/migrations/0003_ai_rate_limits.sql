CREATE TABLE IF NOT EXISTS ai_rate_limits (
  user_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_rate_limits_window
  ON ai_rate_limits(window_start);
