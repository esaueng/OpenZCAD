import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  addPrimitiveFeature,
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import {
  MAX_LOCAL_CHECKPOINT_DOCUMENTS,
  toBodyId,
  toProjectId,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteLocalProject,
  deleteSourceBlob,
  deleteSourceBlobIfUnreferenced,
  ensureLocalProjectStorage,
  hasSourceBlob,
  listLocalProjects,
  listLocalSaveStateIds,
  loadLocalSaveState,
  loadProjectMeasurements,
  saveProjectMeasurements,
  loadLocalProject,
  putSourceBlobIfAbsent,
  releaseSourceBlobClaim,
  saveLocalProject,
  saveLocalProjectOrganization,
  listLocalProjectOrganizations,
  listPendingOrganizationMirrors
} from './localProjectStore';

const DATABASE_NAME = 'openzcad-v2';
const DOCUMENT_STORE = 'projects';
const SUMMARY_STORE = 'projectSummaries';
const MEASUREMENT_STORE = 'projectMeasurements';
const CLAIM_STORE = 'sourceBlobClaims';
const PAST_BLOCKED_GRACE_MS = 10_000;

/** The stores this database had before the shelf projections were added. */
const LEGACY_STORES = [
  'projects',
  'projectMeta',
  'projectSync',
  'projectThumbnails'
];

function projectDocument(name: string, id: string): ProjectDocument {
  const document = createProjectDocument(name, toUserId('user-1'));
  return { ...document, projectId: toProjectId(id) };
}

/** A legacy import large enough that putting every document on the shelf path hurts. */
function largeStepImportDocument(name: string, id: string): ProjectDocument {
  const stepText = [
    'ISO-10303-21;\nDATA;\n/*',
    'STEP-PAYLOAD'.repeat(700_000),
    '*/\nENDSEC;\nEND-ISO-10303-21;'
  ].join('');
  const imported = importStepBody(projectDocument(name, id), {
    name: 'Imported assembly',
    artifactId: `artifact_${id}`,
    sourceName: `${id}.step`,
    stepText
  }).document;
  return {
    ...imported,
    derived: { ...imported.derived, updatedAt: '2026-08-06T14:30:00.000Z' }
  };
}

function embeddedStepLength(document: ProjectDocument | null): number {
  const feature = Object.values(document?.nodes ?? {}).find(
    (node) => node.kind === 'feature' && node.featureKind === 'imported-step'
  );
  if (
    !feature ||
    feature.kind !== 'feature' ||
    feature.data.featureKind !== 'imported-step'
  ) {
    return 0;
  }
  return feature.data.stepText?.length ?? 0;
}

const failed = (cause: DOMException | null) =>
  cause ?? new Error('IndexedDB request failed.');

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(failed(source.error));
  });
}

/** Opens the database as it existed at version 5, before this change. */
function openLegacyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, 5);
    open.onupgradeneeded = () => {
      for (const name of LEGACY_STORES) {
        open.result.createObjectStore(name, { keyPath: 'projectId' });
      }
      open.result.createObjectStore('sourceBlobs', {
        keyPath: 'checksumSha256'
      });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(failed(open.error));
  });
}

/** A tab predating `onversionchange`, used to pin the shared blocked fallback. */
function openBlockingLegacyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, 6);
    open.onupgradeneeded = () => {
      for (const name of [...LEGACY_STORES, SUMMARY_STORE]) {
        open.result.createObjectStore(name, { keyPath: 'projectId' });
      }
      open.result.createObjectStore('sourceBlobs', {
        keyPath: 'checksumSha256'
      });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(failed(open.error));
  });
}

/** The shipped version-7 schema, whose live connections close for upgrades. */
function openPreviousDatabase(
  onVersionChange: () => void = () => undefined
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, 7);
    open.onupgradeneeded = () => {
      for (const name of [...LEGACY_STORES, SUMMARY_STORE, MEASUREMENT_STORE]) {
        open.result.createObjectStore(name, { keyPath: 'projectId' });
      }
      open.result.createObjectStore('sourceBlobs', {
        keyPath: 'checksumSha256'
      });
    };
    open.onsuccess = () => {
      open.result.onversionchange = () => {
        onVersionChange();
        open.result.close();
      };
      resolve(open.result);
    };
    open.onerror = () => reject(failed(open.error));
  });
}

