/**
 * Encrypted document versions in the browser (ADR-024 Phase 4, encrypted
 * documents; roadmap L11). It implements the plaintext transport's shapes
 * (`createProject`, `saveProjectDocument`, `saveRevision`, `loadProject`,
 * `loadRevision`, `listRevisions`) for format-2 projects, so `api.ts` can
 * dispatch on the storage format and autosave needs no second code path.
 *
 * - **Write.** The browser validates the document as for any account write
 *   (`splitProjectStorageUpload`), encodes the document body with the
 *   signed map of retained revisions (`revisionVersionHashes`), encrypts it
 *   under a fresh version key, wraps that key under the group's current
 *   project key, binds the header to the epoch (`epochBinding`) and signs
 *   the envelope with this device's certified signing key (`ecdsaSign`, so
 *   a Keychain key signs natively). The project catches up or joins its MLS
 *   group first, so the version is written under the current key epoch.
 * - **Current head.** The version log from the pinned head up to the
 *   offered head must verify (`verifyVersionLog`: chain, rising versions
 *   and epochs, every signature, the pin present); the head's author must
 *   be a certified device of this account (`verifyAuthoredEnvelope`, with
 *   revocation cutoffs) holding a leaf it certified in the head's epoch;
 *   the epoch binding must match that epoch's authenticator. Only then is
 *   the head decrypted, validated and the pin moved forward.
 * - **Historical read.** A revision is opened only if the pinned head's
 *   signed body maps it to its hash (or it is the head), and never moves
 *   the pin.
 * - A fresh browser (no pin) warns when the head it is offered was signed
 *   well before the account's last recorded activity.
 * - **Content blobs** (slice 4-6). Imported sources, mesh payloads and
 *   reference images are encrypted blobs (`encryptedContentBlobs.ts`): a
 *   write's body carries the reference of every blob its document names and
 *   the header's `blobIds` are derived from that list; a verified read
 *   hands its body's references to this page's registry, so the source
 *   resolver and the next write can use them. A write the account refuses
 *   because it lost a blob the document names (409 `E2EE_BLOB_UNKNOWN`)
 *   stores the blob again from this device's copy (`restoreBlobs`) and is
 *   retried once.
 * - **Replaced envelopes** (slice 4-7). The project info (name, thumbnail,
 *   archived exports; `encryptedProjectInfo.ts`), measurements and view
 *   state (`replacedEnvelopes.ts`) are sealed and opened through this
 *   store's kit (`replaced`): under the current key epoch, bound to it and
 *   signed by this device; on the way back the signer must be a listed
 *   device of this account and the binding, kind, project and sequence must
 *   hold before the body is decoded.
 *
 * - **Copies, branches and adoption** (slice 4-8). `copyProject` stores a
 *   copy the page built from a verified source: its first version and
 *   project info carry the source's blob ids and keys (registered under the
 *   copy's id), and the account copies the blobs byte for byte, so no file
 *   is encrypted again. `createProject` with an adopted document creates
 *   it encrypted (decision D2); its device-only files follow as blobs.
 *
 * Not yet: files embedded in the document itself (the legacy `stepText`
 * and embedded-mesh forms), the live room (4-9).
 */
import {
  AuthorshipError,
  authorCutoffKey,
  EnvelopeKey,
  VersionLogError,
  checkBlobReferences,
  encodeProjectInfoBody,
  encryptProjectEnvelope,
  epochBinding,
  fromBase64Url,
  fromHex,
  parseEnvelope,
  signProjectEnvelope,
  toBase64Url,
  toHex,
  unwrapKey,
  verifyAuthoredEnvelope,
  verifyAuthoredLogRecord,
  verifyProjectEnvelopeSignature,
  verifyVersionLog,
  versionHash,
  wrapKey,
  type BodyEnvelopeHeader,
  type EncryptedDocumentBody,
  type ProjectEnvelopeHeader,
  type ProjectEnvelopeHeaderInit,
  type ProjectInfoBody,
  type VerifiedAuthor,
  type VerifiedDeviceList,
  type VersionCutoff,
  type VersionLogRecord
} from '@openzcad/crypto';
import {
  PROJECT_STORAGE_FORMAT_E2EE_V1,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type E2eeAdoption,
  type E2eeCopyFrom,
  type E2eeProjectEnvelopeRecord,
  type E2eeProjectEnvelopeUpload,
  type E2eeProjectState,
  type E2eeReplacedEnvelopeKind,
  type E2eeRevisionsResponse,
  type E2eeStoredVersion,
  type E2eeVersionLogEntry,
  type ListRevisionsResponse,
  type ProjectDocument,
  type ProjectSummary,
  type SaveProjectDocumentRequest,
  type SaveProjectDocumentResponse,
  type SaveRevisionRequest,
  type UserId
} from '@openzcad/shared';
import {
  UnstorableDocumentError,
  assertStorableDocument,
  createProjectDocument,
  createSavedRevision
} from '@openzcad/document-core';
import {
  importArtifactIds,
  prepareInitialProjectDocument,
  splitProjectStorageUpload
} from '@openzcad/persistence';
import { ApiError, PROJECT_DOCUMENT_UNAVAILABLE_CODE } from '../api';
import {
  decodeProjectEnvelopeJob,
  sealDocumentJob,
  type ProjectEnvelopeDecodeJob,
  type ProjectEnvelopeDecodeResult,
  type SealDocumentJob,
  type SealDocumentResult
} from './decodeJobs';
import { E2eeApiError } from './e2eeApi';
import {
  pageBlobReferences,
  type BlobReferenceRegistry
} from './blobReferences';
import {
  E2EE_BLOB_KEY_MISSING_MESSAGE,
  documentBlobReferences,
  rememberDocumentBlobs
} from './encryptedContentBlobs';
import {
  createEncryptedDocumentsApi,
  type EncryptedDocumentsApi
} from './encryptedDocumentsApi';
import type { CertifyingDevice } from './mls/certify';
import type { MlsProjectRef } from './mls/projectSessions';
import {
  createProjectGroup,
  epochAuthenticatorForEpoch,
  groupBaseForKeyEpoch,
  joinProjectGroup,
  projectRevocationCutoffs,
  projectKeyForEpoch,
  type ProjectGroupContext
} from './projectGroups';
import {
  versionPins,
  type ProjectVersionPin,
  type VersionPinStore
} from './versionPins';
import {
  createProjectInfoAccess,
  projectInfoReferences,
  type ProjectInfoAccess
} from './encryptedProjectInfo';
import type {
  OpenedReplaced,
  ReplacedEnvelopeKit,
  SealedReplaced
} from './replacedEnvelopes';

// --- Context ---------------------------------------------------------------

/** Decrypts and decodes one project envelope (the decode worker in a page). */
export type EnvelopeOpener = (
  job: Omit<ProjectEnvelopeDecodeJob, 'type'>
) => Promise<ProjectEnvelopeDecodeResult>;

/** Encodes and encrypts a document version (the decode worker in a page). */
export type DocumentSealer = (
  job: Omit<SealDocumentJob, 'type'>
) => Promise<SealDocumentResult>;

export type EncryptedProjectWarning = {
  readonly kind: 'stale-head';
  readonly projectId: string;
  /** The head's signed timestamp, Unix ms. */
  readonly signedAt: number;
  /** The account's last recorded activity, Unix ms (plaintext, a hint). */
  readonly updatedAt: number;
};

