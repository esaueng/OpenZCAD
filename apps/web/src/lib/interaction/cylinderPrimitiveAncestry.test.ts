import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  filletEdges,
  listFeaturesInOrder,
  offsetSolidBody,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  toUserId,
  type FaceTopologyReferenceV5,
  type FaceWitnessV1,
  type FeatureId
} from '@openzcad/shared';
import {
  primitiveCylinderHeightAncestor,
  primitiveCylinderRadiusAncestor
} from './cylinderPrimitiveAncestry';

function cylinderDocument() {
  return addPrimitiveFeature(
    createProjectDocument('Cylinder ancestry', toUserId('user_ancestry')),
    {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4.6, height: 12 }
    }
  );
}

describe('cylinder radius ancestry', () => {
  it('walks a mixed fillet/chamfer result chain back to its primitive', () => {
    const cylinder = cylinderDocument();
    const sourceBodyId = cylinder.bodyOrder[0]!;
    const fillet = filletEdges(cylinder, {
      name: 'First rim fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [101],
      size: 1
    });
    const moved = transformBody(fillet.document, {
      name: 'Move blend',
      targetBodyId: fillet.bodyId,
      translation: { x: 5, y: 0, z: 0 }
    });
    const chamfer = chamferEdges(moved.document, {
      name: 'Second rim chamfer',
      targetBodyId: fillet.bodyId,
      edgeHashes: [202],
      size: 0.5
    });

    expect(
      primitiveCylinderRadiusAncestor(chamfer.document, chamfer.bodyId)
        ?.featureId
    ).toBe(listFeaturesInOrder(cylinder)[0]!.featureId);
  });

  it('stops at direct edits and other body-producing feature boundaries', () => {
    const cylinder = cylinderDocument();
    const sourceBodyId = cylinder.bodyOrder[0]!;
    const fillet = filletEdges(cylinder, {
      name: 'Rim fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [101],
      size: 1
    });
    const edited = directEditBody(fillet.document, {
      name: 'Resize derived wall',
      targetBodyId: fillet.bodyId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: 303,
        sourceRadius: 4.6,
        sourceAxisStart: { x: 0, y: 0, z: 0 },
        sourceAxisEnd: { x: 0, y: 0, z: 12 },
        concavity: 'boss',
        radius: 5
      }
    });
    expect(
      primitiveCylinderRadiusAncestor(edited.document, fillet.bodyId)
    ).toBeNull();

    const siblingEdit = directEditBody(fillet.document, {
      name: 'Resize consumed source branch',
      targetBodyId: sourceBodyId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: 304,
        sourceRadius: 4.6,
        sourceAxisStart: { x: 0, y: 0, z: 0 },
        sourceAxisEnd: { x: 0, y: 0, z: 12 },
        concavity: 'boss',
        radius: 5
      }
    });
    expect(
      primitiveCylinderRadiusAncestor(siblingEdit.document, fillet.bodyId)
        ?.featureId
    ).toBe(sourceFeatureId(cylinder));

    const offset = offsetSolidBody(cylinder, {
      name: 'Offset cylinder',
      targetBodyId: sourceBodyId,
      distance: 0.25
    });
    const filletedOffset = filletEdges(offset.document, {
      name: 'Offset rim fillet',
      targetBodyId: offset.bodyId,
      edgeHashes: [404],
      size: 0.5
    });
    expect(
      primitiveCylinderRadiusAncestor(
        filletedOffset.document,
        filletedOffset.bodyId
      )
    ).toBeNull();
  });

  it('crosses a referenced cap offset but not a reference-free one', () => {
    const cylinder = cylinderDocument();
    const sourceBodyId = cylinder.bodyOrder[0]!;
    const capReference: FaceTopologyReferenceV5 = {
      kind: 'face',
      producingFeatureId: sourceFeatureId(cylinder),
      lineageName: 'primitive.cylinder.face.cap.end',
      currentHash: 505,
      witnessVersion: 1,
      witness: {} as FaceWitnessV1
    };
    const capOffset = (faceReference?: FaceTopologyReferenceV5) =>
      directEditBody(cylinder, {
        name: 'Offset cap',
        targetBodyId: sourceBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: 505,
          ...(faceReference ? { faceReference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: 66.5,
          sourceCenter: { x: 0, y: 0, z: 12 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 5
        }
      });

    const referenced = filletEdges(capOffset(capReference).document, {
      name: 'Rim fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [101],
      size: 1
    });
    expect(
      primitiveCylinderRadiusAncestor(referenced.document, referenced.bodyId)
        ?.featureId
    ).toBe(sourceFeatureId(cylinder));

    const bare = filletEdges(capOffset(undefined).document, {
      name: 'Rim fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [101],
      size: 1
    });
    expect(
      primitiveCylinderRadiusAncestor(bare.document, bare.bodyId)
    ).toBeNull();
  });

  it('does not overwrite a parametric radius expression', () => {
    const cylinder = cylinderDocument();
    const sourceBodyId = cylinder.bodyOrder[0]!;
    const sourceFeature = listFeaturesInOrder(cylinder)[0]!;
    const parametric = updateFeature(cylinder, {
      featureId: sourceFeature.featureId,
      data: { dimensions: { radius: 'base_radius' } }
    });

    expect(
      primitiveCylinderRadiusAncestor(parametric, sourceBodyId)
    ).toBeNull();
  });
});

