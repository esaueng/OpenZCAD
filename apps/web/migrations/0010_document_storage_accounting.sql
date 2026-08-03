-- Stored-byte accounting and revision retention.
--
-- Continuous sync writes the projects row and never inserts a revision, so
-- revision growth is now driven by explicit saves rather than by how fast
-- somebody edits. That makes the history prunable on a simple rule — keep the
-- most recent per project — without discarding anything a background process
-- created behind the user's back.
--
-- The byte columns are denormalized on purpose. Summing
-- `length(CAST(document_json AS BLOB))` across an account reads every document
-- blob to answer a number shown in a settings panel; a column that each write
-- already knows costs nothing to maintain and turns the query into a SUM over
-- integers.

ALTER TABLE projects ADD COLUMN document_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE revisions ADD COLUMN document_bytes INTEGER NOT NULL DEFAULT 0;

-- CAST to BLOB first: SQLite's length() counts characters on TEXT, and a
-- document full of non-ASCII names would otherwise be under-reported.
UPDATE projects SET document_bytes = length(CAST(document_json AS BLOB));
UPDATE revisions SET document_bytes = length(CAST(document_json AS BLOB));

-- Pruning deletes the oldest rows of one project; accounting sums one account's
-- rows. The existing idx_revisions_project_created serves the first, and this
-- serves the second without a scan across every account's revisions.
CREATE INDEX IF NOT EXISTS idx_revisions_project_bytes
  ON revisions(project_id, document_bytes);