export interface EncryptedProjectContext {
  /** The account's groups, keys and this device (null: read-only, D4). */
  readonly groups: ProjectGroupContext;
  readonly api?: EncryptedDocumentsApi;
  readonly pins?: VersionPinStore;
  /** Defaults to decoding in-line; pages pass the decode worker. */
  readonly open?: EnvelopeOpener;
  /** Defaults to encrypting in-line; pages pass the decode worker. */
  readonly seal?: DocumentSealer;
  /**
   * This project's cutoffs for revoked devices, keyed by
   * `authorCutoffKey`. By default they come from the identity-signed
   * revocation cutoffs the groups context verifies (slice 4-10); a revoked
   * device without one has its versions refused (`revoked-without-cutoff`).
   */
  readonly cutoffs?: (
    projectId: string
  ) => Promise<ReadonlyMap<string, VersionCutoff>>;
  readonly now?: () => number;
  readonly onWarning?: (warning: EncryptedProjectWarning) => void;
  /** Content blob references; defaults to this page's registry. */
  readonly blobReferences?: BlobReferenceRegistry;
  /**
   * Runs on every verified document a load or a historical read returns,
   * after its blob references are registered: a page fetches the sources
   * its geometry workers will ask for. Best-effort: a source that cannot be
   * fetched now is reported where it is needed, as for any other source.
   */
  readonly onDocument?: (
    projectId: string,
    document: ProjectDocument
  ) => Promise<void>;
  /**
   * Stores again, from this device's copy, blobs a document names that the
   * account lost or collected (409 `E2EE_BLOB_UNKNOWN`); the write is then
   * retried once with the new references.
   */
  readonly restoreBlobs?: (
    projectId: string,
    blobIds: readonly string[]
  ) => Promise<void>;
}

/** How far a fresh browser lets a head's signature trail account activity. */
export const STALE_HEAD_WARNING_MS = 10 * 60 * 1000;
const SCHEMA_VERSION = 1;
const LOG_WINDOW = 4096;
/** The most log records one head read follows (judgment). */
const MAX_LOG_RECORDS = 64 * 1024;

export type EncryptedIntegrityReason =
  /** The account showed an older head than this browser already accepted. */
  | 'rollback'
  /** The history does not contain this browser's pin, or splits. */
  | 'fork'
  /** A signature, an author or a revoked device's cutoff did not hold. */
  | 'author'
  /** The author held no editing leaf in the version's epoch. */
  | 'authority'
  /** The version's epoch or its binding is wrong. */
  | 'epoch'
  /** The envelope or its document does not match what was asked for. */
  | 'content'
  /** A revision is not part of the pinned history. */
  | 'history';

/**
 * A version that did not verify. It reads as an unreadable account copy
 * (503 `PROJECT_DOCUMENT_UNAVAILABLE`): the device copy stays open and
 * autosave waits for an explicit retry rather than writing over either.
 */
export class EncryptedProjectIntegrityError extends ApiError {
  constructor(
    readonly reason: EncryptedIntegrityReason,
    message: string
  ) {
    super(503, message, PROJECT_DOCUMENT_UNAVAILABLE_CODE, {
      e2eeIntegrity: reason
    });
    this.name = 'EncryptedProjectIntegrityError';
  }
}

/** This device holds no key session, or only reads (decision D4). */
export const E2EE_KEYS_LOCKED_CODE = 'E2EE_KEYS_LOCKED';
export const E2EE_READ_ONLY_DEVICE_CODE = 'E2EE_READ_ONLY_DEVICE';
/**
 * Imports whose file is embedded in the document (the legacy `stepText`
 * and embedded-mesh forms the plaintext path splits into storage assets)
 * have no encrypted form yet; reference-form imports are content blobs.
 */
export const E2EE_CONTENT_UNAVAILABLE_MESSAGE =
  'Encrypted projects cannot hold files embedded in the document yet. Import the file again, or keep this project on this device.';

/** What this page remembers of a project's accepted head. */
interface HeadState {
  readonly version: number;
  readonly hash: string;
  readonly keyEpoch: number;
  readonly revisionHashes: Map<string, Uint8Array>;
  readonly document: ProjectDocument;
  infoName: string | null;
  infoSequence: number;
}

/** A copy or branch the page built from a verified source (slice 4-8). */
export interface EncryptedCopyRequest {
  readonly sourceProjectId: string;
  /** The copy: its own `proj_` id, carrying the source's blob ids. */
  readonly document: ProjectDocument;
  /** A branch: the source's named save it starts from. */
  readonly revisionId?: string;
}

export interface EncryptedProjectStore {
  createProject(request: CreateProjectRequest): Promise<CreateProjectResponse>;
  /** Stores a copy or branch of an encrypted project (slice 4-8). */
  copyProject(request: EncryptedCopyRequest): Promise<CreateProjectResponse>;
  saveProjectDocument(
    payload: SaveProjectDocumentRequest
  ): Promise<SaveProjectDocumentResponse>;
  saveRevision(payload: SaveRevisionRequest): Promise<ProjectDocument>;
  loadProject(projectId: string): Promise<ProjectDocument>;
  loadRevision(
    projectId: string,
    revisionId: string
  ): Promise<ProjectDocument | null>;
  listRevisions(projectId: string): Promise<ListRevisionsResponse>;
  /** The decrypted name of a project-info envelope, or null if it fails. */
  projectName(record: E2eeProjectEnvelopeRecord): Promise<string | null>;
  /** The project info: name, thumbnail and archived exports (4-7). */
  readonly info: ProjectInfoAccess;
  /** Seals and opens replaced envelopes: project info, measurements, view state. */
  readonly replaced: ReplacedEnvelopeKit;
  /** What the live room's codec uses (slice 4-9, `encryptedRoomCodec.ts`). */
  roomAccess(): EncryptedRoomAccess;
}

/** A head this page accepted: what a room version is sealed on. */
export interface EncryptedRoomHeadState {
  readonly version: number;
  readonly hash: string;
  readonly keyEpoch: number;
  readonly revisionHashes: ReadonlyMap<string, Uint8Array>;
  readonly document: ProjectDocument;
}

/** A document version sealed for the room, not yet acknowledged. */
export interface EncryptedRoomSealed {
  readonly envelope: Uint8Array;
  readonly hash: string;
  readonly keyEpoch: number;
  readonly version: number;
  /** As stored: validated, split, at `version`. */
  readonly document: ProjectDocument;
  readonly signature: string;
  readonly wrappedVersionKey: string;
  readonly signerDeviceId: string;
}

/**
 * The store's encrypt/sign and decrypt/verify paths, for the live room.
 * Every head the room relays is read as a current head (pin moves); a
 * version the room accepts moves the pin from the head it was sealed on.
 */
export interface EncryptedRoomAccess {
  currentHead(projectId: string): EncryptedRoomHeadState | null;
  /** Seals `document` on `base`, under the group's current epoch. */
  seal(
    projectId: string,
    document: ProjectDocument,
    base: EncryptedRoomHeadState
  ): Promise<EncryptedRoomSealed>;
  openHead(
    projectId: string,
    record: E2eeStoredVersion,
    envelope: Uint8Array | null
  ): Promise<EncryptedRoomHeadState>;
  accepted(
    projectId: string,
    sealed: EncryptedRoomSealed,
    base: EncryptedRoomHeadState,
    record: E2eeStoredVersion
  ): Promise<EncryptedRoomHeadState>;
  /** Processes the group's newer Commits (or rejoins). */
  catchUp(projectId: string): Promise<void>;
}

const b64 = toBase64Url;
const bytes = (text: string) => fromBase64Url(text);
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function signingKeyOf(
  list: VerifiedDeviceList,
  deviceId: string
): Uint8Array | null {
  const live = list.devices.find((d) => d.deviceId === deviceId);
  if (live) return live.signingKey;
  const revoked = list.revoked.find(
    (r) => r.kind === 'device' && r.id === deviceId
  );
  return revoked?.device?.signingKey ?? null;
}

/**
 * Version cutoffs from the verified revocation cutoffs: a revoked device's
 * versions are accepted only below its cutoff key epoch and, when the
 * revoking browser named one, up to its cutoff head.
 */
async function groupCutoffs(
  groups: ProjectGroupContext,
  projectId: string
): Promise<ReadonlyMap<string, VersionCutoff>> {
  const out = new Map<string, VersionCutoff>();
  if (!groups.account.list.revoked.some((r) => r.kind === 'device')) return out;
  const cutoffs = await projectRevocationCutoffs(groups, projectId);
  for (const [deviceId, cutoff] of cutoffs) {
    out.set(authorCutoffKey(groups.account.userId, deviceId), {
      keyEpoch: cutoff.keyEpoch,
      ...(cutoff.head
        ? {
            documentVersion: cutoff.head.documentVersion,
            versionHash: cutoff.head.versionHash
          }
        : {})
    });
  }
  return out;
}

