-- ADR-024 Phase 3 tail (roadmap L11): account-key history. Every rotation
-- of the account key (device or passkey removal, read-only revocation,
-- recovery-key replacement) wraps the key it replaces under its successor,
-- so keys wrapped under an older account key stay reachable. The browser
-- makes every wrap; the Worker stores the AES-KW bytes and never sees a key.
-- The routes stay closed behind E2EE_KEYS_ENABLED.
--
-- One row per replaced account key: (generation, key_sequence) names it by
-- its identity generation and the device-list sequence of the entry that
-- first committed to it. Rows reference the user only, not the identity
-- generation, so pruning replaced identities keeps the history that newer
-- account keys walk back through. Account erasure deletes the rows with
-- the other key tables; deleting the users row cascades to them.

CREATE TABLE e2ee_account_key_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  key_sequence INTEGER NOT NULL CHECK (key_sequence >= 0),
  -- base64url of the 41-byte AES-KW wrap (previous-account-key).
  wrapped TEXT NOT NULL CHECK (length(wrapped) = 55),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, generation, key_sequence)
) WITHOUT ROWID;

-- Writes already carry the erasure fence in their own predicate (see
-- e2eeWriteAuthorization); this trigger fences any other writer too.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_account_key_history_insert
BEFORE INSERT ON e2ee_account_key_history
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id IN (NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_account_key_history_update
BEFORE UPDATE ON e2ee_account_key_history
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
