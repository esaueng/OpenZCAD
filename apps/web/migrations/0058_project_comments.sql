-- L08 review comments on plaintext projects: threads pinned to a point on
-- the model, and their replies. An encrypted project's comments never reach
-- this table (they are not offered until they can be encrypted records).
-- Deleting the project deletes its comments; erasing an account deletes the
-- comments it wrote (accountDeletion.ts).

CREATE TABLE IF NOT EXISTS project_comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  author_user_id TEXT,
  author_name TEXT NOT NULL CHECK (length(author_name) <= 200),
  body_text TEXT NOT NULL CHECK (length(body_text) BETWEEN 1 AND 2000),
  anchor_json TEXT CHECK (anchor_json IS NULL OR length(anchor_json) <= 1024),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_name TEXT CHECK (
    resolved_by_name IS NULL OR length(resolved_by_name) <= 200
  ),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES project_comments(id) ON DELETE CASCADE,
  CHECK ((parent_id IS NULL) = (anchor_json IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS project_comments_by_project
  ON project_comments (project_id, created_at);

CREATE INDEX IF NOT EXISTS project_comments_by_author
  ON project_comments (author_user_id);

-- Account erasure fences every cloud write before cleanup begins.
CREATE TRIGGER IF NOT EXISTS block_erasing_comment_insert
BEFORE INSERT ON project_comments
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  WHERE erasure.user_id = NEW.author_user_id
     OR erasure.user_id IN (
       SELECT user_id FROM projects WHERE id = NEW.project_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
