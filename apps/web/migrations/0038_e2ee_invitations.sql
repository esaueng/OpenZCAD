-- ADR-024 Phase 5, slice 5-3a (roadmap L11): invitations to end-to-end
-- encrypted projects, the KeyPackages invitees publish, and the Welcomes
-- the owner's Add Commit leaves for them.
--
-- An invitation is an owner-signed statement ("OZI", @openzcad/crypto)
-- naming the project, the invitation, the owner, a hash of the invitee's
-- email (the address itself is only in the email the Worker sends), the
-- role, an expiry of at most seven days and the signing device. The Worker
-- checks the signature against the owner's newest device list before
-- storing it. Accepting binds the signed-in account whose email hashes to
-- the statement's; it does not make a member. Each of the invitee's
-- certified devices publishes one KeyPackage per project with its
-- certified leaf; the owner claims them once (atomic, single use) and
-- Commits an Add, whose batch consumes exactly the claimed KeyPackages,
-- registers their leaves, stores the Welcome for each and inserts the
-- project_members row with the invitation's role.
--
-- Ordinary traffic does not depend on this migration: until it is applied,
-- only the encrypted invitation and KeyPackage routes probe for the tables
-- (and answer 503), the Add form of a Commit is refused, and project purge,
-- contacts lookups and account erasure leave them out. Plaintext
-- invitations (project_invitations) are unchanged and keep refusing
-- encrypted projects. Everything stays behind E2EE_KEYS_ENABLED and
-- E2EE_PROJECTS_ENABLED.
--
-- Numbering: 0035 is an unused gap, 0036 is slice 4-10, 0037 slice 5-1
-- and 0041 slice 6-1; renumber at merge time if needed.

