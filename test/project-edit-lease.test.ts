import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { ProjectCollaborationRoom } from '@openzcad/cloudflare-adapters';
import {
  toUserId,
  type CollaborationServerMessage,
  type ProjectDocument,
  type ProjectEditLease
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  createRoomContext,
  installWorkerSocketGlobals,
  type FakeWebSocket
} from './collaboration-room-harness';

let globals: ReturnType<typeof installWorkerSocketGlobals>;

beforeAll(() => {
  globals = installWorkerSocketGlobals();
});

afterAll(() => {
  globals.restore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const leaseEnv = { PROJECT_EDIT_LEASES_ENFORCED: 'true' };

async function openSocket(
  room: ProjectCollaborationRoom,
  projectId: string,
  userId: string,
  role: 'owner' | 'editor' | 'viewer',
  clientId: string
): Promise<FakeWebSocket> {
  const response = await room.fetch(
    new Request(`https://room.test/?projectId=${projectId}`, {
      headers: {
        upgrade: 'websocket',
        'x-openzcad-user-id': userId,
        'x-openzcad-display-name': userId,
        'x-openzcad-project-role': role
      }
    })
  );
  expect(response.status).toBe(101);
  const socket = globals.serverSockets.at(-1)!;
  await socket.receive(
    JSON.stringify({
      type: 'hello',
      clientId,
      displayName: userId,
      baseVersion: null,
      document: null
    })
  );
  return socket;
}

async function acquire(
  socket: FakeWebSocket,
  clientId: string
): Promise<ProjectEditLease> {
  await socket.receive(JSON.stringify({ type: 'lease-acquire', clientId }));
  const granted = socket.lastFrame();
  expect(granted).toMatchObject({ type: 'lease-granted' });
  return (
    granted as Extract<CollaborationServerMessage, { type: 'lease-granted' }>
  ).lease;
}

function documentFrame(
  document: ProjectDocument,
  clientId: string,
  leaseId: string,
  baseVersion: number | null = null
): string {
  return JSON.stringify({
    type: 'document',
    clientId,
    baseVersion,
    document,
    leaseId
  });
}

describe('project edit lease', () => {
  async function twoBrowsers(role: 'owner' | 'editor' = 'owner') {
    const storage = createRoomContext();
    const document = createProjectDocument(
      'Concurrent project',
      toUserId('user_owner')
    );
    const room = new ProjectCollaborationRoom(storage.context, leaseEnv);
    const first = await openSocket(
      room,
      document.projectId,
      'user_owner',
      role,
      'client_first'
    );
    const second = await openSocket(
      room,
      document.projectId,
      'user_owner',
      role,
      'client_second'
    );
    const firstLease = await acquire(first, 'client_first');
    const secondLease = await acquire(second, 'client_second');
    return {
      ...storage,
      document,
      room,
      first,
      second,
      firstLease,
      secondLease
    };
  }

  it('accepts HTTP fallback writes from both browsers but rejects exchanging their tokens', async () => {
    const { document, room, firstLease, secondLease } = await twoBrowsers();
    const snapshot = (clientId: string, leaseId: string) =>
      room.fetch(
        new Request(`https://room.test/?projectId=${document.projectId}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-openzcad-user-id': 'user_owner',
            'x-openzcad-display-name': 'Test owner',
            'x-openzcad-project-role': 'owner'
          },
          body: JSON.stringify({
            clientId,
            leaseId,
            document,
            baseVersion: null
          })
        })
      );
    expect((await snapshot('client_first', firstLease.leaseId)).status).toBe(
      200
    );
    expect((await snapshot('client_second', secondLease.leaseId)).status).toBe(
      200
    );
    const rejected = await snapshot('client_second', firstLease.leaseId);
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({
      type: 'error',
      code: 'lease-required'
    });
  });

  it('acknowledges the second browser joining with an already-current snapshot', async () => {
    const { document, first, second, firstLease, secondLease } =
      await twoBrowsers();
    await first.receive(
      documentFrame(document, 'client_first', firstLease.leaseId)
    );
    second.sent.length = 0;
    await second.receive(
      documentFrame(document, 'client_second', secondLease.leaseId)
    );
    expect(second.lastFrame()).toMatchObject({
      type: 'ack',
      version: document.version
    });
  });

  it('merges independent simultaneous edits and returns the combined model to both browsers', async () => {
    const { document, values, first, second, firstLease, secondLease } =
      await twoBrowsers();
    await first.receive(
      documentFrame(document, 'client_first', firstLease.leaseId)
    );
    const box = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const sphere = addPrimitiveFeature(document, {
      name: 'Sphere',
      primitiveKind: 'sphere',
      dimensions: { radius: 2 }
    });
    await Promise.all([
      first.receive(
        documentFrame(box, 'client_first', firstLease.leaseId, document.version)
      ),
      second.receive(
        documentFrame(
          sphere,
          'client_second',
          secondLease.leaseId,
          document.version
        )
      )
    ]);
    const merged = values.get('room:latest') as ProjectDocument;
    expect(merged.featureOrder).toEqual(
      expect.arrayContaining([...box.featureOrder, ...sphere.featureOrder])
    );
    expect(merged.featureOrder).toHaveLength(2);
    expect(first.lastFrame()).toMatchObject({
      type: 'document',
      document: { version: merged.version }
    });
    expect(second.lastFrame()).toMatchObject({
      type: 'ack',
      document: { version: merged.version }
    });
  });

  it('refuses conflicting simultaneous changes instead of overwriting the first browser', async () => {
    const { document, values, first, second, firstLease, secondLease } =
      await twoBrowsers();
    await first.receive(
      documentFrame(document, 'client_first', firstLease.leaseId)
    );
    const firstEdit = {
      ...document,
      version: document.version + 1,
      name: 'First name'
    };
    const secondEdit = {
      ...document,
      version: document.version + 1,
      name: 'Second name'
    };
    await first.receive(
      documentFrame(
        firstEdit,
        'client_first',
        firstLease.leaseId,
        document.version
      )
    );
    await second.receive(
      documentFrame(
        secondEdit,
        'client_second',
        secondLease.leaseId,
        document.version
      )
    );
    expect(second.lastFrame()).toMatchObject({
      type: 'conflict',
      document: { name: 'First name' }
    });
    expect(values.get('room:latest')).toMatchObject({ name: 'First name' });
  });

  it('restores both leases after eviction and releases only the requesting browser', async () => {
    const { document, context, firstLease, secondLease } = await twoBrowsers();
    const restarted = new ProjectCollaborationRoom(context, leaseEnv);
    const first = await openSocket(
      restarted,
      document.projectId,
      'user_owner',
      'owner',
      'client_first'
    );
    const second = await openSocket(
      restarted,
      document.projectId,
      'user_owner',
      'owner',
      'client_second'
    );
    expect((await acquire(first, 'client_first')).leaseId).toBe(
      firstLease.leaseId
    );
    expect((await acquire(second, 'client_second')).leaseId).toBe(
      secondLease.leaseId
    );
    await first.receive(
      JSON.stringify({
        type: 'lease-release',
        clientId: 'client_first',
        leaseId: firstLease.leaseId
      })
    );
    expect(first.lastFrame()).toMatchObject({
      type: 'lease-lost',
      reason: 'released'
    });
    await second.receive(
      documentFrame(document, 'client_second', secondLease.leaseId)
    );
    expect(second.lastFrame()).toMatchObject({ type: 'ack' });
    const other = await openSocket(
      restarted,
      document.projectId,
      'user_other',
      'editor',
      'client_other'
    );
    await other.receive(
      JSON.stringify({ type: 'lease-acquire', clientId: 'client_other' })
    );
    expect(other.lastFrame()).toMatchObject({
      type: 'lease-denied',
      reason: 'held'
    });
  });

  it('expires an idle browser without expiring the other browser heartbeat', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
    const { document, room, first, second, firstLease, secondLease } =
      await twoBrowsers();
    now.mockReturnValue(2_000_000_020_000);
    await second.receive(
      JSON.stringify({
        type: 'lease-renew',
        clientId: 'client_second',
        leaseId: secondLease.leaseId
      })
    );
    now.mockReturnValue(2_000_000_030_001);
    await first.receive(
      documentFrame(document, 'client_first', firstLease.leaseId)
    );
    expect(first.lastFrame()).toMatchObject({
      type: 'error',
      code: 'lease-required'
    });
    await second.receive(
      documentFrame(document, 'client_second', secondLease.leaseId)
    );
    expect(second.lastFrame()).toMatchObject({ type: 'ack' });
    const other = await openSocket(
      room,
      document.projectId,
      'user_other',
      'editor',
      'client_other'
    );
    await other.receive(
      JSON.stringify({ type: 'lease-acquire', clientId: 'client_other' })
    );
    expect(other.lastFrame()).toMatchObject({
      type: 'lease-denied',
      reason: 'held',
      expiresAt: 2_000_000_050_000
    });
    now.mockReturnValue(2_000_000_050_001);
    await acquire(other, 'client_other');
  });

  it('revokes every browser lease when a shared editor becomes a viewer', async () => {
    const { document, room, values, first, second, firstLease, secondLease } =
      await twoBrowsers('editor');
    const update = await room.fetch(
      new Request(`https://room.test/?projectId=${document.projectId}`, {
        method: 'PATCH',
        headers: {
          'x-openzcad-internal-user-id': 'user_owner',
          'x-openzcad-internal-project-role': 'viewer'
        }
      })
    );
    expect(update.status).toBe(204);
    expect(values.has('room:edit-lease')).toBe(false);
    for (const [socket, lease] of [
      [first, firstLease],
      [second, secondLease]
    ] as const) {
      expect(socket.lastFrame()).toMatchObject({
        type: 'lease-lost',
        reason: 'role-changed'
      });
      await socket.receive(
        documentFrame(document, lease.clientId, lease.leaseId)
      );
      expect(socket.lastFrame()).toMatchObject({
        type: 'error',
        code: 'permission-denied'
      });
    }
  });

  it('lets two browsers on the same account author with separate leases', async () => {
    const { context, values } = createRoomContext();
    const document = createProjectDocument(
      'Two browsers',
      toUserId('user_owner')
    );
    const room = new ProjectCollaborationRoom(context, leaseEnv);
    const first = await openSocket(
      room,
      document.projectId,
      'user_owner',
      'owner',
      'client_first'
    );
    const second = await openSocket(
      room,
      document.projectId,
      'user_owner',
      'owner',
      'client_second'
    );
    const firstLease = await acquire(first, 'client_first');
    const secondLease = await acquire(second, 'client_second');
    expect(secondLease.leaseId).not.toBe(firstLease.leaseId);
    await first.receive(
      documentFrame(document, 'client_first', firstLease.leaseId)
    );
    const changed = addPrimitiveFeature(document, {
      name: 'Second browser box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    await second.receive(
      documentFrame(changed, 'client_second', secondLease.leaseId)
    );
    expect(second.lastFrame()).toMatchObject({
      type: 'ack',
      version: changed.version
    });
    expect(first.lastFrame()).toMatchObject({
      type: 'document',
      document: { version: changed.version }
    });
    expect(values.get('room:latest')).toMatchObject({
      version: changed.version
    });
    await second.receive(
      documentFrame(changed, 'client_second', firstLease.leaseId)
    );
    expect(second.lastFrame()).toMatchObject({
      type: 'error',
      code: 'lease-required'
    });
  });

  it('persists one lease across eviction and grants only after expiry', async () => {
    const { context, values } = createRoomContext();
    const document = createProjectDocument(
      'Persisted lease',
      toUserId('user_lease_owner')
    );
    const firstRoom = new ProjectCollaborationRoom(context, leaseEnv);
    const first = await openSocket(
      firstRoom,
      document.projectId,
      'user_lease_owner',
      'owner',
      'client_first'
    );
    const lease = await acquire(first, 'client_first');
    expect(values.get('room:edit-lease')).toEqual(lease);

    const restarted = new ProjectCollaborationRoom(context, leaseEnv);
    const second = await openSocket(
      restarted,
      document.projectId,
      'user_lease_editor',
      'editor',
      'client_second'
    );
    await second.receive(
      JSON.stringify({ type: 'lease-acquire', clientId: 'client_second' })
    );
    expect(second.lastFrame()).toMatchObject({
      type: 'lease-denied',
      reason: 'held'
    });

    values.set('room:edit-lease', { ...lease, expiresAt: Date.now() - 1 });
    const afterExpiry = new ProjectCollaborationRoom(context, leaseEnv);
    const third = await openSocket(
      afterExpiry,
      document.projectId,
      'user_lease_editor',
      'editor',
      'client_second'
    );
    await acquire(third, 'client_second');
  });

  it('renews by heartbeat, survives disconnect, and permits takeover only after TTL', async () => {
    const now = vi.spyOn(Date, 'now');
    const startedAt = 2_000_000_000_000;
    now.mockReturnValue(startedAt);
    const { context, values } = createRoomContext();
    const document = createProjectDocument(
      'Heartbeat lease',
      toUserId('user_heartbeat_owner')
    );
    const room = new ProjectCollaborationRoom(context, leaseEnv);
    const owner = await openSocket(
      room,
      document.projectId,
      'user_heartbeat_owner',
      'owner',
      'client_heartbeat'
    );
    const lease = await acquire(owner, 'client_heartbeat');

    now.mockReturnValue(startedAt + 10_000);
    await owner.receive(
      JSON.stringify({
        type: 'lease-renew',
        clientId: 'client_heartbeat',
        leaseId: lease.leaseId
      })
    );
    const renewed = (
      owner.lastFrame() as Extract<
        CollaborationServerMessage,
        { type: 'lease-granted' }
      >
    ).lease;
    expect(renewed.expiresAt).toBe(startedAt + 40_000);

    owner.close(1006, 'network lost');
    expect(values.get('room:edit-lease')).toEqual(renewed);

    now.mockReturnValue(startedAt + 30_001);
    const beforeExpiry = new ProjectCollaborationRoom(context, leaseEnv);
    const waiting = await openSocket(
      beforeExpiry,
      document.projectId,
      'user_heartbeat_editor',
      'editor',
      'client_takeover'
    );
    await waiting.receive(
      JSON.stringify({ type: 'lease-acquire', clientId: 'client_takeover' })
    );
    expect(waiting.lastFrame()).toMatchObject({
      type: 'lease-denied',
      reason: 'held'
    });

    now.mockReturnValue(startedAt + 40_001);
    const afterExpiry = new ProjectCollaborationRoom(context, leaseEnv);
    const takeover = await openSocket(
      afterExpiry,
      document.projectId,
      'user_heartbeat_editor',
      'editor',
      'client_takeover'
    );
    await acquire(takeover, 'client_takeover');
  });

  it('rejects forged, other-client, and cross-project lease identities', async () => {
    const { context, values } = createRoomContext();
    const document = createProjectDocument(
      'Bound lease',
      toUserId('user_bound_owner')
    );
    const room = new ProjectCollaborationRoom(context, leaseEnv);
    const owner = await openSocket(
      room,
      document.projectId,
      'user_bound_owner',
      'owner',
      'client_owner'
    );
    const lease = await acquire(owner, 'client_owner');
    const changed = addPrimitiveFeature(document, {
      name: 'Only holder',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });

    owner.sent.length = 0;
    await owner.receive(documentFrame(changed, 'client_owner', 'lease_forged'));
    expect(owner.lastFrame()).toMatchObject({
      type: 'error',
      code: 'lease-required'
    });

    const editor = await openSocket(
      room,
      document.projectId,
      'user_bound_editor',
      'editor',
      'client_editor'
    );
    editor.sent.length = 0;
    await editor.receive(
      documentFrame(changed, 'client_editor', lease.leaseId)
    );
    expect(editor.lastFrame()).toMatchObject({
      type: 'error',
      code: 'lease-required'
    });

    values.set('room:edit-lease', {
      ...lease,
      projectId: 'project_other',
      expiresAt: Date.now() + 30_000
    });
    const restarted = new ProjectCollaborationRoom(context, leaseEnv);
    const replacement = await openSocket(
      restarted,
      document.projectId,
      'user_bound_editor',
      'editor',
      'client_replacement'
    );
    await acquire(replacement, 'client_replacement');
  });

  it('blocks viewer document frames and revokes an editor lease on downgrade', async () => {
    const { context, values } = createRoomContext();
    const document = createProjectDocument(
      'Role checks',
      toUserId('user_role_owner')
    );
    const changed = addPrimitiveFeature(document, {
      name: 'Forbidden',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const room = new ProjectCollaborationRoom(context, leaseEnv);
    const viewer = await openSocket(
      room,
      document.projectId,
      'user_role_viewer',
      'viewer',
      'client_viewer'
    );
    viewer.sent.length = 0;
    await viewer.receive(documentFrame(changed, 'client_viewer', 'lease_any'));
    expect(viewer.lastFrame()).toMatchObject({
      type: 'error',
      code: 'permission-denied'
    });
    expect(values.has('room:latest')).toBe(false);

    const editor = await openSocket(
      room,
      document.projectId,
      'user_role_editor',
      'editor',
      'client_editor'
    );
    const lease = await acquire(editor, 'client_editor');
    editor.sent.length = 0;
    const update = await room.fetch(
      new Request(
        `https://project-room.internal/?projectId=${document.projectId}`,
        {
          method: 'PATCH',
          headers: {
            'x-openzcad-internal-user-id': 'user_role_editor',
            'x-openzcad-internal-project-role': 'viewer'
          }
        }
      )
    );
    expect(update.status).toBe(204);
    expect(values.has('room:edit-lease')).toBe(false);
    expect(editor.lastFrame()).toMatchObject({
      type: 'lease-lost',
      reason: 'role-changed'
    });

    editor.sent.length = 0;
    await editor.receive(
      documentFrame(changed, 'client_editor', lease.leaseId)
    );
    expect(editor.lastFrame()).toMatchObject({
      type: 'error',
      code: 'permission-denied'
    });

    const removed = await room.fetch(
      new Request(
        `https://project-room.internal/?projectId=${document.projectId}`,
        {
          method: 'PATCH',
          headers: {
            'x-openzcad-internal-user-id': 'user_role_editor'
          }
        }
      )
    );
    expect(removed.status).toBe(204);
    expect(editor.closed).toMatchObject({
      code: 1008,
      reason: 'Project access was removed.'
    });
  });

  it('requires the same active lease for HTTP snapshot fallback writes', async () => {
    const { context } = createRoomContext();
    const document = createProjectDocument(
      'HTTP lease',
      toUserId('user_http_owner')
    );
    const room = new ProjectCollaborationRoom(context, leaseEnv);
    const socket = await openSocket(
      room,
      document.projectId,
      'user_http_owner',
      'owner',
      'client_http'
    );
    const lease = await acquire(socket, 'client_http');
    const request = (leaseId: string) =>
      new Request(`https://room.test/?projectId=${document.projectId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openzcad-user-id': 'user_http_owner',
          'x-openzcad-display-name': 'HTTP owner',
          'x-openzcad-project-role': 'owner'
        },
        body: JSON.stringify({
          clientId: 'client_http',
          baseVersion: null,
          document,
          leaseId
        })
      });

    const forged = await room.fetch(request('lease_forged'));
    expect(forged.status).toBe(409);
    await expect(forged.json()).resolves.toMatchObject({
      type: 'error',
      code: 'lease-required'
    });

    const accepted = await room.fetch(request(lease.leaseId));
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      type: 'ack',
      version: document.version
    });
  });

  it('re-checks D1 membership on every non-owner authored document', async () => {
    const { context } = createRoomContext();
    const document = createProjectDocument(
      'Membership recheck',
      toUserId('user_recheck_owner')
    );
    let memberRole: string | null = 'editor';
    const env = {
      PROJECT_EDIT_LEASES_ENFORCED: 'true',
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => (memberRole ? { role: memberRole } : null)
          })
        })
      }
    };
    const room = new ProjectCollaborationRoom(context, env);
    const editor = await openSocket(
      room,
      document.projectId,
      'user_recheck_editor',
      'editor',
      'client_recheck'
    );
    const lease = await acquire(editor, 'client_recheck');
    const changed = addPrimitiveFeature(document, {
      name: 'Edited box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });

    editor.sent.length = 0;
    await editor.receive(
      documentFrame(changed, 'client_recheck', lease.leaseId)
    );
    expect(editor.lastFrame()).toMatchObject({ type: 'ack' });

    // The membership row is gone but the internal role PATCH never reached
    // the room, so the open socket still holds its stale editor role. The D1
    // re-check is what stops it from authoring.
    memberRole = null;
    editor.sent.length = 0;
    await editor.receive(
      documentFrame(changed, 'client_recheck', lease.leaseId)
    );
    expect(editor.lastFrame()).toMatchObject({
      type: 'error',
      code: 'permission-denied'
    });
  });

  it('re-checks D1 membership for lease heartbeats and HTTP fallback writes', async () => {
    const { context, values } = createRoomContext();
    const document = createProjectDocument(
      'Fallback membership recheck',
      toUserId('user_fallback_owner')
    );
    let memberRole: string | null = 'editor';
    const env = {
      PROJECT_EDIT_LEASES_ENFORCED: 'true',
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => (memberRole ? { role: memberRole } : null)
          })
        })
      }
    };
    const room = new ProjectCollaborationRoom(context, env);
    const editor = await openSocket(
      room,
      document.projectId,
      'user_fallback_editor',
      'editor',
      'client_fallback'
    );
    const lease = await acquire(editor, 'client_fallback');
    memberRole = null;

    editor.sent.length = 0;
    await editor.receive(
      JSON.stringify({
        type: 'lease-renew',
        clientId: 'client_fallback',
        leaseId: lease.leaseId
      })
    );
    expect(editor.lastFrame()).toMatchObject({
      type: 'lease-lost',
      reason: 'role-changed'
    });
    expect(values.has('room:edit-lease')).toBe(false);

    editor.sent.length = 0;
    await editor.receive(
      JSON.stringify({
        type: 'lease-acquire',
        clientId: 'client_fallback'
      })
    );
    expect(editor.lastFrame()).toMatchObject({
      type: 'lease-denied',
      reason: 'read-only'
    });

    const response = await room.fetch(
      new Request(`https://room.test/?projectId=${document.projectId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openzcad-user-id': 'user_fallback_editor',
          'x-openzcad-display-name': 'Fallback editor',
          'x-openzcad-project-role': 'editor'
        },
        body: JSON.stringify({
          clientId: 'client_fallback',
          baseVersion: null,
          document,
          leaseId: lease.leaseId
        })
      })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      code: 'permission-denied'
    });
  });

  it('requires an explicit trusted role even when lease enforcement is off', async () => {
    const { context } = createRoomContext();
    const document = createProjectDocument(
      'Missing role',
      toUserId('user_missing_role')
    );
    const room = new ProjectCollaborationRoom(context, {});
    const missingRole = {
      'x-openzcad-user-id': 'user_missing_role',
      'x-openzcad-display-name': 'Missing role'
    };

    const upgrade = await room.fetch(
      new Request(`https://room.test/?projectId=${document.projectId}`, {
        headers: { ...missingRole, upgrade: 'websocket' }
      })
    );
    expect(upgrade.status).toBe(400);

    const snapshot = await room.fetch(
      new Request(`https://room.test/?projectId=${document.projectId}`, {
        method: 'POST',
        headers: { ...missingRole, 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: 'client_missing_role',
          document
        })
      })
    );
    expect(snapshot.status).toBe(400);

    const forgedOwnerUpdate = await room.fetch(
      new Request(`https://room.test/?projectId=${document.projectId}`, {
        method: 'PATCH',
        headers: {
          'x-openzcad-internal-user-id': 'user_member',
          'x-openzcad-internal-project-role': 'owner'
        }
      })
    );
    expect(forgedOwnerUpdate.status).toBe(400);
  });
});
