-- The Glimpse account-activity census finds each consenting account's latest
-- named save with `GROUP BY author_user_id` over `revisions`. The only index
-- naming the author (0009) leads with project_id, so that read scanned every
-- revision on every hourly run. This one makes it an index range per author.
-- Its ongoing cost is one index entry per revision insert, which only named
-- saves make. Applying it builds the index over every existing revision once,
-- holding D1's writer for that build; apply it at a quiet hour.

CREATE INDEX IF NOT EXISTS idx_revisions_author_created
  ON revisions(author_user_id, created_at);
