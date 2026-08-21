PRAGMA foreign_keys = ON;

-- Anonymous share links. A link never stores its token: only the SHA-256 hash
-- is kept, and presenting a matching token is the entire authorization for the
-- read-only shared-project routes. Ownership stays authoritative in
-- projects.user_id; created_by_user_id records provenance only.
CREATE TABLE IF NOT EXISTS project_share_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('tweak', 'view')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (created_at >= 0),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_project_share_links_project_created
  ON project_share_links(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_share_links_project_active
  ON project_share_links(project_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- Account erasure fences every cloud write before cleanup begins, matching the
-- 0014 guards. Share links are insert-then-revoke, so only INSERT needs one.
CREATE TRIGGER IF NOT EXISTS block_erasing_share_link_insert
BEFORE INSERT ON project_share_links
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id = NEW.created_by_user_id
) OR EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;

-- Extend the audit ledger to record share-link lifecycle events. SQLite cannot
-- alter a CHECK constraint in place, so the table is rebuilt with the two new
-- event types and a share_link_id provenance column. Nothing references
-- project_access_events, so drop-and-rename is safe; its indexes and the 0014
-- erasure trigger are recreated below because they fall with the old table.
CREATE TABLE project_access_events_rebuilt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  actor_user_id TEXT,
  subject_user_id TEXT,
  invitation_id TEXT,
  share_link_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'invitation-created',
    'invitation-revoked',
    'invitation-accepted',
    'member-role-changed',
    'member-removed',
    'share-link-created',
    'share-link-revoked'
  )),
  previous_role TEXT CHECK (previous_role IS NULL OR previous_role IN ('owner', 'editor', 'viewer')),
  next_role TEXT CHECK (next_role IS NULL OR next_role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (invitation_id) REFERENCES project_invitations(id) ON DELETE SET NULL,
  FOREIGN KEY (share_link_id) REFERENCES project_share_links(id) ON DELETE SET NULL
);

INSERT INTO project_access_events_rebuilt
  (id, project_id, actor_user_id, subject_user_id, invitation_id, event_type,
   previous_role, next_role, created_at, metadata_json)
SELECT id, project_id, actor_user_id, subject_user_id, invitation_id,
       event_type, previous_role, next_role, created_at, metadata_json
FROM project_access_events;

DROP TABLE project_access_events;
ALTER TABLE project_access_events_rebuilt RENAME TO project_access_events;

CREATE INDEX IF NOT EXISTS idx_project_access_events_project_created
  ON project_access_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_access_events_subject_created
  ON project_access_events(subject_user_id, created_at DESC)
  WHERE subject_user_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS block_erasing_access_event_write
BEFORE INSERT ON project_access_events
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests
  WHERE user_id = NEW.actor_user_id OR user_id = NEW.subject_user_id
) OR EXISTS (
  SELECT 1
  FROM account_erasure_requests erasure
  JOIN projects ON projects.user_id = erasure.user_id
  WHERE projects.id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