CREATE TABLE e2ee_invitations (
  invitation_id TEXT PRIMARY KEY CHECK (length(invitation_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Lowercase hex of the statement's invitee email hash.
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  -- SHA-256 hex of the emailed token, as for plaintext invitations.
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  -- base64url of the canonical statement (at most 601 bytes raw) and its
  -- 65-byte signature by signer_device_id.
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 802),
  signature TEXT NOT NULL CHECK (length(signature) = 87),
  signer_device_id TEXT NOT NULL CHECK (length(signer_device_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  -- Unix milliseconds, from the statement.
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  accepted_by_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  accepted_at TEXT,
  -- When the owner's Add Commit landed, and the epoch it was sent in.
  completed_at TEXT,
  completed_epoch INTEGER CHECK (completed_epoch IS NULL OR completed_epoch >= 0),
  revoked_at TEXT,
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
  CHECK (completed_at IS NULL OR accepted_at IS NOT NULL),
  CHECK ((completed_at IS NULL) = (completed_epoch IS NULL)),
  CHECK (accepted_by_user_id IS NULL OR accepted_by_user_id <> invited_by_user_id)
);

CREATE INDEX IF NOT EXISTS e2ee_invitations_project
  ON e2ee_invitations(project_id, created_at);
CREATE INDEX IF NOT EXISTS e2ee_invitations_accepted
  ON e2ee_invitations(accepted_by_user_id)
  WHERE accepted_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS e2ee_invitations_email
  ON e2ee_invitations(email_hash);

-- What the statement says never changes; only acceptance, completion and
-- revocation move, each once.
CREATE TRIGGER IF NOT EXISTS e2ee_invitation_statement_immutable
BEFORE UPDATE OF invitation_id, project_id, invited_by_user_id, email_hash,
  role, token_hash, statement, signature, signer_device_id, created_at,
  expires_at ON e2ee_invitations
BEGIN
  SELECT RAISE(ABORT, 'E2EE_INVITATION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS e2ee_invitation_progress_once
BEFORE UPDATE OF accepted_by_user_id, accepted_at, completed_at,
  completed_epoch, revoked_at ON e2ee_invitations
WHEN (OLD.accepted_at IS NOT NULL
      AND (NEW.accepted_at IS NOT OLD.accepted_at
           OR NEW.accepted_by_user_id IS NOT OLD.accepted_by_user_id))
  OR (OLD.completed_at IS NOT NULL
      AND (NEW.completed_at IS NOT OLD.completed_at
           OR NEW.completed_epoch IS NOT OLD.completed_epoch))
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_INVITATION_SETTLED');
END;

-- One KeyPackage per project and invitee device, with the device's leaf
-- for the project (its leaf key and version-2 certification), as the leaf
-- registry stores them. Republishing replaces a KeyPackage that no Add
-- consumed yet; a consumed one stays until the project or account goes.
CREATE TABLE e2ee_key_packages (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  invitation_id TEXT NOT NULL
    REFERENCES e2ee_invitations(invitation_id) ON DELETE CASCADE,
  -- base64url of the MLS KeyPackage message, at most 16 KiB raw.
  key_package TEXT NOT NULL CHECK (length(key_package) BETWEEN 1 AND 21846),
  -- SHA-256 hex of the KeyPackage bytes, computed by the Worker.
  key_package_hash TEXT NOT NULL CHECK (length(key_package_hash) = 64),
  leaf_key TEXT NOT NULL CHECK (length(leaf_key) = 87),
  certification TEXT NOT NULL CHECK (length(certification) = 98),
  created_at TEXT NOT NULL,
  claimed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TEXT,
  consumed_at TEXT,
  consumed_epoch INTEGER,
  PRIMARY KEY (project_id, user_id, device_id),
  CHECK (consumed_at IS NULL OR claimed_at IS NOT NULL),
  CHECK ((consumed_at IS NULL) = (consumed_epoch IS NULL))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS e2ee_key_packages_invitation
  ON e2ee_key_packages(invitation_id);
CREATE INDEX IF NOT EXISTS e2ee_key_packages_user
  ON e2ee_key_packages(user_id);

-- A claim is single use: a claimed KeyPackage is never claimed again, and
-- a consumed one never changes. Republishing (a replacement row) resets
-- the claim with the new KeyPackage.
CREATE TRIGGER IF NOT EXISTS e2ee_key_package_claim_once
BEFORE UPDATE ON e2ee_key_packages
WHEN OLD.consumed_at IS NOT NULL
  OR (OLD.claimed_at IS NOT NULL
      AND NEW.key_package_hash = OLD.key_package_hash
      AND (NEW.claimed_at IS NOT OLD.claimed_at
           OR NEW.claimed_by_user_id IS NOT OLD.claimed_by_user_id))
BEGIN
  SELECT RAISE(ABORT, 'E2EE_KEY_PACKAGE_CLAIMED');
END;

-- The Welcome an Add Commit made, once per recipient KeyPackage (the same
-- MLS Welcome message serves every device the Commit added).
CREATE TABLE e2ee_welcomes (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  key_package_hash TEXT NOT NULL CHECK (length(key_package_hash) = 64),
  -- The epoch the Add Commit was sent in; the Welcome joins epoch + 1.
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  -- base64url of the MLS Welcome, at most 256 KiB raw.
  welcome TEXT NOT NULL CHECK (length(welcome) BETWEEN 1 AND 349526),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key_package_hash)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS e2ee_welcomes_recipient
  ON e2ee_welcomes(user_id, project_id, device_id);

-- Writes already carry the erasure fence in their own predicate (see
-- e2eeWriteAuthorization); these triggers fence any other writer too.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_invitation_insert
BEFORE INSERT ON e2ee_invitations
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (NEW.invited_by_user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_invitation_accept
BEFORE UPDATE OF accepted_by_user_id ON e2ee_invitations
WHEN NEW.accepted_by_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (NEW.accepted_by_user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_key_package_insert
BEFORE INSERT ON e2ee_key_packages
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id IN (NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
