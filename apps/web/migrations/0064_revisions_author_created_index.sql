-- The Glimpse account-activity census finds each consenting account's latest
-- named save with `GROUP BY author_user_id` over `revisions`. The only index
-- naming the author (0009) leads with project_id, so that read scanned every
-- revision. This one makes it an index range per author. Its cost is one
-- index entry per revision insert, which only named saves make.

CREATE INDEX IF NOT EXISTS idx_revisions_author_created
  ON revisions(author_user_id, created_at);
