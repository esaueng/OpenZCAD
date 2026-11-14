import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  createSavedRevision,
  listNodesByKind,
  setNodeMetadata,
  setParameter,
  UnstorableDocumentError
} from '@openzcad/document-core';
import {
  toProjectId,
  toUserId,
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';
import {
  listLocalProjects,
  loadLocalProject,
  loadLocalSaveState,
  saveImportedProject,
  saveLocalProject,
  saveLocalSaveStates
} from './localProjectStore';
import { importProjectCopy, parseProjectBackup } from './projectBackup';
import type { ProjectBackupWorkerResult } from '../worker/projectBackupWorker';
import {
  LOCAL_PROJECT_CHECKPOINT_STORE,
  LOCAL_PROJECT_DATABASE_NAME,
  LOCAL_PROJECT_DOCUMENT_STORE
} from './localProjectSchema';

const owner = toUserId('user_reserved_names');

function boxProject(id = 'proj_reserved_names'): ProjectDocument {
  const document = addPrimitiveFeature(
    createProjectDocument('Reserved names', owner),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    }
  );
  return { ...document, projectId: toProjectId(id) };
}

/**
 * The project as `JSON.parse` returns it from a backup or a device copy, with
 * its body id renamed everywhere. Rewriting the text keeps `__proto__` an own
 * key, as a parsed file would have it.
 */
function withBodyId(document: ProjectDocument, id: string): ProjectDocument {
  const bodyId = document.bodyOrder[0]!;
  return JSON.parse(
    JSON.stringify(document).replaceAll(
      JSON.stringify(bodyId),
      JSON.stringify(id)
    )
  ) as ProjectDocument;
}

/** The project with a parameter named `name`, which `setParameter` refuses. */
function withParameterName(
  document: ProjectDocument,
  name: string
): ProjectDocument {
  const placeholder = 'reservedNamePlaceholder';
  const withParameter = setParameter(document, {
    name: placeholder,
    expression: '4 mm'
  });
  expect(listNodesByKind(withParameter, 'parameter')).toHaveLength(1);
  return JSON.parse(
    JSON.stringify(withParameter).replaceAll(
      JSON.stringify(placeholder),
      JSON.stringify(name)
    )
  ) as ProjectDocument;
}

/** The project as received, with its primitive's kind replaced. */
function withPrimitiveKind(
  document: ProjectDocument,
  kind: string
): ProjectDocument {
  return JSON.parse(
    JSON.stringify(document).replaceAll(
      '"primitiveKind":"box"',
      `"primitiveKind":${JSON.stringify(kind)}`
    )
  ) as ProjectDocument;
}

/** The project with metadata `role: "constructor"` on its active part. */
function withMetadataRole(document: ProjectDocument): ProjectDocument {
  return setNodeMetadata(document, {
    nodeId: document.activePartId,
    metadata: { role: 'constructor' }
  });
}

const FORGED = [
  ['a body id "__proto__"', (d: ProjectDocument) => withBodyId(d, '__proto__')],
  [
    'a body id "constructor"',
    (d: ProjectDocument) => withBodyId(d, 'constructor')
  ],
  [
    'a parameter named "constructor"',
    (d: ProjectDocument) => withParameterName(d, 'constructor')
  ]
] as const;

