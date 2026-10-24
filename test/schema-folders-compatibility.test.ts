import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  addSketchObjects,
  assertStorableDocument,
  createObjectFolder,
  createProjectDocument,
  findSketch,
  normalizeDocument,
  UnstorableDocumentError,
  updateSketch,
  updateSketchObject
} from '@openzcad/document-core';
import { splitProjectStorageUpload } from '@openzcad/persistence';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type CreateProjectResponse,
  type DocumentChange,
  type ObjectFolderSet,
  type ProjectDocument,
  type SerializedCommand,
  type SketchObjectData
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import { parseSaveProjectDocumentRequest } from '../apps/web/worker/validation';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';

const projection: SketchObjectData = {
  objectKind: 'line',
  x1: 0,
  y1: 0,
  x2: 10,
  y2: 0,
  projection: { mode: 'unlinked' }
};
const folders: ObjectFolderSet = {
  folders: [{ id: 'folder_schema', name: 'Parts', parentId: null }],
  placements: {}
};
const projectionError =
  /Sketch projections require project schema v33 or newer/;
const foldersError = /Objects folders require project schema v34 or newer/;
const badVersions: unknown[] = [
  undefined,
  null,
  NaN,
  '34',
  -1,
  31,
  32,
  32.5,
  33.5
];
const clone = <T>(value: T): T => structuredClone(value);

function fixture() {
  const added = addSketchFeature(
    createProjectDocument('Schema carriers', toUserId('user_schema')),
    {
      name: 'Line',
      plane: 'XY',
      objects: [{ ...projection, projection: undefined }]
    }
  );
  const sketch = findSketch(added.document, added.sketchId)!;
  if (sketch.kind !== 'sketch') throw new Error('Expected a sketch.');
  return { ...added, objectId: sketch.objectIds[0]! };
}

function versioned(
  document: ProjectDocument,
  version: unknown
): ProjectDocument {
  const copy = clone(document);
  Object.assign(copy, { schemaVersion: version });
  return copy;
}

function history(
  document: ProjectDocument,
  changes: DocumentChange[],
  cursor: 0 | 1
) {
  document.editHistory = {
    schemaVersion: 1,
    projectId: document.projectId,
    actorUserId: document.ownerUserId,
    entries: [{ id: 'schema_entry', label: 'Stored content', changes }],
    cursor,
    trimmed: 0
  };
  return document;
}

function transaction(commands: SerializedCommand[]): SerializedCommand {
  return {
    kind: 'transaction',
    payload: commands,
    replayVersion: 1,
    label: 'Nested content',
    timestamp: '2026-10-22T00:00:00.000Z'
  };
}

function projectionCommands(
  f: ReturnType<typeof fixture>
): SerializedCommand[] {
  return [
    commandFactories
      .addSketch({ name: 'Projected', plane: 'XY', objects: [projection] })
      .serialize(),
    commandFactories
      .addSketch({ name: 'Legacy projected', plane: 'XY', object: projection })
      .serialize(),
    commandFactories
      .updateSketch({ sketchId: f.sketchId, object: projection })
      .serialize(),
    commandFactories
      .addSketchObjects({ sketchId: f.sketchId, objects: [projection] })
      .serialize(),
    commandFactories
      .updateSketchObject({
        sketchId: f.sketchId,
        objectId: f.objectId,
        data: projection
      })
      .serialize()
  ];
}

function folderCommands(): SerializedCommand[] {
  return [
    commandFactories
      .createObjectFolder({
        folderId: 'folder_schema',
        name: 'Parts',
        parentId: null
      })
      .serialize(),
    commandFactories
      .renameObjectFolder({ folderId: 'folder_schema', name: 'Renamed' })
      .serialize(),
    commandFactories
      .deleteObjectFolder({ folderId: 'folder_schema' })
      .serialize(),
    commandFactories
      .moveToObjectFolder({ parentId: null, folderIds: ['folder_schema'] })
      .serialize()
  ];
}

const carriers = [
  'current',
  'undo node',
  'redo node',
  'undo map',
  'redo map',
  'nested log',
  'undo value log',
  'redo value log',
  'undo splice log',
  'redo splice log'
] as const;
type Carrier = (typeof carriers)[number];

