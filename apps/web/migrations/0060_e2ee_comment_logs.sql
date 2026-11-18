-- L08 encrypted review comments (held for the owner, #1667): on an end-to-end
-- encrypted project each member keeps one comment log, a signed, encrypted
-- `comments` project envelope replaced whole. The account stores ciphertext
-- only: who wrote a log and when stay readable, as for every other envelope
-- (ADR-024, Plaintext metadata). A log goes with its project, and with its
-- writer's account on erasure (accountDeletion.ts).

CREATE TABLE IF NOT EXISTS e2ee_project_comment_logs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 200),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 0 AND 4294967295),
  envelope TEXT NOT NULL CHECK (length(envelope) BETWEEN 1 AND 1403670),
  wrapped_version_key TEXT NOT NULL CHECK (length(wrapped_version_key) = 55),
  signature TEXT NOT NULL CHECK (length(signature) = 98),
  signer_device_id TEXT NOT NULL
    CHECK (length(signer_device_id) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

-- A log's sequence only moves forward, under its own writer and project.
CREATE TRIGGER IF NOT EXISTS e2ee_comment_log_forward
BEFORE UPDATE ON e2ee_project_comment_logs
WHEN NEW.sequence <= OLD.sequence OR NEW.project_id <> OLD.project_id
  OR NEW.user_id <> OLD.user_id OR NEW.key_epoch < OLD.key_epoch
BEGIN
  SELECT RAISE(ABORT, 'E2EE_ENVELOPE_SEQUENCE');
END;

-- Account erasure fences every cloud write before cleanup begins.
CREATE TRIGGER IF NOT EXISTS block_erasing_comment_log_insert
BEFORE INSERT ON e2ee_project_comment_logs
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
