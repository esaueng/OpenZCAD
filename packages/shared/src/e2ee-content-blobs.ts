/**
 * Wire types of the encrypted content blob routes (ADR-024 Phase 4, content
 * blobs; roadmap L11), under `/api/e2ee/projects/:id/blobs…`. A content blob
 * is an imported source, a mesh payload or a reference image's picture,
 * encrypted in the browser under its own random key. Its bytes travel
 * through the ordinary upload sessions (`/api/uploads/:id/…`); these routes
 * open such a session for a blob id the browser proposes, commit it, find a
 * blob by its dedupe tag and serve its ciphertext. The key and the hash that
 * authenticate a blob live only inside the encrypted document that
 * references it.
 */

/** Blob ids are 16 random bytes in lowercase hex, minted by the crypto package. */
export const E2EE_BLOB_ID_PATTERN = /^[0-9a-f]{32}$/;
/** A dedupe tag: lowercase hex HMAC-SHA256 under the project's dedupe secret. */
export const E2EE_DEDUPE_TAG_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The content blob kinds browsers upload: imported sources and mesh
 * payloads, which documents name (slice 4-6), and thumbnails and archived
 * exports, which the project-info envelope names (slice 4-7).
 */
export const E2EE_UPLOADABLE_BLOB_KINDS = Object.freeze([
  'import-source',
  'mesh-payload',
  'thumbnail',
  'export'
] as const);
export type E2eeUploadableBlobKind =
  (typeof E2EE_UPLOADABLE_BLOB_KINDS)[number];

/**
 * How long a committed blob that no retained version references survives
 * before garbage collection, so the save that will reference an upload has
 * time to land (judgment: a day, like the source-blob claims).
 */
export const E2EE_UNREFERENCED_BLOB_GRACE_MS = 24 * 60 * 60 * 1000;

/** `POST /api/e2ee/projects/:id/blobs/uploads`. */
export interface E2eeBlobUploadRequest {
  readonly blobId: string;
  readonly kind: E2eeUploadableBlobKind;
}

/** An upload session for the blob, or the blob when it is already committed. */
export type E2eeBlobUploadResponse =
  | {
      readonly committed: false;
      readonly session: {
        readonly uploadSessionId: string;
        /** The ordinary single-part upload route of the session. */
        readonly uploadUrl: string;
        readonly expiresAt: string;
        readonly blobId: string;
      };
    }
  | {
      readonly committed: true;
      readonly blobId: string;
      readonly ciphertextBytes: number;
    };

/** `POST /api/e2ee/projects/:id/blobs/:blobId/finalize`. */
export interface E2eeBlobFinalizeRequest {
  readonly uploadSessionId: string;
  /** The plaintext's dedupe tag; a later upload of the same file finds it. */
  readonly dedupeTag?: string;
}

export interface E2eeBlobFinalizeResponse {
  readonly blobId: string;
  readonly kind: E2eeUploadableBlobKind;
  readonly ciphertextBytes: number;
}

/** `GET /api/e2ee/projects/:id/blobs?tag=…`: the committed blob with that tag. */
export interface E2eeBlobLookupResponse {
  readonly blobId: string | null;
}
