import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  normalizeDocument,
  updateSketch,
  updateSketchObject
} from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
  type EdgeTopologyReferenceV5,
  type EdgeWitnessV1,
  type FeatureId
} from '@openzcad/shared';
import {
  resolveTopologyReference,
  topologyHashOfWitness
} from '../packages/kernel-adapter/src/topology-lineage';
import worker from '../apps/web/worker/index';
import {
  HttpError,
  parseSaveProjectDocumentRequest
} from '../apps/web/worker/validation';
import {
  createRoomContext,
  createTestRoom,
  installWorkerSocketGlobals
} from './collaboration-room-harness';

const witness: EdgeWitnessV1 = {
  curveType: 'LINE',
  length: 1_000_000,
  closed: false,
  endpoints: [
    [0, 0, 0],
    [1_000_000, 0, 0]
  ],
  midpoint: [500_000, 0, 0]
};
function reference(value: EdgeWitnessV1 = witness): EdgeTopologyReferenceV5 {
  return {
    kind: 'edge',
    producingFeatureId: 'feat_source' as FeatureId,
    lineageName: 'edge.source',
    currentHash: topologyHashOfWitness('edge', value),
    witnessVersion: 1,
    witness: structuredClone(value)
  };
}
const invalidReferences: [string, EdgeTopologyReferenceV5][] = [
  ['zero hash', { ...reference(), currentHash: 0 }],
  [
    'mismatched hash',
    { ...reference(), currentHash: reference().currentHash + 1 }
  ],
  [
    'reversed endpoints',
    reference({
      ...witness,
      closed: false,
      endpoints: [
        [1_000_000, 0, 0],
        [0, 0, 0]
      ],
      midpoint: [500_000, 0, 0]
    })
  ],
  [
    'negative closed axis',
    reference({
      curveType: 'CIRCLE',
      length: 6_283_185,
      closed: true,
      center: [0, 0, 0],
      axis: [0, 0, -1_000_000_000]
    })
  ],
  [
    'zero closed axis',
    reference({
      curveType: 'CIRCLE',
      length: 6_283_185,
      closed: true,
      center: [0, 0, 0],
      axis: [0, 0, 0]
    })
  ],
  [
    'unsupported closed witness',
    reference({
      curveType: 'BSPLINE',
      length: 6_283_185,
      closed: true,
      center: [0, 0, 0],
      axis: null
    })
  ]
];
function fixture(
  edgeReference = reference(),
  base = createProjectDocument(
    'Reference validation',
    toUserId('user_reference')
  )
) {
  const added = addSketchFeature(base, {
    name: 'Line',
    plane: 'XY',
    objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }]
  });
  const objectId = findSketch(added.document, added.sketchId)!.objectIds[0]!;
  const node = added.document.nodes[objectId]!;
  if (node.kind !== 'sketch-object') throw new Error('Expected an object.');
  node.data.projection = {
    mode: 'linked',
    source: {
      bodyId: toBodyId('body_source'),
      edgeReference: structuredClone(edgeReference)
    }
  };
  return { ...added, objectId, data: node.data };
}
const invalid = /without a verified source edge/;

it.each(invalidReferences)(
  'rejects %s before loading, native edits or account parsing',
  (_name, ref) => {
    expect(resolveTopologyReference(ref, [])).toMatchObject({
      status: 'failed',
      reason:
        _name === 'unsupported closed witness'
          ? 'unsupported-witness'
          : 'invalid-reference'
    });
    const f = fixture(ref),
      before = structuredClone(f.document);
    expect(() => normalizeDocument(f.document)).toThrow(invalid);
    const ordinary = fixture(),
      ordinaryBefore = structuredClone(ordinary.document);
    expect(() =>
      updateSketchObject(ordinary.document, {
        sketchId: ordinary.sketchId,
        objectId: ordinary.objectId,
        data: f.data
      })
    ).toThrow(invalid);
    expect(() =>
      updateSketch(ordinary.document, {
        sketchId: ordinary.sketchId,
        object: f.data
      })
    ).toThrow(invalid);
    let failure: unknown;
    try {
      parseSaveProjectDocumentRequest(
        {
          projectId: f.document.projectId,
          expectedVersion: f.document.version,
          document: f.document
        },
        f.document.projectId
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(400);
    expect(f.document).toEqual(before);
    expect(ordinary.document).toEqual(ordinaryBefore);
  }
);

it.each([
  ['open line', witness, 3231434560],
  [
    'closed circle',
    {
      curveType: 'CIRCLE',
      length: 6_283_185,
      closed: true,
      center: [0, 0, 0],
      axis: [0, 0, 1_000_000_000]
    },
    158043708
  ],
  [
    'closed null axis',
    {
      curveType: 'CIRCLE',
      length: 6_283_185,
      closed: true,
      center: [0, 0, 0],
      axis: null
    },
    2204658744
  ]
] as [string, EdgeWitnessV1, number][])(
  'preserves a valid %s with its exact hash',
  (_name, validWitness, frozenHash) => {
    expect(reference(validWitness).currentHash).toBe(frozenHash);
    const f = fixture(reference(validWitness));
    expect(normalizeDocument(f.document).nodes[f.objectId]).toEqual(
      f.document.nodes[f.objectId]
    );
    expect(() =>
      parseSaveProjectDocumentRequest(
        {
          projectId: f.document.projectId,
          expectedVersion: f.document.version,
          document: f.document
        },
        f.document.projectId
      )
    ).not.toThrow();
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
it.each(invalidReferences.slice(0, 2))(
  'account refuses %s without changing stored data',
  async (_name, ref) => {
    const created = await worker.fetch(
      request('/api/projects', 'POST', { name: 'Reference refusal' }),
      env
    );
    expect(created.status).toBe(201);
    const original = (await created.json()) as {
      document: ReturnType<typeof createProjectDocument>;
    };
    const path = `/api/projects/${original.document.projectId}`;
    const before: unknown = await (
      await worker.fetch(request(path, 'GET'), env)
    ).json();
    const f = fixture(ref, original.document);
    const response = await worker.fetch(
      request(`${path}/document`, 'PUT', {
        projectId: f.document.projectId,
        expectedVersion: original.document.version,
        document: f.document
      }),
      env
    );
    expect(response.status).toBe(400);
    expect(
      await (await worker.fetch(request(path, 'GET'), env)).json()
    ).toEqual(before);
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
  '%s room refuses malformed references',
  (transport) => {
    it.each(invalidReferences.slice(0, 2))(
      'rejects %s before storage',
      async (_name, ref) => {
        const { document } = fixture(ref),
          { context, values } = createRoomContext(),
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
                clientId: 'projection_reference',
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
              clientId: 'projection_reference',
              displayName: 'Owner',
              baseVersion: null,
              document: null
            })
          );
          await socket.receive(
            JSON.stringify({
              type: 'document',
              clientId: 'projection_reference',
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
    );
  }
);