/** Group and key-store refusals become ApiErrors the sync paths understand. */
function asApiError(error: unknown): unknown {
  if (error instanceof ApiError || !(error instanceof E2eeApiError)) {
    return error;
  }
  return new ApiError(error.status, error.message, error.code, {
    ...((error as { body?: Record<string, unknown> }).body ?? {})
  });
}

const integrity = (reason: EncryptedIntegrityReason, message: string) =>
  new EncryptedProjectIntegrityError(reason, message);

function logFailure(error: VersionLogError): EncryptedProjectIntegrityError {
  switch (error.reason) {
    case 'pinned-missing':
    case 'empty':
      return integrity(
        'fork',
        'The account showed this browser a version history that does not contain the version it last saw. It may be rolled back or split; your work stays on this device.'
      );
    case 'signer-unknown':
    case 'signature-invalid':
      return integrity(
        'author',
        `A version in this project's history is not signed by one of your devices (${error.message}).`
      );
    case 'epoch-decreased':
      return integrity(
        'epoch',
        'A version in this project’s history was written under an older key epoch than the one before it.'
      );
    default:
      return integrity(
        'fork',
        `This project’s version history does not hold together (${error.message}).`
      );
  }
}

function recordOf(entry: E2eeVersionLogEntry): VersionLogRecord {
  return {
    prefix: bytes(entry.prefix),
    versionHash: fromHex(entry.versionHash),
    signature: bytes(entry.signature)
  };
}

/** The blob ids a refused write names, or every one the version named. */
function unknownBlobsOf(
  error: ApiError,
  sealed: { envelope: Uint8Array }
): readonly string[] {
  const listed = error.details?.blobIds;
  if (
    Array.isArray(listed) &&
    listed.length > 0 &&
    listed.every((id) => typeof id === 'string')
  ) {
    return listed;
  }
  const { header } = parseEnvelope(sealed.envelope);
  return header.class === 'project' ? header.blobIds : [];
}

function inlineOpener(): EnvelopeOpener {
  return (job) =>
    decodeProjectEnvelopeJob({ type: 'project-envelope', ...job });
}

// --- Store -----------------------------------------------------------------

