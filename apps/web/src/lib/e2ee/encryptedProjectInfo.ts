/**
 * The project-info envelope of an encrypted project in the browser (ADR-024
 * Phase 4, slices 4-5 and 4-7; roadmap L11): the project's name, its
 * thumbnail's reference and its archived exports, so the shelf and the File
 * menu need no document.
 *
 * It keeps its own sequence and hash chain: each one's header carries its
 * sequence as the document version and names the hash of the one it
 * replaces, which the Worker checks against what it stores. This browser
 * pins the newest sequence and hash it accepted (`versionPins.ts`): an older
 * sequence, or another envelope at the pinned one, is refused, and one
 * sequence past the pin must name the pinned hash. The account keeps only
 * the current envelope, so a jump of more than one is accepted on its
 * signature alone (a fresh browser's limit, as for documents).
 *
 * A write is a read-modify-write on the verified current one, retried when
 * another write landed meanwhile; an envelope this browser cannot verify is
 * replaced (chained on its bytes) rather than built on. Verified thumbnail
 * and export references are handed to this page's blob registry, so the
 * shelf and downloads read them through the decode worker.
 */
import {
  encodeProjectInfoBody,
  toHex,
  type ContentBlobReference,
  type ProjectExportEntry,
  type ProjectInfoBody
} from '@openzcad/crypto';
import {
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_CONTENT_TYPE,
  type ArtifactKind,
  type ArtifactRecord,
  type E2eeProjectEnvelopeRecord,
  type E2eeProjectInfoResponse
} from '@openzcad/shared';
import { ApiError } from '../api';
import type { ArchiveArtifactInput } from '../archiveArtifact';
import type { BlobReferenceRegistry } from './blobReferences';
import {
  storedEnvelopeHash,
  type ReplacedEnvelopeKit
} from './replacedEnvelopes';
import { envelopeMayFollow, type VersionPinStore } from './versionPins';

/** The current project info as this browser verified it. */
export interface ProjectInfoSnapshot {
  /** 0 when the project has none. */
  readonly sequence: number;
  /** Lowercase hex hash of the stored envelope; null when none. */
  readonly hash: string | null;
  /** Null when there is none, or it did not verify. */
  readonly body: ProjectInfoBody | null;
}

export interface ProjectInfoAccess {
  /** Verifies and decodes one stored project info; refuses a rollback. */
  verify(record: E2eeProjectEnvelopeRecord): Promise<ProjectInfoBody>;
  /** The account's current project info, verified. */
  read(projectId: string): Promise<ProjectInfoSnapshot>;
  /**
   * Replaces the project info with `change(current)`; `null` leaves it as
   * it is. `current` is null when there is none or it did not verify.
   */
  update(
    projectId: string,
    change: (current: ProjectInfoBody | null) => ProjectInfoBody | null
  ): Promise<ProjectInfoBody | null>;
}

/** The most archived exports a project info keeps, newest first (judgment). */
export const MAX_INFO_EXPORTS = 100;

/** An older or forked project info: never shown, never built on. */
export class ProjectInfoRollbackError extends ApiError {
  constructor(message: string) {
    super(503, message, 'E2EE_INFO_ROLLBACK');
    this.name = 'ProjectInfoRollbackError';
  }
}

/** The blob references a project info body names, header order. */
export function projectInfoReferences(
  body: ProjectInfoBody
): ContentBlobReference[] {
  return [
    ...(body.thumbnail ? [body.thumbnail] : []),
    ...body.exports.map((entry) => entry.ref)
  ];
}

/** Adds an archived export, newest first, keeping at most MAX_INFO_EXPORTS. */
export function withExport(
  body: ProjectInfoBody,
  entry: ProjectExportEntry
): ProjectInfoBody {
  return {
    ...body,
    exports: [
      entry,
      ...body.exports.filter((item) => item.ref.blobId !== entry.ref.blobId)
    ].slice(0, MAX_INFO_EXPORTS)
  };
}

const RETRIES = 3;
const RETRIED = new Set([
  'E2EE_SEQUENCE_CONFLICT',
  'E2EE_INFO_MISMATCH',
  'E2EE_EPOCH_STALE'
]);