async function settleEventLoop(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Seeds documents the way a build without the projections store would have. */
async function seedLegacyDocuments(
  documents: ProjectDocument[]
): Promise<void> {
  const database = await openLegacyDatabase();
  const tx = database.transaction(DOCUMENT_STORE, 'readwrite');
  for (const document of documents) {
    tx.objectStore(DOCUMENT_STORE).put(document);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(failed(tx.error));
  });
  database.close();
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(failed(open.error));
  });
  const result = await request(
    action(database.transaction(storeName, mode).objectStore(storeName))
  );
  database.close();
  return result;
}

interface ReadTrace {
  /** Every value-returning read, as `${store}.${method}`. */
  calls: string[];
  /** Most document reads ever open at the same moment. */
  peakConcurrentDocumentReads: number;
  /** Reads that would deserialize a whole document. */
  documentReads(): string[];
  restore(): void;
}

/**
 * Records the reads the store makes, so a test can prove the start-screen path
 * never deserializes a document rather than just asserting on its output.
 */
function traceReads(
  poisonedKey?: string,
  onDocumentRead?: (key: IDBValidKey) => void
): ReadTrace {
  const prototype = IDBObjectStore.prototype;
  const original = {
    get: prototype.get,
    getAll: prototype.getAll,
    getAllKeys: prototype.getAllKeys
  };
  const trace: ReadTrace = {
    calls: [],
    peakConcurrentDocumentReads: 0,
    documentReads: () =>
      trace.calls.filter(
        (call) =>
          call === `${DOCUMENT_STORE}.get` ||
          call === `${DOCUMENT_STORE}.getAll`
      ),
    restore: () => Object.assign(prototype, original)
  };
  let openDocumentReads = 0;

  prototype.get = function (this: IDBObjectStore, key: IDBValidKey) {
    trace.calls.push(`${this.name}.get`);
    if (this.name === DOCUMENT_STORE && key === poisonedKey) {
      throw new Error('simulated unreadable document');
    }
    const source = original.get.call(this, key);
    if (this.name === DOCUMENT_STORE) {
      openDocumentReads += 1;
      trace.peakConcurrentDocumentReads = Math.max(
        trace.peakConcurrentDocumentReads,
        openDocumentReads
      );
      const settle = () => {
        openDocumentReads -= 1;
      };
      source.addEventListener('success', () => {
        settle();
        onDocumentRead?.(key);
      });
      source.addEventListener('error', settle);
    }
    return source;
  };
  prototype.getAll = function (
    this: IDBObjectStore,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number
  ) {
    trace.calls.push(`${this.name}.getAll`);
    return original.getAll.call(this, query, count);
  };
  prototype.getAllKeys = function (
    this: IDBObjectStore,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number
  ) {
    trace.calls.push(`${this.name}.getAllKeys`);
    return original.getAllKeys.call(this, query, count);
  };
  return trace;
}

/**
 * Every connection this module opens, and whether it was let go of.
 *
 * The store opens one connection per transaction and closes it when the
 * transaction ends. Nothing in the records shows whether the close happened —
 * the writes land either way — so it is counted here instead. A leak of one
 * IDBDatabase per transaction is one per autosave and one per shelf read, and
 * it stays invisible until some future schema version cannot upgrade past it.
 */
interface ConnectionTrace {
  /** Connections opened and not yet closed. */
  live(): number;
  opened(): number;
  restore(): void;
}

function traceConnections(): ConnectionTrace {
  const factory = Object.getPrototypeOf(globalThis.indexedDB) as IDBFactory;
  const originalOpen = factory.open;
  const databasePrototype = IDBDatabase.prototype;
  const originalClose = databasePrototype.close;
  const open = new Set<IDBDatabase>();
  let opened = 0;

  databasePrototype.close = function (this: IDBDatabase) {
    open.delete(this);
    return originalClose.call(this);
  };
  factory.open = function (
    this: IDBFactory,
    name: string,
    version?: number
  ): IDBOpenDBRequest {
    const request = originalOpen.call(this, name, version);
    request.addEventListener('success', () => {
      opened += 1;
      open.add(request.result);
    });
    return request;
  };

  return {
    live: () => open.size,
    opened: () => opened,
    restore: () => {
      factory.open = originalOpen;
      databasePrototype.close = originalClose;
    }
  };
}

let trace: ReadTrace | null = null;
let connections: ConnectionTrace | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.useRealTimers();
  trace?.restore();
  trace = null;
  connections?.restore();
  connections = null;
});

