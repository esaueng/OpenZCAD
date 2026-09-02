import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type FaceTopologyReferenceV5,
  type FaceWitnessV1,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { faceOffsetBaseline, planFaceOffset } from './faceOffsetPlan';

/**
 * The far cap of an extrude re-plans a face offset as an edit of the stored
 * distance. The kernel-backed sign table lives in
 * `test/extrude-cap-drag.test.ts`; this pins the plan's shape without a
 * kernel: the command it emits, the expression it composes, and the refusal
 * at zero depth.
 */

const user = toUserId('user_face_offset_plan');

function extrudedPlate(
  distance: number | string,
  operation: 'add' | 'cut' | 'new-body' = 'add'
): { document: ProjectDocument; bodyId: BodyId; featureId: FeatureId } {
  const plate = addPrimitiveFeature(createProjectDocument('Plan', user), {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 24, depth: 10 }
  });
  const { document: withSketch, sketchId } = addSketchFeature(plate, {
    name: 'Top sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 6,
        centerX: 20,
        centerY: 12
      }
    ]
  });
  const objectIds = [...(findSketch(withSketch, sketchId)?.objectIds ?? [])];
  const { document, bodyId } = extrudeSketch(withSketch, {
    name: 'Boss',
    sketchId,
    distance,
    ...(operation === 'new-body'
      ? {}
      : { operation, targetBodyId: plate.bodyOrder[0]! }),
    profiles: [{ all: true, sourceEntityIds: objectIds }]
  });
  const featureId = listFeaturesInOrder(document).find(
    (feature) => feature.name === 'Boss'
  )!.featureId;
  return { document, bodyId, featureId };
}

const CAP_HASH = 4242;

function capFace(
  featureId: FeatureId,
  normalZ: 1 | -1,
  lineageName = 'boolean.face.tool.sweep.face.cap.end.region.abc'
): FaceTopology {
  const reference: FaceTopologyReferenceV5 = {
    kind: 'face',
    producingFeatureId: featureId,
    lineageName,
    currentHash: CAP_HASH,
    witnessVersion: 1,
    witness: {} as FaceWitnessV1
  };
  return {
    topologyId: 'face:cap',
    hash: CAP_HASH,
    triangleStart: 0,
    triangleCount: 2,
    reference,
    geometry: {
      surfaceType: 'plane',
      area: 60,
      center: { x: 20, y: 12, z: 18 },
      normal: { x: 0, y: 0, z: normalZ }
    }
  };
}

describe('planFaceOffset on an extrude far cap', () => {
  it('edits the stored distance of a boss with the drag', () => {
    const { document, bodyId, featureId } = extrudedPlate(8);
    const plan = planFaceOffset({
      document,
      bodyId,
      face: capFace(featureId, 1),
      faceHash: CAP_HASH,
      offset: 2.5
    });
    expect(plan?.kind).toBe('extrude-distance');
    if (plan?.kind !== 'extrude-distance') {
      return;
    }
    expect(plan.feature.featureId).toBe(featureId);
    expect(plan.value).toBe(10.5);
    expect(plan.command.label).toBe('Edit Boss');
    const edited = plan.command.apply(document);
    const feature = listFeaturesInOrder(edited).find(
      (candidate) => candidate.featureId === featureId
    )!;
    expect(
      feature.data.featureKind === 'extrude' && feature.data.distance
    ).toBe(10.5);
    expect(
      faceOffsetBaseline(document, bodyId, capFace(featureId, 1), CAP_HASH)
    ).toEqual({ total: 8, sense: 1 });
  });

  it('keeps a typed expression live with the sense folded in', () => {
    const { document, bodyId, featureId } = extrudedPlate(-4, 'cut');
    const plan = planFaceOffset({
      document,
      bodyId,
      face: capFace(featureId, 1),
      faceHash: CAP_HASH,
      offset: 1,
      exact: 'lip'
    });
    expect(plan?.kind).toBe('extrude-distance');
    if (plan?.kind !== 'extrude-distance') {
      return;
    }
    // A pocket floor pulled outward adds to its negative distance.
    expect(plan.value).toBe(-3);
    const feature = listFeaturesInOrder(plan.command.apply(document)).find(
      (candidate) => candidate.featureId === featureId
    )!;
    expect(
      feature.data.featureKind === 'extrude' && feature.data.distance
    ).toBe('-4 + (lip)');
    expect(
      faceOffsetBaseline(document, bodyId, capFace(featureId, 1), CAP_HASH)
    ).toEqual({ total: -4, sense: 1 });
  });

  it('refuses a drag through the sketch plane and a stale cap', () => {
    const { document, bodyId, featureId } = extrudedPlate(8);
    const through = planFaceOffset({
      document,
      bodyId,
      face: capFace(featureId, 1),
      faceHash: CAP_HASH,
      offset: -8
    });
    expect(
      through?.kind === 'extrude-distance' ? through.preflightRejection : null
    ).toMatch(/no depth/);
    // A reference whose hash has moved on is not this face; the drag falls
    // back to the local push/pull rather than editing the wrong feature.
    const stale = planFaceOffset({
      document,
      bodyId,
      face: capFace(featureId, 1),
      faceHash: CAP_HASH + 1,
      offset: 1
    });
    expect(stale?.kind).toBe('direct-edit');
    expect(
      faceOffsetBaseline(document, bodyId, capFace(featureId, 1), CAP_HASH + 1)
    ).toBeUndefined();
  });

  it('leaves the near cap and a two-sided extrude on the local offset', () => {
    const { document, bodyId, featureId } = extrudedPlate(8);
    const near = planFaceOffset({
      document,
      bodyId,
      face: capFace(
        featureId,
        -1,
        'boolean.face.tool.sweep.face.cap.start.region.abc'
      ),
      faceHash: CAP_HASH,
      offset: 1
    });
    expect(near?.kind).toBe('direct-edit');

    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Two-sided', user),
      {
        name: 'Mid sketch',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          {
            objectKind: 'rectangle',
            width: 10,
            height: 6,
            centerX: 0,
            centerY: 0
          }
        ]
      }
    );
    const twoSided = extrudeSketch(withSketch, {
      name: 'Both ways',
      sketchId,
      distance: 8,
      symmetric: true
    });
    const bothWays = listFeaturesInOrder(twoSided.document).find(
      (feature) => feature.name === 'Both ways'
    )!;
    // Two faces move with the distance, so neither is "the" cap to drag.
    const plan = planFaceOffset({
      document: twoSided.document,
      bodyId: twoSided.bodyId,
      face: capFace(bothWays.featureId, 1, 'sweep.face.cap.end.region.abc'),
      faceHash: CAP_HASH,
      offset: 1
    });
    expect(plan?.kind).toBe('direct-edit');
  });
});
