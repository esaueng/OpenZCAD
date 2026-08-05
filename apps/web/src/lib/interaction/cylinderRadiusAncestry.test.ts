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
import { toUserId } from '@openzcad/shared';
import { primitiveCylinderRadiusAncestor } from './cylinderRadiusAncestry';

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

function sourceFeatureId(document: ReturnType<typeof cylinderDocument>) {
  return listFeaturesInOrder(document)[0]!.featureId;
}
