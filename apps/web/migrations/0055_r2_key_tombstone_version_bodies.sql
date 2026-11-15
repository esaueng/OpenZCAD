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
--
-- Each record names the account it is charged to (the project's owner, or
-- the creator of a project not yet created) and the object's size, so the
-- admission guard below can bound what pending objects one account holds.
CREATE TABLE IF NOT EXISTS r2_pending_objects (
  object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 512),
  attempt TEXT NOT NULL CHECK (length(attempt) BETWEEN 1 AND 64),
  project_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 256),
  object_bytes INTEGER NOT NULL CHECK (object_bytes >= 0),
  bucket TEXT NOT NULL CHECK (bucket IN ('project-storage', 'artifacts')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (object_key, attempt)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS r2_pending_objects_project
  ON r2_pending_objects (project_id, created_at);

CREATE INDEX IF NOT EXISTS r2_pending_objects_age
  ON r2_pending_objects (created_at);

-- The admission guard's per-account and per-attempt sums, read from the
-- index alone, and the owner-scoped drain.
CREATE INDEX IF NOT EXISTS r2_pending_objects_owner
  ON r2_pending_objects (owner_user_id, attempt, object_bytes);

-- Admission of a pending record, enforced in the INSERT itself so no two
-- concurrent requests can both pass:
--
-- * Refused while a cleanup holds a fresh claim on the key (migration
--   0050): that cleanup may be about to delete the key, and a writer that
--   recorded the key afterwards would put bytes the delete then removes.
--   The claim, in turn, is refused while any other attempt's record names
--   the key (`claimObjectKeysForDelete`), so a claim and a pending write
--   of one key exclude each other.
-- * Refused once one attempt's own objects would exceed the account's
--   storage allowance (`users.project_storage_limit_bytes`, 2 GiB without
--   a users row, as migration 0049): its rows could never commit.
-- * Refused once the account's pending objects would exceed that allowance
--   in bytes, or reach 2400 records (two copies of the most files one copy
--   may list), so failed writes cannot hold unbounded stored bytes outside
--   the allowance until they are reclaimed.
DROP TRIGGER IF EXISTS r2_pending_object_admission;
CREATE TRIGGER r2_pending_object_admission
BEFORE INSERT ON r2_pending_objects
BEGIN
  SELECT RAISE(ABORT, 'r2_key_deleting')
  WHERE EXISTS (
    SELECT 1 FROM r2_key_tombstones
    WHERE object_key = NEW.object_key
      AND created_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000
  );

  SELECT RAISE(ABORT, 'r2_pending_attempt_quota')
  WHERE NEW.object_bytes + COALESCE((
      SELECT SUM(object_bytes) FROM r2_pending_objects
      WHERE owner_user_id = NEW.owner_user_id AND attempt = NEW.attempt
    ), 0) > COALESCE((
      SELECT project_storage_limit_bytes FROM users WHERE id = NEW.owner_user_id
    ), 2147483648);

  SELECT RAISE(ABORT, 'r2_pending_account_limit')
  WHERE (
      SELECT COUNT(*) FROM r2_pending_objects
      WHERE owner_user_id = NEW.owner_user_id
    ) >= 2400
    OR NEW.object_bytes + COALESCE((
      SELECT SUM(object_bytes) FROM r2_pending_objects
      WHERE owner_user_id = NEW.owner_user_id
    ), 0) > COALESCE((
      SELECT project_storage_limit_bytes FROM users WHERE id = NEW.owner_user_id
    ), 2147483648);
END;

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
