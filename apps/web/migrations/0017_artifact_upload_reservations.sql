-- Durable account accounting for unfinished artifact uploads.
--
-- Roll forward:
--   * finalized bytes are backfilled from the existing artifacts table;
--   * every pre-migration upload session is marked `legacy`, refused by the
--     Worker, forced expired for the old Worker, and selected by cleanup;
--   * valid legacy multipart ids are copied out of metadata_json so cleanup
--     can abort their R2 state without trusting application metadata.
--
-- Rollback:
--   D1 migrations have no automatic down path. Restore the pre-migration Time
--   Travel bookmark before rolling the Worker back. If only the Worker is
--   rolled back, the insert trigger below refuses its unaccounted upload
--   sessions because the older code does not supply owner_user_id. Uploads
--   therefore fail closed while unrelated project data remains readable.

-- Do not guess through legacy corruption. These guards abort the migration,
-- which leaves the previous schema and Worker as the only runnable pair.
CREATE TABLE artifact_upload_migration_guard_0017 (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO artifact_upload_migration_guard_0017 (valid)
SELECT 0
WHERE EXISTS (
  SELECT 1 FROM upload_sessions WHERE NOT json_valid(metadata_json)
);

INSERT INTO artifact_upload_migration_guard_0017 (valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM upload_sessions
  WHERE json_valid(metadata_json)
    AND json_type(metadata_json, '$') <> 'object'
);

INSERT INTO artifact_upload_migration_guard_0017 (valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM upload_sessions
  WHERE json_valid(metadata_json)
    AND json_type(metadata_json, '$.__openzcadMultipartUploadId') IS NOT NULL
    AND (
      json_type(metadata_json, '$.__openzcadMultipartUploadId') <> 'text'
      OR length(json_extract(metadata_json, '$.__openzcadMultipartUploadId')) = 0
    )
);

INSERT INTO artifact_upload_migration_guard_0017 (valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM upload_sessions uploads
  LEFT JOIN projects ON projects.id = uploads.project_id
  WHERE projects.user_id IS NULL OR length(projects.user_id) = 0
);

-- NULL artifact sizes are the documented legacy value and continue to count
-- as zero. Any other non-integer or negative value is corrupt quota state.
INSERT INTO artifact_upload_migration_guard_0017 (valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM artifacts
  WHERE bytes IS NOT NULL
    AND (typeof(bytes) <> 'integer' OR bytes < 0)
);

DROP TABLE artifact_upload_migration_guard_0017;

ALTER TABLE upload_sessions ADD COLUMN owner_user_id TEXT;
ALTER TABLE upload_sessions ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0
  CHECK (reserved_bytes >= 0);
ALTER TABLE upload_sessions ADD COLUMN reservation_state TEXT NOT NULL DEFAULT 'legacy'
  CHECK (reservation_state IN (
    'legacy', 'open', 'uploading', 'completing', 'completed', 'aborting'
  ));
ALTER TABLE upload_sessions ADD COLUMN multipart_upload_id TEXT;
ALTER TABLE upload_sessions ADD COLUMN completion_started_at INTEGER
  CHECK (completion_started_at IS NULL OR completion_started_at >= 0);

UPDATE upload_sessions
SET owner_user_id = (
      SELECT projects.user_id
      FROM projects
      WHERE projects.id = upload_sessions.project_id
    ),
    multipart_upload_id = CASE
      WHEN json_type(metadata_json, '$.__openzcadMultipartUploadId') = 'text'
      THEN json_extract(metadata_json, '$.__openzcadMultipartUploadId')
      ELSE NULL
    END,
    metadata_json = json_remove(
      metadata_json,
      '$.__openzcadMultipartUploadId'
    ),
    expires_at = '1970-01-01T00:00:00.000Z';

-- Account erasure fences ordinary upload mutations before deleting project
-- objects. Reservation cleanup must remain possible while that fence is held,
-- but only as a one-way abort/release transition.
DROP TRIGGER block_erasing_upload_update;
CREATE TRIGGER block_erasing_upload_update
BEFORE UPDATE ON upload_sessions
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
AND NOT (
  NEW.id = OLD.id
  AND NEW.artifact_id = OLD.artifact_id
  AND NEW.project_id = OLD.project_id
  AND NEW.object_key = OLD.object_key
  AND NEW.file_name = OLD.file_name
  AND NEW.content_type = OLD.content_type
  AND NEW.expires_at = OLD.expires_at
  AND NEW.kind = OLD.kind
  AND NEW.metadata_json = OLD.metadata_json
  AND NEW.owner_user_id = OLD.owner_user_id
  AND NEW.multipart_upload_id IS OLD.multipart_upload_id
  AND NEW.completion_started_at IS NULL
  AND NEW.reservation_state = 'aborting'
  AND OLD.reservation_state IN (
    'legacy', 'open', 'uploading', 'completing', 'completed', 'aborting'
  )
  AND NEW.reserved_bytes BETWEEN 0 AND OLD.reserved_bytes
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TABLE artifact_account_usage (
  owner_user_id TEXT PRIMARY KEY,
  finalized_bytes INTEGER NOT NULL DEFAULT 0 CHECK (finalized_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  active_sessions INTEGER NOT NULL DEFAULT 0 CHECK (active_sessions >= 0)
);

INSERT INTO artifact_account_usage (
  owner_user_id,
  finalized_bytes,
  reserved_bytes,
  active_sessions
)
SELECT
  owners.owner_user_id,
  COALESCE((
    SELECT SUM(COALESCE(artifacts.bytes, 0))
    FROM artifacts
    JOIN projects ON projects.id = artifacts.project_id
    WHERE projects.user_id = owners.owner_user_id
  ), 0),
  0,
  (
    SELECT COUNT(*)
    FROM upload_sessions
    WHERE upload_sessions.owner_user_id = owners.owner_user_id
  )
FROM (
  SELECT DISTINCT user_id AS owner_user_id FROM projects
) AS owners;

CREATE TABLE artifact_upload_parts (
  upload_session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 64),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 33554432),
  etag TEXT,
  reservation_token TEXT NOT NULL CHECK (length(reservation_token) > 0),
  PRIMARY KEY (upload_session_id, part_number),
  FOREIGN KEY (upload_session_id) REFERENCES upload_sessions(id) ON DELETE RESTRICT
);

CREATE INDEX idx_artifact_upload_parts_session
  ON artifact_upload_parts(upload_session_id, part_number);
CREATE INDEX idx_upload_sessions_owner_expiry
  ON upload_sessions(owner_user_id, expires_at);

-- A session is counted from creation through finalize, abort, or expiry. The
-- trigger is the cap: concurrent Workers cannot both pass a preceding SELECT.
CREATE TRIGGER artifact_upload_session_before_insert
BEFORE INSERT ON upload_sessions
BEGIN
  SELECT CASE
    WHEN NEW.owner_user_id IS NULL OR length(NEW.owner_user_id) = 0
      THEN RAISE(ABORT, 'artifact_upload_owner_required')
    WHEN NEW.reservation_state <> 'open'
      OR NEW.reserved_bytes <> 0
      OR NEW.multipart_upload_id IS NOT NULL
      OR NEW.completion_started_at IS NOT NULL
      THEN RAISE(ABORT, 'artifact_upload_initial_state_invalid')
  END;

  INSERT OR IGNORE INTO artifact_account_usage (
    owner_user_id, finalized_bytes, reserved_bytes, active_sessions
  ) VALUES (NEW.owner_user_id, 0, 0, 0);

  SELECT CASE
    WHEN (
      SELECT active_sessions
      FROM artifact_account_usage
      WHERE owner_user_id = NEW.owner_user_id
    ) >= 16
      THEN RAISE(ABORT, 'artifact_upload_session_limit')
    WHEN (
      SELECT finalized_bytes + reserved_bytes
      FROM artifact_account_usage
      WHERE owner_user_id = NEW.owner_user_id
    ) >= 2147483648
      THEN RAISE(ABORT, 'artifact_account_quota')
  END;
END;

CREATE TRIGGER artifact_upload_session_after_insert
AFTER INSERT ON upload_sessions
BEGIN
  UPDATE artifact_account_usage
  SET active_sessions = active_sessions + 1
  WHERE owner_user_id = NEW.owner_user_id;
END;

-- Multipart coordination moved out of user metadata. Refuse an older Worker
-- that tries to recreate the private marker after this migration; its R2
-- create call is then aborted by that Worker's existing error path.
CREATE TRIGGER artifact_upload_metadata_before_update
BEFORE UPDATE OF metadata_json ON upload_sessions
WHEN NEW.metadata_json <> OLD.metadata_json
BEGIN
  SELECT RAISE(ABORT, 'artifact_upload_metadata_immutable');
END;

-- Part rows must be removed first. That release is itself trigger-accounted,
-- so a session delete can never silently discard a non-zero reservation.
CREATE TRIGGER artifact_upload_session_before_delete
BEFORE DELETE ON upload_sessions
WHEN OLD.reserved_bytes <> 0
  OR EXISTS (
    SELECT 1 FROM artifact_upload_parts
    WHERE upload_session_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_upload_reservation_not_released');
END;

CREATE TRIGGER artifact_upload_session_after_delete
AFTER DELETE ON upload_sessions
BEGIN
  UPDATE artifact_account_usage
  SET active_sessions = active_sessions - 1
  WHERE owner_user_id = OLD.owner_user_id;
END;

-- Finalized accounting remains authoritative for ordinary single PUTs too.
-- During multipart finalization the matching session reservation is deducted
-- from the quota expression; the same transaction inserts the artifact,
-- removes its part rows, and deletes the session, making the conversion atomic.
CREATE TRIGGER artifact_usage_before_artifact_insert
BEFORE INSERT ON artifacts
BEGIN
  SELECT CASE
    WHEN NEW.bytes IS NULL OR typeof(NEW.bytes) <> 'integer' OR NEW.bytes < 0
      THEN RAISE(ABORT, 'artifact_finalized_bytes_invalid')
    WHEN NOT EXISTS (
      SELECT 1 FROM projects WHERE id = NEW.project_id
    )
      THEN RAISE(ABORT, 'artifact_project_owner_missing')
  END;

  INSERT OR IGNORE INTO artifact_account_usage (
    owner_user_id, finalized_bytes, reserved_bytes, active_sessions
  )
  SELECT user_id, 0, 0, 0 FROM projects WHERE id = NEW.project_id;

  SELECT CASE
    WHEN (
      SELECT usage.finalized_bytes + usage.reserved_bytes + NEW.bytes
        - COALESCE((
            SELECT sessions.reserved_bytes
            FROM upload_sessions sessions
            WHERE sessions.artifact_id = NEW.id
              AND sessions.project_id = NEW.project_id
              AND sessions.reservation_state = 'completed'
              AND sessions.reserved_bytes = NEW.bytes
          ), 0)
      FROM artifact_account_usage usage
      JOIN projects ON projects.user_id = usage.owner_user_id
      WHERE projects.id = NEW.project_id
    ) > 2147483648
      THEN RAISE(ABORT, 'artifact_account_quota')
  END;
END;

CREATE TRIGGER artifact_usage_after_artifact_insert
AFTER INSERT ON artifacts
BEGIN
  UPDATE artifact_account_usage
  SET finalized_bytes = finalized_bytes + NEW.bytes
  WHERE owner_user_id = (
    SELECT user_id FROM projects WHERE id = NEW.project_id
  );
END;

CREATE TRIGGER artifact_usage_after_artifact_delete
AFTER DELETE ON artifacts
BEGIN
  UPDATE artifact_account_usage
  SET finalized_bytes = finalized_bytes - COALESCE(OLD.bytes, 0)
  WHERE owner_user_id = (
    SELECT user_id FROM projects WHERE id = OLD.project_id
  );
END;

-- Artifact ownership and byte counts have never been mutable. Refusing such an
-- update keeps the denormalized account row from drifting if that changes.
CREATE TRIGGER artifact_usage_before_artifact_accounting_update
BEFORE UPDATE OF project_id, bytes ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact_accounting_fields_immutable');
END;

CREATE TRIGGER artifact_upload_part_before_insert
BEFORE INSERT ON artifact_upload_parts
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
        AND reservation_state = 'uploading'
        AND multipart_upload_id IS NOT NULL
        AND owner_user_id IS NOT NULL
    )
      THEN RAISE(ABORT, 'artifact_multipart_not_uploading')
    WHEN (
      SELECT COUNT(*) FROM artifact_upload_parts
      WHERE upload_session_id = NEW.upload_session_id
    ) >= 64 AND NOT EXISTS (
      SELECT 1 FROM artifact_upload_parts
      WHERE upload_session_id = NEW.upload_session_id
        AND part_number = NEW.part_number
    )
      THEN RAISE(ABORT, 'artifact_upload_part_limit')
    WHEN (
      SELECT reserved_bytes + NEW.bytes - COALESCE((
        SELECT bytes FROM artifact_upload_parts
        WHERE upload_session_id = NEW.upload_session_id
          AND part_number = NEW.part_number
      ), 0)
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
    ) > 1073741824
      THEN RAISE(ABORT, 'artifact_upload_byte_limit')
    WHEN (
      SELECT usage.reserved_bytes + NEW.bytes - COALESCE((
        SELECT bytes FROM artifact_upload_parts
        WHERE upload_session_id = NEW.upload_session_id
          AND part_number = NEW.part_number
      ), 0)
      FROM artifact_account_usage usage
      JOIN upload_sessions sessions
        ON sessions.owner_user_id = usage.owner_user_id
      WHERE sessions.id = NEW.upload_session_id
    ) > 2147483648
      THEN RAISE(ABORT, 'artifact_reserved_byte_limit')
    WHEN (
      SELECT usage.finalized_bytes + usage.reserved_bytes + NEW.bytes
        - COALESCE((
          SELECT bytes FROM artifact_upload_parts
          WHERE upload_session_id = NEW.upload_session_id
            AND part_number = NEW.part_number
        ), 0)
      FROM artifact_account_usage usage
      JOIN upload_sessions sessions
        ON sessions.owner_user_id = usage.owner_user_id
      WHERE sessions.id = NEW.upload_session_id
    ) > 2147483648
      THEN RAISE(ABORT, 'artifact_account_quota')
  END;
END;

CREATE TRIGGER artifact_upload_part_after_insert
AFTER INSERT ON artifact_upload_parts
BEGIN
  UPDATE upload_sessions
  SET reserved_bytes = reserved_bytes + NEW.bytes
  WHERE id = NEW.upload_session_id;

  UPDATE artifact_account_usage
  SET reserved_bytes = reserved_bytes + NEW.bytes
  WHERE owner_user_id = (
    SELECT owner_user_id
    FROM upload_sessions
    WHERE id = NEW.upload_session_id
  );
END;

CREATE TRIGGER artifact_upload_part_before_update
BEFORE UPDATE ON artifact_upload_parts
BEGIN
  SELECT CASE
    WHEN NEW.upload_session_id <> OLD.upload_session_id
      OR NEW.part_number <> OLD.part_number
      THEN RAISE(ABORT, 'artifact_upload_part_identity_immutable')
    WHEN NOT EXISTS (
      SELECT 1
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
        AND reservation_state = 'uploading'
        AND multipart_upload_id IS NOT NULL
    )
      THEN RAISE(ABORT, 'artifact_multipart_not_uploading')
    WHEN NEW.bytes < 1 OR NEW.bytes > 33554432
      OR length(NEW.reservation_token) = 0
      THEN RAISE(ABORT, 'artifact_upload_part_invalid')
    WHEN (
      SELECT reserved_bytes + NEW.bytes - OLD.bytes
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
    ) > 1073741824
      THEN RAISE(ABORT, 'artifact_upload_byte_limit')
    WHEN (
      SELECT usage.reserved_bytes + NEW.bytes - OLD.bytes
      FROM artifact_account_usage usage
      JOIN upload_sessions sessions
        ON sessions.owner_user_id = usage.owner_user_id
      WHERE sessions.id = NEW.upload_session_id
    ) > 2147483648
      THEN RAISE(ABORT, 'artifact_reserved_byte_limit')
    WHEN (
      SELECT usage.finalized_bytes + usage.reserved_bytes
        + NEW.bytes - OLD.bytes
      FROM artifact_account_usage usage
      JOIN upload_sessions sessions
        ON sessions.owner_user_id = usage.owner_user_id
      WHERE sessions.id = NEW.upload_session_id
    ) > 2147483648
      THEN RAISE(ABORT, 'artifact_account_quota')
  END;
END;

CREATE TRIGGER artifact_upload_part_after_update_bytes
AFTER UPDATE OF bytes ON artifact_upload_parts
WHEN NEW.bytes <> OLD.bytes
BEGIN
  UPDATE upload_sessions
  SET reserved_bytes = reserved_bytes + NEW.bytes - OLD.bytes
  WHERE id = NEW.upload_session_id;

  UPDATE artifact_account_usage
  SET reserved_bytes = reserved_bytes + NEW.bytes - OLD.bytes
  WHERE owner_user_id = (
    SELECT owner_user_id
    FROM upload_sessions
    WHERE id = NEW.upload_session_id
  );
END;

CREATE TRIGGER artifact_upload_part_after_delete
AFTER DELETE ON artifact_upload_parts
BEGIN
  UPDATE upload_sessions
  SET reserved_bytes = reserved_bytes - OLD.bytes
  WHERE id = OLD.upload_session_id;

  UPDATE artifact_account_usage
  SET reserved_bytes = reserved_bytes - OLD.bytes
  WHERE owner_user_id = (
    SELECT owner_user_id
    FROM upload_sessions
    WHERE id = OLD.upload_session_id
  );
END;
