-- R2 key tombstones for encrypted version bodies (follows migration 0050).
--
-- An encrypted version's body is stored under `e2ee/<project>/v/<version
-- hash>`, so a retried save of the identical envelope writes the same key.
-- A failed save's rollback that read no row naming the key, paused, and
-- then deleted it could remove the bytes of the identical retry that
-- committed meanwhile. Version bodies therefore follow migration 0050's
-- protocol too: `claimObjectKeysForDelete` treats a version row naming the
-- key as a live reference, and the guard below refuses a new version row
-- naming a key while a fresh claim holds it. A body reaches R2 before its
-- row, so a save checks after its commit that its body is still there and
-- stores it again if not, exactly as a source asset does.
--
-- Version rows never take a new body key once inserted (migration 0033's
-- immutability trigger only lets a body be cleared), so the insert guard is
-- the only one needed. The partial index serves the claim's reference
-- check and the guard's lookups by key.
CREATE INDEX IF NOT EXISTS e2ee_project_versions_envelope_key
  ON e2ee_project_versions (envelope_key)
  WHERE envelope_key IS NOT NULL;

DROP TRIGGER IF EXISTS r2_key_tombstone_version_body_guard;
CREATE TRIGGER r2_key_tombstone_version_body_guard
BEFORE INSERT ON e2ee_project_versions
WHEN NEW.envelope_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'r2_key_deleting')
  WHERE EXISTS (
    SELECT 1 FROM r2_key_tombstones
    WHERE object_key = NEW.envelope_key
      AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000
  );
END;
