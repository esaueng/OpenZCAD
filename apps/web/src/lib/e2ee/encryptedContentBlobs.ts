/**
 * Encrypted content blobs in the browser (ADR-024 Phase 4, content blobs;
 * roadmap L11): the imported sources, mesh payloads and reference-image
 * pictures of an end-to-end encrypted project.
 *
 * - **Archive.** `archive` is the encrypting transport behind
 *   `archiveArtifact`. It tags the plaintext with `assetDedupeHash` under
 *   the project's dedupe secret (from the current key archive) and asks the
 *   account for that tag; a blob this page already holds the reference for,
 *   with the same plaintext checksum, is reused. Otherwise the blob is
 *   encrypted under a fresh key (`encryptContentBlobStream`, which drives
 *   `createContentBlobWriter`), uploaded through the ordinary single-part or
 *   multipart upload session opened for its header's `blobId`, and
 *   committed with its tag. The returned artifact id is the blob id; the
 *   reference (key, ciphertext hash, size) stays on this page until a
 *   document body carries it.
 * - **Write.** `documentBlobReferences` gives the references a document
 *   names, in a stable order; the sealed header's `blobIds` are derived from
 *   exactly that list (`decodeJobs.ts`), and `checkBlobReferences` runs on
 *   every write.
 * - **Read.** `read` downloads the ciphertext and decrypts it in the decode
 *   worker against the reference, so a swapped, truncated or resized blob
 *   fails there.
 * - **Thumbnails and exports** (slice 4-7) are archived the same way; the
 *   project-info envelope, not a document, names them.
 * - **Restore.** When the account lost or collected a blob a document still
 *   names, `restore` stores it again from this device's source store: the
 *   bytes must match the checksum and length the page holds for that blob,
 *   and are encrypted under a fresh key with the same blob id
 *   (`ContentBlobOptions.blobId`), so one key still encrypts one envelope
 *   and the next version carries the new reference.
 */
import {
  E2eeError,
  EnvelopeKey,
  PLAINTEXT_CEILINGS,
  assetDedupeHash,
  encryptContentBlobStream,
  importAssetDedupeSecret,
  toHex,
  type Compression,
  type ContentBlobKind,
  type ContentBlobReference
} from '@openzcad/crypto';
import {
  documentNodesWithHistory,
  importedSourceReferenceOf,
  referenceImagesWithHistory,
  type ArtifactKind,
  type CompleteMultipartUploadRequest,
  type E2eeBlobFinalizeRequest,
  type E2eeBlobFinalizeResponse,
  type E2eeBlobLookupResponse,
  type E2eeBlobUploadRequest,
  type E2eeBlobUploadResponse,
  type E2eeUploadableBlobKind,
  type ProjectDocument,
  type UploadedArtifactPart
} from '@openzcad/shared';
import { importArtifactIds } from '@openzcad/persistence';
import { UnstorableDocumentError } from '@openzcad/document-core';
import { ApiError, encryptedLocalOnly } from '../api';
import type { ArchiveArtifactInput } from '../archiveArtifact';
import {
  uploadArtifactBody,
  type ArtifactUploadTransport
} from '../artifactUpload';
import { desktopFetch } from '../desktopBridge';
import {
  decodeContentBlobJob,
  type ContentBlobDecodeJob,
  type ContentBlobDecodeResult
} from './decodeJobs';
import type { BlobReferenceRegistry } from './blobReferences';
import {
  dedupeSecretForProject,
  type ProjectGroupContext
} from './projectGroups';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Device-only artifact ids: never uploaded, so they need no reference. */
const LOCAL_ARTIFACT_PREFIX = 'artifact_local_';

// --- Routes ----------------------------------------------------------------

export interface ContentBlobsApi {
  lookup(projectId: string, tag: string): Promise<string | null>;
  startUpload(
    projectId: string,
    request: E2eeBlobUploadRequest
  ): Promise<E2eeBlobUploadResponse>;
  finalize(
    projectId: string,
    blobId: string,
    request: E2eeBlobFinalizeRequest
  ): Promise<E2eeBlobFinalizeResponse>;
  /** The ciphertext, read up to `maxBytes`. */
  download(
    projectId: string,
    blobId: string,
    maxBytes: number,
    signal?: AbortSignal,
    onProgress?: () => void
  ): Promise<Blob>;
}