export function createProjectInfoAccess(deps: {
  readonly userId: string;
  readonly kit: ReplacedEnvelopeKit;
  readonly pins: VersionPinStore;
  readonly references: BlobReferenceRegistry;
  readonly api: {
    info(projectId: string): Promise<E2eeProjectInfoResponse>;
    saveInfo(
      projectId: string,
      upload: {
        sequence: number;
        envelope: string;
        wrappedVersionKey: string;
        signature: string;
        signerDeviceId: string;
      }
    ): Promise<E2eeProjectInfoResponse>;
  };
}): ProjectInfoAccess {
  const { userId, kit, pins, references, api } = deps;

  /** The pin's word on a stored info, before anything is decrypted. */
  async function requireFollows(
    projectId: string,
    sequence: number,
    hash: string,
    previous: string | null
  ): Promise<void> {
    const pin = await pins.read(userId, projectId);
    if (!pin || pin.infoSequence === 0) return;
    const pinned = { sequence: pin.infoSequence, hash: pin.infoHash };
    if (!envelopeMayFollow(pinned, sequence, hash)) {
      throw new ProjectInfoRollbackError(
        sequence < pin.infoSequence
          ? 'The account offered an older project info than this browser already accepted.'
          : 'The account offered another project info than this browser already accepted.'
      );
    }
    if (
      pin.infoHash !== null &&
      sequence === pin.infoSequence + 1 &&
      previous !== pin.infoHash
    ) {
      throw new ProjectInfoRollbackError(
        'The account’s project info does not follow the one this browser accepted.'
      );
    }
  }

  function remember(projectId: string, body: ProjectInfoBody): void {
    for (const reference of projectInfoReferences(body)) {
      references.remember(projectId, reference);
    }
  }

  async function verify(
    record: E2eeProjectEnvelopeRecord
  ): Promise<ProjectInfoBody> {
    if (record.kind !== 'project-info') {
      throw new ApiError(502, 'Not a project info.');
    }
    const hash = await storedEnvelopeHash(record.envelope);
    const opened = await kit.open(record, 'project-info');
    const previous = opened.header.previousVersionHash;
    await requireFollows(
      record.projectId,
      record.sequence,
      hash,
      previous ? toHex(previous) : null
    );
    const body = opened.value as ProjectInfoBody;
    if (
      !(await pins.advanceInfo(userId, record.projectId, record.sequence, hash))
    ) {
      // Another tab moved the pin meanwhile: this one must still follow it.
      await requireFollows(record.projectId, record.sequence, hash, null);
    }
    remember(record.projectId, body);
    return body;
  }

  async function read(projectId: string): Promise<ProjectInfoSnapshot> {
    const { info } = await api.info(projectId);
    if (!info) {
      const pin = await pins.read(userId, projectId);
      if (pin && pin.infoSequence > 0) {
        throw new ProjectInfoRollbackError(
          'The account no longer shows this project’s info.'
        );
      }
      return { sequence: 0, hash: null, body: null };
    }
    if (info.projectId !== projectId) {
      throw new ApiError(502, 'The account answered for another project.');
    }
    try {
      return {
        sequence: info.sequence,
        hash: await storedEnvelopeHash(info.envelope),
        body: await verify(info)
      };
    } catch (error) {
      if (error instanceof ProjectInfoRollbackError) throw error;
      // It did not verify: replaced, never built on. Its bytes still name
      // the chain link the next one must carry.
      return {
        sequence: info.sequence,
        hash: await storedEnvelopeHash(info.envelope),
        body: null
      };
    }
  }

  return {
    verify,
    read,
    async update(projectId, change) {
      for (let attempt = 0; ; attempt++) {
        const current = await read(projectId);
        const next = change(current.body);
        if (next === null) return current.body;
        const sequence = current.sequence + 1;
        const sealed = await kit.seal(
          projectId,
          {
            kind: 'project-info',
            sequence,
            previousHash: current.hash,
            blobIds: projectInfoReferences(next).map((ref) => ref.blobId)
          },
          (header) => encodeProjectInfoBody(next, header)
        );
        try {
          await api.saveInfo(projectId, {
            sequence,
            envelope: sealed.envelope,
            wrappedVersionKey: sealed.wrappedVersionKey,
            signature: sealed.signature,
            signerDeviceId: sealed.signerDeviceId
          });
        } catch (error) {
          if (
            error instanceof ApiError &&
            RETRIED.has(error.code ?? '') &&
            attempt < RETRIES - 1
          ) {
            continue;
          }
          throw error;
        }
        await pins.advanceInfo(userId, projectId, sequence, sealed.hash);
        remember(projectId, next);
        return next;
      }
    }
  };
}

// --- Thumbnails and archived exports ----------------------------------------

/** What the thumbnail and export paths need from a page. */
export interface ProjectFilesDeps {
  readonly info: ProjectInfoAccess;
  readonly references: BlobReferenceRegistry;
  /** Encrypts and stores one file as a content blob; resolves to its id. */
  archive(projectId: string, input: ArchiveArtifactInput): Promise<string>;
}

