CREATE TABLE IF NOT EXISTS ai_global_daily_usage (
  day_start INTEGER PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  cost_units INTEGER NOT NULL CHECK (cost_units >= 0)
);