async function refusal(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '');
  let details: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    // A static host answers unknown routes with HTML.
  }
  return new ApiError(
    response.status,
    typeof details?.error === 'string'
      ? details.error
      : `${response.status} ${response.statusText}`,
    typeof details?.code === 'string' ? details.code : undefined,
    details
  );
}

const blobsPath = (projectId: string) =>
  `/api/e2ee/projects/${encodeURIComponent(projectId)}/blobs`;

export function createContentBlobsApi(
  fetcher: Fetch = desktopFetch
): ContentBlobsApi {
  const send = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {})
      }
    });
    if (!response.ok) throw await refusal(response);
    return (await response.json()) as T;
  };
  return {
    lookup: async (projectId, tag) =>
      (
        await send<E2eeBlobLookupResponse>(
          `${blobsPath(projectId)}?tag=${encodeURIComponent(tag)}`
        )
      ).blobId,
    startUpload: (projectId, request) =>
      send(`${blobsPath(projectId)}/uploads`, {
        method: 'POST',
        body: JSON.stringify(request)
      }),
    finalize: (projectId, blobId, request) =>
      send(`${blobsPath(projectId)}/${encodeURIComponent(blobId)}/finalize`, {
        method: 'POST',
        body: JSON.stringify(request)
      }),
    async download(projectId, blobId, maxBytes, signal, onProgress) {
      const response = await fetcher(
        `${blobsPath(projectId)}/${encodeURIComponent(blobId)}`,
        { credentials: 'same-origin', ...(signal ? { signal } : {}) }
      );
      if (!response.ok) throw await refusal(response);
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new E2eeError(
          'limit-exceeded',
          'The encrypted file is too large'
        );
      }
      const reader = response.body?.getReader();
      if (!reader) return new Blob([]);
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onProgress?.();
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new E2eeError(
            'limit-exceeded',
            'The encrypted file is too large'
          );
        }
        parts.push(new Uint8Array(value));
      }
      return new Blob(parts);
    }
  };
}

/** The ordinary upload-session routes, as `api.ts` calls them. */
export function uploadTransport(
  fetcher: Fetch = desktopFetch
): ArtifactUploadTransport {
  const check = async (response: Response) => {
    if (!response.ok) throw await refusal(response);
    return response;
  };
  const uploads = (id: string) => `/api/uploads/${encodeURIComponent(id)}`;
  return {
    async uploadArtifact(uploadUrl, body) {
      if (!uploadUrl.startsWith('/api/uploads/')) {
        throw new Error('Artifact upload URL must use the application origin.');
      }
      await check(
        await fetcher(uploadUrl, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body
        })
      );
    },
    createMultipartUpload: async (uploadSessionId) =>
      (await (
        await check(
          await fetcher(`${uploads(uploadSessionId)}/multipart`, {
            method: 'POST',
            credentials: 'same-origin'
          })
        )
      ).json()) as { uploadId: string },
    uploadArtifactPart: async (uploadSessionId, uploadId, partNumber, body) =>
      (await (
        await check(
          await fetcher(
            `${uploads(uploadSessionId)}/parts/${partNumber}?uploadId=${encodeURIComponent(uploadId)}`,
            {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/octet-stream' },
              body
            }
          )
        )
      ).json()) as UploadedArtifactPart,
    async completeMultipartUpload(
      uploadSessionId,
      payload: CompleteMultipartUploadRequest
    ) {
      await check(
        await fetcher(`${uploads(uploadSessionId)}/multipart/complete`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        })
      );
    },
    async abortMultipartUpload(uploadSessionId, uploadId) {
      await check(
        await fetcher(
          `${uploads(uploadSessionId)}/multipart?uploadId=${encodeURIComponent(uploadId)}`,
          { method: 'DELETE', credentials: 'same-origin' }
        )
      );
    }
  };
}

