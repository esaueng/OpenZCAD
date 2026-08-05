-- Require browser approval to include the short user code displayed only by
-- the native desktop app. This binds an approval to a local desktop instance
-- instead of allowing approval by attacker-distributed attempt ids alone.

ALTER TABLE desktop_auth_attempts
  ADD COLUMN user_code_hash TEXT;
