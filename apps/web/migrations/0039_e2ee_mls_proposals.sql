-- ADR-024 Phase 5, slice 5-5 (roadmap L11): MLS proposals stored for
-- another member to commit, so far only a departing member's SelfRemove.
-- A Commit may not remove its own sender (RFC 9420 §12.2), so a member
-- leaves by a SelfRemove proposal that any remaining member, a viewer
-- included, commits by reference. The Worker stores the proposal with the
-- epoch it was sent in, and drops the sender's access in the same batch
-- (plan decision M4): its project_members row, its account-wrapped keys
-- and its assistant consent go then, not when someone commits.
--
-- Every member Commit for a key epoch must settle every proposal still
-- pending in it, by stating it as applied (committed by reference) or, if
-- the committer's MLS engine refused it, as rejected; the Commit row's
-- insert is gated on that, so a departure cannot be left behind by a Commit
-- that raced it. An external Commit (a rejoin, which cannot carry proposals
-- by reference) is refused while one is pending.
--
-- Ordinary traffic does not depend on this migration: until it is applied,
-- no statement names the table (the Worker probes for it first), leaving
-- answers 503, the proposal listing is empty, and Commits, removals by the
-- owner and role changes work as before. Everything stays behind
-- E2EE_KEYS_ENABLED and E2EE_PROJECTS_ENABLED.
--
-- Numbering: 0035 is an unused gap, 0036 is slice 4-10, 0037 slice 5-1,
-- 0038 slice 5-3a and 0041 slice 6-1; renumber at merge time if needed.

CREATE TABLE e2ee_mls_proposals (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The key epoch (the group's key-epoch base plus the MLS epoch) the
  -- proposal was sent in; key epochs never repeat across group resets
  -- (decision D10).
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 0),
  -- SHA-256 hex of the proposal message bytes, computed by the Worker.
  proposal_hash TEXT NOT NULL CHECK (length(proposal_hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('self-remove')),
  -- Null once the sender's account was erased, as for Commits.
  sender_user_id TEXT,
  sender_device_id TEXT
    CHECK (sender_device_id IS NULL OR length(sender_device_id) BETWEEN 1 AND 128),
  -- base64url of the MLS PublicMessage proposal, at most 16 KiB raw.
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 21846),
  created_at TEXT NOT NULL,
  -- How the Commit that settled it treated it, and the key epoch that
  -- Commit moved the group to; both null while pending.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('committed', 'rejected')),
  settled_key_epoch INTEGER
    CHECK (settled_key_epoch IS NULL OR settled_key_epoch > key_epoch),
  PRIMARY KEY (project_id, key_epoch, proposal_hash),
  CHECK ((outcome IS NULL) = (settled_key_epoch IS NULL))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS e2ee_mls_proposals_pending
  ON e2ee_mls_proposals(project_id, key_epoch)
  WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS e2ee_mls_proposals_sender
  ON e2ee_mls_proposals(sender_user_id)
  WHERE sender_user_id IS NOT NULL;

-- A stored proposal never changes; only its settlement moves, once, and
-- erasure clears its sender.
CREATE TRIGGER IF NOT EXISTS e2ee_mls_proposal_immutable
BEFORE UPDATE ON e2ee_mls_proposals
WHEN NEW.project_id <> OLD.project_id OR NEW.key_epoch <> OLD.key_epoch
  OR NEW.proposal_hash <> OLD.proposal_hash OR NEW.kind <> OLD.kind
  OR NEW.message <> OLD.message OR NEW.created_at <> OLD.created_at
  OR (NEW.sender_user_id IS NOT NULL
      AND NEW.sender_user_id IS NOT OLD.sender_user_id)
  OR (NEW.sender_device_id IS NOT NULL
      AND NEW.sender_device_id IS NOT OLD.sender_device_id)
  OR (OLD.outcome IS NOT NULL
      AND (NEW.outcome IS NOT OLD.outcome
           OR NEW.settled_key_epoch IS NOT OLD.settled_key_epoch))
BEGIN
  SELECT RAISE(ABORT, 'E2EE_PROPOSAL_IMMUTABLE');
END;

-- Writes also carry the session/erasure predicate in their own SQL (see
-- e2eeWriteAuthorization); this fence holds for any other writer as well.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_mls_proposal_insert
BEFORE INSERT ON e2ee_mls_proposals
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.sender_user_id
) OR EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
