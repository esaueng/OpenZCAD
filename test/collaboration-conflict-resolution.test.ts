import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type CollaborationServerMessage } from '@openzcad/shared';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';

let globals: ReturnType<typeof installWorkerSocketGlobals>;
beforeAll(() => {
  globals = installWorkerSocketGlobals();
});
afterAll(() => globals.restore());

async function recoveryRoom(localVersion = 28, remoteVersion = 26) {
  const base = createProjectDocument('Part (Recovery)', toUserId('user_owner'));
  const remote = {
    ...base,
    version: remoteVersion,
    revisions: [],
    checkpoints: []
  };
  const local = {
    ...addPrimitiveFeature(base, {
      name: 'Kept box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 2, depth: 3 }
    }),
    version: localVersion,
    revisions: [],
    checkpoints: []
  };
  const storage = createRoomContext();
  const room = createTestRoom(storage.context, {
    PROJECT_EDIT_LEASES_ENFORCED: 'true'
  });
  const headers = {
    'x-openzcad-user-id': 'user_owner',
    'x-openzcad-display-name': 'Owner',
    'x-openzcad-project-role': 'owner'
  };
  const url = `https://room.test/?projectId=${base.projectId}`;
  await room.fetch(
    new Request(url, { headers: { ...headers, upgrade: 'websocket' } })
  );
  const socket = globals.serverSockets.at(-1)!;
  await socket.receive(
    JSON.stringify({
      type: 'hello',
      clientId: 'client_owner',
      displayName: 'Owner',
      document: null,
      baseVersion: null
    })
  );
  await socket.receive(
    JSON.stringify({ type: 'lease-acquire', clientId: 'client_owner' })
  );
  const granted = socket.lastFrame() as Extract<
    CollaborationServerMessage,
    { type: 'lease-granted' }
  >;
  expect(granted.type).toBe('lease-granted');
  const body = {
    clientId: 'client_owner',
    baseVersion: remote.version,
    document: local,
    leaseId: granted.lease.leaseId
  };
  await socket.receive(
    JSON.stringify({
      ...body,
      type: 'document',
      document: remote,
      baseVersion: null
    })
  );
  expect(socket.lastFrame()?.type).toBe('ack');
  return { room, socket, local, remote, body, headers, url };
}

