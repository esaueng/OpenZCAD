-- View-mode measurements are project data, but they are not authored CAD
-- history. Keep the bounded snapshot beside the canonical document so a
-- measurement never changes document equality or the exact-rebuild cache.

CREATE TABLE IF NOT EXISTS project_measurements (
  project_id TEXT PRIMARY KEY,
  record_version INTEGER NOT NULL CHECK (record_version >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload_json TEXT NOT NULL CHECK (length(payload_json) <= 524288),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Account erasure fences every cloud write before cleanup begins. An UPSERT
-- can take either path, so both INSERT and UPDATE need their own guard.
CREATE TRIGGER IF NOT EXISTS block_erasing_measurement_insert
BEFORE INSERT ON project_measurements
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_measurement_update
BEFORE UPDATE ON project_measurements
WHEN EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id IN (OLD.project_id, NEW.project_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