function carried(
  kind: 'projection' | 'folders',
  carrier: Carrier,
  version: unknown,
  commandIndex = 0
) {
  const f = fixture();
  const document = versioned(f.document, version);
  if (carrier === 'current') {
    if (kind === 'folders') document.objectFolders = clone(folders);
    else {
      const node = document.nodes[f.objectId];
      if (!node || node.kind !== 'sketch-object')
        throw new Error('Expected an object.');
      node.data = clone(projection);
    }
    return document;
  }
  if (carrier.includes('node') || carrier.includes('map')) {
    const undo = carrier.startsWith('undo');
    if (kind === 'folders')
      return history(
        document,
        [
          {
            kind: 'value',
            field: 'objectFolders',
            before: undo ? folders : undefined,
            after: undo ? undefined : folders
          }
        ],
        undo ? 1 : 0
      );
    const node = document.nodes[f.objectId];
    if (!node || node.kind !== 'sketch-object')
      throw new Error('Expected an object.');
    const marked = { ...node, data: projection };
    const map = carrier.endsWith('map');
    const plain = map ? document.nodes : node;
    const annotated = map
      ? { ...document.nodes, [f.objectId]: marked }
      : marked;
    return history(
      document,
      [
        {
          kind: 'value',
          field: 'nodes',
          ...(map ? {} : { key: f.objectId }),
          before: undo ? annotated : plain,
          after: undo ? plain : annotated
        }
      ],
      undo ? 1 : 0
    );
  }
  const command = (
    kind === 'projection' ? projectionCommands(f) : folderCommands()
  )[commandIndex]!;
  const commands = [transaction([transaction([command])])];
  if (carrier === 'nested log') document.commandLog = commands;
  else {
    const undo = carrier.startsWith('undo');
    const before = undo ? commands : [];
    const after = undo ? [] : commands;
    const change: DocumentChange = carrier.includes('splice')
      ? { kind: 'splice', field: 'commandLog', index: 0, before, after }
      : { kind: 'value', field: 'commandLog', before, after };
    history(document, [change], undo ? 1 : 0);
  }
  return document;
}

function refusesWithoutMutation(document: ProjectDocument, error: RegExp) {
  const before = clone(document);
  expect(() => normalizeDocument(document)).toThrow(error);
  expect(() => new CommandManager(document)).toThrow(error);
  expect(() => replayCommands(document, [])).toThrow(error);
  expect(document).toEqual(before);
}

/**
 * ADR-024 Phase 1: the account and the room store contents unread, so the
 * browser refuses a carrier its schema cannot hold before it writes, submits
 * or adopts one. It writes only declared schemas, so a missing one is refused
 * outright; a declared older one is refused by the carrier's own name.
 */
function browserRefuses(document: ProjectDocument, error?: RegExp) {
  const before = clone(document);
  expect(() => assertStorableDocument(document)).toThrow(
    UnstorableDocumentError
  );
  if (error) expect(() => assertStorableDocument(document)).toThrow(error);
  expect(document).toEqual(before);
}
const backdated = (kind: 'projection' | 'folders') =>
  kind === 'projection' ? 32 : 33;

