import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createProjectDocument } from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteLocalProject,
  listLocalProjects,
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
function traceReads(poisonedKey?: string): ReadTrace {
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
      source.addEventListener('success', settle);
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

let trace: ReadTrace | null = null;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  trace?.restore();
  trace = null;
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