export function createEncryptedProjectStore(
  ctx: EncryptedProjectContext
): EncryptedProjectStore {
  const groups = ctx.groups;
  const userId = groups.account.userId;
  const api = ctx.api ?? createEncryptedDocumentsApi();
  const pins = ctx.pins ?? versionPins();
  const open = ctx.open ?? inlineOpener();
  const seal: DocumentSealer =
    ctx.seal ?? ((job) => sealDocumentJob({ type: 'seal-document', ...job }));
  const now = ctx.now ?? Date.now;
  const heads = new Map<string, HeadState>();
  const authenticators = new Map<string, Uint8Array>();
  const blobReferences = ctx.blobReferences ?? pageBlobReferences;

  /** The page's sources for a verified document, never failing its read. */
  async function opened(
    projectId: string,
    document: ProjectDocument
  ): Promise<ProjectDocument> {
    try {
      await ctx.onDocument?.(projectId, document);
    } catch {
      // A source that cannot be fetched now is reported where it is needed.
    }
    return document;
  }

  const list = () => groups.account.list;
  const cutoffsFor = async (projectId: string) =>
    ctx.cutoffs
      ? await ctx.cutoffs(projectId)
      : await groupCutoffs(groups, projectId);

  function writableDevice(): CertifyingDevice {
    const device = groups.device;
    if (
      !device ||
      device.userId !== userId ||
      !list().devices.some((d) => d.deviceId === device.deviceId)
    ) {
      throw new ApiError(
        403,
        'This device can read your encrypted projects but cannot save them. Save from a device listed in Settings › Encryption.',
        E2EE_READ_ONLY_DEVICE_CODE
      );
    }
    return device;
  }

  const refOf = (
    device: CertifyingDevice,
    projectId: string
  ): MlsProjectRef => ({
    userId,
    deviceId: device.deviceId,
    projectId
  });

  async function authenticatorOf(projectId: string, keyEpoch: number) {
    const id = `${projectId} ${keyEpoch}`;
    const cached = authenticators.get(id);
    if (cached) return cached;
    const authenticator = await epochAuthenticatorForEpoch(
      groups,
      projectId,
      keyEpoch
    );
    authenticators.set(id, authenticator);
    return authenticator;
  }

  /** The epoch binding a header must carry for its key epoch. */
  async function requireBinding(header: ProjectEnvelopeHeader) {
    let expected: Uint8Array;
    try {
      expected = await epochBinding(
        header.projectId,
        header.keyEpoch,
        await authenticatorOf(header.projectId, header.keyEpoch)
      );
    } catch {
      throw integrity(
        'epoch',
        `This project has no verifiable key epoch ${header.keyEpoch}.`
      );
    }
    if (!sameBytes(expected, header.epochBindingHash)) {
      throw integrity(
        'epoch',
        'A version is not bound to the key epoch it names.'
      );
    }
  }

  /**
   * The author's device held a leaf it certified, with an editing role, in
   * the version's epoch. Solo groups: the owner is the only member, with
   * the owner role.
   */
  async function requireAuthority(
    projectId: string,
    author: VerifiedAuthor
  ): Promise<void> {
    const refuse = (): never => {
      throw integrity(
        'authority',
        `Device ${author.deviceId} held no editing leaf in this project when it signed version ${author.header.documentVersion}.`
      );
    };
    if (author.userId !== userId) refuse();
    // Before a group reset (decision D9) the version names an epoch of an
    // earlier group generation.
    const { keyEpochBase, current } = await groupBaseForKeyEpoch(
      groups,
      projectId,
      author.header.keyEpoch
    );
    const epoch = author.header.keyEpoch - keyEpochBase;
    if (epoch < 0) refuse();
    const signingKey = signingKeyOf(list(), author.deviceId);
    if (!signingKey) refuse();
    if (groups.device) {
      const status = await groups.sessions
        .status(refOf(groups.device, projectId))
        .catch(() => null);
      const role = current
        ? status?.roles?.users.find((r) => r.userId === author.userId)
        : undefined;
      if (
        role &&
        (!['owner', 'editor'].includes(role.role) || role.since > epoch)
      ) {
        refuse();
      }
    }
    const { leaves } = await groups.api.leaves(projectId);
    for (const leaf of leaves) {
      if (leaf.userId !== author.userId || leaf.deviceId !== author.deviceId) {
        continue;
      }
      const verified = await groups.sessions.verifyLeafCertification(
        {
          projectId,
          userId: leaf.userId,
          deviceId: leaf.deviceId,
          leafKey: bytes(leaf.leafKey),
          certification: bytes(leaf.certification)
        },
        signingKey!
      );
      if (verified && verified.certifiedEpoch <= epoch) return;
    }
    refuse();
  }

  async function authorOf(
    projectId: string,
    envelope: Uint8Array,
    signature: Uint8Array
  ): Promise<VerifiedAuthor> {
    try {
      return await verifyAuthoredEnvelope(envelope, signature, {
        deviceLists: [list()],
        cutoffs: await cutoffsFor(projectId)
      });
    } catch (error) {
      if (error instanceof AuthorshipError) {
        throw integrity(
          'author',
          error.reason === 'outside-cutoff'
            ? 'A version was signed by a removed device after it was removed.'
            : `A version is not signed by one of your devices (${error.reason}).`
        );
      }
      throw error;
    }
  }

  /** Every log record from the pin (or the head alone) up to the head. */
  async function collectLog(
    projectId: string,
    first: readonly E2eeVersionLogEntry[],
    more: boolean,
    head: E2eeVersionLogEntry
  ): Promise<E2eeVersionLogEntry[]> {
    const entries = [...first];
    while (more) {
      const last = entries.at(-1);
      if (!last || entries.length > MAX_LOG_RECORDS) {
        throw integrity(
          'fork',
          'This project’s version history is too long to check here.'
        );
      }
      const page = await api.versions(projectId, last.documentVersion);
      if (page.log[0]?.versionHash !== last.versionHash) {
        throw integrity(
          'fork',
          'The account’s version history pages do not join.'
        );
      }
      entries.push(...page.log.slice(1));
      more = page.more && page.log.length > 1;
    }
    const last = entries.at(-1);
    if (
      !last ||
      last.documentVersion !== head.documentVersion ||
      last.versionHash !== head.versionHash
    ) {
      throw integrity(
        'fork',
        'The account’s version history does not end at the head it offered.'
      );
    }
    return entries;
  }

  /**
   * `verifyVersionLog` from the pin, in overlapping windows of at most
   * 4,096 records, each signature resolved through `verifyAuthoredLogRecord`.
   */
  async function verifyLog(
    projectId: string,
    pinHash: string | null,
    entries: readonly E2eeVersionLogEntry[]
  ): Promise<void> {
    const cutoffs = await cutoffsFor(projectId);
    let pinned = pinHash;
    for (let start = 0; ; start += LOG_WINDOW - 1) {
      const window = entries.slice(start, start + LOG_WINDOW);
      let authorship: AuthorshipError | null = null;
      try {
        const verified = await verifyVersionLog(window.map(recordOf), {
          ...(pinned ? { pinnedVersionHash: fromHex(pinned) } : {}),
          projectId,
          resolveSigningKey: async ({ index, record, header }) => {
            const entry = window[index]!;
            if (
              header.kind !== 'document' ||
              header.documentVersion !== entry.documentVersion ||
              header.keyEpoch !== entry.keyEpoch
            ) {
              return null;
            }
            try {
              const author = await verifyAuthoredLogRecord(record, {
                deviceLists: [list()],
                cutoffs
              });
              if (
                author.userId !== userId ||
                author.deviceId !== entry.signerDeviceId
              ) {
                return null;
              }
              return signingKeyOf(list(), author.deviceId);
            } catch (error) {
              if (error instanceof AuthorshipError) authorship = error;
              return null;
            }
          }
        });
        pinned = toHex(verified.head.versionHash);
      } catch (error) {
        const refused = authorship as AuthorshipError | null;
        if (refused) {
          throw integrity(
            'author',
            refused.reason === 'outside-cutoff'
              ? 'A version was signed by a removed device after it was removed.'
              : `A version is not signed by one of your devices (${refused.reason}).`
          );
        }
        if (error instanceof VersionLogError) throw logFailure(error);
        throw error;
      }
      if (start + LOG_WINDOW >= entries.length) return;
    }
  }

  async function versionKeyOf(
    projectId: string,
    header: ProjectEnvelopeHeader,
    hash: string,
    wrapped: string
  ): Promise<Uint8Array> {
    const projectKey = await projectKeyForEpoch(
      groups,
      projectId,
      header.keyEpoch
    );
    try {
      return await unwrapKey(projectKey, bytes(wrapped), {
        purpose: 'version-key',
        projectId,
        keyEpoch: header.keyEpoch,
        kind: header.kind,
        versionId: hash
      });
    } catch {
      throw integrity(
        'content',
        'A version key does not open under its project key.'
      );
    }
  }

  /** Decrypts a verified document envelope and checks the document in it. */
  async function openDocument(
    projectId: string,
    header: ProjectEnvelopeHeader,
    hash: string,
    wrapped: string,
    envelope: Uint8Array
  ): Promise<{ body: EncryptedDocumentBody; document: ProjectDocument }> {
    const versionKey = await versionKeyOf(projectId, header, hash, wrapped);
    let result: ProjectEnvelopeDecodeResult;
    try {
      result = await open({
        kind: 'document',
        versionKey,
        envelope,
        expect: {
          projectId,
          documentVersion: header.documentVersion,
          keyEpoch: header.keyEpoch,
          previousVersionHash: header.previousVersionHash,
          epochBindingHash: header.epochBindingHash
        }
      });
    } catch (error) {
      throw integrity(
        'content',
        `This project’s version ${header.documentVersion} does not decrypt as a document (${error instanceof Error ? error.message : String(error)}).`
      );
    } finally {
      versionKey.fill(0);
    }
    const body = result.value as EncryptedDocumentBody;
    let document: ProjectDocument;
    try {
      document = assertStorableDocument(body.document);
    } catch (error) {
      throw integrity(
        'content',
        `The account copy of this project cannot be opened here: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (document.projectId !== projectId) {
      throw integrity(
        'content',
        'The decrypted document belongs to a different project.'
      );
    }
    if (document.version !== header.documentVersion) {
      throw integrity(
        'content',
        'The decrypted document names another version than its envelope.'
      );
    }
    // The verified body is what authenticates each blob the document names.
    rememberDocumentBlobs(blobReferences, projectId, body.blobs, document);
    return { body, document };
  }

  /**
   * A named save's own body cannot map its revision (its hash is not known
   * while it is sealed), so a head that is one is added to the map here:
   * the head's document names that revision last, and the account lists
   * it at the head's version and hash. Without it the next version, built
   * on a head read back after a reload, would drop that save state from
   * the signed history. It adds no trust: a historical read already
   * accepts a revision the account places at the verified head.
   */
  async function withOwnNamedSave(
    projectId: string,
    revisionHashes: Map<string, Uint8Array>,
    document: ProjectDocument,
    head: { documentVersion: number; hash: string }
  ): Promise<void> {
    const own = document.revisions.at(-1)?.revisionId as string | undefined;
    if (!own || revisionHashes.has(own)) return;
    let listed: E2eeRevisionsResponse['revisions'];
    try {
      listed = (await api.revisions(projectId)).revisions;
    } catch {
      // The map stays as signed; the next read tries again.
      return;
    }
    if (
      listed.some(
        (revision) =>
          revision.revisionId === own &&
          revision.versionHash === head.hash &&
          revision.documentVersion === head.documentVersion
      )
    ) {
      revisionHashes.set(own, fromHex(head.hash));
    }
  }

  /** Reads, verifies and pins the current head (ADR-024, current head). */
  async function readHead(projectId: string): Promise<HeadState> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pin = await pins.read(userId, projectId);
      const pinHash = pin?.headHash ?? null;
      const { metadata, envelope } = await api.loadDocument(
        projectId,
        pinHash ? pin!.documentVersion : undefined
      );
      const head = metadata.head;
      if (pin && pinHash && head.documentVersion < pin.documentVersion) {
        throw integrity(
          'rollback',
          `The account offered version ${head.documentVersion} of this project, older than version ${pin.documentVersion} this browser already accepted. Your work stays on this device.`
        );
      }
      const entries = await collectLog(
        projectId,
        metadata.log,
        metadata.more,
        head
      );
      await verifyLog(projectId, pinHash, entries);
      const author = await authorOf(projectId, envelope, bytes(head.signature));
      const header = author.header;
      const hash = toHex(author.versionHash);
      if (
        hash !== head.versionHash ||
        header.documentVersion !== head.documentVersion ||
        header.kind !== 'document' ||
        header.projectId !== projectId
      ) {
        throw integrity(
          'content',
          'The head the account sent is not the one its history ends at.'
        );
      }
      if (author.deviceId !== head.signerDeviceId) {
        throw integrity(
          'author',
          'The head names another device than the one that signed it.'
        );
      }
      if (header.keyEpoch > metadata.keyEpoch) {
        throw integrity(
          'epoch',
          'The head names a key epoch the project does not have yet.'
        );
      }
      if (pin && pinHash && header.keyEpoch < pin.keyEpoch) {
        throw integrity(
          'epoch',
          'The head was written under an older key epoch than this browser already accepted.'
        );
      }
      await requireAuthority(projectId, author);
      await requireBinding(header);
      const { body, document } = await openDocument(
        projectId,
        header,
        hash,
        head.wrappedVersionKey,
        envelope
      );
      const updatedAt = Date.parse(metadata.project.updatedAt);
      if (
        !pinHash &&
        Number.isFinite(updatedAt) &&
        updatedAt - author.signedAt > STALE_HEAD_WARNING_MS
      ) {
        ctx.onWarning?.({
          kind: 'stale-head',
          projectId,
          signedAt: author.signedAt,
          updatedAt
        });
      }
      const accepted = await pins.advance(userId, projectId, pinHash, {
        headHash: hash,
        documentVersion: header.documentVersion,
        keyEpoch: header.keyEpoch
      });
      if (!accepted) {
        // Another tab moved the pin meanwhile: verify again from it.
        const current = await pins.read(userId, projectId);
        if (current?.headHash !== hash) continue;
      }
      const revisionHashes = new Map(body.revisionVersionHashes);
      await withOwnNamedSave(projectId, revisionHashes, document, {
        documentVersion: header.documentVersion,
        hash
      });
      const state: HeadState = {
        version: header.documentVersion,
        hash,
        keyEpoch: header.keyEpoch,
        revisionHashes,
        document,
        infoName: heads.get(projectId)?.infoName ?? null,
        infoSequence: Math.max(
          heads.get(projectId)?.infoSequence ?? 0,
          pin?.infoSequence ?? 0
        )
      };
      heads.set(projectId, state);
      return state;
    }
    throw integrity(
      'fork',
      'This project kept changing in another tab while it was checked. Reload to try again.'
    );
  }

  /** The verified head a write builds on; a conflict when it moved on. */
  async function headFor(
    projectId: string,
    expectedVersion: number
  ): Promise<HeadState> {
    const known = heads.get(projectId);
    if (known?.version === expectedVersion) return known;
    const head = await readHead(projectId);
    if (head.version !== expectedVersion) {
      throw new ApiError(
        409,
        `Project ${projectId} has a newer remote revision.`,
        'REVISION_CONFLICT',
        { currentVersion: head.version }
      );
    }
    return head;
  }

  interface Material {
    keyEpoch: number;
    projectKey: Uint8Array;
    epochAuthenticator: Uint8Array;
  }

  /** The current epoch's key material, after catching up or joining. */
  async function currentMaterial(
    device: CertifyingDevice,
    projectId: string
  ): Promise<Material> {
    const state = await joinProjectGroup(groups, projectId);
    const material = await groups.sessions.epochMaterial(
      refOf(device, projectId)
    );
    const { group } = await groups.api.group(projectId);
    if (group.keyEpochBase + material.epoch !== state.keyEpoch) {
      throw new ApiError(
        409,
        'The project’s keys moved meanwhile. Save again.',
        'E2EE_EPOCH_STALE'
      );
    }
    return {
      keyEpoch: state.keyEpoch,
      projectKey: material.projectKey,
      epochAuthenticator: material.epochAuthenticator
    };
  }

  /** Revisions the next head still names: those the document still records. */
  function retainedHashes(
    hashes: ReadonlyMap<string, Uint8Array>,
    document: ProjectDocument
  ): Map<string, Uint8Array> {
    const ids = new Set(document.revisions.map((r) => r.revisionId as string));
    return new Map([...hashes].filter(([id]) => ids.has(id)));
  }

  interface Sealed {
    envelope: Uint8Array;
    hash: string;
    keyEpoch: number;
    document: ProjectDocument;
    signature: string;
    wrappedVersionKey: string;
    signerDeviceId: string;
  }

  /** Wraps the version key and signs an envelope sealed elsewhere. */
  async function signSealed(
    device: CertifyingDevice,
    material: Material,
    init: ProjectEnvelopeHeaderInit,
    envelope: Uint8Array,
    hash: string,
    versionKey: Uint8Array
  ) {
    try {
      const wrappedVersionKey = b64(
        await wrapKey(material.projectKey, versionKey, {
          purpose: 'version-key',
          projectId: init.projectId,
          keyEpoch: init.keyEpoch,
          kind: init.kind,
          versionId: hash
        })
      );
      const signature = b64(
        await signProjectEnvelope(device.signing.privateKey, envelope, now())
      );
      return { envelope, hash, wrappedVersionKey, signature };
    } finally {
      versionKey.fill(0);
    }
  }

  async function sealEnvelope(
    device: CertifyingDevice,
    material: Material,
    init: ProjectEnvelopeHeaderInit,
    plaintext: Uint8Array
  ) {
    const key = EnvelopeKey.generate();
    const envelope = await encryptProjectEnvelope(key, init, plaintext);
    const hash = toHex(await versionHash(envelope));
    const wrappedVersionKey = b64(
      await wrapKey(material.projectKey, key.bytes, {
        purpose: 'version-key',
        projectId: init.projectId,
        keyEpoch: init.keyEpoch,
        kind: init.kind,
        versionId: hash
      })
    );
    const signature = b64(
      await signProjectEnvelope(device.signing.privateKey, envelope, now())
    );
    return { envelope, hash, wrappedVersionKey, signature };
  }

  async function sealDocument(
    device: CertifyingDevice,
    material: Material,
    projectId: string,
    document: ProjectDocument,
    expectedVersion: number,
    previousHash: string | null,
    revisionHashes: ReadonlyMap<string, Uint8Array>
  ): Promise<Sealed> {
    // The checks every account write gets (ADR-024 Phase 1).
    const split = await splitProjectStorageUpload(document);
    if (split.storageAssets.length) {
      throw new UnstorableDocumentError(E2EE_CONTENT_UNAVAILABLE_MESSAGE);
    }
    const documentVersion = Math.max(document.version, expectedVersion + 1);
    const stored = {
      ...split.document,
      version: documentVersion
    } as unknown as ProjectDocument;
    // Every blob the document names, with the key and hash that let a
    // reader authenticate it; the header's ids are derived from this list.
    const blobs = documentBlobReferences(blobReferences, projectId, stored);
    const init: ProjectEnvelopeHeaderInit = {
      kind: 'document',
      projectId,
      documentVersion,
      previousVersionHash: previousHash === null ? null : fromHex(previousHash),
      epochBindingHash: await epochBinding(
        projectId,
        material.keyEpoch,
        material.epochAuthenticator
      ),
      schemaVersion: SCHEMA_VERSION,
      keyEpoch: material.keyEpoch
    };
    // Encoded and encrypted off the main thread in a page.
    const sealedBody = await seal({
      header: init,
      document: stored as unknown as Record<string, unknown>,
      blobs,
      revisionVersionHashes: retainedHashes(revisionHashes, stored)
    });
    // On every write, whoever sealed it: the header lists exactly the
    // references the body carries.
    const sealedHeader = parseEnvelope(sealedBody.envelope).header;
    if (sealedHeader.class !== 'project') {
      throw new Error('The sealed version is not a project envelope.');
    }
    checkBlobReferences(sealedHeader, blobs);
    const sealed = await signSealed(
      device,
      material,
      init,
      sealedBody.envelope,
      toHex(sealedBody.versionHash),
      sealedBody.versionKey
    );
    return {
      ...sealed,
      keyEpoch: material.keyEpoch,
      document: stored,
      signerDeviceId: device.deviceId
    };
  }

  async function sealInfo(
    device: CertifyingDevice,
    material: Material,
    projectId: string,
    body: ProjectInfoBody,
    sequence: number
  ): Promise<E2eeProjectEnvelopeUpload> {
    const init: ProjectEnvelopeHeaderInit = {
      kind: 'project-info',
      projectId,
      documentVersion: sequence,
      previousVersionHash: null,
      epochBindingHash: await epochBinding(
        projectId,
        material.keyEpoch,
        material.epochAuthenticator
      ),
      schemaVersion: SCHEMA_VERSION,
      keyEpoch: material.keyEpoch,
      // A copy's first info names the thumbnail and exports it carries.
      blobIds: projectInfoReferences(body).map((ref) => ref.blobId)
    };
    const sealed = await sealEnvelope(
      device,
      material,
      init,
      encodeProjectInfoBody(body, init)
    );
    return {
      sequence,
      envelope: b64(sealed.envelope),
      wrappedVersionKey: sealed.wrappedVersionKey,
      signature: sealed.signature,
      signerDeviceId: device.deviceId
    };
  }

  /**
   * Keeps the project-info envelope's name in step with the document's,
   * keeping its thumbnail and archived exports (slice 4-7).
   */
  async function syncInfo(projectId: string, state: HeadState): Promise<void> {
    const name = state.document.name;
    if (state.infoName === name) return;
    try {
      const body = await info.update(projectId, (current) =>
        current?.name === name
          ? null
          : {
              name,
              ...(current?.thumbnail ? { thumbnail: current.thumbnail } : {}),
              exports: current?.exports ?? []
            }
      );
      state.infoName = body?.name ?? name;
    } catch {
      // The name follows on the next save; the document is what matters.
    }
  }

  /** One version on top of `expectedVersion`, retried once on a new epoch. */
  async function writeVersion(
    projectId: string,
    document: ProjectDocument,
    expectedVersion: number,
    revisionId: string | null
  ) {
    const device = writableDevice();
    if (document.projectId !== projectId) {
      throw new ApiError(404, 'Project not found.', 'PROJECT_NOT_FOUND');
    }
    const head = await headFor(projectId, expectedVersion);
    let restored = false;
    for (let attempt = 0; ; attempt++) {
      const material = await currentMaterial(device, projectId);
      const sealed = await sealDocument(
        device,
        material,
        projectId,
        document,
        expectedVersion,
        head.hash,
        head.revisionHashes
      );
      const upload = {
        expectedVersion,
        signature: sealed.signature,
        wrappedVersionKey: sealed.wrappedVersionKey,
        signerDeviceId: sealed.signerDeviceId
      };
      let response;
      try {
        response =
          revisionId === null
            ? await api.saveDocument(projectId, upload, sealed.envelope)
            : await api.saveRevision(
                projectId,
                { ...upload, revisionId },
                sealed.envelope
              );
      } catch (error) {
        // The group moved between the catch-up and the write: once more.
        if (
          error instanceof ApiError &&
          error.code === 'E2EE_EPOCH_STALE' &&
          attempt < 2
        ) {
          continue;
        }
        // The account lost or collected a blob this document names: store
        // it again from this device's copy and retry, once.
        if (
          error instanceof ApiError &&
          error.code === 'E2EE_BLOB_UNKNOWN' &&
          ctx.restoreBlobs &&
          !restored
        ) {
          restored = true;
          await ctx.restoreBlobs(projectId, unknownBlobsOf(error, sealed));
          continue;
        }
        throw error;
      }
      if (response.versionHash !== sealed.hash) {
        throw integrity(
          'content',
          'The account stored another version than this browser sent.'
        );
      }
      await pins.advance(userId, projectId, head.hash, {
        headHash: sealed.hash,
        documentVersion: response.version,
        keyEpoch: sealed.keyEpoch
      });
      const revisionHashes = retainedHashes(
        head.revisionHashes,
        sealed.document
      );
      if (revisionId !== null) {
        revisionHashes.set(revisionId, fromHex(sealed.hash));
      }
      const state: HeadState = {
        version: response.version,
        hash: sealed.hash,
        keyEpoch: sealed.keyEpoch,
        revisionHashes,
        document: sealed.document,
        infoName: head.infoName,
        infoSequence: head.infoSequence
      };
      heads.set(projectId, state);
      await syncInfo(projectId, state);
      return { response, document: sealed.document };
    }
  }

  /**
   * Opens a replaced envelope (project info, measurements, view state):
   * signed by a device this account lists, bound to its key epoch, of the
   * kind, project, sequence and epoch the account named, then decoded by
   * its body codec.
   */
  async function openReplaced(
    record: E2eeProjectEnvelopeRecord,
    kind: E2eeReplacedEnvelopeKind
  ): Promise<OpenedReplaced> {
    const envelope = bytes(record.envelope);
    const signer = list().devices.find(
      (d) => d.deviceId === record.signerDeviceId
    );
    if (!signer) {
      throw integrity(
        'author',
        'This envelope is not signed by a device this account lists.'
      );
    }
    const signed = await verifyProjectEnvelopeSignature(
      signer.signingKey,
      envelope,
      bytes(record.signature)
    ).catch(() => null);
    if (!signed) {
      throw integrity('author', 'This envelope’s signature does not verify.');
    }
    let header: ProjectEnvelopeHeader;
    try {
      const parsed = parseEnvelope(envelope).header;
      if (parsed.class !== 'project') throw new Error('not a project envelope');
      header = parsed;
    } catch {
      throw integrity('content', 'This envelope does not parse.');
    }
    if (
      header.kind !== kind ||
      header.projectId !== record.projectId ||
      header.keyEpoch !== record.keyEpoch ||
      header.documentVersion !== record.sequence
    ) {
      throw integrity(
        'content',
        'This envelope is not the one the account named.'
      );
    }
    await requireBinding(header);
    const hash = toHex(await versionHash(envelope));
    const versionKey = await versionKeyOf(
      record.projectId,
      header,
      hash,
      record.wrappedVersionKey
    );
    let result: ProjectEnvelopeDecodeResult;
    try {
      result = await open({
        kind,
        versionKey,
        envelope,
        expect: {
          projectId: record.projectId,
          keyEpoch: record.keyEpoch,
          documentVersion: record.sequence
        }
      });
    } catch (error) {
      throw integrity(
        'content',
        `This ${kind} envelope does not decrypt (${error instanceof Error ? error.message : String(error)}).`
      );
    } finally {
      versionKey.fill(0);
    }
    return {
      header: result.header,
      value: result.value,
      hash,
      signedAt: signed.signedAt
    };
  }

  /** Seals a replaced envelope under the project's current key epoch. */
  async function sealReplaced(
    projectId: string,
    init: {
      readonly kind: E2eeReplacedEnvelopeKind;
      readonly sequence: number;
      readonly previousHash: string | null;
      readonly blobIds: readonly string[];
    },
    encode: (header: BodyEnvelopeHeader) => Uint8Array
  ): Promise<SealedReplaced> {
    const device = writableDevice();
    const material = await currentMaterial(device, projectId);
    const header: ProjectEnvelopeHeaderInit = {
      kind: init.kind,
      projectId,
      documentVersion: init.sequence,
      previousVersionHash:
        init.previousHash === null ? null : fromHex(init.previousHash),
      epochBindingHash: await epochBinding(
        projectId,
        material.keyEpoch,
        material.epochAuthenticator
      ),
      schemaVersion: SCHEMA_VERSION,
      keyEpoch: material.keyEpoch,
      blobIds: init.blobIds
    };
    const sealed = await sealEnvelope(device, material, header, encode(header));
    return {
      envelope: b64(sealed.envelope),
      wrappedVersionKey: sealed.wrappedVersionKey,
      signature: sealed.signature,
      signerDeviceId: device.deviceId,
      hash: sealed.hash,
      keyEpoch: material.keyEpoch
    };
  }

  const replaced: ReplacedEnvelopeKit = {
    seal: (projectId, init, encode) =>
      sealReplaced(projectId, init, encode).catch((error: unknown) => {
        throw asApiError(error);
      }),
    open: openReplaced
  };

  const info = createProjectInfoAccess({
    userId,
    kit: replaced,
    pins,
    references: blobReferences,
    api
  });

  async function projectName(
    record: E2eeProjectEnvelopeRecord
  ): Promise<string | null> {
    try {
      return (await info.verify(record)).name;
    } catch {
      return null;
    }
  }

  // --- The live room (slice 4-9) ---------------------------------------------

  /** Room versions this page sealed, until their ack. */
  const roomSealed = new WeakSet<EncryptedRoomSealed>();

  /**
   * The account's log from `since` through the room's head, which the room
   * wrote to the account before it relayed it.
   */
  async function roomLog(
    projectId: string,
    since: number,
    head: E2eeVersionLogEntry
  ): Promise<E2eeVersionLogEntry[]> {
    const entries: E2eeVersionLogEntry[] = [];
    for (let from = since; ;) {
      const page = await api.versions(projectId, from);
      const last = entries.at(-1);
      if (last && page.log[0]?.versionHash !== last.versionHash) {
        throw integrity(
          'fork',
          'The account’s version history pages do not join.'
        );
      }
      entries.push(...(last ? page.log.slice(1) : page.log));
      const at = entries.findIndex(
        (entry) => entry.documentVersion >= head.documentVersion
      );
      if (at >= 0) {
        if (entries[at]!.versionHash !== head.versionHash) {
          throw integrity(
            'fork',
            'The room relayed a version the account’s history does not hold.'
          );
        }
        return entries.slice(0, at + 1);
      }
      if (
        !page.more ||
        page.log.length < 2 ||
        entries.length > MAX_LOG_RECORDS
      ) {
        throw integrity(
          'fork',
          'The account’s version history does not reach the room’s head.'
        );
      }
      from = entries.at(-1)!.documentVersion;
    }
  }

  /**
   * A head the room relays, read as a current head (ADR-024, current head):
   * the log from the pin through it verifies, its author and authority hold,
   * it decrypts in the decode worker and validates, and the pin moves.
   */
  async function openRoomHead(
    projectId: string,
    record: E2eeStoredVersion,
    envelope: Uint8Array | null
  ): Promise<EncryptedRoomHeadState> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const known = heads.get(projectId);
      if (known?.hash === record.versionHash) return known;
      // Too large for the room: the account serves it, verified the same way.
      if (!envelope) return readHead(projectId);
      const pin = await pins.read(userId, projectId);
      const pinHash = pin?.headHash ?? null;
      if (pin && pinHash && record.documentVersion < pin.documentVersion) {
        throw integrity(
          'rollback',
          `The room offered version ${record.documentVersion} of this project, older than version ${pin.documentVersion} this browser already accepted. Your work stays on this device.`
        );
      }
      const entries = await roomLog(
        projectId,
        pin && pinHash ? pin.documentVersion : record.documentVersion,
        record
      );
      await verifyLog(projectId, pinHash, entries);
      const author = await authorOf(
        projectId,
        envelope,
        bytes(record.signature)
      );
      const header = author.header;
      const hash = toHex(author.versionHash);
      if (
        hash !== record.versionHash ||
        header.documentVersion !== record.documentVersion ||
        header.kind !== 'document' ||
        header.projectId !== projectId
      ) {
        throw integrity(
          'content',
          'The version the room relayed is not the one its record names.'
        );
      }
      if (author.deviceId !== record.signerDeviceId) {
        throw integrity(
          'author',
          'The room’s head names another device than the one that signed it.'
        );
      }
      const { group } = await groups.api.group(projectId);
      if (header.keyEpoch > group.keyEpochBase + group.epoch) {
        throw integrity(
          'epoch',
          'The room’s head names a key epoch the project does not have yet.'
        );
      }
      if (pin && pinHash && header.keyEpoch < pin.keyEpoch) {
        throw integrity(
          'epoch',
          'The room’s head was written under an older key epoch than this browser already accepted.'
        );
      }
      await requireAuthority(projectId, author);
      await requireBinding(header);
      const { body, document } = await openDocument(
        projectId,
        header,
        hash,
        record.wrappedVersionKey,
        envelope
      );
      const advanced = await pins.advance(userId, projectId, pinHash, {
        headHash: hash,
        documentVersion: header.documentVersion,
        keyEpoch: header.keyEpoch
      });
      if (!advanced) {
        // Another tab moved the pin meanwhile: verify again from it.
        const current = await pins.read(userId, projectId);
        if (current?.headHash !== hash) continue;
      }
      const state: HeadState = {
        version: header.documentVersion,
        hash,
        keyEpoch: header.keyEpoch,
        revisionHashes: new Map(body.revisionVersionHashes),
        document,
        infoName: heads.get(projectId)?.infoName ?? null,
        infoSequence: Math.max(
          heads.get(projectId)?.infoSequence ?? 0,
          pin?.infoSequence ?? 0
        )
      };
      heads.set(projectId, state);
      return state;
    }
    throw integrity(
      'fork',
      'This project kept changing in another tab while it was checked. Reload to try again.'
    );
  }

  const roomAccess: EncryptedRoomAccess = {
    currentHead: (projectId) => heads.get(projectId) ?? null,

    async seal(projectId, document, base) {
      const device = writableDevice();
      if (document.projectId !== projectId) {
        throw new ApiError(404, 'Project not found.', 'PROJECT_NOT_FOUND');
      }
      const material = await currentMaterial(device, projectId);
      const sealed = await sealDocument(
        device,
        material,
        projectId,
        document,
        base.version,
        base.hash,
        base.revisionHashes
      );
      const result: EncryptedRoomSealed = {
        envelope: sealed.envelope,
        hash: sealed.hash,
        keyEpoch: sealed.keyEpoch,
        document: sealed.document,
        version: sealed.document.version,
        signature: sealed.signature,
        wrappedVersionKey: sealed.wrappedVersionKey,
        signerDeviceId: sealed.signerDeviceId
      };
      roomSealed.add(result);
      return result;
    },

    openHead: (projectId, record, envelope) =>
      openRoomHead(projectId, record, envelope),

    async accepted(projectId, sealed, base, record) {
      if (
        record.versionHash !== sealed.hash ||
        record.documentVersion !== sealed.version
      ) {
        throw integrity(
          'content',
          'The room stored another version than this browser sent.'
        );
      }
      const advanced = await pins.advance(userId, projectId, base.hash, {
        headHash: sealed.hash,
        documentVersion: sealed.version,
        keyEpoch: sealed.keyEpoch
      });
      if (!advanced) {
        const current = await pins.read(userId, projectId);
        if (
          current?.headHash !== sealed.hash &&
          (current?.documentVersion ?? 0) >= sealed.version
        ) {
          throw integrity(
            'fork',
            'This browser accepted another version while the room stored this one. Reload to check.'
          );
        }
      }
      const previous = heads.get(projectId);
      const state: HeadState = {
        version: sealed.version,
        hash: sealed.hash,
        keyEpoch: sealed.keyEpoch,
        revisionHashes: retainedHashes(base.revisionHashes, sealed.document),
        document: sealed.document,
        infoName: previous?.infoName ?? null,
        infoSequence: previous?.infoSequence ?? 0
      };
      heads.set(projectId, state);
      const ours = roomSealed.delete(sealed);
      // The shelf's name follows the document, as after an account save:
      // through the project info's own chain (slice 4-7), keeping its
      // thumbnail and archived exports.
      if (ours) await syncInfo(projectId, state);
      return state;
    },

    async catchUp(projectId) {
      if (groups.device) await joinProjectGroup(groups, projectId);
    }
  };

  const guarded =
    <A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await run(...args);
      } catch (error) {
        throw asApiError(error);
      }
    };

  const summaryOf = (
    state: E2eeProjectState,
    name: string
  ): ProjectSummary => ({
    projectId: state.projectId as ProjectSummary['projectId'],
    name,
    revisionCount: state.revisionCount,
    updatedAt: state.updatedAt,
    documentVersion: state.documentVersion,
    organization: state.organization,
    storageFormat: PROJECT_STORAGE_FORMAT_E2EE_V1
  });

  /**
   * A new project from a prepared document: its MLS group at epoch 0, its
   * first version and its first project info, in one write. A copy names
   * its source and the blobs the account copies for it; an adoption, the
   * device project it binds (slice 4-8).
   */
  async function createFrom(
    document: ProjectDocument,
    extra: {
      readonly info: ProjectInfoBody;
      readonly copyFrom?: E2eeCopyFrom;
      readonly adoption?: E2eeAdoption;
    }
  ): Promise<CreateProjectResponse> {
    const device = writableDevice();
    const projectId = document.projectId;
    let created:
      | {
          sealed: Sealed;
          state: E2eeProjectState;
          infoHash: string;
        }
      | undefined;
    const creating: ProjectGroupContext = {
      ...groups,
      api: {
        ...groups.api,
        // The project row is written together with its group, so until
        // that write lands the Worker knows no such project. To
        // createProjectGroup, which asks for an existing group before
        // building one and again after a failed upload, that is a project
        // without a group yet.
        group: async (id) => {
          try {
            return await groups.api.group(id);
          } catch (error) {
            if (
              error instanceof E2eeApiError &&
              error.status === 404 &&
              error.code === 'PROJECT_NOT_FOUND'
            ) {
              throw new E2eeApiError(
                404,
                error.message,
                'E2EE_GROUP_NOT_FOUND'
              );
            }
            throw error;
          }
        },
        // The group's epoch 0 travels with the project row, its first
        // version and its project info, in one write.
        createGroup: async (id, groupRequest) => {
          const material = await groups.sessions.epochMaterial(
            refOf(device, id)
          );
          const epoch0: Material = {
            keyEpoch: 0,
            projectKey: material.projectKey,
            epochAuthenticator: material.epochAuthenticator
          };
          const sealed = await sealDocument(
            device,
            epoch0,
            id,
            document,
            0,
            null,
            new Map()
          );
          const firstInfo = await sealInfo(device, epoch0, id, extra.info, 1);
          const metadata = {
            projectId: id,
            group: groupRequest,
            version: {
              expectedVersion: 0,
              signature: sealed.signature,
              wrappedVersionKey: sealed.wrappedVersionKey,
              signerDeviceId: device.deviceId
            },
            info: firstInfo,
            ...(extra.copyFrom ? { copyFrom: extra.copyFrom } : {}),
            ...(extra.adoption ? { adoption: extra.adoption } : {})
          };
          let response;
          try {
            response = await api.create(metadata, sealed.envelope);
          } catch (error) {
            // The request may have landed and its answer been lost: the
            // same bytes again are answered as created (slice 4-8).
            if (error instanceof ApiError) throw error;
            response = await api.create(metadata, sealed.envelope);
          }
          if (response.versionHash !== sealed.hash) {
            throw integrity(
              'content',
              'The account stored another version than this browser sent.'
            );
          }
          created = {
            sealed,
            state: response.project,
            infoHash: toHex(await versionHash(bytes(firstInfo.envelope)))
          };
          return groups.api.group(id);
        }
      }
    };
    await createProjectGroup(creating, projectId);
    if (!created) throw new Error('The encrypted project was not created.');
    const { sealed, state, infoHash } = created;
    await pins.advance(userId, projectId, null, {
      headHash: sealed.hash,
      documentVersion: sealed.document.version,
      keyEpoch: 0
    });
    await pins.advanceInfo(userId, projectId, 1, infoHash);
    heads.set(projectId, {
      version: sealed.document.version,
      hash: sealed.hash,
      keyEpoch: 0,
      revisionHashes: new Map(),
      document: sealed.document,
      infoName: extra.info.name,
      infoSequence: 1
    });
    return {
      project: summaryOf(state, sealed.document.name),
      document: sealed.document
    };
  }

  /** The browser's checks of a new project's document (ADR-024 Phase 1). */
  function prepared(source: ProjectDocument, name: string): ProjectDocument {
    try {
      return prepareInitialProjectDocument(userId as UserId, source, name);
    } catch (error) {
      throw new ApiError(
        400,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return {
    createProject: guarded(async (request) => {
      writableDevice();
      const ownerUserId = userId as UserId;
      // A device project saved to the account (decision D2): stored as the
      // page re-homed it; its device-only files follow as blobs.
      if (request.document || request.adoptionProtocolVersion) {
        if (
          request.adoptionProtocolVersion !== 2 ||
          !request.document ||
          !request.localProjectId
        ) {
          throw new ApiError(
            400,
            'This device project cannot be saved to the account as sent.'
          );
        }
        const document = prepared(request.document, request.name);
        return createFrom(document, {
          info: { name: document.name, exports: [] },
          adoption: { localProjectId: request.localProjectId }
        });
      }
      const initial =
        request.initialDocument ??
        createProjectDocument(request.name, ownerUserId, request.units);
      const document = prepared(initial, request.name);
      return createFrom(document, {
        info: { name: document.name, exports: [] }
      });
    }),

    copyProject: guarded(async (request) => {
      writableDevice();
      const sourceProjectId = request.sourceProjectId;
      if (request.document.projectId === sourceProjectId) {
        throw new ApiError(400, 'A copy is a new project.');
      }
      const document = prepared(request.document, request.document.name);
      const projectId = document.projectId;
      // The copy names the source's blobs: the references this page holds
      // from the verified source become the copy's own, keys and all.
      const blobIds = new Set<string>();
      for (const id of importArtifactIds(document)) {
        if (id.startsWith('artifact_local_')) continue;
        const held = blobReferences.get(sourceProjectId, id);
        if (!held) {
          throw new UnstorableDocumentError(E2EE_BLOB_KEY_MISSING_MESSAGE);
        }
        blobReferences.remember(projectId, held.reference, held.checksumSha256);
        blobIds.add(id);
      }
      // A duplicate carries the shelf picture and archived exports; a
      // branch starts from an older save, which neither shows.
      let carried: ProjectInfoBody | null = null;
      if (request.revisionId === undefined) {
        try {
          carried = (await info.read(sourceProjectId)).body;
        } catch {
          carried = null;
        }
      }
      const firstInfo: ProjectInfoBody = {
        name: document.name,
        ...(carried?.thumbnail ? { thumbnail: carried.thumbnail } : {}),
        exports: carried?.exports ?? []
      };
      for (const reference of projectInfoReferences(firstInfo)) {
        blobReferences.remember(projectId, reference);
        blobIds.add(reference.blobId);
      }
      return createFrom(document, {
        info: firstInfo,
        copyFrom: {
          projectId: sourceProjectId,
          blobIds: [...blobIds].sort(),
          ...(request.revisionId === undefined
            ? {}
            : { revisionId: request.revisionId })
        }
      });
    }),

    saveProjectDocument: guarded(async (payload) => {
      const { response } = await writeVersion(
        payload.projectId,
        payload.document,
        payload.expectedVersion,
        null
      );
      return {
        projectId: payload.projectId,
        version: response.version,
        updatedAt: response.updatedAt
      };
    }),

    saveRevision: guarded(async (payload) => {
      const reason = payload.reason.trim();
      const document =
        payload.savedRevisionId === undefined
          ? createSavedRevision(payload.document, reason)
          : payload.document;
      const revisionId =
        payload.savedRevisionId ?? document.revisions.at(-1)!.revisionId;
      return (
        await writeVersion(
          payload.projectId,
          document,
          payload.expectedVersion,
          revisionId
        )
      ).document;
    }),

    loadProject: guarded(async (projectId) =>
      opened(projectId, (await readHead(projectId)).document)
    ),

    loadRevision: guarded(async (projectId, revisionId) => {
      // The pinned head's signed body is what proves a revision belongs.
      const head = heads.get(projectId) ?? (await readHead(projectId));
      const found = await api.revision(projectId, revisionId);
      if (!found) return null;
      const { metadata, envelope } = found;
      const expected = head.revisionHashes.get(revisionId);
      const claimed = metadata.version.versionHash;
      if (claimed !== head.hash && (!expected || toHex(expected) !== claimed)) {
        throw integrity(
          'history',
          'This saved version is not part of the history this browser trusts.'
        );
      }
      const author = await authorOf(
        projectId,
        envelope,
        bytes(metadata.version.signature)
      );
      const hash = toHex(author.versionHash);
      if (hash !== claimed || author.header.kind !== 'document') {
        throw integrity(
          'history',
          'The saved version the account sent is not the one its history names.'
        );
      }
      await requireAuthority(projectId, author);
      await requireBinding(author.header);
      const { document } = await openDocument(
        projectId,
        author.header,
        hash,
        metadata.version.wrappedVersionKey,
        envelope
      );
      // A historical read never moves the pin.
      return opened(projectId, document);
    }),

    listRevisions: guarded(async (projectId) => {
      const { revisions, maxRevisions } = await api.revisions(projectId);
      const head = heads.get(projectId) ?? (await readHead(projectId));
      const reasons = new Map<string, string>();
      for (const record of head.document.revisions) {
        reasons.set(record.revisionId, record.reason);
      }
      for (const checkpoint of head.document.checkpoints) {
        reasons.set(checkpoint.revisionId, checkpoint.reason);
      }
      return {
        revisions: revisions.map((revision) => ({
          revisionId: revision.revisionId as never,
          projectId: projectId as never,
          reason: reasons.get(revision.revisionId) ?? 'Saved version',
          createdAt: revision.createdAt,
          ...(revision.authorUserId
            ? { authorUserId: revision.authorUserId as UserId }
            : {}),
          documentBytes: revision.documentBytes
        })),
        maxRevisions
      };
    }),

    projectName,
    info,
    replaced,
    roomAccess: () => roomAccess
  };
}

/** The pin type, for callers that inspect what a read accepted. */
export type { ProjectVersionPin };
