-- Shelf state for projects: archive, recycle bin, pinning, and manual order.
-- Deleting a project moves it to `status = 'deleted'` and stamps `deleted_at`;
-- the row is destroyed only once the retention window has passed.
ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE projects ADD COLUMN archived_at TEXT;

-- Seed the manual order from the order projects were already shown in, so the
-- grid does not reshuffle the first time someone drags a single tile.
UPDATE projects
SET sort_order = (
  SELECT COUNT(*)
  FROM projects AS peer
  WHERE peer.user_id = projects.user_id
    AND (
      peer.updated_at > projects.updated_at
      OR (peer.updated_at = projects.updated_at AND peer.id > projects.id)
    )
);

CREATE INDEX IF NOT EXISTS idx_projects_user_shelf
  ON projects(user_id, status, pinned DESC, sort_order);
CREATE INDEX IF NOT EXISTS idx_projects_purge
  ON projects(status, deleted_at);
