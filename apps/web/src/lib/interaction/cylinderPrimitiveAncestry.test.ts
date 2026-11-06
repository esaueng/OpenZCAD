import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
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
  type EdgeTopologyReferenceV5,
  type EdgeWitnessV1,
  type FaceTopologyReferenceV5,
  type BodyId,
  type FaceWitnessV1,
  type FeatureId
} from '@openzcad/shared';
import {
  primitiveBoxFaceAncestor,
  primitiveConeCapAncestor,
  primitiveCurvedFaceAncestor,
  primitiveCylinderCapAncestor,
  primitiveCylinderHeightAncestor,
  primitiveCylinderRadiusAncestor,
  primitiveCylinderScale
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

  it('leaves every face that is not a cylinder cap alone', () => {
    const { fillet, filletFeatureId } = filletedCylinder();

    for (const lineageName of [
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
    const outsiderFeatureId = listFeaturesInOrder(outsider.document).at(
      -1
    )!.featureId;

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
    const offsetFeatureId = listFeaturesInOrder(offset.document).at(
      -1
    )!.featureId;
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
    const filletFeatureId = listFeaturesInOrder(withReference.document).at(
      -1
    )!.featureId;
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
    const bareFilletFeatureId = listFeaturesInOrder(bare.document).at(
      -1
    )!.featureId;
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

describe('box side ancestry', () => {
  function joinedBox() {
    const box = addPrimitiveFeature(
      createProjectDocument('Joined box', toUserId('user_ancestry')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 26 }
      }
    );
    const cylinder = addPrimitiveFeature(box, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 6, height: 35 }
    });
    const joined = booleanBodies(cylinder, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [cylinder.bodyOrder[1]!, box.bodyOrder[0]!]
    });
    const rounded = filletEdges(joined.document, {
      name: 'Round junction',
      targetBodyId: joined.bodyId,
      edgeHashes: [101],
      size: 5
    });
    const reference: FaceTopologyReferenceV5 = {
      kind: 'face',
      producingFeatureId: listFeaturesInOrder(joined.document).at(-1)!
        .featureId,
      lineageName: 'boolean.face.operand.1.primitive.box.face.x-max',
      currentHash: 123,
      witnessVersion: 1,
      witness: {} as FaceWitnessV1
    };
    return { box, joined, rounded, reference };
  }

  it('follows the unique union operand role through the fillet', () => {
    const { box, rounded, reference } = joinedBox();
    expect(
      primitiveBoxFaceAncestor(rounded.document, rounded.bodyId, reference, 123)
    ).toMatchObject({
      primitive: { featureId: sourceFeatureId(box) },
      dimension: 'width',
      axis: 'x',
      side: 'max',
      scale: 1
    });
  });

  it('preserves local editing on bare unions and rejects rotated union axes', () => {
    const { joined, rounded, reference } = joinedBox();
    expect(
      primitiveBoxFaceAncestor(joined.document, joined.bodyId, reference, 123)
    ).toBeNull();
    const scaled = transformBody(rounded.document, {
      name: 'Scale union',
      targetBodyId: rounded.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      scale: 2
    }).document;
    expect(
      primitiveBoxFaceAncestor(scaled, rounded.bodyId, reference, 123)?.scale
    ).toBe(2);
    const rotated = transformBody(rounded.document, {
      name: 'Rotate union',
      targetBodyId: rounded.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    }).document;
    expect(
      primitiveBoxFaceAncestor(rotated, rounded.bodyId, reference, 123)
    ).toBeNull();
  });

  it('requires a current, uniquely published max-side union role', () => {
    const { rounded, reference } = joinedBox();
    for (const candidate of [
      { ...reference, currentHash: 124 },
      { ...reference, producingFeatureId: sourceFeatureId(rounded.document) },
      ...[
        'boolean.face.operand.9.primitive.box.face.x-max',
        'boolean.face.operand.0.primitive.box.face.x-max',
        'boolean.face.operand.1.primitive.box.face.x-min',
        'boolean.face.shared.primitive.box.face.x-max',
        'boolean.face.operand.1.boolean.face.operand.0.primitive.box.face.x-max'
      ].map((lineageName) => ({ ...reference, lineageName }))
    ]) {
      expect(
        primitiveBoxFaceAncestor(
          rounded.document,
          rounded.bodyId,
          candidate,
          123
        )
      ).toBeNull();
    }
  });

  it('does not cross other booleans or resize a kept source', () => {
    const { joined, rounded, reference } = joinedBox();
    const feature = listFeaturesInOrder(joined.document).at(-1)!;
    for (const data of [
      { operation: 'subtract' },
      { operation: 'intersect' },
      { keepOriginals: 'all' }
    ] as const) {
      const document = updateFeature(rounded.document, {
        featureId: feature.featureId,
        data
      });
      expect(
        primitiveBoxFaceAncestor(document, rounded.bodyId, reference, 123)
      ).toBeNull();
    }
  });

  it('does not resize a copied source or replace a local face baseline', () => {
    const { box, rounded, reference } = joinedBox();
    const copied = transformBody(rounded.document, {
      name: 'Copy source',
      targetBodyId: box.bodyOrder[0]!,
      translation: { x: 50, y: 0, z: 0 },
      copy: true
    }).document;
    expect(
      primitiveBoxFaceAncestor(copied, rounded.bodyId, reference, 123)
    ).toBeNull();
    const locallyMoved = directEditBody(rounded.document, {
      name: 'Local end move',
      targetBodyId: rounded.bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: 123,
        faceReference: reference,
        sourceSurfaceType: 'plane',
        sourceArea: 349,
        sourceCenter: { x: 30, y: 9, z: 13 },
        sourceNormal: { x: 1, y: 0, z: 0 },
        offset: 2
      }
    }).document;
    expect(
      primitiveBoxFaceAncestor(locallyMoved, rounded.bodyId, reference, 123)
    ).toBeNull();
  });

  it('does not mistake rotated modifier axes for source-box axes', () => {
    const box = addPrimitiveFeature(
      createProjectDocument('Box', toUserId('user_ancestry')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: '40', height: 24, depth: 10 }
      }
    );
    const bodyId = box.bodyOrder[0]!;
    const placed = transformBody(box, {
      name: 'Rotate',
      targetBodyId: bodyId,
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 90, y: 0, z: 0 }
    }).document;
    const fillet = filletEdges(placed, {
      name: 'Fillet',
      targetBodyId: bodyId,
      edgeHashes: [101],
      size: 1.5
    });
    const reference: FaceTopologyReferenceV5 = {
      kind: 'face',
      producingFeatureId: listFeaturesInOrder(fillet.document).at(-1)!
        .featureId,
      lineageName: 'modifier.box.face.y-min',
      currentHash: 123,
      witnessVersion: 1,
      witness: {} as FaceWitnessV1
    };
    expect(
      primitiveBoxFaceAncestor(fillet.document, fillet.bodyId, reference, 123)
    ).toBeNull();
  });
});

