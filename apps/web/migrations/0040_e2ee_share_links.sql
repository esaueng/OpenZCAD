-- ADR-024 Phase 5, slice 5-10 (roadmap L11): share links of end-to-end
-- encrypted projects. A link is `#share=<token>.<key>.<owner>`; the fragment
-- never reaches the server. Which links are active is project state, inside
-- the encrypted, signed document (owner-signed grants and permanent
-- tombstones), so the server cannot add a link back. What the server keeps:
--
-- - e2ee_share_links: one row per link the owner registered: the hash of
--   its capability token (the anonymous route's whole authorization), its
--   mode, the hash of its share key, the owner fingerprint it names, and the
--   newest share-authority statement ("OZA", signed by an owner device the
--   delegation names: who may publish snapshots, for at most seven days,
--   with a sequence that rises per link). A revoked link keeps its row
--   (revoked_at), so neither its id nor its token is ever reused, and loses
--   everything else at once.
-- - e2ee_share_keys: the share key wrapped under each key epoch's project
--   key; the first wrap stored for an epoch wins.
-- - e2ee_share_snapshots: the current snapshot per link, a signed
--   share-snapshot envelope (inline when small, otherwise in R2 under an
--   opaque key), the visitor's wrap of its version key under the share key,
--   the members' wrap under the project key and the author's signing key.
-- - e2ee_share_delegations: per account, the newest identity-signed share
--   delegation ("OZS": which owner devices may sign statements, for at most
--   30 days), with a sequence that rises.
--
-- Ordinary traffic does not depend on this migration: until it is applied,
-- no statement names these tables (the Worker probes for them first), the
-- share-link routes answer 503 and the anonymous route 404, and plaintext
-- share links are untouched (they never read these tables, and keep
-- refusing format 2). Everything stays behind E2EE_KEYS_ENABLED and
-- E2EE_PROJECTS_ENABLED. Project purge deletes the rows (and the R2 bodies);
-- account erasure deletes the account's delegation and, with `all`, clears
-- its user id from rows in other owners' projects.
--
-- Numbering: 0035 is an unused gap, 0036 is slice 4-10, 0037 slice 5-1,
-- 0038 slice 5-3a, 0039 slice 5-5 and 0041 slice 6-1; renumber at merge
-- time if needed.

CREATE TABLE e2ee_share_links (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL CHECK (length(share_id) BETWEEN 1 AND 128),
  -- Lowercase hex SHA-256 of the token bytes.
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  mode TEXT NOT NULL CHECK (mode IN ('view', 'tweak')),
  -- base64url of 32-byte hashes.
  share_key_hash TEXT NOT NULL CHECK (length(share_key_hash) = 43),
  owner_identity_hash TEXT NOT NULL CHECK (length(owner_identity_hash) = 43),
  -- Null once that account was erased.
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  -- The newest share-authority statement (base64url, at most 66 KiB raw)
  -- and its 65-byte signature; all null until the first, and on revocation.
  authority TEXT CHECK (authority IS NULL OR length(authority) <= 90000),
  authority_signature TEXT
    CHECK (authority_signature IS NULL OR length(authority_signature) = 87),
  authority_sequence INTEGER
    CHECK (authority_sequence IS NULL OR authority_sequence >= 0),
  authority_expires_at INTEGER,
  PRIMARY KEY (project_id, share_id),
  CHECK ((authority IS NULL) = (authority_signature IS NULL)
     AND (authority IS NULL) = (authority_sequence IS NULL)
     AND (authority IS NULL) = (authority_expires_at IS NULL)),
  CHECK (revoked_at IS NULL OR authority IS NULL)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS e2ee_share_links_creator
  ON e2ee_share_links(created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE TABLE e2ee_share_keys (
  project_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 0),
  -- base64url of the 41-byte `share-key` wrap.
  wrapped TEXT NOT NULL CHECK (length(wrapped) = 55),
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, share_id, key_epoch),
  FOREIGN KEY (project_id, share_id)
    REFERENCES e2ee_share_links(project_id, share_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE e2ee_share_snapshots (
  project_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  -- The document version the snapshot was made from, and its key epoch.
  document_version INTEGER NOT NULL CHECK (document_version >= 1),
  key_epoch INTEGER NOT NULL CHECK (key_epoch >= 0),
  -- Lowercase hex version hash of the envelope, computed by the Worker.
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  envelope_inline TEXT,
  envelope_key TEXT,
  envelope_bytes INTEGER NOT NULL CHECK (envelope_bytes > 0),
  -- base64url: the 73-byte version signature, the 41-byte wraps and the
  -- author's 65-byte signing key.
  signature TEXT NOT NULL CHECK (length(signature) = 98),
  wrapped_for_link_visitors TEXT NOT NULL
    CHECK (length(wrapped_for_link_visitors) = 55),
  wrapped_for_members TEXT NOT NULL CHECK (length(wrapped_for_members) = 55),
  author_key TEXT NOT NULL CHECK (length(author_key) = 87),
  signer_user_id TEXT,
  signer_device_id TEXT NOT NULL
    CHECK (length(signer_device_id) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, share_id),
  CHECK ((envelope_inline IS NULL) <> (envelope_key IS NULL)),
  FOREIGN KEY (project_id, share_id)
    REFERENCES e2ee_share_links(project_id, share_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS e2ee_share_snapshots_signer
  ON e2ee_share_snapshots(signer_user_id)
  WHERE signer_user_id IS NOT NULL;

CREATE TABLE e2ee_share_delegations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  -- base64url of the canonical delegation (at most 4.2 KiB raw) and its
  -- 65-byte identity signature.
  statement TEXT NOT NULL CHECK (length(statement) <= 6000),
  signature TEXT NOT NULL CHECK (length(signature) = 87),
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- A delegation's sequence only rises within one identity generation.
CREATE TRIGGER IF NOT EXISTS e2ee_share_delegation_rises
BEFORE UPDATE ON e2ee_share_delegations
WHEN NEW.generation < OLD.generation
  OR (NEW.generation = OLD.generation AND NEW.sequence <= OLD.sequence)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_SHARE_DELEGATION_STALE');
END;

-- A statement's sequence only rises; a revoked link never comes back, and
-- its id, token, key hash, mode and owner never change.
CREATE TRIGGER IF NOT EXISTS e2ee_share_link_immutable
BEFORE UPDATE ON e2ee_share_links
WHEN NEW.project_id <> OLD.project_id OR NEW.share_id <> OLD.share_id
  OR NEW.token_hash <> OLD.token_hash OR NEW.mode <> OLD.mode
  OR NEW.share_key_hash <> OLD.share_key_hash
  OR NEW.owner_identity_hash <> OLD.owner_identity_hash
  OR NEW.created_at <> OLD.created_at
  OR (NEW.created_by_user_id IS NOT NULL
      AND NEW.created_by_user_id IS NOT OLD.created_by_user_id)
  OR (OLD.revoked_at IS NOT NULL
      AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.authority IS NOT NULL))
  OR (OLD.authority_sequence IS NOT NULL AND NEW.authority_sequence IS NOT NULL
      AND NEW.authority_sequence <= OLD.authority_sequence)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_SHARE_LINK_IMMUTABLE');
END;

-- Writes also carry the session/erasure predicate in their own SQL (see
-- e2eeWriteAuthorization); these fences hold for any other writer as well.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_share_link_insert
BEFORE INSERT ON e2ee_share_links
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.created_by_user_id
) OR EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_share_snapshot_insert
BEFORE INSERT ON e2ee_share_snapshots
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.signer_user_id
) OR EXISTS (
  SELECT 1 FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_share_delegation_insert
BEFORE INSERT ON e2ee_share_delegations
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
