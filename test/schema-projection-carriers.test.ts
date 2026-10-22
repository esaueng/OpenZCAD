import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  normalizeDocument,
  updateSketchObject
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toSketchId,
  toUserId,
  type CreateProjectResponse,
  type DocumentChange,
  type SerializedCommand,
  type SketchObjectData
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import {
  HttpError,
  parseSaveProjectDocumentRequest
} from '../apps/web/worker/validation';
import {
  parseProjectBackup,
  importProjectCopy
} from '../apps/web/src/lib/projectBackup';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';

const clone = <T>(value: T): T => structuredClone(value);
const projection: SketchObjectData = {
  objectKind: 'line',
  x1: 0,
  y1: 0,
  x2: 10,
  y2: 0,
  projection: { mode: 'unlinked' }
};
const floor = /Sketch projections require project schema v33 or newer/;
const carriers = [
  'current',
  'undo node',
  'redo node',
  'undo map',
  'redo map',
  'saved log',
  'undo value log',
  'redo value log',
  'undo splice log',
  'redo splice log'
] as const;
type Carrier = (typeof carriers)[number];
function fixture(
  base = createProjectDocument(
    'Projection schema',
    toUserId('user_projection_schema')
  )
) {
  const added = addSketchFeature(base, {
    name: 'Ordinary line',
    plane: 'XY',
    objects: [{ ...projection, projection: undefined }]
  });
  return {
    ...added,
    objectId: findSketch(added.document, added.sketchId)!.objectIds[0]!
  };
}
function nested(command: SerializedCommand): SerializedCommand {
  const wrap = (payload: SerializedCommand[]): SerializedCommand => ({
    kind: 'transaction',
    replayVersion: 1,
    label: 'Stored transaction',
    timestamp: '2026-10-22T00:00:00.000Z',
    payload
  });
  return wrap([wrap([command])]);
}
function carried(
  f: ReturnType<typeof fixture>,
  carrier: Carrier,
  malformed: boolean,
  version: unknown
) {
  const document = clone(f.document);
  Object.assign(document, { schemaVersion: version });
  const data = clone(projection);
  if (malformed)
    Object.assign(data, { projection: { mode: 'linked', source: {} } });
  const ordinary = document.nodes[f.objectId];
  if (ordinary?.kind !== 'sketch-object')
    throw new Error('Expected a sketch object.');
  const marked = { ...ordinary, data };
  if (carrier === 'current') {
    document.nodes[f.objectId] = marked;
    return document;
  }
  let change: DocumentChange;
  const undo = carrier.startsWith('undo');
  if (carrier.endsWith('node') || carrier.endsWith('map')) {
    const wholeMap = carrier.endsWith('map');
    const plain = wholeMap ? document.nodes : ordinary;
    const projected = wholeMap
      ? { ...document.nodes, [f.objectId]: marked }
      : marked;
    change = {
      kind: 'value',
      field: 'nodes',
      ...(wholeMap ? {} : { key: f.objectId }),
      before: undo ? projected : plain,
      after: undo ? plain : projected
    };
  } else {
    const commands = [
      nested(
        commandFactories
          .updateSketchObject({
            sketchId: f.sketchId,
            objectId: f.objectId,
            data
          })
          .serialize()
      )
    ];
    if (carrier === 'saved log') {
      document.commandLog = commands;
      return document;
    }
    const before = undo ? commands : [],
      after = undo ? [] : commands;
    change = carrier.includes('splice')
      ? { kind: 'splice', field: 'commandLog', index: 0, before, after }
      : { kind: 'value', field: 'commandLog', before, after };
  }
  document.editHistory = {
    schemaVersion: 1,
    projectId: document.projectId,
    actorUserId: document.ownerUserId,
    cursor: undo ? 1 : 0,
    trimmed: 0,
    entries: [
      {
        id: 'projection_history',
        label: 'Stored projection',
        changes: [change]
      }
    ]
  };
  return document;
}

it.each(carriers)(
  'rejects invalid declared projection versions in %s without mutation',
  (carrier) => {
    const f = fixture();
    for (const version of [undefined, null, NaN, '33', -1, 31, 32, 32.5]) {
      const document = carried(f, carrier, false, version),
        before = clone(document);
      expect(() => normalizeDocument(document)).toThrow(floor);
      expect(() => new CommandManager(document)).toThrow(floor);
      expect(() => replayCommands(document, [])).toThrow(floor);
      expect(document).toEqual(before);
    }
  }
);

it('refuses a fractional future schema without mutating its projection carriers', () => {
  const document = carried(
    fixture(),
    'current',
    false,
    PROJECT_DOCUMENT_SCHEMA_VERSION + 0.5
  );
  const before = clone(document);
  expect(() => normalizeDocument(document)).toThrow(
    /Unsupported project schema/
  );
  expect(() => new CommandManager(document)).toThrow(floor);
  expect(() => replayCommands(document, [])).toThrow(floor);
  expect(document).toEqual(before);
});

