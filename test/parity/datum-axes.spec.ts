import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  patternBody,
  revolveSketch,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { CURRENT_CANONICAL_BASIS_REVISION } from '@openzcad/geometry';
import {
  toUserId,
  type BodyId,
  type DatumAxisDefinition,
  type DerivedState,
  type EdgeTopologyReferenceV5,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { OcctStepKernelAdapter } from './occt-reference/occt-step';

/**
 * R01 datum axes resolve the same line in the Remus build and the OCCT
 * parity reference — through two points, where two planes meet, along a
 * block edge re-found through each kernel's own lineage, and along a
 * cylinder's axis — and each consumer (revolve, circular pattern, Move)
 * turns about it to the analytic result in both kernels.
 */

const xz = {
  type: 'canonical',
  plane: 'XZ',
  offset: 0,
  basisRevision: CURRENT_CANONICAL_BASIS_REVISION
} as const;
const yz = { type: 'canonical', plane: 'YZ', offset: 0 } as const;
const at = (x: number | string, y: number | string, z: number | string) =>
  ({ type: 'point', point: { x, y, z } }) as const;
const axisRef = (datumFeatureId: FeatureId) =>
  ({ type: 'datum-axis', datumFeatureId }) as const;

function blank(): ProjectDocument {
  return createProjectDocument('Datum axes parity', toUserId('user_r01_ax'));
}

function withAxis(document: ProjectDocument, definition: DatumAxisDefinition) {
  return addDatumAxis(document, { name: 'Axis', definition });
}

function block(document: ProjectDocument, size = 2) {
  const next = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: size, height: size, depth: size }
  });
  return { document: next, bodyId: next.bodyOrder.at(-1)! };
}

/** The block's vertical edge at (x, y), by its lineage. */
function verticalEdge(
  derived: DerivedState,
  bodyId: BodyId,
  x: number,
  y: number
): EdgeTopologyReferenceV5 {
  const edge = derived.bodyRepresentations[bodyId]?.topology?.edges.find(
    (candidate) => {
      const witness = candidate.reference?.witness;
      return (
        witness !== undefined &&
        !witness.closed &&
        witness.endpoints.every(
          ([ex, ey]) =>
            Math.abs(ex * 1e-6 - x) < 1e-9 && Math.abs(ey * 1e-6 - y) < 1e-9
        )
      );
    }
  );
  expect(edge?.reference).toBeDefined();
  return edge!.reference!;
}

