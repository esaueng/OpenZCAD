import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteLocalProject,
  deleteSourceBlob,
  ensureLocalProjectStorage,
  listLocalProjects,
  loadLocalProject,
  putSourceBlobIfAbsent,
  saveLocalProject,
  saveLocalProjectOrganization
} from './localProjectStore';

const DATABASE_NAME = 'openzcad-v2';
const DOCUMENT_STORE = 'projects';
const SUMMARY_STORE = 'projectSummaries';

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
  trace?.restore();
  trace = null;
  connections?.restore();
  connections = null;
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