describe('the source-claim schema upgrade', () => {
  it('notifies and closes a version-7 tab instead of trapping startup', async () => {
    let versionChanges = 0;
    const otherTab = await openPreviousDatabase(() => {
      versionChanges += 1;
    });

    await expect(ensureLocalProjectStorage()).resolves.toBe('ready');

    expect(versionChanges).toBe(1);
    expect(
      await withStore(CLAIM_STORE, 'readonly', (store) => store.getAllKeys())
    ).toEqual([]);
    otherTab.close();
  });

  it('settles every queued caller when an older tab blocks the upgrade', async () => {
    const otherTab = await openBlockingLegacyDatabase();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const readiness = ensureLocalProjectStorage();
    const listingError = listLocalProjects().then(
      () => null,
      (error: unknown) => error
    );
    await settleEventLoop();
    vi.advanceTimersByTime(PAST_BLOCKED_GRACE_MS);

    expect(await readiness).toBe('blocked');
    expect(await listingError).toMatchObject({
      name: 'LocalStorageBlockedError'
    });

    otherTab.close();
    vi.useRealTimers();
    await settleEventLoop();
    expect(await ensureLocalProjectStorage()).toBe('ready');
    expect(
      await withStore(CLAIM_STORE, 'readonly', (store) => store.getAllKeys())
    ).toEqual([]);
  });
});

describe('reading a source blob for storage', () => {
  const text = 'ISO-10303-21; /* watched while it is read */';

  /**
   * The read is streamed only so the import can report it. The checksum is
   * the store's whole contract, so the streamed path has to agree with the
   * buffered one byte for byte — a mismatch here would file the same bytes
   * under two identities and break every reference to them.
   */
  it('hashes a watched read identically to an unwatched one', async () => {
    const unwatched = await putSourceBlobIfAbsent(new Blob([text]));
    const watched = await putSourceBlobIfAbsent(new Blob([text]), {
      onBytesRead: () => {}
    });
    expect(watched.ref.checksumSha256).toBe(unwatched.ref.checksumSha256);
    expect(watched.ref.logicalBytes).toBe(unwatched.ref.logicalBytes);
  });

  it('reports bytes as they arrive, finishing at the whole file', async () => {
    const reported: [number, number][] = [];
    const stored = await putSourceBlobIfAbsent(new Blob([text]), {
      onBytesRead: (read, total) => reported.push([read, total])
    });
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.at(-1)).toEqual([
      stored.ref.logicalBytes,
      stored.ref.logicalBytes
    ]);
    // Monotonic, and never past the total.
    for (const [read, total] of reported) {
      expect(read).toBeLessThanOrEqual(total);
    }
  });

  /**
   * The plain objects tests use as files, and any engine without `stream()`,
   * must still store. Progress is presentation; the bytes are not.
   */
  it('stores from a source that cannot be streamed', async () => {
    const bytes = new TextEncoder().encode(text);
    const unstreamable = {
      size: bytes.byteLength,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0))
    } as unknown as Blob;
    const stored = await putSourceBlobIfAbsent(unstreamable, {
      onBytesRead: () => {
        throw new Error('nothing to report without a stream');
      }
    });
    expect(stored.ref.checksumSha256).toBe(
      (await putSourceBlobIfAbsent(new Blob([text]))).ref.checksumSha256
    );
  });
});

describe('a cancelled source read', () => {
  const text = 'ISO-10303-21; /* stopped part way */';

  it('writes nothing when cancelled before it starts', async () => {
    // Settle the schema first, so the assertion below reads an empty claim
    // store rather than failing on a database the abort never opened.
    expect(await ensureLocalProjectStorage()).toBe('ready');
    const controller = new AbortController();
    controller.abort();
    await expect(
      putSourceBlobIfAbsent(new Blob([text]), {
        claimId: 'tab-a',
        signal: controller.signal
      })
    ).rejects.toThrow();
    // Neither the bytes nor the claim: the record and the claim are written in
    // one transaction after the whole blob has been read and hashed, so an
    // abort has nothing to undo.
    expect(
      await withStore(CLAIM_STORE, 'readonly', (store) => store.getAllKeys())
    ).toEqual([]);
  });

  it('still stores normally when its signal is never aborted', async () => {
    const controller = new AbortController();
    const stored = await putSourceBlobIfAbsent(new Blob([text]), {
      claimId: 'tab-a',
      signal: controller.signal
    });
    expect(await hasSourceBlob(stored.ref.checksumSha256)).toBe(true);
  });
});

