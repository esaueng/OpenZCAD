/**
 * Wire types of the encrypted-project MLS routes (ADR-024 Phase 4, solo
 * groups; roadmap L11), served under `/api/e2ee/projects/:id/…`. Every byte
 * string is unpadded base64url. The Worker orders and stores; browsers
 * verify everything that comes back.
 */
import type { E2eeMlsAddRequest } from './e2ee-invitations';

/** What an account-key wrap in the project key store holds. */
export type E2eeProjectKeyPurpose = 'project-key' | 'rejoin-psk';

/**
 * One key wrapped under the caller's account key. `keyEpoch` is the
 * monotonic project-key generation (decision D10), and both purposes' wrap
 * contexts bind it. For `rejoin-psk` the PSK's MLS epoch is
 * `keyEpoch - keyEpochBase`; the wrap does not bind that, because MLS epochs
 * restart at 0 after a group reset.
 */
export interface E2eeProjectKeyWrap {
  keyEpoch: number;
  purpose: E2eeProjectKeyPurpose;
  /** Which account key wraps it: identity generation and key sequence. */
  accountKeyGeneration: number;
  accountKeySequence: number;
  /** 41-byte AES-KW wrap. */
  wrapped: string;
}

/** A signed `key-archive` project envelope for one key epoch. */
export interface E2eeKeyArchiveRecord {
  keyEpoch: number;
  envelope: string;
  /** The envelope's version key under that epoch's project key (41 bytes). */
  wrappedVersionKey: string;
  /** `signProjectEnvelope` by `signerDeviceId`'s certified signing key. */
  signature: string;
  signerDeviceId: string;
}

/** A leaf key the sending device certified for the project. */
export interface E2eeProjectLeafInput {
  /** 65-byte P-256 leaf signing key. */
  leafKey: string;
  /** 73-byte version-2 leaf certification. */
  certification: string;
}

export interface E2eeProjectLeafRecord extends E2eeProjectLeafInput {
  userId: string;
  deviceId: string;
  createdAt: string;
}

export interface E2eeProjectGroupRecord {
  groupId: string;
  /** Identity-authorized resets so far (decision D9); 0 for the first group. */
  generation: number;
  /** Key epoch of this group's epoch 0: key epoch = base + MLS epoch. */
  keyEpochBase: number;
  /** The group's current epoch as the sequencer accepted it. */
  epoch: number;
  /** The newest GroupInfo, for an owner device's external Commit. */
  groupInfo: string;
  groupInfoEpoch: number;
  /** The signed epoch-zero GroupInfo every join archive starts from. */
  initialGroupInfo: string;
  updatedAt: string;
  /**
   * Proposals stored for the current epoch that no Commit settled yet
   * (slice 5-5, migration 0039: a departing member's SelfRemove). Absent
   * without the migration.
   */
  pendingProposals?: number;
  /**
   * Set for the reader when a device removal of its own account named this
   * project and the Worker has not yet seen that account's member Commit
   * reaching the cutoff (slice 5-7). Its browsers then commit one; until
   * they do, every writer is fenced off.
   */
  rotationDue?: true;
}

export interface E2eeProjectGroupResponse {
  group: E2eeProjectGroupRecord;
}

/** Create the project's group: everything epoch 0 needs, in one write. */
export interface E2eeCreateProjectGroupRequest {
  groupId: string;
  /** The creating device; it must be certified in the caller's device list. */
  deviceId: string;
  /** The epoch-zero GroupInfo (also stored as the initial GroupInfo). */
  groupInfo: string;
  leaf: E2eeProjectLeafInput;
  /** The epoch-zero project key and rejoin PSK under the account key. */
  wraps: E2eeProjectKeyWrap[];
  archive: E2eeKeyArchiveRecord;
}

export type E2eeMlsCommitKind = 'commit' | 'external';

/**
 * A Commit for `epoch` (the group's current epoch), with what the new epoch
 * (`epoch + 1`) needs: its GroupInfo, the project key and rejoin PSK under
 * the sender's account key, its key archive, and for an external Commit the
 * joining device's certified leaf. Accepted all together or not at all.
 * An owner's Add of an invitee (slice 5-3a, migration 0038) also states the
 * invitation, exactly the KeyPackages it claimed and the Welcome. An
 * owner’s role change (slice 5-4) states it in `roles`.
 */
export interface E2eeMlsCommitRequest {
  epoch: number;
  kind: E2eeMlsCommitKind;
  deviceId: string;
  message: string;
  groupInfo: string;
  leaf?: E2eeProjectLeafInput;
  wraps: E2eeProjectKeyWrap[];
  archive: E2eeKeyArchiveRecord;
  add?: E2eeMlsAddRequest;
  /**
   * The role changes of current members this Commit’s `setRoles` makes
   * (slice 5-4; owner only). The Worker mirrors them into
   * `project_members` in the Commit’s own batch, and refuses any Commit
   * whose new GroupInfo lists other roles than the current epoch’s with
   * exactly the stated changes (and an Add’s invitee) applied
   * (409 `E2EE_ROLES_MISMATCH`). Ownership never moves on an encrypted
   * project (409 `E2EE_OWNERSHIP_TRANSFER_UNAVAILABLE`).
   */
  roles?: E2eeMlsRoleChange[];
  /**
   * The identities this Commit's `dropUsers` removes from the roles, with
   * all of their leaves (owner only). The Worker deletes their
   * `project_members` rows in the same batch; the new roles must no longer
   * list them (checked as for `roles`).
   */
  dropUsers?: string[];
  /**
   * The hashes (SHA-256 hex of the message) of the stored proposals of this
   * epoch the Commit applies by reference (slice 5-5, migration 0039), and
   * of those the committer's MLS engine refused. Together they must name
   * every proposal still pending in the epoch, or the Commit is refused
   * (409 `E2EE_PROPOSALS_PENDING`).
   */
  proposals?: string[];
  rejectedProposals?: string[];
}

