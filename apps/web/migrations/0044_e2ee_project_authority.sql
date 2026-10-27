-- ADR-024 8-C5b: independently authenticated MLS roots and membership pins.
-- Only this account can authenticate its MAC; its certified device also signs
-- the record. The Delivery Service stores it with compare-and-swap. Removing
-- a staged group cascades these records, so a new staging has no old anchors.
-- This is an incompatible experimental-format cutover, not a backfill: a
-- server cannot invent independently authenticated roots for old archives.
-- Refuse BEFORE publishing the new code; keep the prior release/schema until
-- owners have completed the documented client-side transition.
CREATE TABLE e2ee_authority_cutover_guard (id INTEGER PRIMARY KEY);
CREATE TRIGGER e2ee_authority_cutover_required
BEFORE INSERT ON e2ee_authority_cutover_guard
WHEN EXISTS (SELECT 1 FROM e2ee_project_groups)
BEGIN
  SELECT RAISE(ABORT, 'E2EE_AUTHORITY_CUTOVER_REQUIRED: retain the prior release and transition existing encrypted projects before migration 0044');
END;
INSERT INTO e2ee_authority_cutover_guard (id) VALUES (1);
DROP TABLE e2ee_authority_cutover_guard;

CREATE TABLE e2ee_project_authority (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES e2ee_project_groups(project_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 4294967295),
  account_key_generation INTEGER NOT NULL CHECK (account_key_generation >= 1),
  account_key_sequence INTEGER NOT NULL CHECK (account_key_sequence >= 0),
  signer_device_id TEXT NOT NULL CHECK (length(signer_device_id) BETWEEN 1 AND 128),
  record TEXT NOT NULL CHECK (length(record) BETWEEN 1 AND 1048576),
  record_mac TEXT NOT NULL CHECK (length(record_mac) = 43),
  signature TEXT NOT NULL CHECK (length(signature) = 87),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE TRIGGER e2ee_project_authority_monotonic
BEFORE UPDATE ON e2ee_project_authority
WHEN NEW.sequence <= OLD.sequence
BEGIN
  SELECT RAISE(ABORT, 'E2EE_AUTHORITY_SEQUENCE');
END;