describe('device-wide source blob claims', () => {
  const source = new TextEncoder().encode(
    'ISO-10303-21; /* one file shared across tabs */'
  );

  it('writes every tab claim atomically even when the blob already exists', async () => {
    const first = await putSourceBlobIfAbsent(source, { claimId: 'tab-a' });
    const second = await putSourceBlobIfAbsent(source, { claimId: 'tab-b' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(
      await withStore(CLAIM_STORE, 'readonly', (store) => store.getAllKeys())
    ).toEqual([
      `${first.ref.checksumSha256}:tab-a`,
      `${first.ref.checksumSha256}:tab-b`
    ]);
  });

  it('keeps bytes while another tab has a live claim', async () => {
    const stored = await putSourceBlobIfAbsent(source, { claimId: 'tab-a' });
    await putSourceBlobIfAbsent(source, { claimId: 'tab-b' });

    await expect(
      deleteSourceBlobIfUnreferenced({
        checksumSha256: stored.ref.checksumSha256,
        claimId: 'tab-a'
      })
    ).resolves.toBe(false);
    expect(await hasSourceBlob(stored.ref.checksumSha256)).toBe(true);

    await releaseSourceBlobClaim(stored.ref.checksumSha256, 'tab-b');
    await expect(
      deleteSourceBlobIfUnreferenced({
        checksumSha256: stored.ref.checksumSha256,
        claimId: 'tab-a'
      })
    ).resolves.toBe(true);
    expect(await hasSourceBlob(stored.ref.checksumSha256)).toBe(false);
  });

  it('keeps bytes referenced by any saved project, not only the open tab', async () => {
    const stored = await putSourceBlobIfAbsent(source, { claimId: 'tab-a' });
    const imported = importStepBody(projectDocument('Other tab', 'proj-b'), {
      name: 'Shared frame',
      artifactId: 'artifact_local_shared',
      sourceName: 'frame.step',
      stepSourceRef: stored.ref
    }).document;
    await saveLocalProject(imported);

    await expect(
      deleteSourceBlobIfUnreferenced({
        checksumSha256: stored.ref.checksumSha256,
        claimId: 'tab-a'
      })
    ).resolves.toBe(false);
    expect(await hasSourceBlob(stored.ref.checksumSha256)).toBe(true);

    await releaseSourceBlobClaim(stored.ref.checksumSha256, 'tab-a');
    await deleteLocalProject(imported.projectId);
    await expect(
      deleteSourceBlobIfUnreferenced({
        checksumSha256: stored.ref.checksumSha256
      })
    ).resolves.toBe(true);
  });

  it('sweeps a lapsed claim before reclaiming genuinely abandoned bytes', async () => {
    const stored = await putSourceBlobIfAbsent(source, {
      claimId: 'closed-tab'
    });
    const afterClaimLapses = Date.now() + 25 * 60 * 60 * 1000;

    await expect(
      deleteSourceBlobIfUnreferenced({
        checksumSha256: stored.ref.checksumSha256,
        now: afterClaimLapses
      })
    ).resolves.toBe(true);
    expect(await hasSourceBlob(stored.ref.checksumSha256)).toBe(false);
    expect(
      await withStore(CLAIM_STORE, 'readonly', (store) => store.getAllKeys())
    ).toEqual([]);
  });
});

/**
 * Two claims the code makes about its transactions that the records left behind
 * cannot show: a failed one is rolled back rather than half applied, and every
 * one of them gives its connection back.
 */
describe('what a transaction leaves behind', () => {
  /**
   * A document `summarizeProjectDocument` cannot project. `saveLocalProject`
   * issues the document write FIRST and then derives the projection, so this
   * throws out of the action with a write already in the transaction — the one
   * failure shape IndexedDB does not abort on by itself, since no request
   * errored.
   */
  function unsummarizable(name: string, id: string): ProjectDocument {
    const document = projectDocument(name, id);
    return { ...document, checkpoints: undefined as unknown as [] };
  }

  it('rolls back the writes of a transaction that could not finish', async () => {
    // Without the abort, the document write commits on behalf of a save that
    // failed: the stored document is replaced by one the shelf cannot project,
    // while the projection still describes the version that is no longer there.
    // That disagreement is exactly what putting the two in one transaction is
    // for, and it is invisible on the successful path.
    await saveLocalProject(projectDocument('Bracket', 'proj-a'));

    await expect(
      saveLocalProject(unsummarizable('Renamed', 'proj-a'))
    ).rejects.toThrow();

    expect((await loadLocalProject('proj-a'))?.name).toBe('Bracket');
    expect((await listLocalProjects()).map((project) => project.name)).toEqual([
      'Bracket'
    ]);
  });

  it('gives every connection back, on the paths that fail as well', async () => {
    connections = traceConnections();

    expect(await ensureLocalProjectStorage()).toBe('ready');
    const stored = await putSourceBlobIfAbsent(
      new TextEncoder().encode('ISO-10303-21; /* accounted for */')
    );
    await saveLocalProject(projectDocument('Bracket', 'proj-a'));
    await listLocalProjects();
    await loadLocalProject('proj-a');
    await deleteSourceBlob(stored.ref.checksumSha256);
    await expect(
      saveLocalProject(unsummarizable('Renamed', 'proj-a'))
    ).rejects.toThrow();

    // One per transaction, which is the design; none of them still held, which
    // is the property. A leak here is one connection per autosave and one per
    // shelf read, growing for the life of the tab.
    expect(connections.opened()).toBeGreaterThan(5);
    expect(connections.live()).toBe(0);
  });
});

describe('listLocalProjects', () => {
  it('builds the shelf without reading a single document', async () => {
    await saveLocalProject(projectDocument('Bracket', 'proj-a'));
    await saveLocalProject(projectDocument('Housing', 'proj-b'));

    trace = traceReads();
    const projects = await listLocalProjects();

    expect(trace.documentReads()).toEqual([]);
    expect(projects.map((project) => project.name)).toEqual([
      'Bracket',
      'Housing'
    ]);
  });

  it('reports the same fields the documents carry', async () => {
    const document = projectDocument('Bracket', 'proj-a');
    await saveLocalProject(document);

    const [project] = await listLocalProjects();

    expect(project).toMatchObject({
      projectId: 'proj-a',
      name: 'Bracket',
      lastRevisionId: document.revisions.at(-1)?.revisionId,
      updatedAt: document.derived.updatedAt,
      revisionCount: document.checkpoints.length,
      documentVersion: document.version
    });
  });

  it('follows the document when it is saved again', async () => {
    const first = projectDocument('Bracket', 'proj-a');
    await saveLocalProject(first);
    await saveLocalProject({
      ...first,
      name: 'Bracket v2',
      version: 7,
      derived: { ...first.derived, updatedAt: '2026-08-06T12:00:00.000Z' }
    });

    const [project] = await listLocalProjects();

    expect(project).toMatchObject({
      name: 'Bracket v2',
      documentVersion: 7,
      updatedAt: '2026-08-06T12:00:00.000Z'
    });
  });

  it('keeps device shelf state out of the stored projection', async () => {
    await saveLocalProject(projectDocument('Bracket', 'proj-a'));
    await saveLocalProjectOrganization('proj-a', {
      status: 'archived',
      pinned: true,
      sortOrder: 3
    });

    const stored = await withStore(
      SUMMARY_STORE,
      'readonly',
      (store) =>
        store.get('proj-a') as IDBRequest<Record<string, unknown> | undefined>
    );
    const [project] = await listLocalProjects();

    expect(stored).not.toHaveProperty('organization');
    expect(project?.organization).toEqual({
      status: 'archived',
      pinned: true,
      sortOrder: 3
    });
  });

  it('tracks which shelf changes have not reached the account', async () => {
    await saveLocalProjectOrganization(
      'proj-a',
      { status: 'deleted', pinned: false, sortOrder: 1 },
      { mirrorPending: true }
    );
    await saveLocalProjectOrganization('proj-b', {
      status: 'archived',
      pinned: true,
      sortOrder: 2
    });

    expect([...(await listPendingOrganizationMirrors())]).toEqual(['proj-a']);
    // The flag is bookkeeping, not shelf state: readers never see it.
    expect((await listLocalProjectOrganizations()).get('proj-a')).toEqual({
      status: 'deleted',
      pinned: false,
      sortOrder: 1
    });

    await saveLocalProjectOrganization('proj-a', {
      status: 'deleted',
      pinned: false,
      sortOrder: 1
    });

    expect((await listPendingOrganizationMirrors()).size).toBe(0);
  });

  it('leaves organization undefined when the device has never organised it', async () => {
    await saveLocalProject(projectDocument('Bracket', 'proj-a'));

    const [project] = await listLocalProjects();

    expect(project?.organization).toBeUndefined();
  });
});

describe('backfilling projections for documents saved before this store', () => {
  it('reads the legacy documents one at a time and never in bulk', async () => {
    await seedLegacyDocuments([
      projectDocument('Bracket', 'proj-a'),
      projectDocument('Housing', 'proj-b'),
      projectDocument('Plate', 'proj-c')
    ]);

    trace = traceReads();
    const projects = await listLocalProjects();

    expect(projects.map((project) => project.name)).toEqual([
      'Bracket',
      'Housing',
      'Plate'
    ]);
    expect(trace.calls).not.toContain(`${DOCUMENT_STORE}.getAll`);
    expect(trace.documentReads()).toHaveLength(3);
    expect(trace.peakConcurrentDocumentReads).toBe(1);
  });

  it('does not read the documents again on the next refresh', async () => {
    await seedLegacyDocuments([
      projectDocument('Bracket', 'proj-a'),
      projectDocument('Housing', 'proj-b')
    ]);
    await listLocalProjects();

    trace = traceReads();
    const projects = await listLocalProjects();

    expect(trace.documentReads()).toEqual([]);
    expect(projects).toHaveLength(2);
  });

  it('preserves a large embedded STEP project and keeps it off later shelf reads', async () => {
    const imported = largeStepImportDocument('Imported turbine', 'proj-step');
    const stepLength = embeddedStepLength(imported);
    await seedLegacyDocuments([
      imported,
      projectDocument('Small bracket', 'proj-small')
    ]);

    trace = traceReads();
    const firstShelf = await listLocalProjects();

    expect(firstShelf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: 'proj-step',
          name: 'Imported turbine',
          updatedAt: '2026-08-06T14:30:00.000Z'
        })
      ])
    );
    expect(trace.calls).not.toContain(`${DOCUMENT_STORE}.getAll`);
    expect(trace.peakConcurrentDocumentReads).toBe(1);

    trace.restore();
    const restored = await loadLocalProject('proj-step');
    expect(stepLength).toBeGreaterThan(8 * 1024 * 1024);
    expect(embeddedStepLength(restored)).toBe(stepLength);

    trace = traceReads();
    const warmShelf = await listLocalProjects();
    expect(warmShelf).toHaveLength(2);
    expect(trace.documentReads()).toEqual([]);
  });

  it('cannot replace a newer cross-tab save with a stale backfill summary', async () => {
    const original = projectDocument('Bracket', 'proj-a');
    const updated = {
      ...original,
      name: 'Bracket renamed elsewhere',
      version: original.version + 1,
      derived: { ...original.derived, updatedAt: '2026-08-06T15:00:00.000Z' }
    };
    await seedLegacyDocuments([original]);

    let concurrentSave: Promise<void> | undefined;
    trace = traceReads(undefined, (key) => {
      if (key === 'proj-a' && !concurrentSave) {
        concurrentSave = saveLocalProject(updated);
      }
    });
    await listLocalProjects();
    await concurrentSave;
    trace.restore();
    trace = null;

    expect(await listLocalProjects()).toEqual([
      expect.objectContaining({
        name: 'Bracket renamed elsewhere',
        documentVersion: updated.version,
        updatedAt: '2026-08-06T15:00:00.000Z'
      })
    ]);
  });

  it('skips a document it cannot read instead of emptying the shelf', async () => {
    await seedLegacyDocuments([
      projectDocument('Bracket', 'proj-a'),
      projectDocument('Housing', 'proj-b')
    ]);

    trace = traceReads('proj-a');
    const projects = await listLocalProjects();

    expect(projects.map((project) => project.name)).toEqual(['Housing']);
  });

  it('retries a document that failed to backfill', async () => {
    await seedLegacyDocuments([
      projectDocument('Bracket', 'proj-a'),
      projectDocument('Housing', 'proj-b')
    ]);
    const failing = traceReads('proj-a');
    await listLocalProjects();
    failing.restore();

    const projects = await listLocalProjects();

    expect(projects.map((project) => project.name)).toEqual([
      'Bracket',
      'Housing'
    ]);
  });
});