describe('cylinder radius across a boolean', () => {
  function bossOnSphere(operation: 'union' | 'subtract' | 'intersect') {
    const sphere = addPrimitiveFeature(
      createProjectDocument('Boss on sphere', toUserId('user_ancestry')),
      {
        name: 'Sphere',
        primitiveKind: 'sphere',
        dimensions: { radius: 73.5 }
      }
    );
    const cylinder = addPrimitiveFeature(sphere, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 6, height: 64.1 }
    });
    const cylinderBodyId = cylinder.bodyOrder[1]!;
    const placed = transformBody(cylinder, {
      name: 'Move',
      targetBodyId: cylinderBodyId,
      translation: { x: 0, y: 0, z: 58 },
      rotationDeg: { x: 20, y: 10, z: 0 }
    }).document;
    const joined = booleanBodies(placed, {
      name: 'Combine',
      operation,
      targetBodyIds: [sphere.bodyOrder[0]!, cylinderBodyId]
    });
    const wall: FaceTopologyReferenceV5 = {
      kind: 'face',
      producingFeatureId: listFeaturesInOrder(joined.document).at(-1)!
        .featureId,
      lineageName: 'boolean.face.operand.1.primitive.cylinder.face.wall',
      currentHash: 321,
      witnessVersion: 1,
      witness: {} as FaceWitnessV1
    };
    const cylinderFeatureId = listFeaturesInOrder(cylinder).at(-1)!.featureId;
    return { joined, wall, cylinderFeatureId, cylinderBodyId };
  }

  it('resizes the consumed cylinder behind a union or subtract wall', () => {
    for (const operation of ['union', 'subtract'] as const) {
      const { joined, wall, cylinderFeatureId } = bossOnSphere(operation);
      expect(
        primitiveCylinderRadiusAncestor(
          joined.document,
          joined.bodyId,
          wall,
          321
        )?.featureId,
        operation
      ).toBe(cylinderFeatureId);
      // A rotation does not change a radius, and nothing scaled the operand.
      expect(
        primitiveCylinderScale(joined.document, joined.bodyId, wall, 321)
      ).toBe(1);
      // Without the wall's role the boolean stays a hard boundary.
      expect(
        primitiveCylinderRadiusAncestor(joined.document, joined.bodyId)
      ).toBeNull();
    }
  });

  it('follows the wall through a referenced cap offset and a seam fillet', () => {
    const { joined, wall, cylinderFeatureId } = bossOnSphere('union');
    const capped = directEditBody(joined.document, {
      name: 'Offset face',
      targetBodyId: joined.bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: 654,
        faceReference: {
          ...wall,
          lineageName: 'boolean.face.operand.1.primitive.cylinder.face.cap.end',
          currentHash: 654
        },
        sourceSurfaceType: 'plane',
        sourceArea: 113,
        sourceCenter: { x: 0, y: 0, z: 122 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        offset: 5
      }
    }).document;
    const seam: EdgeTopologyReferenceV5 = {
      kind: 'edge',
      producingFeatureId: wall.producingFeatureId,
      lineageName:
        'boolean.edge.between.operand.0.primitive.box.face.z-max|operand.1.primitive.cylinder.face.wall',
      currentHash: 101,
      witnessVersion: 1,
      witness: {} as EdgeWitnessV1
    };
    const named = filletEdges(capped, {
      name: 'Fillet edges',
      targetBodyId: joined.bodyId,
      edgeHashes: [101],
      edgeReferences: [seam],
      size: 2
    });
    expect(
      primitiveCylinderRadiusAncestor(named.document, named.bodyId, wall, 321)
        ?.featureId
    ).toBe(cylinderFeatureId);
  });

  it('keeps a hash-only seam fillet on the local wall resize', () => {
    // Resizing the operand makes a new seam edge, which a hash cannot find
    // again; the local resize leaves the seam where the fillet picked it.
    const { joined, wall } = bossOnSphere('union');
    const rounded = filletEdges(joined.document, {
      name: 'Fillet edges',
      targetBodyId: joined.bodyId,
      edgeHashes: [101, 102],
      size: 2
    });
    expect(
      primitiveCylinderRadiusAncestor(
        rounded.document,
        rounded.bodyId,
        wall,
        321
      )
    ).toBeNull();
  });

  it('requires a current wall role published by that boolean', () => {
    const { joined, wall } = bossOnSphere('union');
    for (const candidate of [
      { ...wall, currentHash: 322 },
      { ...wall, producingFeatureId: sourceFeatureId(joined.document) },
      ...[
        'boolean.face.operand.0.primitive.cylinder.face.wall',
        'boolean.face.operand.7.primitive.cylinder.face.wall',
        'boolean.face.operand.1.primitive.cylinder.face.cap.end',
        'boolean.face.shared.primitive.cylinder.face.wall',
        'boolean.face.operand.1.boolean.face.operand.0.primitive.cylinder.face.wall'
      ].map((lineageName) => ({ ...wall, lineageName }))
    ]) {
      expect(
        primitiveCylinderRadiusAncestor(
          joined.document,
          joined.bodyId,
          candidate,
          321
        ),
        candidate.lineageName
      ).toBeNull();
    }
  });

  it('does not cross an intersect, a kept source or a copied source', () => {
    const intersected = bossOnSphere('intersect');
    expect(
      primitiveCylinderRadiusAncestor(
        intersected.joined.document,
        intersected.joined.bodyId,
        intersected.wall,
        321
      )
    ).toBeNull();
    const { joined, wall, cylinderBodyId } = bossOnSphere('union');
    const kept = updateFeature(joined.document, {
      featureId: wall.producingFeatureId,
      data: { keepOriginals: 'all' }
    });
    expect(
      primitiveCylinderRadiusAncestor(kept, joined.bodyId, wall, 321)
    ).toBeNull();
    const copied = transformBody(joined.document, {
      name: 'Copy source',
      targetBodyId: cylinderBodyId,
      translation: { x: 50, y: 0, z: 0 },
      copy: true
    }).document;
    expect(
      primitiveCylinderRadiusAncestor(copied, joined.bodyId, wall, 321)
    ).toBeNull();
  });

  it('keeps an earlier local wall resize authoritative', () => {
    const { joined, wall } = bossOnSphere('union');
    const resized = directEditBody(joined.document, {
      name: 'Resize Cylinder',
      targetBodyId: joined.bodyId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: 321,
        faceReference: wall,
        sourceRadius: 6,
        sourceAxisStart: { x: 0, y: 0, z: 58 },
        sourceAxisEnd: { x: 0, y: 0, z: 122.1 },
        concavity: 'boss',
        radius: 7
      }
    }).document;
    expect(
      primitiveCylinderRadiusAncestor(resized, joined.bodyId, wall, 321)
    ).toBeNull();
  });
});