// --- Documents ---------------------------------------------------------------

/**
 * The plaintext checksum each blob id stands for in a document: an import's
 * source or mesh payload reference, or a reference image's picture, in the
 * model and in its undo history.
 */
export function documentBlobChecksums(
  document: ProjectDocument
): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const node of documentNodesWithHistory(document)) {
    if (node?.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    const artifactId = (node.data as { artifactId?: unknown }).artifactId;
    if (ref && typeof artifactId === 'string') {
      checksums.set(artifactId, ref.checksumSha256);
    }
  }
  for (const image of referenceImagesWithHistory(document)) {
    const checksum = image?.source?.checksumSha256;
    if (typeof image?.artifactId === 'string' && typeof checksum === 'string') {
      checksums.set(image.artifactId, checksum);
    }
  }
  return checksums;
}

/** What a verified document body tells this page about the blobs it names. */
export function rememberDocumentBlobs(
  registry: BlobReferenceRegistry,
  projectId: string,
  blobs: readonly ContentBlobReference[],
  document: ProjectDocument
): void {
  const checksums = documentBlobChecksums(document);
  for (const reference of blobs) {
    registry.remember(
      projectId,
      reference,
      checksums.get(reference.blobId) ?? null
    );
  }
}

/** A lost blob this device holds no matching copy of. */
export const E2EE_BLOB_RESTORE_MESSAGE =
  'The account no longer holds a file this project names, and this device has no copy of it. Import the file again.';

/** Every write: the body's blob table names files this page holds keys for. */
export const E2EE_BLOB_KEY_MISSING_MESSAGE =
  'This project names a file this browser has no key for. Reopen the project, or remove and import the file again.';

/**
 * The references a document names (imports, mesh payloads and pictures, in
 * the model and its undo history), sorted by blob id. Device-only ids need
 * none. A name this page holds no reference for cannot be written: the body
 * would not authenticate it.
 */
export function documentBlobReferences(
  registry: BlobReferenceRegistry,
  projectId: string,
  document: ProjectDocument
): ContentBlobReference[] {
  const references: ContentBlobReference[] = [];
  for (const id of importArtifactIds(document).sort()) {
    if (id.startsWith(LOCAL_ARTIFACT_PREFIX)) continue;
    const held = registry.get(projectId, id);
    if (!held) throw new UnstorableDocumentError(E2EE_BLOB_KEY_MISSING_MESSAGE);
    references.push(held.reference);
  }
  return references;
}

// --- Archive and read --------------------------------------------------------

/** How each archived artifact kind is stored as a content blob. */
export function contentBlobKindFor(kind: ArtifactKind): {
  kind: E2eeUploadableBlobKind;
  compression: Compression;
} {
  switch (kind) {
    case 'step-import':
      return { kind: 'import-source', compression: 'gzip' };
    case 'mesh-payload':
      return { kind: 'mesh-payload', compression: 'gzip' };
    case 'reference-image':
      // PNG and JPEG are compressed already; stored as is, a cut-short
      // picture is also visible to the Worker by its length.
      return { kind: 'import-source', compression: 'none' };
    case 'thumbnail':
      // WebP is compressed already.
      return { kind: 'thumbnail', compression: 'none' };
    case 'step-export':
    case 'stl-export':
    case '3mf-export':
    case 'obj-export':
    case 'gltf-export':
    case 'ply-export':
      return { kind: 'export', compression: 'gzip' };
    default:
      // Original mesh files and snapshots: nothing an encrypted project
      // names.
      throw encryptedLocalOnly('Stored files');
  }
}

/** The most ciphertext a reference's blob can take: tags, gzip and a prefix. */
export function maxCiphertextBytes(reference: ContentBlobReference): number {
  return Math.ceil(reference.plaintextLength * 1.3) + 1024 * 1024;
}

