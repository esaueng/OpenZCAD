-- Separate, expiring account-statistics permission. Existing analytics choices
-- grant nothing here. Account identity remains in OpenZCAD, never in Glimpse.
CREATE TABLE glimpse_account_consent (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE glimpse_census_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
INSERT INTO glimpse_census_clock VALUES (1, 0);
