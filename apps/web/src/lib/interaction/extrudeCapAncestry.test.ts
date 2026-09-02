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
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type FaceTopologyReferenceV5,
  type FaceWitnessV1,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { extrudeCapAncestor } from './extrudeCapAncestry';

const user = toUserId('user_extrude_cap');
const HASH = 99;

function reference(
  producingFeatureId: FeatureId,
  lineageName: string,
  currentHash = HASH
): FaceTopologyReferenceV5 {
  return {
    kind: 'face',
    producingFeatureId,
    lineageName,
    currentHash,
    witnessVersion: 1,
    witness: {} as FaceWitnessV1
  };
}

function extruded(input: {
  distance: number | string;
  operation?: 'add' | 'cut';
  symmetric?: boolean;
  backDistance?: number;
}): { document: ProjectDocument; bodyId: BodyId; featureId: FeatureId } {
  const plate = addPrimitiveFeature(createProjectDocument('Cap', user), {
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
    distance: input.distance,
    ...(input.operation
      ? { operation: input.operation, targetBodyId: plate.bodyOrder[0]! }
      : {}),
    ...(input.symmetric ? { symmetric: true } : {}),
    ...(input.backDistance !== undefined
      ? { backDistance: input.backDistance }
      : {}),
    profiles: [{ all: true, sourceEntityIds: objectIds }]
  });
  const featureId = listFeaturesInOrder(document).find(
    (feature) => feature.name === 'Boss'
  )!.featureId;
  return { document, bodyId, featureId };
}

describe('extrudeCapAncestor', () => {
  it('proves the far cap under both the region and the boolean vocabulary', () => {
    const { document, bodyId, featureId } = extrudedPlate();
    for (const name of [
      'sweep.face.cap.end.region.abc',
      'boolean.face.tool.sweep.face.cap.end.region.abc',
      'sweep.face.cap.end.ent_1'
    ]) {
      const cap = extrudeCapAncestor(
        document,
        bodyId,
        reference(featureId, name),
        HASH
      );
      expect(cap?.feature.featureId, name).toBe(featureId);
      expect(cap?.distance).toBe(8);
      expect(cap?.sense).toBe(1);
    }
  });

  it('signs the drag by the cap orientation and the operation', () => {
    const cases = [
      { distance: 8, operation: 'add', sense: 1 },
      { distance: -8, operation: undefined, sense: -1 },
      { distance: -4, operation: 'cut', sense: 1 },
      { distance: 4, operation: 'cut', sense: -1 }
    ] as const;
    for (const { distance, operation, sense } of cases) {
      const { document, bodyId, featureId } = extruded({
        distance,
        ...(operation ? { operation } : {})
      });
      expect(
        extrudeCapAncestor(
          document,
          bodyId,
          reference(featureId, 'sweep.face.cap.end.region.abc'),
          HASH
        )?.sense,
        `${operation ?? 'new-body'} ${distance}`
      ).toBe(sense);
    }
  });

  it('fails closed on anything it cannot prove', () => {
    const { document, bodyId, featureId } = extrudedPlate();
    const cap = 'sweep.face.cap.end.region.abc';
    // Not this face.
    expect(extrudeCapAncestor(document, bodyId, undefined, HASH)).toBeNull();
    expect(
      extrudeCapAncestor(
        document,
        bodyId,
        reference(featureId, cap, HASH + 1),
        HASH
      )
    ).toBeNull();
    // The near cap, a wall, the target operand's face.
    for (const name of [
      'sweep.face.cap.start.region.abc',
      'sweep.face.side.region.abc.ent_1.segment',
      'boolean.face.target.primitive.box.face.z-max'
    ]) {
      expect(
        extrudeCapAncestor(document, bodyId, reference(featureId, name), HASH),
        name
      ).toBeNull();
    }
    // Another feature's name, or another body.
    const plate = listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Plate'
    )!;
    expect(
      extrudeCapAncestor(
        document,
        bodyId,
        reference(plate.featureId, cap),
        HASH
      )
    ).toBeNull();
    expect(
      extrudeCapAncestor(
        document,
        document.bodyOrder[0]!,
        reference(featureId, cap),
        HASH
      )
    ).toBeNull();
    // Two-sided, expression-driven, and suppressed extrudes.
    for (const variant of [
      extruded({ distance: 8, symmetric: true }),
      extruded({ distance: 8, backDistance: 2 }),
      extruded({ distance: 'h' })
    ]) {
      expect(
        extrudeCapAncestor(
          variant.document,
          variant.bodyId,
          reference(variant.featureId, cap),
          HASH
        )
      ).toBeNull();
    }
    const suppressed = structuredClone(document);
    const node = listFeaturesInOrder(suppressed).find(
      (feature) => feature.featureId === featureId
    )!;
    node.metadata = {
      ...node.metadata,
      [FEATURE_SUPPRESSED_METADATA_KEY]: true
    };
    expect(
      extrudeCapAncestor(suppressed, bodyId, reference(featureId, cap), HASH)
    ).toBeNull();
  });
});

function extrudedPlate() {
  return extruded({ distance: 8, operation: 'add' });
}