/** The artifact kinds an encrypted project archives as `export` blobs. */
export const EXPORT_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> =
  new Set<ArtifactKind>([
    'step-export',
    'stl-export',
    '3mf-export',
    'obj-export',
    'gltf-export',
    'ply-export'
  ]);

/** The project-info body's cap on one export's metadata, as JSON. */
const MAX_EXPORT_METADATA_JSON = 4000;

/** What an archived export records beside its file, inside the project info. */
export function exportMetadata(
  input: Pick<ArchiveArtifactInput, 'kind' | 'metadata' | 'body'>,
  createdAt = new Date().toISOString()
): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {
    ...(input.metadata ?? {}),
    artifactKind: input.kind,
    createdAt,
    bytes: input.body.size
  };
  // Body ids are the only open-ended field; a long list is left out.
  if (JSON.stringify(metadata).length > MAX_EXPORT_METADATA_JSON) {
    delete metadata.bodyIds;
  }
  return JSON.stringify(metadata).length > MAX_EXPORT_METADATA_JSON
    ? { artifactKind: input.kind, createdAt, bytes: input.body.size }
    : metadata;
}

/**
 * Archives an export of an encrypted project: an `export` content blob,
 * listed (newest first) in a new project info. Resolves to its blob id.
 */
export async function archiveExport(
  deps: ProjectFilesDeps,
  projectId: string,
  input: ArchiveArtifactInput
): Promise<string> {
  if (!EXPORT_ARTIFACT_KINDS.has(input.kind)) {
    throw new ApiError(400, 'Not an export.');
  }
  const blobId = await deps.archive(projectId, input);
  const held = deps.references.get(projectId, blobId);
  if (!held) throw new ApiError(500, 'The export was not stored.');
  const entry: ProjectExportEntry = {
    ref: held.reference,
    fileName: input.fileName,
    contentType: input.contentType,
    metadata: exportMetadata(input)
  };
  const listed = await deps.info.update(projectId, (current) =>
    current ? withExport(current, entry) : null
  );
  if (!listed?.exports.some((item) => item.ref.blobId === blobId)) {
    throw new ApiError(
      409,
      'The project info could not be read, so the export was not archived.'
    );
  }
  return blobId;
}

/**
 * Publishes a captured shelf thumbnail of an encrypted project: a
 * `thumbnail` content blob named by a new project info, never an artifact.
 * Resolves to its blob id.
 */
export async function publishThumbnail(
  deps: ProjectFilesDeps,
  projectId: string,
  image: Blob
): Promise<string> {
  if (image.size > MAX_THUMBNAIL_BYTES) {
    throw new ApiError(413, 'Thumbnail is too large.');
  }
  const blobId = await deps.archive(projectId, {
    fileName: 'thumbnail.webp',
    contentType: THUMBNAIL_CONTENT_TYPE,
    kind: 'thumbnail',
    body: image
  });
  const held = deps.references.get(projectId, blobId);
  if (!held) throw new ApiError(500, 'The thumbnail was not stored.');
  const updated = await deps.info.update(projectId, (current) =>
    !current
      ? null
      : current.thumbnail?.blobId === blobId
        ? null
        : { ...current, thumbnail: held.reference }
  );
  if (updated?.thumbnail?.blobId !== blobId) {
    throw new ApiError(
      409,
      'The project info could not be read, so the thumbnail waits for the next save.'
    );
  }
  return blobId;
}

/** An encrypted project's archived exports, as the File menu lists them. */
export function exportArtifacts(
  projectId: string,
  body: ProjectInfoBody | null
): ArtifactRecord[] {
  return (body?.exports ?? []).map((entry) => {
    const kind = entry.metadata.artifactKind;
    return {
      artifactId: entry.ref.blobId as ArtifactRecord['artifactId'],
      projectId: projectId as ArtifactRecord['projectId'],
      kind:
        typeof kind === 'string' &&
        EXPORT_ARTIFACT_KINDS.has(kind as ArtifactKind)
          ? (kind as ArtifactKind)
          : 'step-export',
      name: entry.fileName,
      // Encrypted blobs have no object key a client may name.
      objectKey: '',
      contentType: entry.contentType,
      bytes: entry.ref.plaintextLength,
      createdAt:
        typeof entry.metadata.createdAt === 'string'
          ? entry.metadata.createdAt
          : '',
      metadata: { ...entry.metadata }
    };
  });
}
