/**
 * Wire types and a thin client for share links of end-to-end encrypted
 * projects (ADR-024 Phase 5, slice 5-10; roadmap L11), served under
 * `/api/e2ee/…` behind E2EE_PROJECTS_ENABLED and migration 0040. Every byte
 * string is unpadded base64url; times named `…At` are ISO strings except
 * `expiresAt`, a statement's Unix milliseconds.
 *
 * A link is `#share=<token>.<key>.<owner>` (base64url of 32 bytes each):
 * the capability token for the anonymous route, the share key, and the
 * owner's identity fingerprint. The server stores only the token's hash and
 * the share key wrapped under each key epoch's project key; the active set
 * of links lives in the encrypted, signed document (owner-signed grants and
 * tombstones). The server keeps per link the newest share-authority
 * statement ("OZA") and the newest share snapshot, and per owner the newest
 * identity-signed share delegation ("OZS").
 *
 * - `GET /api/e2ee/projects/:id/share-links` (a member): the project's live
 *   links, their key wraps, statements and snapshot positions, and the
 *   owner's delegation.
 * - `POST …/share-links` (owner): registers a link the owner just granted.
 * - `DELETE …/share-links/:shareId` (owner): forgets a link the owner just
 *   tombstoned, signed by a certified device of the owner over the
 *   project's current key epoch: its snapshot, key wraps and statement go
 *   at once.
 * - `POST …/share-links/:shareId/keys` (owner or editor): the share key
 *   under the current key epoch's project key, signed by a certified
 *   device of the caller; the first one stored wins.
 * - `PUT …/share-links/:shareId/authority` (owner): a new statement.
 * - `PUT …/share-links/:shareId/snapshot` (owner or editor): a frame with
 *   the signed share-snapshot envelope.
 * - `GET`/`PUT /api/e2ee/share-delegation` (the account itself).
 * - `GET /api/e2ee/share/:token` (anonymous): a frame with the snapshot
 *   envelope, its signature, the visitor's wrap of its version key, the
 *   author's signing key, the statement, the delegation and the owner's
 *   identity key. Never a plaintext project.
 */
import {
  E2EE_FRAME_CONTENT_TYPE,
  decodeE2eeFrame,
  encodeE2eeFrame
} from './e2ee-project-documents';

export type E2eeShareLinkMode = 'view' | 'tweak';

/** A signed statement as stored: canonical bytes and their signature. */
export interface E2eeSignedStatement {
  statement: string;
  /** 65 bytes: `u8 1 | r || s`. */
  signature: string;
}

/**
 * `POST /api/e2ee/projects/:id/share-links` (owner only), signed by the
 * sending owner device (`signShareLinkRegistration`, "OZN") over every
 * other field. The server registers the link only while `deviceId` is
 * certified in the owner's newest device list, so an owner device removed
 * while its session stays signed in cannot register links.
 */
export interface E2eeCreateShareLinkRequest {
  /** The grant's link id. */
  shareId: string;
  /** Lowercase hex SHA-256 of the link token's bytes. */
  tokenHash: string;
  mode: E2eeShareLinkMode;
  /** `shareKeyHash` of the share key (32 bytes). */
  shareKeyHash: string;
  /** The owner's identity fingerprint the link names (32 bytes). */
  ownerIdentityHash: string;
  /** The share key under the current key epoch's project key. */
  key: E2eeShareKeyWrap;
  /** The sending device, certified in the owner's device list. */
  deviceId: string;
  /** 65 bytes: `u8 1 | r || s` by `deviceId`'s certified signing key. */
  signature: string;
}

/** The share key wrapped under one key epoch's project key (41 bytes). */
export interface E2eeShareKeyWrap {
  keyEpoch: number;
  wrapped: string;
}

/**
 * `POST …/share-links/:shareId/keys`: a wrap the sending device signs
 * (`signShareKeyWrap`). The server keeps it only while `deviceId` is
 * certified in the caller's newest device list, so a revoked device of an
 * account that stays an editor cannot plant the epoch's first wrap.
 */
