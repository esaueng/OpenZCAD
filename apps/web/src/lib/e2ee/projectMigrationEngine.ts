/**
 * The browser engine that moves an existing plaintext project to encrypted
 * storage (ADR-024 Phase 7, slice 7-2; roadmap L11), behind
 * E2EE_MIGRATION_ENABLED. The Worker (slice 7-1) keeps the migration's
 * state and a lease; everything that encrypts happens here, through the
 * encrypted-project clients slices 4-4 to 4-7 already built
 * (`encryptedProjectStore.ts`, `encryptedContentBlobs.ts`,
 * `encryptedProjectInfo.ts`, `replacedEnvelopes.ts`), whose every request
 * names the lease (`withMigrationLease`).
 *
 * For one project:
 *
 * 1. **Start.** This page's edits to it are flushed first
 *    (`flushProject`), then the Worker starts staging (or resumes it, with
 *    this page's own lease or a lapsed one), locks the plaintext and closes
 *    its room. A room still holding edits the account never saved answers
 *    E2EE_MIGRATION_ROOM_AHEAD, and one that cannot confirm what it holds
 *    503 PROJECT_ROOM_UNAVAILABLE; either way nothing is staged and the
 *    owner retries the start. The lease is renewed in the background for
 *    as long as the engine works on the project.
 * 2. **Save states** (decision M9), oldest first: each retained plaintext
 *    revision becomes an encrypted version and a named save under its own
 *    revision id; its body is the revision's document, so its name and
 *    reason travel inside the ciphertext. The files a document names
 *    (imports, mesh payloads, reference pictures) become content blobs
 *    first, through 4-6's dedupe tags, and the document names their blob
 *    ids. The first version also creates the project's MLS group and its
 *    project info.
 * 3. **Head**, at `sourceVersion + 1` or later, so it is newer than the
 *    plaintext head; then the project info (name, thumbnail, archived
 *    exports), measurements and view state.
 * 4. **Checks before the cutover**: every staged version was signed by,
 *    and every leaf of the staged group belongs to, a device the account
 *    still lists (a device removed during staging could read what was
 *    staged, and its versions would have no revocation cutoff here: the
 *    staging is abandoned and started again); the head's signed revision
 *    map names every retained save state.
 * 5. **Cutover**, then the purge, a bounded step per call, to completion.
 *
 * **Resumable.** The staged version log is the journal: on a resume the
 * engine verifies the staged head, reads its signed revision map (and
 * opens each staged save state, which hands this page their blob keys, so
 * dedupe finds them) and stages only what is missing. A lost lease
 * (E2EE_MIGRATION_LEASE_LOST) is resumed by starting again; a plaintext
 * that moved (E2EE_MIGRATION_STALE) is abandoned and started over.
 */
import {
  E2EE_MIGRATION_CODES,
  type ArtifactRecord,
  type E2eeProjectMigrationRecord,
  type ProjectDocument,
  type ProjectSummary,
  type RevisionSummary
} from '@openzcad/shared';
import type { ProjectExportEntry, ProjectInfoBody } from '@openzcad/crypto';
import { importArtifactIds } from '@openzcad/persistence';
import { ApiError } from '../api';
import type { BlobReferenceRegistry } from './blobReferences';
import type { EncryptedContentBlobs } from './encryptedContentBlobs';
import type { EncryptedDocumentsApi } from './encryptedDocumentsApi';
import { EXPORT_ARTIFACT_KINDS, exportMetadata } from './encryptedProjectInfo';
import type { EncryptedProjectStore } from './encryptedProjectStore';
import type { MigrationPlaintextSource } from './migrationPlaintextSource';
import type { ProjectGroupContext } from './projectGroups';
import {
  withMigrationLease,
  type ProjectMigrationsApi
} from './projectMigrationsApi';
import type {
  EncryptedMeasurements,
  EncryptedViewStates
} from './replacedEnvelopes';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The encrypted-project clients the engine stages through. */
export interface MigrationStagingClients {
  readonly store: EncryptedProjectStore;
  readonly blobs: EncryptedContentBlobs;
  readonly references: BlobReferenceRegistry;
  readonly measurements: EncryptedMeasurements;
  readonly viewStates: EncryptedViewStates;
  readonly groups: ProjectGroupContext;
  readonly documents: EncryptedDocumentsApi;
}

