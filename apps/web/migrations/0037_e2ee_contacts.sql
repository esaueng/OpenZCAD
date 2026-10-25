-- ADR-024 Phase 5, slice 5-1 (roadmap L11): contacts lists. Each user's
-- verified pins for other people's keys live in a hash-chained list of
-- entries signed by the user's identity key, so a server that served an
-- older copy could not revive a verified pin for a key that has since been
-- replaced. The Worker stores the entries, checks each one under the
-- identity key before appending it, and never sees anything secret. The
-- routes stay closed behind E2EE_KEYS_ENABLED.
-- Ordinary traffic does not depend on this migration: until it is applied,
-- only the contacts routes probe for the table (and answer 503), and account
-- erasure leaves it out.
--
-- Numbering: 0035 is an unused gap and 0036 is held by slice 4-10; renumber
-- at merge time if needed.

-- One identity-signed contacts entry. A list belongs to one identity
-- generation: replacing the recovery key replaces the identity, whose new
-- list starts empty, and pruning a replaced identity cascades to its list.
CREATE TABLE e2ee_contact_entries (
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0 AND sequence < 1024),
  -- base64url of the canonical entry, at most 512 bytes raw.
  entry TEXT NOT NULL CHECK (length(entry) BETWEEN 1 AND 683),
  signature TEXT NOT NULL CHECK (length(signature) = 87),
  -- Lowercase hex of the entry hash, computed by the Worker.
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, generation, sequence),
  FOREIGN KEY (user_id, generation)
    REFERENCES e2ee_identities(user_id, generation) ON DELETE CASCADE
) WITHOUT ROWID;

-- An accepted entry never changes; the list only grows.
CREATE TRIGGER IF NOT EXISTS e2ee_contact_entry_immutable
BEFORE UPDATE ON e2ee_contact_entries
BEGIN
  SELECT RAISE(ABORT, 'E2EE_CONTACT_ENTRY_IMMUTABLE');
END;

-- Writes already carry the erasure fence in their own predicate (see
-- e2eeWriteAuthorization); this trigger fences any other writer too.
CREATE TRIGGER IF NOT EXISTS block_erasing_e2ee_contact_entry_insert
BEFORE INSERT ON e2ee_contact_entries
WHEN EXISTS (
  SELECT 1 FROM account_erasure_requests WHERE user_id IN (NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_ERASURE_IN_PROGRESS');
END;
