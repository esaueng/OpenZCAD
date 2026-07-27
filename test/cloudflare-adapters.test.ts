import { describe, expect, it } from 'vitest';
import {
  createPersistenceService,
  ProjectCollaborationRoom,
  resolveCollaborationDocument
} from '@openzcad/cloudflare-adapters';
import { toUserId } from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';

describe('cloudflare adapters', () => {
  it('falls back to in-memory persistence when D1 is absent', async () => {
    const service = createPersistenceService({ ENVIRONMENT: 'beta' });
    const created = await service.createProject(toUserId('user_test'), {
      name: 'CF Test'
    });
    const listed = await service.listProjects(toUserId('user_test'));

    expect(created.project.name).toBe('CF Test');
    expect(
      listed.projects.some(
        (project) => project.projectId === created.project.projectId
      )
    ).toBe(true);
  });

  it('accepts newer collaboration documents and rejects divergent peers', () => {
    const base = createProjectDocument('Room', toUserId('user_room'));
    const first = addPrimitiveFeature(base, {
      name: 'A',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const divergent = addPrimitiveFeature(base, {
      name: 'B',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const newer = addPrimitiveFeature(first, {
      name: 'C',
      primitiveKind: 'cylinder',
      dimensions: { radius: 1, height: 2 }
    });

    expect(resolveCollaborationDocument(null, first).kind).toBe('accept');
    expect(resolveCollaborationDocument(first, newer).kind).toBe('accept');
    expect(resolveCollaborationDocument(first, first).kind).toBe('same');
    expect(resolveCollaborationDocument(first, divergent).kind).toBe(
      'conflict'
    );
    const merged = resolveCollaborationDocument(first, divergent, base);
    expect(merged.kind).toBe('accept');
    expect(merged.document.version).toBe(
      Math.max(first.version, divergent.version) + 1
    );
    expect(merged.document.featureOrder).toHaveLength(2);
    expect(merged.document.bodyOrder).toHaveLength(2);
  });

  it('accepts undo and redo as forward collaboration revisions', () => {
    const manager = new CommandManager(
      createProjectDocument('Undo Room', toUserId('user_room'))
    );
    const added = manager.execute(
      commandFactories.addPrimitive({
        name: 'A',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const undone = manager.undo();
    const redone = manager.redo();

    expect(undone.version).toBeGreaterThan(added.version);
    expect(redone.version).toBeGreaterThan(undone.version);
    expect(resolveCollaborationDocument(added, undone).kind).toBe('accept');
    expect(resolveCollaborationDocument(undone, redone).kind).toBe('accept');
  });

  it('restores the latest collaboration document from durable storage', async () => {
    const values = new Map<string, unknown>();
    const context = {
      storage: {
        async get<T>(key: string) {
          return values.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          values.set(key, structuredClone(value));
        }
      },
      async blockConcurrencyWhile<T>(callback: () => Promise<T>) {
        return callback();
      }
    };
    const base = createProjectDocument('Durable Room', toUserId('user_room'));
    const first = addPrimitiveFeature(base, {
      name: 'A',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const divergent = addPrimitiveFeature(base, {
      name: 'B',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const request = (document: typeof first) =>
      new Request(
        `https://room.test/?projectId=${document.projectId}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-openzcad-user-id': 'user_room',
            'x-openzcad-display-name': 'Room user'
          },
          body: JSON.stringify({ clientId: 'client_test', document })
        }
      );

    const original = new ProjectCollaborationRoom(context, {});
    expect((await original.fetch(request(first))).status).toBe(200);

    const restored = new ProjectCollaborationRoom(context, {});
    const conflict = await restored.fetch(request(divergent));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      type: 'conflict',
      document: { version: first.version }
    });
  });

  it('returns the merged document to the submitting client', async () => {
    const values = new Map<string, unknown>();
    const context = {
      storage: {
        async get<T>(key: string) {
          return values.get(key) as T | undefined;
        },
        async put<T>(key: string, value: T) {
          values.set(key, structuredClone(value));
        }
      },
      async blockConcurrencyWhile<T>(callback: () => Promise<T>) {
        return callback();
      }
    };
    const base = createProjectDocument('Race Room', toUserId('user_room'));
    // Two clients edit disjoint parts of the same base at the same time.
    const fromA = addPrimitiveFeature(base, {
      name: 'A',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const fromB = addPrimitiveFeature(base, {
      name: 'B',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const submit = (
      clientId: string,
      document: typeof fromA,
      baseVersion: number | null
    ) =>
      new Request(`https://room.test/?projectId=${document.projectId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openzcad-user-id': 'user_room',
          'x-openzcad-display-name': 'Room user'
        },
        body: JSON.stringify({ clientId, document, baseVersion })
      });

    const room = new ProjectCollaborationRoom(context, {});

    // Both clients join on the shared base first; this is what puts the common
    // ancestor into room history so a three-way merge is possible at all.
    expect(
      (await room.fetch(submit('client_a', base, null))).status
    ).toBe(200);

    // A lands first and is stored verbatim, so it needs no document echoed back.
    const ackA = (await (
      await room.fetch(submit('client_a', fromA, base.version))
    ).json()) as { type: string; version: number; document?: typeof fromA };
    expect(ackA.type).toBe('ack');
    expect(ackA.document).toBeUndefined();

    // B's submission gets merged with A's. B never sees the broadcast (it is
    // the sender), so the ack has to carry the merged document or B stays on a
    // document that no longer matches the room while reporting itself synced.
    const ackB = (await (
      await room.fetch(submit('client_b', fromB, base.version))
    ).json()) as { type: string; version: number; document?: typeof fromA };
    expect(ackB.type).toBe('ack');
    expect(ackB.document).toBeDefined();

    const merged = ackB.document!;
    expect(merged.version).toBe(ackB.version);
    expect(merged.version).toBe(Math.max(fromA.version, fromB.version) + 1);
    // Exact convergence: the merge kept both peers' work, and B's acked
    // document is byte-identical to what the room now considers canonical.
    expect(merged.featureOrder).toHaveLength(2);
    expect(merged.bodyOrder).toHaveLength(2);

    const restored = new ProjectCollaborationRoom(context, {});
    const ackC = (await (
      await restored.fetch(submit('client_b', merged, merged.version))
    ).json()) as { type: string; version: number; document?: typeof fromA };
    expect(ackC.type).toBe('ack');
    expect(ackC.document).toBeUndefined();
  });
});
