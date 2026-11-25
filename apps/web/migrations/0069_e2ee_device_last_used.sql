-- The day each of an account's certified devices last read its encryption
-- keys (ADR-024 amendment 2026-11-25), so Settings › Encryption can show
-- "used 2 days ago" and offer to remove devices nobody has used in 30 days.
-- Days are UTC dates (YYYY-MM-DD), never times. `first_day` is when this
-- row started, so a browser can tell a device that was not used from one
-- that was used before the account's days were recorded at all. The Worker
-- writes a row at most once per device per day, only for a device the
-- account's current device list wraps the account key to, and drops rows
-- of devices that list no longer names.

CREATE TABLE IF NOT EXISTS e2ee_device_last_used (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 255),
  first_day TEXT NOT NULL CHECK (length(first_day) = 10),
  last_day TEXT NOT NULL CHECK (length(last_day) = 10 AND last_day >= first_day),
  PRIMARY KEY (user_id, device_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Account erasure fences every cloud write before cleanup begins. An UPSERT
-- can take either path, so both INSERT and UPDATE need their own guard.
CREATE TRIGGER IF NOT EXISTS block_erasing_device_last_used_insert
BEFORE INSERT ON e2ee_device_last_used
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_device_last_used_update
BEFORE UPDATE ON e2ee_device_last_used
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
