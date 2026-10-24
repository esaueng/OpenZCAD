/**
 * The encrypted collaboration room (ADR-024 Phase 4, slice 4-9): two Node
 * devices of one owner run the real client modules (`encryptedProjectStore`,
 * `encryptedRoomCodec`, `projectGroups`) with the in-process MLS engine,
 * against the real Worker routes over SQLite and the Worker's own room class
 * (`apps/web/worker/e2eeRoom.ts`) on fake Durable Object storage.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createSavedRevision,
  mergeCollaborationDocuments
} from '@openzcad/document-core';
import type {
  CollaborationServerMessage,
  E2eeRoomSubmission,
  ProjectDocument
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import { ProjectCollaborationRoom } from '../apps/web/worker/e2eeRoom';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  createEncryptedRoomCodec,
  type EncryptedRoomCodec
} from '../apps/web/src/lib/e2ee/encryptedRoomCodec';
import {
  createRoomContext,
  installWorkerSocketGlobals,
  type FakeWebSocket
} from './collaboration-room-harness';
import {
  OTHER,
  OWNER,
  count,
  createEncrypted,
  device,
  makeAccount,
  newServer,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';

let owner: Account;
let other: Account;
let globals: ReturnType<typeof installWorkerSocketGlobals>;

beforeAll(async () => {
  globals = installWorkerSocketGlobals();
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, ['other_laptop']);
});

afterAll(() => {
  globals.restore();
});

afterEach(() => {
  forgetAllProjectKeys();
});

interface RoomServer extends Server {
  rooms: Map<string, ProjectCollaborationRoom>;
  /** Each room's Durable Object storage. */
  storage: Map<string, Map<string, unknown>>;
}

/** The real Worker with the Worker's room class behind PROJECT_ROOM. */
function roomServer(): RoomServer {
  const rooms = new Map<string, ProjectCollaborationRoom>();
  const storage = new Map<string, Map<string, unknown>>();
  let env: Record<string, unknown> = {};
  const namespace = {
    getByName: (name: string) => {
      let room = rooms.get(name);
      if (!room) {
        const { context, values } = createRoomContext();
        storage.set(name, values);
        room = new ProjectCollaborationRoom(context, env);
        context.activate(room);
        rooms.set(name, room);
      }
      return room;
    }
  };
  const srv = newServer([owner, other], undefined, {
    PROJECT_ROOM: namespace
  });
  env = srv.env;
  return Object.assign(srv, { rooms, storage });
}

const roomUrl = (projectId: string) =>
  `https://example.com/api/projects/${projectId}/collaboration`;

async function connect(
  projectId: string,
  env: Record<string, unknown>,
  user = OWNER
): Promise<Response> {
  return worker.fetch(
    new Request(roomUrl(projectId), {
      headers: {
        upgrade: 'websocket',
        origin: 'https://example.com',
        'x-openzcad-development-user': user
      }
    }),
    env
  );
}

/** One device's live room: its socket and its codec, as the hook drives them. */
interface Live {
  socket: FakeWebSocket;
  codec: EncryptedRoomCodec;
  clientId: string;
  /** Every frame the room sent, decoded by the codec, in order. */
  decoded: CollaborationServerMessage[];
  /** Decodes every frame not read yet. */
  read(): Promise<CollaborationServerMessage[]>;
  /** Waits for, and returns, the first new frame of `type`. */
  next<T extends CollaborationServerMessage['type']>(
    type: T
  ): Promise<Extract<CollaborationServerMessage, { type: T }>>;
  send(document: ProjectDocument, baseVersion: number): Promise<void>;
  sendSealed(submission: E2eeRoomSubmission): Promise<void>;
}

