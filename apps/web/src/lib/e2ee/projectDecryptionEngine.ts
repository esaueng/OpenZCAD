/**
 * The browser engine of the beta-only reverse path (ADR-024 Phase 7, slice
 * 7-3; roadmap L11), behind E2EE_REVERSE_ENABLED: it turns an encrypted
 * project its owner alone holds back into plaintext. It mirrors the
 * encrypting engine (`projectMigrationEngine.ts`) step for step, in the
 * other direction, on migration 0042's state machine with direction
 * `decrypt`:
 *
 * 1. **Start.** This page's edits to the project are flushed, then the
 *    Worker starts staging (or resumes it), closes the encrypted room and
 *    refuses encrypted writes. The lease is renewed in the background.
 * 2. **Save states**, oldest first: each retained encrypted save state is
 *    opened through the verifying store and staged as a plaintext save
 *    state under its own revision id; every encrypted blob its document
 *    names is decrypted and stored as an ordinary file first (an import's
 *    archive, a mesh payload, a reference picture), and the document names
 *    the file's artifact id instead of the blob id.
 * 3. **Head**, at `sourceVersion + 1`, so it is newer than the encrypted
 *    head; then the project info (the name, the thumbnail and the archived
 *    exports, as files), measurements and view state.
 * 4. **Checks**: every retained encrypted save state is staged.
 * 5. **Cutover** to format 1, then the purge of every encrypted row, blob
 *    and room key, a bounded step per call.
 *
 * **Resumable.** The Worker's list of what is staged is the journal: a
 * resumed run skips staged save states and finds staged files by the blob
 * id their metadata names (`e2eeBlobId`). A lost lease resumes by starting
 * again; an encrypted head that moved abandons and starts over.
 */
import {
  DECRYPT_STAGED_BLOB_METADATA_KEY,
  E2EE_MIGRATION_CODES,
  THUMBNAIL_CONTENT_TYPE,
  documentAssetsWithHistory,
  documentNodesWithHistory,
  referenceImagesWithHistory,
  type ArtifactKind,
  type E2eeDecryptStagingResponse,
  type E2eeProjectMigrationRecord,
  type ProjectDocument,
  type ProjectSummary,
  type RevisionSummary
} from '@openzcad/shared';
import { ApiError } from '../api';
import { importSourceArchive, meshPayloadArchive } from '../importArchival';
import type { BlobReferenceRegistry } from './blobReferences';
import type { EncryptedContentBlobs } from './encryptedContentBlobs';
import { EXPORT_ARTIFACT_KINDS } from './encryptedProjectInfo';
import type { EncryptedProjectStore } from './encryptedProjectStore';
import {
  createMigrationPlaintextTarget,
  type MigrationPlaintextTarget
} from './migrationPlaintextTarget';
import {
  MigrationPausedError,
  memoryLeaseStore,
  migrationErrorOf,
  withBlobIds,
  type MigrationError,
  type MigrationLeaseStore,
  type MigrationPhase,
  type MigrationProgress
} from './projectMigrationEngine';
import {
  withMigrationLease,
  type ProjectMigrationsApi
} from './projectMigrationsApi';
import type {
  EncryptedMeasurements,
  EncryptedViewStates
} from './replacedEnvelopes';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The encrypted-project clients the engine reads (and verifies) through. */
export interface DecryptionReadClients {
  readonly store: EncryptedProjectStore;
  readonly blobs: EncryptedContentBlobs;
  readonly references: BlobReferenceRegistry;
  readonly measurements: EncryptedMeasurements;
  readonly viewStates: EncryptedViewStates;
}

export interface DecryptionEngineDeps {
  readonly deviceId: string;
  /** The page's fetcher; the engine adds the lease for staging requests. */
  readonly fetcher: Fetch;
  readonly migrations: ProjectMigrationsApi;
  /** The encrypted clients, built once. */
  createReaders(): DecryptionReadClients;
  /** Where staged plaintext goes (the plaintext routes, by default). */
  createTarget?(leased: Fetch): MigrationPlaintextTarget;
  readonly leases?: MigrationLeaseStore;
  /** Saves this page's pending edits to the project before staging begins. */
  flushProject?(projectId: string): Promise<void>;
  /** After the cutover: this page now treats the project as plaintext. */
  onCutover?(projectId: string): void;
  onProgress?(progress: MigrationProgress): void;
  readonly renewEveryMs?: number;
  /** Runs before each staging step; tests interrupt the engine through it. */
  beforeStep?(step: string, projectId: string): void | Promise<void>;
}

