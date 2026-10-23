import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchComposite,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  normalizeDocument
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  createSketchCompositeCornerTarget,
  toUserId,
  type CreateProjectResponse,
  type DocumentChange,
  type ProjectDocument,
  type SerializedCommand,
  type SketchObjectData
} from '@openzcad/shared';
import worker from '../apps/web/worker/index';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';

const families = [
  { name: 'projection', floor: 33 },
  { name: 'folder', floor: 34 },
  { name: 'distance mode', floor: 35 },
  { name: 'composite target', floor: 36 },
  { name: 'conversion', floor: 37 },
  { name: 'boundary provenance', floor: 37 }
] as const;
type Family = (typeof families)[number]['name'];
const carriers = [
  'current',
  'nested log',
  'undo value log',
  'redo splice log'
] as const;
type Carrier = (typeof carriers)[number];
const clone = <T>(value: T): T => structuredClone(value);
const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchObjectData => ({ objectKind: 'line', x1, y1, x2, y2 });

function fixture(
  family: Family,
  initial = createProjectDocument('Admission matrix', toUserId('user_matrix'))
) {
  const legacy = family === 'conversion' || family === 'boundary provenance';
  const added = addSketchFeature(initial, {
    name: 'Authored geometry',
    plane: 'XY',
    objects: legacy
      ? [
          {
            objectKind: 'rectangle',
            width: '2 cm',
            height: 6,
            centerX: 0,
            centerY: 0
          }
        ]
      : [
          line(0, 0, 20, 0),
          line(20, 0, 20, 6),
          line(20, 6, 0, 6),
          line(0, 6, 0, 0)
        ]
  });
  let base = added.document;
  let sketch = findSketch(base, added.sketchId)!;
  let composite;
  if (family === 'composite target') {
    base = addSketchComposite(base, {
      sketchId: added.sketchId,
      composite: {
        compositeKind: 'rectangle',
        method: 'corner',
        edgeIds: [...sketch.objectIds]
      }
    }).document;
    sketch = findSketch(base, added.sketchId)!;
    composite = sketch.composites![0]!;
  }
  const manager = new CommandManager(base);
  const first = sketch.objectIds[0]!;
  if (family === 'projection')
    manager.execute(
      commandFactories.addSketchObjects({
        sketchId: added.sketchId,
        objects: [{ ...line(0, 0, 20, 0), projection: { mode: 'unlinked' } }]
      })
    );
  else if (family === 'folder')
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_matrix',
        name: 'Parts',
        parentId: null
      })
    );
  else if (family === 'distance mode' || family === 'composite target')
    manager.execute(
      commandFactories.addSketchReferenceDimension({
        sketchId: added.sketchId,
        data: {
          dimensionKind: 'distance',
          ...(family === 'distance mode'
            ? { distanceMode: 'horizontal' as const }
            : {}),
          a: composite
            ? createSketchCompositeCornerTarget(composite, 0)
            : { objectId: first, point: 'start' },
          b: composite
            ? createSketchCompositeCornerTarget(composite, 1)
            : { objectId: first, point: 'end' }
        }
      })
    );
  else {
    const source = base.nodes[first]!;
    if (source.kind !== 'sketch-object') throw new Error('Missing source.');
    if (family === 'conversion')
      manager.execute(
        commandFactories.convertLegacySketchObject({
          sketchId: added.sketchId,
          sourceObjectId: first,
          expectedSource: source.data
        })
      );
    else {
      const profile = computeSketchProfileAnalysis(
        [{ id: first, data: source.data }],
        (value) =>
          typeof value === 'number'
            ? value
            : value === '2 cm'
              ? 20
              : Number(value)
      ).profiles[0]!;
      manager.execute(
        commandFactories.extrudeSketch({
          name: 'Plate',
          sketchId: added.sketchId,
          distance: 3,
          profile: {
            profileId: profile.profileId,
            regionFingerprint: profile.regionFingerprint,
            sourceArea: profile.area,
            samplePoint: profile.samplePoint,
            sourceEntityIds: profile.sourceEntityIds,
            sourceBoundaryLoops: profile.sourceBoundaryLoops
          }
        })
      );
    }
  }
  return { base, authored: manager.document };
}
function nested(commands: SerializedCommand[]): SerializedCommand[] {
  return [
    {
      kind: 'transaction',
      payload: [
        {
          kind: 'transaction',
          payload: commands,
          label: 'Inner',
          replayVersion: 1,
          timestamp: new Date(0).toISOString()
        }
      ],
      label: 'Outer',
      replayVersion: 1,
      timestamp: new Date(0).toISOString()
    }
  ];
}
function carried(
  f: ReturnType<typeof fixture>,
  carrier: Carrier,
  version: unknown
) {
  const document = clone(carrier === 'current' ? f.authored : f.base);
  delete document.editHistory;
  document.commandLog = [];
  const commands = nested(clone(f.authored.commandLog));
  if (carrier === 'nested log') document.commandLog = commands;
  if (carrier === 'undo value log' || carrier === 'redo splice log') {
    const undo = carrier === 'undo value log';
    const change: DocumentChange = undo
      ? { kind: 'value', field: 'commandLog', before: commands, after: [] }
      : {
          kind: 'splice',
          field: 'commandLog',
          index: 0,
          before: [],
          after: commands
        };
    document.editHistory = {
      schemaVersion: 1,
      projectId: document.projectId,
      actorUserId: document.ownerUserId,
      entries: [
        { id: 'entry_matrix', label: 'Retained command', changes: [change] }
      ],
      cursor: undo ? 1 : 0,
      trimmed: 0
    };
  }
  if (version === undefined) Reflect.deleteProperty(document, 'schemaVersion');
  else Object.assign(document, { schemaVersion: version });
  return document;
}
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
const env = {
  ENVIRONMENT: 'development' as const,
  AUTH_MODE: 'development' as const,
  ARTIFACTS: {} as R2Bucket,
  PROJECT_ROOM: { getByName: vi.fn() }
};
let sockets: ReturnType<typeof installWorkerSocketGlobals>;
beforeAll(() => {
  sockets = installWorkerSocketGlobals();
});
afterAll(() => sockets.restore());

