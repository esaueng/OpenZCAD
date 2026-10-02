-- Account-scoped recovery for device projects saved to an account.
CREATE TABLE project_adoptions (
  user_id TEXT NOT NULL,
  local_project_id TEXT NOT NULL,
  cloud_project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, local_project_id)
);