export interface ProjectDecryptionEngine {
  /**
   * Turns one encrypted project back into plaintext, resuming whatever was
   * staged. Rejects with {@link MigrationPausedError} when `signal` aborts.
   */
  decrypt(project: ProjectSummary, signal?: AbortSignal): Promise<void>;
  /** Drops a staging and lets the encrypted project be written again. */
  cancel(projectId: string): Promise<void>;
}

/** Staged work that must be dropped and staged again from the start. */
class RestartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestartError';
  }
}

const MAX_RESTARTS = 2;
const MAX_RESUMES = 3;
const MAX_STEP_CALLS = 500;

const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** Plain words for what went wrong turning encryption off. */
export function decryptionErrorOf(error: unknown): MigrationError {
  switch (codeOf(error)) {
    case E2EE_MIGRATION_CODES.shared:
      return {
        code: E2EE_MIGRATION_CODES.shared,
        retryable: false,
        message:
          'Only a project nobody else can open can stop being encrypted. Remove its members, pending invitations and share links first.'
      };
    case E2EE_MIGRATION_CODES.optedIn:
      return {
        code: E2EE_MIGRATION_CODES.optedIn,
        retryable: false,
        message:
          'Your account encrypts new projects, so it cannot hold a plaintext one. Turn off “Encrypt new projects” first.'
      };
    case E2EE_MIGRATION_CODES.leased:
      return {
        code: E2EE_MIGRATION_CODES.leased,
        retryable: true,
        message:
          'Another device or tab is turning this project’s encryption off. Wait for it to finish, or retry in five minutes if it was closed.'
      };
    case 'FEATURE_DISABLED':
      return {
        code: 'FEATURE_DISABLED',
        retryable: false,
        message: 'Turning encryption off is not available for this account.'
      };
    // The cutover (or a further staged file) would take the account over
    // its limits: retrying cannot help until space is freed. Nothing was
    // changed; the staging stays until it is cancelled.
    case 'ARTIFACT_QUOTA_EXCEEDED':
      return {
        code: 'ARTIFACT_QUOTA_EXCEEDED',
        retryable: false,
        message:
          'Your account does not have room for this project’s files as plaintext. Nothing was changed; the project stays encrypted. Cancel, free up file storage, then try again.'
      };
    case 'PROJECT_STORAGE_QUOTA':
      return {
        code: 'PROJECT_STORAGE_QUOTA',
        retryable: false,
        message:
          'Your account does not have project storage left for this project as plaintext. Nothing was changed; the project stays encrypted. Cancel, free up project storage, then try again.'
      };
  }
  return migrationErrorOf(error);
}

/** What one file a document names is, for its plaintext artifact. */
interface FileMeta {
  readonly kind: ArtifactKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly metadata?: Record<string, string | number | boolean>;
}

/**
 * The encrypted blobs a document names (in its model and undo history), by
 * blob id, with what each is as a plaintext file: an imported STEP's
 * archive, an imported mesh's payload, a reference picture, or (named only
 * by a project asset) whatever its blob kind says. Ids this page holds no
 * blob reference for (device-local ones) are left alone.
 */
export function documentBlobFiles(
  document: ProjectDocument,
  /** The blob kind of an id this page holds a reference for, else null. */
  isBlob: (id: string) => string | null
): Map<string, FileMeta> {
  const files = new Map<string, FileMeta>();
  const add = (id: unknown, meta: () => FileMeta) => {
    if (typeof id !== 'string' || files.has(id) || !isBlob(id)) return;
    files.set(id, meta());
  };
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind !== 'feature') continue;
    const data = node.data as {
      featureKind?: string;
      artifactId?: string;
      sourceName?: string;
    };
    const sourceName = data.sourceName ?? 'import';
    if (data.featureKind === 'imported-step') {
      add(data.artifactId, () => ({
        kind: 'step-import',
        fileName: sourceName,
        contentType: 'model/step'
      }));
    } else if (data.featureKind === 'imported-mesh') {
      add(data.artifactId, () => meshPayloadArchive(sourceName));
    }
  }
  for (const image of referenceImagesWithHistory(document)) {
    add(image.artifactId, () =>
      importSourceArchive({
        kind: 'reference-image',
        sourceName: image.name,
        contentType: image.contentType
      })
    );
  }
  for (const asset of documentAssetsWithHistory(document)) {
    add(asset.artifactId, () =>
      isBlob(asset.artifactId!) === 'mesh-payload'
        ? meshPayloadArchive(asset.name)
        : {
            kind: 'step-import',
            fileName: asset.name,
            contentType: asset.contentType || 'model/step'
          }
    );
  }
  return files;
}