/** Where this page keeps the lease of a staging it may resume after a reload. */
export interface MigrationLeaseStore {
  get(projectId: string): string | null;
  set(projectId: string, leaseId: string): void;
  delete(projectId: string): void;
}

export function memoryLeaseStore(): MigrationLeaseStore {
  const leases = new Map<string, string>();
  return {
    get: (projectId) => leases.get(projectId) ?? null,
    set: (projectId, leaseId) => void leases.set(projectId, leaseId),
    delete: (projectId) => void leases.delete(projectId)
  };
}

export type MigrationPhase =
  | 'waiting'
  | 'starting'
  | 'revisions'
  | 'head'
  | 'details'
  | 'checking'
  | 'cutover'
  | 'purging'
  | 'done'
  | 'paused'
  | 'error';

export interface MigrationError {
  readonly code?: string;
  readonly message: string;
  /** Retrying may help (a network failure, a lease, a busy device). */
  readonly retryable: boolean;
}

export interface MigrationProgress {
  readonly projectId: string;
  readonly name: string;
  readonly phase: MigrationPhase;
  readonly revisionsDone: number;
  readonly revisionsTotal: number;
  /** Plaintext bytes encrypted so far: documents and files. */
  readonly bytesDone: number;
  readonly bytesTotal: number;
  /**
   * The project is cut over to encrypted storage, and its plaintext copy
   * is deleted only once the purge completes: until then a stop is
   * retried (the purge resumes), never cancelled.
   */
  readonly cutOver?: boolean;
  /**
   * A staging began, so the Worker holds the plaintext locked (writes
   * refused with PROJECT_MIGRATING) until it is cut over or abandoned:
   * this page keeps the project read-only meanwhile, paused or stopped.
   */
  readonly plaintextLocked?: boolean;
  readonly error?: MigrationError;
}

export interface MigrationEngineDeps {
  readonly deviceId: string;
  /** The page's fetcher; the engine adds the lease for staging requests. */
  readonly fetcher: Fetch;
  readonly migrations: ProjectMigrationsApi;
  readonly plaintext: MigrationPlaintextSource;
  /** The encrypted clients, built once over the leased fetcher. */
  createStaging(leased: Fetch): MigrationStagingClients;
  readonly leases?: MigrationLeaseStore;
  /** Saves this page's pending edits to the project before staging begins. */
  flushProject?(projectId: string): Promise<void>;
  /** After the cutover: this page now treats the project as encrypted. */
  onCutover?(projectId: string): void;
  onProgress?(progress: MigrationProgress): void;
  /** Lease renewal period (default a third of the five-minute lease). */
  readonly renewEveryMs?: number;
  /** Runs before each staging step; tests interrupt the engine through it. */
  beforeStep?(step: string, projectId: string): void | Promise<void>;
}

/** The engine stopped because it was asked to (pause). */
export class MigrationPausedError extends Error {
  constructor() {
    super('Paused.');
    this.name = 'MigrationPausedError';
  }
}

/** Staged work that must be dropped and staged again from the start. */
class RestartError extends Error {
  constructor(
    readonly reason:
      'stale' | 'device-removed' | 'unfinished-start' | 'unreadable-journal',
    message: string
  ) {
    super(message);
    this.name = 'RestartError';
  }
}

/** Abandons, restarts and lease resumes one project may take (judgment). */
const MAX_RESTARTS = 2;
const MAX_RESUMES = 3;
const MAX_STEP_CALLS = 500;

