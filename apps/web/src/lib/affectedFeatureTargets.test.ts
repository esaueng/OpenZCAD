import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
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
});
