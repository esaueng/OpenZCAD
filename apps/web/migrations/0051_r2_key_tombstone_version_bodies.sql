-- R2 key tombstones for encrypted version bodies (follows migration 0050).
--
-- An encrypted version's body is stored under `e2ee/<project>/v/<version
-- hash>`, so a retried save of the identical envelope writes the same key.
-- A failed save's rollback that read no row naming the key, paused, and
-- then deleted it could remove the bytes of the identical retry that
-- committed meanwhile. Version bodies therefore follow migration 0050's
-- protocol too: `claimObjectKeysForDelete` treats a version row naming the
-- key as a live reference, and the guard below refuses a new version row
-- naming a key while a fresh claim holds it. Bodies written from now on
-- also carry a per-attempt nonce in their key (`…/v/<hash>.<nonce>`), and a
-- save checks its body is in R2 before its commit, so no committed row can
-- name a body another attempt's rollback removed; the claim still guards
-- the hash-only keys of older rows.
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

-- Bodies being written. A save records its body's key here before the R2
-- put; the version row that names the body clears it (trigger below). A
-- row left behind is an attempt that failed after its put and could not
-- remove its own object: project deletion, the encrypted-data drop and
-- retention delete those objects (under a claim) and then the row. A
-- per-attempt key (`…/v/<hash>.<nonce>`) can name a version only while
-- its row is still here, so a body drained as abandoned is never committed.
CREATE TABLE IF NOT EXISTS e2ee_pending_bodies (
  object_key TEXT PRIMARY KEY CHECK (length(object_key) BETWEEN 1 AND 512),
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS e2ee_pending_bodies_project
  ON e2ee_pending_bodies (project_id, created_at);

DROP TRIGGER IF EXISTS e2ee_pending_body_required;
CREATE TRIGGER e2ee_pending_body_required
BEFORE INSERT ON e2ee_project_versions
WHEN NEW.envelope_key GLOB '*/v/*.*'
  AND NOT EXISTS (
    SELECT 1 FROM e2ee_pending_bodies WHERE object_key = NEW.envelope_key
  )
BEGIN
  SELECT RAISE(ABORT, 'e2ee_body_not_pending');
END;

DROP TRIGGER IF EXISTS e2ee_pending_body_committed;
CREATE TRIGGER e2ee_pending_body_committed
AFTER INSERT ON e2ee_project_versions
WHEN NEW.envelope_key IS NOT NULL
BEGIN
  DELETE FROM e2ee_pending_bodies WHERE object_key = NEW.envelope_key;
END;
