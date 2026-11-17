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
-- Each unary + keeps SQLite from answering `document_object_id IS NULL`
-- through the document-object indexes, which hold every account's inline
-- rows under one key: it walks this owner's projects and their revisions.
SELECT owners.user_id AS user_id,
  COALESCE((
    SELECT SUM(p.document_bytes) FROM projects p
    WHERE p.user_id = owners.user_id AND +p.document_object_id IS NULL
  ), 0)
  + COALESCE((
    SELECT SUM(r.document_bytes)
    FROM revisions r JOIN projects p ON p.id = r.project_id
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

-- Upload sessions whose bytes stage a migration rather than add counted
-- storage: a decrypt staging's plaintext files (migration 0043's view) and
-- an encrypt staging's ciphertext blobs (an encrypted blob session of a
-- plaintext project, decision M10). Their finalized rows count toward the
-- allowance only from the cutover on, so they are checked against the
-- account's projected storage instead (below). Selected by `id`, it is one
-- primary-key lookup.
CREATE VIEW IF NOT EXISTS migration_staging_upload_sessions AS
SELECT s.id AS id
FROM upload_sessions s JOIN projects p ON p.id = s.project_id
WHERE s.project_id IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
   OR (s.e2ee_blob_kind IS NOT NULL AND p.storage_format = 1);

-- What each live migration staging would add to the counted storage once
-- it cuts over and its purge has run: everything it staged that does not
-- count yet, less (while it is still staging) what the purge removes.
--
-- - Encrypt (a plaintext project staging ciphertext): its encrypted
--   versions and blobs, less its plaintext: the inline head and save
--   states, document objects, source assets, files and the reservations of
--   its plaintext uploads (the purge discards them).
-- - Decrypt (an encrypted project staging plaintext): its staged files,
--   document objects and assets, less its encrypted blobs and retained
--   envelopes.
--
-- An abandoned staging is credited nothing: it will not cut over, and
-- holds its staged rows until its cleanup drops them.
CREATE VIEW IF NOT EXISTS migration_staging_growth AS
SELECT m.owner_user_id AS user_id, m.project_id AS project_id,
  CASE
    WHEN m.direction = 'encrypt' AND p.storage_format = 1 THEN
      (SELECT COALESCE(SUM(v.envelope_bytes), 0) FROM e2ee_project_versions v
       WHERE v.project_id = m.project_id
         AND (v.envelope_key IS NOT NULL OR v.envelope_inline IS NOT NULL))
      + (SELECT COALESCE(SUM(b.ciphertext_bytes), 0) FROM e2ee_content_blobs b
         WHERE b.project_id = m.project_id)
      - (m.state = 'staging') * (
          p.document_bytes * (p.document_object_id IS NULL)
          + (SELECT COALESCE(SUM(r.document_bytes), 0) FROM revisions r
             WHERE r.project_id = m.project_id
               AND +r.document_object_id IS NULL)
          + (SELECT COALESCE(SUM(o.stored_bytes), 0)
             FROM project_document_objects o WHERE o.project_id = m.project_id)
          + (SELECT COALESCE(SUM(a.stored_bytes), 0)
             FROM project_storage_assets a WHERE a.project_id = m.project_id)
          + (SELECT COALESCE(SUM(f.bytes), 0) FROM artifacts f
             WHERE f.project_id = m.project_id)
          + (SELECT COALESCE(SUM(s.reserved_bytes), 0) FROM upload_sessions s
             WHERE s.project_id = m.project_id AND s.e2ee_blob_kind IS NULL))
    WHEN m.direction = 'decrypt' AND p.storage_format = 2 THEN
      (SELECT COALESCE(SUM(f.bytes), 0) FROM artifacts f
       WHERE f.project_id = m.project_id)
      + (SELECT COALESCE(SUM(o.stored_bytes), 0)
         FROM project_document_objects o WHERE o.project_id = m.project_id)
      + (SELECT COALESCE(SUM(a.stored_bytes), 0)
         FROM project_storage_assets a WHERE a.project_id = m.project_id)
      - (m.state = 'staging') * (
          (SELECT COALESCE(SUM(b.ciphertext_bytes), 0) FROM e2ee_content_blobs b
           WHERE b.project_id = m.project_id)
          + (SELECT COALESCE(SUM(v.envelope_bytes), 0)
             FROM e2ee_project_versions v
             WHERE v.project_id = m.project_id
               AND (v.envelope_key IS NOT NULL OR v.envelope_inline IS NOT NULL)))
    ELSE 0
  END AS bytes
FROM e2ee_project_migrations m JOIN projects p ON p.id = m.project_id
WHERE m.state IN ('staging', 'abandoned');

