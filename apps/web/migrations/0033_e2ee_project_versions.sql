-- ADR-024 Phase 4, slice 4-5 (roadmap L11): encrypted document versions.
-- The Worker stores what browsers encrypted and signed, and keeps the
-- version log browsers check for rollback and forks (decision D1). It never
-- sees a document, a revision name or a project name. The routes stay
-- closed behind E2EE_PROJECTS_ENABLED.
-- Ordinary traffic does not depend on this migration: until it is applied,
-- no statement outside the encrypted-project routes names these tables
-- (they probe for them first), and those routes answer 503.

-- The version log: one row per signed document envelope the Worker accepted,
-- keyed by its document version. `version_hash` is lowercase hex SHA-256 of
-- the whole envelope, computed by the Worker. `prefix` (base64url) is the
-- envelope prefix and `signature` the author's v1 signature, so a record
-- verifies without the body. The body lives in R2 under `envelope_key` or
-- inline (base64url) in `envelope_inline`; both are cleared once the body
-- is pruned (an autosave replaced it and no retained revision names it),
-- and the log row stays. `envelope_bytes` is the ciphertext size quotas
-- count while the body is retained. The signer columns name who signed;
-- erasure clears the user.
CREATE TABLE e2ee_project_versions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_version INTEGER NOT NULL CHECK (document_version >= 1),
  version_hash TEXT NOT NULL CHECK (length(version_hash) = 64),
  key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 0 AND 4294967295),
  prefix TEXT NOT NULL CHECK (length(prefix) BETWEEN 11 AND 1398115),
  signature TEXT NOT NULL CHECK (length(signature) = 98),
  signer_user_id TEXT,
  signer_device_id TEXT NOT NULL
    CHECK (length(signer_device_id) BETWEEN 1 AND 128),
  envelope_key TEXT CHECK (envelope_key IS NULL OR length(envelope_key) <= 512),
  envelope_inline TEXT,
  envelope_bytes INTEGER NOT NULL CHECK (envelope_bytes > 0),
  wrapped_version_key TEXT NOT NULL CHECK (length(wrapped_version_key) = 55),
  created_at TEXT NOT NULL,
  CHECK (envelope_key IS NULL OR envelope_inline IS NULL),
  PRIMARY KEY (project_id, document_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS e2ee_project_versions_hash
  ON e2ee_project_versions (project_id, version_hash);

-- Named saves: a revision names the version it was saved as. Its body is
-- retained while the row exists (the newest MAX_PROJECT_REVISIONS per
-- project), and so is its log row (decision D6). Its name lives inside the
-- encrypted document, never here.
CREATE TABLE e2ee_project_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL CHECK (length(revision_id) BETWEEN 1 AND 128),
  document_version INTEGER NOT NULL CHECK (document_version >= 1),
  version_hash TEXT NOT NULL CHECK (length(version_hash) = 64),
  author_user_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS e2ee_project_revisions_version
  ON e2ee_project_revisions (project_id, document_version);

-- Small signed project envelopes that are replaced as a whole: the
-- project-info envelope (name, thumbnail reference, archived exports) now,
-- measurements and view state later. `sequence` only moves forward; the
-- browser signs it into nothing, so it pins the newest sequence it saw.
CREATE TABLE e2ee_project_envelopes (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('project-info', 'measurements', 'view-state')),
  scope TEXT NOT NULL DEFAULT '' CHECK (length(scope) <= 128),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 0 AND 4294967295),
  envelope TEXT NOT NULL CHECK (length(envelope) BETWEEN 1 AND 1403670),
  wrapped_version_key TEXT NOT NULL CHECK (length(wrapped_version_key) = 55),
  signature TEXT NOT NULL CHECK (length(signature) = 98),
  signer_device_id TEXT NOT NULL
    CHECK (length(signer_device_id) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind, scope)
);

-- An accepted version is never rewritten: only its body pointers may be
-- cleared (pruning) and its signer user cleared (erasure).
CREATE TRIGGER IF NOT EXISTS e2ee_project_version_immutable
BEFORE UPDATE ON e2ee_project_versions
WHEN NEW.project_id <> OLD.project_id
  OR NEW.document_version <> OLD.document_version
  OR NEW.version_hash <> OLD.version_hash
  OR NEW.key_epoch <> OLD.key_epoch
  OR NEW.prefix <> OLD.prefix
  OR NEW.signature <> OLD.signature
  OR NEW.signer_device_id <> OLD.signer_device_id
  OR NEW.envelope_bytes <> OLD.envelope_bytes
  OR NEW.wrapped_version_key <> OLD.wrapped_version_key
  OR NEW.created_at <> OLD.created_at
  OR (NEW.signer_user_id IS NOT NULL
      AND NEW.signer_user_id IS NOT OLD.signer_user_id)
  OR (NEW.envelope_key IS NOT NULL
      AND NEW.envelope_key IS NOT OLD.envelope_key)
  OR (NEW.envelope_inline IS NOT NULL
      AND NEW.envelope_inline IS NOT OLD.envelope_inline)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_VERSION_IMMUTABLE');
END;

-- A replaced envelope's sequence only moves forward, whoever writes.
CREATE TRIGGER IF NOT EXISTS e2ee_project_envelope_forward
BEFORE UPDATE ON e2ee_project_envelopes
WHEN NEW.sequence <= OLD.sequence OR NEW.project_id <> OLD.project_id
  OR NEW.kind <> OLD.kind OR NEW.scope <> OLD.scope
  OR NEW.key_epoch < OLD.key_epoch
BEGIN
  SELECT RAISE(ABORT, 'E2EE_ENVELOPE_SEQUENCE');
END;

-- Retained ciphertext counts against the owner's project storage, with the
-- R2 document objects and assets of plaintext projects (migration 0022's
-- limit). A body the same batch pruned first no longer counts.
CREATE TRIGGER IF NOT EXISTS e2ee_project_version_quota
BEFORE INSERT ON e2ee_project_versions
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.envelope_bytes +
    COALESCE((
      SELECT SUM(versions.envelope_bytes)
      FROM e2ee_project_versions versions
      JOIN projects owner ON owner.id = versions.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
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

-- Writes also carry the session/erasure predicate in their own SQL (see
-- e2eeWriteAuthorization); these fences hold for any other writer as well.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_version_insert
BEFORE INSERT ON e2ee_project_versions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
) OR EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.signer_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

-- Not fenced on the signer: erasure itself clears the signer column.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_version_update
BEFORE UPDATE ON e2ee_project_versions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_revision_insert
BEFORE INSERT ON e2ee_project_revisions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_revision_update
BEFORE UPDATE ON e2ee_project_revisions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_envelope_insert
BEFORE INSERT ON e2ee_project_envelopes
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_envelope_update
BEFORE UPDATE ON e2ee_project_envelopes
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
