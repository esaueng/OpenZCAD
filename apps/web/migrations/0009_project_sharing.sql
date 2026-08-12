PRAGMA foreign_keys = ON;

-- Ownership remains authoritative in projects.user_id. Only non-owner access
-- is stored here, so a membership row can never transfer project ownership.
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  added_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_project_members_user_project
  ON project_members(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project_role
  ON project_members(project_id, role);

CREATE TABLE IF NOT EXISTS project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL CHECK (email = lower(trim(email)) AND length(email) > 3),
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id TEXT NOT NULL,
  accepted_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (accepted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (created_at >= 0),
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_project_invitations_project_created
  ON project_invitations(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_invitations_email_expires
  ON project_invitations(email, expires_at);
CREATE INDEX IF NOT EXISTS idx_project_invitations_project_active
  ON project_invitations(project_id, expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS project_access_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  actor_user_id TEXT,
  subject_user_id TEXT,
  invitation_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'invitation-created',
    'invitation-revoked',
    'invitation-accepted',
    'member-role-changed',
    'member-removed'
  )),
  previous_role TEXT CHECK (previous_role IS NULL OR previous_role IN ('owner', 'editor', 'viewer')),
  next_role TEXT CHECK (next_role IS NULL OR next_role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (invitation_id) REFERENCES project_invitations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_project_access_events_project_created
  ON project_access_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_access_events_subject_created
  ON project_access_events(subject_user_id, created_at DESC)
  WHERE subject_user_id IS NOT NULL;

ALTER TABLE revisions ADD COLUMN author_user_id TEXT
  REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_revisions_project_author_created
  ON revisions(project_id, author_user_id, created_at DESC);