export interface EncryptedContentBlobContext {
  readonly groups: ProjectGroupContext;
  readonly references: BlobReferenceRegistry;
  readonly api?: ContentBlobsApi;
  readonly transport?: ArtifactUploadTransport;
  /** Defaults to decrypting in-line; pages pass the decode worker. */
  readonly decode?: (
    job: Omit<ContentBlobDecodeJob, 'type'>
  ) => Promise<ContentBlobDecodeResult>;
  /** Upload part size; tests make it small. */
  readonly partBytes?: number;
  /** Envelope chunk size; tests make it small. */
  readonly chunkSize?: number;
  /** This device's copy of a source, by plaintext SHA-256 (for `restore`). */
  readonly loadLocal?: (checksumSha256: string) => Promise<Uint8Array | null>;
}

export interface EncryptedContentBlobs {
  /** Encrypts and stores one file; resolves to its blob id. */
  archive(projectId: string, input: ArchiveArtifactInput): Promise<string>;
  /**
   * Stores again blobs the account lost or collected, from this device's
   * copies, under their ids and fresh keys; the page then holds the new
   * references. Refuses a blob it has no matching copy of.
   */
  restore(projectId: string, blobIds: readonly string[]): Promise<void>;
  /** Downloads and decrypts a blob this page holds the reference for. */
  read(
    projectId: string,
    blobId: string,
    signal?: AbortSignal,
    onProgress?: () => void
  ): Promise<Uint8Array<ArrayBuffer>>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
    )
  );
}

async function encryptBlob(
  kind: ContentBlobKind,
  plaintext: Uint8Array,
  compression: Compression,
  chunkSize: number | undefined,
  blobId?: string
): Promise<{ envelope: Blob; reference: ContentBlobReference }> {
  const source = new Blob([plaintext as Uint8Array<ArrayBuffer>]).stream();
  const stream = encryptContentBlobStream(
    EnvelopeKey.generate(),
    kind,
    source,
    {
      plaintextLength: plaintext.byteLength,
      compression,
      ...(chunkSize ? { chunkSize } : {}),
      ...(blobId ? { blobId } : {})
    }
  );
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const reader = stream.envelope.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return { envelope: new Blob(parts), reference: await stream.reference };
}

