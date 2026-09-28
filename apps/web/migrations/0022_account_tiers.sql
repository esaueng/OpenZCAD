-- The Worker derives this enforcement value from the server-only membership list.
-- Existing accounts start Free. Membership is never accepted from API payloads.
ALTER TABLE users ADD COLUMN artifact_limit_bytes INTEGER NOT NULL DEFAULT 2147483648
  CHECK (typeof(artifact_limit_bytes) = 'integer' AND artifact_limit_bytes > 0);

DROP TRIGGER artifact_upload_session_before_insert;
CREATE TRIGGER artifact_upload_session_before_insert
BEFORE INSERT ON upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'artifact_upload_owner_required')
  WHERE NEW.owner_user_id IS NULL OR length(NEW.owner_user_id) = 0;

  SELECT RAISE(ABORT, 'artifact_upload_initial_state_invalid')
  WHERE NEW.reservation_state <> 'open'
      OR NEW.reserved_bytes <> 0
      OR NEW.multipart_upload_id IS NOT NULL
      OR NEW.completion_started_at IS NOT NULL;

  INSERT OR IGNORE INTO artifact_account_usage (
    owner_user_id, finalized_bytes, reserved_bytes, active_sessions
  ) VALUES (NEW.owner_user_id, 0, 0, 0);

  SELECT RAISE(ABORT, 'artifact_upload_session_limit')
  WHERE (
      SELECT active_sessions
      FROM artifact_account_usage
      WHERE owner_user_id = NEW.owner_user_id
    ) >= 16;

  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE (
      SELECT finalized_bytes + reserved_bytes
      FROM artifact_account_usage
      WHERE owner_user_id = NEW.owner_user_id
    ) >= COALESCE((SELECT artifact_limit_bytes FROM users WHERE id = NEW.owner_user_id), 2147483648);
END;

