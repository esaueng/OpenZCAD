-- Rollback of a failed source copy may erase stored documents asynchronously.
-- Fence every writer and restore until erasure completes, including clients
-- that recover the latest document version from a shelf summary.
CREATE TABLE project_copy_cleanup_claims (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  claimed_at TEXT NOT NULL
);

-- These aliases are registered only by the server's independently verified
-- source-copy stream. Keep the owned bytes for late local-id autosaves and
-- restores until the project itself is purged.
CREATE TABLE project_copy_source_archives (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mesh-payload', 'step-import')),
  checksum_sha256 TEXT NOT NULL CHECK (
    length(checksum_sha256) = 64 AND checksum_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  logical_bytes INTEGER NOT NULL CHECK (typeof(logical_bytes) = 'integer' AND logical_bytes > 0),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, kind, checksum_sha256, logical_bytes)
);
CREATE INDEX idx_project_copy_source_archive_artifact
  ON project_copy_source_archives(artifact_id);
