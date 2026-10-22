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
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

function linear(axis: 'x' | 'y' | 'z' = 'x', spacing = 30, count = 3) {
  const block = addPrimitiveFeature(
    createProjectDocument(
      'Linear native vertices',
      toUserId('linear_vertices')
    ),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    }
  );
  const document = patternBody(block, {
    name: 'Row',
    patternKind: 'linear',
    targetBodyId: block.bodyOrder.at(-1)!,
    axis,
    spacing,
    count
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

function multipleSourceLinear(spacing = 30, count = 3) {
  const pair = linear('z', 30, 2);
  const field = patternBody(pair.document, {
    name: 'Multiple source row',
    patternKind: 'linear',
    targetBodyId: pair.bodyId,
    axis: 'x',
    spacing,
    count
  });
  return {
    ...field,
    featureId: listFeaturesInOrder(field.document).at(-1)!.featureId
  };
}

describe(
  'qualified LINEAR edge and runtime native vertex adoption',
  { timeout: 120_000 },
  () => {
    it.each([
      ['x', 30],
      ['x', -30],
      ['y', 30],
      ['y', -30],
      ['z', 30],
      ['z', -30]
    ] as const)(
      'publishes every exact source role along %s at spacing%s',
      async (axis, spacing) => {
        const { document, bodyId } = linear(axis, spacing);
        const derived = await adapter.syncDocument(document);
        expect(derived.warnings).toEqual([]);
        const body = topology(derived, bodyId);
        expect(body.faces.filter((face) => face.reference)).toHaveLength(18);
        expect(body.edges.filter((edge) => edge.reference)).toHaveLength(36);
        expect(
          body.vertices?.filter((vertex) => vertex.reference)
        ).toHaveLength(24);
        expect(new Set(body.vertices!.map((vertex) => vertex.id)).size).toBe(
          24
        );
        expect(
          new Set(body.vertices!.map((vertex) => vertex.reference!.lineageName))
            .size
        ).toBe(24);
        const points = [];
        for (let member = 0; member < 3; member += 1)
          for (const x of [0, 10])
            for (const y of [0, 10])
              for (const z of [0, 10]) {
                const point = { x, y, z };
                point[axis] += member * spacing;
                points.push(JSON.stringify(point));
              }
        expect(
          body.vertices!.map((vertex) => JSON.stringify(vertex.point)).sort()
        ).toEqual(points.sort());
        for (const vertex of body.vertices!) {
          expect(vertex.reference!.witness.position).toEqual(
            [vertex.point.x, vertex.point.y, vertex.point.z].map((value) =>
              Math.round(value * 1e6)
            )
          );
          expect(
            body.edges.filter((edge) => edge.vertexIds?.includes(vertex.id))
          ).toHaveLength(3);
          expect(vertex.reference!.lineageName).toMatch(
            /^pattern\.vertex\.instance\.[012]\./
          );
        }
        expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          3000,
          8
        );
      }
    );

    it('uses the normalized authored oblique translation', async () => {
      const { document, bodyId, featureId } = linear('x', 25);
      const result = await adapter.syncDocument(
        updateFeature(document, {
          featureId,
          data: { direction: { x: 3, y: 4, z: 0 } }
        })
      );
      expect(result.warnings).toEqual([]);
      const body = topology(result, bodyId);
      const vertices = body.vertices!;
      expect(vertices.filter((vertex) => vertex.reference)).toHaveLength(24);
      expect(new Set(vertices.map((vertex) => vertex.id)).size).toBe(24);
      expect(
        new Set(vertices.map((vertex) => vertex.reference!.lineageName)).size
      ).toBe(24);
      const expected: string[] = [];
      const roundoffKey = (point: { x: number; y: number; z: number }) =>
        [point.x, point.y, point.z]
          .map((value) => Math.round(value * 1e12))
          .join(',');
      for (let member = 0; member < 3; member += 1)
        for (const x of [0, 10])
          for (const y of [0, 10])
            for (const z of [0, 10])
              expected.push(
                roundoffKey({ x: 15 * member + x, y: 20 * member + y, z })
              );
      expect(
        vertices.map((vertex) => roundoffKey(vertex.point)).sort()
      ).toEqual(expected.sort());
      for (const vertex of vertices) {
        expect(
          body.edges.filter((edge) => edge.vertexIds?.includes(vertex.id))
        ).toHaveLength(3);
        const member = Number(
          /^pattern\.vertex\.instance\.(\d+)\./.exec(
            vertex.reference!.lineageName
          )![1]
        );
        // The independent 3-4-5 closed form permits only arithmetic roundoff.
        expect(
          Math.min(
            ...[0, 10].map((x) => Math.abs(vertex.point.x - 15 * member - x))
          )
        ).toBeLessThan(1e-12);
        expect(
          Math.min(
            ...[0, 10].map((y) => Math.abs(vertex.point.y - 20 * member - y))
          )
        ).toBeLessThan(1e-12);
        expect([0, 10]).toContain(vertex.point.z);
      }
    });

    it('keeps touching members as24 distinct vertices and16 positions', async () => {
      const { document, bodyId } = linear('x', 10);
      const body = topology(await adapter.syncDocument(document), bodyId);
      expect(body.vertices?.filter((vertex) => vertex.reference)).toHaveLength(
        24
      );
      expect(new Set(body.vertices!.map((vertex) => vertex.id)).size).toBe(24);
      expect(
        new Set(body.vertices!.map((vertex) => JSON.stringify(vertex.point)))
          .size
      ).toBe(16);
    });

    it('preserves the100-box edge budget and legacy endpoint datum without vertex scans', async () => {
      const { document, bodyId } = linear('x', 30, 100);
      const output = vi.spyOn(RemusKernel.prototype, 'resolveOperationOutput');
      try {
        const derived = await adapter.syncDocument(document);
        const body = topology(derived, bodyId);
        expect(derived.warnings).toEqual([]);
        expect(body.edges.filter((edge) => edge.reference)).toHaveLength(1200);
        expect(body.vertices).toHaveLength(800);
        expect(
          body.vertices!.every(
            (vertex) =>
              !vertex.reference && vertex.unavailableReason === 'event-budget'
          )
        ).toBe(true);
        expect(
          output.mock.calls.filter(([, kind]) => kind === 'edge')
        ).toHaveLength(1201);
        expect(
          output.mock.calls.filter(([, kind]) => kind === 'vertex')
        ).toHaveLength(0);
        const reference = body.edges.find(
          (edge) =>
            edge.reference?.lineageName ===
            'pattern.edge.instance.99.primitive.box.edge.z.x-max.y-min'
        )!.reference!;
        const datum = addDatumPlane(document, {
          name: 'Budget endpoint',
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
        const replay = await adapter.syncDocument(datum.document);
        expect(replay.warnings).toEqual([]);
        expect(replay.datumFrames![datum.featureId]!.origin).toEqual({
          x: 2980,
          y: 0,
          z: 10
        });
        expect(
          output.mock.calls.filter(([, kind]) => kind === 'vertex')
        ).toHaveLength(0);
      } finally {
        output.mockRestore();
      }
    });

    it('keeps the existing product count minimum and performs no invalid count scans', async () => {
      const { document, bodyId, featureId } = linear();
      const output = vi.spyOn(RemusKernel.prototype, 'resolveOperationOutput');
      try {
        const derived = await adapter.syncDocument(
          updateFeature(document, { featureId, data: { count: 1 } })
        );
        expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
        expect(derived.warnings.join('\n')).toMatch(/Row.*between 2 and 100/);
        expect(
          output.mock.calls.filter(
            ([, kind]) => kind === 'edge' || kind === 'vertex'
          )
        ).toHaveLength(0);
      } finally {
        output.mockRestore();
      }
    });

    it('retains the fused-overlap geometry path without claiming copied boundary identity', async () => {
      const { document, bodyId } = linear('x', 5);
      const output = vi.spyOn(RemusKernel.prototype, 'resolveOperationOutput');
      try {
        const derived = await adapter.syncDocument(document);
        const body = topology(derived, bodyId);
        expect(derived.warnings).toEqual([]);
        expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          2000,
          8
        );
        expect(body.vertices).toBeUndefined();
        expect(body.edges.every((edge) => !edge.reference)).toBe(true);
        expect(
          output.mock.calls.filter(
            ([, kind]) => kind === 'edge' || kind === 'vertex'
          )
        ).toHaveLength(0);
      } finally {
        output.mockRestore();
      }
    });
    it('publishes qualified native vertices for every source and member of a LINEAR pattern', async () => {
      const pair = linear('z', 30, 2);
      await adapter.syncDocument(pair.document);
      const output = vi.spyOn(RemusKernel.prototype, 'resolveOperationOutput');
      const journal = vi.spyOn(RemusKernel.prototype, 'linearPatternJournaled');
      try {
        const field = patternBody(pair.document, {
          name: 'Multiple sources',
          patternKind: 'linear',
          targetBodyId: pair.bodyId,
          axis: 'x',
          spacing: 30,
          count: 3
        });

        const derived = await adapter.syncDocument(field.document);
        expect(derived.warnings).toEqual([]);
        const body = topology(derived, field.bodyId);
        expect(body.faces.filter((face) => face.reference)).toHaveLength(36);
        expect(body.edges).toHaveLength(72);
        expect(body.edges.filter((edge) => edge.reference)).toHaveLength(72);
        expect(
          body.vertices?.filter((vertex) => vertex.reference)
        ).toHaveLength(48);
        expect(new Set(body.vertices!.map((vertex) => vertex.id)).size).toBe(
          48
        );
        expect(
          new Set(body.vertices!.map((vertex) => vertex.reference!.lineageName))
            .size
        ).toBe(48);
        const expected = [];
        for (const sourceZ of [0, 30])
          for (const memberX of [0, 30, 60])
            for (const x of [0, 10])
              for (const y of [0, 10])
                for (const z of [0, 10])
                  expected.push(
                    JSON.stringify({ x: memberX + x, y, z: sourceZ + z })
                  );
        expect(
          body.vertices!.map((vertex) => JSON.stringify(vertex.point)).sort()
        ).toEqual(expected.sort());
        for (const vertex of body.vertices!) {
          expect(
            body.edges.filter((edge) => edge.vertexIds?.includes(vertex.id))
          ).toHaveLength(3);
          expect(vertex.reference!.witness.position).toEqual(
            [vertex.point.x, vertex.point.y, vertex.point.z].map((value) =>
              Math.round(value * 1e6)
            )
          );
        }
        expect(journal.mock.calls).toHaveLength(2);
        const members = journal.mock.results.flatMap((result, index) => {
          expect(result.type).toBe('return');
          const { compound, op } = JSON.parse(result.value as string) as {
            compound: number;
            op: number;
          };
          expect(
            output.mock.calls.filter(
              ([actualOp, kind]) => actualOp === op && kind === 'edge'
            )
          ).toHaveLength(37);
          expect(
            output.mock.calls.filter(
              ([actualOp, kind]) => actualOp === op && kind === 'vertex'
            )
          ).toHaveLength(25);
          const solids = Array.from(
            (journal.mock.contexts[index] as RemusKernel).getCompoundSolids(
              compound
            )
          );
          expect(solids).toHaveLength(3);
          return solids;
        });
        expect(new Set(members).size).toBe(6);
        expect(derived.bodyRepresentations[field.bodyId]!.volume).toBeCloseTo(
          6000,
          8
        );
      } finally {
        output.mockRestore();
        journal.mockRestore();
      }
    });

    it('keeps touching multi-source members distinct at their shared positions', async () => {
      const field = multipleSourceLinear(10);
      const derived = await adapter.syncDocument(field.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[field.bodyId]!.volume).toBeCloseTo(
        6000,
        8
      );
      const body = topology(derived, field.bodyId);
      expect(body.faces.filter((face) => face.reference)).toHaveLength(36);
      expect(body.edges.filter((edge) => edge.reference)).toHaveLength(72);
      expect(body.vertices?.filter((vertex) => vertex.reference)).toHaveLength(
        48
      );
      expect(new Set(body.vertices!.map((vertex) => vertex.id)).size).toBe(48);
      expect(
        new Set(body.vertices!.map((vertex) => vertex.reference!.lineageName))
          .size
      ).toBe(48);
      const positions = new Map<string, typeof body.vertices>();
      for (const vertex of body.vertices!) {
        const key = JSON.stringify(vertex.point);
        positions.set(key, [...(positions.get(key) ?? []), vertex]);
        expect(
          body.edges.filter((edge) => edge.vertexIds?.includes(vertex.id))
        ).toHaveLength(3);
      }
      expect(positions.size).toBe(32);
      const touching = [...positions.values()].filter(
        (vertices) => vertices!.length === 2
      );
      expect(touching).toHaveLength(16);
      for (const vertices of touching) {
        expect(new Set(vertices!.map((vertex) => vertex.id)).size).toBe(2);
        expect(
          new Set(vertices!.map((vertex) => vertex.reference!.lineageName)).size
        ).toBe(2);
      }
    });

    it('requalifies a unique multi-source R01 endpoint through count and spacing replay, then refuses its deleted member', async () => {
      const field = multipleSourceLinear();
      const initial = topology(
        await adapter.syncDocument(field.document),
        field.bodyId
      );
      const vertices = new Map(
        initial.vertices!.map((vertex) => [vertex.id, vertex])
      );
      const reference = initial.edges.find(
        (edge) =>
          edge.reference &&
          edge.vertexIds?.length === 2 &&
          edge.vertexIds.every((id) => {
            const point = vertices.get(id)!.point;
            return (
              point.x === 70 && point.y === 0 && [30, 40].includes(point.z)
            );
          })
      )?.reference;
      expect(reference).toBeDefined();
      const datum = addDatumPlane(field.document, {
        name: 'Multiple source endpoint',
        definition: {
          kind: 'parallel-point',
          source: { type: 'canonical', plane: 'XY', offset: 0 },
          point: {
            type: 'edge-vertex',
            bodyId: field.bodyId,
            edgeReference: reference!,
            end: 1
          }
        }
      });
      const check = (derived: DerivedState, x: number, count: number) => {
        expect(derived.warnings).toEqual([]);
        expect(derived.datumFrames![datum.featureId]!.origin).toEqual({
          x,
          y: 0,
          z: 40
        });
        const body = topology(derived, field.bodyId);
        expect(body.faces.filter((face) => face.reference)).toHaveLength(
          12 * count
        );
        expect(body.edges.filter((edge) => edge.reference)).toHaveLength(
          24 * count
        );
        expect(
          body.vertices?.filter((vertex) => vertex.reference)
        ).toHaveLength(16 * count);
        expect(
          new Set(body.vertices!.map((vertex) => vertex.reference!.lineageName))
            .size
        ).toBe(16 * count);
        expect(
          body.vertices!.filter(
            (vertex) =>
              vertex.point.x === x &&
              vertex.point.y === 0 &&
              vertex.point.z === 40
          )
        ).toHaveLength(1);
        return body
          .vertices!.map((vertex) => ({
            name: vertex.reference!.lineageName,
            point: vertex.point,
            witness: vertex.reference!.witness
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      };
      check(await adapter.syncDocument(datum.document), 70, 3);
      const grown = updateFeature(datum.document, {
        featureId: field.featureId,
        data: { count: 5, spacing: 45 }
      });
      const expected = check(await adapter.syncDocument(grown), 100, 5);
      check(await adapter.syncDocument(datum.document), 70, 3);
      expect(check(await adapter.syncDocument(grown), 100, 5)).toEqual(
        expected
      );
      const cold = await createExactKernelAdapter();
      try {
        expect(
          check(
            await cold.syncDocument(
              JSON.parse(JSON.stringify(grown)) as ProjectDocument
            ),
            100,
            5
          )
        ).toEqual(expected);
      } finally {
        cold.dispose();
      }
      const deleted = await adapter.syncDocument(
        updateFeature(grown, { featureId: field.featureId, data: { count: 2 } })
      );
      expect(deleted.datumFrames?.[datum.featureId]).toBeUndefined();
      expect(deleted.warnings).toHaveLength(1);
      expect(deleted.warnings[0]).toMatch(
        /Multiple source endpoint.*deleted|Multiple source endpoint.*no longer/i
      );
    });

    it('requalifies native R01 points through edits, checkpoint undo/redo and cold replay, then refuses a deleted member', async () => {
      const { document, bodyId, featureId } = linear('x', -30);
      const initial = topology(await adapter.syncDocument(document), bodyId);
      const reference = initial.edges.find(
        (edge) =>
          edge.reference?.lineageName ===
          'pattern.edge.instance.2.primitive.box.edge.z.x-max.y-min'
      )!.reference!;
      const datum = addDatumPlane(document, {
        name: 'Row endpoint',
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
      const check = (derived: DerivedState, x: number, count: number) => {
        expect(derived.warnings).toEqual([]);
        expect(derived.datumFrames![datum.featureId]!.origin).toEqual({
          x,
          y: 0,
          z: 10
        });
        const vertices = topology(derived, bodyId).vertices!;
        expect(vertices.filter((vertex) => vertex.reference)).toHaveLength(
          count * 8
        );
        expect(
          vertices.find(
            (vertex) =>
              vertex.reference?.lineageName.startsWith(
                'pattern.vertex.instance.2.'
              ) &&
              vertex.point.x === x &&
              vertex.point.y === 0 &&
              vertex.point.z === 10
          )
        ).toBeDefined();
      };
      check(await adapter.syncDocument(datum.document), -50, 3);
      const grown = updateFeature(datum.document, {
        featureId,
        data: { count: 5, spacing: -45 }
      });
      check(await adapter.syncDocument(grown), -80, 5);
      check(await adapter.syncDocument(datum.document), -50, 3);
      check(await adapter.syncDocument(grown), -80, 5);
      const cold = await createExactKernelAdapter();
      try {
        check(
          await cold.syncDocument(
            JSON.parse(JSON.stringify(grown)) as ProjectDocument
          ),
          -80,
          5
        );
      } finally {
        cold.dispose();
      }
      const refused = await adapter.syncDocument(
        updateFeature(grown, { featureId, data: { count: 2 } })
      );
      expect(refused.datumFrames?.[datum.featureId]).toBeUndefined();
      expect(refused.warnings).toHaveLength(1);
      expect(refused.warnings[0]).toMatch(
        /Row endpoint.*deleted|Row endpoint.*no longer/i
      );
    });
  }
);
