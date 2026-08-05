import { describe, expect, it, vi } from 'vitest';
import {
  createPersistenceService,
  CLOUDFLARE_BOOLEAN_FLAGS,
  D1R2PersistenceService,
  isCloudflareFeatureEnabled,
  projectCollaborationRollout,
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
      'x-openzcad-display-name': 'Room user',
      'x-openzcad-project-role': 'owner'
    },
    body: JSON.stringify(body)
  });
}

describe('cloudflare adapters', () => {
  it('keeps typed feature flags off unless explicitly enabled', () => {
    expect(CLOUDFLARE_BOOLEAN_FLAGS).toEqual([
      'DESKTOP_AUTH_ENABLED',
      'PROJECT_SHARING_ENABLED',
      'PROJECT_EDIT_LEASES_ENFORCED',
      'PROJECT_PERSONAL_SYNC_ENABLED',
      'AI_PATCH_DIRECT_EDIT_ENABLED',
      'AI_PATCH_FACE_SKETCH_ENABLED',
      'AI_PATCH_MULTI_PROFILE_EXTRUDE_ENABLED',
      'AI_PATCH_MIRROR_ENABLED',
      'AI_PATCH_SHELL_ENABLED',
      'AI_PATCH_SOLID_OFFSET_ENABLED',
      'AI_PATCH_PARTIAL_REVOLVE_ENABLED'
    ]);
    expect(isCloudflareFeatureEnabled({}, 'PROJECT_SHARING_ENABLED')).toBe(
      false
    );
    expect(
      isCloudflareFeatureEnabled(
        { PROJECT_SHARING_ENABLED: 'definitely' },
        'PROJECT_SHARING_ENABLED'
      )
    ).toBe(false);
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(
        isCloudflareFeatureEnabled(
          { PROJECT_SHARING_ENABLED: value },
          'PROJECT_SHARING_ENABLED'
        )
      ).toBe(true);
    }
    for (const value of ['', '0', 'false', 'no', 'off']) {
      expect(
        isCloudflareFeatureEnabled(
          { PROJECT_SHARING_ENABLED: value },
          'PROJECT_SHARING_ENABLED'
        )
      ).toBe(false);
    }
  });

  it('resolves collaboration canaries by normalized authenticated email', () => {
    const canaryEnv = {
      PROJECT_SHARING_ENABLED: 'false',
      PROJECT_EDIT_LEASES_ENFORCED: 'false',
      PROJECT_PERSONAL_SYNC_ENABLED: 'false',
      PROJECT_COLLABORATION_CANARY_EMAILS:
        ' owner@example.com, Second@Example.com '
    };

    expect(projectCollaborationRollout(canaryEnv, 'OWNER@example.com')).toEqual(
      {
        sharingEnabled: true,
        editLeasesEnforced: true,
        personalSyncEnabled: true,
        canary: true
      }
    );
    expect(projectCollaborationRollout(canaryEnv, 'other@example.com')).toEqual(
      {
        sharingEnabled: false,
        editLeasesEnforced: false,
        personalSyncEnabled: false,
        canary: false
      }
    );
    expect(
      projectCollaborationRollout(
        { PROJECT_EDIT_LEASES_ENFORCED: 'true' },
        'other@example.com'
      ).editLeasesEnforced
    ).toBe(true);
  });

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

  it('reads shelf state out of the D1 project row', async () => {
    const document = createProjectDocument('Shelved', toUserId('user_test'));
    const all = vi.fn(async () => ({
      results: [
        {
          id: document.projectId,
          name: document.name,
          updated_at: document.derived.updatedAt,
          document_json: JSON.stringify(document),
          status: 'deleted',
          pinned: 1,
          sort_order: 4,
          deleted_at: '2026-01-01T00:00:00.000Z',
          archived_at: null
        }
      ]
    }));
    const prepare = vi.fn((_query: string) => ({ bind: () => ({ all }) }));
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_SHARING_ENABLED: 'true'
    });

    const listed = await service.listProjects(toUserId('user_test'));
    expect(listed.projects[0]?.organization).toEqual({
      status: 'deleted',
      pinned: true,
      sortOrder: 4,
      deletedAt: '2026-01-01T00:00:00.000Z'
    });
    // Pinned-first, then manual order: the ordering has to come from SQL,
    // because the list is not re-sorted after it is read.
    expect(prepare.mock.calls[0]?.[0]).toContain(
      'ORDER BY pinned DESC, sort_order ASC, updated_at DESC'
    );
    expect(prepare.mock.calls[0]?.[0]).toContain('project_members');
  });

  it('duplicates from D1 without requiring disabled sharing schema', async () => {
    const userId = toUserId('user_duplicate_owner');
    const source = createProjectDocument('Bracket', userId);
    const queries: string[] = [];
    const run = vi.fn(async () => ({ success: true }));
    const prepare = vi.fn((query: string) => {
      queries.push(query);
      if (query.includes('project_members')) {
        throw new Error('no such table: project_members');
      }
      return {
        bind: (..._bindings: unknown[]) => ({
          all: async () => {
            if (query.includes('SELECT name FROM projects')) {
              return { results: [{ name: source.name }] };
            }
            return {
              results: [
                {
                  id: source.projectId,
                  name: source.name,
                  updated_at: source.derived.updatedAt,
                  document_json: JSON.stringify(source),
                  status: 'active',
                  pinned: 0,
                  sort_order: 7,
                  deleted_at: null,
                  archived_at: null
                }
              ]
            };
          },
          first: async () => {
            if (query.includes('SELECT user_id AS owner_user_id')) {
              return { owner_user_id: userId };
            }
            if (
              query.includes(
                'SELECT document_json, document_object_id FROM projects'
              )
            ) {
              return {
                document_json: JSON.stringify(source),
                document_object_id: null
              };
            }
            if (query.includes('SELECT sort_order FROM projects')) {
              return { sort_order: 7 };
            }
            return null;
          },
          run
        })
      };
    });
    const service = new D1R2PersistenceService({
      DB: { prepare } as unknown as D1Database,
      PROJECT_SHARING_ENABLED: 'false'
    });

    await expect(service.listProjects(userId)).resolves.toMatchObject({
      projects: [{ projectId: source.projectId, name: 'Bracket' }]
    });
    const copy = await service.duplicateProject(userId, {
      projectId: source.projectId
    });

    expect(copy.project.projectId).not.toBe(source.projectId);
    expect(copy.project.name).toBe('Bracket (copy)');
    expect(copy.document.ownerUserId).toBe(userId);
    expect(queries).not.toContainEqual(
      expect.stringContaining('project_members')
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('destroys a purged project together with everything hanging off it', async () => {
    const statements: string[] = [];
    const all = vi.fn(async () => ({ results: [{ id: 'proj_expired' }] }));
    const batch = vi.fn(async () => []);
    const prepare = vi.fn((query: string) => {
      statements.push(query);
      return { bind: () => ({ all, query }) };
    });
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database
    });

    expect(await service.purgeExpiredProjects(toUserId('user_test'))).toEqual([
      'proj_expired'
    ]);
    expect(statements[0]).toContain("status = 'deleted'");
    const destroyed = statements.slice(1).join('\n');
    for (const table of [
      'upload_sessions',
      'artifacts',
      'revisions',
      'projects'
    ]) {
      expect(destroyed).toContain(`DELETE FROM ${table}`);
    }
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('keeps project rows retryable when R2 deletion fails', async () => {
    const batch = vi.fn(async () => []);
    const deleteObject = vi.fn(async () => {
      throw new Error('R2 unavailable');
    });
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        all: async () => ({
          results: query.includes('SELECT object_key')
            ? [{ object_key: 'proj_expired/source.step' }]
            : [{ id: 'proj_expired' }]
        })
      })
    }));
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      ARTIFACTS: { delete: deleteObject } as unknown as R2Bucket
    });

    await expect(
      service.purgeExpiredProjects(toUserId('user_test'))
    ).rejects.toThrow('R2 unavailable');
    expect(batch).not.toHaveBeenCalled();
  });

  it('keeps failed expired-upload deletions tracked for the next sweep', async () => {
    const prepared: Array<{ query: string; bindings: unknown[] }> = [];
    let deletedStatements: Array<{ query: string; bindings: unknown[] }> = [];
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      deletedStatements = statements as unknown as typeof deletedStatements;
      return [];
    });
    const prepare = vi.fn((query: string) => ({
      bind: (...bindings: unknown[]) => {
        const statement = {
          query,
          bindings,
          all: async () => ({
            results: query.includes('SELECT id, object_key')
              ? [
                  { id: 'upload_deleted', object_key: 'project/uploads/a' },
                  { id: 'upload_retry', object_key: 'project/uploads/b' }
                ]
              : []
          })
        };
        prepared.push(statement);
        return statement;
      }
    }));
    const deleteObject = vi.fn(async (key: string) => {
      if (key.endsWith('/b')) {
        throw new Error('R2 temporarily unavailable');
      }
    });
    const service = new D1R2PersistenceService({
      DB: { prepare, batch } as unknown as D1Database,
      ARTIFACTS: { delete: deleteObject } as unknown as R2Bucket
    });

    await expect(service.purgeExpiredUploadSessions()).resolves.toBe(1);

    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(deletedStatements).toHaveLength(1);
    expect(deletedStatements[0]).toMatchObject({
      query: 'DELETE FROM upload_sessions WHERE id = ?',
      bindings: ['upload_deleted']
    });
    expect(prepared).not.toContainEqual(
      expect.objectContaining({
        query: 'DELETE FROM upload_sessions WHERE id = ?',
        bindings: ['upload_retry']
      })
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
    expect((await room.fetch(submit('client_a', base, null))).status).toBe(200);

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
      expect(bytes, `${key} is ${bytes} bytes`).toBeLessThan(
        DURABLE_VALUE_LIMIT_BYTES
      );
    }
    expect(values.has('room:latest')).toBe(true);
    expect(
      Array.from(values.keys()).filter((key) => key.startsWith('room:history:'))
        .length
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
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      accepted.version
    );
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

  it.each([
    ['without content-length', undefined],
    ['with an underreported content-length', '1']
  ])('counts streamed snapshot bytes %s', async (_label, contentLength) => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Stream Flood Room',
      toUserId('user_room')
    );
    const room = new ProjectCollaborationRoom(context, {});
    const chunk = new TextEncoder().encode('😀'.repeat(250_000));
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 3) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-openzcad-user-id': 'user_room',
      'x-openzcad-display-name': 'Room user',
      'x-openzcad-project-role': 'owner'
    };
    if (contentLength !== undefined) {
      headers['content-length'] = contentLength;
    }
    const request = new Request(
      `https://room.test/?projectId=${base.projectId}`,
      {
        method: 'POST',
        headers,
        body,
        duplex: 'half'
      } as RequestInit & { duplex: 'half' }
    );
    expect(request.headers.get('content-length')).toBe(contentLength ?? null);

    const response = await room.fetch(request);

    expect(response.status).toBe(413);
    // The stream queues one chunk ahead, but cancellation prevents the final
    // pull that request.text() would need in order to reach EOF.
    expect(pulls).toBe(3);
    expect(cancelled).toBe(true);
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
