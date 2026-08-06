-- Immediate, resumable account and cloud-project erasure.
--
-- The fence is deliberately stored in D1 before any R2 or Durable Object
-- cleanup begins. Triggers then refuse late writes from another device until
-- the erasure request either completes or is retried.

CREATE TABLE IF NOT EXISTS account_erasure_requests (
  user_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('profile', 'projects', 'all')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (started_at >= 0),
  CHECK (updated_at >= started_at)
);

CREATE TRIGGER IF NOT EXISTS block_erasing_project_insert
BEFORE INSERT ON projects
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_project_update
BEFORE UPDATE ON projects
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_revision_write
BEFORE INSERT ON revisions
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_artifact_write
BEFORE INSERT ON artifacts
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_upload_insert
BEFORE INSERT ON upload_sessions
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_upload_update
BEFORE UPDATE ON upload_sessions
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_document_object_write
BEFORE INSERT ON project_document_objects
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_storage_asset_write
BEFORE INSERT ON project_storage_assets
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_settings_insert
BEFORE INSERT ON user_settings
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_settings_update
BEFORE UPDATE ON user_settings
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_credential_insert
BEFORE INSERT ON user_ai_credentials
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_credential_update
BEFORE UPDATE ON user_ai_credentials
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_browser_session_insert
BEFORE INSERT ON auth_sessions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_desktop_attempt_update
BEFORE UPDATE OF user_id ON desktop_auth_attempts
WHEN NEW.user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_desktop_refresh_insert
BEFORE INSERT ON desktop_refresh_tokens
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_desktop_access_insert
BEFORE INSERT ON desktop_access_tokens
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_member_write
BEFORE INSERT ON project_members
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
) OR EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_member_update
BEFORE UPDATE ON project_members
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id)
) OR EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_invitation_write
BEFORE INSERT ON project_invitations
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id = NEW.invited_by_user_id
) OR EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_access_event_write
BEFORE INSERT ON project_access_events
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id = NEW.actor_user_id OR user_id = NEW.subject_user_id
) OR EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_ai_usage_insert
BEFORE INSERT ON ai_rate_limits
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE 'account:' || user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_ai_usage_update
BEFORE UPDATE ON ai_rate_limits
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE 'account:' || user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_ai_lease_insert
BEFORE INSERT ON ai_concurrency_leases
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE 'account:' || user_id = NEW.account_bucket
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