async function live(
  srv: RoomServer,
  d: Device,
  projectId: string,
  clientId: string
): Promise<Live> {
  const response = await connect(projectId, srv.env);
  expect(response.status).toBe(101);
  const socket = globals.serverSockets.at(-1)!;
  const codec = createEncryptedRoomCodec(d.store.roomAccess(), projectId);
  let seen = 0;
  const result: Live = {
    socket,
    codec,
    clientId,
    decoded: [],
    async read() {
      const fresh: CollaborationServerMessage[] = [];
      while (seen < socket.sent.length) {
        const { message } = await codec.decode(socket.sent[seen++]!);
        if (message) fresh.push(message);
      }
      result.decoded.push(...fresh);
      return fresh;
    },
    async next(type) {
      const deadline = Date.now() + 15_000;
      const fresh: CollaborationServerMessage[] = [];
      for (;;) {
        fresh.push(...(await result.read()));
        const found = fresh.find((frame) => frame.type === type);
        if (found) return found as never;
        if (Date.now() > deadline) {
          throw new Error(
            `No ${type} frame; saw ${JSON.stringify(fresh.map((f) => f.type))}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async send(document, baseVersion) {
      const encoded = await codec.encode(document, baseVersion);
      if (encoded.kind !== 'sealed') throw new Error('nothing to send');
      await result.sendSealed(encoded.submission);
    },
    async sendSealed(submission) {
      await socket.receive(
        JSON.stringify({ type: 'e2ee-document', clientId, version: submission })
      );
    }
  };
  await socket.receive(
    JSON.stringify({
      type: 'hello',
      clientId,
      displayName: 'Owner',
      baseVersion: null,
      document: null
    })
  );
  await socket.receive(JSON.stringify({ type: 'lease-acquire', clientId }));
  return result;
}

const withBox = (document: ProjectDocument, name: string) =>
  addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width: 1, height: 2, depth: 3 }
  });

/** Waits until the room has sent a raw frame matching `test`. */
async function rawFrame(
  socket: FakeWebSocket,
  test: (frame: Record<string, unknown>) => boolean
): Promise<number> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const index = socket.sent.findIndex((frame) =>
      test(JSON.parse(frame) as Record<string, unknown>)
    );
    if (index >= 0) return index;
    if (Date.now() > deadline) throw new Error('No such frame from the room.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const featureNames = (document: ProjectDocument) =>
  Object.values(document.nodes)
    .filter((node) => node.kind === 'feature')
    .map((node) => node.name);

/** A project the laptop created, open on both devices' live rooms. */
async function twoDevices(srv: RoomServer) {
  const laptop = device(srv, owner, 'owner_laptop');
  const created = await createEncrypted(laptop);
  const projectId = created.document.projectId;
  const desktop = device(srv, owner, 'owner_desktop');
  await desktop.store.loadProject(projectId);
  const a = await live(srv, laptop, projectId, 'client_laptop');
  const b = await live(srv, desktop, projectId, 'client_desktop');
  return { laptop, desktop, created: created.document, projectId, a, b };
}

describe('encrypted collaboration room (ADR-024 slice 4-9)', () => {
  it('relays a version between two devices of the owner, through the account', async () => {
    const srv = roomServer();
    const { desktop, laptop, created, projectId, a, b } = await twoDevices(srv);
    // Each first hears the account's head, decrypted and verified here.
    expect(await a.next('state')).toMatchObject({
      role: 'owner',
      document: { name: 'Bracket', version: created.version }
    });
    expect((await b.next('state')).document?.version).toBe(created.version);

    const next = withBox(created, 'Laptop box');
    await a.send(next, created.version);
    expect(await a.next('ack')).toEqual({ type: 'ack', version: next.version });
    // The room wrote it to the account's log before relaying it.
    expect(
      rows<{ document_version: number }>(
        srv,
        'SELECT document_version FROM e2ee_project_versions WHERE project_id = ? ORDER BY document_version',
        projectId
      ).map((row) => row.document_version)
    ).toEqual([created.version, next.version]);
    expect(await laptop.pins.read(OWNER, projectId)).toMatchObject({
      documentVersion: next.version
    });

    const relayed = await b.next('document');
    expect(relayed.clientId).toBe('client_laptop');
    expect(relayed.document.version).toBe(next.version);
    expect(featureNames(relayed.document)).toContain('Laptop box');
    // The desktop verified it as a current head: its pin moved.
    expect(await desktop.pins.read(OWNER, projectId)).toMatchObject({
      documentVersion: next.version
    });
    // A later account read on the desktop agrees with the room.
    expect((await desktop.store.loadProject(projectId)).version).toBe(
      next.version
    );

    // Neither the account nor the room held the model in plaintext.
    expect(
      JSON.stringify(rows(srv, 'SELECT * FROM e2ee_project_versions'))
    ).not.toContain('Laptop box');
    const roomValues = [...srv.storage.get(projectId)!.entries()];
    expect(roomValues.map(([key]) => key)).not.toContain('room:latest');
    const text = new TextDecoder();
    for (const [, value] of roomValues) {
      const envelope = (value as { envelope?: Uint8Array } | null)?.envelope;
      expect(
        envelope ? text.decode(envelope) : JSON.stringify(value)
      ).not.toContain('Laptop box');
    }
  });

  it('merges a stale edit with the base and latest the room returns', async () => {
    const srv = roomServer();
    const { created: base, projectId, a, b } = await twoDevices(srv);
    await a.next('state');
    await b.next('state');

    // Both edit version 1; the laptop lands first.
    const laptopEdit = withBox(base, 'Laptop box');
    const desktopEdit = withBox(base, 'Desktop box');
    await a.send(laptopEdit, base.version);
    await a.next('ack');
    await b.next('document');
    await b.send(desktopEdit, base.version);
    const conflict = await b.next('conflict');
    expect(conflict.base?.version).toBe(base.version);
    expect(conflict.document.version).toBe(laptopEdit.version);

    // The desktop merges in the browser and resubmits on the latest.
    const merged = mergeCollaborationDocuments(
      conflict.base!,
      conflict.document,
      desktopEdit
    );
    expect(merged).not.toBeNull();
    await b.send(merged!, conflict.document.version);
    const ack = await b.next('ack');
    expect(ack.version).toBeGreaterThan(laptopEdit.version);

    const relayed = await a.next('document');
    expect(featureNames(relayed.document)).toEqual(
      expect.arrayContaining(['Laptop box', 'Desktop box'])
    );
    expect(count(srv, 'e2ee_project_versions', projectId)).toBe(3);
  });

  it('refuses an old-epoch head after a Commit, broadcasts the epoch, and lands after catch-up', async () => {
    const srv = roomServer();
    const { created, projectId, a, b } = await twoDevices(srv);
    await a.next('state');
    await b.next('state');

    // The laptop seals under epoch 0 ...
    const next = withBox(created, 'Late box');
    const stale = await a.codec.encode(next, created.version);
    if (stale.kind !== 'sealed') throw new Error('nothing sealed');
    // ... while the desktop joins the group by external Commit (epoch 1),
    // and sends nothing yet.
    await b.codec.encode(withBox(created, 'Unsent'), created.version);
    expect(
      rows<{ epoch: number }>(
        srv,
        'SELECT epoch FROM e2ee_project_groups WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ epoch: 1 }]);
    // The Commit route told the room, and the room told both devices.
    for (const socket of [a.socket, b.socket]) {
      await rawFrame(
        socket,
        (frame) => frame.type === 'e2ee-epoch' && frame.keyEpoch === 1
      );
    }

    // The old-epoch head is refused by the room, and nothing is written.
    await a.sendSealed(stale.submission);
    expect(await a.next('error')).toMatchObject({ code: 'epoch-stale' });
    expect(count(srv, 'e2ee_project_versions', projectId)).toBe(1);

    // Caught up (the epoch notice did it), it lands under epoch 1.
    await a.send(next, created.version);
    expect(await a.next('ack')).toEqual({ type: 'ack', version: next.version });
    expect(
      rows<{ key_epoch: number }>(
        srv,
        'SELECT key_epoch FROM e2ee_project_versions WHERE project_id = ? ORDER BY document_version',
        projectId
      ).map((row) => row.key_epoch)
    ).toEqual([0, 1]);
  });

  it('names a checkpoint through the encrypted revision path', async () => {
    const srv = roomServer();
    const laptop = device(srv, owner, 'owner_laptop');
    const created = await createEncrypted(laptop);
    const projectId = created.document.projectId;
    const a = await live(srv, laptop, projectId, 'client_laptop');
    await a.next('state');
    const named = createSavedRevision(
      withBox(created.document, 'Named box'),
      'Before the holes'
    );
    const revisionId = named.revisions.at(-1)!.revisionId;
    const encoded = await a.codec.encode(named, created.document.version);
    if (encoded.kind !== 'sealed') throw new Error('nothing sealed');
    const response = await worker.fetch(
      new Request(roomUrl(projectId), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
          'x-openzcad-development-user': OWNER
        },
        body: JSON.stringify({
          clientId: 'client_laptop',
          revisionId,
          version: encoded.submission
        })
      }),
      srv.env
    );
    expect(response.status).toBe(200);
    const { message } = await a.codec.decode(await response.text());
    expect(message).toEqual({ type: 'ack', version: named.version });
    expect(
      rows<{ revision_id: string; document_version: number }>(
        srv,
        'SELECT revision_id, document_version FROM e2ee_project_revisions WHERE project_id = ?',
        projectId
      )
    ).toEqual([{ revision_id: revisionId, document_version: named.version }]);
    // The account lists it; its reason stays inside the ciphertext.
    const listed = await laptop.store.listRevisions(projectId);
    expect(listed.revisions[0]).toMatchObject({
      revisionId,
      reason: 'Before the holes'
    });
    expect(
      JSON.stringify(rows(srv, 'SELECT * FROM e2ee_project_revisions'))
    ).not.toContain('Before the holes');
  });

  it('opens only for the owner, and only while encrypted projects are on', async () => {
    const srv = roomServer();
    const laptop = device(srv, owner, 'owner_laptop');
    const created = await createEncrypted(laptop);
    const projectId = created.document.projectId;
    srv.db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'editor', ?, 1, 1)`
      )
      .run(projectId, OTHER, OWNER);
    const ticket = (user: string, env = srv.env) =>
      worker.fetch(
        new Request(`${roomUrl(projectId)}/ticket`, {
          method: 'POST',
          headers: {
            origin: 'https://example.com',
            'x-openzcad-development-user': user
          }
        }),
        env
      );
    const member = await connect(projectId, srv.env, OTHER);
    expect(member.status).toBe(409);
    expect(((await member.json()) as { code: string }).code).toBe(
      'ENCRYPTED_PROJECT_SHARING_UNAVAILABLE'
    );
    expect((await ticket(OTHER)).status).toBe(409);
    expect(srv.rooms.has(projectId)).toBe(false);

    // With E2EE_PROJECTS_ENABLED off, the owner meets the 4-1 refusal.
    const off = { ...srv.env, E2EE_PROJECTS_ENABLED: 'false' };
    const closed = await connect(projectId, off);
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as { code: string }).code).toBe(
      'PROJECT_FORMAT_UNSUPPORTED'
    );
    expect((await ticket(OWNER, off)).status).toBe(409);
    expect(srv.rooms.has(projectId)).toBe(false);

    // The owner's ticket opens the encrypted room.
    expect((await ticket(OWNER)).status).toBe(200);
    expect(srv.storage.get(projectId)!.get('room:meta')).toMatchObject({
      format: 2
    });
  });

  it('keeps the last good version when the room relays one this browser cannot open', async () => {
    const srv = roomServer();
    const { desktop, created, projectId, a, b } = await twoDevices(srv);
    await a.next('state');
    await b.next('state');
    const pinned = await desktop.pins.read(OWNER, projectId);

    // The room is the server's to tamper with: it relays a version whose
    // record names another device than the one that signed it.
    await a.send(withBox(created, 'Box'), created.version);
    await a.next('ack');
    const index = await rawFrame(
      b.socket,
      (frame) => frame.type === 'e2ee-document'
    );
    const frame = JSON.parse(b.socket.sent[index]!) as {
      head: { record: { signerDeviceId: string } };
    };
    frame.head.record.signerDeviceId = 'owner_desktop';
    b.socket.sent[index] = JSON.stringify(frame);
    expect(await b.next('error')).toMatchObject({ code: 'document-invalid' });
    // Nothing was accepted: the pin stays where it was.
    expect(await desktop.pins.read(OWNER, projectId)).toEqual(pinned);
  });
});