it.each(carriers)(
  'translates malformed projection metadata in %s to HTTP400',
  (carrier) => {
    const document = carried(
        fixture(),
        carrier,
        true,
        PROJECT_DOCUMENT_SCHEMA_VERSION
      ),
      before = clone(document);
    let failure: unknown;
    try {
      parseSaveProjectDocumentRequest(
        {
          projectId: document.projectId,
          expectedVersion: document.version,
          document
        },
        document.projectId
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(400);
    expect(document).toEqual(before);
  }
);

it('rejects live projection writes and supplied nested replay before applying any prefix', () => {
  const f = fixture(),
    document = clone(f.document);
  Object.assign(document, { schemaVersion: 32 });
  const before = clone(document);
  expect(() =>
    updateSketchObject(document, {
      sketchId: f.sketchId,
      objectId: f.objectId,
      data: projection
    })
  ).toThrow(floor);
  const prefix = commandFactories
    .updateSketch({ sketchId: f.sketchId, offset: 1 })
    .serialize();
  prefix.payload = { sketchId: toSketchId('sketch_missing'), offset: 1 };
  const log = [
    prefix,
    nested(
      commandFactories
        .updateSketchObject({
          sketchId: f.sketchId,
          objectId: f.objectId,
          data: projection
        })
        .serialize()
    )
  ];
  const savedLog = clone(log);
  expect(() => replayCommands(document, log)).toThrow(floor);
  expect(document).toEqual(before);
  expect(log).toEqual(savedLog);
});

it('accepts v33 projection carriers and preserves valid legacy documents without projections', () => {
  const f = fixture();
  for (const carrier of carriers) {
    const document = carried(f, carrier, false, 33),
      before = clone(document);
    const opened = normalizeDocument(document);
    expect(opened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(opened.nodes).toEqual(before.nodes);
    expect(opened.commandLog).toEqual(before.commandLog);
    expect(opened.editHistory).toEqual(before.editHistory);
    expect(document).toEqual(before);
  }
  for (const version of [undefined, 14, 31, 32]) {
    const legacy = clone(f.document);
    Object.assign(legacy, { schemaVersion: version });
    const before = clone(legacy),
      opened = normalizeDocument(legacy);
    expect(opened.nodes).toEqual(before.nodes);
    expect(opened.commandLog).toEqual(before.commandLog);
    expect(legacy).toEqual(before);
  }
});

it('refuses a native backup carrying backdated projection content before opening a native copy', async () => {
  const document = carried(fixture(), 'current', false, 32),
    before = clone(document);
  const backup = await parseProjectBackup(
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document,
      files: []
    })
  );
  const saved = clone(backup);
  expect(() => importProjectCopy(backup, document.ownerUserId)).toThrow(floor);
  expect(backup).toEqual(saved);
  expect(document).toEqual(before);
});

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
it.each(carriers)(
  'account refuses malformed and backdated %s before storage',
  async (carrier) => {
    const created = await worker.fetch(
      request('/api/projects', 'POST', { name: 'Projection refusal' }),
      env
    );
    expect(created.status).toBe(201);
    const { document: original } =
      (await created.json()) as CreateProjectResponse;
    const path = `/api/projects/${original.projectId}`;
    const before: unknown = await (
      await worker.fetch(request(path, 'GET'), env)
    ).json();
    const f = fixture(original);
    for (const malformed of [true, false]) {
      const document = carried(
        f,
        carrier,
        malformed,
        malformed ? PROJECT_DOCUMENT_SCHEMA_VERSION : 32
      );
      const response = await worker.fetch(
        request(`${path}/document`, 'PUT', {
          projectId: original.projectId,
          expectedVersion: original.version,
          document
        }),
        env
      );
      expect(response.status).toBe(400);
      expect(
        await (await worker.fetch(request(path, 'GET'), env)).json()
      ).toEqual(before);
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
describe.each(['http', 'websocket'] as const)(
  '%s room projection guard',
  (transport) => {
    it.each(carriers)(
      'refuses malformed and backdated %s as document-invalid before storage',
      async (carrier) => {
        for (const malformed of [true, false]) {
          const document = carried(
            fixture(),
            carrier,
            malformed,
            malformed ? PROJECT_DOCUMENT_SCHEMA_VERSION : 32
          );
          const { context, values } = createRoomContext(),
            room = createTestRoom(context, {});
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
                  clientId: 'projection_schema',
                  baseVersion: null,
                  document
                })
              })
            );
            result = await response.json();
          } else {
            const response = await room.fetch(
              new Request(url, {
                headers: { ...headers, upgrade: 'websocket' }
              })
            );
            expect(response.status).toBe(101);
            const socket = sockets.serverSockets.at(-1)!;
            await socket.receive(
              JSON.stringify({
                type: 'hello',
                clientId: 'projection_schema',
                displayName: 'Owner',
                baseVersion: null,
                document: null
              })
            );
            await socket.receive(
              JSON.stringify({
                type: 'document',
                clientId: 'projection_schema',
                baseVersion: null,
                document
              })
            );
            result = socket.lastFrame();
          }
          expect(result).toMatchObject({
            type: 'error',
            code: 'document-invalid'
          });
          expect(values.has('room:latest')).toBe(false);
        }
      }
    );
  }
);