const documentBytes = (document: ProjectDocument) =>
  new TextEncoder().encode(JSON.stringify(document)).byteLength;

/** Encrypted projects the caller may turn back into plaintext, newest first. */
export function decryptableProjects(
  projects: readonly ProjectSummary[]
): ProjectSummary[] {
  return projects
    .filter(
      (project) =>
        project.storageFormat === 2 &&
        (project.organization?.status ?? 'active') !== 'deleted'
    )
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.projectId.localeCompare(b.projectId)
    );
}

export function createProjectDecryptionEngine(
  deps: DecryptionEngineDeps
): ProjectDecryptionEngine {
  const { migrations } = deps;
  const leases = deps.leases ?? memoryLeaseStore();
  let currentLease: string | null = null;
  const leased: Fetch = (input, init) =>
    currentLease
      ? withMigrationLease(deps.fetcher, currentLease)(input, init)
      : deps.fetcher(input, init);
  let readers: DecryptionReadClients | null = null;
  const read = () => (readers ??= deps.createReaders());
  const target = (deps.createTarget ?? createMigrationPlaintextTarget)(leased);

  async function stepAll(
    step: () => Promise<{ complete: boolean }>
  ): Promise<void> {
    for (let call = 0; call < MAX_STEP_CALLS; call++) {
      if ((await step()).complete) return;
    }
    throw new ApiError(503, 'The account did not finish. Try again.');
  }

  async function abandonAll(projectId: string): Promise<void> {
    const lease = leases.get(projectId);
    await stepAll(() => migrations.abandon(projectId, lease));
    leases.delete(projectId);
    currentLease = null;
  }

  /**
   * After the cutover the project is plaintext: this browser forgets what
   * it accepted of its encrypted form (head, pins, cached project keys and
   * roles), so encrypting it again later starts from nothing.
   */
  async function leftEncryption(projectId: string): Promise<void> {
    leases.delete(projectId);
    currentLease = null;
    await read().store.forgetStagedProject(projectId);
    deps.onCutover?.(projectId);
  }

  async function purgeAll(
    projectId: string,
    report: (phase: MigrationPhase) => void
  ): Promise<void> {
    report('purging');
    await stepAll(() => migrations.purge(projectId));
    report('done');
  }

  async function acquire(
    projectId: string,
    existing: E2eeProjectMigrationRecord | null
  ): Promise<{ lease: string; migration: E2eeProjectMigrationRecord }> {
    if (existing?.state !== 'staging') {
      await deps.flushProject?.(projectId);
    }
    const started = await migrations.start(
      projectId,
      { direction: 'decrypt', deviceId: deps.deviceId },
      leases.get(projectId)
    );
    leases.set(projectId, started.leaseId);
    currentLease = started.leaseId;
    return { lease: started.leaseId, migration: started.migration };
  }

  function renewLease(projectId: string, lease: string) {
    const timer = setInterval(() => {
      migrations.renew(projectId, lease).catch(() => undefined);
    }, deps.renewEveryMs ?? 100_000);
    return { stop: () => clearInterval(timer) };
  }

  async function decrypt(
    project: ProjectSummary,
    signal?: AbortSignal
  ): Promise<void> {
    const projectId = project.projectId;
    let progress: MigrationProgress = {
      projectId,
      name: project.name,
      phase: 'starting',
      revisionsDone: 0,
      revisionsTotal: project.revisionCount,
      bytesDone: 0,
      bytesTotal: 0
    };
    const report = (change: Partial<MigrationProgress>) => {
      progress = { ...progress, ...change };
      deps.onProgress?.(progress);
    };
    const check = async (step: string) => {
      if (signal?.aborted) throw new MigrationPausedError();
      await deps.beforeStep?.(step, projectId);
      if (signal?.aborted) throw new MigrationPausedError();
    };
    report({});
    let restarts = 0;
    let resumes = 0;
    for (;;) {
      try {
        await runOnce(project, check, report, () => progress);
        return;
      } catch (error) {
        if (error instanceof MigrationPausedError) {
          report({ phase: 'paused' });
          throw error;
        }
        if (
          codeOf(error) === E2EE_MIGRATION_CODES.leaseLost &&
          resumes < MAX_RESUMES
        ) {
          resumes++;
          continue;
        }
        const restart =
          error instanceof RestartError ||
          codeOf(error) === E2EE_MIGRATION_CODES.stale;
        if (restart && restarts < MAX_RESTARTS) {
          restarts++;
          await abandonAll(projectId);
          continue;
        }
        report({ phase: 'error', error: decryptionErrorOf(error) });
        throw error;
      }
    }
  }

  async function runOnce(
    project: ProjectSummary,
    check: (step: string) => Promise<void>,
    report: (change: Partial<MigrationProgress>) => void,
    current: () => MigrationProgress
  ): Promise<void> {
    const projectId = project.projectId;
    await check('status');
    const status = (await migrations.status(projectId, leases.get(projectId)))
      .migration;
    const ours = status?.direction === 'decrypt';
    if (ours && (status.state === 'cutover' || status.state === 'purging')) {
      await leftEncryption(projectId);
      return purgeAll(projectId, (phase) => report({ phase }));
    }
    if (ours && status.state === 'done') {
      return report({ phase: 'done' });
    }
    if (status?.state === 'abandoned' && status.purgeCursor !== null) {
      await stepAll(() => migrations.abandon(projectId));
    }
    report({ phase: 'starting', error: undefined });
    const { lease, migration } = await acquire(projectId, status);
    const renewal = renewLease(projectId, lease);
    try {
      await stage(project, migration, lease, check, report, current);
      await check('cutover');
      report({ phase: 'cutover' });
      await migrations.cutover(projectId, lease);
    } finally {
      renewal.stop();
    }
    await leftEncryption(projectId);
    await check('purge');
    await purgeAll(projectId, (phase) => report({ phase }));
  }

  async function stage(
    project: ProjectSummary,
    migration: E2eeProjectMigrationRecord,
    lease: string,
    check: (step: string) => Promise<void>,
    report: (change: Partial<MigrationProgress>) => void,
    current: () => MigrationProgress
  ): Promise<void> {
    const projectId = project.projectId;
    const { store, blobs, references, measurements, viewStates } = read();

    // The encrypted head, as the start froze it, verified.
    await check('read');
    const head = await store.loadProject(projectId);
    if (head.version !== migration.sourceVersion) {
      throw new RestartError('The project changed after this began.');
    }
    const order = new Map(
      head.revisions.map((r, index) => [r.revisionId as string, index])
    );
    const revisions: RevisionSummary[] = [
      ...(await store.listRevisions(projectId)).revisions
    ].sort(
      (a, b) =>
        (order.get(a.revisionId) ?? -1) - (order.get(b.revisionId) ?? -1) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.revisionId.localeCompare(b.revisionId)
    );
    const info = (await store.info.read(projectId)).body;

    // The journal: what an earlier run staged.
    await check('journal');
    const journal: E2eeDecryptStagingResponse =
      await migrations.stagedPlaintext(projectId, lease);
    const staged = new Set(journal.revisions.map((r) => r.revisionId));
    const artifactIds = new Map<string, string>();
    for (const artifact of journal.artifacts) {
      if (artifact.blobId) artifactIds.set(artifact.blobId, artifact.artifactId);
    }

    const blobKind = (id: string) =>
      references.get(projectId, id)?.reference.kind ?? null;
    let bytesDone = 0;
    report({
      phase: 'revisions',
      revisionsDone: 0,
      revisionsTotal: revisions.length,
      bytesDone,
      bytesTotal:
        revisions.reduce((total, r) => total + r.documentBytes, 0) +
        documentBytes(head)
    });
    const advance = (bytes: number, extra: Partial<MigrationProgress> = {}) => {
      bytesDone += bytes;
      report({
        bytesDone: Math.min(bytesDone, Math.max(current().bytesTotal, 1)),
        ...extra
      });
    };

    /** Decrypts one blob into a staged file, once; its artifact id. */
    async function fileFor(blobId: string, meta: FileMeta): Promise<string> {
      const known = artifactIds.get(blobId);
      if (known) return known;
      await check('file');
      const bytes = await blobs.read(projectId, blobId);
      report({ bytesTotal: current().bytesTotal + bytes.byteLength });
      const artifactId = await target.stageFile(projectId, {
        fileName: meta.fileName,
        contentType: meta.contentType,
        kind: meta.kind,
        body: new Blob([bytes], { type: meta.contentType }),
        metadata: {
          ...(meta.metadata ?? {}),
          [DECRYPT_STAGED_BLOB_METADATA_KEY]: blobId
        }
      });
      artifactIds.set(blobId, artifactId);
      advance(bytes.byteLength);
      return artifactId;
    }

    /** The document with every blob it names moved to its staged file. */
    async function plaintextDocument(
      document: ProjectDocument
    ): Promise<ProjectDocument> {
      for (const [blobId, meta] of documentBlobFiles(document, blobKind)) {
        await fileFor(blobId, meta);
      }
      return withBlobIds(document, artifactIds);
    }

    // Save states, oldest first.
    let done = 0;
    for (const revision of revisions) {
      if (staged.has(revision.revisionId)) {
        done++;
        advance(revision.documentBytes, { revisionsDone: done });
        continue;
      }
      await check('revision');
      const document = await store.loadRevision(projectId, revision.revisionId);
      // Retention dropped it: the cutover no longer asks for it either.
      if (!document) continue;
      // Who saved it, a former collaborator's say, stays its author.
      await target.stageRevision(
        projectId,
        await plaintextDocument(document),
        revision.reason,
        revision.revisionId,
        revision.authorUserId
      );
      staged.add(revision.revisionId);
      done++;
      advance(revision.documentBytes, { revisionsDone: done });
    }

    // The head, newer than the encrypted head it replaces, under the name
    // the verified project info gives it.
    await check('head');
    report({ phase: 'head' });
    const plainHead = await plaintextDocument(head);
    await target.stageHead(projectId, {
      ...plainHead,
      name: info?.name || plainHead.name,
      version: migration.sourceVersion + 1
    });
    advance(documentBytes(head));

    // The shelf picture and the archived exports, as files.
    await check('info');
    report({ phase: 'details' });
    if (info?.thumbnail) {
      await fileFor(info.thumbnail.blobId, {
        kind: 'thumbnail',
        fileName: `${projectId}-thumbnail.webp`,
        contentType: THUMBNAIL_CONTENT_TYPE
      });
    }
    for (const entry of info?.exports ?? []) {
      const {
        artifactKind,
        createdAt: _createdAt,
        bytes: _bytes,
        ...metadata
      } = entry.metadata;
      const kind =
        typeof artifactKind === 'string' &&
        EXPORT_ARTIFACT_KINDS.has(artifactKind as ArtifactKind)
          ? (artifactKind as ArtifactKind)
          : null;
      if (!kind) continue;
      await fileFor(entry.ref.blobId, {
        kind,
        fileName: entry.fileName,
        contentType: entry.contentType,
        metadata
      });
    }

    // Measurements and view state, in one call.
    await check('measurements');
    const measured = await measurements.loadProjectMeasurements(projectId);
    const sessions = await viewStates.load(projectId);
    await migrations.stageDetails(projectId, lease, {
      measurements: measured.record,
      workspaceSessions: sessions.map(
        ({ updatedAt: _updatedAt, ...session }) => session
      )
    });

    // Every retained save state is staged.
    await check('checks');
    report({ phase: 'checking' });
    const after = await migrations.stagedPlaintext(projectId, lease);
    const stagedIds = new Set(after.revisions.map((r) => r.revisionId));
    const missing: string[] = [];
    for (const revision of revisions) {
      if (stagedIds.has(revision.revisionId)) continue;
      if ((await store.loadRevision(projectId, revision.revisionId)) !== null) {
        missing.push(revision.revisionId);
      }
    }
    if (missing.length) {
      throw new ApiError(
        409,
        'Some save states could not be carried into the plaintext history. Nothing was changed; your project stays encrypted.',
        E2EE_MIGRATION_CODES.revisionsIncomplete,
        { revisionIds: missing }
      );
    }
  }

  return {
    decrypt,
    async cancel(projectId) {
      await abandonAll(projectId);
    }
  };
}