export interface E2eeShareKeyUpload extends E2eeShareKeyWrap {
  /** The sending device, certified in the caller's device list. */
  deviceId: string;
  /** 65 bytes: `u8 1 | r || s` by `deviceId`'s certified signing key. */
  signature: string;
}

/**
 * The body of `DELETE …/share-links/:shareId`: the sending owner device's
 * signature (`signShareLinkForget`) over the project, the link and the
 * project's current key epoch. The server forgets the link only while
 * `deviceId` is certified in the owner's newest device list, so an owner
 * device removed while its session stays signed in cannot break the links.
 */
export interface E2eeShareLinkForgetRequest {
  /** The project's current key epoch (409 `E2EE_EPOCH_STALE` otherwise). */
  keyEpoch: number;
  /** The sending device, certified in the owner's device list. */
  deviceId: string;
  /** 65 bytes: `u8 1 | r || s` by `deviceId`'s certified signing key. */
  signature: string;
}

export interface E2eeShareAuthorityRecord extends E2eeSignedStatement {
  sequence: number;
  expiresAt: number;
}

export interface E2eeShareSnapshotPosition {
  documentVersion: number;
  keyEpoch: number;
  /** Lowercase hex version hash of the snapshot envelope. */
  snapshotHash: string;
  signerDeviceId: string;
  updatedAt: string;
}

export interface E2eeShareLinkRecord {
  shareId: string;
  mode: E2eeShareLinkMode;
  shareKeyHash: string;
  ownerIdentityHash: string;
  createdAt: string;
  keys: E2eeShareKeyWrap[];
  authority: E2eeShareAuthorityRecord | null;
  snapshot: E2eeShareSnapshotPosition | null;
}

export interface E2eeShareDelegationRecord extends E2eeSignedStatement {
  sequence: number;
  expiresAt: number;
  /** The identity generation that signed it. */
  generation: number;
}

export interface E2eeShareLinksResponse {
  links: E2eeShareLinkRecord[];
  /** The project owner's current delegation; null when none. */
  delegation: E2eeShareDelegationRecord | null;
}

export interface E2eeShareLinkResponse {
  link: E2eeShareLinkRecord;
}

export interface E2eeShareKeyResponse {
  /** The wrap stored for the epoch: the caller's, or an earlier one. */
  key: E2eeShareKeyWrap;
}

export interface E2eeShareDelegationResponse {
  delegation: E2eeShareDelegationRecord | null;
}

/** Frame metadata of `PUT …/share-links/:shareId/snapshot`. */
export interface E2eeShareSnapshotUpload {
  /** `signProjectEnvelope` by `signerDeviceId`'s certified signing key. */
  signature: string;
  signerDeviceId: string;
  /** The version key under the share key (`share-version-key`, 41 bytes). */
  wrappedForLinkVisitors: string;
  /** The version key under the project key (`version-key`, 41 bytes). */
  wrappedForMembers: string;
}

/** Frame metadata of `GET /api/e2ee/share/:token`; the payload is the envelope. */
export interface E2eeSharedSnapshotMetadata {
  shareId: string;
  mode: E2eeShareLinkMode;
  documentVersion: number;
  keyEpoch: number;
  /**
   * The `versionId` both snapshot-key wraps bind: the snapshot's document
   * version in decimal.
   */
  versionId: string;
  snapshotSignature: string;
  /** The version key under the share key (`share-version-key`). */
  wrappedVersionKey: string;
  /** The author's device signing public key (65 bytes). */
  authorKey: string;
  authority: E2eeSignedStatement;
  delegation: E2eeSignedStatement;
  /** The owner's identity public key (65 bytes). */
  ownerIdentityKey: string;
}

/** The `versionId` a share snapshot's key wraps bind (ADR-024 slice 5-10). */
export function shareSnapshotVersionId(documentVersion: number): string {
  return String(documentVersion);
}

