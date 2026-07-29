import { describe, expect, it, vi } from 'vitest';
import {
  createPersistenceService,
  D1R2PersistenceService,
  ProjectCollaborationRoom,
  resolveCollaborationDocument
} from '@openzcad/cloudflare-adapters';
import { toUserId } from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import type { ProjectDocument } from '@openzcad/shared';
import {
  createRoomContext,
  settleRoom,
  storedValueBytes
} from './collaboration-room-harness';

/** SQLite-backed Durable Object storage refuses a value over 2 MiB. */
const DURABLE_VALUE_LIMIT_BYTES = 2 * 1024 * 1024;

function roomRequest(
  document: ProjectDocument,
  body: Record<string, unknown>
): Request {
  return new Request(`https://room.test/?projectId=${document.projectId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-openzcad-user-id': 'user_room',
      'x-openzcad-display-name': 'Room user'
    },
    body: JSON.stringify(body)
  });
}

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

  it('skips a corrupt D1 project row without hiding valid projects', async () => {
    const document = createProjectDocument(
      'Valid D1 project',
      toUserId('user_test')
    );
    const rows = [
      {
        id: document.projectId,
        name: document.name,
        updated_at: document.derived.updatedAt,
        document_json: JSON.stringify(document)
      },
      {
        id: 'project_poisoned',
        name: 'Poisoned',
        updated_at: document.derived.updatedAt,
        document_json: '{not-json'
      }
    ];
    const all = vi.fn(async () => ({ results: rows }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database
    });

    await expect(service.listProjects(toUserId('user_test'))).resolves.toEqual({
      projects: [
        expect.objectContaining({
          projectId: document.projectId,
          name: document.name
        })
      ]
    });
    expect(consoleError).toHaveBeenCalledWith('Skipping corrupt project row.');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      'project_poisoned'
    );
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
    const { context } = createRoomContext();
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
      roomRequest(document, { clientId: 'client_test', document });

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
    const { context } = createRoomContext();
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
    ) => roomRequest(document, { clientId, document, baseVersion });

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

  it('keeps every stored value under the durable-storage limit', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Heavy Room', toUserId('user_room'));
    // ~1 MB of document. Under the old layout the room wrote latest plus its
    // whole history into one value, so a handful of these blew past 2 MiB.
    const heavy = addPrimitiveFeature(base, {
      name: 'H'.repeat(500_000),
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const at = (version: number): ProjectDocument => ({
      ...structuredClone(heavy),
      version
    });

    const room = new ProjectCollaborationRoom(context, {});
    for (let offset = 0; offset < 4; offset += 1) {
      const document = at(heavy.version + offset);
      const response = await room.fetch(
        roomRequest(document, {
          clientId: 'client_heavy',
          document,
          baseVersion: null
        })
      );
      expect(response.status).toBe(200);
    }

    const sizes = storedValueBytes(values);
    const total = Array.from(sizes.values()).reduce(
      (sum, bytes) => sum + bytes,
      0
    );
    // The room now holds more than one value could ever have carried...
    expect(total).toBeGreaterThan(DURABLE_VALUE_LIMIT_BYTES);
    // ...yet no individual key is anywhere near the per-value ceiling.
    for (const [key, bytes] of sizes) {
      expect(
        bytes,
        `${key} is ${bytes} bytes`
      ).toBeLessThan(DURABLE_VALUE_LIMIT_BYTES);
    }
    expect(values.has('room:latest')).toBe(true);
    expect(
      Array.from(values.keys()).filter((key) =>
        key.startsWith('room:history:')
      ).length
    ).toBeGreaterThan(0);
  });

  it('refuses an unstorable document without moving room state', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Overflow Room', toUserId('user_room'));
    const accepted = addPrimitiveFeature(base, {
      name: 'Keeper',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const room = new ProjectCollaborationRoom(context, {});
    expect(
      (
        await room.fetch(
          roomRequest(accepted, {
            clientId: 'client_ok',
            document: accepted,
            baseVersion: null
          })
        )
      ).status
    ).toBe(200);

    // Past what one durable value holds, but under the HTTP body ceiling.
    const oversize = addPrimitiveFeature(accepted, {
      name: 'X'.repeat(1_550_000),
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const rejected = await room.fetch(
      roomRequest(oversize, {
        clientId: 'client_big',
        document: oversize,
        baseVersion: null
      })
    );
    expect(rejected.status).toBe(413);
    await expect(rejected.json()).resolves.toMatchObject({
      type: 'error',
      code: 'document-too-large'
    });

    // The rejection has to happen before any mutation, or the room serves a
    // document that storage never took and reverts on the next eviction.
    expect(
      (values.get('room:latest') as ProjectDocument).version
    ).toBe(accepted.version);
    const restored = new ProjectCollaborationRoom(context, {});
    const state = await restored.fetch(
      roomRequest(accepted, {
        clientId: 'client_ok',
        document: accepted,
        baseVersion: null
      })
    );
    await expect(state.json()).resolves.toMatchObject({
      type: 'ack',
      version: accepted.version
    });
  });

  it('rejects an over-long snapshot body before parsing it', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Flood Room', toUserId('user_room'));
    const room = new ProjectCollaborationRoom(context, {});
    const response = await room.fetch(
      roomRequest(base, {
        clientId: 'client_flood',
        padding: 'p'.repeat(1_700_000),
        document: base
      })
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      code: 'document-too-large'
    });
  });

  it('migrates a legacy single-value room into per-document keys', async () => {
    const base = createProjectDocument('Legacy Room', toUserId('user_room'));
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
    const values = new Map<string, unknown>([
      [
        'room-state',
        {
          projectId: base.projectId,
          latestDocument: first,
          history: [base, first]
        }
      ]
    ]);
    const { context } = createRoomContext(values);

    const room = new ProjectCollaborationRoom(context, {});
    await settleRoom(room);

    expect(values.has('room-state')).toBe(false);
    expect(values.get('room:meta')).toMatchObject({
      projectId: base.projectId,
      latestVersion: first.version,
      historyVersions: [base.version, first.version]
    });
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      first.version
    );
    expect(values.has(`room:history:${base.version}`)).toBe(true);

    // The migrated history still serves as a merge ancestor, which is the only
    // reason to carry it across at all.
    const merged = (await (
      await room.fetch(
        roomRequest(divergent, {
          clientId: 'client_legacy',
          document: divergent,
          baseVersion: base.version
        })
      )
    ).json()) as { type: string; document?: ProjectDocument };
    expect(merged.type).toBe('ack');
    expect(merged.document?.featureOrder).toHaveLength(2);
  });

  it('leaves a migrated room alone when the legacy key reappears', async () => {
    const base = createProjectDocument('Stale Room', toUserId('user_room'));
    const current = addPrimitiveFeature(base, {
      name: 'Current',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const values = new Map<string, unknown>([
      ['room-state', { projectId: base.projectId, latestDocument: base }],
      [
        'room:meta',
        {
          schema: 1,
          projectId: base.projectId,
          latestVersion: current.version,
          historyVersions: []
        }
      ],
      ['room:latest', current]
    ]);
    const { context } = createRoomContext(values);

    const room = new ProjectCollaborationRoom(context, {});
    await settleRoom(room);

    expect(values.has('room-state')).toBe(false);
    // The split layout wins; the stale legacy value must not roll the room back.
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      current.version
    );
    const conflict = await room.fetch(
      roomRequest(base, {
        clientId: 'client_stale',
        document: addPrimitiveFeature(base, {
          name: 'Other',
          primitiveKind: 'sphere',
          dimensions: { radius: 1 }
        })
      })
    );
    expect(conflict.status).toBe(409);
  });

  it('drops the oldest history entries instead of growing without bound', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Long Room', toUserId('user_room'));
    let document = addPrimitiveFeature(base, {
      name: 'Seed',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const room = new ProjectCollaborationRoom(context, {});
    for (let step = 0; step < 30; step += 1) {
      const next: ProjectDocument = {
        ...document,
        version: document.version + 1
      };
      await room.fetch(
        roomRequest(next, {
          clientId: 'client_long',
          document: next,
          baseVersion: null
        })
      );
      document = next;
    }

    const historyKeys = Array.from(values.keys()).filter((key) =>
      key.startsWith('room:history:')
    );
    expect(historyKeys.length).toBeLessThanOrEqual(20);
    const meta = values.get('room:meta') as { historyVersions: number[] };
    // Every version the index advertises must still have its key, or a restart
    // loses the ancestor a merge was going to use.
    for (const version of meta.historyVersions) {
      expect(values.has(`room:history:${version}`)).toBe(true);
    }
    expect(meta.historyVersions).toHaveLength(historyKeys.length);
  });
});