describe('deleteLocalProject', () => {
  it('destroys the projection with the document', async () => {
    await saveLocalProject(projectDocument('Bracket', 'proj-a'));
    await saveLocalProject(projectDocument('Housing', 'proj-b'));

    await deleteLocalProject('proj-a');

    const remaining = await withStore(SUMMARY_STORE, 'readonly', (store) =>
      store.getAllKeys()
    );
    expect(remaining).toEqual(['proj-b']);
    expect((await listLocalProjects()).map((project) => project.name)).toEqual([
      'Housing'
    ]);
  });

  it('ignores a projection whose document is gone', async () => {
    await saveLocalProject(projectDocument('Bracket', 'proj-a'));
    await withStore(DOCUMENT_STORE, 'readwrite', (store) =>
      store.delete('proj-a')
    );

    expect(await listLocalProjects()).toEqual([]);
  });
});

describe('project measurements', () => {
  const projectId = 'project_measured';

  function record(count: number) {
    return {
      projectId,
      version: 1,
      updatedAt: '2026-08-07T00:00:00Z',
      display: {
        unit: 'mm' as const,
        precision: 2,
        radialDisplay: 'diameter' as const
      },
      measurements: Array.from({ length: count }, (_, index) => ({
        id: `edge:${index}`,
        kind: 'edge-length' as const,
        label: `Edge ${index}`,
        targets: [],
        result: { value: index + 1, dimension: 'length' as const },
        quality: 'exact-kernel' as const,
        status: 'current' as const,
        sourceRevision: 1,
        sourceUnit: 'mm' as const,
        visible: true
      }))
    };
  }

  it('round-trips a record through its own store', async () => {
    await saveProjectMeasurements(record(2));
    const loaded = await loadProjectMeasurements(projectId);
    expect(loaded?.measurements).toHaveLength(2);
    expect(loaded?.display.unit).toBe('mm');
  });

  it('answers null for a project that has never been measured', async () => {
    expect(await loadProjectMeasurements('project_never')).toBeNull();
  });

  it('refuses an unreadable record without calling it missing', async () => {
    const future = { ...record(2), version: 2, futureField: 'keep me' };
    expect(await ensureLocalProjectStorage()).toBe('ready');
    await withStore(MEASUREMENT_STORE, 'readwrite', (store) =>
      store.put(future)
    );

    await expect(loadProjectMeasurements(projectId)).rejects.toThrow(
      /unsupported or malformed/
    );
    expect(
      await withStore<Record<string, unknown>>(
        MEASUREMENT_STORE,
        'readonly',
        (store) => store.get(projectId) as IDBRequest<Record<string, unknown>>
      )
    ).toEqual(future);
  });

  it('replaces rather than appending on a second write', async () => {
    await saveProjectMeasurements(record(3));
    await saveProjectMeasurements(record(1));
    expect(
      (await loadProjectMeasurements(projectId))?.measurements
    ).toHaveLength(1);
  });

  it('is deleted with its project', async () => {
    // The orphan hazard, and it is not merely untidy: `adoptProjectDocument`
    // reuses a project id, so a record left behind would surface under a
    // DIFFERENT project that later claimed the same id — someone else's
    // measurements appearing on your part.
    let document = createProjectDocument('Measured', toUserId('user_m'));
    document = { ...document, projectId: toProjectId(projectId) };
    await saveLocalProject(document);
    await saveProjectMeasurements(record(2));
    expect(await loadProjectMeasurements(projectId)).not.toBeNull();

    await deleteLocalProject(projectId);
    expect(await loadProjectMeasurements(projectId)).toBeNull();
  });
});

