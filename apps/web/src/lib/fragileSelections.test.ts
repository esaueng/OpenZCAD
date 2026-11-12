import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  draftBody,
  filletEdges,
  holeBody,
  listFeaturesInOrder,
  shellBody,
  updateFeature
} from '@openzcad/document-core';
import {
  toFeatureId,
  toUserId,
  type DerivedState,
  type FaceTopologyReferenceV5,
  type ProjectDocument
} from '@openzcad/shared';
import {
  fragileSelectionAdvisory,
  fragileSelectionSteps,
  fragileSelectionSummary,
  hashOnlySelections
} from './fragileSelections';
import { topologyReferenceRepairCommand } from './topologyReferenceRepairs';

const faceReference = (hash: number, name = `box.face.${hash}`) =>
  ({
    kind: 'face',
    producingFeatureId: toFeatureId('feature_box'),
    lineageName: name,
    currentHash: hash,
    witnessVersion: 1,
    witness: {
      surfaceType: 'plane',
      perimeter: 40,
      centroid: [0, 0, 0],
      analytic: { kind: 'plane', normal: [0, 0, 1000000000], offset: hash },
      closure: { u: 'open', v: 'open' }
    }
  }) satisfies FaceTopologyReferenceV5;

function box(): { document: ProjectDocument; boxId: string } {
  const document = addPrimitiveFeature(
    createProjectDocument('Fragile', toUserId('user_fragile')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 24 }
    }
  );
  return { document, boxId: document.bodyOrder[0]! };
}

function drilled(
  document: ProjectDocument,
  boxId: string,
  faceHash: number,
  named: boolean
) {
  return holeBody(document, {
    name: 'Hole',
    targetBodyId: boxId as never,
    faceHash,
    ...(named ? { faceReference: faceReference(faceHash) } : {}),
    style: 'simple',
    diameter: 4,
    depthMode: 'through',
    position: { u: 0, v: 0 }
  }).document;
}

const clean = (document: ProjectDocument): DerivedState => ({
  ...document.derived,
  warnings: [],
  featureWarnings: []
});

describe('hash-only selections', () => {
  it('counts every stored pick without a v5 reference', () => {
    const { document, boxId } = box();
    const target = boxId as never;
    const filleted = filletEdges(document, {
      name: 'Fillet',
      targetBodyId: target,
      edgeHashes: [1, 2, 2],
      size: 1
    });
    const shelled = shellBody(filleted.document, {
      name: 'Shell',
      targetBodyId: filleted.bodyId,
      openingFaceHashes: [3, 4],
      openingFaceReferences: [faceReference(3), faceReference(4)],
      thickness: 1
    });
    const drafted = draftBody(shelled.document, {
      name: 'Draft',
      targetBodyId: shelled.bodyId,
      faceHashes: [5, 6],
      faceReferences: [faceReference(5)],
      pullDirection: { x: 0, y: 0, z: 1 },
      neutralPoint: { x: 0, y: 0, z: 0 },
      angleDeg: 2
    });
    const edited = directEditBody(drafted.document, {
      name: 'Distance',
      targetBodyId: drafted.bodyId,
      operation: {
        kind: 'set-face-distance',
        faceHash: 7,
        faceReference: faceReference(7),
        oppositeFaceHash: 8,
        sourceDistance: 10,
        moveMode: 'symmetric',
        distance: 12
      }
    });
    const steps = fragileSelectionSteps(edited.document);
    expect(steps.map(({ featureName, count }) => [featureName, count])).toEqual(
      [
        ['Fillet', 2],
        ['Draft', 1],
        ['Distance', 1]
      ]
    );
    const distance = listFeaturesInOrder(edited.document).at(-1)!;
    expect(hashOnlySelections(distance.data)).toEqual([8]);
    expect(fragileSelectionSummary(steps)).toBe(
      '3 steps use fragile selections.'
    );
    expect(fragileSelectionSummary(steps.slice(0, 1))).toBe(
      '1 step uses a fragile selection.'
    );
    expect(fragileSelectionSummary([])).toBeNull();
  });
});

describe('the advisory a commit earns', () => {
  it('names a new step that stores a hash-only pick', () => {
    const { document, boxId } = box();
    expect(
      fragileSelectionAdvisory(document, drilled(document, boxId, 11, false))
    ).toBe(
      '“Hole”: this selection has no stable name, so it may need re-picking if earlier steps change.'
    );
  });

  it('says nothing for a named pick, an untouched pick, or a carried one', () => {
    const { document, boxId } = box();
    expect(
      fragileSelectionAdvisory(document, drilled(document, boxId, 11, true))
    ).toBeNull();
    const legacy = drilled(document, boxId, 11, false);
    const hole = listFeaturesInOrder(legacy).at(-1)!;
    // Editing a diameter leaves the stored pick as the user made it before.
    const resized = updateFeature(legacy, {
      featureId: hole.featureId,
      data: { diameter: 5 }
    });
    expect(fragileSelectionAdvisory(legacy, resized)).toBeNull();
    // A rewrite the commit made on the user's behalf is not a pick.
    const moved = updateFeature(legacy, {
      featureId: hole.featureId,
      data: { faceHash: 12 }
    });
    expect(fragileSelectionAdvisory(legacy, moved)).not.toBeNull();
    expect(
      fragileSelectionAdvisory(legacy, moved, {
        carried: new Set([hole.featureId])
      })
    ).toBeNull();
  });

  it('counts several new steps in one commit', () => {
    const { document, boxId } = box();
    const one = drilled(document, boxId, 11, false);
    const two = shellBody(one, {
      name: 'Shell',
      targetBodyId: one.bodyOrder.at(-1)!,
      openingFaceHashes: [13],
      thickness: 1
    }).document;
    expect(fragileSelectionAdvisory(document, two)).toBe(
      '2 steps store selections with no stable name, so they may need re-picking if earlier steps change.'
    );
  });

  it('says nothing when the commit’s own rebuild proves the name', () => {
    const { document, boxId } = box();
    const after = drilled(document, boxId, 11, false);
    const hole = listFeaturesInOrder(after).at(-1)!;
    const derived: DerivedState = {
      ...clean(after),
      faceReferenceRepairs: [
        {
          featureId: hole.featureId,
          faceHash: 11,
          faceReference: faceReference(11)
        }
      ]
    };
    expect(topologyReferenceRepairCommand(after, derived)).not.toBeNull();
    expect(fragileSelectionAdvisory(document, after, { derived })).toBeNull();
    // A proof for another hash is not this pick's.
    expect(
      fragileSelectionAdvisory(document, after, {
        derived: {
          ...derived,
          faceReferenceRepairs: [
            {
              featureId: hole.featureId,
              faceHash: 12,
              faceReference: faceReference(12)
            }
          ]
        }
      })
    ).not.toBeNull();
  });
});
