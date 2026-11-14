-- One storage allowance per account (roadmap L10). Until now an account had
-- two separately enforced allowances: project storage (documents,
-- revisions, R2 document objects, source assets and retained encrypted
-- envelopes, against `users.project_storage_limit_bytes`) and cloud file
-- storage (imports, exports and encrypted content blobs in
-- `artifact_account_usage`, against `users.artifact_limit_bytes`). Every
-- trigger that compared one of those measures with its own limit now
-- compares their sum with a single limit, so a write that grows either side
-- is refused once the account's combined usage would go over it. Existing
-- data over the limit stays; as before, only growth is refused.
--
-- The single limit lives in `users.project_storage_limit_bytes`. The Worker
-- writes the same unified value to `artifact_limit_bytes` too, which keeps
-- an older Worker (and the per-account in-flight reservation check below,
-- unchanged) reading a consistent value. No column is added or dropped, so
-- a rollback to the previous Worker stays compatible with this schema.
--
-- Each trigger below is the latest definition of its predecessor (0022,
-- 0042 or 0043), with every other check kept verbatim; only the quota sum
-- and the limit column change. The fallback for an owner without a `users`
-- row stays 2 GiB, as before.

-- An owner's project storage exactly as the quota has measured it so far
-- (migrations 0022, 0042 and 0043) and as the Worker reports it
-- (`plaintextProjectStorageBytes` plus encrypted stored bytes): documents
-- and revisions held inline in D1 by their `document_bytes`; R2 document
-- objects and source assets by their stored size, except a project's
-- plaintext staged for decryption (migration 0043's view), which counts
-- from its cutover on; and the retained envelopes of encrypted (format 2)
-- projects, staged ciphertext of a plaintext project excluded (decision
-- M10). Selected by `user_id`, SQLite pushes the filter into the owner list
-- and evaluates each sum for that owner only; an owner with no projects has
-- no row, which every reader takes as zero.
CREATE VIEW IF NOT EXISTS account_project_storage AS
SELECT owners.user_id AS user_id,
  COALESCE((
    SELECT SUM(p.document_bytes) FROM projects p
    WHERE p.user_id = owners.user_id AND p.document_object_id IS NULL
  ), 0)
  + COALESCE((
    SELECT SUM(r.document_bytes)
    FROM revisions r JOIN projects p ON p.id = r.project_id
    -- The unary + keeps SQLite from scanning every account's inline
    -- revisions through the document-object index: it walks this owner's
    -- projects and their revisions instead.
    WHERE p.user_id = owners.user_id AND +r.document_object_id IS NULL
  ), 0)
  + COALESCE((
    SELECT SUM(o.stored_bytes)
    FROM project_document_objects o JOIN projects p ON p.id = o.project_id
    WHERE p.user_id = owners.user_id
      AND p.id NOT IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
  ), 0)
  + COALESCE((
    SELECT SUM(a.stored_bytes)
    FROM project_storage_assets a JOIN projects p ON p.id = a.project_id
    WHERE p.user_id = owners.user_id
      AND p.id NOT IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
  ), 0)
  + COALESCE((
    SELECT SUM(v.envelope_bytes)
    FROM e2ee_project_versions v JOIN projects p ON p.id = v.project_id
    WHERE p.user_id = owners.user_id AND p.storage_format = 2
      AND (v.envelope_key IS NOT NULL OR v.envelope_inline IS NOT NULL)
  ), 0) AS bytes
FROM (SELECT DISTINCT user_id FROM projects) owners;

-- Accounts the Worker has not yet refreshed keep one consistent value: the
-- larger of the two, so no account loses room it had on either side before
-- the Worker's own sync writes the configured unified limit.
UPDATE users
SET project_storage_limit_bytes = MAX(project_storage_limit_bytes, artifact_limit_bytes),
    artifact_limit_bytes = MAX(project_storage_limit_bytes, artifact_limit_bytes)
WHERE project_storage_limit_bytes <> artifact_limit_bytes;

-- ---------------------------------------------------------------------------
-- Cloud file side: artifact usage plus the owner's project storage.
-- ---------------------------------------------------------------------------

-- Migration 0022's upload-session admission.
DROP TRIGGER IF EXISTS artifact_upload_session_before_insert;
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
    )
    + COALESCE((
      SELECT bytes FROM account_project_storage
      WHERE user_id = NEW.owner_user_id
    ), 0) >= COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = NEW.owner_user_id), 2147483648);
END;

