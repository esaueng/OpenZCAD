import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { InMemoryPersistenceService } from '@openzcad/persistence';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import { api } from '../apps/web/src/lib/api';
import { desktopFetch } from '../apps/web/src/lib/desktopBridge';
import { parseCreateProjectRequest } from '../apps/web/worker/validation';

vi.mock('../apps/web/src/lib/desktopBridge', () => ({
  desktopFetch: vi.fn()
}));

const owner = toUserId('user_account');

function legacyDocument(): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Original', toUserId('user_local'))
  );
  manager.execute(
    commandFactories.renameNode({
      nodeId: manager.document.rootNodeId,
      name: 'First edit'
    })
  );
  manager.execute(
    commandFactories.renameNode({
      nodeId: manager.document.rootNodeId,
      name: 'Second edit'
    })
  );
  manager.undo();
  return {
    ...manager.document,
    schemaVersion: 14
  } as unknown as ProjectDocument;
}

describe('account adoption from an unopened device snapshot', () => {
  beforeEach(() => vi.resetAllMocks());

  it('upgrades the outgoing schema and round trips both undo and redo through account storage', async () => {
    const local = legacyDocument();
    const original = structuredClone(local);
    const store = new InMemoryPersistenceService();
    vi.mocked(desktopFetch).mockImplementation(async (input, init) => {
      expect(input).toBe('/api/projects');
      expect(init?.method).toBe('POST');
      if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
      const payload: unknown = JSON.parse(init.body);
      const request = parseCreateProjectRequest(payload);
      expect(request.document?.schemaVersion).toBe(
        PROJECT_DOCUMENT_SCHEMA_VERSION
      );
      return Response.json(await store.createProject(owner, request));
    });

    // The raw shelf snapshot reproduces the reported Worker refusal.
    expect(() =>
      parseCreateProjectRequest({ name: local.name, document: local })
    ).toThrow('Reload to update before saving a project with undo history.');
    await api.adoptProject(local);
    expect(local).toEqual(original);
    const saved = (await store.loadProject(owner, local.projectId))!;
    expect(saved.projectId).toBe(local.projectId);
    expect(saved.version).toBe(local.version);
    expect(saved.editHistory).toEqual({
      ...local.editHistory,
      actorUserId: owner
    });
    const reopened = new CommandManager(saved);
    expect(reopened.canUndo).toBe(true);
    expect(reopened.canRedo).toBe(true);
    reopened.redo();
    expect(reopened.document.name).toBe('Second edit');
    reopened.undo();
    expect(reopened.document.name).toBe('First edit');
    reopened.undo();
    expect(reopened.document.name).toBe('Original');
  });

  it('repairs history endpoints when upgrading a legacy sketch node', async () => {
    const manager = new CommandManager(
      createProjectDocument('Sketch', toUserId('user_local'))
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XY',
        offset: 2,
        object: {
          objectKind: 'rectangle',
          width: 10,
          height: 20,
          centerX: 0,
          centerY: 0
        }
      })
    );
    // Model the pre-v4 storage format in both the live node and undo snapshot.
    const local = JSON.parse(
      JSON.stringify(manager.document, (_key, value: unknown) => {
        if (
          value &&
          typeof value === 'object' &&
          'kind' in value &&
          value.kind === 'sketch'
        ) {
          const { planeRef, ...node } = value as unknown as {
            planeRef: { plane: string; offset: number };
          };
          return { ...node, plane: planeRef.plane, offset: planeRef.offset };
        }
        return value;
      })
    ) as ProjectDocument;
    Object.assign(local, { schemaVersion: 3 });
    const original = structuredClone(local);
    const store = new InMemoryPersistenceService();
    vi.mocked(desktopFetch).mockImplementation(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
      return Response.json(
        await store.createProject(
          owner,
          parseCreateProjectRequest(JSON.parse(init.body) as unknown)
        )
      );
    });
    await api.adoptProject(local);
    expect(local).toEqual(original);
    const reopened = new CommandManager(
      (await store.loadProject(owner, local.projectId))!
    );
    const sketch = Object.values(reopened.document.nodes).find(
      (node) => node.kind === 'sketch'
    );
    expect(sketch?.kind === 'sketch' && sketch.planeRef).toEqual({
      type: 'canonical',
      plane: 'XY',
      offset: 2
    });
    reopened.undo();
    expect(reopened.document.sketchOrder).toHaveLength(0);
    reopened.redo();
    expect(reopened.document.nodes[sketch!.id]).toEqual(sketch);
  });

  it('refuses future schemas and corrupt history before sending a request', () => {
    const future = {
      ...legacyDocument(),
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION + 1
    } as unknown as ProjectDocument;
    expect(() => api.adoptProject(future)).toThrow(
      'Unsupported project schema'
    );
    const corrupt = legacyDocument();
    corrupt.editHistory!.cursor = -1;
    expect(() => api.adoptProject(corrupt)).toThrow(
      'Invalid or unsupported project undo history.'
    );
    expect(desktopFetch).not.toHaveBeenCalled();
  });
});