export class E2eeShareLinkApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'E2eeShareLinkApiError';
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface E2eeShareLinksApi {
  list(projectId: string): Promise<E2eeShareLinksResponse>;
  create(
    projectId: string,
    request: E2eeCreateShareLinkRequest
  ): Promise<E2eeShareLinkResponse>;
  forget(
    projectId: string,
    shareId: string,
    request: E2eeShareLinkForgetRequest
  ): Promise<{ ok: true }>;
  postKey(
    projectId: string,
    shareId: string,
    key: E2eeShareKeyUpload
  ): Promise<E2eeShareKeyResponse>;
  putAuthority(
    projectId: string,
    shareId: string,
    authority: E2eeSignedStatement
  ): Promise<E2eeShareLinkResponse>;
  putSnapshot(
    projectId: string,
    shareId: string,
    upload: E2eeShareSnapshotUpload,
    envelope: Uint8Array
  ): Promise<E2eeShareLinkResponse>;
  delegation(): Promise<E2eeShareDelegationResponse>;
  putDelegation(
    delegation: E2eeSignedStatement
  ): Promise<E2eeShareDelegationResponse>;
  /** The anonymous read; null when the link serves nothing (404). */
  shared(token: string): Promise<{
    metadata: E2eeSharedSnapshotMetadata;
    envelope: Uint8Array;
  } | null>;
}

async function refusal(response: Response): Promise<E2eeShareLinkApiError> {
  const text = await response.text().catch(() => '');
  let details: { error?: unknown; code?: unknown } = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') details = parsed;
  } catch {
    // A static host answers unknown routes with HTML.
  }
  return new E2eeShareLinkApiError(
    response.status,
    typeof details.error === 'string'
      ? details.error
      : `${response.status} ${response.statusText}`,
    typeof details.code === 'string' ? details.code : undefined
  );
}

export function createE2eeShareLinksApi(fetcher: Fetch): E2eeShareLinksApi {
  const call = async <T>(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<T> => {
    const response = await fetcher(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw await refusal(response);
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as unknown;
      if (payload && typeof payload === 'object') return payload as T;
    } catch {
      // Below.
    }
    throw new E2eeShareLinkApiError(502, 'The server answered without JSON.');
  };
  const links = (projectId: string) =>
    `/api/e2ee/projects/${encodeURIComponent(projectId)}/share-links`;
  const link = (projectId: string, shareId: string) =>
    `${links(projectId)}/${encodeURIComponent(shareId)}`;
  return {
    list: (projectId) => call(links(projectId)),
    create: (projectId, request) => call(links(projectId), 'POST', request),
    forget: (projectId, shareId, request) =>
      call(link(projectId, shareId), 'DELETE', request),
    postKey: (projectId, shareId, key) =>
      call(`${link(projectId, shareId)}/keys`, 'POST', key),
    putAuthority: (projectId, shareId, authority) =>
      call(`${link(projectId, shareId)}/authority`, 'PUT', authority),
    async putSnapshot(projectId, shareId, upload, envelope) {
      const response = await fetcher(`${link(projectId, shareId)}/snapshot`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': E2EE_FRAME_CONTENT_TYPE },
        body: encodeE2eeFrame(upload, envelope)
      });
      if (!response.ok) throw await refusal(response);
      return (await response.json()) as E2eeShareLinkResponse;
    },
    delegation: () => call('/api/e2ee/share-delegation'),
    putDelegation: (delegation) =>
      call('/api/e2ee/share-delegation', 'PUT', delegation),
    async shared(token) {
      const response = await fetcher(
        `/api/e2ee/share/${encodeURIComponent(token)}`,
        { method: 'GET', credentials: 'omit' }
      );
      if (response.status === 404) return null;
      if (!response.ok) throw await refusal(response);
      const frame = decodeE2eeFrame(
        new Uint8Array(await response.arrayBuffer())
      );
      return {
        metadata: frame.metadata as E2eeSharedSnapshotMetadata,
        envelope: frame.payload
      };
    }
  };
}
