-- Library folders (the shelf's grouping of projects) for one account, so
-- every device the owner signs in on shows the same folders. One opaque
-- record per account: browsers merge their copies and write the result back
-- with compare-and-set on `revision`. Format 1 is the plaintext JSON folder
-- set; format 2 is the same set sealed under the account key (ADR-024), which
-- the Worker cannot read.

CREATE TABLE IF NOT EXISTS library_folder_sets (
  user_id TEXT PRIMARY KEY,
  format INTEGER NOT NULL CHECK (format IN (1, 2)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  record TEXT NOT NULL CHECK (length(record) <= 262144),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Account erasure fences every cloud write before cleanup begins. An UPSERT
-- can take either path, so both INSERT and UPDATE need their own guard.
CREATE TRIGGER IF NOT EXISTS block_erasing_library_folders_insert
BEFORE INSERT ON library_folder_sets
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

CREATE TRIGGER IF NOT EXISTS block_erasing_library_folders_update
BEFORE UPDATE ON library_folder_sets
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
