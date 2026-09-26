-- Distinguish internal one-part R2 uploads from the public multipart API.
-- The existing multipart reservation triggers account for their bytes.
ALTER TABLE upload_sessions ADD COLUMN single_part INTEGER NOT NULL DEFAULT 0
  CHECK (single_part IN (0, 1));
ALTER TABLE upload_sessions ADD COLUMN upload_protocol_version INTEGER NOT NULL DEFAULT 0
  CHECK (upload_protocol_version IN (0, 1));

-- Older Workers omit the version. Refuse their new sessions before they can
-- write an R2 object through the former direct-PUT path.
CREATE TRIGGER artifact_upload_protocol_before_insert
BEFORE INSERT ON upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'artifact_upload_protocol_version_required')
  WHERE NEW.upload_protocol_version <> 1;
END;

-- Old open sessions may already have a direct R2 PUT in flight. Refuse their
-- reuse by new Workers, but retain their original expiry for cleanup retries.
-- Account erasure has already fenced its sessions and handles them separately.
UPDATE upload_sessions
SET reservation_state = 'legacy'
WHERE reservation_state = 'open'
  AND NOT EXISTS (
    SELECT 1 FROM account_erasure_requests erasure
    JOIN projects ON projects.user_id = erasure.user_id
    WHERE projects.id = upload_sessions.project_id
  );

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
  AND NEW.single_part = OLD.single_part
  AND NEW.upload_protocol_version = OLD.upload_protocol_version
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
