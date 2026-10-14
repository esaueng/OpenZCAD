-- A cancelled import may finish uploading before its caller hears the result.
-- Keep its discard claim after removing the bytes: a delayed document write
-- must not publish the now-missing source. Claims consume no artifact quota.
CREATE TABLE artifact_mesh_discards (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
CREATE INDEX idx_artifact_mesh_discards_project
  ON artifact_mesh_discards(project_id);