describe('cylinder height ancestry', () => {
  const TOP_CAP_HASH = 707;

  function capReference(
    producingFeatureId: FeatureId,
    lineageName: string,
    currentHash = TOP_CAP_HASH
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

  function filletedCylinder() {
    const cylinder = cylinderDocument();
    const fillet = filletEdges(cylinder, {
      name: 'Round All Outside Edges',
      targetBodyId: cylinder.bodyOrder[0]!,
      edgeHashes: [101],
      size: 2
    });
    return {
      cylinder,
      fillet,
      filletFeatureId: listFeaturesInOrder(fillet.document).at(-1)!.featureId
    };
  }

  it('grows the primitive behind a filleted top cap', () => {
    const { cylinder, fillet, filletFeatureId } = filletedCylinder();

    expect(
      primitiveCylinderHeightAncestor(
        fillet.document,
        fillet.bodyId,
        capReference(filletFeatureId, 'modifier.cylinder.face.cap.end'),
        TOP_CAP_HASH
      )?.featureId
    ).toBe(sourceFeatureId(cylinder));
  });

  it('grows the primitive behind its own bare top cap', () => {
    const cylinder = cylinderDocument();
    const sourceBodyId = cylinder.bodyOrder[0]!;

    expect(
      primitiveCylinderHeightAncestor(
        cylinder,
        sourceBodyId,
        capReference(
          sourceFeatureId(cylinder),
          'primitive.cylinder.face.cap.end'
        ),
        TOP_CAP_HASH
      )?.featureId
    ).toBe(sourceFeatureId(cylinder));
  });

  it('leaves every face that is not the axial-maximum cap alone', () => {
    const { fillet, filletFeatureId } = filletedCylinder();

    for (const lineageName of [
      // The primitive grows from its base, so a start-cap drag would have to
      // move the body too and stays on the generic offset.
      'modifier.cylinder.face.cap.start',
      'modifier.cylinder.face.wall',
      'modifier.cylinder.face.blend.end',
      'primitive.box.face.z-max'
    ]) {
      expect(
        primitiveCylinderHeightAncestor(
          fillet.document,
          fillet.bodyId,
          capReference(filletFeatureId, lineageName),
          TOP_CAP_HASH
        )
      ).toBeNull();
    }
  });

  it('refuses a face with no reference, a stale one, or a foreign publisher', () => {
    const { cylinder, fillet, filletFeatureId } = filletedCylinder();
    const topCap = 'modifier.cylinder.face.cap.end';
    const outsider = filletEdges(cylinder, {
      name: 'Unrelated fillet',
      targetBodyId: cylinder.bodyOrder[0]!,
      edgeHashes: [999],
      size: 0.5
    });
    const outsiderFeatureId = listFeaturesInOrder(outsider.document)
      .at(-1)!
      .featureId;

    expect(
      primitiveCylinderHeightAncestor(
        fillet.document,
        fillet.bodyId,
        undefined,
        TOP_CAP_HASH
      )
    ).toBeNull();
    expect(
      primitiveCylinderHeightAncestor(
        fillet.document,
        fillet.bodyId,
        capReference(filletFeatureId, topCap, TOP_CAP_HASH + 1),
        TOP_CAP_HASH
      )
    ).toBeNull();
    expect(
      primitiveCylinderHeightAncestor(
        fillet.document,
        fillet.bodyId,
        capReference(outsiderFeatureId, topCap),
        TOP_CAP_HASH
      )
    ).toBeNull();
  });

  it('stops at a foreign producer and at an expression-driven height', () => {
    const cylinder = cylinderDocument();
    const sourceBodyId = cylinder.bodyOrder[0]!;
    const topCap = 'primitive.cylinder.face.cap.end';

    const offset = offsetSolidBody(cylinder, {
      name: 'Offset cylinder',
      targetBodyId: sourceBodyId,
      distance: 0.25
    });
    const offsetFeatureId = listFeaturesInOrder(offset.document)
      .at(-1)!
      .featureId;
    expect(
      primitiveCylinderHeightAncestor(
        offset.document,
        offset.bodyId,
        capReference(offsetFeatureId, topCap),
        TOP_CAP_HASH
      )
    ).toBeNull();

    const parametric = updateFeature(cylinder, {
      featureId: sourceFeatureId(cylinder),
      data: { dimensions: { radius: 4.6, height: 'stack_height' } }
    });
    expect(
      primitiveCylinderHeightAncestor(
        parametric,
        sourceBodyId,
        capReference(sourceFeatureId(cylinder), topCap),
        TOP_CAP_HASH
      )
    ).toBeNull();
  });

  it('crosses a referenced cap offset the way a radius edit does', () => {
    const cylinder = cylinderDocument();
    const sourceBodyId = cylinder.bodyOrder[0]!;
    const topCap = 'primitive.cylinder.face.cap.end';
    const capOffset = (faceReference?: FaceTopologyReferenceV5) =>
      directEditBody(cylinder, {
        name: 'Offset cap',
        targetBodyId: sourceBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: 505,
          ...(faceReference ? { faceReference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: 66.5,
          sourceCenter: { x: 0, y: 0, z: 12 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 5
        }
      });
    const referenced = capReference(sourceFeatureId(cylinder), topCap, 505);

    const withReference = filletEdges(capOffset(referenced).document, {
      name: 'Rim fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [101],
      size: 1
    });
    const filletFeatureId = listFeaturesInOrder(withReference.document)
      .at(-1)!
      .featureId;
    expect(
      primitiveCylinderHeightAncestor(
        withReference.document,
        withReference.bodyId,
        capReference(filletFeatureId, 'modifier.cylinder.face.cap.end'),
        TOP_CAP_HASH
      )?.featureId
    ).toBe(sourceFeatureId(cylinder));

    const bare = filletEdges(capOffset(undefined).document, {
      name: 'Rim fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [101],
      size: 1
    });
    const bareFilletFeatureId = listFeaturesInOrder(bare.document)
      .at(-1)!
      .featureId;
    expect(
      primitiveCylinderHeightAncestor(
        bare.document,
        bare.bodyId,
        capReference(bareFilletFeatureId, 'modifier.cylinder.face.cap.end'),
        TOP_CAP_HASH
      )
    ).toBeNull();
  });
});

function sourceFeatureId(document: ReturnType<typeof cylinderDocument>) {
  return listFeaturesInOrder(document)[0]!.featureId;
}
