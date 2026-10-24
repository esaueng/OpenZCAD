/**
 * Wire types of the encrypted-project MLS routes (ADR-024 Phase 4, solo
 * groups; roadmap L11), served under `/api/e2ee/projects/:id/…`. Every byte
 * string is unpadded base64url. The Worker orders and stores; browsers
 * verify everything that comes back.
 */

/** What an account-key wrap in the project key store holds. */
export type E2eeProjectKeyPurpose = 'project-key' | 'rejoin-psk';

/**
 * One key wrapped under the caller's account key. `keyEpoch` is the
 * monotonic project-key generation (decision D10); for `rejoin-psk` the MLS
 * epoch the wrap context names is `keyEpoch - keyEpochBase`.
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
}

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

export interface E2eeKeyArchivesResponse {
  archives: E2eeKeyArchiveRecord[];
  more: boolean;
}

/** 409 when another Commit already took the epoch: rebase onto `winner`. */
export const E2EE_EPOCH_TAKEN_CODE = 'EPOCH_TAKEN';
