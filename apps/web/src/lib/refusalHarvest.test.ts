import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyRepresentation,
  type DerivedState,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import { kernelRefusedBucket } from './analytics';
import {
  createRefusalHarvester,
  newRefusingWarnings,
  refusalObservation
} from './refusalHarvest';

function candidate(): { document: ProjectDocument; featureId: string } {
  let document = addPrimitiveFeature(
    createProjectDocument('Private', toUserId('user_private')),
    {
      name: 'Boss',
      primitiveKind: 'cylinder',
      dimensions: { radius: 6, height: 10 }
    }
  );
  const bodyId = document.bodyOrder[0]!;
  document = directEditBody(document, {
    name: 'Resize',
    targetBodyId: bodyId,
    operation: {
      kind: 'resize-cylindrical-face',
      faceHash: 11,
      sourceRadius: 6,
      sourceAxisStart: { x: 0, y: 0, z: 0 },
      sourceAxisEnd: { x: 0, y: 0, z: 10 },
      concavity: 'boss',
      radius: 7
    }
  }).document;
  return {
    document,
    featureId: listFeaturesInOrder(document).at(-1)!.featureId
  };
}

function derivedWithTopology(document: ProjectDocument): DerivedState {
  const bodyId = document.bodyOrder[0]!;
  const face = (hash: number, surfaceType: string) => ({
    topologyId: `f${hash}`,
    hash,
    triangleStart: 0,
    triangleCount: 0,
    geometry: { surfaceType } as never
  });
  const body = {
    bodyId,
    topology: {
      faces: [
        face(11, 'cylinder'),
        face(12, 'plane'),
        face(13, 'sphere'),
        face(14, 'torus')
      ],
      edges: [
        {
          topologyId: 'e1',
          hash: 21,
          points: [],
          adjacentFaceHashes: [11, 12]
        },
        {
          topologyId: 'e2',
          hash: 22,
          points: [],
          adjacentFaceHashes: [11, 13]
        },
        // Not touching the target face: torus must not appear.
        { topologyId: 'e3', hash: 23, points: [], adjacentFaceHashes: [12, 14] }
      ]
    }
  } as unknown as BodyRepresentation;
  return {
    bodyRepresentations: { [bodyId]: body },
    exportableBodyIds: [],
    warnings: [],
    updatedAt: ''
  };
}

function refusal(
  featureId: string,
  kind: FeatureWarning['kind'] = 'build-failed'
): FeatureWarning {
  return {
    featureId: featureId as FeatureWarning['featureId'],
    featureName: 'Resize',
    message: 'Feature "Resize": move-face does not support face 13 (sphere)',
    kind,
    kernelRefusal: {
      family: 'direct-edit',
      operation: 'resize-cylindrical-face',
      category: 'unsupported',
      code: 'unsupported_move_face',
      reason: 'unsupported_neighbor',
      neighborSurfaceType: 'sphere'
    }
  };
}

describe('refusal harvest', () => {
  it('reads operation kind and the surface signature from published topology', () => {
    const { document, featureId } = candidate();
    const observation = refusalObservation(document, refusal(featureId), [
      derivedWithTopology(document)
    ]);
    expect(observation).toEqual({
      warningKind: 'build-failed',
      featureKind: 'direct-edit',
      directEditKind: 'resize-cylindrical-face',
      family: 'direct-edit',
      kernelOperation: 'resize-cylindrical-face',
      category: 'unsupported',
      code: 'unsupported_move_face',
      targetSurface: 'cylinder',
      neighbourSurfaces: ['plane', 'sphere']
    });
    expect(kernelRefusedBucket(observation)).toBe(
      'direct-edit.resize-cylindrical-face|direct-edit|resize-cylindrical-face|unsupported|unsupported_move_face|build-failed|cylinder|plane+sphere'
    );
  });

  it('counts only refusals the build on screen did not already have', () => {
    const { featureId } = candidate();
    const derived = {
      featureWarnings: [
        refusal(featureId),
        refusal('feat_old'),
        refusal('feat_advice', 'advisory')
      ]
    };
    expect(
      newRefusingWarnings(derived, [refusal('feat_old')]).map(
        (warning) => warning.featureId
      )
    ).toEqual([featureId]);
  });

  it('counts a repeated preview of one edit once, but keeps the latest capture', () => {
    const { document, featureId } = candidate();
    const track = vi.fn();
    const harvester = createRefusalHarvester({ track });
    const derived = {
      ...derivedWithTopology(document),
      featureWarnings: [refusal(featureId)]
    };
    const baseline = { featureWarnings: [] };
    const first = harvester.observe(document, derived, baseline);
    const second = harvester.observe({ ...document }, { ...derived }, baseline);
    expect(track).toHaveBeenCalledOnce();
    expect(first).not.toBeNull();
    expect(harvester.latest()).toBe(second);
    // A new document state is a new observation.
    harvester.observe(
      { ...document, version: document.version + 1 },
      derived,
      baseline
    );
    expect(track).toHaveBeenCalledTimes(2);
    harvester.clear();
    expect(harvester.latest()).toBeNull();
  });

  it('drops the held capture once a later attempt builds', () => {
    const { document, featureId } = candidate();
    const onClear = vi.fn();
    const harvester = createRefusalHarvester({ track: vi.fn(), onClear });
    const derived = {
      ...derivedWithTopology(document),
      featureWarnings: [refusal(featureId)]
    };
    harvester.observe(document, derived, { featureWarnings: [] });
    expect(harvester.latest()).not.toBeNull();
    expect(
      harvester.observe(
        document,
        { ...derived, featureWarnings: [] },
        { featureWarnings: [] }
      )
    ).toBeNull();
    expect(harvester.latest()).toBeNull();
    expect(onClear).toHaveBeenCalledOnce();
  });
});
