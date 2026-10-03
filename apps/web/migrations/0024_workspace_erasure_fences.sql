-- Fence late workspace/adoption writes during resumable account erasure.

CREATE TRIGGER IF NOT EXISTS block_erasing_workspace_session_insert
BEFORE INSERT ON project_workspace_sessions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (NEW.user_id) OR user_id IN (
    SELECT user_id FROM projects WHERE id IN (NEW.project_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_workspace_session_update
BEFORE UPDATE ON project_workspace_sessions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id) OR user_id IN (
    SELECT user_id FROM projects WHERE id IN (OLD.project_id, NEW.project_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_project_adoption_insert
BEFORE INSERT ON project_adoptions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (NEW.user_id) OR user_id IN (
    SELECT user_id FROM projects WHERE id IN (NEW.cloud_project_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_project_adoption_update
BEFORE UPDATE ON project_adoptions
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id IN (OLD.user_id, NEW.user_id) OR user_id IN (
    SELECT user_id FROM projects WHERE id IN (OLD.cloud_project_id, NEW.cloud_project_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
