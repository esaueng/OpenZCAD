-- ADR-024 Phase 4, slice 4-1 (roadmap L11): a storage format per project and
-- the account's "encrypt new projects" opt-in. Nothing here encrypts data or
-- turns a feature on: the routes that use the opt-in stay closed behind
-- E2EE_PROJECTS_ENABLED, and no API path creates a format-2 project yet.
-- The Worker does not depend on it for ordinary traffic: until it is applied,
-- no statement names these objects, every project reads as format 1, and
-- encrypted projects stay reported as unavailable.

-- 1 = plaintext (every existing row), 2 = end-to-end encrypted (e2ee-v1).
-- The Worker refuses every document, revision, measurement, view-state and
-- room route on a format-2 project with 409 PROJECT_FORMAT_UNSUPPORTED until
-- the encrypted paths exist, and never parses its document_json.
ALTER TABLE projects ADD COLUMN storage_format INTEGER NOT NULL DEFAULT 1
  CHECK (storage_format IN (1, 2));

-- One row per account that has set the opt-in. `record` is the base64url
-- canonical JSON {v, kind, userId, encryptNewProjects, sequence} and
-- `record_mac` its HMAC-SHA-256 under a key the browser derives from the
-- account key; the Worker cannot verify the MAC and browsers trust nothing
-- else. The Worker reads `encrypt_new_projects` only to refuse plaintext
-- creates (decision D2) and requires `sequence` to increase on every write.
-- Profile data: it goes with the user on erasure, like the key tables.
CREATE TABLE e2ee_project_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypt_new_projects INTEGER NOT NULL CHECK (encrypt_new_projects IN (0, 1)),
  record TEXT NOT NULL CHECK (length(record) BETWEEN 1 AND 683),
  record_mac TEXT NOT NULL CHECK (length(record_mac) = 43),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- Writes also carry the session/erasure predicate in their own SQL, as the
-- key tables' do; these fences hold for any other writer as well.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_preference_insert
BEFORE INSERT ON e2ee_project_preferences
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id IN (NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_preference_update
BEFORE UPDATE ON e2ee_project_preferences
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

-- Decision D2 in the same write as the project: an account that has opted
-- in gets no new plaintext project, whichever path inserts it (create,
-- adopt, duplicate) and however it races a preference write. The Worker
-- checks first for a clear refusal; this closes the window between that read
-- and the insert. The Worker maps the abort to 409 ENCRYPTED_PROJECTS_REQUIRED.
-- Operations note: turning E2EE_PROJECTS_ENABLED off for an account that has
-- opted in keeps refusing its plaintext creates until its row here is
-- cleared or set to 0.
CREATE TRIGGER IF NOT EXISTS e2ee_projects_require_encryption
BEFORE INSERT ON projects
WHEN NEW.storage_format = 1 AND EXISTS (
  SELECT 1 FROM e2ee_project_preferences
  WHERE user_id = NEW.user_id AND encrypt_new_projects = 1
)
BEGIN
  SELECT RAISE(ABORT, 'ENCRYPTED_PROJECTS_REQUIRED');
END;

-- A stored opt-in never moves backwards, whoever writes it.
CREATE TRIGGER IF NOT EXISTS e2ee_project_preference_sequence_forward
BEFORE UPDATE ON e2ee_project_preferences
WHEN NEW.sequence <= OLD.sequence OR NEW.user_id <> OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'E2EE_PREFERENCE_SEQUENCE');
END;