describe('source-first routing across a boolean (WS4)', () => {
  function plateAnd(
    primitiveKind: 'cylinder' | 'cone' | 'sphere' | 'torus',
    operation: 'union' | 'subtract' | 'intersect',
    order: 'plate-first' | 'tool-first' = 'plate-first'
  ) {
    const plate = addPrimitiveFeature(
      createProjectDocument('WS4 routing', toUserId('user_ancestry')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const tool = addPrimitiveFeature(plate, {
      name: 'Tool',
      primitiveKind,
      dimensions:
        primitiveKind === 'cone'
          ? { bottomRadius: 6, topRadius: 3, height: 20 }
          : primitiveKind === 'torus'
            ? { majorRadius: 10, minorRadius: 3 }
            : primitiveKind === 'sphere'
              ? { radius: 8 }
              : { radius: 5, height: 20 }
    });
    const [plateBodyId, toolBodyId] = tool.bodyOrder as [BodyId, BodyId];
    const placed = transformBody(tool, {
      name: 'Place',
      targetBodyId: toolBodyId,
      translation: { x: 20, y: 20, z: 4 }
    }).document;
    const joined = booleanBodies(placed, {
      name: 'Combine',
      operation,
      targetBodyIds:
        order === 'plate-first'
          ? [plateBodyId, toolBodyId]
          : [toolBodyId, plateBodyId]
    });
    const booleanId = listFeaturesInOrder(joined.document).at(-1)!.featureId;
    const toolIndex = order === 'plate-first' ? 1 : 0;
    const face = (role: string, operandIndex = toolIndex) =>
      ({
        kind: 'face',
        producingFeatureId: booleanId,
        lineageName: `boolean.face.operand.${operandIndex}.${role}`,
        currentHash: 321,
        witnessVersion: 1,
        witness: {} as FaceWitnessV1
      }) satisfies FaceTopologyReferenceV5;
    const toolFeatureId = listFeaturesInOrder(tool).at(-1)!.featureId;
    return {
      document: joined.document,
      bodyId: joined.bodyId,
      plateBodyId,
      toolBodyId,
      toolFeatureId,
      booleanId,
      face
    };
  }

  it('drives a cylinder cap across a union or subtract, inverting a cut tool', () => {
    for (const [operation, order, side, sense] of [
      ['union', 'plate-first', 'end', 1],
      ['subtract', 'plate-first', 'start', -1],
      // The cylinder as the subtract's target keeps its own orientation.
      ['subtract', 'tool-first', 'end', 1]
    ] as const) {
      const { document, bodyId, face, toolFeatureId } = plateAnd(
        'cylinder',
        operation,
        order
      );
      const reference = face(`primitive.cylinder.face.cap.${side}`);
      expect(
        primitiveCylinderCapAncestor(document, bodyId, reference, 321),
        `${operation} ${order}`
      ).toMatchObject({
        primitive: { featureId: toolFeatureId },
        side,
        scale: 1,
        sense
      });
    }
  });

  it('refuses a cap across an intersect, a kept or copied source, or a stale role', () => {
    const intersected = plateAnd('cylinder', 'intersect');
    expect(
      primitiveCylinderCapAncestor(
        intersected.document,
        intersected.bodyId,
        intersected.face('primitive.cylinder.face.cap.end'),
        321
      )
    ).toBeNull();
    const { document, bodyId, face, booleanId, toolBodyId } = plateAnd(
      'cylinder',
      'union'
    );
    const cap = face('primitive.cylinder.face.cap.end');
    const kept = updateFeature(document, {
      featureId: booleanId,
      data: { keepOriginals: 'tools' }
    });
    expect(primitiveCylinderCapAncestor(kept, bodyId, cap, 321)).toBeNull();
    const copied = transformBody(document, {
      name: 'Copy',
      targetBodyId: toolBodyId,
      translation: { x: 60, y: 0, z: 0 },
      copy: true
    }).document;
    expect(primitiveCylinderCapAncestor(copied, bodyId, cap, 321)).toBeNull();
    for (const candidate of [
      { ...cap, currentHash: 322 },
      face('primitive.cylinder.face.cap.end', 0),
      face('primitive.cylinder.face.cap.end', 2)
    ]) {
      expect(
        primitiveCylinderCapAncestor(document, bodyId, candidate, 321),
        candidate.lineageName
      ).toBeNull();
    }
  });

  it('keeps an earlier move of the same cap and a hash-only blend local', () => {
    const { document, bodyId, face, toolFeatureId } = plateAnd(
      'cylinder',
      'union'
    );
    const cap = face('primitive.cylinder.face.cap.end');
    const offset = (lineageName: string) =>
      directEditBody(document, {
        name: 'Offset face',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: 654,
          faceReference: { ...cap, lineageName, currentHash: 654 },
          sourceSurfaceType: 'plane',
          sourceArea: 78.5,
          sourceCenter: { x: 20, y: 20, z: 24 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 2
        }
      }).document;
    expect(
      primitiveCylinderCapAncestor(offset(cap.lineageName), bodyId, cap, 321)
    ).toBeNull();
    // A planar offset of another face replays on the resized operand.
    expect(
      primitiveCylinderCapAncestor(
        offset('boolean.face.operand.0.primitive.box.face.z-min'),
        bodyId,
        cap,
        321
      )?.primitive.featureId
    ).toBe(toolFeatureId);
    const rounded = filletEdges(document, {
      name: 'Fillet edges',
      targetBodyId: bodyId,
      edgeHashes: [101],
      size: 1
    });
    expect(
      primitiveCylinderCapAncestor(rounded.document, rounded.bodyId, cap, 321)
    ).toBeNull();
  });

  it('drives a cone cap by its height, and only a cone cap', () => {
    const { document, bodyId, face, toolFeatureId } = plateAnd(
      'cone',
      'subtract'
    );
    expect(
      primitiveConeCapAncestor(
        document,
        bodyId,
        face('primitive.cone.face.cap.start'),
        321
      )
    ).toMatchObject({
      primitive: { featureId: toolFeatureId },
      side: 'start',
      sense: -1
    });
    expect(
      primitiveCylinderCapAncestor(
        document,
        bodyId,
        face('primitive.cone.face.cap.start'),
        321
      )
    ).toBeNull();
    expect(
      primitiveConeCapAncestor(
        document,
        bodyId,
        face('primitive.cylinder.face.cap.start'),
        321
      )
    ).toBeNull();
  });

  it('owns sphere patches, a cone wall and a torus shell across a union or subtract', () => {
    for (const [kind, role] of [
      ['sphere', 'primitive.sphere.face.z-max'],
      ['sphere', 'primitive.sphere.face.z-min'],
      ['cone', 'primitive.cone.face.wall'],
      ['torus', 'primitive.torus.face.shell']
    ] as const) {
      for (const operation of ['union', 'subtract'] as const) {
        const { document, bodyId, face, toolFeatureId } = plateAnd(
          kind,
          operation
        );
        expect(
          primitiveCurvedFaceAncestor(document, bodyId, face(role), 321)
            ?.featureId,
          `${operation} ${role}`
        ).toBe(toolFeatureId);
      }
      const intersected = plateAnd(kind, 'intersect');
      expect(
        primitiveCurvedFaceAncestor(
          intersected.document,
          intersected.bodyId,
          intersected.face(role),
          321
        )
      ).toBeNull();
    }
    // The role must name the operand's own kind.
    const { document, bodyId, face } = plateAnd('sphere', 'union');
    expect(
      primitiveCurvedFaceAncestor(
        document,
        bodyId,
        face('primitive.torus.face.shell'),
        321
      )
    ).toBeNull();
  });
});

describe('box side across a subtract', () => {
  function filletedPlateMinusPin(neighbour: string) {
    const plate = addPrimitiveFeature(
      createProjectDocument('Plate minus pin', toUserId('user_ancestry')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const pin = addPrimitiveFeature(plate, {
      name: 'Pin',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 20 }
    });
    const [plateBodyId, pinBodyId] = pin.bodyOrder as [BodyId, BodyId];
    const cut = booleanBodies(pin, {
      name: 'Cut',
      operation: 'subtract',
      targetBodyIds: [plateBodyId, pinBodyId]
    });
    const booleanId = listFeaturesInOrder(cut.document).at(-1)!.featureId;
    const reference = (lineageName: string, currentHash: number) =>
      ({
        kind: 'face',
        producingFeatureId: booleanId,
        lineageName,
        currentHash,
        witnessVersion: 1,
        witness: {} as FaceWitnessV1
      }) satisfies FaceTopologyReferenceV5;
    const corner: EdgeTopologyReferenceV5 = {
      kind: 'edge',
      producingFeatureId: booleanId,
      lineageName: 'boolean.edge.operand.0.primitive.box.edge.z.x-min.y-min',
      currentHash: 900,
      witnessVersion: 1,
      witness: {} as EdgeWitnessV1
    };
    const rounded = filletEdges(cut.document, {
      name: 'Fillet edges',
      targetBodyId: cut.bodyId,
      edgeHashes: [900],
      edgeReferences: [corner],
      size: 2
    });
    const side = reference(
      'boolean.face.operand.0.primitive.box.face.x-max',
      1
    );
    const faces = [
      side,
      reference(neighbour, 2),
      reference('boolean.face.operand.0.primitive.box.face.y-max', 3)
    ];
    const document = {
      ...rounded.document,
      derived: {
        ...rounded.document.derived,
        bodyRepresentations: {
          [rounded.bodyId]: {
            topology: {
              faces: faces.map((face) => ({
                hash: face.currentHash,
                reference: face
              })),
              edges: [
                { hash: 11, adjacentFaceHashes: [1, 2] },
                { hash: 12, adjacentFaceHashes: [1, 3] }
              ]
            }
          }
        }
      }
    } as unknown as typeof rounded.document;
    return {
      document,
      bodyId: rounded.bodyId,
      side,
      boxFeatureId: listFeaturesInOrder(plate)[0]!.featureId
    };
  }

  it('resizes the target box when every neighbour of the side is its own', () => {
    const { document, bodyId, side, boxFeatureId } = filletedPlateMinusPin(
      'modifier.fillet.face.band-between.boolean.face.operand.0.primitive.box.face.x-max|boolean.face.operand.0.primitive.box.face.y-min'
    );
    expect(primitiveBoxFaceAncestor(document, bodyId, side, 1)).toMatchObject({
      primitive: { featureId: boxFeatureId },
      dimension: 'width',
      side: 'max'
    });
  });

  it('keeps the side local where the tool reaches it, or for a tool side', () => {
    for (const neighbour of [
      'boolean.face.operand.1.primitive.cylinder.face.wall',
      'modifier.fillet.face.band-between.boolean.face.operand.0.primitive.box.face.x-max|boolean.face.operand.1.primitive.cylinder.face.wall'
    ]) {
      const { document, bodyId, side } = filletedPlateMinusPin(neighbour);
      expect(
        primitiveBoxFaceAncestor(document, bodyId, side, 1),
        neighbour
      ).toBeNull();
    }
    const { document, bodyId, side } = filletedPlateMinusPin(
      'boolean.face.operand.0.primitive.box.face.z-max'
    );
    // An unnamed neighbour proves nothing either.
    const unnamed = structuredClone(document);
    delete (
      unnamed.derived.bodyRepresentations[bodyId]!.topology!.faces[1] as {
        reference?: unknown;
      }
    ).reference;
    expect(primitiveBoxFaceAncestor(unnamed, bodyId, side, 1)).toBeNull();
    // A subtract's tool side and a min side never cross.
    for (const lineageName of [
      'boolean.face.operand.1.primitive.box.face.x-max',
      'boolean.face.operand.0.primitive.box.face.x-min'
    ]) {
      expect(
        primitiveBoxFaceAncestor(document, bodyId, { ...side, lineageName }, 1)
      ).toBeNull();
    }
  });
});
