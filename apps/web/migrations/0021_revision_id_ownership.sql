-- Revision IDs are global and remain bound to one project across saves.
CREATE TRIGGER project_revision_id_owner_before_insert
BEFORE INSERT ON revisions
WHEN EXISTS (
  SELECT 1 FROM revisions
  WHERE id = NEW.id AND project_id <> NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'revision_project_collision');
END;