describe('save states on the device', () => {
  /** A document sitting exactly on a save point, as an explicit save leaves it. */
  function savedDocument(
    name: string,
    id: string,
    reason: string
  ): ProjectDocument {
    return createCheckpoint(projectDocument(name, id), reason);
  }

  it('keeps the model of each save, and gives it back', async () => {
    const first = savedDocument('Bracket', 'proj-a', 'First save');
    await saveLocalProject(first);
    const boxed = appendRevision(
      addPrimitiveFeature(first, {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, depth: 10, height: 10 }
      }),
      'Added box'
    );
    const second = createCheckpoint(boxed, 'Second save');
    await saveLocalProject(second);

    const restored = await loadLocalSaveState(
      'proj-a',
      first.checkpoints.at(-1)!.checkpointId
    );
    // The first save's model, not the current one — that is the whole point.
    expect(restored?.featureOrder).toEqual([]);
    expect(second.featureOrder).toHaveLength(1);
    expect(await listLocalSaveStateIds('proj-a')).toEqual(
      new Set([
        first.checkpoints.at(-1)!.checkpointId,
        second.checkpoints.at(-1)!.checkpointId
      ])
    );
  });

  it('stores nothing extra for an autosave between saves', async () => {
    const saved = savedDocument('Bracket', 'proj-a', 'First save');
    await saveLocalProject(saved);
    // An ordinary edit: same checkpoint list, a version further on. Writing a
    // snapshot body here would mean one per 450ms of modelling.
    const edited = appendRevision(
      addPrimitiveFeature(saved, {
        name: 'Sphere',
        primitiveKind: 'sphere',
        dimensions: { radius: 3 }
      }),
      'Added sphere'
    );
    await saveLocalProject(edited);

    expect(await listLocalSaveStateIds('proj-a')).toEqual(
      new Set([saved.checkpoints.at(-1)!.checkpointId])
    );
  });

  it('does not keep the meshes, which the kernel rebuilds anyway', async () => {
    const saved = createCheckpoint(
      {
        ...projectDocument('Bracket', 'proj-a'),
        derived: {
          bodyRepresentations: {
            [toBodyId('body_1')]: { bodyId: toBodyId('body_1') }
          },
          exportableBodyIds: [toBodyId('body_1')],
          warnings: ['kept'],
          updatedAt: '2026-08-06T14:30:00.000Z'
        } as unknown as ProjectDocument['derived']
      },
      'First save'
    );
    await saveLocalProject(saved);

    const restored = await loadLocalSaveState(
      'proj-a',
      saved.checkpoints.at(-1)!.checkpointId
    );
    expect(restored?.derived.bodyRepresentations).toEqual({});
    expect(restored?.derived.exportableBodyIds).toEqual([]);
    // Conclusions about the document survive; geometry does not.
    expect(restored?.derived.warnings).toEqual(['kept']);
  });

  it('keeps the newest saves and drops the oldest past the bound', async () => {
    let document = projectDocument('Busy', 'proj-a');
    const reasons: string[] = [];
    for (let save = 0; save < MAX_LOCAL_CHECKPOINT_DOCUMENTS + 4; save += 1) {
      const reason = `Save ${save}`;
      reasons.push(reason);
      document = createCheckpoint(
        appendRevision(document, `Edit ${save}`),
        reason
      );
      await saveLocalProject(document);
    }

    const stored = await listLocalSaveStateIds('proj-a');
    expect(stored.size).toBe(MAX_LOCAL_CHECKPOINT_DOCUMENTS);
    const kept = document.checkpoints.filter((checkpoint) =>
      stored.has(checkpoint.checkpointId)
    );
    // Exactly the tail: history is most useful nearest the present, and the
    // account keeps a longer run of it for the rest.
    expect(kept.map((checkpoint) => checkpoint.reason)).toEqual(
      reasons.slice(-MAX_LOCAL_CHECKPOINT_DOCUMENTS)
    );
  });

  it('reports a save this device never had, rather than inventing one', async () => {
    await saveLocalProject(projectDocument('Bracket', 'proj-a'));

    expect(
      await loadLocalSaveState('proj-a', 'checkpoint_elsewhere')
    ).toBeNull();
  });

  it('takes a project’s save states with the project when it is deleted', async () => {
    const saved = savedDocument('Bracket', 'proj-a', 'First save');
    await saveLocalProject(saved);
    await deleteLocalProject('proj-a');

    // Project ids are reused by adoption, so a survivor would surface as some
    // other project's history.
    expect(await listLocalSaveStateIds('proj-a')).toEqual(new Set());
  });

  it('keeps one project’s save states out of another’s', async () => {
    const bracket = savedDocument('Bracket', 'proj-a', 'Bracket save');
    const flange = savedDocument('Flange', 'proj-b', 'Flange save');
    await saveLocalProject(bracket);
    await saveLocalProject(flange);
    await deleteLocalProject('proj-a');

    expect(await listLocalSaveStateIds('proj-b')).toEqual(
      new Set([flange.checkpoints.at(-1)!.checkpointId])
    );
  });

  it('opens a database from before the store existed, and fills it from the next save', async () => {
    const legacy = await openLegacyDatabase();
    legacy.close();

    // Older saves were never kept on this device and cannot be invented, so
    // the upgraded database starts empty and earns its rows from here on.
    expect(await ensureLocalProjectStorage()).toBe('ready');
    expect(await listLocalSaveStateIds('proj-a')).toEqual(new Set());
    const saved = savedDocument('Bracket', 'proj-a', 'First save');
    await saveLocalProject(saved);
    expect(await listLocalSaveStateIds('proj-a')).toEqual(
      new Set([saved.checkpoints.at(-1)!.checkpointId])
    );
  });
});
