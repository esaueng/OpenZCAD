import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProjectCollaborationRoom,
  resolveCollaborationDocument
} from '@openzcad/cloudflare-adapters';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
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

function upgradeRequest(projectId: string, user: string): Request {
  return new Request(`https://room.test/?projectId=${projectId}`, {
    headers: {
      upgrade: 'websocket',
      'x-openzcad-user-id': user,
      'x-openzcad-display-name': user,
      'x-openzcad-project-role': 'owner'
    }
  });
}

/**
 * A real editing session. Documents that reach a room come from a
 * `CommandManager`, which is what appends the `revisions` entries the room uses
 * to tell one line of history from another — the document-core helpers do not,
 * so a fixture built from them carries no lineage to check.
 */
function session(name: string, owner = 'user_a') {
  const manager = new CommandManager(
    createProjectDocument(name, toUserId(owner))
  );
  return {
    manager,
    box(label: string): ProjectDocument {
      return manager.execute(
        commandFactories.addPrimitive({
          name: label,
          primitiveKind: 'box',
          dimensions: { width: 1, height: 1, depth: 1 }
        })
      );
    }
  };
}

/**
 * The room used to accept any submission whose version number was simply larger
 * than its own, without establishing that the submission descended from what it
 * already held. A client that edited offline and then reconnected satisfied
 * that test by accident: its version outranked the room's while sharing none of
 * its history, so work committed while it was away was replaced with no
 * conflict raised and no copy left anywhere a user can reach — the room's own
 * document history is bounded and surfaced in no UI.
 */
describe('a collaboration submission that shares no history with the room', () => {
  it('is refused rather than accepted on version ordering alone', () => {
    const a = session('Stale base');
    const shared = a.box('Common');

    // The room moved on while this client was away.
    const latest = a.box('Committed by A');

    // A different line from the same shared document: three offline edits, so
    // the submission outranks the room numerically.
    const b = new CommandManager(shared);
    const offline = ['B one', 'B two', 'B three'].reduce<ProjectDocument>(
      (_, label) =>
        b.execute(
          commandFactories.addPrimitive({
            name: label,
            primitiveKind: 'box',
            dimensions: { width: 1, height: 1, depth: 1 }
          })
        ),
      shared
    );

    expect(offline.version).toBeGreaterThan(latest.version);

    const resolution = resolveCollaborationDocument(latest, offline);
    expect(resolution.kind).toBe('conflict');
    // The room keeps its own document; A's committed feature is still in it.
    expect(resolution.document.version).toBe(latest.version);
    expect(resolution.document.featureOrder).toEqual(latest.featureOrder);
  });

  it('still accepts an ordinary edit that continues the room line', () => {
    const a = session('Forward');
    const latest = a.box('First');
    const next = a.box('Second');

    expect(resolveCollaborationDocument(latest, next).kind).toBe('accept');
  });

  it('still accepts undo and redo, which raise the version without adding features', () => {
    const a = session('Undo');
    const added = a.box('A');
    const undone = a.manager.undo();
    const redone = a.manager.redo();

    expect(undone.version).toBeGreaterThan(added.version);
    expect(resolveCollaborationDocument(added, undone).kind).toBe('accept');
    expect(resolveCollaborationDocument(undone, redone).kind).toBe('accept');
  });

  it('conflicts rather than discarding the room when a behind client cannot merge', () => {
    const a = session('Unmergeable');
    a.box('Common');
    // The parameter must already exist on the shared ancestor, so both sides
    // edit the same node rather than each minting one of their own.
    const shared = a.manager.execute(
      commandFactories.setParameter({ name: 'width', expression: '10' })
    );
    const latest = a.manager.execute(
      commandFactories.setParameter({ name: 'width', expression: '20' })
    );

    const b = new CommandManager(shared);
    b.execute(commandFactories.setParameter({ name: 'width', expression: '30' }));
    const incoming = b.execute(
      commandFactories.setParameter({ name: 'depth', expression: '5' })
    );

    expect(incoming.version).toBeGreaterThan(latest.version);
    // `shared` is a genuine common ancestor, so the room tries to merge — and
    // when that fails it must keep its own document rather than fall through to
    // the version comparison.
    expect(resolveCollaborationDocument(latest, incoming, shared).kind).toBe(
      'conflict'
    );
  });

  it('keeps the committed feature when a reconnecting client submits', async () => {
    const context = createRoomContext();
    const room = new ProjectCollaborationRoom(context.context, {});
    const a = session('Reconnect');
    const shared = a.box('Common');
    const projectId = shared.projectId;

    expect((await room.fetch(upgradeRequest(projectId, 'user_a'))).status).toBe(
      101
    );
    const socketA = globals.serverSockets.at(-1) as FakeWebSocket;
    expect((await room.fetch(upgradeRequest(projectId, 'user_b'))).status).toBe(
      101
    );
    const socketB = globals.serverSockets.at(-1) as FakeWebSocket;

    for (const [socket, id] of [
      [socketA, 'client_a'],
      [socketB, 'client_b']
    ] as const) {
      await socket.receive(
        JSON.stringify({
          type: 'hello',
          clientId: id,
          document: shared,
          baseVersion: null
        })
      );
    }

    // A commits one feature. The room is now ahead of B.
    const committed = a.box('Committed by A');
    await socketA.receive(
      JSON.stringify({
        type: 'document',
        clientId: 'client_a',
        document: committed,
        baseVersion: shared.version
      })
    );

    // B was offline from `shared`. It submits against the version it last
    // *saw* rather than the one its document descends from — which is exactly
    // what the client used to send, and what the room used to believe.
    const b = new CommandManager(shared);
    let offline = shared;
    for (const label of ['B one', 'B two', 'B three']) {
      offline = b.execute(
        commandFactories.addPrimitive({
          name: label,
          primitiveKind: 'box',
          dimensions: { width: 1, height: 1, depth: 1 }
        })
      );
    }
    expect(offline.version).toBeGreaterThan(committed.version);

    await socketB.receive(
      JSON.stringify({
        type: 'document',
        clientId: 'client_b',
        document: offline,
        baseVersion: committed.version
      })
    );

    expect(socketB.lastFrame()?.type).toBe('conflict');

    // The room still holds A's work rather than B's replacement of it.
    const conflictFrame = socketB.lastFrame();
    expect(
      conflictFrame && 'document' in conflictFrame && conflictFrame.document
        ? conflictFrame.document.featureOrder
        : []
    ).toEqual(committed.featureOrder);
  });
});
