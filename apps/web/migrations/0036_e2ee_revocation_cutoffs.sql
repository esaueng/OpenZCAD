-- ADR-024 Phase 4, slice 4-10 (roadmap L11): device removal across encrypted
-- projects, and the owner-only solo group reset (decision D9). The routes
-- stay closed behind E2EE_KEYS_ENABLED and E2EE_PROJECTS_ENABLED.
-- Ordinary traffic does not depend on this migration: until it is applied,
-- no statement outside the device-removal and reset routes, project purge
-- and account erasure names these tables (they probe for them first), and
-- those routes answer 503.
-- (Number 0035 is held for slice 4-7.)

-- The identity-signed per-project revocation cutoffs of one device-list entry
-- that revokes devices (`encodeRevocationCutoffs`, "OZR"): for each project
-- the user owned, the first key epoch the revoked devices must not know and
-- the newest head the revoking browser had accepted. Browsers verify the
-- statement against the device list before using it; the Worker checks it
-- too. A later statement for the same entry may replace an earlier one only
-- if it keeps every project with a cutoff no lower.
CREATE TABLE e2ee_revocation_cutoffs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  entry_sequence INTEGER NOT NULL CHECK (entry_sequence >= 1),
  -- Hex `deviceListEntryHash` of the revoking entry.
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
  -- base64url of the canonical statement and its 65-byte signature.
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 966900),
  signature TEXT NOT NULL CHECK (length(signature) = 87),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, generation, entry_sequence)
) WITHOUT ROWID;

-- One row per identity-authorized solo group reset (decision D9), the
-- public record a collaborator's browser checks for a fork. `generation`
-- and `key_epoch_base` are the new group's; the prior group's id and epoch
-- are kept for the record. The statement (`encodeGroupReset`, "OZX") is
-- signed by the owner's identity key.
CREATE TABLE e2ee_group_resets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  key_epoch_base INTEGER NOT NULL
    CHECK (key_epoch_base BETWEEN 1 AND 4294967295),
  prior_group_id TEXT NOT NULL CHECK (length(prior_group_id) BETWEEN 1 AND 128),
  prior_epoch INTEGER NOT NULL CHECK (prior_epoch >= 0),
  identity_generation INTEGER NOT NULL CHECK (identity_generation >= 1),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 430),
  signature TEXT NOT NULL CHECK (length(signature) = 87),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, generation)
) WITHOUT ROWID;

-- A reset is the one way a group row may start over at epoch 0: the next
-- generation, a key-epoch base right after the replaced group's newest key
-- epoch (decision D10), and only with its reset recorded. Otherwise the
-- sequencer still never moves backwards, whoever writes (migration 0032).
DROP TRIGGER IF EXISTS e2ee_project_group_forward;

CREATE TRIGGER e2ee_project_group_forward
BEFORE UPDATE ON e2ee_project_groups
WHEN NEW.project_id <> OLD.project_id
  OR NEW.generation < OLD.generation
  OR (NEW.generation = OLD.generation
      AND (NEW.epoch < OLD.epoch OR NEW.key_epoch_base < OLD.key_epoch_base))
  OR (NEW.generation > OLD.generation
      AND (NEW.generation <> OLD.generation + 1
           OR NEW.epoch <> 0
           OR NEW.key_epoch_base <> OLD.key_epoch_base + OLD.epoch + 1
           OR NOT EXISTS (
             SELECT 1 FROM e2ee_group_resets r
             WHERE r.project_id = NEW.project_id
               AND r.generation = NEW.generation
               AND r.key_epoch_base = NEW.key_epoch_base)))
BEGIN
  SELECT RAISE(ABORT, 'E2EE_GROUP_EPOCH');
END;

-- A recorded reset is never rewritten.
CREATE TRIGGER IF NOT EXISTS e2ee_group_reset_immutable
BEFORE UPDATE ON e2ee_group_resets
BEGIN
  SELECT RAISE(ABORT, 'E2EE_GROUP_RESET_IMMUTABLE');
END;

-- Writes also carry the session/erasure predicate in their own SQL (see
-- e2eeWriteAuthorization); these fences hold for any other writer as well.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_revocation_cutoff_insert
BEFORE INSERT ON e2ee_revocation_cutoffs
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_revocation_cutoff_update
BEFORE UPDATE ON e2ee_revocation_cutoffs
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_group_reset_insert
BEFORE INSERT ON e2ee_group_resets
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
