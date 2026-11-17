-- The submitting device's signature on each MLS Commit (base64url, the
-- 65-byte `u8 1 | r || s` of `signMlsCommitSubmission`). The Worker verifies
-- it against the signing key the sender's device list certifies before the
-- Commit is sequenced. Commits accepted before this migration have none;
-- only signed member Commits count as a device removal's key rotation.
-- Erasure clears it together with the sender columns.
ALTER TABLE e2ee_mls_commits
  ADD COLUMN sender_signature TEXT
    CHECK (sender_signature IS NULL OR length(sender_signature) = 87);

-- An accepted Commit is never rewritten; only erasure clears its sender
-- and signature.
DROP TRIGGER IF EXISTS e2ee_mls_commit_immutable;
CREATE TRIGGER e2ee_mls_commit_immutable
BEFORE UPDATE ON e2ee_mls_commits
WHEN NEW.project_id <> OLD.project_id OR NEW.epoch <> OLD.epoch
  OR NEW.kind <> OLD.kind OR NEW.message <> OLD.message
  OR NEW.created_at <> OLD.created_at
  OR (NEW.sender_user_id IS NOT NULL
      AND NEW.sender_user_id IS NOT OLD.sender_user_id)
  OR (NEW.sender_device_id IS NOT NULL
      AND NEW.sender_device_id IS NOT OLD.sender_device_id)
  OR (NEW.sender_signature IS NOT NULL
      AND NEW.sender_signature IS NOT OLD.sender_signature)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_COMMIT_IMMUTABLE');
END;