describe('datum axes across exact kernels', () => {
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

  async function inBoth(
    document: ProjectDocument,
    check: (derived: DerivedState) => void
  ) {
    for (const adapter of [remus, occt]) {
      const built = await adapter.syncDocument(document);
      expect(built.warnings).toEqual([]);
      check(built);
    }
  }

  function profile(document: ProjectDocument) {
    // x 10..14, z 0..6 on the front-facing XZ plane.
    return addSketchFeature(document, {
      name: 'Profile',
      planeRef: xz,
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 6,
          centerX: 12,
          centerY: 3
        }
      ]
    });
  }

  it('revolves about the axis where XZ and YZ meet', async () => {
    const sketched = profile(blank());
    const crossing = withAxis(sketched.document, {
      kind: 'plane-intersection',
      sources: [xz, yz]
    });
    const revolved = revolveSketch(crossing.document, {
      name: 'Ring',
      sketchId: sketched.sketchId,
      axis: 'horizontal',
      axisRef: axisRef(crossing.featureId)
    });
    await inBoth(revolved.document, (derived) => {
      const ring = derived.bodyRepresentations[revolved.bodyId]!;
      expect(ring.volume).toBeCloseTo(Math.PI * (14 ** 2 - 10 ** 2) * 6, 2);
      expect(ring.bbox.min.x).toBeCloseTo(-14, 5);
      expect(ring.bbox.max.y).toBeCloseTo(14, 5);
      expect(ring.bbox.max.z).toBeCloseTo(6, 5);
    });
  });

  it('revolves about a two-point axis off the sketch origin', async () => {
    const sketched = profile(blank());
    const axis = withAxis(sketched.document, {
      kind: 'two-point',
      points: [at('15 + 5', 0, 0), at(20, 0, 10)]
    });
    const revolved = revolveSketch(axis.document, {
      name: 'Ring',
      sketchId: sketched.sketchId,
      axis: 'horizontal',
      axisRef: axisRef(axis.featureId)
    });
    await inBoth(revolved.document, (derived) => {
      const ring = derived.bodyRepresentations[revolved.bodyId]!;
      expect(ring.volume).toBeCloseTo(Math.PI * (10 ** 2 - 6 ** 2) * 6, 2);
      expect(ring.bbox.min.x).toBeCloseTo(10, 5);
      expect(ring.bbox.max.x).toBeCloseTo(30, 5);
    });
  });

  it('patterns a block about the axis along another block’s edge', async () => {
    const post = addPrimitiveFeature(blank(), {
      name: 'Post',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const postId = post.bodyOrder.at(-1)!;
    const derived = await remus.syncDocument(post);
    // The post's vertical edge at (10, 0), re-found by lineage in each kernel.
    const axis = withAxis(post, {
      kind: 'edge',
      source: {
        type: 'edge',
        bodyId: postId,
        edgeReference: verticalEdge(derived, postId, 10, 0)
      }
    });
    const seed = block(axis.document);
    const ringed = patternBody(seed.document, {
      name: 'Ring',
      targetBodyId: seed.bodyId,
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      angleDeg: 360,
      axisRef: axisRef(axis.featureId)
    });
    await inBoth(ringed.document, (built) => {
      const ring = built.bodyRepresentations[ringed.bodyId]!;
      expect(ring.volume).toBeCloseTo(4 * 8, 5);
      expect(ring.bbox.min.x).toBeCloseTo(0, 5);
      expect(ring.bbox.max.x).toBeCloseTo(20, 5);
      expect(ring.bbox.min.y).toBeCloseTo(-10, 5);
      expect(ring.bbox.max.y).toBeCloseTo(10, 5);
    });
  });

  it('turns a Move half a turn about a cylinder’s axis', async () => {
    const post = addPrimitiveFeature(blank(), {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 10 }
    });
    const postId = post.bodyOrder.at(-1)!;
    const derived = await remus.syncDocument(post);
    const side = derived.bodyRepresentations[postId]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const { axisStart } = side.geometry!;
    const axis = withAxis(post, {
      kind: 'cylinder',
      source: { type: 'face', bodyId: postId, faceReference: side.reference! }
    });
    const seed = block(axis.document);
    const moved = transformBody(seed.document, {
      name: 'Turn',
      targetBodyId: seed.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      axisRotation: { axis: axisRef(axis.featureId), angleDeg: 180 }
    });
    // Half a turn about the vertical line (cx, cy) maps x ↦ 2cx − x.
    const cx = axisStart!.x;
    const cy = axisStart!.y;
    await inBoth(moved.document, (built) => {
      const turned = built.bodyRepresentations[seed.bodyId]!.bbox;
      expect(turned.min.x).toBeCloseTo(2 * cx - 2, 5);
      expect(turned.max.x).toBeCloseTo(2 * cx, 5);
      expect(turned.min.y).toBeCloseTo(2 * cy - 2, 5);
      expect(turned.min.z).toBeCloseTo(0, 5);
    });
  });

  it('refuses parallel planes in both kernels', async () => {
    const lid = addDatumPlane(blank(), {
      name: 'Lid',
      definition: {
        kind: 'offset',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        offset: 4
      }
    });
    const parallel = withAxis(lid.document, {
      kind: 'plane-intersection',
      sources: [
        { type: 'canonical', plane: 'XY', offset: 0 },
        { type: 'datum', datumFeatureId: lid.featureId }
      ]
    });
    for (const adapter of [remus, occt]) {
      const built = await adapter.syncDocument(parallel.document);
      expect(built.warnings.join('\n')).toMatch(/these are parallel/);
    }
  });
});
