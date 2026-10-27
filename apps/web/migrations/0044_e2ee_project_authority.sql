-- ADR-024 8-C5b: independently authenticated MLS roots and membership pins.
-- Only this account can authenticate its MAC; its certified device also signs
-- the record. The Delivery Service stores it with compare-and-swap. Removing
-- a staged group cascades these records, so a new staging has no old anchors.
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