-- Migration 0043's finalization check (staged decrypt files exempt).
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
    )
    + COALESCE((
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    AND NEW.bytes > COALESCE((
      SELECT reserved_bytes FROM upload_sessions
      WHERE artifact_id = NEW.id AND project_id = NEW.project_id
        AND reservation_state = 'completed' AND reserved_bytes = NEW.bytes
    ), 0);
END;

-- Migration 0022's multipart part reservation. The in-flight reservation
-- check (`artifact_reserved_byte_limit`) is unchanged: it bounds reserved
-- bytes alone, against the mirrored `artifact_limit_bytes`.
DROP TRIGGER IF EXISTS artifact_upload_part_before_insert;
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
    )
    + COALESCE((
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 2147483648)
    AND NEW.bytes > COALESCE((SELECT bytes FROM artifact_upload_parts WHERE upload_session_id = NEW.upload_session_id AND part_number = NEW.part_number), 0);
END;

DROP TRIGGER IF EXISTS artifact_upload_part_before_update;
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
    )
    + COALESCE((
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 2147483648)
    AND NEW.bytes > OLD.bytes;
END;

-- Migration 0042's encrypted content blob check (format-1 staging exempt).
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
    )
    + COALESCE((
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    AND NEW.ciphertext_bytes > COALESCE((
      SELECT reserved_bytes FROM upload_sessions
      WHERE artifact_id = NEW.blob_id AND project_id = NEW.project_id
        AND reservation_state = 'completed'
        AND reserved_bytes = NEW.ciphertext_bytes
    ), 0);
END;

-- ---------------------------------------------------------------------------
-- Project side: project storage plus the owner's artifact usage (finalized
-- and reserved, as the cloud file side counts it).
-- ---------------------------------------------------------------------------

-- Migration 0022's inline-document checks: the growth of the row's inline
-- bytes on top of everything the account stores.
DROP TRIGGER IF EXISTS project_account_d1_project_bytes_before_insert;
CREATE TRIGGER project_account_d1_project_bytes_before_insert
BEFORE INSERT ON projects
WHEN NEW.document_object_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes +
    COALESCE((
      SELECT bytes FROM account_project_storage WHERE user_id = NEW.user_id
    ), 0) +
    COALESCE((
      SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
      WHERE owner_user_id = NEW.user_id
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = NEW.user_id), 2147483648);
END;

DROP TRIGGER IF EXISTS project_account_d1_project_bytes_before_update;
CREATE TRIGGER project_account_d1_project_bytes_before_update
BEFORE UPDATE OF document_bytes, document_object_id ON projects
WHEN NEW.document_bytes * (NEW.document_object_id IS NULL)
   > OLD.document_bytes * (OLD.document_object_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes * (NEW.document_object_id IS NULL)
    - OLD.document_bytes * (OLD.document_object_id IS NULL) +
    COALESCE((
      SELECT bytes FROM account_project_storage WHERE user_id = NEW.user_id
    ), 0) +
    COALESCE((
      SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
      WHERE owner_user_id = NEW.user_id
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = NEW.user_id), 2147483648);
END;

DROP TRIGGER IF EXISTS project_account_d1_revision_bytes_before_insert;
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
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) +
    COALESCE((
      SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
      WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

DROP TRIGGER IF EXISTS project_account_d1_revision_bytes_before_update;
CREATE TRIGGER project_account_d1_revision_bytes_before_update
BEFORE UPDATE OF document_bytes, document_object_id ON revisions
WHEN NEW.document_bytes * (NEW.document_object_id IS NULL)
   > OLD.document_bytes * (OLD.document_object_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes * (NEW.document_object_id IS NULL)
    - OLD.document_bytes * (OLD.document_object_id IS NULL) +
    COALESCE((
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) +
    COALESCE((
      SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
      WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

-- Migration 0043's R2 document object and source asset checks (staged
-- decrypt plaintext exempt; an asset already stored for the project is not
-- new storage).
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
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) +
    COALESCE((
      SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
      WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
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
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) +
    COALESCE((
      SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
      WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648);
END;

-- Migration 0043's encrypted version check (staged ciphertext of a
-- plaintext project exempt).
DROP TRIGGER IF EXISTS e2ee_project_version_quota;
CREATE TRIGGER e2ee_project_version_quota
BEFORE INSERT ON e2ee_project_versions
WHEN (SELECT storage_format FROM projects WHERE id = NEW.project_id) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.envelope_bytes +
    COALESCE((
      SELECT bytes FROM account_project_storage
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) +
    COALESCE((
      SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
      WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > COALESCE((
      SELECT project_storage_limit_bytes FROM users
      WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 2147483648);
END;