describe('explicit Keep this device’s version', () => {
  for (const transport of ['socket', 'http'] as const) {
    it.each([
      [28, 26],
      [26, 26],
      [24, 26]
    ])(
      `${transport} keeps a revisionless divergent document (%i vs %i)`,
      async (localVersion, remoteVersion) => {
        const { room, socket, local, remote, body, headers, url } =
          await recoveryRoom(localVersion, remoteVersion);
        // Merely seeing the current room version is not consent to replace it.
        await socket.receive(JSON.stringify({ ...body, type: 'document' }));
        expect(socket.lastFrame()?.type).toBe('conflict');
        let ack: CollaborationServerMessage;
        if (transport === 'socket') {
          await socket.receive(
            JSON.stringify({
              ...body,
              type: 'document',
              conflictResolution: 'keep-local'
            })
          );
          ack = socket.lastFrame()!;
        } else {
          const response = await room.fetch(
            new Request(url, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                ...body,
                conflictResolution: 'keep-local'
              })
            })
          );
          expect(response.status).toBe(200);
          ack = (await response.json()) as CollaborationServerMessage;
        }
        expect(ack.type).toBe('ack');
        const committed = (
          ack as Extract<CollaborationServerMessage, { type: 'ack' }>
        ).document!;
        expect(committed.featureOrder).toEqual(local.featureOrder);
        expect(committed.version).toBe(
          Math.max(local.version, remote.version) + 1
        );
        expect(committed.revisions).toHaveLength(1);
        expect(committed.checkpoints.at(-1)?.reason).toBe(
          'Kept this device’s version'
        );
        // The committed revision establishes real lineage for the next edit.
        const manager = new CommandManager(committed);
        const edited = manager.execute(
          commandFactories.addPrimitive({
            name: 'Next box',
            primitiveKind: 'box',
            dimensions: { width: 2, height: 2, depth: 2 }
          })
        );
        await socket.receive(
          JSON.stringify({
            ...body,
            type: 'document',
            baseVersion: committed.version,
            document: edited
          })
        );
        expect(socket.lastFrame()?.type).toBe('ack');
      }
    );

    it(`${transport} refuses a stale conflict decision`, async () => {
      const { room, socket, remote, body, headers, url } = await recoveryRoom();
      const stale = {
        ...body,
        baseVersion: remote.version - 1,
        conflictResolution: 'keep-local'
      };
      if (transport === 'socket') {
        await socket.receive(JSON.stringify({ ...stale, type: 'document' }));
        expect(socket.lastFrame()).toMatchObject({
          type: 'conflict',
          document: { version: remote.version }
        });
      } else {
        const response = await room.fetch(
          new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(stale)
          })
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          type: 'conflict',
          document: { version: remote.version }
        });
      }
    });

    it(`${transport} retains the active lease requirement`, async () => {
      const { room, socket, body, headers, url } = await recoveryRoom();
      const invalid = {
        ...body,
        leaseId: 'other_lease',
        conflictResolution: 'keep-local'
      };
      if (transport === 'socket') {
        await socket.receive(JSON.stringify({ ...invalid, type: 'document' }));
        expect(socket.lastFrame()).toMatchObject({
          type: 'error',
          code: 'lease-required'
        });
      } else {
        const response = await room.fetch(
          new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(invalid)
          })
        );
        expect(response.ok).toBe(false);
        expect(await response.json()).toMatchObject({
          type: 'error',
          code: 'lease-required'
        });
      }
    });

    it(`${transport} refuses another owner's document`, async () => {
      const { room, socket, body, headers, url } = await recoveryRoom();
      const invalid = {
        ...body,
        document: { ...body.document, ownerUserId: toUserId('user_other') },
        conflictResolution: 'keep-local'
      };
      if (transport === 'socket') {
        await socket.receive(JSON.stringify({ ...invalid, type: 'document' }));
        expect(socket.lastFrame()).toMatchObject({
          type: 'error',
          code: 'document-invalid'
        });
      } else {
        const response = await room.fetch(
          new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(invalid)
          })
        );
        expect(response.ok).toBe(false);
        expect(await response.json()).toMatchObject({
          type: 'error',
          code: 'document-invalid'
        });
      }
    });

    it(`${transport} refuses a viewer's replacement`, async () => {
      const { room, body, headers, url } = await recoveryRoom();
      const viewerHeaders = {
        ...headers,
        'x-openzcad-user-id': 'user_viewer',
        'x-openzcad-project-role': 'viewer'
      };
      const replacement = {
        ...body,
        clientId: 'client_viewer',
        conflictResolution: 'keep-local'
      };
      if (transport === 'socket') {
        await room.fetch(
          new Request(url, {
            headers: { ...viewerHeaders, upgrade: 'websocket' }
          })
        );
        const viewer = globals.serverSockets.at(-1)!;
        await viewer.receive(
          JSON.stringify({
            type: 'hello',
            clientId: 'client_viewer',
            displayName: 'Viewer',
            baseVersion: null,
            document: null
          })
        );
        await viewer.receive(
          JSON.stringify({ ...replacement, type: 'document' })
        );
        expect(viewer.lastFrame()).toMatchObject({
          type: 'error',
          code: 'permission-denied'
        });
      } else {
        const response = await room.fetch(
          new Request(url, {
            method: 'POST',
            headers: viewerHeaders,
            body: JSON.stringify(replacement)
          })
        );
        expect(response.ok).toBe(false);
        expect(await response.json()).toMatchObject({
          type: 'error',
          code: 'permission-denied'
        });
      }
    });
  }
});
