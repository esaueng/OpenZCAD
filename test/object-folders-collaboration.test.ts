import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assertStorableDocument,
  createProjectDocument,
  mergeCollaborationDocuments,
  UnstorableDocumentError
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';

let globals: ReturnType<typeof installWorkerSocketGlobals>;
beforeAll(() => {
  globals = installWorkerSocketGlobals();
});
afterAll(() => {
  globals.restore();
});

function filedDocument(): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Filed part', toUserId('user_room'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    })
  );
  manager.execute(
    commandFactories.createObjectFolder({
      folderId: 'folder_a',
      name: 'Frame',
      parentId: null,
      bodyIds: [...manager.document.bodyOrder]
    })
  );
  return structuredClone(manager.document);
}

async function submission(transport: string, document: ProjectDocument) {
  const { context, values } = createRoomContext();
  const room = createTestRoom(context, {});
  const url = `https://room.test/?projectId=${document.projectId}`;
  const headers = {
    'x-openzcad-user-id': 'user_room',
    'x-openzcad-display-name': 'Owner',
    'x-openzcad-project-role': 'owner'
  };
  if (transport === 'http') {
    const response = await room.fetch(
      new Request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          clientId: 'client_folders',
          baseVersion: null,
          document
        })
      })
    );
    return { result: (await response.json()) as unknown, values };
  }
  const response = await room.fetch(
    new Request(url, { headers: { ...headers, upgrade: 'websocket' } })
  );
  expect(response.status).toBe(101);
  const socket = globals.serverSockets.at(-1)!;
  await socket.receive(
    JSON.stringify({
      type: 'hello',
      clientId: 'client_folders',
      displayName: 'Owner',
      baseVersion: null,
      document: null
    })
  );
  await socket.receive(
    JSON.stringify({
      type: 'document',
      clientId: 'client_folders',
      baseVersion: null,
      document
    })
  );
  return { result: socket.lastFrame(), values };
}

/**
 * U06 folders at the collaboration edge. Since ADR-024 Phase 1 the room no
 * longer reads (or normalizes) contents on save: the browser refuses a
 * malformed section by name before it submits, and the room stores whatever
 * envelope-valid document it is sent without failing as `internal`.
 */
describe.each(['http', 'websocket'])(
  'Objects folders in %s collaboration snapshots',
  (transport) => {
    it('stores a valid folder section', async () => {
      const document = filedDocument();
      const { result, values } = await submission(transport, document);
      expect(result).toMatchObject({ type: 'ack' });
      expect(
        (values.get('room:latest') as ProjectDocument).objectFolders
      ).toEqual(document.objectFolders);
    });

    it('refuses a malformed folder section by name in the browser, before submission', async () => {
      const document = filedDocument();
      document.objectFolders!.folders[0]!.parentId = 'folder_missing';
      expect(() => assertStorableDocument(document)).toThrow(
        UnstorableDocumentError
      );
      expect(() => assertStorableDocument(document)).toThrow(
        /"document\.objectFolders": .*does not exist/
      );
      const { result, values } = await submission(transport, document);
      expect(result).toMatchObject({ type: 'ack' });
      expect(
        (values.get('room:latest') as ProjectDocument).objectFolders
      ).toEqual(document.objectFolders);
    });
  }
);

/**
 * Two forks that are each valid can merge field by field into a folder
 * section that is not: one deletes a folder while the other files a body in
 * it. That is an ordinary collaboration conflict, not a room failure.
 */
describe('Objects folders in a three-way collaboration merge', () => {
  it('reports a delete-versus-file fork as a conflict instead of throwing', () => {
    const manager = new CommandManager(filedDocument());
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_b',
        name: 'Spare',
        parentId: null
      })
    );
    const base = structuredClone(manager.document);
    const bodyId = base.bodyOrder[0]!;

    const deleting = new CommandManager(structuredClone(base));
    deleting.execute(
      commandFactories.deleteObjectFolder({ folderId: 'folder_b' })
    );
    const filing = new CommandManager(structuredClone(base));
    filing.execute(
      commandFactories.moveToObjectFolder({
        parentId: 'folder_b',
        bodyIds: [bodyId]
      })
    );

    expect(() =>
      mergeCollaborationDocuments(base, deleting.document, filing.document)
    ).not.toThrow();
    expect(
      mergeCollaborationDocuments(base, deleting.document, filing.document)
    ).toBeNull();
  });
});