/** What a stored proposal asks for (slice 5-5): so far only leaving. */
export type E2eeMlsProposalKind = 'self-remove';

/** A proposal stored for another member to commit (migration 0039). */
export interface E2eeMlsProposalRecord {
  /** The key epoch it was sent in (key-epoch base + MLS epoch). */
  keyEpoch: number;
  /** SHA-256 hex of the message bytes. */
  proposalHash: string;
  kind: E2eeMlsProposalKind;
  /** Null once the sender's account was erased. */
  senderUserId: string | null;
  senderDeviceId: string | null;
  /** The MLS PublicMessage proposal. */
  message: string;
  createdAt: string;
}

/**
 * `GET /api/e2ee/projects/:id/mls/proposals[?keyEpoch=]` (a member): the
 * proposals still pending in that key epoch (the current one by default),
 * those its Commit applied by reference (which every member must process
 * before that Commit), and the members who left by one and hold no
 * membership any more, for the owner to drop from the roles. Empty, with
 * `available: false`, until migration 0039 is applied.
 */
export interface E2eeMlsProposalsResponse {
  available: boolean;
  keyEpoch: number;
  proposals: E2eeMlsProposalRecord[];
  committed: E2eeMlsProposalRecord[];
  departed: string[];
}

/**
 * `POST …/mls/proposals` (a member other than the owner): leave by a
 * SelfRemove proposal sent in the group's current MLS `epoch`. The Worker
 * drops the sender's access in the same batch (decision M4).
 */
export interface E2eeMlsProposalRequest {
  epoch: number;
  /** The sending device, certified in the caller's newest device list. */
  deviceId: string;
  kind: E2eeMlsProposalKind;
  message: string;
}

export interface E2eeMlsProposalResponse {
  proposal: E2eeMlsProposalRecord;
}

/** One member’s new role in an owner’s `setRoles` Commit (slice 5-4). */
export interface E2eeMlsRoleChange {
  userId: string;
  role: 'editor' | 'viewer';
}

/** 409 when a Commit’s new roles are not the change it states. */
export const E2EE_ROLES_MISMATCH_CODE = 'E2EE_ROLES_MISMATCH';
/** 409: an encrypted project’s owner never changes (slice 5-4). */
export const E2EE_OWNERSHIP_TRANSFER_CODE =
  'E2EE_OWNERSHIP_TRANSFER_UNAVAILABLE';

export interface E2eeMlsCommitRecord {
  /** The epoch the Commit was sent in; applying it yields `epoch + 1`. */
  epoch: number;
  kind: E2eeMlsCommitKind;
  /** Null once the sender's account was erased. */
  senderUserId: string | null;
  senderDeviceId: string | null;
  message: string;
  createdAt: string;
}

export interface E2eeMlsCommitResponse {
  commit: E2eeMlsCommitRecord;
  group: E2eeProjectGroupRecord;
}

export interface E2eeMlsCommitsResponse {
  commits: E2eeMlsCommitRecord[];
  /** More Commits follow the last one returned. */
  more: boolean;
}

export interface E2eeProjectLeavesResponse {
  leaves: E2eeProjectLeafRecord[];
}

export interface E2eeProjectKeysResponse {
  /** The caller's own wraps only, ascending by key epoch then purpose. */
  wraps: E2eeProjectKeyWrap[];
  more: boolean;
}

/**
 * `POST /api/e2ee/projects/:id/keys` (slice 5-2): a member's browser posts
 * its own account-wrapped project key and rejoin PSK for an epoch it
 * reached by processing someone else's Commit (decision D1), so its other
 * devices can read and rejoin. Only ever the caller's own wraps; a wrap
 * already stored is kept, never replaced.
 */
export interface E2eeProjectKeyUploadRequest {
  /** The posting device, certified in the caller's newest device list. */
  deviceId: string;
  keyEpoch: number;
  /** One project-key and one rejoin-psk wrap for `keyEpoch`. */
  wraps: E2eeProjectKeyWrap[];
}

export interface E2eeProjectKeyUploadResponse {
  /** The caller's wraps for that key epoch, as stored. */
  wraps: E2eeProjectKeyWrap[];
}

export interface E2eeKeyArchivesResponse {
  archives: E2eeKeyArchiveRecord[];
  more: boolean;
}

/** 409 when another Commit already took the epoch: rebase onto `winner`. */
export const E2EE_EPOCH_TAKEN_CODE = 'EPOCH_TAKEN';
