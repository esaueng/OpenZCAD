import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addDatumPlane,
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  patternBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import { decodeRemusPatternJournal } from '../packages/kernel-adapter/src/remus-lineage';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

function grid(spacing = 30, spacing2 = 40) {
  const block = addPrimitiveFeature(
    createProjectDocument('Native grid vertices', toUserId('grid_vertices')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    }
  );
  const document = patternBody(block, {
    name: 'Field',
    patternKind: 'grid',
    targetBodyId: block.bodyOrder.at(-1)!,
    axis: 'x',
    axis2: 'y',
    count: 3,
    count2: 2,
    spacing,
    spacing2
  }).document;
  return {
    document,
    bodyId: document.bodyOrder.at(-1)!,
    featureId: listFeaturesInOrder(document).at(-1)!.featureId
  };
}

function topology(derived: DerivedState, bodyId: BodyId) {
  expect(derived.bodyRepresentations[bodyId]).toBeDefined();
  return derived.bodyRepresentations[bodyId]!.topology!;
}

describe(
  'journal-qualified runtime grid vertices',
  { timeout: 120_000 },
  () => {
    it.each([
      [30, 40],
      [-30, 40],
      [30, -40],
      [-30, -40]
    ])('publishes all 48 actual box vertices at %s, %s', async (sx, sy) => {
      const { document, bodyId } = grid(sx, sy);
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = topology(derived, bodyId);
      const vertices = body.vertices ?? [];
      expect(vertices).toHaveLength(48);
      expect(vertices.filter((vertex) => vertex.reference)).toHaveLength(48);
      expect(new Set(vertices.map((vertex) => vertex.id)).size).toBe(48);
      expect(vertices.some((vertex) => vertex.id === 0)).toBe(true);
      expect(
        new Set(vertices.map((vertex) => vertex.reference!.lineageName)).size
      ).toBe(48);
      const expected = [];
      for (let column = 0; column < 3; column += 1) {
        for (let row = 0; row < 2; row += 1) {
          for (const x of [0, 10]) {
            for (const y of [0, 10]) {
              for (const z of [0, 10]) {
                expected.push([column * sx + x, row * sy + y, z].join(','));
              }
            }
          }
        }
      }
      expect(
        vertices
          .map((vertex) =>
            [vertex.point.x, vertex.point.y, vertex.point.z].join(',')
          )
          .sort()
      ).toEqual(expected.sort());
      for (const vertex of vertices) {
        expect(vertex.reference!.kind).toBe('vertex');
        expect(vertex.reference!.witness.position).toEqual(
          [vertex.point.x, vertex.point.y, vertex.point.z].map((value) =>
            Math.round(value * 1e6)
          )
        );
        expect(
          body.edges.filter((edge) => edge.vertexIds?.includes(vertex.id))
        ).toHaveLength(3);
      }
    });

    it('keeps stable vertex roles through count growth and a cold rebuild', async () => {
      const { document, bodyId, featureId } = grid(-30, 40);
      const original =
        topology(await adapter.syncDocument(document), bodyId).vertices ?? [];
      expect(original).toHaveLength(48);
      const grown = updateFeature(document, {
        featureId,
        data: { count: 4, count2: 3 }
      });
      const cold = await createExactKernelAdapter();
      try {
        const vertices =
          topology(
            await cold.syncDocument(
              JSON.parse(JSON.stringify(grown)) as ProjectDocument
            ),
            bodyId
          ).vertices ?? [];
        expect(vertices.filter((vertex) => vertex.reference)).toHaveLength(96);
        for (const source of original) {
          const matches = vertices.filter(
            (vertex) =>
              vertex.reference?.lineageName === source.reference!.lineageName
          );
          expect(matches).toHaveLength(1);
          expect(matches[0]!.point).toEqual(source.point);
        }
      } finally {
        cold.dispose();
      }
    });

    it('preserves the 100-box edge envelope without spending vertex ordinals', async () => {
      const outputs = vi.spyOn(RemusKernel.prototype, 'resolveOperationOutput');
      try {
        const { document, bodyId, featureId } = grid();
        const expanded = updateFeature(document, {
          featureId,
          data: { count: 10, count2: 10 }
        });
        const derived = await adapter.syncDocument(expanded);
        const body = topology(derived, bodyId);
        expect(body.edges.filter((edge) => edge.reference)).toHaveLength(1200);
        expect(
          body.vertices?.filter((vertex) => vertex.reference) ?? []
        ).toHaveLength(0);
        expect(
          outputs.mock.calls.filter(([, kind]) => kind === 'edge')
        ).toHaveLength(1201);
        expect(
          outputs.mock.calls.filter(([, kind]) => kind === 'vertex')
        ).toHaveLength(0);
        const reference = body.edges.find(
          (edge) =>
            edge.reference?.lineageName ===
            'pattern.edge.instance.9-9.primitive.box.edge.z.x-max.y-min'
        )!.reference!;
        const datum = addDatumPlane(expanded, {
          name: 'Legacy budget corner',
          definition: {
            kind: 'parallel-point',
            source: { type: 'canonical', plane: 'XY', offset: 0 },
            point: {
              type: 'edge-vertex',
              bodyId,
              edgeReference: reference,
              end: 1
            }
          }
        });
        const replayed = await adapter.syncDocument(datum.document);
        expect(replayed.warnings).toEqual([]);
        expect(replayed.datumFrames![datum.featureId]!.origin).toEqual({
          x: 280,
          y: 360,
          z: 10
        });
        expect(topology(replayed, bodyId).vertices).toHaveLength(800);
        expect(
          topology(replayed, bodyId).vertices!.every(
            (vertex) =>
              !vertex.reference && vertex.unavailableReason === 'event-budget'
          )
        ).toBe(true);
        expect(
          outputs.mock.calls.filter(([, kind]) => kind === 'vertex')
        ).toHaveLength(0);
      } finally {
        outputs.mockRestore();
      }
    });

    it('keeps touching members distinct instead of welding their native vertices', async () => {
      const { document, bodyId } = grid(10, 10);
      const result = topology(await adapter.syncDocument(document), bodyId);
      const vertices = result.vertices!;
      expect(vertices).toHaveLength(48);
      expect(vertices.filter((vertex) => vertex.reference)).toHaveLength(48);
      expect(new Set(vertices.map((vertex) => vertex.id)).size).toBe(48);
      expect(
        new Set(vertices.map((vertex) => JSON.stringify(vertex.point))).size
      ).toBe(24);
      expect(
        new Set(vertices.map((vertex) => vertex.reference!.lineageName)).size
      ).toBe(48);
    });

    it('spends no vertex ordinals on an unsupported multiple-source grid', async () => {
      const block = addPrimitiveFeature(
        createProjectDocument('Multiple sources', toUserId('multi_grid')),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        }
      );
      const pair = patternBody(block, {
        name: 'Pair',
        patternKind: 'linear',
        targetBodyId: block.bodyOrder.at(-1)!,
        axis: 'z',
        count: 2,
        spacing: 30
      }).document;
      const field = patternBody(pair, {
        name: 'Field',
        patternKind: 'grid',
        targetBodyId: pair.bodyOrder.at(-1)!,
        axis: 'x',
        axis2: 'y',
        count: 2,
        count2: 2,
        spacing: 30,
        spacing2: 40
      }).document;
      const gridOps = new Set<number>();
      const linearOps = new Set<number>();
      const gridJournal = RemusKernel.prototype.gridPatternJournaled;
      const linearJournal = RemusKernel.prototype.linearPatternJournaled;
      const gridCalls = vi
        .spyOn(RemusKernel.prototype, 'gridPatternJournaled')
        .mockImplementation(function (this: RemusKernel, ...args) {
          const response = gridJournal.apply(this, args);
          gridOps.add(decodeRemusPatternJournal(response).op);
          return response;
        });
      const linearCalls = vi
        .spyOn(RemusKernel.prototype, 'linearPatternJournaled')
        .mockImplementation(function (this: RemusKernel, ...args) {
          const response = linearJournal.apply(this, args);
          linearOps.add(decodeRemusPatternJournal(response).op);
          return response;
        });
      const outputs = vi.spyOn(RemusKernel.prototype, 'resolveOperationOutput');
      try {
        const derived = await adapter.syncDocument(field);
        expect(derived.warnings).toEqual([]);
        const result = topology(derived, field.bodyOrder.at(-1)!);
        expect(result.faces).toHaveLength(48);
        expect(result.faces.filter((face) => face.reference)).toHaveLength(48);
        expect(result.edges).toHaveLength(96);
        expect(result.vertices).toBeUndefined();
        expect(
          outputs.mock.calls.filter(
            ([op, kind]) => gridOps.has(op) && kind === 'vertex'
          )
        ).toHaveLength(0);
        expect(gridOps.size).toBe(2);
        expect(linearOps.size).toBe(1);
        expect(
          outputs.mock.calls.filter(
            ([op, kind]) => linearOps.has(op) && kind === 'vertex'
          )
        ).toHaveLength(17);
        expect(
          outputs.mock.calls.filter(
            ([op, kind]) => gridOps.has(op) && kind === 'edge'
          )
        ).toHaveLength(98);
      } finally {
        outputs.mockRestore();
        gridCalls.mockRestore();
        linearCalls.mockRestore();
      }
    });

    it('requalifies datum vertices through spacing/count edits, checkpoint undo and cold replay, and refuses a deleted cell', async () => {
      const events: RebuildCacheEvent[] = [];
      const cached = await createExactKernelAdapter({
        onRebuildCacheEvent: (event) => events.push(event)
      });
      try {
        const { document, bodyId, featureId } = grid(-30, 40);
        const initial = topology(await cached.syncDocument(document), bodyId);
        const reference = initial.edges.find(
          (edge) =>
            edge.reference?.lineageName ===
            'pattern.edge.instance.2-1.primitive.box.edge.z.x-max.y-min'
        )!.reference!;
        const datum = addDatumPlane(document, {
          name: 'Native corner',
          definition: {
            kind: 'parallel-point',
            source: { type: 'canonical', plane: 'XY', offset: 0 },
            point: {
              type: 'edge-vertex',
              bodyId,
              edgeReference: reference,
              end: 1
            }
          }
        });
        const check = (
          derived: DerivedState,
          point: { x: number; y: number; z: number },
          count: number
        ) => {
          expect(derived.warnings).toEqual([]);
          expect(derived.datumFrames![datum.featureId]!.origin).toEqual(point);
          const vertices = topology(derived, bodyId).vertices!;
          expect(vertices.filter((vertex) => vertex.reference)).toHaveLength(
            count
          );
          expect(
            vertices.find(
              (vertex) =>
                vertex.reference?.lineageName.startsWith(
                  'pattern.vertex.instance.2-1.'
                ) && JSON.stringify(vertex.point) === JSON.stringify(point)
            )
          ).toBeDefined();
        };
        check(
          await cached.syncDocument(datum.document),
          { x: -50, y: 40, z: 10 },
          48
        );
        const moved = updateFeature(datum.document, {
          featureId,
          data: { spacing: -45, spacing2: 55, count: 4, count2: 3 }
        });
        expect(events.at(-1)!.restored).toBeGreaterThanOrEqual(2);
        check(await cached.syncDocument(moved), { x: -80, y: 55, z: 10 }, 96);
        check(
          await cached.syncDocument(datum.document),
          { x: -50, y: 40, z: 10 },
          48
        );
        check(await cached.syncDocument(moved), { x: -80, y: 55, z: 10 }, 96);
        const cold = await createExactKernelAdapter();
        try {
          check(
            await cold.syncDocument(
              JSON.parse(JSON.stringify(moved)) as ProjectDocument
            ),
            { x: -80, y: 55, z: 10 },
            96
          );
        } finally {
          cold.dispose();
        }
        const removed = updateFeature(moved, { featureId, data: { count: 2 } });
        const refused = await cached.syncDocument(removed);
        expect(refused.datumFrames?.[datum.featureId]).toBeUndefined();
        expect(refused.warnings).toHaveLength(1);
        expect(refused.warnings[0]).toMatch(
          /Native corner.*deleted|Native corner.*no longer/i
        );
      } finally {
        cached.dispose();
      }
    });
  }
);
