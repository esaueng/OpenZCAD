-- The identities an account's devices pinned for other people on first use
-- (ADR-024 amendment 2026-11-25, trust on first use for invitations). One
-- record per account, sealed under the account key in the browser: the
-- Worker stores it opaque. Browsers merge their copies and write the result
-- back with compare-and-set on `revision`; `sequence` is the sealed
-- record's own, copied from its header, so a write can never lower it.

CREATE TABLE IF NOT EXISTS e2ee_first_use_pins (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  sequence INTEGER NOT NULL CHECK (sequence >= 1 AND sequence <= 4294967295),
  record TEXT NOT NULL CHECK (length(record) <= 131072),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Account erasure fences every cloud write before cleanup begins. An UPSERT
-- can take either path, so both INSERT and UPDATE need their own guard.
CREATE TRIGGER IF NOT EXISTS block_erasing_first_use_pins_insert
BEFORE INSERT ON e2ee_first_use_pins
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_first_use_pins_update
BEFORE UPDATE ON e2ee_first_use_pins
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
