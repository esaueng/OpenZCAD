-- ADR-024 Phase 7, slice 7-1 (roadmap L11): moving an existing plaintext
-- project to encrypted storage. One row per project records the move: its
-- direction, where it stands, whose browser drives it under which lease,
-- the staged head, and how far the purge of the plaintext has come. The
-- server never transforms content: the owner's browser encrypts every
-- retained revision and file, the Worker stores the ciphertext beside the
-- plaintext ("staging"), flips the storage format in one batch ("cutover"),
-- and then deletes the plaintext a bounded step at a time ("purging").
-- The routes stay closed behind E2EE_MIGRATION_ENABLED.
-- Ordinary traffic does not depend on this migration: until it is applied,
-- no statement outside the migration routes names this table (they probe
-- for it first), the plaintext routes never refuse as migrating, and those
-- routes answer 503.

-- direction: `encrypt` (format 1 to 2); `decrypt` is reserved for the
-- beta-only reverse path (slice 7-3) and refused until then.
-- state: `staging` (plaintext reads keep working, plaintext writes, named
-- saves and the room refuse with 409 PROJECT_MIGRATING, and the lease
-- holder writes ciphertext beside the plaintext), `cutover` (the format
-- flipped; nothing purged yet), `purging`, `done`, or `abandoned` (the
-- staged ciphertext is dropped and the plaintext unlocked). `abandoned` and
-- `done` may start over as `staging` once nothing staged remains.
-- lease_id is a random 32-byte base64url token the start route hands the
-- owner's browser; lease_expires_at is in milliseconds since the epoch.
-- source_version and source_measurement_revision are the plaintext heads
-- when staging began: a cutover refuses if either moved. staged_version and
-- staged_hash are the staged head (document version and the Worker's
-- version hash); revision_count, blob_count and blob_bytes are what the
-- cutover found; purge_cursor names the next purge step (or `cleanup`
-- while an abandoned staging still has rows or objects to drop);
-- purged_rows and purged_objects count what the purge removed.
CREATE TABLE e2ee_project_migrations (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('encrypt', 'decrypt')),
  state TEXT NOT NULL
    CHECK (state IN ('staging', 'cutover', 'purging', 'done', 'abandoned')),
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT CHECK (device_id IS NULL OR length(device_id) BETWEEN 1 AND 128),
  lease_id TEXT CHECK (lease_id IS NULL OR length(lease_id) = 43),
  lease_expires_at INTEGER
    CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_measurement_revision INTEGER NOT NULL DEFAULT 0
    CHECK (source_measurement_revision >= 0),
  staged_version INTEGER NOT NULL DEFAULT 0 CHECK (staged_version >= 0),
  staged_hash TEXT CHECK (staged_hash IS NULL OR length(staged_hash) = 64),
  revision_count INTEGER NOT NULL DEFAULT 0 CHECK (revision_count >= 0),
  blob_count INTEGER NOT NULL DEFAULT 0 CHECK (blob_count >= 0),
  blob_bytes INTEGER NOT NULL DEFAULT 0 CHECK (blob_bytes >= 0),
  purge_cursor TEXT CHECK (purge_cursor IS NULL OR length(purge_cursor) <= 32),
  purged_rows INTEGER NOT NULL DEFAULT 0 CHECK (purged_rows >= 0),
  purged_objects INTEGER NOT NULL DEFAULT 0 CHECK (purged_objects >= 0),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cutover_at TEXT,
  finished_at TEXT,
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS e2ee_project_migrations_owner
  ON e2ee_project_migrations (owner_user_id, state);
CREATE INDEX IF NOT EXISTS e2ee_project_migrations_sweep
  ON e2ee_project_migrations (state, updated_at);

-- The state only moves along the machine above, whoever writes, and a row
-- never changes project, owner or direction (a new direction starts a new
-- row once the old one is done).
CREATE TRIGGER IF NOT EXISTS e2ee_project_migration_forward
BEFORE UPDATE ON e2ee_project_migrations
WHEN NEW.project_id <> OLD.project_id
  OR NEW.owner_user_id <> OLD.owner_user_id
  OR (NEW.direction <> OLD.direction
      AND NOT (OLD.state IN ('done', 'abandoned') AND NEW.state = 'staging'))
  OR (NEW.state <> OLD.state AND NOT (
    (OLD.state = 'staging' AND NEW.state IN ('cutover', 'abandoned'))
    OR (OLD.state = 'cutover' AND NEW.state = 'purging')
    OR (OLD.state = 'purging' AND NEW.state = 'done')
    OR (OLD.state IN ('done', 'abandoned') AND NEW.state = 'staging')))
BEGIN
  SELECT RAISE(ABORT, 'E2EE_MIGRATION_STATE');
END;