/** The Worker's refusal code, from any of the clients' error classes. */
const codeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

/** The Worker could not reach, or have confirmed by, the project's room. */
const ROOM_UNAVAILABLE = 'PROJECT_ROOM_UNAVAILABLE';

/** Plain words for what went wrong, and whether a retry may help. */
export function migrationErrorOf(error: unknown): MigrationError {
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case E2EE_MIGRATION_CODES.shared:
      return {
        code,
        retryable: false,
        message:
          'This project is shared. Encrypting shared projects is not available yet; remove its members and pending invitations first.'
      };
    case E2EE_MIGRATION_CODES.leased:
      return {
        code,
        retryable: true,
        message:
          'Another device or tab is encrypting this project. Wait for it to finish, or retry in five minutes if it was closed.'
      };
    case E2EE_MIGRATION_CODES.roomAhead:
      return {
        code,
        retryable: true,
        message:
          'This project has edits from a live session that your account has not saved yet. Open it, save it, then retry.'
      };
    case 'PROJECT_MIGRATING':
      return { code, retryable: true, message };
    case ROOM_UNAVAILABLE:
      // The room could not confirm its lock (a start: nothing was staged)
      // or its purge (after the cutover): either way, retrying helps.
      return { code, retryable: true, message };
    case 'E2EE_LOCAL_ONLY':
    case 'E2EE_BLOB_TOO_LARGE':
      return {
        code,
        retryable: false,
        message: `This project holds a file encrypted projects cannot store yet: ${message}`
      };
    case 'E2EE_KEYS_LOCKED':
    case 'E2EE_READ_ONLY_DEVICE':
    case 'E2EE_DEVICE_NOT_CERTIFIED':
      return { code, retryable: false, message };
  }
  if (error instanceof Error && error.name === 'UnstorableDocumentError') {
    return {
      code: 'E2EE_CONTENT_UNAVAILABLE',
      retryable: false,
      message
    };
  }
  const status = statusOf(error);
  if (status !== undefined) {
    return {
      ...(code ? { code } : {}),
      retryable: status >= 500 || status === 409 || status === 429,
      message
    };
  }
  return { retryable: true, message };
}

/**
 * The document with every file it names moved to its blob id: imports,
 * mesh payloads, project assets and reference pictures, in the model and
 * its undo history. The derived projection is kept as it is: the store
 * drops its geometry before sealing.
 */
export function withBlobIds(
  document: ProjectDocument,
  blobIds: ReadonlyMap<string, string>
): ProjectDocument {
  const { derived, ...content } = document;
  const rewritten = structuredClone(content) as Record<string, unknown>;
  const pending: unknown[] = [rewritten];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'artifactId' && typeof child === 'string') {
        const blobId = blobIds.get(child);
        if (blobId) (value as Record<string, unknown>)[key] = blobId;
      } else if (child && typeof child === 'object') {
        pending.push(child);
      }
    }
  }
  return { ...(rewritten as unknown as ProjectDocument), derived };
}

const documentBytes = (document: ProjectDocument) =>
  new TextEncoder().encode(JSON.stringify(document)).byteLength;

/** Projects to encrypt, oldest first (least recently changed, judgment). */
export function migratableProjects(
  projects: readonly ProjectSummary[]
): ProjectSummary[] {
  return projects
    .filter(
      (project) =>
        (project.storageFormat ?? 1) === 1 &&
        (project.organization?.status ?? 'active') !== 'deleted'
    )
    .sort(
      (a, b) =>
        a.updatedAt.localeCompare(b.updatedAt) ||
        a.projectId.localeCompare(b.projectId)
    );
}

export interface ProjectMigrationEngine {
  /**
   * Encrypts one project end to end, resuming whatever was staged. Rejects
   * with {@link MigrationPausedError} when `signal` aborts.
   */
  migrate(project: ProjectSummary, signal?: AbortSignal): Promise<void>;
  /** Drops a staging and unlocks the plaintext (the lease holder only). */
  cancel(projectId: string): Promise<void>;
}