-- An owner's projected storage is everything counted (project storage
-- and file usage, finalized and reserved) plus what their live stagings
-- would add at their cutovers (`migration_staging_growth`). A migration
-- staging write is admitted while the projected storage stays within the
-- allowance, or while the owner's stagings together, with the write, still
-- shrink what the account stores (the cutover's own growth-only rule), so
-- staging is cumulative and bounded, and an account at or over its
-- allowance can still stage a migration that shrinks it. The triggers below spell
-- the sum out for one owner: a view correlated on the owner would keep
-- SQLite from narrowing the project storage view to that owner.

-- The head a pending document object replaces, when the write that adds it
-- moves the project's head to it (an autosave or named save). A save that
-- replaces a head releases the old one once nothing names it, so the
-- object's admission credits it (below) and a save that does not grow what
-- the account stores is never refused. A checkpoint or copy names none.
ALTER TABLE project_document_objects ADD COLUMN supersedes_object_id TEXT;

-- The head-replacing save's object a source asset was added with, so the
-- save's assets share its one credit (below) instead of each taking it.
ALTER TABLE project_storage_assets ADD COLUMN added_by_object_id TEXT;

-- ---------------------------------------------------------------------------
-- Cloud file side: artifact usage plus the owner's project storage.
-- ---------------------------------------------------------------------------

-- Migration 0022's upload-session admission. A migration staging's
-- session is admitted against the owner's projected storage instead.
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
      NEW.project_id IN (SELECT project_id FROM e2ee_decrypt_staged_projects)
      OR (
        NEW.e2ee_blob_kind IS NOT NULL
        AND (SELECT storage_format FROM projects WHERE id = NEW.project_id) = 1
      )
    )
    AND (COALESCE((SELECT bytes FROM account_project_storage WHERE user_id = NEW.owner_user_id), 0)
      + COALESCE((SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
                  WHERE owner_user_id = NEW.owner_user_id), 0)
      + COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = NEW.owner_user_id), 0)) >= COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = NEW.owner_user_id), 2147483648)
    -- ...unless the owner's stagings together still shrink what it stores.
    AND COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = NEW.owner_user_id), 0) >= 0;

  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE NEW.project_id NOT IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND NOT (
      NEW.e2ee_blob_kind IS NOT NULL
      AND (SELECT storage_format FROM projects WHERE id = NEW.project_id) = 1
    )
    AND (
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

  -- A decrypt staging's file: against the owner's projected storage, less
  -- the reservation it releases.
  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE NEW.project_id IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND (COALESCE((SELECT bytes FROM account_project_storage WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
                  WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)) + NEW.bytes
      - COALESCE((
          SELECT reserved_bytes FROM upload_sessions
          WHERE artifact_id = NEW.id AND project_id = NEW.project_id
            AND reservation_state = 'completed' AND reserved_bytes = NEW.bytes
        ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    AND NEW.bytes > COALESCE((
      SELECT reserved_bytes FROM upload_sessions
      WHERE artifact_id = NEW.id AND project_id = NEW.project_id
        AND reservation_state = 'completed' AND reserved_bytes = NEW.bytes
    ), 0)
    -- ...unless the owner's stagings together, with this write, still
    -- shrink what it stores (only growth is refused).
    AND COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + NEW.bytes - COALESCE((SELECT reserved_bytes FROM upload_sessions WHERE artifact_id = NEW.id AND project_id = NEW.project_id AND reservation_state = 'completed' AND reserved_bytes = NEW.bytes), 0) > 0;
END;

-- Migration 0022's multipart part reservation. The in-flight reservation
-- check (`artifact_reserved_byte_limit`) is unchanged: it bounds reserved
-- bytes alone, against the mirrored `artifact_limit_bytes`. A migration
-- staging's part is checked against the owner's projected storage.
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
  WHERE NOT EXISTS (
      SELECT 1 FROM migration_staging_upload_sessions
      WHERE id = NEW.upload_session_id
    )
    AND (
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

  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE EXISTS (
      SELECT 1 FROM migration_staging_upload_sessions
      WHERE id = NEW.upload_session_id
    )
    AND (COALESCE((SELECT bytes FROM account_project_storage WHERE user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 0)
      + COALESCE((SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
                  WHERE owner_user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 0)
      + COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 0)) + NEW.bytes
      - COALESCE((
        SELECT bytes FROM artifact_upload_parts
        WHERE upload_session_id = NEW.upload_session_id
          AND part_number = NEW.part_number
      ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 2147483648)
    AND NEW.bytes > COALESCE((SELECT bytes FROM artifact_upload_parts WHERE upload_session_id = NEW.upload_session_id AND part_number = NEW.part_number), 0)
    -- ...unless the owner's stagings together, with this write, still
    -- shrink what it stores (only growth is refused).
    AND COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 0)
      + NEW.bytes - COALESCE((SELECT bytes FROM artifact_upload_parts WHERE upload_session_id = NEW.upload_session_id AND part_number = NEW.part_number), 0) > 0;
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
  WHERE NOT EXISTS (
      SELECT 1 FROM migration_staging_upload_sessions
      WHERE id = NEW.upload_session_id
    )
    AND (
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

  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE EXISTS (
      SELECT 1 FROM migration_staging_upload_sessions
      WHERE id = NEW.upload_session_id
    )
    AND (COALESCE((SELECT bytes FROM account_project_storage WHERE user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 0)
      + COALESCE((SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
                  WHERE owner_user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 0)
      + COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 0)) + NEW.bytes - OLD.bytes
      > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 2147483648)
    AND NEW.bytes > OLD.bytes
    -- ...unless the owner's stagings together, with this write, still
    -- shrink what it stores (only growth is refused).
    AND COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT owner_user_id FROM upload_sessions WHERE id = NEW.upload_session_id)), 0)
      + NEW.bytes - OLD.bytes > 0;
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

-- An encrypt staging's blob (decision M10: it counts from the cutover on)
-- is checked against the owner's projected storage, less the reservation
-- it releases.
DROP TRIGGER IF EXISTS e2ee_staged_blob_quota_before_insert;
CREATE TRIGGER e2ee_staged_blob_quota_before_insert
BEFORE INSERT ON e2ee_content_blobs
WHEN (SELECT storage_format FROM projects WHERE id = NEW.project_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'artifact_account_quota')
  WHERE (COALESCE((SELECT bytes FROM account_project_storage WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
                  WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)) + NEW.ciphertext_bytes
      - COALESCE((
          SELECT sessions.reserved_bytes
          FROM upload_sessions sessions
          WHERE sessions.artifact_id = NEW.blob_id
            AND sessions.project_id = NEW.project_id
            AND sessions.reservation_state = 'completed'
            AND sessions.reserved_bytes = NEW.ciphertext_bytes
        ), 0) > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    AND NEW.ciphertext_bytes > COALESCE((
      SELECT reserved_bytes FROM upload_sessions
      WHERE artifact_id = NEW.blob_id AND project_id = NEW.project_id
        AND reservation_state = 'completed'
        AND reserved_bytes = NEW.ciphertext_bytes
    ), 0)
    -- ...unless the owner's stagings together, with this write, still
    -- shrink what it stores (only growth is refused).
    AND COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + NEW.ciphertext_bytes - COALESCE((SELECT reserved_bytes FROM upload_sessions WHERE artifact_id = NEW.blob_id AND project_id = NEW.project_id AND reservation_state = 'completed' AND reserved_bytes = NEW.ciphertext_bytes), 0) > 0;
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
  -- A decrypt staging's document: against the projected storage.
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.project_id IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND NEW.stored_bytes > 0
    AND (COALESCE((SELECT bytes FROM account_project_storage WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
                  WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)) + NEW.stored_bytes
      > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    -- ...unless the owner's stagings together, with this write, still
    -- shrink what it stores (only growth is refused).
    AND COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + NEW.stored_bytes > 0;
  -- A head-replacing write is credited the head it releases: still the
  -- project's head, named by no save state, claimed by no other pending
  -- object (so a retried or conflicting save cannot claim it twice), and
  -- only while the project holds no other unreclaimed object (a replaced
  -- head whose pruning failed), so at most one replacement's credit is
  -- ever outstanding per project. Only growth is refused.
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.project_id NOT IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND NEW.stored_bytes - COALESCE((
      SELECT head.stored_bytes FROM project_document_objects head
      JOIN projects hp ON hp.id = head.project_id
        AND hp.document_object_id = head.id
      WHERE head.id = NEW.supersedes_object_id
        AND head.project_id = NEW.project_id
        AND NOT EXISTS (
          SELECT 1 FROM revisions hr WHERE hr.document_object_id = head.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_document_objects claim
          WHERE claim.project_id = NEW.project_id
            AND claim.supersedes_object_id = head.id
            AND claim.state = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_document_objects spare
          WHERE spare.project_id = NEW.project_id
            AND spare.state = 'committed'
            AND spare.id <> head.id
            AND NOT EXISTS (
              SELECT 1 FROM revisions sr WHERE sr.document_object_id = spare.id
            )
        )
    ), 0) > 0
    AND NEW.stored_bytes - COALESCE((
      SELECT head.stored_bytes FROM project_document_objects head
      JOIN projects hp ON hp.id = head.project_id
        AND hp.document_object_id = head.id
      WHERE head.id = NEW.supersedes_object_id
        AND head.project_id = NEW.project_id
        AND NOT EXISTS (
          SELECT 1 FROM revisions hr WHERE hr.document_object_id = head.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_document_objects claim
          WHERE claim.project_id = NEW.project_id
            AND claim.supersedes_object_id = head.id
            AND claim.state = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_document_objects spare
          WHERE spare.project_id = NEW.project_id
            AND spare.state = 'committed'
            AND spare.id <> head.id
            AND NOT EXISTS (
              SELECT 1 FROM revisions sr WHERE sr.document_object_id = spare.id
            )
        )
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

DROP TRIGGER IF EXISTS project_account_asset_bytes_before_insert;
CREATE TRIGGER project_account_asset_bytes_before_insert
BEFORE INSERT ON project_storage_assets
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_invalid')
  WHERE typeof(NEW.stored_bytes) <> 'integer' OR NEW.stored_bytes < 0
    OR NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  -- A decrypt staging's source asset: against the projected storage.
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.project_id IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND NOT EXISTS (
      SELECT 1 FROM project_storage_assets
      WHERE project_id = NEW.project_id
        AND checksum_sha256 = NEW.checksum_sha256 AND kind = NEW.kind
    )
    AND NEW.stored_bytes > 0
    AND (COALESCE((SELECT bytes FROM account_project_storage WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
                  WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)) + NEW.stored_bytes
      > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    -- ...unless the owner's stagings together, with this write, still
    -- shrink what it stores (only growth is refused).
    AND COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + NEW.stored_bytes > 0;
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.project_id NOT IN (
      SELECT project_id FROM e2ee_decrypt_staged_projects
    )
    AND NOT EXISTS (
      SELECT 1 FROM project_storage_assets
      WHERE project_id = NEW.project_id
        AND checksum_sha256 = NEW.checksum_sha256 AND kind = NEW.kind
    )
    -- A source asset of the save that just moved the head (the asset names
    -- that save's object) is judged with that save: what the account
    -- stores once the replaced head is pruned (under the object's credit
    -- rules), refused only if the save as a whole grows it. The save's
    -- earlier assets have already used their share of the credit.
    AND NEW.stored_bytes - COALESCE((
      SELECT old.stored_bytes - cur.stored_bytes - COALESCE((
          SELECT SUM(prior.stored_bytes) FROM project_storage_assets prior
          WHERE prior.project_id = rp.id
            AND prior.added_by_object_id = cur.id
        ), 0)
      FROM projects rp
      JOIN project_document_objects cur
        ON cur.id = rp.document_object_id AND cur.project_id = rp.id
      JOIN project_document_objects old
        ON old.id = cur.supersedes_object_id AND old.project_id = rp.id
      WHERE rp.id = NEW.project_id
        AND cur.id = NEW.added_by_object_id
        AND old.state = 'committed'
        AND NOT EXISTS (
          SELECT 1 FROM revisions orr WHERE orr.document_object_id = old.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_document_objects spare
          WHERE spare.project_id = rp.id
            AND spare.state = 'committed'
            AND spare.id NOT IN (cur.id, old.id)
            AND NOT EXISTS (
              SELECT 1 FROM revisions sr WHERE sr.document_object_id = spare.id
            )
        )
    ), 0) > 0
    AND NEW.stored_bytes - COALESCE((
      SELECT old.stored_bytes FROM projects rp
      JOIN project_document_objects cur
        ON cur.id = rp.document_object_id AND cur.project_id = rp.id
      JOIN project_document_objects old
        ON old.id = cur.supersedes_object_id AND old.project_id = rp.id
      WHERE rp.id = NEW.project_id
        AND cur.id = NEW.added_by_object_id
        AND old.state = 'committed'
        AND NOT EXISTS (
          SELECT 1 FROM revisions orr WHERE orr.document_object_id = old.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM project_document_objects spare
          WHERE spare.project_id = rp.id
            AND spare.state = 'committed'
            AND spare.id NOT IN (cur.id, old.id)
            AND NOT EXISTS (
              SELECT 1 FROM revisions sr WHERE sr.document_object_id = spare.id
            )
        )
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

-- An encrypt staging's version (decision M10: it counts from the cutover
-- on) is checked against the owner's projected storage.
DROP TRIGGER IF EXISTS e2ee_staged_version_quota;
CREATE TRIGGER e2ee_staged_version_quota
BEFORE INSERT ON e2ee_project_versions
WHEN (SELECT storage_format FROM projects WHERE id = NEW.project_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.envelope_bytes > 0
    AND (COALESCE((SELECT bytes FROM account_project_storage WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT finalized_bytes + reserved_bytes FROM artifact_account_usage
                  WHERE owner_user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)) + NEW.envelope_bytes
      > COALESCE((SELECT project_storage_limit_bytes FROM users WHERE id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 2147483648)
    -- ...unless the owner's stagings together, with this write, still
    -- shrink what it stores (only growth is refused).
    AND COALESCE((SELECT SUM(bytes) FROM migration_staging_growth
                  WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)), 0)
      + NEW.envelope_bytes > 0;
END;
