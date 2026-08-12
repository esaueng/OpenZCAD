-- R2-backed project documents.
--
-- D1 retains account ownership, shelf state, optimistic version fences, and
-- compact summary fields. Immutable document projections and their imported
-- STEP/mesh payloads live in private R2 objects. All additions are nullable or
-- separate tables so rows written before this migration remain readable.

ALTER TABLE projects ADD COLUMN document_object_id TEXT;
ALTER TABLE revisions ADD COLUMN document_object_id TEXT;
ALTER TABLE projects ADD COLUMN last_revision_id TEXT;
ALTER TABLE projects ADD COLUMN revision_count INTEGER;

UPDATE projects
SET revision_count = json_array_length(document_json, '$.revisions')
WHERE json_valid(document_json);

UPDATE projects
SET last_revision_id = json_extract(
  document_json,
  '$.revisions[#-1].revisionId'
)
WHERE json_valid(document_json)
  AND json_array_length(document_json, '$.revisions') > 0;

CREATE TABLE IF NOT EXISTS project_document_objects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  logical_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  content_encoding TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_storage_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('step-source', 'mesh-payload')),
  object_key TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  logical_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  content_encoding TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, checksum_sha256, kind)
);

CREATE INDEX IF NOT EXISTS idx_project_document_objects_project_state
  ON project_document_objects(project_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_project_storage_assets_project
  ON project_storage_assets(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_projects_document_object
  ON projects(document_object_id);
CREATE INDEX IF NOT EXISTS idx_revisions_document_object
  ON revisions(document_object_id);
