CREATE TABLE IF NOT EXISTS project_workspace_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_sessions_recent
  ON project_workspace_sessions(user_id, project_id, updated_at DESC);