describe.each(families)(
  '$name storage admission at v$floor',
  ({ name, floor }) => {
    it('refuses backdated, fractional and absent versions in every retained carrier before native mutation', () => {
      const f = fixture(name);
      for (const carrier of carriers)
        for (const version of [
          32,
          floor - 1,
          floor - 0.5,
          floor + 0.5,
          undefined
        ]) {
          const document = carried(f, carrier, version);
          const before = clone(document);
          expect(
            () => normalizeDocument(document),
            `${carrier}:${version}`
          ).toThrow(/schema/);
          expect(
            () => new CommandManager(document),
            `${carrier}:${version}`
          ).toThrow(/schema/);
          expect(
            () => replayCommands(document, []),
            `${carrier}:${version}`
          ).toThrow(/schema/);
          expect(document).toEqual(before);
        }
    });
    it('retains every carrier at its introduction floor and every later supported version', () => {
      const f = fixture(name);
      for (const carrier of carriers)
        for (
          let version = floor;
          version <= PROJECT_DOCUMENT_SCHEMA_VERSION;
          version++
        ) {
          const document = carried(f, carrier, version);
          const before = clone(document);
          const opened = normalizeDocument(document);
          expect({ ...opened, schemaVersion: version }).toEqual(document);
          expect(document).toEqual(before);
        }
    });
    it('refuses account saves atomically for current and saved command carriers', async () => {
      const created = await worker.fetch(
        request('/api/projects', 'POST', { name: `Matrix ${name}` }),
        env
      );
      expect(created.status).toBe(201);
      const { document: original } =
        (await created.json()) as CreateProjectResponse;
      const path = `/api/projects/${original.projectId}`;
      const storedBefore: unknown = await (
        await worker.fetch(request(path, 'GET'), env)
      ).json();
      const f = fixture(name, original);
      for (const carrier of carriers)
        for (const version of [
          floor - 1,
          floor - 0.5,
          floor + 0.5,
          undefined
        ]) {
          const document = carried(f, carrier, version);
          const before = clone(document);
          const response = await worker.fetch(
            request(`${path}/document`, 'PUT', {
              projectId: original.projectId,
              expectedVersion: original.version,
              document
            }),
            env
          );
          expect(response.status, `${carrier}:${version}`).toBe(400);
          expect(await response.json()).toHaveProperty('error');
          expect(
            await (await worker.fetch(request(path, 'GET'), env)).json()
          ).toEqual(storedBefore);
          expect(document).toEqual(before);
        }
    });
    it('retains accepted account nodes and saved command/history carriers unchanged', async () => {
      for (const carrier of carriers) {
        const created = await worker.fetch(
          request('/api/projects', 'POST', {
            name: `Accepted ${name} ${carrier}`
          }),
          env
        );
        expect(created.status).toBe(201);
        const { document: original } =
          (await created.json()) as CreateProjectResponse;
        const path = `/api/projects/${original.projectId}`;
        const current = carried(
          fixture(name, original),
          carrier,
          PROJECT_DOCUMENT_SCHEMA_VERSION
        );
        const accepted = await worker.fetch(
          request(`${path}/document`, 'PUT', {
            projectId: original.projectId,
            expectedVersion: original.version,
            document: current
          }),
          env
        );
        expect(accepted.status, carrier).toBe(200);
        const stored = (await (
          await worker.fetch(request(path, 'GET'), env)
        ).json()) as ProjectDocument;
        expect(stored.nodes).toEqual(current.nodes);
        expect(stored.objectFolders).toEqual(current.objectFolders);
        expect(stored.commandLog).toEqual(current.commandLog);
        expect(stored.editHistory).toEqual(current.editHistory);
      }
    });
    it.each(['http', 'websocket'] as const)(
      'refuses %s room writes before storage and retains valid current history',
      async (transport) => {
        const f = fixture(name);
        for (const carrier of carriers)
          for (const version of [
            floor - 1,
            floor - 0.5,
            floor + 0.5,
            undefined,
            PROJECT_DOCUMENT_SCHEMA_VERSION
          ]) {
            const document = carried(f, carrier, version);
            const before = clone(document);
            const { context, values } = createRoomContext();
            const room = createTestRoom(context, {});
            const url = `https://room.test/?projectId=${document.projectId}`;
            const headers = {
              'x-openzcad-user-id': document.ownerUserId,
              'x-openzcad-display-name': 'Owner',
              'x-openzcad-project-role': 'owner'
            };
            let result: unknown;
            if (transport === 'http')
              result = await (
                await room.fetch(
                  new Request(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                      clientId: 'client_matrix',
                      baseVersion: null,
                      document
                    })
                  })
                )
              ).json();
            else {
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
                  clientId: 'client_matrix',
                  displayName: 'Owner',
                  baseVersion: null,
                  document: null
                })
              );
              await socket.receive(
                JSON.stringify({
                  type: 'document',
                  clientId: 'client_matrix',
                  baseVersion: null,
                  document
                })
              );
              result = socket.lastFrame();
            }
            if (version === PROJECT_DOCUMENT_SCHEMA_VERSION) {
              expect(result, `${carrier}:${version}`).toMatchObject({
                type: 'ack'
              });
              const stored = values.get('room:latest') as ProjectDocument;
              expect(stored.nodes).toEqual(before.nodes);
              expect(stored.commandLog).toEqual(before.commandLog);
              expect(stored.editHistory).toEqual(before.editHistory);
              expect(stored.objectFolders).toEqual(before.objectFolders);
            } else {
              expect(result, `${carrier}:${version}`).toMatchObject({
                type: 'error',
                code: 'document-invalid'
              });
              expect(values.has('room:latest')).toBe(false);
            }
            expect(document).toEqual(before);
          }
      }
    );
  }
);
