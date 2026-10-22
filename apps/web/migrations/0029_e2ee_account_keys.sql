-- ADR-024 Phase 3, first slice (roadmap L11): account-level key material for
-- end-to-end encryption. The Worker stores public keys, identity-signed
-- device-list entries and wrapped keys only; every secret is sealed or
-- wrapped in the browser before it arrives. The routes stay closed behind
-- E2EE_KEYS_ENABLED, which must not be turned on before this migration is
-- applied. Every row belongs to one user and goes with them on erasure.

-- One row per identity key a user has had. Replacing the recovery key
-- replaces the identity and starts a new generation with a fresh device
-- list; the current and three previous generations stay readable so the
-- browser can list devices to approve again. Replacement prunes older rows.
CREATE TABLE e2ee_identities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  -- base64url of the raw 65-byte P-256 public key.
  identity_key TEXT NOT NULL CHECK (length(identity_key) = 87),
  -- base64url of an identity transition statement and its signature, from
  -- the second generation on; informational, never trusted.
  transition_statement TEXT CHECK (length(transition_statement) <= 512),
  transition_signature TEXT CHECK (length(transition_signature) <= 128),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, generation)
) WITHOUT ROWID;

-- The identity-signed, hash-chained device list of each generation.
CREATE TABLE e2ee_device_list_entries (
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  -- base64url of the canonical entry, at most 32 KiB raw.
  entry TEXT NOT NULL CHECK (length(entry) <= 43700),
  signature TEXT NOT NULL CHECK (length(signature) = 87),
  -- Lowercase hex of the entry hash, computed by the Worker.
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, generation, sequence),
  FOREIGN KEY (user_id, generation)
    REFERENCES e2ee_identities(user_id, generation) ON DELETE CASCADE
) WITHOUT ROWID;

-- Wrapped and sealed keys. account-key: the account key sealed to a
-- certified unlock target (device, recovery key, passkey).
-- account-key-approval: sealed to a device approved without certification.
-- identity-key: the identity key sealed to the recovery-key or a passkey
-- target. unlock-target-key: a target's private half under its secret.
-- encryption-key: the encryption private key under the account key.
CREATE TABLE e2ee_key_wraps (
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (
    purpose IN (
      'account-key',
      'account-key-approval',
      'identity-key',
      'unlock-target-key',
      'encryption-key'
    )
  ),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  -- Device-list sequence whose account key or encryption key this wraps.
  key_sequence INTEGER NOT NULL CHECK (key_sequence >= 0),
  wrapped TEXT NOT NULL CHECK (length(wrapped) BETWEEN 1 AND 8192),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, generation, purpose, target_id),
  FOREIGN KEY (user_id, generation)
    REFERENCES e2ee_identities(user_id, generation) ON DELETE CASCADE
) WITHOUT ROWID;

-- The relay for approving a new device from an unlocked one. Short-lived;
-- the browsers authenticate the exchange (full-hash QR scan, or the
-- commitment-based six-digit comparison), never this table.
CREATE TABLE e2ee_device_approvals (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  signing_key TEXT NOT NULL CHECK (length(signing_key) = 87),
  unlock_key TEXT NOT NULL CHECK (length(unlock_key) = 87),
  commitment TEXT CHECK (length(commitment) = 43),
  approver_key TEXT CHECK (length(approver_key) = 87),
  approver_nonce TEXT CHECK (length(approver_nonce) = 43),
  device_nonce TEXT CHECK (length(device_nonce) = 43),
  grant_statement TEXT CHECK (length(grant_statement) <= 512),
  grant_signature TEXT CHECK (length(grant_signature) <= 128),
  state TEXT NOT NULL CHECK (
    state IN ('requested', 'responded', 'revealed', 'completed')
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX e2ee_device_approvals_user
  ON e2ee_device_approvals (user_id, created_at);
