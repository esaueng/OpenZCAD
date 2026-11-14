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

-- Objects being written before their rows (migration 0050's writers that
-- put bytes first): encrypted version bodies and encrypted-copy blobs. A
-- writer records each key here, under its own attempt token, before the R2
-- put; the row that then names the key clears every record of it (triggers
-- below). While another attempt's record names a key, no cleanup can claim
-- it, so a rollback never removes bytes an attempt still in flight wrote.
-- A record left behind is an attempt that failed and could not remove its
-- own object: project deletion, the encrypted-data drop, retention and the
-- scheduled sweep delete those objects (under a claim) and then the record.
-- A per-attempt version body (`…/v/<hash>.<nonce>`) can name a version only
-- while it is still recorded, so a body drained as abandoned never commits.
CREATE TABLE IF NOT EXISTS r2_pending_objects (
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512),
  attempt TEXT NOT NULL CHECK (length(attempt) BETWEEN 1 AND 64),
  project_id TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('project-storage', 'artifacts')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (object_key, attempt)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS r2_pending_objects_project
  ON r2_pending_objects (project_id, created_at);

CREATE INDEX IF NOT EXISTS r2_pending_objects_age
  ON r2_pending_objects (created_at);

DROP TRIGGER IF EXISTS r2_pending_version_body_required;
CREATE TRIGGER r2_pending_version_body_required
BEFORE INSERT ON e2ee_project_versions
WHEN NEW.envelope_key GLOB '*/v/*.*'
  AND NOT EXISTS (
    SELECT 1 FROM r2_pending_objects WHERE object_key = NEW.envelope_key
  )
BEGIN
  SELECT RAISE(ABORT, 'r2_object_not_pending');
END;

DROP TRIGGER IF EXISTS r2_pending_version_body_committed;
CREATE TRIGGER r2_pending_version_body_committed
AFTER INSERT ON e2ee_project_versions
WHEN NEW.envelope_key IS NOT NULL
BEGIN
  DELETE FROM r2_pending_objects WHERE object_key = NEW.envelope_key;
END;

DROP TRIGGER IF EXISTS r2_pending_content_blob_committed;
CREATE TRIGGER r2_pending_content_blob_committed
AFTER INSERT ON e2ee_content_blobs
BEGIN
  DELETE FROM r2_pending_objects WHERE object_key = NEW.object_key;
END;
