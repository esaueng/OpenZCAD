ALTER TABLE ai_rate_limits
  ADD COLUMN cost_units INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ai_concurrency_leases (
  lease_id TEXT PRIMARY KEY,
  account_bucket TEXT NOT NULL,
  ip_bucket TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_concurrency_account
  ON ai_concurrency_leases(account_bucket, expires_at);

CREATE INDEX IF NOT EXISTS idx_ai_concurrency_ip
  ON ai_concurrency_leases(ip_bucket, expires_at);

CREATE INDEX IF NOT EXISTS idx_ai_concurrency_expiry
  ON ai_concurrency_leases(expires_at);
