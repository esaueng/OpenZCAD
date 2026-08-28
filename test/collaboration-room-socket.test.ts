import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProjectCollaborationRoom } from '@openzcad/cloudflare-adapters';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
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

interface SocketIdentity {
  userId: string;
  displayName: string;
  role: 'owner' | 'editor' | 'viewer';
}

const ownerIdentity: SocketIdentity = {
  userId: 'user_room',
  displayName: 'Room user',
  role: 'owner'
};

function upgradeRequest(
  projectId: string,
  identity: SocketIdentity = ownerIdentity
): Request {
  return new Request(`https://room.test/?projectId=${projectId}`, {
    headers: {
      upgrade: 'websocket',
      'x-openzcad-user-id': identity.userId,
      'x-openzcad-display-name': identity.displayName,
      'x-openzcad-project-role': identity.role
    }
  });
}

async function openSocket(
  room: ProjectCollaborationRoom,
  projectId: string,
  identity: SocketIdentity = ownerIdentity
): Promise<FakeWebSocket> {
  const response = await room.fetch(upgradeRequest(projectId, identity));
  expect(response.status).toBe(101);
  return globals.serverSockets.at(-1)!;
}

async function issueSocketTicket(
  room: ProjectCollaborationRoom,
  projectId: string,
  identity: SocketIdentity = ownerIdentity
): Promise<{ ticket: string; expiresAt: number }> {
  const response = await room.fetch(
    new Request(`https://room.test/?projectId=${projectId}`, {
      method: 'PUT',
      headers: {
        'x-openzcad-internal-ticket-request': 'v1',
        'x-openzcad-user-id': identity.userId,
        'x-openzcad-display-name': identity.displayName,
        'x-openzcad-project-role': identity.role
      }
    })
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json() as Promise<{ ticket: string; expiresAt: number }>;
}

function hello(document: ProjectDocument | null, clientId = 'client_ws') {
  return JSON.stringify({
    type: 'hello',
    clientId,
    displayName: 'Room user',
    baseVersion: null,
    document
  });
}

function documentFrame(
  document: ProjectDocument,
  baseVersion: number | null = null,
  clientId = 'client_ws'
) {
  return JSON.stringify({
    type: 'document',
    clientId,
    baseVersion,
    document
  });
}

/** A `nodes` value nested far past anything a real document produces. */
function deeplyNestedDocumentFrame(depth: number, clientId = 'client_ws') {
  const nested = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
  return `{"type":"document","clientId":"${clientId}","baseVersion":null,"document":{"nodes":${nested}}}`;
}

describe('collaboration room socket handling', () => {
  it('closes sockets and deletes every stored value during internal erasure', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Erased room', toUserId('user_room'));
    const room = new ProjectCollaborationRoom(context, {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development'
    });
    const socket = await openSocket(room, base.projectId);
    await socket.receive(hello(base));
    expect(values.size).toBeGreaterThan(0);

    const erased = await room.fetch(
      new Request(`https://room.test/?projectId=${base.projectId}`, {
        method: 'DELETE',
        headers: { 'x-openzcad-internal-project-erasure': 'v1' }
      })
    );

    expect(erased.status).toBe(204);
    expect(values.size).toBe(0);
    expect(socket.closed).toEqual({
      code: 4001,
      reason: 'Cloud project was permanently deleted.'
    });
    expect((await room.fetch(upgradeRequest(base.projectId))).status).toBe(410);
  });

  it('fails hosted room access closed outside the account canary', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Canary room', toUserId('user_room'));
    const roomEnv = {
      ENVIRONMENT: 'beta' as const,
      PRODUCTION_GUARD: 'enabled',
      PROJECT_COLLABORATION_CANARY_EMAILS: 'allowed@example.com'
    };
    const room = new ProjectCollaborationRoom(context, roomEnv);
    const request = (email: string) =>
      new Request(`https://room.test/?projectId=${base.projectId}`, {
        headers: {
          upgrade: 'websocket',
          'x-openzcad-user-id': 'user_room',
          'x-openzcad-display-name': 'Room user',
          'x-openzcad-user-email': email,
          'x-openzcad-project-role': 'owner'
        }
      });

    expect((await room.fetch(request('blocked@example.com'))).status).toBe(403);
    expect((await room.fetch(request('ALLOWED@example.com'))).status).toBe(101);

    const socket = globals.serverSockets.at(-1)!;
    await socket.receive(hello(null));
    roomEnv.PROJECT_COLLABORATION_CANARY_EMAILS = '';
    await socket.receive(
      JSON.stringify({
        type: 'presence',
        clientId: 'client_ws',
        status: 'active'
      })
    );
    expect(socket.closed).toEqual({
      code: 1008,
      reason: 'Collaboration access is disabled.'
    });
  });

  it('withholds broadcasts from a member removed while its socket stays open', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Revoked broadcast room',
      toUserId('user_room')
    );
    let memberRole: 'editor' | null = 'editor';
    const room = new ProjectCollaborationRoom(context, {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () =>
              memberRole ? { role: memberRole, collaboration_enabled: 1 } : null
          })
        })
      }
    });
    const owner = await openSocket(room, base.projectId);
    await owner.receive(hello(base, 'client_owner'));
    const member = await openSocket(room, base.projectId, {
      userId: 'user_removed',
      displayName: 'Removed member',
      role: 'editor'
    });
    await member.receive(hello(null, 'client_member'));
    memberRole = null;
    member.sent.length = 0;

    const next = addPrimitiveFeature(base, {
      name: 'Private after removal',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    await owner.receive(documentFrame(next, base.version, 'client_owner'));

    expect(member.closed).toEqual({
      code: 1008,
      reason: 'Project collaboration access is no longer available.'
    });
    expect(member.frames()).not.toContainEqual(
      expect.objectContaining({ type: 'document' })
    );
  });

  it('sends immediately after each recipient access check', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Recipient check ordering',
      toUserId('user_room')
    );
    let delayBlocker = false;
    let releaseBlocker: (() => void) | undefined;
    const room = new ProjectCollaborationRoom(context, {
      DB: {
        prepare: () => ({
          bind: (_projectId: string, userId: string) => ({
            first: async () => {
              if (delayBlocker && userId === 'user_blocker') {
                await new Promise<void>((resolve) => {
                  releaseBlocker = resolve;
                });
              }
              return { role: 'viewer', collaboration_enabled: 1 };
            }
          })
        })
      }
    });
    const owner = await openSocket(room, base.projectId);
    await owner.receive(hello(base, 'client_owner'));
    const target = await openSocket(room, base.projectId, {
      userId: 'user_target',
      displayName: 'Target viewer',
      role: 'viewer'
    });
    await target.receive(hello(null, 'client_target'));
    const blocker = await openSocket(room, base.projectId, {
      userId: 'user_blocker',
      displayName: 'Blocking viewer',
      role: 'viewer'
    });
    await blocker.receive(hello(null, 'client_blocker'));
    target.sent.length = 0;
    blocker.sent.length = 0;
    delayBlocker = true;

    const next = addPrimitiveFeature(base, {
      name: 'Checked recipient',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    await owner.receive(documentFrame(next, base.version, 'client_owner'));

    expect(target.frames()).toContainEqual(
      expect.objectContaining({ type: 'document' })
    );
    expect(blocker.frames()).not.toContainEqual(
      expect.objectContaining({ type: 'document' })
    );
    releaseBlocker?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blocker.frames()).toContainEqual(
      expect.objectContaining({ type: 'document' })
    );
  });

  it('does not resend room state when a removed member repeats hello', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Revoked state room',
      toUserId('user_room')
    );
    let memberPresent = true;
    const room = new ProjectCollaborationRoom(context, {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () =>
              memberPresent
                ? { role: 'viewer', collaboration_enabled: 1 }
                : null
          })
        })
      }
    });
    const owner = await openSocket(room, base.projectId);
    await owner.receive(hello(base, 'client_owner'));
    const member = await openSocket(room, base.projectId, {
      userId: 'user_removed_viewer',
      displayName: 'Removed viewer',
      role: 'viewer'
    });
    await member.receive(hello(null, 'client_viewer'));
    memberPresent = false;
    member.sent.length = 0;

    await member.receive(hello(null, 'client_viewer'));

    expect(member.closed).toMatchObject({ code: 1008 });
    expect(member.frames()).not.toContainEqual(
      expect.objectContaining({ type: 'state' })
    );
  });

  it('closes connected collaborators when the owner disables collaboration', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Disabled collaboration room',
      toUserId('user_room')
    );
    const room = new ProjectCollaborationRoom(context, {});
    const owner = await openSocket(room, base.projectId);
    await owner.receive(hello(base, 'client_owner'));
    const viewer = await openSocket(room, base.projectId, {
      userId: 'user_viewer',
      displayName: 'Room viewer',
      role: 'viewer'
    });
    await viewer.receive(hello(null, 'client_viewer'));

    const response = await room.fetch(
      new Request(
        `https://project-room.internal/?projectId=${base.projectId}`,
        {
          method: 'PATCH',
          headers: {
            'x-openzcad-internal-owner-collaboration-disabled': 'v1'
          }
        }
      )
    );

    expect(response.status).toBe(204);
    expect(viewer.closed).toEqual({
      code: 1008,
      reason: 'Project collaboration was disabled by the owner.'
    });
    expect(owner.closed).toBeNull();
    await expect(room.snapshot()).resolves.toEqual({
      members: [['client_owner', 'active']],
      lease: null
    });
  });

  it('clears a disconnected collaborator lease when the owner disables collaboration', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument(
      'Disabled lease room',
      toUserId('user_room')
    );
    const roomEnv = { PROJECT_EDIT_LEASES_ENFORCED: 'true' };
    const room = new ProjectCollaborationRoom(context, roomEnv);
    const editor = await openSocket(room, base.projectId, {
      userId: 'user_disconnected_editor',
      displayName: 'Disconnected editor',
      role: 'editor'
    });
    await editor.receive(hello(null, 'client_editor'));
    await editor.receive(
      JSON.stringify({ type: 'lease-acquire', clientId: 'client_editor' })
    );
    expect(values.has('room:edit-lease')).toBe(true);

    const restarted = new ProjectCollaborationRoom(context, roomEnv);
    const response = await restarted.fetch(
      new Request(
        `https://project-room.internal/?projectId=${base.projectId}`,
        {
          method: 'PATCH',
          headers: {
            'x-openzcad-internal-owner-collaboration-disabled': 'v1'
          }
        }
      )
    );

    expect(response.status).toBe(204);
    expect(values.has('room:edit-lease')).toBe(false);
  });

  it('rejects a pre-issued member ticket after the owner disables collaboration', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Disabled ticket room',
      toUserId('user_room')
    );
    let collaborationEnabled = true;
    const room = new ProjectCollaborationRoom(context, {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development',
      DB: {
        prepare: (query: string) => ({
          bind: () => ({
            first: async () => {
              if (query.includes('account_erasure_requests')) {
                return null;
              }
              if (query.includes('SELECT user_id FROM projects')) {
                return null;
              }
              return {
                role: 'viewer',
                collaboration_enabled: collaborationEnabled ? 1 : 0
              };
            }
          })
        })
      }
    });
    const issued = await issueSocketTicket(room, base.projectId, {
      userId: 'user_ticket_viewer',
      displayName: 'Ticket viewer',
      role: 'viewer'
    });
    collaborationEnabled = false;

    const response = await room.fetch(
      new Request(
        `https://room.test/?projectId=${base.projectId}&ticket=${issued.ticket}`,
        { headers: { upgrade: 'websocket' } }
      )
    );

    expect(response.status).toBe(401);
  });

  it('stores only a hash and consumes a native socket ticket once', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Ticket room', toUserId('user_room'));
    const room = new ProjectCollaborationRoom(context, {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development'
    });
    const issued = await issueSocketTicket(room, base.projectId);

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(values.get('room:socket-tickets'))).not.toContain(
      issued.ticket
    );

    // Recreate the object to prove pending tickets survive normal DO eviction.
    const restored = new ProjectCollaborationRoom(context, {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development'
    });
    const upgrade = () =>
      restored.fetch(
        new Request(
          `https://room.test/?projectId=${base.projectId}&ticket=${issued.ticket}`,
          { headers: { upgrade: 'websocket' } }
        )
      );
    expect((await upgrade()).status).toBe(101);
    expect((await upgrade()).status).toBe(401);
    expect(values.has('room:socket-tickets')).toBe(false);
  });

  it('rejects expired and forged native socket tickets before opening a socket', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Expired ticket', toUserId('user_room'));
    const room = new ProjectCollaborationRoom(context, {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development'
    });
    const issued = await issueSocketTicket(room, base.projectId);
    const pending = structuredClone(
      values.get('room:socket-tickets') as Record<string, { expiresAt: number }>
    );
    for (const claim of Object.values(pending)) {
      claim.expiresAt = Date.now() - 1;
    }
    values.set('room:socket-tickets', pending);
    const socketsBefore = globals.serverSockets.length;

    const expired = await room.fetch(
      new Request(
        `https://room.test/?projectId=${base.projectId}&ticket=${issued.ticket}`,
        { headers: { upgrade: 'websocket' } }
      )
    );
    const forged = await room.fetch(
      new Request(
        `https://room.test/?projectId=${base.projectId}&ticket=${'f'.repeat(43)}`,
        { headers: { upgrade: 'websocket' } }
      )
    );

    expect(expired.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(globals.serverSockets).toHaveLength(socketsBefore);
  });

  it('serves room state over an accepted socket', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Socket Room', toUserId('user_room'));
    const room = new ProjectCollaborationRoom(context, {});
    const socket = await openSocket(room, base.projectId);

    await socket.receive(hello(base));

    const frames = socket.frames();
    expect(frames.at(0)).toMatchObject({ type: 'ack', version: base.version });
    expect(frames.at(1)).toMatchObject({ type: 'state' });
    expect(socket.closed).toBeNull();
  });

  it('answers a hostile payload with an error frame and stays live', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Hostile Room', toUserId('user_room'));
    const room = new ProjectCollaborationRoom(context, {});
    const socket = await openSocket(room, base.projectId);
    await socket.receive(hello(base));
    socket.sent.length = 0;

    await socket.receive(deeplyNestedDocumentFrame(2_000));

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: 'document-too-complex'
    });
    // The whole point of a typed frame over a dropped connection: the client
    // learns its submission failed and keeps collaborating.
    expect(socket.closed).toBeNull();

    socket.sent.length = 0;
    const next = addPrimitiveFeature(base, {
      name: 'After',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    await socket.receive(documentFrame(next));
    expect(socket.lastFrame()).toMatchObject({
      type: 'ack',
      version: next.version
    });
  });

  it('rejects a merge that would outgrow one storage value', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Bulk Room', toUserId('user_room'));
    // Each peer's document fits a socket frame on its own; only the merged
    // result is unstorable, which is why the size guard has to run against the
    // resolved document rather than the submitted one.
    const fromA = addPrimitiveFeature(base, {
      name: 'A'.repeat(400_000),
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const fromB = addPrimitiveFeature(base, {
      name: 'B'.repeat(400_000),
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });

    const room = new ProjectCollaborationRoom(context, {});
    const socket = await openSocket(room, base.projectId);
    await socket.receive(hello(base));
    await socket.receive(documentFrame(fromA, base.version));
    expect(socket.lastFrame()).toMatchObject({ type: 'ack' });
    socket.sent.length = 0;

    await socket.receive(documentFrame(fromB, base.version));

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: 'document-too-large'
    });
    expect(socket.closed).toBeNull();
    // Nothing moved: the room still serves — and still stores — the document
    // it had before the oversize merge.
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      fromA.version
    );
  });

  it('reports a failed write instead of leaving the sender unanswered', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Broken Room', toUserId('user_room'));
    const room = new ProjectCollaborationRoom(context, {});
    const socket = await openSocket(room, base.projectId);
    await socket.receive(hello(base));
    socket.sent.length = 0;

    const failure = new Error('storage unavailable');
    const put = context.storage.put;
    context.storage.put = () => Promise.reject(failure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const next = addPrimitiveFeature(base, {
      name: 'Doomed',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    await socket.receive(documentFrame(next));

    expect(socket.lastFrame()).toMatchObject({
      type: 'error',
      code: 'internal'
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    context.storage.put = put;

    // In-memory state rolled back to what storage still holds, so a later
    // eviction cannot silently rewind the room.
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      base.version
    );
    socket.sent.length = 0;
    await socket.receive(documentFrame(next));
    expect(socket.lastFrame()).toMatchObject({
      type: 'ack',
      version: next.version
    });
    expect((values.get('room:latest') as ProjectDocument).version).toBe(
      next.version
    );
  });

  it('closes a socket whose raw message exceeds the frame ceiling', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Flood Room', toUserId('user_room'));
    const room = new ProjectCollaborationRoom(context, {});
    const socket = await openSocket(room, base.projectId);

    await socket.receive('x'.repeat(950_001));

    expect(socket.closed).toMatchObject({ code: 1009 });
  });
});
