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
  type FaceWitnessV1,
  type FeatureId
} from '@openzcad/shared';
import {
  primitiveBoxFaceAncestor,
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
