-- An account's whole settings sealed under its account key (ADR-024
-- amendment 2026-11-14), base64url, for an account whose library is
-- encrypted. Its `settings_json` then holds only what the Worker acts on:
-- the sharing switch and the assistant's route. NULL for an account that
-- stores its settings readable, and until a browser holding the account key
-- first writes one.

ALTER TABLE user_settings ADD COLUMN sealed_settings TEXT;
