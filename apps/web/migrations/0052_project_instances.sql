-- Project instances: which generation of a project id a row belongs to.
--
-- Project ids are minted by clients, so a project deleted and created again
-- reuses its id. A deletion that checked ownership, paused, and resumed
-- after another deletion finished and the id was created again must not
-- destroy the new project, and a delayed erasure of the old project's
-- collaboration room must not erase the new project's room. Every inserted
-- project row gets an immutable random instance id here; a deletion
-- captures it with its ownership check and acts only while it still names
-- the project, and a room records the instance it serves.
--
-- A separate table, filled by triggers, so no project write path has to
-- name it and the projects table is not rewritten. Existing projects get
-- their instance below.
CREATE TABLE IF NOT EXISTS project_instances (
  project_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL CHECK (length(instance_id) = 32)
) WITHOUT ROWID;

INSERT OR IGNORE INTO project_instances (project_id, instance_id)
SELECT id, lower(hex(randomblob(16))) FROM projects;

DROP TRIGGER IF EXISTS project_instance_insert;
CREATE TRIGGER project_instance_insert
AFTER INSERT ON projects
BEGIN
  INSERT OR REPLACE INTO project_instances (project_id, instance_id)
  VALUES (NEW.id, lower(hex(randomblob(16))));
END;

DROP TRIGGER IF EXISTS project_instance_delete;
CREATE TRIGGER project_instance_delete
AFTER DELETE ON projects
BEGIN
  DELETE FROM project_instances WHERE project_id = OLD.id;
END;

-- Instances never change while their project exists.
DROP TRIGGER IF EXISTS project_instance_immutable;
CREATE TRIGGER project_instance_immutable
BEFORE UPDATE ON project_instances
BEGIN
  SELECT RAISE(ABORT, 'project_instance_immutable');
END;

-- An account erasure request's own identity: a random token set when the
-- request is first recorded and kept by its retries. An attempt reads it
-- back from the statement that records the request, lists the projects it
-- erases only while that very request is still open, and stops once a
-- retry completed it, instead of continuing against projects created since.
ALTER TABLE account_erasure_requests ADD COLUMN request_token TEXT
  CHECK (request_token IS NULL OR length(request_token) BETWEEN 1 AND 64);