DROP TRIGGER artifact_usage_before_artifact_insert;
CREATE TRIGGER artifact_usage_before_artifact_insert
BEFORE INSERT ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact_finalized_bytes_invalid')
  WHERE NEW.bytes IS NULL OR typeof(NEW.bytes) <> 'integer' OR NEW.bytes < 0;

  SELECT RAISE(ABORT, 'artifact_project_owner_missing')
  WHERE NOT EXISTS (
      SELECT 1 FROM projects WHERE id = NEW.project_id
    );

  INSERT OR IGNORE INTO artifact_account_usage (
    owner_user_id, finalized_bytes, reserved_bytes, active_sessions
  )
  SELECT user_id, 0, 0, 0 FROM projects WHERE id = NEW.project_id;

  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE (
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
    ) > COALESCE((SELECT artifact_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    AND NEW.bytes > COALESCE((
      SELECT reserved_bytes FROM upload_sessions
      WHERE artifact_id = NEW.id AND project_id = NEW.project_id
        AND reservation_state = 'completed' AND reserved_bytes = NEW.bytes
    ), 0);
END;

DROP TRIGGER artifact_upload_part_before_insert;
CREATE TRIGGER artifact_upload_part_before_insert
BEFORE INSERT ON artifact_upload_parts
BEGIN
  SELECT RAISE(ABORT, 'artifact_multipart_not_uploading')
  WHERE NOT EXISTS (
      SELECT 1
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
        AND reservation_state = 'uploading'
        AND multipart_upload_id IS NOT NULL
        AND owner_user_id IS NOT NULL
    );

  SELECT RAISE(ABORT, 'artifact_upload_part_limit')
  WHERE (
      SELECT COUNT(*) FROM artifact_upload_parts
      WHERE upload_session_id = NEW.upload_session_id
    ) >= 64 AND NOT EXISTS (
      SELECT 1 FROM artifact_upload_parts
      WHERE upload_session_id = NEW.upload_session_id
        AND part_number = NEW.part_number
    );

  SELECT RAISE(ABORT, 'artifact_upload_byte_limit')
  WHERE (
      SELECT reserved_bytes + NEW.bytes - COALESCE((
        SELECT bytes FROM artifact_upload_parts
        WHERE upload_session_id = NEW.upload_session_id
          AND part_number = NEW.part_number
      ), 0)
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
    ) > 1073741824;

  SELECT RAISE(ABORT, 'artifact_reserved_byte_limit')
  WHERE (
      SELECT usage.reserved_bytes + NEW.bytes - COALESCE((
        SELECT bytes FROM artifact_upload_parts
        WHERE upload_session_id = NEW.upload_session_id
          AND part_number = NEW.part_number
      ), 0)
      FROM artifact_account_usage usage
      JOIN upload_sessions sessions
        ON sessions.owner_user_id = usage.owner_user_id
      WHERE sessions.id = NEW.upload_session_id
    ) > COALESCE((SELECT artifact_limit_bytes FROM users WHERE id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 2147483648)
    AND NEW.bytes > COALESCE((SELECT bytes FROM artifact_upload_parts WHERE upload_session_id = NEW.upload_session_id AND part_number = NEW.part_number), 0);

  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE (
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
    ) > COALESCE((SELECT artifact_limit_bytes FROM users WHERE id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 2147483648)
    AND NEW.bytes > COALESCE((SELECT bytes FROM artifact_upload_parts WHERE upload_session_id = NEW.upload_session_id AND part_number = NEW.part_number), 0);
END;

DROP TRIGGER artifact_upload_part_before_update;
CREATE TRIGGER artifact_upload_part_before_update
BEFORE UPDATE ON artifact_upload_parts
BEGIN
  SELECT RAISE(ABORT, 'artifact_upload_part_identity_immutable')
  WHERE NEW.upload_session_id <> OLD.upload_session_id
      OR NEW.part_number <> OLD.part_number;

  SELECT RAISE(ABORT, 'artifact_multipart_not_uploading')
  WHERE NOT EXISTS (
      SELECT 1
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
        AND reservation_state = 'uploading'
        AND multipart_upload_id IS NOT NULL
    );

  SELECT RAISE(ABORT, 'artifact_upload_part_invalid')
  WHERE NEW.bytes < 1 OR NEW.bytes > 33554432
      OR length(NEW.reservation_token) = 0;

  SELECT RAISE(ABORT, 'artifact_upload_byte_limit')
  WHERE (
      SELECT reserved_bytes + NEW.bytes - OLD.bytes
      FROM upload_sessions
      WHERE id = NEW.upload_session_id
    ) > 1073741824;

  SELECT RAISE(ABORT, 'artifact_reserved_byte_limit')
  WHERE (
      SELECT usage.reserved_bytes + NEW.bytes - OLD.bytes
      FROM artifact_account_usage usage
      JOIN upload_sessions sessions
        ON sessions.owner_user_id = usage.owner_user_id
      WHERE sessions.id = NEW.upload_session_id
    ) > COALESCE((SELECT artifact_limit_bytes FROM users WHERE id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 2147483648)
    AND NEW.bytes > OLD.bytes;

  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE (
      SELECT usage.finalized_bytes + usage.reserved_bytes
        + NEW.bytes - OLD.bytes
      FROM artifact_account_usage usage
      JOIN upload_sessions sessions
        ON sessions.owner_user_id = usage.owner_user_id
      WHERE sessions.id = NEW.upload_session_id
    ) > COALESCE((SELECT artifact_limit_bytes FROM users WHERE id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 2147483648)
    AND NEW.bytes > OLD.bytes;
END;


-- Project counts and cloud document/asset storage use the same owner policy.
ALTER TABLE users ADD COLUMN project_limit INTEGER NOT NULL DEFAULT 100
  CHECK (typeof(project_limit) = 'integer' AND project_limit > 0);
ALTER TABLE users ADD COLUMN project_storage_limit_bytes INTEGER NOT NULL DEFAULT 2147483648
  CHECK (typeof(project_storage_limit_bytes) = 'integer' AND project_storage_limit_bytes > 0);

DROP TRIGGER project_account_count_before_insert;
CREATE TRIGGER project_account_count_before_insert
BEFORE INSERT ON projects
BEGIN
  SELECT RAISE(ABORT, 'project_account_count_quota')
  WHERE (SELECT COUNT(*) FROM projects WHERE user_id = NEW.user_id) >= COALESCE((SELECT project_limit FROM users WHERE id = NEW.user_id), 100);
END;

DROP TRIGGER project_account_d1_project_bytes_before_insert;
CREATE TRIGGER project_account_d1_project_bytes_before_insert
BEFORE INSERT ON projects
WHEN NEW.document_object_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes +
    COALESCE((
      SELECT SUM(document_bytes) FROM projects
      WHERE user_id = NEW.user_id AND document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(revisions.document_bytes)
      FROM revisions JOIN projects ON projects.id = revisions.project_id
      WHERE projects.user_id = NEW.user_id
        AND revisions.document_object_id IS NULL
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = NEW.user_id), 2147483648);
END;

DROP TRIGGER project_account_d1_project_bytes_before_update;
CREATE TRIGGER project_account_d1_project_bytes_before_update
BEFORE UPDATE OF document_bytes, document_object_id ON projects
WHEN NEW.document_bytes * (NEW.document_object_id IS NULL)
   > OLD.document_bytes * (OLD.document_object_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes * (NEW.document_object_id IS NULL)
    - OLD.document_bytes * (OLD.document_object_id IS NULL) +
    COALESCE((
      SELECT SUM(document_bytes) FROM projects
      WHERE user_id = NEW.user_id AND document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(revisions.document_bytes)
      FROM revisions JOIN projects ON projects.id = revisions.project_id
      WHERE projects.user_id = NEW.user_id
        AND revisions.document_object_id IS NULL
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = NEW.user_id), 2147483648);
END;

DROP TRIGGER project_account_d1_revision_bytes_before_insert;
CREATE TRIGGER project_account_d1_revision_bytes_before_insert
BEFORE INSERT ON revisions
WHEN NEW.document_object_id IS NULL AND NEW.document_bytes >
  COALESCE((
    SELECT old.document_bytes FROM revisions old
    WHERE old.id = NEW.id AND old.project_id = NEW.project_id
      AND old.document_object_id IS NULL
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes -
    COALESCE((
      SELECT old.document_bytes FROM revisions old
      WHERE old.id = NEW.id AND old.project_id = NEW.project_id
        AND old.document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(document_bytes) FROM projects
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(revisions.document_bytes)
      FROM revisions JOIN projects ON projects.id = revisions.project_id
      WHERE projects.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND revisions.document_object_id IS NULL
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

DROP TRIGGER project_account_d1_revision_bytes_before_update;
CREATE TRIGGER project_account_d1_revision_bytes_before_update
BEFORE UPDATE OF document_bytes, document_object_id ON revisions
WHEN NEW.document_bytes * (NEW.document_object_id IS NULL)
   > OLD.document_bytes * (OLD.document_object_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes * (NEW.document_object_id IS NULL)
    - OLD.document_bytes * (OLD.document_object_id IS NULL) +
    COALESCE((
      SELECT SUM(document_bytes) FROM projects
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(revisions.document_bytes)
      FROM revisions JOIN projects ON projects.id = revisions.project_id
      WHERE projects.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND revisions.document_object_id IS NULL
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

DROP TRIGGER project_account_object_bytes_before_insert;
CREATE TRIGGER project_account_object_bytes_before_insert
BEFORE INSERT ON project_document_objects
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_invalid')
  WHERE typeof(NEW.stored_bytes) <> 'integer' OR NEW.stored_bytes < 0
    OR NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.stored_bytes +
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
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

DROP TRIGGER project_account_asset_bytes_before_insert;
CREATE TRIGGER project_account_asset_bytes_before_insert
BEFORE INSERT ON project_storage_assets
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_invalid')
  WHERE typeof(NEW.stored_bytes) <> 'integer' OR NEW.stored_bytes < 0
    OR NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NOT EXISTS (
      SELECT 1 FROM project_storage_assets
      WHERE project_id = NEW.project_id
        AND checksum_sha256 = NEW.checksum_sha256 AND kind = NEW.kind
    ) AND NEW.stored_bytes +
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
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

