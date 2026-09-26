-- All shelf states count until a project is hard deleted. Existing accounts
-- above either ceiling remain readable and may delete data; new growth stops.
-- D1 evaluates each trigger in the same transaction as the row write.
-- R2 replacements temporarily keep old and new objects, so a save at the
-- ceiling can be refused until space is freed even if later pruning would fit.

CREATE TRIGGER project_account_count_before_insert
BEFORE INSERT ON projects
BEGIN
  SELECT RAISE(ABORT, 'project_account_count_quota')
  WHERE (SELECT COUNT(*) FROM projects WHERE user_id = NEW.user_id) >= 100;
END;

CREATE TRIGGER project_account_owner_immutable
BEFORE UPDATE OF user_id ON projects
WHEN NEW.user_id <> OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'project_account_owner_immutable');
END;

-- Rows from before R2 rollout remain in D1. Keep their head and revision
-- bodies under a separate account ceiling while they are stored there.
CREATE TRIGGER project_account_d1_project_bytes_before_insert
BEFORE INSERT ON projects
WHEN NEW.document_object_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes +
    COALESCE((
      SELECT SUM(document_bytes) FROM projects
      WHERE user_id = NEW.user_id AND document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(revisions.document_bytes)
      FROM revisions JOIN projects ON projects.id = revisions.project_id
      WHERE projects.user_id = NEW.user_id
        AND revisions.document_object_id IS NULL
    ), 0) > 2147483648;
END;

CREATE TRIGGER project_account_d1_project_bytes_before_update
BEFORE UPDATE OF document_bytes, document_object_id ON projects
WHEN NEW.document_bytes * (NEW.document_object_id IS NULL)
   > OLD.document_bytes * (OLD.document_object_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes * (NEW.document_object_id IS NULL)
    - OLD.document_bytes * (OLD.document_object_id IS NULL) +
    COALESCE((
      SELECT SUM(document_bytes) FROM projects
      WHERE user_id = NEW.user_id AND document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(revisions.document_bytes)
      FROM revisions JOIN projects ON projects.id = revisions.project_id
      WHERE projects.user_id = NEW.user_id
        AND revisions.document_object_id IS NULL
    ), 0) > 2147483648;
END;

CREATE TRIGGER project_account_d1_revision_bytes_before_insert
BEFORE INSERT ON revisions
WHEN NEW.document_object_id IS NULL AND NEW.document_bytes >
  COALESCE((
    SELECT old.document_bytes FROM revisions old
    WHERE old.id = NEW.id AND old.project_id = NEW.project_id
      AND old.document_object_id IS NULL
  ), 0)
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes -
    COALESCE((
      SELECT old.document_bytes FROM revisions old
      WHERE old.id = NEW.id AND old.project_id = NEW.project_id
        AND old.document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(document_bytes) FROM projects
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(revisions.document_bytes)
      FROM revisions JOIN projects ON projects.id = revisions.project_id
      WHERE projects.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND revisions.document_object_id IS NULL
    ), 0) > 2147483648;
END;

CREATE TRIGGER project_account_d1_revision_bytes_before_update
BEFORE UPDATE OF document_bytes, document_object_id ON revisions
WHEN NEW.document_bytes * (NEW.document_object_id IS NULL)
   > OLD.document_bytes * (OLD.document_object_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'project_account_document_quota')
  WHERE NEW.document_bytes * (NEW.document_object_id IS NULL)
    - OLD.document_bytes * (OLD.document_object_id IS NULL) +
    COALESCE((
      SELECT SUM(document_bytes) FROM projects
      WHERE user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND document_object_id IS NULL
    ), 0) +
    COALESCE((
      SELECT SUM(revisions.document_bytes)
      FROM revisions JOIN projects ON projects.id = revisions.project_id
      WHERE projects.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
        AND revisions.document_object_id IS NULL
    ), 0) > 2147483648;
END;

CREATE TRIGGER project_account_revision_owner_immutable
BEFORE UPDATE OF project_id ON revisions
WHEN NEW.project_id <> OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'project_account_revision_owner_immutable');
END;

CREATE TRIGGER project_account_object_bytes_before_insert
BEFORE INSERT ON project_document_objects
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_invalid')
  WHERE typeof(NEW.stored_bytes) <> 'integer' OR NEW.stored_bytes < 0
    OR NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NEW.stored_bytes +
    COALESCE((
      SELECT SUM(objects.stored_bytes)
      FROM project_document_objects objects
      JOIN projects owner ON owner.id = objects.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) +
    COALESCE((
      SELECT SUM(assets.stored_bytes)
      FROM project_storage_assets assets
      JOIN projects owner ON owner.id = assets.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > 2147483648;
END;

CREATE TRIGGER project_account_asset_bytes_before_insert
BEFORE INSERT ON project_storage_assets
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_invalid')
  WHERE typeof(NEW.stored_bytes) <> 'integer' OR NEW.stored_bytes < 0
    OR NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id);
  SELECT RAISE(ABORT, 'project_account_storage_quota')
  WHERE NOT EXISTS (
      SELECT 1 FROM project_storage_assets
      WHERE project_id = NEW.project_id
        AND checksum_sha256 = NEW.checksum_sha256 AND kind = NEW.kind
    ) AND NEW.stored_bytes +
    COALESCE((
      SELECT SUM(objects.stored_bytes)
      FROM project_document_objects objects
      JOIN projects owner ON owner.id = objects.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) +
    COALESCE((
      SELECT SUM(assets.stored_bytes)
      FROM project_storage_assets assets
      JOIN projects owner ON owner.id = assets.project_id
      WHERE owner.user_id = (SELECT user_id FROM projects WHERE id = NEW.project_id)
    ), 0) > 2147483648;
END;

CREATE TRIGGER project_account_object_bytes_immutable
BEFORE UPDATE OF project_id, stored_bytes ON project_document_objects
WHEN NEW.project_id <> OLD.project_id OR NEW.stored_bytes <> OLD.stored_bytes
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_immutable');
END;

CREATE TRIGGER project_account_asset_bytes_immutable
BEFORE UPDATE OF project_id, stored_bytes ON project_storage_assets
WHEN NEW.project_id <> OLD.project_id OR NEW.stored_bytes <> OLD.stored_bytes
BEGIN
  SELECT RAISE(ABORT, 'project_account_storage_immutable');
END;