function backupText(
  document: ProjectDocument,
  saveStates: { checkpointId: string; document: ProjectDocument }[] = []
): string {
  return JSON.stringify({
    format: 'openzcad-project',
    version: 1,
    document,
    files: [],
    ...(saveStates.length ? { saveStates } : {})
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('backup import refuses reserved names', () => {
  /** The whole worker path: read the file, parse, validate, make the copy. */
  async function importInWorker(
    text: string,
    ownerUserId: UserId = owner
  ): Promise<ProjectBackupWorkerResult> {
    const postMessage = vi.fn();
    const scope: {
      postMessage: typeof postMessage;
      onmessage?: (event: MessageEvent) => Promise<void>;
    } = { postMessage };
    vi.stubGlobal('self', scope);
    await import('../worker/projectBackupWorker');
    await scope.onmessage!({
      data: { file: new NodeFile([text], 'project.openzcad'), ownerUserId }
    } as MessageEvent);
    expect(postMessage).toHaveBeenCalledOnce();
    return postMessage.mock.calls[0]![0] as ProjectBackupWorkerResult;
  }

  it('still imports an ordinary backup', async () => {
    const result = await importInWorker(backupText(boxProject()));
    expect(result.ok).toBe(true);
  });

  it.each(FORGED)('refuses %s anywhere in the project', async (_, forge) => {
    const text = backupText(forge(boxProject()));
    await expect(parseProjectBackup(text)).rejects.toBeInstanceOf(
      UnstorableDocumentError
    );
    const result = await importInWorker(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/reserved/);
    // Nothing reached Object.prototype on the way.
    expect(Object.prototype).not.toHaveProperty('bodyId');
  });

  it('refuses a save state that uses a reserved name', async () => {
    const saved = createSavedRevision(boxProject(), 'Point');
    const checkpointId = saved.checkpoints.at(-1)!.checkpointId;
    const result = await importInWorker(
      backupText(saved, [
        { checkpointId, document: withParameterName(saved, 'toString') }
      ])
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(
      /reserved parameter name "toString"/
    );
  });

  it('refuses a primitive kind outside its union', async () => {
    const text = backupText(withPrimitiveKind(boxProject(), '__proto__'));
    await expect(parseProjectBackup(text)).rejects.toBeInstanceOf(
      UnstorableDocumentError
    );
    const result = await importInWorker(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(
      /primitiveKind" has the unknown value "__proto__"/
    );
  });

  it('imports a project whose metadata uses a reserved name as a value', async () => {
    const result = await importInWorker(
      backupText(withMetadataRole(boxProject()))
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a backup handed to the copy step without parsing', () => {
    const backup = {
      format: 'openzcad-project',
      version: 1,
      document: withBodyId(boxProject(), '__proto__'),
      files: []
    } as unknown as Parameters<typeof importProjectCopy>[0];
    expect(() => importProjectCopy(backup, owner)).toThrow(
      UnstorableDocumentError
    );
  });
});

describe('device copies with reserved names', () => {
  /** A copy written by something other than this store's checked writes. */
  async function seedRaw(storeName: string, value: unknown): Promise<void> {
    await saveLocalProject(boxProject('proj_seed_schema'));
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(LOCAL_PROJECT_DATABASE_NAME);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('open failed'));
    });
    const tx = database.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('write failed'));
    });
    database.close();
  }

  it.each(FORGED)(
    'will not open a stored project with %s, and the shelf still loads',
    async (_, forge) => {
      await saveLocalProject(boxProject('proj_good'));
      const forged = forge(boxProject('proj_forged'));
      await seedRaw(LOCAL_PROJECT_DOCUMENT_STORE, forged);

      const opening = loadLocalProject('proj_forged');
      await expect(opening).rejects.toBeInstanceOf(UnstorableDocumentError);
      await expect(loadLocalProject('proj_forged')).rejects.toThrow(
        /This project on this device cannot be opened: .*reserved/
      );
      expect((await loadLocalProject('proj_good'))?.projectId).toBe(
        'proj_good'
      );
      const shelf = (await listLocalProjects()).map((p) => p.projectId);
      expect(shelf).toEqual(expect.arrayContaining(['proj_good']));
    }
  );

  it.each(FORGED)('will not save a project with %s', async (_, forge) => {
    await expect(
      saveLocalProject(forge(boxProject('proj_forged')))
    ).rejects.toThrow(/cannot be saved: .*reserved/);
    expect(await loadLocalProject('proj_forged')).toBeNull();
  });

  it('will not open or save a save state with a reserved name', async () => {
    const saved = createSavedRevision(boxProject('proj_points'), 'Point');
    const checkpoint = saved.checkpoints.at(-1)!;
    const forged = withParameterName(saved, 'valueOf');
    await expect(saveLocalSaveStates([forged])).rejects.toThrow(
      /cannot be saved: .*reserved parameter name "valueOf"/
    );
    await seedRaw(LOCAL_PROJECT_CHECKPOINT_STORE, {
      ...checkpoint,
      projectId: saved.projectId,
      document: forged
    });
    await expect(
      loadLocalSaveState(saved.projectId, checkpoint.checkpointId)
    ).rejects.toThrow(/cannot be opened: .*reserved/);
  });

  it('will not open or save a project with a primitive kind outside its union', async () => {
    const forged = withPrimitiveKind(boxProject('proj_forged'), 'constructor');
    await seedRaw(LOCAL_PROJECT_DOCUMENT_STORE, forged);
    await expect(loadLocalProject('proj_forged')).rejects.toThrow(
      /cannot be opened: .*primitiveKind" has the unknown value "constructor"/
    );
    await expect(saveLocalProject(forged)).rejects.toThrow(
      /cannot be saved: .*primitiveKind" has the unknown value/
    );
  });

  it('opens and saves a project whose metadata uses a reserved name as a value', async () => {
    const project = withMetadataRole(boxProject('proj_metadata'));
    await seedRaw(LOCAL_PROJECT_DOCUMENT_STORE, project);
    expect((await loadLocalProject('proj_metadata'))?.projectId).toBe(
      'proj_metadata'
    );
    await expect(saveLocalProject(project)).resolves.not.toThrow();
  });

  it('will not store an imported project with a reserved name', async () => {
    const backup = {
      format: 'openzcad-project',
      version: 1,
      document: withBodyId(boxProject('proj_imported'), '__proto__'),
      files: []
    } as unknown as Parameters<typeof saveImportedProject>[0];
    await expect(saveImportedProject(backup)).rejects.toThrow(
      UnstorableDocumentError
    );
    expect(await loadLocalProject('proj_imported')).toBeNull();
  });
});
