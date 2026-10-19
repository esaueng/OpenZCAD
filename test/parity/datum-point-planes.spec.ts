import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  mirrorBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { GEOMETRY_LINEAR_TOLERANCE, type Vec3 } from '@openzcad/geometry';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeVertexPointSource,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { OcctStepKernelAdapter } from './occt-reference/occt-step';

/**
 * R01 three-point and parallel-at-point planes resolve the same frame in the
 * Remus build and the OCCT parity reference: typed points, and vertices
 * re-found through each kernel's own edge lineage. Each consumer's geometry
 * is compared against the analytic expectation in both kernels.
 */

const quantum = (value: number) =>
  Math.round(value / GEOMETRY_LINEAR_TOLERANCE);
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const datum = (datumFeatureId: FeatureId) =>
  ({ type: 'datum', datumFeatureId }) as const;

function vertexOf(
  derived: DerivedState,
  bodyId: BodyId,
  point: Vec3,
  other: Vec3
): EdgeVertexPointSource {
  const key = (value: Vec3) =>
    [value.x, value.y, value.z].map(quantum).join(',');
  const edge = derived.bodyRepresentations[bodyId]?.topology?.edges.find(
    (candidate) => {
      const witness = candidate.reference?.witness;
      if (!witness || witness.closed) return false;
      const ends = witness.endpoints.map((end) => end.join(','));
      return ends.includes(key(point)) && ends.includes(key(other));
    }
  );
  expect(edge?.reference).toBeDefined();
  const [a, b] = [point, other].map((value) =>
    [value.x, value.y, value.z].map(quantum)
  ) as [number[], number[]];
  let order = 0;
  for (let index = 0; index < 3 && order === 0; index += 1)
    order = Math.sign(a[index]! - b[index]!);
  return {
    type: 'edge-vertex',
    bodyId,
    edgeReference: edge!.reference!,
    end: order < 0 ? 0 : 1
  };
}

describe('three-point and parallel datum planes across exact kernels', () => {
  let remus: ExactKernelAdapter;
  let occt: OcctStepKernelAdapter;
  beforeAll(async () => {
    remus = await createExactKernelAdapter();
    occt = await OcctStepKernelAdapter.create();
  });
  afterAll(() => {
    remus.dispose();
    occt.dispose();
  });

  function block(): { document: ProjectDocument; bodyId: BodyId } {
    const document = addPrimitiveFeature(
      createProjectDocument('Point planes parity', toUserId('user_r01_pp')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    return { document, bodyId: document.bodyOrder.at(-1)! };
  }

  it('pads on a plane through three block vertices at z = 20', async () => {
    const { document, bodyId } = block();
    const derived = await remus.syncDocument(document);
    const planed = addDatumPlane(document, {
      name: 'Top through corners',
      definition: {
        kind: 'three-point',
        points: [
          vertexOf(derived, bodyId, v(0, 0, 20), v(20, 0, 20)),
          vertexOf(derived, bodyId, v(20, 0, 20), v(0, 0, 20)),
          vertexOf(derived, bodyId, v(0, 20, 20), v(20, 20, 20))
        ]
      }
    });
    const sketched = addSketchFeature(planed.document, {
      name: 'Pad sketch',
      planeRef: datum(planed.featureId),
      objects: [
        { objectKind: 'rectangle', width: 4, height: 6, centerX: 3, centerY: 4 }
      ]
    });
    const padded = extrudeSketch(sketched.document, {
      name: 'Pad',
      sketchId: sketched.sketchId,
      distance: 5
    });
    for (const adapter of [remus, occt]) {
      const built = await adapter.syncDocument(padded.document);
      expect(built.warnings).toEqual([]);
      const pad = built.bodyRepresentations[padded.bodyId]!;
      expect(pad.bbox.min.z).toBeCloseTo(20, 6);
      expect(pad.bbox.max.z).toBeCloseTo(25, 6);
      expect(pad.bbox.min.x).toBeCloseTo(1, 6);
      expect(pad.bbox.min.y).toBeCloseTo(1, 6);
      expect(pad.volume).toBeCloseTo(4 * 6 * 5, 6);
    }
  });

  it('mirrors across a plane parallel to YZ through a typed point at x = 30', async () => {
    const { document, bodyId } = block();
    const planed = addDatumPlane(document, {
      name: 'Side',
      definition: {
        kind: 'parallel-point',
        source: { type: 'canonical', plane: 'YZ', offset: 0 },
        point: { type: 'point', point: { x: '25 + 5', y: 7, z: -3 } }
      }
    });
    const mirrored = mirrorBody(planed.document, {
      name: 'Mirror',
      targetBodyId: bodyId,
      plane: datum(planed.featureId)
    });
    for (const adapter of [remus, occt]) {
      const built = await adapter.syncDocument(mirrored.document);
      expect(built.warnings).toEqual([]);
      const copy = built.bodyRepresentations[mirrored.bodyId]!;
      expect(copy.bbox.min.x).toBeCloseTo(40, 6);
      expect(copy.bbox.max.x).toBeCloseTo(60, 6);
      expect(copy.volume).toBeCloseTo(20 * 20 * 20, 6);
    }
  });

  it('pads on a plane parallel to XY through a top vertex of the block', async () => {
    const { document, bodyId } = block();
    const derived = await remus.syncDocument(document);
    const planed = addDatumPlane(document, {
      name: 'Lid',
      definition: {
        kind: 'parallel-point',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        point: vertexOf(derived, bodyId, v(20, 20, 20), v(20, 20, 0))
      }
    });
    const sketched = addSketchFeature(planed.document, {
      name: 'Pad sketch',
      planeRef: datum(planed.featureId),
      objects: [
        { objectKind: 'rectangle', width: 4, height: 6, centerX: 0, centerY: 0 }
      ]
    });
    const padded = extrudeSketch(sketched.document, {
      name: 'Pad',
      sketchId: sketched.sketchId,
      distance: 5
    });
    for (const adapter of [remus, occt]) {
      const built = await adapter.syncDocument(padded.document);
      expect(built.warnings).toEqual([]);
      const pad = built.bodyRepresentations[padded.bodyId]!;
      // The origin is the vertex: the rectangle centres on (20, 20).
      expect(pad.bbox.min.x).toBeCloseTo(18, 6);
      expect(pad.bbox.min.y).toBeCloseTo(17, 6);
      expect(pad.bbox.min.z).toBeCloseTo(20, 6);
      expect(pad.bbox.max.z).toBeCloseTo(25, 6);
    }
  });

  it('refuses collinear points in both kernels', async () => {
    const planed = addDatumPlane(
      createProjectDocument('Collinear', toUserId('user_r01_pp')),
      {
        name: 'Line',
        definition: {
          kind: 'three-point',
          points: [
            { type: 'point', point: { x: 0, y: 0, z: 0 } },
            { type: 'point', point: { x: 1, y: 2, z: 3 } },
            { type: 'point', point: { x: 2, y: 4, z: 6 } }
          ]
        }
      }
    );
    for (const adapter of [remus, occt]) {
      const built = await adapter.syncDocument(planed.document);
      expect(built.warnings.join('\n')).toMatch(/collinear/);
    }
  });
});