-- Writes also carry the session/erasure predicate in their own SQL; these
-- fences hold for any other writer as well. Profile erasure itself only
-- forgets the device and lease (abandoning a staging it can no longer
-- finish), so only that move is let through.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_migration_insert
BEFORE INSERT ON e2ee_project_migrations
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_migration_update
BEFORE UPDATE ON e2ee_project_migrations
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.owner_user_id, NEW.owner_user_id)
) AND NOT (
  NEW.device_id IS NULL AND NEW.lease_id IS NULL
  AND NEW.staged_version = OLD.staged_version
  AND NEW.purged_rows = OLD.purged_rows
  AND NEW.purged_objects = OLD.purged_objects
  AND (NEW.state = OLD.state
       OR (OLD.state = 'staging' AND NEW.state = 'abandoned'))
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

-- Decision M10: staged ciphertext does not count toward quota until the
-- cutover. A plaintext project (format 1) holds encrypted rows only while
-- it is staged, so these replacements of migration 0033's and 0034's
-- accounting skip format-1 projects and count only format-2 ones. Before
-- this migration every encrypted row belongs to a format-2 project, so the
-- answers are unchanged; the cutover adds the staged blobs' bytes to the
-- owner's artifact usage in its own batch.
DROP TRIGGER IF EXISTS e2ee_project_version_quota;
CREATE TRIGGER e2ee_project_version_quota
BEFORE INSERT ON e2ee_project_versions
WHEN (SELECT storage_format FROM projects WHERE id = NEW.project_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.envelope_bytes +
    COALESCE((
      SELECT SUM(versions.envelope_bytes)
      FROM e2ee_project_versions versions
      JOIN projects owner ON owner.id = versions.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND owner.storage_format = 2
        AND (versions.envelope_key IS NOT NULL
             OR versions.envelope_inline IS NOT NULL)
    ), 0) +
    COALESCE((
      SELECT SUM(objects.stored_bytes)
      FROM project_document_objects objects
      JOIN projects owner ON owner.id = objects.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) +
    COALESCE((
      SELECT SUM(assets.stored_bytes)
      FROM project_storage_assets assets
      JOIN projects owner ON owner.id = assets.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > COALESCE((
      SELECT project_storage_limit_bytes FROM users
      WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 2147483648);
END;

DROP TRIGGER IF EXISTS e2ee_content_blob_usage_before_insert;
CREATE TRIGGER e2ee_content_blob_usage_before_insert
BEFORE INSERT ON e2ee_content_blobs
WHEN (SELECT storage_format FROM projects WHERE id = NEW.project_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'artifact_project_owner_missing')
  WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);

  INSERT OR IGNORE INTO artifact_account_usage (
    owner_user_id, finalized_bytes, reserved_bytes, active_sessions
  )
  SELECT user_id, 0, 0, 0 FROM projects WHERE id = NEW.project_id;

  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE (
      SELECT usage.finalized_bytes + usage.reserved_bytes
        + NEW.ciphertext_bytes
        - COALESCE((
            SELECT sessions.reserved_bytes
            FROM upload_sessions sessions
            WHERE sessions.artifact_id = NEW.blob_id
              AND sessions.project_id = NEW.project_id
              AND sessions.reservation_state = 'completed'
              AND sessions.reserved_bytes = NEW.ciphertext_bytes
          ), 0)
      FROM artifact_account_usage usage
      JOIN projects ON projects.user_id = usage.owner_user_id
      WHERE projects.id = NEW.project_id
    ) > COALESCE((SELECT artifact_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    AND NEW.ciphertext_bytes > COALESCE((
      SELECT reserved_bytes FROM upload_sessions
      WHERE artifact_id = NEW.blob_id AND project_id = NEW.project_id
        AND reservation_state = 'completed'
        AND reserved_bytes = NEW.ciphertext_bytes
    ), 0);
END;

DROP TRIGGER IF EXISTS e2ee_content_blob_usage_after_insert;
CREATE TRIGGER e2ee_content_blob_usage_after_insert
AFTER INSERT ON e2ee_content_blobs
WHEN (SELECT storage_format FROM projects WHERE id = NEW.project_id) IS NOT 1
BEGIN
  UPDATE artifact_account_usage
  SET finalized_bytes = finalized_bytes + NEW.ciphertext_bytes
  WHERE owner_user_id = (
    SELECT user_id FROM projects WHERE id = NEW.project_id
  );
END;

DROP TRIGGER IF EXISTS e2ee_content_blob_usage_after_delete;
CREATE TRIGGER e2ee_content_blob_usage_after_delete
AFTER DELETE ON e2ee_content_blobs
WHEN (SELECT storage_format FROM projects WHERE id = OLD.project_id) IS NOT 1
BEGIN
  UPDATE artifact_account_usage
  SET finalized_bytes = finalized_bytes - OLD.ciphertext_bytes
  WHERE owner_user_id = (
    SELECT user_id FROM projects WHERE id = OLD.project_id
  );
END;
