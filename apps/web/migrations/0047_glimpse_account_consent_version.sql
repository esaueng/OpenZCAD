-- Version of the account-statistics permission text each grant accepted.
-- Version 3 adds save-activity counts (Glimpse privacy review, 13 Nov 2026).
-- Existing grants accepted the version 2 text, which named account, project,
-- revision and storage totals only: they keep covering those totals until
-- they expire, and are never counted in save activity.
ALTER TABLE glimpse_account_consent
  ADD COLUMN version INTEGER NOT NULL DEFAULT 2 CHECK (version >= 2);