describe.each(['projection', 'folders'] as const)(
  '%s carrier minimum schema',
  (kind) => {
    const error = kind === 'projection' ? projectionError : foldersError;
    it.each(carriers)(
      'refuses invalid declared versions in %s before mutation',
      (carrier) => {
        const versions =
          kind === 'folders' ? [...badVersions, 33, 33.5] : badVersions;
        const commandCount = carrier.includes('log')
          ? kind === 'projection'
            ? 5
            : 4
          : 1;
        for (const version of versions)
          for (let i = 0; i < commandCount; i++)
            refusesWithoutMutation(carried(kind, carrier, version, i), error);
      }
    );

    it('accepts its introduction boundary and preserves every stored carrier', () => {
      for (const carrier of carriers) {
        const document = carried(
          kind,
          carrier,
          kind === 'projection' ? 33 : 34
        );
        const before = clone(document);
        const normalized = normalizeDocument(document);
        expect(normalized.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
        expect(normalized.nodes).toEqual(before.nodes);
        expect(normalized.objectFolders).toEqual(before.objectFolders);
        expect(normalized.commandLog).toEqual(before.commandLog);
        expect(normalized.editHistory).toEqual(before.editHistory);
        expect(document).toEqual(before);
      }
    });

    it('preflights supplied nested replay before an invalid prefix can run', () => {
      const f = fixture();
      const commands =
        kind === 'projection' ? projectionCommands(f) : folderCommands();
      const versions =
        kind === 'projection' ? badVersions : [...badVersions, 33];
      for (const version of versions)
        for (const command of commands) {
          const document = versioned(f.document, version);
          const before = clone(document);
          const prefix: SerializedCommand = commandFactories
            .updateSketch({ sketchId: f.sketchId, offset: NaN })
            .serialize();
          // A missing sketch would fail first if replay executed the prefix.
          prefix.payload = { sketchId: 'sketch_missing', offset: 2 };
          const log = [prefix, transaction([transaction([command])])];
          expect(() => replayCommands(document, log)).toThrow(error);
          expect(document).toEqual(before);
          expect(log[1]).toEqual(transaction([transaction([command])]));
        }
    });
  }
);

it('ordinary projection and folder writes require a declared minimum schema', () => {
  const f = fixture();
  for (const version of badVersions) {
    const document = versioned(f.document, version);
    const before = clone(document);
    expect(() =>
      addSketchFeature(document, {
        name: 'Projection',
        plane: 'XY',
        objects: [projection]
      })
    ).toThrow(projectionError);
    expect(() =>
      addSketchObjects(document, {
        sketchId: f.sketchId,
        objects: [projection]
      })
    ).toThrow(projectionError);
    expect(() =>
      updateSketch(document, { sketchId: f.sketchId, object: projection })
    ).toThrow(projectionError);
    expect(() =>
      updateSketchObject(document, {
        sketchId: f.sketchId,
        objectId: f.objectId,
        data: projection
      })
    ).toThrow(projectionError);
    expect(() =>
      createObjectFolder(document, {
        folderId: 'folder_schema',
        name: 'Parts',
        parentId: null
      })
    ).toThrow(foldersError);
    expect(document).toEqual(before);
  }
});

it('does not synthesize new content in legacy documents, including missing schema', () => {
  for (const version of [
    undefined,
    ...Array.from({ length: 34 }, (_, i) => i + 1)
  ]) {
    const document = versioned(fixture().document, version);
    const before = clone(document);
    const normalized = normalizeDocument(document);
    expect(normalized.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(normalized.nodes).toEqual(before.nodes);
    expect(normalized.objectFolders).toBeUndefined();
    expect(document).toEqual(before);
  }
});

it('keeps the legacy unreadable-history drop policy', () => {
  const document = carried('folders', 'undo node', 31);
  document.editHistory!.schemaVersion = 2 as 1;
  const before = clone(document);
  expect(normalizeDocument(document).editHistory).toBeUndefined();
  expect(() => new CommandManager(document)).toThrow(/undo history/);
  expect(document).toEqual(before);
});

it.each(['projection', 'folders'] as const)(
  'refuses missing-schema %s in the browser while the Worker parses it unread',
  (kind) => {
    const document = carried(kind, 'current', undefined);
    const before = clone(document);
    browserRefuses(document);
    browserRefuses(
      carried(kind, 'current', backdated(kind)),
      kind === 'projection' ? projectionError : foldersError
    );
    const parsed = parseSaveProjectDocumentRequest(
      {
        projectId: document.projectId,
        expectedVersion: document.version,
        document
      },
      document.projectId
    );
    expect(parsed.document).toEqual(before);
    expect(document).toEqual(before);
  }
);

it.each(['projection', 'folders'] as const)(
  'refuses missing-schema nested %s command logs in the browser while the Worker parses them unread',
  (kind) => {
    const document = carried(kind, 'nested log', undefined);
    const before = clone(document);
    browserRefuses(document);
    browserRefuses(
      carried(kind, 'nested log', backdated(kind)),
      kind === 'projection' ? projectionError : foldersError
    );
    const parsed = parseSaveProjectDocumentRequest(
      {
        projectId: document.projectId,
        expectedVersion: document.version,
        document
      },
      document.projectId
    );
    expect(parsed.document).toEqual(before);
    expect(document).toEqual(before);
  }
);

const env = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const,
  ARTIFACTS: {} as R2Bucket,
  PROJECT_ROOM: { getByName: vi.fn() }
};
function request(path: string, method: string, body?: unknown) {
  return new Request(`https://example.com${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
  });
}

it.each(['projection', 'folders'] as const)(
  'refuses account %s saves in the browser before any account write',
  async (kind) => {
    const createdResponse = await worker.fetch(
      request('/api/projects', 'POST', { name: 'Schema refusal' }),
      env
    );
    expect(createdResponse.status).toBe(201);
    const { document: original } =
      (await createdResponse.json()) as CreateProjectResponse;
    const path = `/api/projects/${original.projectId}`;
    const before = (await (
      await worker.fetch(request(path, 'GET'), env)
    ).json()) as ProjectDocument;
    let changed =
      kind === 'projection'
        ? addSketchFeature(original, {
            name: 'Projection',
            plane: 'XY',
            objects: [projection]
          }).document
        : { ...original, objectFolders: clone(folders) };
    changed = versioned(changed, undefined);
    const logDocument = versioned(original, undefined);
    const command =
      kind === 'projection'
        ? projectionCommands(fixture())[0]!
        : folderCommands()[0]!;
    logDocument.commandLog = [transaction([transaction([command])])];
    const error = kind === 'projection' ? projectionError : foldersError;
    for (const document of [changed, logDocument]) {
      browserRefuses(document);
      // Every account write passes through this split, so none is sent.
      await expect(splitProjectStorageUpload(document)).rejects.toThrow(
        UnstorableDocumentError
      );
      await expect(
        splitProjectStorageUpload(versioned(document, backdated(kind)))
      ).rejects.toThrow(error);
    }
    expect(
      await (await worker.fetch(request(path, 'GET'), env)).json()
    ).toEqual(before);
    // The existing missing-schema account path still accepts an ordinary legacy save.
    const legacy = versioned(original, undefined);
    const accepted = await worker.fetch(
      request(`${path}/document`, 'PUT', {
        projectId: original.projectId,
        expectedVersion: original.version,
        document: legacy
      }),
      env
    );
    expect(accepted.status).toBe(200);
    // The account no longer reads contents, so it stores what it is sent.
    let version = original.version;
    for (const document of [changed, logDocument]) {
      const stored = await worker.fetch(
        request(`${path}/document`, 'PUT', {
          projectId: original.projectId,
          expectedVersion: version,
          document: {
            ...document,
            version: Math.max(document.version, version)
          }
        }),
        env
      );
      expect(stored.status).toBe(200);
      ({ version } = (await stored.json()) as { version: number });
    }
  }
);

let sockets: ReturnType<typeof installWorkerSocketGlobals>;
beforeAll(() => {
  sockets = installWorkerSocketGlobals();
});
afterAll(() => {
  sockets.restore();
});

describe.each(['http', 'websocket'])(
  '%s collaboration schema guard',
  (transport) => {
    it.each(['projection', 'folders'] as const)(
      'refuses backdated %s in the browser and stores it unread',
      async (kind) => {
        const document = carried(kind, 'current', backdated(kind));
        browserRefuses(
          document,
          kind === 'projection' ? projectionError : foldersError
        );
        const { context, values } = createRoomContext();
        const room = createTestRoom(context, {});
        const url = `https://room.test/?projectId=${document.projectId}`;
        const headers = {
          'x-openzcad-user-id': document.ownerUserId,
          'x-openzcad-display-name': 'Owner',
          'x-openzcad-project-role': 'owner'
        };
        let result: unknown;
        if (transport === 'http') {
          const response = await room.fetch(
            new Request(url, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                clientId: 'client_schema',
                baseVersion: null,
                document
              })
            })
          );
          result = await response.json();
        } else {
          const response = await room.fetch(
            new Request(url, { headers: { ...headers, upgrade: 'websocket' } })
          );
          expect(response.status).toBe(101);
          const socket = sockets.serverSockets.at(-1)!;
          await socket.receive(
            JSON.stringify({
              type: 'hello',
              clientId: 'client_schema',
              displayName: 'Owner',
              baseVersion: null,
              document: null
            })
          );
          await socket.receive(
            JSON.stringify({
              type: 'document',
              clientId: 'client_schema',
              baseVersion: null,
              document
            })
          );
          result = socket.lastFrame();
        }
        // The room checks only the envelope; each browser refuses these
        // contents before it submits or adopts them.
        expect(result).toMatchObject({ type: 'ack' });
        expect(values.has('room:latest')).toBe(true);
      }
    );
  }
);
