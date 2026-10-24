-- ADR-024 Phase 4, slice 4-4 (roadmap L11): solo MLS groups for end-to-end
-- encrypted projects, the server sequencer and the project key store. The
-- Worker relays and orders MLS handshake messages and stores wrapped keys
-- and signed, encrypted key archives; it never sees a project key, a rejoin
-- PSK or an MLS secret. The routes stay closed behind E2EE_PROJECTS_ENABLED,
-- and no API path creates a format-2 project yet.
-- Ordinary traffic does not depend on this migration: until it is applied,
-- no statement outside the encrypted-project routes names these tables
-- (they probe for them first), and those routes answer 503.

-- One MLS group per encrypted project. `epoch` is the group's current epoch
-- as the sequencer accepted it; `group_info` is the newest GroupInfo (base64url
-- MLSMessage) that lets an owner's device rejoin by external Commit, made in
-- `group_info_epoch`. `initial_group_info` is the signed epoch-zero GroupInfo
-- every join archive starts from. `generation` counts identity-authorized
-- group resets (decision D9) and `key_epoch_base` is the key epoch of this
-- group's epoch 0, so key epochs keep rising across resets (decision D10):
-- key epoch = key_epoch_base + MLS epoch.
CREATE TABLE e2ee_project_groups (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL CHECK (length(group_id) BETWEEN 1 AND 128),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  key_epoch_base INTEGER NOT NULL DEFAULT 0
    CHECK (key_epoch_base BETWEEN 0 AND 4294967295),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  initial_group_info TEXT NOT NULL
    CHECK (length(initial_group_info) BETWEEN 1 AND 349526),
  group_info TEXT NOT NULL CHECK (length(group_info) BETWEEN 1 AND 349526),
  group_info_epoch INTEGER NOT NULL CHECK (group_info_epoch >= 0),
  updated_at TEXT NOT NULL
);

-- The sequencer's log: one accepted Commit per epoch. The primary key makes
-- the first Commit for an epoch win; any later one is refused (409
-- EPOCH_TAKEN) and its sender rebases onto the winner. `epoch` is the epoch
-- the Commit was sent in; applying it yields epoch + 1. `kind` 'external' is
-- an owner device rejoining by external Commit. The sender columns are
-- cleared when that account is erased.
CREATE TABLE e2ee_mls_commits (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('commit', 'external')),
  sender_user_id TEXT,
  sender_device_id TEXT
    CHECK (sender_device_id IS NULL OR length(sender_device_id) BETWEEN 1 AND 128),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 349526),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, epoch)
);

-- Every leaf key a device certified for the project (base64url: the 65-byte
-- P-256 leaf key and the 73-byte version-2 leaf certification). Public; the
-- browsers verify each certification against the device list before the MLS
-- policy sees it.
CREATE TABLE e2ee_project_leaves (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  leaf_key TEXT NOT NULL CHECK (length(leaf_key) = 87),
  certification TEXT NOT NULL CHECK (length(certification) = 98),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, leaf_key)
) WITHOUT ROWID;

-- Per user and key epoch: the project key (decision D1) and the epoch's
-- rejoin PSK, each AES-KW-wrapped (41 bytes) under the user's account key
-- named by (account_key_generation, account_key_sequence). Read-only
-- approved devices read project keys from here (decision D4). Served only
-- to the user they belong to.
CREATE TABLE e2ee_project_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 0 AND 4294967295),
  purpose TEXT NOT NULL CHECK (purpose IN ('project-key', 'rejoin-psk')),
  account_key_generation INTEGER NOT NULL CHECK (account_key_generation >= 1),
  account_key_sequence INTEGER NOT NULL CHECK (account_key_sequence >= 0),
  wrapped TEXT NOT NULL CHECK (length(wrapped) = 55),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id, key_epoch, purpose)
) WITHOUT ROWID;

-- One signed `key-archive` project envelope per key epoch: every earlier
-- project key, the dedupe secret and the epoch's MLS record, encrypted under
-- a version key that is wrapped (`wrapped_version_key`) under that epoch's
-- project key, and signed by the writing device's certified signing key.
CREATE TABLE e2ee_key_archives (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_epoch INTEGER NOT NULL CHECK (key_epoch BETWEEN 0 AND 4294967295),
  envelope TEXT NOT NULL CHECK (length(envelope) BETWEEN 1 AND 1403670),
  wrapped_version_key TEXT NOT NULL CHECK (length(wrapped_version_key) = 55),
  signature TEXT NOT NULL CHECK (length(signature) = 98),
  signer_device_id TEXT NOT NULL CHECK (length(signer_device_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key_epoch)
);

-- The sequencer never moves backwards, whoever writes.
CREATE TRIGGER IF NOT EXISTS e2ee_project_group_forward
BEFORE UPDATE ON e2ee_project_groups
WHEN NEW.epoch < OLD.epoch OR NEW.generation < OLD.generation
  OR NEW.key_epoch_base < OLD.key_epoch_base
  OR NEW.project_id <> OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'E2EE_GROUP_EPOCH');
END;

-- An accepted Commit is never rewritten; only erasure clears its sender.
CREATE TRIGGER IF NOT EXISTS e2ee_mls_commit_immutable
BEFORE UPDATE ON e2ee_mls_commits
WHEN NEW.project_id <> OLD.project_id OR NEW.epoch <> OLD.epoch
  OR NEW.kind <> OLD.kind OR NEW.message <> OLD.message
  OR NEW.created_at <> OLD.created_at
  OR (NEW.sender_user_id IS NOT NULL
      AND NEW.sender_user_id IS NOT OLD.sender_user_id)
  OR (NEW.sender_device_id IS NOT NULL
      AND NEW.sender_device_id IS NOT OLD.sender_device_id)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_COMMIT_IMMUTABLE');
END;

-- Writes also carry the session/erasure predicate in their own SQL (see
-- e2eeWriteAuthorization); these fences hold for any other writer as well.
-- Project rows are fenced by their owner's erasure; user rows by the user's.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_group_insert
BEFORE INSERT ON e2ee_project_groups
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_group_update
BEFORE UPDATE ON e2ee_project_groups
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_mls_commit_insert
BEFORE INSERT ON e2ee_mls_commits
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

-- Not fenced on the sender: erasure itself clears the sender columns.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_mls_commit_update
BEFORE UPDATE ON e2ee_mls_commits
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_leaf_insert
BEFORE INSERT ON e2ee_project_leaves
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
) OR EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_leaf_update
BEFORE UPDATE ON e2ee_project_leaves
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id)
) OR EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_key_insert
BEFORE INSERT ON e2ee_project_keys
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
) OR EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_project_key_update
BEFORE UPDATE ON e2ee_project_keys
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id)
) OR EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_key_archive_insert
BEFORE INSERT ON e2ee_key_archives
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_key_archive_update
BEFORE UPDATE ON e2ee_key_archives
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
