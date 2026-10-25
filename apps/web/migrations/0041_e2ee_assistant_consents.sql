-- ADR-024 Phase 6, slice 6-1 (roadmap L11): per-project assistant consent
-- on end-to-end encrypted projects, per user and per project (plan default
-- M6). Until now the assistant is off on encrypted projects (decision D7).
-- The routes that write here stay closed behind E2EE_PROJECTS_ENABLED.
-- Ordinary traffic does not depend on this migration: until it is applied,
-- no statement names the table (the Worker probes for it first), the
-- consent routes answer 503, and the assistant keeps refusing every
-- encrypted project exactly as before. Plaintext projects never read it.
-- Numbers 0037-0040 are held by other slices.

-- One row per user and encrypted project that user has answered. `record`
-- is the base64url canonical JSON {v, kind, userId, projectId, allowed,
-- copyVersion, route, sequence} and `record_mac` its HMAC-SHA-256 under a
-- key the browser derives from the account key: the Worker cannot verify
-- the MAC, and browsers trust nothing else. The Worker reads `allowed`,
-- `copy_version`, `route` and `revoked_at` only for its own gate on the
-- assistant route, which is defence in depth and an audit trail, and
-- requires `sequence` to increase on every write. A revocation is the next
-- record with allowed = 0; it stamps `revoked_at`. The row goes with the
-- project on purge and with the user on profile erasure.
CREATE TABLE e2ee_assistant_consents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  copy_version INTEGER NOT NULL CHECK (copy_version >= 1),
  route TEXT NOT NULL CHECK (length(route) <= 256),
  record TEXT NOT NULL CHECK (length(record) BETWEEN 1 AND 1366),
  record_mac TEXT NOT NULL CHECK (length(record_mac) = 43),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (user_id, project_id)
) WITHOUT ROWID;

-- Project purge and the co-member listing read by project.
CREATE INDEX IF NOT EXISTS e2ee_assistant_consents_project
  ON e2ee_assistant_consents (project_id);

-- Writes also carry the session/erasure predicate in their own SQL, as the
-- key tables' do; these fences hold for any other writer as well.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_assistant_consent_insert
BEFORE INSERT ON e2ee_assistant_consents
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id IN (NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_assistant_consent_update
BEFORE UPDATE ON e2ee_assistant_consents
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

-- A stored consent never moves backwards or changes hands, whoever writes it.
CREATE TRIGGER IF NOT EXISTS e2ee_assistant_consent_sequence_forward
BEFORE UPDATE ON e2ee_assistant_consents
WHEN NEW.sequence <= OLD.sequence
  OR NEW.user_id <> OLD.user_id
  OR NEW.project_id <> OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'E2EE_ASSISTANT_CONSENT_SEQUENCE');
END;