export function createEncryptedContentBlobs(
  ctx: EncryptedContentBlobContext
): EncryptedContentBlobs {
  const api = ctx.api ?? createContentBlobsApi();
  const transport = ctx.transport ?? uploadTransport();
  const decode =
    ctx.decode ??
    ((job) => decodeContentBlobJob({ type: 'content-blob', ...job }));
  const dedupeKeys = new Map<string, Promise<CryptoKey>>();

  /** The dedupe key of the project's current key epoch, cached per epoch. */
  async function dedupeKeyOf(projectId: string): Promise<CryptoKey> {
    const { keyEpoch, secret } = await dedupeSecretForProject(
      ctx.groups,
      projectId
    );
    const id = `${projectId} ${keyEpoch}`;
    let key = dedupeKeys.get(id);
    if (!key) {
      key = importAssetDedupeSecret(secret);
      dedupeKeys.set(id, key);
      key.catch(() => dedupeKeys.delete(id));
    }
    secret.fill(0);
    return key;
  }

  return {
    async archive(projectId, input) {
      input.signal?.throwIfAborted();
      const { kind, compression } = contentBlobKindFor(input.kind);
      if (input.body.size > PLAINTEXT_CEILINGS[kind]) {
        throw new ApiError(
          413,
          'This file is too large to store in an encrypted project.',
          'E2EE_BLOB_TOO_LARGE',
          { limitBytes: PLAINTEXT_CEILINGS[kind] }
        );
      }
      const plaintext = new Uint8Array(await input.body.arrayBuffer());
      const checksum = await sha256Hex(plaintext);
      const tag = await assetDedupeHash(
        await dedupeKeyOf(projectId),
        plaintext
      );
      input.signal?.throwIfAborted();
      // Dedupe: the account names a blob for the tag, and this page holds
      // its key for the same plaintext. Anything less uploads again.
      const found = await api.lookup(projectId, tag);
      if (found) {
        const held = ctx.references.get(projectId, found);
        if (
          held &&
          held.reference.kind === kind &&
          held.reference.plaintextLength === plaintext.byteLength &&
          held.checksumSha256 === checksum
        ) {
          input.onUploadProgress?.(input.body.size, input.body.size);
          return found;
        }
      }
      const { envelope, reference } = await encryptBlob(
        kind,
        plaintext,
        compression,
        ctx.chunkSize
      );
      input.signal?.throwIfAborted();
      const started = await api.startUpload(projectId, {
        blobId: reference.blobId,
        kind
      });
      if (!started.committed) {
        // The writer's output through the ordinary single-part or multipart
        // session: part boundaries need no alignment with chunks.
        await uploadArtifactBody(transport, started.session, envelope, {
          ...(ctx.partBytes ? { partBytes: ctx.partBytes } : {}),
          ...(input.onUploadProgress
            ? {
                onProgress: (uploaded: number, total: number) =>
                  input.onUploadProgress!(
                    Math.round((uploaded / total) * input.body.size),
                    input.body.size
                  )
              }
            : {}),
          ...(input.signal ? { signal: input.signal } : {})
        });
        input.signal?.throwIfAborted();
        const finalized = await api.finalize(projectId, reference.blobId, {
          uploadSessionId: started.session.uploadSessionId,
          dedupeTag: tag
        });
        if (finalized.blobId !== reference.blobId) {
          throw new Error('The encrypted file could not be stored.');
        }
      }
      ctx.references.remember(projectId, reference, checksum);
      return reference.blobId;
    },

    async restore(projectId, blobIds) {
      function missing(): never {
        throw new UnstorableDocumentError(E2EE_BLOB_RESTORE_MESSAGE);
      }
      const loadLocal = ctx.loadLocal ?? missing;
      for (const blobId of new Set(blobIds)) {
        const held = ctx.references.get(projectId, blobId);
        const checksumSha256 = held?.checksumSha256;
        if (!held || !checksumSha256) missing();
        const { reference } = held;
        const plaintext = await loadLocal(checksumSha256).catch(() => null);
        if (
          !plaintext ||
          plaintext.byteLength !== reference.plaintextLength ||
          (await sha256Hex(plaintext)) !== checksumSha256
        ) {
          missing();
        }
        const compression: Compression =
          reference.kind === 'thumbnail' ? 'none' : 'gzip';
        const { envelope, reference: restored } = await encryptBlob(
          reference.kind,
          plaintext,
          compression,
          ctx.chunkSize,
          blobId
        );
        const started = await api.startUpload(projectId, {
          blobId,
          kind: reference.kind
        });
        // Committed meanwhile by someone else, under a key this page does
        // not hold: never name it with this reference.
        if (started.committed) missing();
        await uploadArtifactBody(transport, started.session, envelope, {
          ...(ctx.partBytes ? { partBytes: ctx.partBytes } : {})
        });
        const tag = await assetDedupeHash(
          await dedupeKeyOf(projectId),
          plaintext
        );
        const finalized = await api.finalize(projectId, blobId, {
          uploadSessionId: started.session.uploadSessionId,
          dedupeTag: tag
        });
        if (finalized.blobId !== blobId) missing();
        ctx.references.remember(projectId, restored, checksumSha256);
      }
    },

    async read(projectId, blobId, signal, onProgress) {
      const held = ctx.references.get(projectId, blobId);
      if (!held) {
        throw new E2eeError(
          'invalid-argument',
          'This page holds no key for that encrypted file'
        );
      }
      const { reference } = held;
      const envelope = await api.download(
        projectId,
        blobId,
        maxCiphertextBytes(reference),
        signal,
        onProgress
      );
      const result = await decode({ reference, envelope, output: 'chunks' });
      if (
        !('chunks' in result) ||
        result.byteLength !== reference.plaintextLength
      ) {
        throw new E2eeError('malformed', 'The encrypted file did not decode');
      }
      const bytes = new Uint8Array(result.byteLength);
      let offset = 0;
      for (const chunk of result.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }
  };
}
