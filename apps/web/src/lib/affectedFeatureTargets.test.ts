import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  filletEdges,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  sweepProfile,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';
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

    const targets = affectedFeatureTargets(moved, sourceFeature.featureId);
    expect(
      targets.map(({ featureName, resultBodyId }) => ({
        featureName,
        resultBodyId
      }))
    ).toEqual([
      { featureName: 'Cylinder', resultBodyId: cylinderBodyId },
      { featureName: 'Cylinder rim fillet', resultBodyId: fillet.bodyId },
      { featureName: 'Move filleted cylinder', resultBodyId: fillet.bodyId }
    ]);
    // Each target identifies its feature, which is what lets a refusal naming
    // one offer to open it.
    expect(targets[0]?.featureId).toBe(sourceFeature.featureId);
    expect(
      targets.every((target) => typeof target.featureId === 'string')
    ).toBe(true);
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
    ).toMatchObject([
      { featureName: 'Raise top', resultBodyId: bodyId },
      { featureName: 'Soften', resultBodyId: downstream.bodyId }
    ]);
  });

  it('counts a sweep as affected by an edit to its guide rail sketch', () => {
    // A guide rail is a sketch the sweep's geometry depends on exactly as its
    // path is. Leaving it out of this walk means the pre-save downstream
    // guard never derives the sweep, and a rail edit that the adapter will
    // later refuse is saved unguarded.
    const start = createProjectDocument('Guided', toUserId('user_guided'));
    const document: ProjectDocument = addSketchFeature(start, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 4,
        height: 2,
        centerX: 0,
        centerY: 0
      }
    }).document;
    const profileSketchId = document.sketchOrder[0]!;
    const path = addSketchFeature(document, {
      name: 'Path',
      plane: 'XZ',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    });
    const rail = addSketchFeature(path.document, {
      name: 'Rail',
      plane: 'XZ',
      offset: 10,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    });
    const pathReference = (sketchId: SketchId) => ({
      sketchId,
      entityIds: findSketch(rail.document, sketchId)!.objectIds
    });
    const swept = sweepProfile(rail.document, {
      name: 'Guided sweep',
      profile: {
        sketchId: profileSketchId,
        profile: {
          profileId: 'profile_1',
          regionFingerprint: 1,
          samplePoint: { x: 0, y: 0 },
          sourceArea: 8,
          sourceEntityIds: findSketch(rail.document, profileSketchId)!.objectIds
        }
      },
      path: pathReference(path.sketchId),
      mode: 'standard',
      guide: pathReference(rail.sketchId)
    });
    const railFeature = listFeaturesInOrder(swept.document).find(
      (feature) => feature.name === 'Rail'
    )!;

    expect(
      affectedFeatureTargets(swept.document, railFeature.featureId)
    ).toMatchObject([
      { featureName: 'Guided sweep', resultBodyId: swept.bodyId }
    ]);
  });

  it('includes a downstream hole and everything past it', () => {
    const plate = addPrimitiveFeature(
      createProjectDocument('Hole branch', toUserId('user_hole')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 10, depth: 24 }
      }
    );
    const plateBodyId = plate.bodyOrder[0]!;
    const hole = holeBody(plate, {
      name: 'Mounting hole',
      targetBodyId: plateBodyId,
      faceHash: 4242,
      style: 'simple',
      diameter: 6,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    const softened = filletEdges(hole.document, {
      name: 'Soften hole rim',
      targetBodyId: hole.bodyId,
      edgeHashes: [303],
      size: 1
    });
    const sourceFeature = listFeaturesInOrder(softened.document)[0]!;

    const targets = affectedFeatureTargets(
      softened.document,
      sourceFeature.featureId
    );
    expect(
      targets.map(({ featureName, resultBodyId }) => ({
        featureName,
        resultBodyId
      }))
    ).toEqual([
      { featureName: 'Plate', resultBodyId: plateBodyId },
      { featureName: 'Mounting hole', resultBodyId: hole.bodyId },
      { featureName: 'Soften hole rim', resultBodyId: softened.bodyId }
    ]);
  });
});
