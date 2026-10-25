import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectCollaborationRoom } from '@openzcad/cloudflare-adapters';
import {
  toUserId,
  type CollaborationServerMessage,
  type E2eeCollaborationServerMessage,
  type ProjectDocument
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  createProjectDocument,
  mergeCollaborationDocuments
} from '@openzcad/document-core';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals,
  type FakeWebSocket
} from './collaboration-room-harness';
import {
  b64,
  createEncryptedRoom,
  fakeE2eeAccount,
  submission,
  type FakeHeader
} from './support/e2ee-room-fakes';

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
  it('counts frames without client identity before JSON parsing and resets after one second', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const { context } = createRoomContext();
      const room = createTestRoom(context, {});
      const socket = await openSocket(room, 'proj_frame_limit');
      const parse = vi.spyOn(JSON, 'parse');
      try {
        for (let i = 0; i < 30; i++) await socket.receive('{}');
        expect(socket.closed).toBeNull();
        now.mockReturnValue(2_000);
        await socket.receive('{}');
        expect(socket.closed).toBeNull();
        for (let i = 0; i < 29; i++) await socket.receive('{}');
        const parsedBeforeLimit = parse.mock.calls.length;
        await socket.receive('{}');
        expect(socket.closed).toEqual({
          code: 1008,
          reason: 'Collaboration message rate limit reached.'
        });
        expect(parse.mock.calls.length).toBe(parsedBeforeLimit);
      } finally {
        parse.mockRestore();
      }
    } finally {
      now.mockRestore();
    }
  });
  it('restores open sockets and presence after hibernation', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Sleeping room', toUserId('user_room'));
    const original = createTestRoom(context, {});
    const owner = await openSocket(original, base.projectId);
    await owner.receive(hello(base, 'owner'));
    const viewer = await openSocket(original, base.projectId, {
      userId: 'viewer',
      displayName: 'Viewer',
      role: 'viewer'
    });
    await viewer.receive(hello(null, 'viewer-client'));
    await viewer.receive(
      JSON.stringify({
        type: 'presence',
        clientId: 'viewer-client',
        status: 'idle'
      })
    );
    const attachmentWrites = viewer.attachmentWrites;
    await viewer.receive(
      JSON.stringify({
        type: 'presence',
        clientId: 'viewer-client',
        status: 'idle'
      })
    );
    expect(viewer.attachmentWrites).toBe(attachmentWrites);

    const restored = createTestRoom(context, {});
    expect((await restored.snapshot()).members).toContainEqual([
      'viewer-client',
      'idle'
    ]);
    viewer.sent.length = 0;
    const edited = addPrimitiveFeature(base, {
      name: 'After wake',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    await owner.receive(documentFrame(edited, base.version, 'owner'));
    expect(viewer.frames()).toContainEqual({
      type: 'document',
      clientId: 'owner',
      document: edited
    });

    restored.webSocketClose(viewer as unknown as WebSocket);
    expect((await restored.snapshot()).members).not.toContainEqual([
      'viewer-client',
      'idle'
    ]);
  });

  it('accepts hello after hibernating before the first message', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Pending hello', toUserId('user_room'));
    const original = createTestRoom(context, {});
    const socket = await openSocket(original, base.projectId);
    createTestRoom(context, {});

    await socket.receive(hello(base));
    expect(socket.frames()).toContainEqual(
      expect.objectContaining({ type: 'state', role: 'owner' })
    );
  });

  it('loads document history only when a woken room receives an edit', async () => {
    const storage = createRoomContext();
    const base = createProjectDocument(
      'History on demand',
      toUserId('user_room')
    );
    const original = createTestRoom(storage.context, {});
    const socket = await openSocket(original, base.projectId);
    await socket.receive(hello(base));
    storage.reads.length = 0;
    createTestRoom(storage.context, {});

    await socket.receive(
      JSON.stringify({
        type: 'presence',
        clientId: 'client_ws',
        status: 'idle'
      })
    );
    expect(storage.reads.some((key) => key.startsWith('room:history:'))).toBe(
      false
    );

    const edited = addPrimitiveFeature(base, {
      name: 'History after wake',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    await socket.receive(documentFrame(edited, base.version));
    expect(storage.reads.some((key) => key.startsWith('room:history:'))).toBe(
      true
    );
    expect(socket.lastFrame()).toMatchObject({ type: 'ack' });
  });

  it('closes a restored socket with missing identity', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Missing identity',
      toUserId('user_room')
    );
    const original = createTestRoom(context, {});
    const socket = await openSocket(original, base.projectId);
    socket.serializeAttachment({ schema: 0 });
    createTestRoom(context, {});

    expect(socket.closed).toEqual({
      code: 1008,
      reason: 'Collaboration identity is unavailable.'
    });
  });

  it('broadcasts an accepted reconnect document to existing peers', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Reconnect room', toUserId('user_room'));
    const room = createTestRoom(context, {});
    const existing = await openSocket(room, base.projectId);
    await existing.receive(hello(base, 'existing'));
    existing.sent.length = 0;

    const reconnecting = await openSocket(room, base.projectId);
    const edited = addPrimitiveFeature(base, {
      name: 'Offline edit',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    await reconnecting.receive(hello(edited, 'reconnecting'));

    expect(values.get('room:latest')).toMatchObject({
      version: edited.version
    });
    expect(
      existing.frames().filter((frame) => frame.type === 'document')
    ).toEqual([
      { type: 'document', clientId: 'reconnecting', document: edited }
    ]);
    expect(reconnecting.frames()).toContainEqual({
      type: 'ack',
      version: edited.version
    });

    existing.sent.length = 0;
    await reconnecting.receive(hello(edited, 'reconnecting'));
    expect(
      existing.frames().filter((frame) => frame.type === 'document')
    ).toEqual([]);
  });

  it('closes sockets and deletes every stored value during internal erasure', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Erased room', toUserId('user_room'));
    const room = createTestRoom(context, {
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

  it('refuses a snapshot whose body finishes after erasure and closes sockets before hello', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Pending erase', toUserId('user_room'));
    const room = createTestRoom(context, {});
    const pendingSocket = await openSocket(room, base.projectId);
    let release!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ clientId: 'late', document: base })
            )
          );
          controller.close();
        };
      }
    });
    const pending = room.fetch(
      new Request(`https://room.test/?projectId=${base.projectId}`, {
        method: 'POST',
        headers: {
          'x-openzcad-user-id': 'user_room',
          'x-openzcad-display-name': 'Owner',
          'x-openzcad-project-role': 'owner'
        },
        body,
        duplex: 'half'
      } as RequestInit)
    );
    const erased = await room.fetch(
      new Request(`https://room.test/?projectId=${base.projectId}`, {
        method: 'DELETE',
        headers: { 'x-openzcad-internal-project-erasure': 'v1' }
      })
    );
    expect(erased.status).toBe(204);
    expect(pendingSocket.closed?.code).toBe(4001);
    release();
    expect((await pending).status).toBe(410);
    expect(values.size).toBe(0);
  });

  it('serializes an in-flight socket ticket before erasing its identity data', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Ticket erase', toUserId('user_room'));
    const room = createTestRoom(context, {});
    let release!: () => void;
    let signal!: () => void;
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const originalGet = context.storage.get.bind(context.storage);
    vi.spyOn(context.storage, 'get').mockImplementation(async (key: string) => {
      if (key === 'room:socket-tickets') {
        signal();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return originalGet(key);
    });
    const pending = room.fetch(
      new Request(`https://room.test/?projectId=${base.projectId}`, {
        method: 'PUT',
        headers: {
          'x-openzcad-internal-ticket-request': 'v1',
          'x-openzcad-user-id': 'user_room',
          'x-openzcad-display-name': 'Owner',
          'x-openzcad-project-role': 'owner'
        }
      })
    );
    await entered;
    const erased = room.fetch(
      new Request(`https://room.test/?projectId=${base.projectId}`, {
        method: 'DELETE',
        headers: { 'x-openzcad-internal-project-erasure': 'v1' }
      })
    );
    release();
    expect((await pending).status).toBe(200);
    expect((await erased).status).toBe(204);
    expect(values.size).toBe(0);
    vi.restoreAllMocks();
  });

  it('fails hosted room access closed outside the account canary', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Canary room', toUserId('user_room'));
    const roomEnv = {
      ENVIRONMENT: 'beta' as const,
      PRODUCTION_GUARD: 'enabled',
      PROJECT_COLLABORATION_CANARY_EMAILS: 'allowed@example.com'
    };
    const room = createTestRoom(context, roomEnv);
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
    const roomEnv = {
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            all: async () => {
              expect(sql).toContain('FROM project_copy_source_archives');
              return { results: [] };
            },
            first: async () =>
              sql.includes('user_id AS owner_user_id')
                ? { owner_user_id: 'user_room' }
                : sql.startsWith('SELECT 1 AS allowed')
                  ? { allowed: 1 }
                  : sql.startsWith(
                        'SELECT user_id, document_version FROM projects'
                      )
                    ? { user_id: 'user_room' }
                    : memberRole
                      ? { role: memberRole, collaboration_enabled: 1 }
                      : null
          })
        })
      }
    };
    const room = createTestRoom(context, roomEnv);
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
    createTestRoom(context, roomEnv);

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

  it('refuses a pending ticket and closes a live member socket after trashing', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Trashed room', toUserId('user_room'));
    let trashed = false;
    const room = createTestRoom(context, {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development',
      DB: {
        prepare: (query: string) => ({
          bind: () => ({
            all: async () => {
              expect(query).toContain('FROM project_copy_source_archives');
              return { results: [] };
            },
            first: async () => {
              // The storage-format schema probe answers "not installed".
              if (query.includes('pragma_table_info')) return null;
              if (query.includes('user_id AS owner_user_id'))
                return { owner_user_id: 'user_room' };
              if (query.startsWith('SELECT 1 AS allowed'))
                return { allowed: 1 };
              if (query.includes('account_erasure_requests')) return null;
              if (query.includes('SELECT user_id'))
                return query.includes('AND user_id')
                  ? null
                  : { user_id: 'user_room' };
              expect(query).toContain("p.status != 'deleted'");
              return trashed
                ? null
                : { role: 'viewer', collaboration_enabled: 1 };
            }
          })
        })
      }
    });
    const owner = await openSocket(room, base.projectId);
    await owner.receive(hello(base, 'client_owner'));
    const identity = {
      userId: 'user_trash_viewer',
      displayName: 'Trashed viewer',
      role: 'viewer' as const
    };
    const member = await openSocket(room, base.projectId, identity);
    await member.receive(hello(null, 'client_member'));
    const issued = await issueSocketTicket(room, base.projectId, identity);
    trashed = true;

    const ticketResponse = await room.fetch(
      new Request(
        `https://room.test/?projectId=${base.projectId}&ticket=${issued.ticket}`,
        { headers: { upgrade: 'websocket' } }
      )
    );
    expect(ticketResponse.status).toBe(401);

    const next = addPrimitiveFeature(base, {
      name: 'Private after trash',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    member.sent.length = 0;
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
    const room = createTestRoom(context, {
      DB: {
        prepare: (sql: string) => ({
          bind: (_projectId: string, userId: string) => ({
            all: async () => {
              expect(sql).toContain('FROM project_copy_source_archives');
              return { results: [] };
            },
            first: async () => {
              if (sql.includes('user_id AS owner_user_id'))
                return { owner_user_id: 'user_room' };
              if (sql.startsWith('SELECT 1 AS allowed')) return { allowed: 1 };
              if (
                sql.startsWith(
                  'SELECT user_id, document_version FROM projects'
                ) &&
                !sql.includes('AND user_id')
              )
                return { user_id: 'user_room' };
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
    const room = createTestRoom(context, {
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
    const room = createTestRoom(context, {});
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
            'x-openzcad-internal-role-update': 'v1',
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
    const room = createTestRoom(context, roomEnv);
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

    const restarted = createTestRoom(context, roomEnv);
    const response = await restarted.fetch(
      new Request(
        `https://project-room.internal/?projectId=${base.projectId}`,
        {
          method: 'PATCH',
          headers: {
            'x-openzcad-internal-role-update': 'v1',
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
    const room = createTestRoom(context, {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development',
      DB: {
        prepare: (query: string) => ({
          bind: () => ({
            first: async () => {
              if (query.includes('account_erasure_requests')) {
                return null;
              }
              if (query.includes('SELECT user_id')) {
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
    const room = createTestRoom(context, {
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
    const restored = createTestRoom(context, {
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
    const room = createTestRoom(context, {
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
    const room = createTestRoom(context, {});
    const socket = await openSocket(room, base.projectId);

    await socket.receive(hello(base));

    const frames = socket.frames();
    expect(frames.at(0)).toMatchObject({ type: 'ack', version: base.version });
    expect(frames.at(1)).toMatchObject({ type: 'state' });
    expect(socket.closed).toBeNull();
  });

  it.each([
    ['huge version', { version: 1e308 }],
    ['string version', { version: '99' }],
    ['fractional version', { version: 1.5 }],
    ['negative version', { version: -1 }],
    ['foreign owner', { ownerUserId: 'attacker' }],
    ['missing nodes', { nodes: null }],
    ['array nodes', { nodes: [] }],
    ['missing command log', { commandLog: null }]
  ])(
    'refuses %s over sockets and HTTP without changing durable state',
    async (_name, malicious) => {
      const { context, values } = createRoomContext();
      const base = createProjectDocument('Safe room', toUserId('user_room'));
      const room = createTestRoom(context, {});
      const socket = await openSocket(room, base.projectId);
      await socket.receive(hello(base));
      const stored = structuredClone(values.get('room:latest'));
      const document = {
        ...base,
        version: base.version + 1,
        ...malicious
      } as ProjectDocument;
      await socket.receive(documentFrame(document));
      expect(socket.lastFrame()).toMatchObject({
        type: 'error',
        code: 'document-invalid'
      });
      const response = await room.fetch(
        new Request(`https://room.test/?projectId=${base.projectId}`, {
          method: 'POST',
          headers: {
            'x-openzcad-user-id': 'user_room',
            'x-openzcad-display-name': 'Owner',
            'x-openzcad-project-role': 'owner'
          },
          body: JSON.stringify({ clientId: 'http', document })
        })
      );
      expect(response.status).toBe(400);
      expect(values.get('room:latest')).toEqual(stored);
      expect(socket.closed).toBeNull();
    }
  );

  it('caps connections before hello and retains the cap across hibernation', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Capped room', toUserId('user_room'));
    let room = createTestRoom(context, {});
    for (let i = 0; i < 8; i++) await openSocket(room, base.projectId);
    expect((await room.fetch(upgradeRequest(base.projectId))).status).toBe(429);
    room = createTestRoom(context, {});
    expect((await room.fetch(upgradeRequest(base.projectId))).status).toBe(429);
  });

  it('refuses presence identity collisions and repeated identity changes', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument(
      'Bound identities',
      toUserId('user_room')
    );
    const room = createTestRoom(context, {});
    const first = await openSocket(room, base.projectId);
    await first.receive(hello(base, 'same-client'));
    const second = await openSocket(room, base.projectId, {
      userId: 'viewer',
      displayName: 'Viewer',
      role: 'viewer'
    });
    await second.receive(hello(null, 'same-client'));
    expect(second.closed?.code).toBe(1008);
    await first.receive(hello(null, 'other-client'));
    expect(first.closed?.code).toBe(1008);
  });

  it('answers a hostile payload with an error frame and stays live', async () => {
    const { context } = createRoomContext();
    const base = createProjectDocument('Hostile Room', toUserId('user_room'));
    const room = createTestRoom(context, {});
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

  it('rejects a browser merge that would outgrow one storage value', async () => {
    const { context, values } = createRoomContext();
    const base = createProjectDocument('Bulk Room', toUserId('user_room'));
    // Each peer's document fits a socket frame on its own; only the merged
    // result is unstorable, so the size guard has to run on the resubmission
    // the browser builds from the conflict's base.
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

    for (const [document, padding] of [
      [fromA, 'A'],
      [fromB, 'B']
    ] as const) {
      for (const node of Object.values(document.nodes)) {
        if (node.kind === 'feature' || node.kind === 'body') {
          node.metadata = {
            ...node.metadata,
            testPadding: padding.repeat(400_000)
          };
        }
      }
    }

    const room = createTestRoom(context, {});
    const socket = await openSocket(room, base.projectId);
    await socket.receive(hello(base));
    await socket.receive(documentFrame(fromA, base.version));
    expect(socket.lastFrame()).toMatchObject({ type: 'ack' });
    socket.sent.length = 0;

    await socket.receive(documentFrame(fromB, base.version));
    const conflict = socket.lastFrame() as {
      type: string;
      document: ProjectDocument;
      base?: ProjectDocument;
    };
    expect(conflict.type).toBe('conflict');
    const merged = mergeCollaborationDocuments(
      conflict.base!,
      conflict.document,
      fromB
    )!;
    // The merged document is too large for a socket frame, so the browser
    // resubmits it over HTTP, as it does any oversize edit.
    const resubmitted = await room.fetch(
      new Request(`https://room.test/?projectId=${base.projectId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openzcad-user-id': ownerIdentity.userId,
          'x-openzcad-display-name': ownerIdentity.displayName,
          'x-openzcad-project-role': ownerIdentity.role
        },
        body: JSON.stringify({
          clientId: 'client_ws',
          baseVersion: fromA.version,
          document: merged
        })
      })
    );

    await expect(resubmitted.json()).resolves.toMatchObject({
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
    const room = createTestRoom(context, {});
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
    const room = createTestRoom(context, {});
    const socket = await openSocket(room, base.projectId);

    await socket.receive('x'.repeat(950_001));

    expect(socket.closed).toMatchObject({ code: 1009 });
  });
});

// --- End-to-end encrypted projects (ADR-024 slice 4-9) ---------------------

const PROJECT = 'proj_encrypted_room';
const CREDENTIAL = `auth_sessions:${'a'.repeat(64)}`;

function encryptedUpgrade(
  projectId = PROJECT,
  identity: SocketIdentity = ownerIdentity
): Request {
  const request = upgradeRequest(projectId, identity);
  request.headers.set('x-openzcad-project-format', '2');
  request.headers.set('x-openzcad-write-credential', CREDENTIAL);
  return request;
}

async function openEncrypted(
  room: ProjectCollaborationRoom,
  clientId: string,
  identity: SocketIdentity = ownerIdentity
): Promise<FakeWebSocket> {
  const response = await room.fetch(encryptedUpgrade(PROJECT, identity));
  expect(response.status).toBe(101);
  const socket = globals.serverSockets.at(-1)!;
  await socket.receive(hello(null, clientId));
  await socket.receive(JSON.stringify({ type: 'lease-acquire', clientId }));
  return socket;
}

function e2eeFrame(
  clientId: string,
  header: Omit<FakeHeader, 'projectId'> & { projectId?: string }
) {
  return JSON.stringify({
    type: 'e2ee-document',
    clientId,
    version: submission({ projectId: PROJECT, ...header })
  });
}

function e2eeFrames(socket: FakeWebSocket) {
  return socket.sent.map(
    (frame) =>
      JSON.parse(frame) as
        E2eeCollaborationServerMessage | CollaborationServerMessage
  );
}

function notice(room: ProjectCollaborationRoom, body: unknown, trusted = true) {
  return room.fetch(
    new Request(
      `https://project-room.internal/_internal/e2ee-notice?projectId=${PROJECT}`,
      {
        method: 'POST',
        headers: trusted ? { 'x-openzcad-internal-e2ee-notice': 'v1' } : {},
        body: JSON.stringify(body)
      }
    )
  );
}

describe('encrypted collaboration room (ADR-024 slice 4-9)', () => {
  it('relays envelopes in order and writes each to the account first', async () => {
    const { context, values } = createRoomContext();
    const account = fakeE2eeAccount(PROJECT);
    const room = createEncryptedRoom(context, account);
    const laptop = await openEncrypted(room, 'client_laptop');
    const desktop = await openEncrypted(room, 'client_desktop');
    const first = account.headRecord;

    // The first frame is the account's head, as ciphertext.
    const state = e2eeFrames(laptop).find(
      (frame) => frame.type === 'e2ee-state'
    );
    expect(state).toMatchObject({
      type: 'e2ee-state',
      role: 'owner',
      keyEpoch: 0,
      head: {
        record: first,
        envelope: b64(account.envelopeOf(first.versionHash)!)
      }
    });

    laptop.sent.length = 0;
    desktop.sent.length = 0;
    const second = {
      documentVersion: 2,
      keyEpoch: 0,
      previousVersionHash: first.versionHash,
      body: 'second'
    };
    await laptop.receive(e2eeFrame('client_laptop', second));
    const stored = account.headRecord;
    expect(stored.documentVersion).toBe(2);
    expect(account.writes).toEqual([
      {
        userId: 'user_room',
        credential: { table: 'auth_sessions', tokenHash: 'a'.repeat(64) },
        expectedVersion: 1,
        revisionId: null,
        versionHash: stored.versionHash
      }
    ]);
    expect(e2eeFrames(laptop)).toEqual([{ type: 'e2ee-ack', record: stored }]);
    expect(e2eeFrames(desktop)).toEqual([
      {
        type: 'e2ee-document',
        clientId: 'client_laptop',
        head: {
          record: stored,
          envelope: b64(account.envelopeOf(stored.versionHash)!)
        }
      }
    ]);
    // Encrypted versions live under keys of their own; no plaintext key.
    expect(values.has('room:latest')).toBe(false);
    expect(values.get('room:e2ee:meta')).toEqual({
      schema: 1,
      latest: stored.versionHash,
      retained: [first.versionHash]
    });
    expect(values.get('room:meta')).toMatchObject({ format: 2 });

    // The same envelope again is acknowledged, not written twice.
    laptop.sent.length = 0;
    await laptop.receive(e2eeFrame('client_laptop', second));
    expect(e2eeFrames(laptop)).toEqual([{ type: 'e2ee-ack', record: stored }]);
    expect(account.writes).toHaveLength(1);
  });

  it('answers a stale submission with its base and the latest, as ciphertext', async () => {
    const { context } = createRoomContext();
    const account = fakeE2eeAccount(PROJECT);
    const room = createEncryptedRoom(context, account);
    const laptop = await openEncrypted(room, 'client_laptop');
    const desktop = await openEncrypted(room, 'client_desktop');
    const first = account.headRecord;
    await laptop.receive(
      e2eeFrame('client_laptop', {
        documentVersion: 2,
        keyEpoch: 0,
        previousVersionHash: first.versionHash,
        body: 'laptop'
      })
    );
    const latest = account.headRecord;

    // The desktop's edit builds on version 1, which the room has moved past,
    // however large its version number.
    desktop.sent.length = 0;
    await desktop.receive(
      e2eeFrame('client_desktop', {
        documentVersion: 9,
        keyEpoch: 0,
        previousVersionHash: first.versionHash,
        body: 'desktop'
      })
    );
    expect(e2eeFrames(desktop)).toEqual([
      {
        type: 'e2ee-conflict',
        latest: {
          record: latest,
          envelope: b64(account.envelopeOf(latest.versionHash)!)
        },
        base: {
          record: first,
          envelope: b64(account.envelopeOf(first.versionHash)!)
        }
      }
    ]);
    expect(account.writes).toHaveLength(1);

    // A base the room never held: the latest only, for the manual choice.
    desktop.sent.length = 0;
    await desktop.receive(
      e2eeFrame('client_desktop', {
        documentVersion: 3,
        keyEpoch: 0,
        previousVersionHash: 'f'.repeat(64),
        body: 'unknown base'
      })
    );
    const conflict = e2eeFrames(desktop)[0]!;
    expect(conflict.type).toBe('e2ee-conflict');
    expect(conflict).not.toHaveProperty('base');
  });

  it('refuses a head built under an older key epoch than the group’s', async () => {
    const { context } = createRoomContext();
    const account = fakeE2eeAccount(PROJECT);
    const room = createEncryptedRoom(context, account);
    const laptop = await openEncrypted(room, 'client_laptop');
    account.keyEpoch = 1; // a Commit landed
    const on = (keyEpoch: number, body: string) =>
      e2eeFrame('client_laptop', {
        documentVersion: 2,
        keyEpoch,
        previousVersionHash: account.headRecord.versionHash,
        body
      });
    laptop.sent.length = 0;
    await laptop.receive(on(0, 'old epoch'));
    expect(e2eeFrames(laptop)).toEqual([
      expect.objectContaining({ type: 'error', code: 'epoch-stale' })
    ]);
    expect(account.writes).toEqual([]);
    // A key epoch the group does not have is refused as well.
    laptop.sent.length = 0;
    await laptop.receive(on(5, 'future epoch'));
    expect(e2eeFrames(laptop)).toEqual([
      expect.objectContaining({ type: 'error', code: 'document-invalid' })
    ]);
    expect(account.writes).toEqual([]);
    // Under the current epoch it lands.
    laptop.sent.length = 0;
    await laptop.receive(on(1, 'current epoch'));
    expect(e2eeFrames(laptop)[0]).toMatchObject({ type: 'e2ee-ack' });
    expect(account.writes).toHaveLength(1);
  });

  it('refuses a plaintext document in an encrypted room', async () => {
    const { context, values } = createRoomContext();
    const account = fakeE2eeAccount(PROJECT);
    const room = createEncryptedRoom(context, account);
    const laptop = await openEncrypted(room, 'client_laptop');
    const plaintext = {
      ...createProjectDocument('Leak', toUserId('user_room')),
      projectId: PROJECT
    } as ProjectDocument;
    laptop.sent.length = 0;
    await laptop.receive(documentFrame(plaintext, null, 'client_laptop'));
    expect(e2eeFrames(laptop)).toEqual([
      expect.objectContaining({ type: 'error', code: 'format-mismatch' })
    ]);
    expect(values.has('room:latest')).toBe(false);
    expect(JSON.stringify([...values.values()])).not.toContain('Leak');

    // A plaintext socket cannot join the room once it is encrypted, across
    // a restart too.
    const restarted = createEncryptedRoom(context, account);
    expect((await restarted.fetch(upgradeRequest(PROJECT))).status).toBe(409);
  });

  it('refuses an envelope in a plaintext room, which never turns encrypted', async () => {
    const { context, values } = createRoomContext();
    const account = fakeE2eeAccount(PROJECT);
    const room = createEncryptedRoom(context, account);
    const plain = await openSocket(room, PROJECT);
    await plain.receive(hello(null, 'client_plain'));
    plain.sent.length = 0;
    await plain.receive(
      e2eeFrame('client_plain', {
        documentVersion: 2,
        keyEpoch: 0,
        previousVersionHash: account.headRecord.versionHash,
        body: 'envelope'
      })
    );
    expect(plain.lastFrame()).toMatchObject({
      type: 'error',
      code: 'format-mismatch'
    });
    expect(account.writes).toEqual([]);
    expect([...values.keys()].some((key) => key.startsWith('room:e2ee:'))).toBe(
      false
    );

    // Once the room holds a plaintext version, an encrypted request is refused.
    const base = {
      ...createProjectDocument('Plain', toUserId('user_room')),
      projectId: PROJECT
    } as ProjectDocument;
    await plain.receive(documentFrame(base, null, 'client_plain'));
    expect(values.has('room:latest')).toBe(true);
    expect((await room.fetch(encryptedUpgrade())).status).toBe(409);
  });

  it('serves the owner only, and only while encrypted projects are open', async () => {
    const account = fakeE2eeAccount(PROJECT);
    const closed = createEncryptedRoom(createRoomContext().context, account, {
      ENVIRONMENT: 'development',
      AUTH_MODE: 'development'
    });
    expect((await closed.fetch(encryptedUpgrade())).status).toBe(403);

    const room = createEncryptedRoom(createRoomContext().context, account);
    const editor = await room.fetch(
      encryptedUpgrade(PROJECT, { ...ownerIdentity, role: 'editor' })
    );
    expect(editor.status).toBe(101);
    const socket = globals.serverSockets.at(-1)!;
    await socket.receive(hello(null, 'client_editor'));
    expect(socket.closed).toMatchObject({ code: 1008 });
    expect(socket.sent.some((frame) => frame.includes('e2ee-state'))).toBe(
      false
    );
  });

  it('broadcasts a new key epoch after a Commit lands', async () => {
    const { context } = createRoomContext();
    const account = fakeE2eeAccount(PROJECT);
    const room = createEncryptedRoom(context, account);
    const laptop = await openEncrypted(room, 'client_laptop');
    const desktop = await openEncrypted(room, 'client_desktop');
    laptop.sent.length = 0;
    desktop.sent.length = 0;
    expect(
      (await notice(room, { kind: 'epoch', keyEpoch: 1 }, false)).status
    ).toBe(403);
    expect((await notice(room, { kind: 'epoch', keyEpoch: -1 })).status).toBe(
      400
    );
    expect((await notice(room, { kind: 'epoch', keyEpoch: 1 })).status).toBe(
      204
    );
    expect(e2eeFrames(laptop)).toEqual([{ type: 'e2ee-epoch', keyEpoch: 1 }]);
    expect(e2eeFrames(desktop)).toEqual([{ type: 'e2ee-epoch', keyEpoch: 1 }]);
  });

  it('follows the account when a version lands there outside the room', async () => {
    const { context } = createRoomContext();
    const account = fakeE2eeAccount(PROJECT);
    const room = createEncryptedRoom(context, account);
    const laptop = await openEncrypted(room, 'client_laptop');
    const first = account.headRecord;
    // A named save through the account's revision route.
    const named = account.writeOutside({
      projectId: PROJECT,
      documentVersion: 2,
      keyEpoch: 0,
      previousVersionHash: first.versionHash,
      body: 'named save'
    });
    laptop.sent.length = 0;
    expect((await notice(room, { kind: 'head' })).status).toBe(204);
    expect(e2eeFrames(laptop)).toEqual([
      {
        type: 'e2ee-document',
        clientId: 'account',
        head: {
          record: named,
          envelope: b64(account.envelopeOf(named.versionHash)!)
        }
      }
    ]);
    // An edit still on version 1 is merged with the named save.
    laptop.sent.length = 0;
    await laptop.receive(
      e2eeFrame('client_laptop', {
        documentVersion: 2,
        keyEpoch: 0,
        previousVersionHash: first.versionHash,
        body: 'stale edit'
      })
    );
    expect(e2eeFrames(laptop)[0]).toMatchObject({
      type: 'e2ee-conflict',
      latest: { record: named },
      base: { record: first }
    });
    expect(account.writes).toEqual([]);
  });
});
