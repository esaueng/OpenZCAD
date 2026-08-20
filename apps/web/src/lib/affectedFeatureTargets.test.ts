import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  filletEdges,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { affectedFeatureTargets } from './affectedFeatureTargets';

describe('affected feature targets', () => {
  it('walks only the downstream body ancestry of the edited primitive', () => {
    const cylinder = addPrimitiveFeature(
      createProjectDocument('Affected branch', toUserId('user_affected')),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 4.6, height: 12 }
      }
    );
    const cylinderBodyId = cylinder.bodyOrder[0]!;
    const box = addPrimitiveFeature(cylinder, {
      name: 'Independent box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const boxBodyId = box.bodyOrder[1]!;
    const fillet = filletEdges(box, {
      name: 'Cylinder rim fillet',
      targetBodyId: cylinderBodyId,
      edgeHashes: [101],
      size: 1
    });
    const chamfer = chamferEdges(fillet.document, {
      name: 'Independent box chamfer',
      targetBodyId: boxBodyId,
      edgeHashes: [202],
      size: 1
    });
    const moved = transformBody(chamfer.document, {
      name: 'Move filleted cylinder',
      targetBodyId: fillet.bodyId,
      translation: { x: 5, y: 0, z: 0 }
    }).document;
    const sourceFeature = listFeaturesInOrder(moved)[0]!;

    expect(affectedFeatureTargets(moved, sourceFeature.featureId)).toEqual([
      { featureName: 'Cylinder', resultBodyId: cylinderBodyId },
      { featureName: 'Cylinder rim fillet', resultBodyId: fillet.bodyId },
      { featureName: 'Move filleted cylinder', resultBodyId: fillet.bodyId }
    ]);
  });

  it('resolves an in-place direct edit as its own source body', () => {
    const box = addPrimitiveFeature(
      createProjectDocument('Direct-edit source', toUserId('user_affected')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 10, depth: 24 }
      }
    );
    const bodyId = box.bodyOrder[0]!;
    const edited = directEditBody(box, {
      name: 'Raise top',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: 1234,
        sourceSurfaceType: 'plane',
        sourceArea: 400,
        sourceCenter: { x: 0, y: 0, z: 0 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        offset: 5
      }
    }).document;
    const downstream = filletEdges(edited, {
      name: 'Soften',
      targetBodyId: bodyId,
      edgeHashes: [7],
      size: 1
    });
    const directEdit = listFeaturesInOrder(downstream.document).find(
      (feature) => feature.name === 'Raise top'
    )!;

    // Direct edits carry no result body on the node; the body they rewrite is
    // the source, and everything downstream of it is affected.
    expect(
      affectedFeatureTargets(downstream.document, directEdit.featureId)
    ).toEqual([
      { featureName: 'Raise top', resultBodyId: bodyId },
      { featureName: 'Soften', resultBodyId: downstream.bodyId }
    ]);
  });
});
