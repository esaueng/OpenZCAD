-- Pending invitations to encrypted projects don't lapse (L11 plan of
-- 2026-11-25, §3.4). Before a statement nobody accepted expires, an owner
-- device signs a fresh one for the same invitation (at most seven days,
-- like every statement), and the Worker replaces the stored statement,
-- its signature, its signing device and its expiry
-- (`PUT /api/e2ee/projects/:id/invitations/:invitationId`).
--
-- Migration 0038 made every statement column immutable. This keeps the
-- invitation's identity (its id, project, owner, email hash, role, token
-- and creation) immutable as before, and lets the statement columns move
-- only while the invitation is open and unaccepted, and only to a later
-- expiry. An acceptance signs the statement it saw, so an accepted,
-- completed or revoked invitation's statement never changes. The Worker
-- probes for the renewal trigger and answers a renewal 503 until this is
-- applied. Each renewed statement also names when its chain began, and no
-- statement may expire more than 30 days after that (crypto), so renewal
-- is bounded even where the server ignores a cancellation; the account's
-- own sealed tombstones (below) stop its devices renewing or adding a
-- cancelled invitation at all.

DROP TRIGGER IF EXISTS e2ee_invitation_statement_immutable;

CREATE TRIGGER IF NOT EXISTS e2ee_invitation_statement_immutable
BEFORE UPDATE OF invitation_id, project_id, invited_by_user_id, email_hash,
  role, token_hash, created_at ON e2ee_invitations
BEGIN
  SELECT RAISE(ABORT, 'E2EE_INVITATION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS e2ee_invitation_statement_renewal
BEFORE UPDATE OF statement, signature, signer_device_id, expires_at
  ON e2ee_invitations
WHEN OLD.accepted_at IS NOT NULL
  OR NEW.accepted_at IS NOT NULL
  OR OLD.completed_at IS NOT NULL
  OR OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NOT NULL
  OR NEW.expires_at <= OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'E2EE_INVITATION_IMMUTABLE');
END;

-- The invitations each account cancelled (ADR-024 amendment 2026-11-25):
-- one record per account, sealed under the account key in the browser
-- (`INVITATION_TOMBSTONES_RECORD`), opaque here like the share link names
-- of migration 0067. The account's own devices renew, and add an
-- acceptance of, no invitation it names. `sequence` is the sealed record's
-- own, copied from its header, so a write can never lower it.
CREATE TABLE IF NOT EXISTS e2ee_invitation_tombstones (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  sequence INTEGER NOT NULL CHECK (sequence >= 1 AND sequence <= 4294967295),
  record TEXT NOT NULL CHECK (length(record) <= 98304),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Account erasure fences every cloud write before cleanup begins.
CREATE TRIGGER IF NOT EXISTS block_erasing_invitation_tombstones_insert
BEFORE INSERT ON e2ee_invitation_tombstones
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_invitation_tombstones_update
BEFORE UPDATE ON e2ee_invitation_tombstones
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
