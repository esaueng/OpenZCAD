-- ADR-024 Phase 7, slice 7-3 (roadmap L11): the beta-only reverse path,
-- which turns an encrypted project the owner alone holds back into
-- plaintext. It reuses migration 0042's state machine (direction
-- `decrypt`) and adds no table: this migration only gives the plaintext a
-- browser stages beside an encrypted project the treatment migration 0042
-- gave staged ciphertext (decision M10): it counts toward nothing until
-- the cutover. The routes stay closed behind E2EE_REVERSE_ENABLED (with
-- E2EE_MIGRATION_ENABLED), which Phase 8 deletes together with this path.
-- Ordinary traffic does not depend on this migration: until it is applied
-- the reverse routes answer 503 and nothing names the view below.

-- The encrypted projects whose plaintext is being staged beside them
-- (`staging`) or dropped after an abandon (`abandoned`, while the project
-- is still format 2). Their plaintext rows (document objects, storage
-- assets and artifacts) are exempt from every quota below; the cutover
-- adds the staged artifacts to the owner's artifact usage in its own
-- batch, and the document objects and assets count from then on because
-- the project leaves this view. Before any decrypt row exists the view is
-- empty, so every answer below is unchanged.
CREATE VIEW IF NOT EXISTS e2ee_decrypt_staged_projects AS
  SELECT m.project_id AS project_id
  FROM e2ee_project_migrations m
  JOIN projects p ON p.id = m.project_id
  WHERE m.direction = 'decrypt'
    AND m.state IN ('staging', 'abandoned')
    AND p.storage_format = 2;

-- Migration 0022's artifact quota, unchanged except that a staged file
-- (an artifact of a project in the view) is not checked against it.
DROP TRIGGER IF EXISTS artifact_usage_before_artifact_insert;
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
  WHERE NEW.project_id NOT IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND (
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

-- Migration 0017's finalized-usage counters, skipping staged files on the
-- way in and on the way out (an abandon drops files that never counted).
DROP TRIGGER IF EXISTS artifact_usage_after_artifact_insert;
CREATE TRIGGER artifact_usage_after_artifact_insert
AFTER INSERT ON artifacts
WHEN NEW.project_id NOT IN (
  SELECT project_id FROM e2ee_decrypt_staged_projects
)
BEGIN
  UPDATE artifact_account_usage
  SET finalized_bytes = finalized_bytes + NEW.bytes
  WHERE owner_user_id = (
    SELECT user_id FROM projects WHERE id = NEW.project_id
  );
END;

DROP TRIGGER IF EXISTS artifact_usage_after_artifact_delete;
CREATE TRIGGER artifact_usage_after_artifact_delete
AFTER DELETE ON artifacts
WHEN OLD.project_id NOT IN (
  SELECT project_id FROM e2ee_decrypt_staged_projects
)
BEGIN
  UPDATE artifact_account_usage
  SET finalized_bytes = finalized_bytes - COALESCE(OLD.bytes, 0)
  WHERE owner_user_id = (
    SELECT user_id FROM projects WHERE id = OLD.project_id
  );
END;

-- Migration 0022's project storage quota: a staged document object or
-- storage asset is not checked, and staged bytes count toward no sum.
DROP TRIGGER IF EXISTS project_account_object_bytes_before_insert;
CREATE TRIGGER project_account_object_bytes_before_insert
BEFORE INSERT ON project_document_objects
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_invalid')
  WHERE typeof(NEW.stored_bytes) <> 'integer' OR NEW.stored_bytes < 0
    OR NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.project_id NOT IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND NEW.stored_bytes +
    COALESCE((
      SELECT SUM(objects.stored_bytes)
      FROM project_document_objects objects
      JOIN projects owner ON owner.id = objects.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND owner.id NOT IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
    ), 0) +
    COALESCE((
      SELECT SUM(assets.stored_bytes)
      FROM project_storage_assets assets
      JOIN projects owner ON owner.id = assets.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND owner.id NOT IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

DROP TRIGGER IF EXISTS project_account_asset_bytes_before_insert;
CREATE TRIGGER project_account_asset_bytes_before_insert
BEFORE INSERT ON project_storage_assets
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_invalid')
  WHERE typeof(NEW.stored_bytes) <> 'integer' OR NEW.stored_bytes < 0
    OR NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.project_id NOT IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND NOT EXISTS (
      SELECT 1 FROM project_storage_assets
      WHERE project_id = NEW.project_id
        AND checksum_sha256 = NEW.checksum_sha256 AND kind = NEW.kind
    ) AND NEW.stored_bytes +
    COALESCE((
      SELECT SUM(objects.stored_bytes)
      FROM project_document_objects objects
      JOIN projects owner ON owner.id = objects.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND owner.id NOT IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
    ), 0) +
    COALESCE((
      SELECT SUM(assets.stored_bytes)
      FROM project_storage_assets assets
      JOIN projects owner ON owner.id = assets.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND owner.id NOT IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

-- Migration 0042's encrypted version quota: staged plaintext of another
-- project counts toward it no more than toward the quotas above.
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
        AND owner.id NOT IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
    ), 0) +
    COALESCE((
      SELECT SUM(assets.stored_bytes)
      FROM project_storage_assets assets
      JOIN projects owner ON owner.id = assets.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND owner.id NOT IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
    ), 0) > COALESCE((
      SELECT project_storage_limit_bytes FROM users
      WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 2147483648);
END;
