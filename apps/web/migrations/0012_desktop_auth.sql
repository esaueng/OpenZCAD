-- Native desktop authorization sessions.
--
-- The browser approves a short-lived PKCE attempt using its existing secure
-- host cookie. The native app exchanges that attempt for an opaque access
-- token and a rotating refresh token. Only hashes are retained in D1.

CREATE TABLE IF NOT EXISTS desktop_auth_attempts (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  exchanged_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_desktop_auth_attempts_expires
  ON desktop_auth_attempts(expires_at);

CREATE TABLE IF NOT EXISTS desktop_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_desktop_refresh_tokens_session
  ON desktop_refresh_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_desktop_refresh_tokens_user
  ON desktop_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_desktop_refresh_tokens_expires
  ON desktop_refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS desktop_access_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_desktop_access_tokens_session
  ON desktop_access_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_desktop_access_tokens_expires
  ON desktop_access_tokens(expires_at);
