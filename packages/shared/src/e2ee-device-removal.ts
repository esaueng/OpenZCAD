/**
 * Wire types of device removal across encrypted projects and the solo group
 * reset (ADR-024 Phase 4, slice 4-10; roadmap L11; decision D9), served at
 * `/api/e2ee/revocation-cutoffs` and `/api/e2ee/projects/:id/mls/reset(s)`.
 * Every byte string is unpadded base64url, every hash lowercase hex. The
 * Worker stores what the identity key signed; browsers verify it against
 * the device list themselves.
 */
import type {
  E2eeKeyArchiveRecord,
  E2eeProjectKeyWrap,
  E2eeProjectLeafInput
} from './e2ee-project-groups';

/** One identity-signed revocation cutoff statement ("OZR"). */
export interface E2eeRevocationCutoffRecord {
  /** Identity generation and sequence of the revoking device-list entry. */
  generation: number;
  entrySequence: number;
  entryHash: string;
  statement: string;
  /** 65-byte identity signature. */
  signature: string;
  updatedAt: string;
}

/** An owned encrypted project's group and newest head, to name its cutoff. */
export interface E2eeRemovalProjectRecord {
  projectId: string;
  groupGeneration: number;
  keyEpochBase: number;
  epoch: number;
  /** The newest accepted version, if the project has one. */
  head: { documentVersion: number; versionHash: string } | null;
  /**
   * In the recycle bin (slice 4-8): a removal names it in its cutoffs but
   * cannot rotate it; the next writer does once it is restored.
   */
  trashed?: true;
}

export interface E2eeRevocationCutoffsResponse {
  /** The caller's statements, every identity generation. */
  statements: E2eeRevocationCutoffRecord[];
  /** The caller's encrypted projects that have an MLS group. */
  projects: E2eeRemovalProjectRecord[];
}

/**
 * `GET /api/e2ee/projects/:id/revocation-cutoffs` (slice 5-2): every
 * other member's identity-signed revocation cutoff statements (the owner's
 * included), for a member of the project. Browsers verify each against
 * that member's verified device list before using it.
 */
export interface E2eeMemberRevocationCutoffsResponse {
  statements: (E2eeRevocationCutoffRecord & { userId: string })[];
}

export interface E2eeRevocationCutoffRequest {
  generation: number;
  entrySequence: number;
  statement: string;
  signature: string;
}

export interface E2eeRevocationCutoffResponse {
  statement: E2eeRevocationCutoffRecord;
}

/** One identity-authorized solo group reset ("OZX"). */
export interface E2eeGroupResetRecord {
  /** The new group's generation and key-epoch base. */
  generation: number;
  keyEpochBase: number;
  priorGroupId: string;
  priorEpoch: number;
  identityGeneration: number;
  statement: string;
  signature: string;
  createdAt: string;
}

export interface E2eeGroupResetsResponse {
  resets: E2eeGroupResetRecord[];
}

/**
 * Replace a solo project's MLS group (decision D9): the signed reset, the
 * group state it replaces, and everything the new group's epoch 0 needs,
 * in one write. Wraps and archive are for key epoch `priorKeyEpoch + 1`.
 */
export interface E2eeGroupResetRequest {
  statement: string;
  signature: string;
  groupId: string;
  deviceId: string;
  groupInfo: string;
  leaf: E2eeProjectLeafInput;
  wraps: E2eeProjectKeyWrap[];
  archive: E2eeKeyArchiveRecord;
}
