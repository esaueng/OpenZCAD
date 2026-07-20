ALTER TABLE projects ADD COLUMN document_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifacts ADD COLUMN bytes INTEGER;
ALTER TABLE upload_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'snapshot';
ALTER TABLE upload_sessions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

UPDATE projects
SET document_version = CAST(json_extract(document_json, '$.version') AS INTEGER)
WHERE json_valid(document_json);

CREATE INDEX IF NOT EXISTS idx_projects_user_updated
  ON projects(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_revisions_project_created
  ON revisions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_project_created
  ON artifacts(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_project_expires
  ON upload_sessions(project_id, expires_at);
