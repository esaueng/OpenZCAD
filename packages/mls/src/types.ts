/** Public types of the MLS group-key layer (ADR-024, "MLS assessment"). */

export type Role = 'owner' | 'editor' | 'viewer';

/** A leaf of the ratchet tree: one device of one member. */
export interface LeafInfo {
  index: number;
  userId: string;
  deviceId: string;
  /** The per-project leaf signing key (P-256, SEC1 uncompressed). */
  signatureKey: Uint8Array;
  /** The device's certification of `signatureKey`, opaque to this package. */
  certification: Uint8Array;
}

export interface RoleEntry {
  userId: string;
  role: Role;
  /** The epoch in which this role took effect. */
  since: number;
}

export interface ProjectRoles {
  /** Rejoin PSKs older than this many epochs are refused. */
  rejoinWindow: number;
  users: RoleEntry[];
}

/**
 * Device lists the app has already verified (identity signatures, leaf
 * certifications). The policy runs synchronously inside WASM and cannot
 * await WebCrypto, so it reads this snapshot instead.
 */
export interface DeviceDirectory {
  users: DirectoryUser[];
}

export interface DirectoryUser {
  userId: string;
  devices: DirectoryDevice[];
}

export interface DirectoryDevice {
  deviceId: string;
  status: 'active' | 'revoked';
  /** Leaf signing keys whose certification by this device was verified. */
  leafKeys: LeafKeyCertification[];
  /** For a revoked device: the device its revocation named as replacement. */
  replacedBy?: string;
  /**
   * For a revoked device: the first epoch of this project's group whose
   * rejoin PSK it must not know (the revocation's per-project cutoff). A
   * rejoin PSK must be no earlier than the newest of the user's cutoffs; the
   * last-leaf exception waives only the stale leaf's own. Required for a
   * revoked device (0 when the group never had an epoch it could know):
   * `setDirectory` refuses a directory with a revoked device that lacks one.
   */
  revocationCutoffEpoch?: number;
}

export interface LeafKeyCertification {
  /** The per-project leaf signing key. */
  key: Uint8Array;
  /**
   * The group epoch from which the certification counts, as the device list
   * records it. A recovery Add (a leaf for an identity already listed, with
   * its unchanged role) needs one no earlier than the identity's latest leaf
   * removal, whoever commits it, the owner included; a missing value counts
   * as before that removal.
   */
  certifiedEpoch?: number;
}

export interface RemovedLeaf {
  userId: string;
  deviceId: string;
  signatureKey: Uint8Array;
}

export interface EpochChange {
  /** The new epoch, or the epoch this member was removed in. */
  epoch: number;
  /** The Commit removed this member's own leaf; the session is closed. */
  removedSelf: boolean;
  removed: RemovedLeaf[];
  added: LeafInfo[];
  rolesChanged: boolean;
  /**
   * History-archive record for the new epoch: GroupContext, public ratchet
   * tree, the Commit and every proposal it applied by reference
   * (`decodeEpochRecord`). Null after a Welcome join or a removal.
   */
  epochRecord: Uint8Array | null;
}

export interface CommitRequest {
  /** KeyPackage messages to Add. */
  add?: Uint8Array[];
  /** Leaf indexes to Remove. */
  remove?: number[];
  /** Add identities or change roles (owner only). */
  setRoles?: { userId: string; role: Role }[];
  /** Drop identities from the roles; their leaves are removed too. */
  dropUsers?: string[];
  rejoinWindow?: number;
}

export interface PendingCommit {
  commit: Uint8Array;
  /** For joiners, when the Commit adds leaves. */
  welcome: Uint8Array | null;
}

export type ProposalType =
  | 'add'
  | 'update'
  | 'remove'
  | 'psk'
  | 'reinit'
  | 'external-init'
  | 'group-context-extensions'
  | 'self-remove'
  | 'custom'
  | 'other';

export type Processed =
  | { kind: 'proposal'; proposalType: ProposalType; sender: number | null }
  | { kind: 'commit'; sender: number | null; change: EpochChange };

export interface RejoinPsk {
  epoch: number;
  secret: Uint8Array;
}

export interface RejoinRequest {
  /** Complete epoch records, from epoch zero through the GroupInfo epoch. */
  history: Uint8Array[];
  psk: RejoinPsk;
  /** A stale leaf of this user to replace in the same external Commit. */
  replaceLeaf?: number;
}

export interface RejoinResult {
  commit: Uint8Array;
  change: EpochChange;
}

/** A GroupInfo or Welcome read before acting on it. Unverified hints. */
export interface GroupInfoSummary {
  epoch: number;
  projectMatches: boolean;
  members: LeafInfo[];
  roles: ProjectRoles | null;
}

export interface SessionStatus {
  userId: string;
  deviceId: string;
  signatureKey: Uint8Array;
  certified: boolean;
  inGroup: boolean;
  removed: boolean;
  epoch: number | null;
  ownIndex: number | null;
  pendingCommit: boolean;
  /** An external rejoin the room has not accepted yet. */
  pendingRejoin: boolean;
  members: LeafInfo[];
  roles: ProjectRoles | null;
}

export interface LeafInit {
  projectId: string;
  userId: string;
  deviceId: string;
}

export interface BuildInfo {
  crate: string;
  mls: string;
  crypto: string;
  cipherSuite: number;
}

export interface EpochRecord {
  version: number;
  epoch: number;
  /** TLS-encoded GroupContext (RFC 9420 §8.1). */
  groupContext: Uint8Array;
  /** TLS-encoded public ratchet tree (RFC 9420 §12.4.3.3). */
  ratchetTree: Uint8Array;
  /** The MLSMessage Commit; empty for the group's first epoch. */
  commit: Uint8Array;
  /** MLSMessage proposals the Commit applied by reference. */
  proposals: Uint8Array[];
  /** Signed bootstrap GroupInfo in epoch zero; empty in later records. */
  groupInfo: Uint8Array;
}