export function createProjectMigrationEngine(
  deps: MigrationEngineDeps
): ProjectMigrationEngine {
  const { migrations, plaintext } = deps;
  const leases = deps.leases ?? memoryLeaseStore();
  let currentLease: string | null = null;
  const leased: Fetch = (input, init) =>
    currentLease
      ? withMigrationLease(deps.fetcher, currentLease)(input, init)
      : deps.fetcher(input, init);
  let clients: MigrationStagingClients | null = null;
  const staging = () => (clients ??= deps.createStaging(leased));

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
    // The staged ciphertext is gone: so is what this browser accepted of
    // it, or the next staging would read as a rollback.
    await staging().store.forgetStagedProject(projectId);
  }

  async function purgeAll(
    projectId: string,
    report: (phase: MigrationPhase) => void
  ): Promise<void> {
    report('purging');
    await stepAll(() => migrations.purge(projectId));
    report('done');
  }

  /** Starts or resumes the staging; the lease this page now holds. */
  async function acquire(
    projectId: string,
    existing: E2eeProjectMigrationRecord | null
  ): Promise<{ lease: string; migration: E2eeProjectMigrationRecord }> {
    const stored = leases.get(projectId);
    if (existing?.state !== 'staging') {
      // Nothing of this page's may stay behind in its tab: flushed first.
      await deps.flushProject?.(projectId);
    }
    const started = await migrations
      .start(
        projectId,
        { direction: 'encrypt', deviceId: deps.deviceId },
        stored
      )
      .catch((error: unknown) => {
        // The room could not confirm what it holds, so the Worker staged
        // nothing (a room's unsaved edits must not be purged): a failed
        // start the owner retries.
        if (codeOf(error) === ROOM_UNAVAILABLE) {
          throw new ApiError(
            503,
            'This project’s live session could not be locked right now, so encryption did not start and nothing changed. Retry in a moment.',
            ROOM_UNAVAILABLE
          );
        }
        throw error;
      });
    leases.set(projectId, started.leaseId);
    currentLease = started.leaseId;
    return { lease: started.leaseId, migration: started.migration };
  }

  async function migrate(
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
      bytesTotal: 0,
      // Listed as encrypted already: only its purge can remain.
      ...(project.storageFormat === 2 ? { cutOver: true } : {})
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
          // Resumed by starting again: our own lease, or a lapsed one.
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
        report({ phase: 'error', error: migrationErrorOf(error) });
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
    if (status?.state === 'cutover' || status?.state === 'purging') {
      leases.delete(projectId);
      deps.onCutover?.(projectId);
      return purgeAll(projectId, (phase) => report({ phase, cutOver: true }));
    }
    if (status?.state === 'done' && (project.storageFormat ?? 1) === 2) {
      return report({ phase: 'done' });
    }
    if (status?.state === 'abandoned' && status.purgeCursor !== null) {
      // An earlier attempt's cleanup is unfinished: finish it first.
      await stepAll(() => migrations.abandon(projectId));
    }
    report({
      phase: 'starting',
      error: undefined,
      // A staging left over (resumed, or another device's) holds it locked;
      // an abandoned one no longer does.
      plaintextLocked: status?.state === 'staging'
    });
    const { lease, migration } = await acquire(projectId, status);
    report({ plaintextLocked: true });
    const resuming = status?.state === 'staging';
    if (resuming && migration.stagedVersion === 0) {
      // A start that may have left a group without a version: nothing
      // worth keeping; dropped and staged from the start.
      throw new RestartError(
        'unfinished-start',
        'The last attempt stopped before its first version.'
      );
    }
    const renewal = renewLease(projectId, lease);
    try {
      await stage(project, migration, check, report, current);
      await check('cutover');
      report({ phase: 'cutover' });
      await migrations.cutover(projectId, lease);
    } finally {
      renewal.stop();
    }
    leases.delete(projectId);
    currentLease = null;
    deps.onCutover?.(projectId);
    await check('purge');
    await purgeAll(projectId, (phase) => report({ phase, cutOver: true }));
  }

  function renewLease(projectId: string, lease: string) {
    const every = deps.renewEveryMs ?? 100_000;
    const timer = setInterval(() => {
      // A lost lease surfaces on the next staged write, which resumes it.
      migrations.renew(projectId, lease).catch(() => undefined);
    }, every);
    return { stop: () => clearInterval(timer) };
  }

  async function stage(
    project: ProjectSummary,
    migration: E2eeProjectMigrationRecord,
    check: (step: string) => Promise<void>,
    report: (change: Partial<MigrationProgress>) => void,
    current: () => MigrationProgress
  ): Promise<void> {
    const projectId = project.projectId;
    const { store, blobs, references, measurements, viewStates } = staging();

    // The plaintext, as the lock froze it.
    await check('read');
    const head = await plaintext.loadProject(projectId);
    if (head.version !== migration.sourceVersion) {
      throw new RestartError(
        'stale',
        'The project changed after its encryption began.'
      );
    }
    // Oldest first, as the head's document lists its save states: each
    // save state's document lists the ones before it, so the signed
    // revision map keeps them all as it grows.
    const order = new Map(
      head.revisions.map((r, index) => [r.revisionId as string, index])
    );
    const revisions: RevisionSummary[] = [
      ...(await plaintext.listRevisions(projectId)).revisions
    ].sort(
      (a, b) =>
        (order.get(a.revisionId) ?? -1) - (order.get(b.revisionId) ?? -1) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.revisionId.localeCompare(b.revisionId)
    );
    const artifacts = new Map<string, ArtifactRecord>(
      (await plaintext.listArtifacts(projectId)).map((artifact) => [
        artifact.artifactId,
        artifact
      ])
    );
    const exports = [...artifacts.values()].filter((artifact) =>
      EXPORT_ARTIFACT_KINDS.has(artifact.kind)
    );
    const fileBytes = [...artifacts.values()]
      .filter(
        (artifact) =>
          artifact.kind !== 'snapshot' &&
          artifact.kind !== 'stl-import' &&
          artifact.kind !== 'mesh-import'
      )
      .reduce((total, artifact) => total + (artifact.bytes ?? 0), 0);
    let bytesDone = 0;
    report({
      phase: 'revisions',
      revisionsDone: 0,
      revisionsTotal: revisions.length,
      bytesDone,
      bytesTotal:
        revisions.reduce((total, r) => total + r.documentBytes, 0) +
        documentBytes(head) +
        fileBytes
    });
    const advance = (bytes: number, extra: Partial<MigrationProgress> = {}) => {
      bytesDone += bytes;
      report({
        bytesDone: Math.min(bytesDone, current().bytesTotal),
        ...extra
      });
    };

    // The journal: what an earlier run staged, verified.
    let stagedVersion = migration.stagedVersion;
    const staged = new Set<string>();
    if (stagedVersion > 0) {
      await check('journal');
      try {
        const map = await store.revisionMap(projectId);
        for (const revisionId of map.keys()) {
          // Opening each one hands this page its blob keys, so the dedupe
          // tags find the files it already stored.
          await store.loadRevision(projectId, revisionId);
          staged.add(revisionId);
        }
      } catch (error) {
        // A journal this browser cannot verify (signed by a device the
        // account removed since, say) is not built on: the plaintext is
        // still the source, so it is staged again from the start.
        if (
          error instanceof Error &&
          error.name === 'EncryptedProjectIntegrityError'
        ) {
          throw new RestartError('unreadable-journal', error.message);
        }
        throw error;
      }
    }

    // Files: each one stored once, named by its blob id.
    const blobIds = new Map<string, string>();
    async function storeFile(record: ArtifactRecord): Promise<string> {
      const known = blobIds.get(record.artifactId);
      if (known) return known;
      const body = await plaintext.download(record.artifactId);
      const blobId = await blobs.archive(projectId, {
        fileName: record.name,
        contentType: record.contentType,
        kind: record.kind,
        body
      });
      blobIds.set(record.artifactId, blobId);
      advance(body.size);
      return blobId;
    }
    async function encryptedDocument(
      document: ProjectDocument
    ): Promise<ProjectDocument> {
      for (const artifactId of importArtifactIds(document)) {
        if (blobIds.has(artifactId)) continue;
        await check('file');
        const record =
          artifacts.get(artifactId) ?? (await plaintext.artifact(artifactId));
        if (!record) {
          throw new ApiError(
            409,
            'This project names a file the account no longer holds. Open it and import the file again.',
            'E2EE_MIGRATION_FILE_MISSING'
          );
        }
        await storeFile(record);
      }
      return withBlobIds(document, blobIds);
    }

    const info = (): ProjectInfoBody => ({ name: head.name, exports: [] });
    /**
     * The document as staged: the first one also creates the staged group
     * and project info, under which its files are stored first.
     */
    async function stagedDocument(
      plain: ProjectDocument
    ): Promise<ProjectDocument> {
      if (stagedVersion > 0) return encryptedDocument(plain);
      const created = await store.stageMigratedProject({
        document: plain,
        info: info(),
        prepare: encryptedDocument
      });
      stagedVersion = created.document.version;
      return created.document;
    }

    // Save states, oldest first (decision M9).
    let done = 0;
    for (const revision of revisions) {
      if (staged.has(revision.revisionId)) {
        done++;
        advance(revision.documentBytes, { revisionsDone: done });
        continue;
      }
      await check('revision');
      const snapshot = await plaintext.loadRevision(
        projectId,
        revision.revisionId
      );
      // Retention dropped it since the listing: the cutover no longer
      // asks for it either.
      if (!snapshot) continue;
      const document = await stagedDocument(snapshot);
      stagedVersion = (
        await store.saveRevision({
          projectId,
          reason: revision.reason,
          expectedVersion: stagedVersion,
          document: { ...document, version: stagedVersion },
          savedRevisionId: revision.revisionId
        })
      ).version;
      staged.add(revision.revisionId);
      done++;
      advance(revision.documentBytes, { revisionsDone: done });
    }

    // The head, newer than the plaintext head it replaces.
    await check('head');
    report({ phase: 'head' });
    const document = await stagedDocument(head);
    const headVersion = Math.max(
      migration.sourceVersion + 1,
      stagedVersion + 1
    );
    await store.saveProjectDocument({
      projectId,
      expectedVersion: stagedVersion,
      document: { ...document, version: headVersion }
    });
    advance(documentBytes(head));

    // Project info: the name, the shelf picture and the archived exports.
    await check('info');
    report({ phase: 'details' });
    let thumbnail: ProjectInfoBody['thumbnail'];
    const thumbnailId = project.thumbnailArtifactId;
    if (thumbnailId) {
      const record =
        artifacts.get(thumbnailId) ?? (await plaintext.artifact(thumbnailId));
      if (record?.kind === 'thumbnail') {
        const blobId = await storeFile(record);
        thumbnail = references.get(projectId, blobId)?.reference;
      }
    }
    const entries: ProjectExportEntry[] = [];
    for (const record of exports) {
      await check('export');
      const blobId = await storeFile(record);
      const held = references.get(projectId, blobId);
      if (!held) throw new ApiError(500, 'The export was not stored.');
      entries.push({
        ref: held.reference,
        fileName: record.name,
        contentType: record.contentType,
        metadata: exportMetadata(
          {
            kind: record.kind,
            metadata: record.metadata,
            body: { size: record.bytes ?? held.reference.plaintextLength }
          } as never,
          record.createdAt
        )
      });
    }
    const body: ProjectInfoBody = {
      name: head.name,
      ...(thumbnail ? { thumbnail } : {}),
      exports: entries.slice(0, 100)
    };
    const written = await store.info.update(projectId, () => body);
    if (!written || written.name !== head.name) {
      throw new ApiError(
        409,
        'The project info could not be staged. Try again.'
      );
    }

    // Measurements and view state. A deployment without cloud measurement
    // sync keeps them on each device, and holds none to carry over.
    await check('measurements');
    const plainMeasurements = await plaintext
      .measurements(projectId)
      .catch((error: unknown) => {
        if (codeOf(error) === 'MEASUREMENT_SYNC_UNAVAILABLE') {
          return { revision: 0, record: null };
        }
        throw error;
      });
    if (plainMeasurements.record) {
      const encrypted = await measurements.loadProjectMeasurements(projectId);
      if (encrypted.revision === 0) {
        await measurements.saveProjectMeasurements({
          projectId,
          expectedRevision: 0,
          record: plainMeasurements.record
        });
      }
    }
    await check('view-state');
    const sessions = await plaintext.workspaceSessions(projectId);
    if (sessions.length) {
      const existing = new Set(
        (await viewStates.load(projectId)).map(
          (session) => `${session.sessionId} ${session.sequence}`
        )
      );
      for (const { updatedAt: _updatedAt, ...session } of sessions) {
        if (existing.has(`${session.sessionId} ${session.sequence}`)) continue;
        // Its document version stays the plaintext one it was taken at
        // (the account takes none newer while staging); the encrypted head
        // is newer, which a resume offer accepts.
        await viewStates.save(session);
      }
    }

    await check('checks');
    report({ phase: 'checking' });
    await requireCurrentDevices(projectId);
    const map = await store.revisionMap(projectId);
    const retained = (await plaintext.listRevisions(projectId)).revisions;
    const uncovered = retained.filter((r) => !map.has(r.revisionId));
    if (uncovered.length) {
      throw new ApiError(
        409,
        'Some save states could not be carried into the encrypted history. Nothing was changed; your project stays as it is.',
        E2EE_MIGRATION_CODES.revisionsIncomplete,
        { revisionIds: uncovered.map((r) => r.revisionId) }
      );
    }
  }

  /**
   * A device removed while this project was staged could read what was
   * staged, and versions it signed have no revocation cutoff here: start
   * again from the plaintext, which it never had the staged keys of.
   */
  async function requireCurrentDevices(projectId: string): Promise<void> {
    const { groups, documents } = staging();
    const userId = groups.account.userId;
    const listed = new Set(
      groups.account.list.devices.map((device) => device.deviceId)
    );
    const outsider = (deviceId: string) => !listed.has(deviceId);
    let since = 1;
    for (let page = 0; page < 64; page++) {
      const { log, more } = await documents.versions(projectId, since);
      for (const entry of log) {
        if (entry.signerUserId === userId && outsider(entry.signerDeviceId)) {
          throw new RestartError(
            'device-removed',
            'A device removed during encryption signed part of it.'
          );
        }
      }
      if (!more || !log.length) break;
      since = log.at(-1)!.documentVersion + 1;
    }
    const device = groups.device;
    if (!device) return;
    const status = await groups.sessions
      .status({ userId, deviceId: device.deviceId, projectId })
      .catch(() => null);
    for (const member of status?.members ?? []) {
      if (member.userId === userId && outsider(member.deviceId)) {
        throw new RestartError(
          'device-removed',
          'A device removed during encryption holds a key to it.'
        );
      }
    }
  }

  return {
    migrate,
    async cancel(projectId) {
      await abandonAll(projectId);
    }
  };
}
