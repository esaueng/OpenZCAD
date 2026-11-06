import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  directEditBody,
  extrudeSketch,
  findSketch,
  listFeaturesInOrder,
  moveFeature,
  transformBody
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

describe('extrude far cap across a boolean', () => {
  function joined(
    operation: 'union' | 'subtract' | 'intersect',
    distance = 8,
    extrudeOperation?: 'add'
  ) {
    const { document, bodyId, featureId } = extruded({
      distance,
      ...(extrudeOperation ? { operation: extrudeOperation } : {})
    });
    const plate = document.bodyOrder[0]!;
    const result = booleanBodies(document, {
      name: 'Combine',
      operation,
      targetBodyIds: [plate, bodyId]
    });
    const booleanId = listFeaturesInOrder(result.document).at(-1)!.featureId;
    return {
      document: result.document,
      bodyId: result.bodyId,
      extrudeBodyId: bodyId,
      featureId,
      cap: reference(
        booleanId,
        'boolean.face.operand.1.sweep.face.cap.end.region.ent_1'
      )
    };
  }

  it('drives the consumed extrude, with the cut turning the floor inside out', () => {
    const union = joined('union');
    expect(
      extrudeCapAncestor(union.document, union.bodyId, union.cap, HASH)
    ).toMatchObject({ feature: { featureId: union.featureId }, sense: 1 });
    // A pocket's floor is the tool's far cap facing back up the pocket.
    const cut = joined('subtract', -6);
    expect(
      extrudeCapAncestor(cut.document, cut.bodyId, cut.cap, HASH)
    ).toMatchObject({ feature: { featureId: cut.featureId }, sense: 1 });
    const grown = joined('subtract', 6);
    expect(
      extrudeCapAncestor(grown.document, grown.bodyId, grown.cap, HASH)?.sense
    ).toBe(-1);
  });

  it('refuses an intersect, a start cap, a stale or foreign role, and a merged extrude', () => {
    const intersected = joined('intersect');
    expect(
      extrudeCapAncestor(
        intersected.document,
        intersected.bodyId,
        intersected.cap,
        HASH
      )
    ).toBeNull();
    const { document, bodyId, cap, featureId } = joined('union');
    for (const candidate of [
      { ...cap, lineageName: 'boolean.face.operand.1.sweep.face.cap.start' },
      { ...cap, currentHash: HASH + 1 },
      { ...cap, producingFeatureId: featureId }
    ]) {
      expect(
        extrudeCapAncestor(document, bodyId, candidate, HASH),
        candidate.lineageName
      ).toBeNull();
    }
    const merged = joined('union', 8, 'add');
    expect(
      extrudeCapAncestor(merged.document, merged.bodyId, merged.cap, HASH)
    ).toBeNull();
  });

  it('stops at a copied or scaled source and an earlier move of the same cap', () => {
    const copied = joined('union');
    const withCopy = transformBody(copied.document, {
      name: 'Copy',
      targetBodyId: copied.extrudeBodyId,
      translation: { x: 50, y: 0, z: 0 },
      copy: true
    }).document;
    expect(
      extrudeCapAncestor(withCopy, copied.bodyId, copied.cap, HASH)
    ).toBeNull();

    const scaled = joined('union');
    const features = listFeaturesInOrder(scaled.document);
    const scaledDocument = transformBody(scaled.document, {
      name: 'Scale',
      targetBodyId: scaled.extrudeBodyId,
      translation: { x: 0, y: 0, z: 0 },
      scale: 2
    }).document;
    // Move the scale before the boolean that consumes the boss.
    const scale = listFeaturesInOrder(scaledDocument).at(-1)!;
    const reordered = moveFeature(scaledDocument, {
      featureId: scale.featureId,
      toIndex: features.length - 1
    });
    expect(
      extrudeCapAncestor(reordered, scaled.bodyId, scaled.cap, HASH)
    ).toBeNull();

    const { document, bodyId, cap } = joined('union');
    const offset = (lineageName: string) =>
      directEditBody(document, {
        name: 'Offset face',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: 77,
          faceReference: { ...cap, lineageName, currentHash: 77 },
          sourceSurfaceType: 'plane',
          sourceArea: 60,
          sourceCenter: { x: 20, y: 12, z: 18 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 2
        }
      }).document;
    expect(
      extrudeCapAncestor(offset(cap.lineageName), bodyId, cap, HASH)
    ).toBeNull();
    expect(
      extrudeCapAncestor(
        offset('boolean.face.operand.0.primitive.box.face.z-min'),
        bodyId,
        cap,
        HASH
      )?.feature.name
    ).toBe('Boss');
  });
});
