-- ADR-024 Phase 4, slice 4-6 (roadmap L11): encrypted content blobs, the
-- imported sources, mesh payloads and reference-image pictures of
-- end-to-end encrypted projects. Browsers encrypt each blob under its own
-- random key and upload the ciphertext through the ordinary upload sessions;
-- the key and the ciphertext hash travel only inside the encrypted document
-- that references the blob. The routes stay closed behind
-- E2EE_PROJECTS_ENABLED.
-- Ordinary traffic does not depend on this migration: until it is applied,
-- no statement outside the encrypted-project routes names the new column or
-- tables (they probe for them first), and those routes answer 503.

-- An upload session that carries an encrypted content blob names the blob's
-- kind here; NULL is an ordinary artifact upload. Its `artifact_id` is the
-- blob id the browser proposed (the header's `blobId`), and its object key
-- is the opaque `e2ee/<projectId>/<blobId>`. Finalizing it commits an
-- `e2ee_content_blobs` row, never an `artifacts` row.
ALTER TABLE upload_sessions ADD COLUMN e2ee_blob_kind TEXT
  CHECK (e2ee_blob_kind IS NULL OR e2ee_blob_kind IN
    ('import-source', 'mesh-payload', 'thumbnail', 'export'));

-- One committed content blob of an encrypted project. `kind` and
-- `ciphertext_bytes` are what the envelope header and the stored object
-- showed the Worker; `dedupe_tag` is the browser's HMAC of the plaintext
-- under the project's dedupe secret, an index value the Worker cannot test
-- known files against. `state` is `deleting` once garbage collection has
-- claimed a blob no retained version references; the row goes after its
-- object does.
CREATE TABLE e2ee_content_blobs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL CHECK (length(blob_id) = 32),
  kind TEXT NOT NULL
    CHECK (kind IN ('import-source', 'mesh-payload', 'thumbnail', 'export')),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) <= 512),
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes > 0),
  dedupe_tag TEXT CHECK (dedupe_tag IS NULL OR length(dedupe_tag) = 64),
  state TEXT NOT NULL DEFAULT 'committed'
    CHECK (state IN ('committed', 'deleting')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, blob_id),
  UNIQUE (project_id, dedupe_tag)
);

-- Which blobs each accepted document version names in its header: the
-- reference count garbage collection reads. Only versions whose body is
-- retained (the head and named saves) keep their blobs alive.
CREATE TABLE e2ee_version_blobs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_hash TEXT NOT NULL CHECK (length(version_hash) = 64),
  blob_id TEXT NOT NULL CHECK (length(blob_id) = 32),
  PRIMARY KEY (project_id, version_hash, blob_id)
);

CREATE INDEX IF NOT EXISTS e2ee_version_blobs_blob
  ON e2ee_version_blobs (project_id, blob_id);

-- A version may name only committed blobs of its own project. Raising here
-- rolls back the whole save batch, version row included.
CREATE TRIGGER IF NOT EXISTS e2ee_version_blob_committed
BEFORE INSERT ON e2ee_version_blobs
WHEN NOT EXISTS (
  SELECT 1 FROM e2ee_content_blobs
  WHERE project_id = NEW.project_id AND blob_id = NEW.blob_id
    AND state = 'committed'
)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_BLOB_UNKNOWN');
END;

-- Garbage collection may claim only a blob no retained version names.
CREATE TRIGGER IF NOT EXISTS e2ee_content_blob_referenced
BEFORE UPDATE OF state ON e2ee_content_blobs
WHEN NEW.state = 'deleting' AND OLD.state = 'committed' AND EXISTS (
  SELECT 1 FROM e2ee_version_blobs refs
  JOIN e2ee_project_versions versions
    ON versions.project_id = refs.project_id
   AND versions.version_hash = refs.version_hash
  WHERE refs.project_id = OLD.project_id AND refs.blob_id = OLD.blob_id
    AND (versions.envelope_key IS NOT NULL
         OR versions.envelope_inline IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_BLOB_REFERENCED');
END;

-- A committed blob leaves only through that claim, or with its project.
CREATE TRIGGER IF NOT EXISTS e2ee_content_blob_release
BEFORE DELETE ON e2ee_content_blobs
WHEN OLD.state <> 'deleting'
  AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_BLOB_NOT_RELEASED');
END;

-- What the Worker accepted about a blob never changes; only its state moves
-- forward and its dedupe tag can be given up to a newer upload.
CREATE TRIGGER IF NOT EXISTS e2ee_content_blob_immutable
BEFORE UPDATE ON e2ee_content_blobs
WHEN NEW.project_id <> OLD.project_id
  OR NEW.blob_id <> OLD.blob_id
  OR NEW.kind <> OLD.kind
  OR NEW.object_key <> OLD.object_key
  OR NEW.ciphertext_bytes <> OLD.ciphertext_bytes
  OR NEW.created_at <> OLD.created_at
  OR (OLD.state = 'deleting' AND NEW.state <> 'deleting')
  OR (NEW.dedupe_tag IS NOT NULL AND NEW.dedupe_tag IS NOT OLD.dedupe_tag)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_BLOB_IMMUTABLE');
END;

-- Content blobs share the artifact accounting of migrations 0017 and 0022:
-- committed ciphertext counts as finalized artifact bytes against the
-- owner's artifact limit, and committing deducts the upload session's own
-- reservation, exactly as an artifact insert does.
CREATE TRIGGER IF NOT EXISTS e2ee_content_blob_usage_before_insert
BEFORE INSERT ON e2ee_content_blobs
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

CREATE TRIGGER IF NOT EXISTS e2ee_content_blob_usage_after_insert
AFTER INSERT ON e2ee_content_blobs
BEGIN
  UPDATE artifact_account_usage
  SET finalized_bytes = finalized_bytes + NEW.ciphertext_bytes
  WHERE owner_user_id = (
    SELECT user_id FROM projects WHERE id = NEW.project_id
  );
END;

CREATE TRIGGER IF NOT EXISTS e2ee_content_blob_usage_after_delete
AFTER DELETE ON e2ee_content_blobs
BEGIN
  UPDATE artifact_account_usage
  SET finalized_bytes = finalized_bytes - OLD.ciphertext_bytes
  WHERE owner_user_id = (
    SELECT user_id FROM projects WHERE id = OLD.project_id
  );
END;

-- An encrypted blob's session never becomes an artifact, whichever Worker
-- version tries.
CREATE TRIGGER IF NOT EXISTS e2ee_blob_session_not_artifact
BEFORE INSERT ON artifacts
WHEN EXISTS (
  SELECT 1 FROM upload_sessions
  WHERE artifact_id = NEW.id AND e2ee_blob_kind IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_BLOB_NOT_ARTIFACT');
END;

-- Writes also carry the session/erasure predicate in their own SQL (see
-- e2eeWriteAuthorization); these fences hold for any other writer as well.
-- Erasure itself claims and deletes blobs, so only that move is let through.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_content_blob_insert
BEFORE INSERT ON e2ee_content_blobs
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_content_blob_update
BEFORE UPDATE ON e2ee_content_blobs
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
) AND NOT (NEW.state = 'deleting' AND NEW.dedupe_tag IS OLD.dedupe_tag)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_version_blob_insert
BEFORE INSERT ON e2ee_version_blobs
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
