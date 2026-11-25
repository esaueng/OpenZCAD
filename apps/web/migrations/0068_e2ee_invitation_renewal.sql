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
-- applied; nothing else depends on it.

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
