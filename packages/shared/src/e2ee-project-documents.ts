/**
 * Wire types of the encrypted document routes (ADR-024 Phase 4, encrypted
 * documents; roadmap L11), served under `/api/e2ee/projects` and
 * `/api/e2ee/projects/:id/…`. Byte strings in JSON are unpadded base64url;
 * version hashes are lowercase hex. Envelopes travel as raw bytes in an
 * `E2EE_FRAME_CONTENT_TYPE` frame, so a 24 MiB document is never inflated
 * into base64 text. The Worker stores and orders; browsers verify everything
 * that comes back.
 */
import type { ProjectOrganization } from './index';
import type { E2eeCreateProjectGroupRequest } from './e2ee-project-groups';

/** `u32 BE metadata length | metadata (UTF-8 JSON) | payload bytes`. */
export const E2EE_FRAME_CONTENT_TYPE = 'application/vnd.openzcad.e2ee-frame';
/** Metadata is small: ids, hashes, signatures, wraps and log records. */
export const MAX_E2EE_FRAME_METADATA_BYTES = 8 * 1024 * 1024;

export class E2eeFrameError extends Error {
  override readonly name = 'E2eeFrameError';
}

/** One frame: JSON metadata followed by an envelope (or nothing). */
export function encodeE2eeFrame(
  metadata: unknown,
  payload: Uint8Array = new Uint8Array(0)
): Uint8Array<ArrayBuffer> {
  const meta = new TextEncoder().encode(JSON.stringify(metadata));
  if (meta.byteLength > MAX_E2EE_FRAME_METADATA_BYTES) {
    throw new E2eeFrameError('Frame metadata is too large.');
  }
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

export function decodeE2eeFrame(
  bytes: Uint8Array,
  maxMetadataBytes = MAX_E2EE_FRAME_METADATA_BYTES
): { metadata: unknown; payload: Uint8Array } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) {
    throw new E2eeFrameError('Not an encrypted-project frame.');
  }
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(0);
  if (length > maxMetadataBytes || 4 + length > bytes.byteLength) {
    throw new E2eeFrameError('Frame metadata is malformed.');
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(4, 4 + length)
      )
    );
  } catch {
    throw new E2eeFrameError('Frame metadata is not JSON.');
  }
  return { metadata, payload: bytes.subarray(4 + length) };
}

/**
 * What travels beside a signed document envelope. The Worker computes the
 * version hash itself and checks that the header names the stored head's.
 */
export interface E2eeVersionUpload {
  /** The head the write builds on; 0 when creating the project. */
  expectedVersion: number;
  /** `signProjectEnvelope` by `signerDeviceId`'s certified signing key. */
  signature: string;
  /** The version key under the header's key epoch's project key (41 bytes). */
  wrappedVersionKey: string;
  signerDeviceId: string;
}

/** A named save: a version plus the revision id the document gained. */
export interface E2eeRevisionUpload extends E2eeVersionUpload {
  revisionId: string;
}

/** A replaced small envelope, such as the project-info envelope. */
export interface E2eeProjectEnvelopeUpload {
  /** Must exceed the stored sequence (1 for the first). */
  sequence: number;
  envelope: string;
  wrappedVersionKey: string;
  signature: string;
  signerDeviceId: string;
}

export interface E2eeProjectEnvelopeRecord extends E2eeProjectEnvelopeUpload {
  projectId: string;
  kind: 'project-info';
  keyEpoch: number;
  updatedAt: string;
}

/**
 * `POST /api/e2ee/projects`: the format-2 project row, its MLS group (as
 * `POST …/mls/group-info` takes it), its first version (the frame payload)
 * and its project-info envelope, in one write.
 */
export interface E2eeCreateProjectMetadata {
  projectId: string;
  group: E2eeCreateProjectGroupRequest;
  version: E2eeVersionUpload;
  info: E2eeProjectEnvelopeUpload;
}

/** One version log record, as `verifyVersionLog` takes it. */
export interface E2eeVersionLogEntry {
  documentVersion: number;
  keyEpoch: number;
  versionHash: string;
  /** The envelope prefix. */
  prefix: string;
  signature: string;
  /** Null once the signer's account was erased. */
  signerUserId: string | null;
  signerDeviceId: string;
  createdAt: string;
}

/** A stored version whose body is retained. */
export interface E2eeStoredVersion extends E2eeVersionLogEntry {
  wrappedVersionKey: string;
  envelopeBytes: number;
}

export interface E2eeProjectState {
  projectId: string;
  documentVersion: number;
  revisionCount: number;
  lastRevisionId: string | null;
  /** The account's last recorded activity (plaintext, so only a hint). */
  updatedAt: string;
  organization: ProjectOrganization;
}

/**
 * `GET …/document[?since=N]`: frame metadata; the payload is the head's
 * envelope. `log` holds the head's record and, with `since`, every record
 * from version `since` (inclusive) up to it, oldest first, at most one
 * page: with `more`, fetch `…/versions?since=<last version>` for the rest.
 */
export interface E2eeDocumentHeadMetadata {
  project: E2eeProjectState;
  head: E2eeStoredVersion;
  log: E2eeVersionLogEntry[];
  more: boolean;
  /** The group's current key epoch, as the sequencer holds it. */
  keyEpoch: number;
}

/** `GET …/versions?since=N`: up to one page of log records from `since`. */
export interface E2eeVersionLogResponse {
  log: E2eeVersionLogEntry[];
  more: boolean;
}

/** `GET …/revisions/:revisionId`: frame metadata; the payload is the envelope. */
export interface E2eeRevisionMetadata {
  revisionId: string;
  version: E2eeStoredVersion;
}

export interface E2eeRevisionRecord {
  revisionId: string;
  documentVersion: number;
  versionHash: string;
  createdAt: string;
  authorUserId: string | null;
  documentBytes: number;
}

export interface E2eeRevisionsResponse {
  revisions: E2eeRevisionRecord[];
  maxRevisions: number;
}

/** A version write's acknowledgement. */
export interface E2eeSaveVersionResponse {
  projectId: string;
  version: number;
  versionHash: string;
  updatedAt: string;
}

export interface E2eeCreateProjectResponse extends E2eeSaveVersionResponse {
  project: E2eeProjectState;
}

export interface E2eeProjectInfoResponse {
  info: E2eeProjectEnvelopeRecord | null;
}

/**
 * `GET /api/projects` adds the project-info envelopes of the caller's
 * format-2 projects, so the shelf can name them without their documents.
 */
export interface E2eeListProjectsExtension {
  encryptedProjectInfo?: E2eeProjectEnvelopeRecord[];
}

/** How many version log records one response carries at most. */
export const E2EE_VERSION_LOG_PAGE = 1024;
/** Decision D6: the log keeps the last 2,000 heads plus every retained revision. */
export const E2EE_VERSION_LOG_RETAINED_HEADS = 2000;

/** The encrypted routes' version conflict: reload, verify, then decide. */
export const E2EE_VERSION_CONFLICT_CODE = 'REVISION_CONFLICT';
