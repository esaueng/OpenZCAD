import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  listFeaturesInOrder,
  shellBody
} from '@openzcad/document-core';
import {
  toFeatureId,
  toUserId,
  type DerivedState,
  type FaceReferenceRepair,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import { commandFactories } from '@openzcad/command-system';
import {
  topologyReferenceRepairCommand,
  withCarriedSelections
} from './topologyReferenceRepairs';

function chamfered() {
  const box = addPrimitiveFeature(
    createProjectDocument('Carried', toUserId('user_carried')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 24 }
    }
  );
  const { document } = chamferEdges(box, {
    name: 'Chamfer',
    targetBodyId: box.bodyOrder[0]!,
    edgeHashes: [11, 12, 11],
    size: 1
  });
  const chamfer = listFeaturesInOrder(document).at(-1)!;
  return { document, chamfer };
}

const derivedWith = (
  document: ReturnType<typeof chamfered>['document'],
  repair: NonNullable<DerivedState['edgeHashRepairs']>[number]
): DerivedState => ({
  ...document.derived,
  warnings: [],
  featureWarnings: [],
  edgeHashRepairs: [repair]
});

/** The derived state of a build in which an unrelated feature failed. */
function withUnrelatedFailure(
  document: ReturnType<typeof chamfered>['document'],
  derived: DerivedState
): DerivedState {
  return {
    ...derived,
    warnings: ['Feature "Box": failed'],
    featureWarnings: [
      {
        featureId: listFeaturesInOrder(document)[0]!.featureId,
        featureName: 'Box',
        message: 'Feature "Box": failed',
        kind: 'build-failed'
      }
    ]
  };
}

describe('carried edge selections', () => {
  it('never writes a carried selection outside the edit that proposed it', () => {
    // A carry is proposed only by an edit's own validation build and stored
    // in that edit's revision (`withCarriedSelections`). The after-build
    // normalization leaves it alone, so a path that commits without a
    // validated build can only leave the pick refused.
    const { document, chamfer } = chamfered();
    const derived = derivedWith(document, {
      featureId: chamfer.featureId,
      from: [11, 12],
      to: [21, 22]
    });
    expect(topologyReferenceRepairCommand(document, derived)).toBeNull();
    expect(
      topologyReferenceRepairCommand(
        document,
        withUnrelatedFailure(document, derived)
      )
    ).toBeNull();
  });

  it('refuses a carry that does not describe the stored selection', () => {
    const { document, chamfer } = chamfered();
    for (const repair of [
      // A different selection: the user re-picked since that rebuild.
      { featureId: chamfer.featureId, from: [11, 13], to: [21, 22] },
      // Two stored edges cannot become one.
      { featureId: chamfer.featureId, from: [11, 12], to: [21, 21] },
      { featureId: chamfer.featureId, from: [11, 12], to: [21] }
    ]) {
      expect(
        withCarriedSelections(document, [], derivedWith(document, repair))
      ).toHaveProperty('refusal');
    }
  });

  it('still withholds lineage repairs from a partially built model', () => {
    const { document } = chamfered();
    expect(
      topologyReferenceRepairCommand(
        document,
        withUnrelatedFailure(document, {
          ...document.derived,
          warnings: [],
          featureWarnings: [],
          referenceRepairs: [
            {
              featureId: listFeaturesInOrder(document).at(-1)!.featureId,
              edgeReferences: []
            }
          ]
        })
      )
    ).toBeNull();
  });
});

describe('a commit that carried a selection', () => {
  const resizeBox = (document: ReturnType<typeof chamfered>['document']) =>
    commandFactories.updateFeature(
      {
        featureId: listFeaturesInOrder(document)[0]!.featureId,
        data: { dimensions: { width: 22.5, height: 18, depth: 24 } }
      },
      'Resize Body'
    );

  it('stores the new hashes in the same revision as the edit', () => {
    const { document, chamfer } = chamfered();
    const edit = resizeBox(document);
    const derived = withUnrelatedFailure(
      document,
      derivedWith(document, {
        featureId: chamfer.featureId,
        from: [11, 12],
        to: [21, 22]
      })
    );
    const result = withCarriedSelections(document, [edit], derived);
    if ('refusal' in result) throw new Error(result.refusal);
    expect(result.commands[0]).toBe(edit);
    expect(result.commands).toHaveLength(2);
    const committed = result.commands.reduce(
      (doc, command) => command.apply(doc),
      document
    );
    const [box, stored] = listFeaturesInOrder(committed);
    expect(box!.data).toMatchObject({
      dimensions: { width: 22.5, height: 18, depth: 24 }
    });
    expect(stored!.data).toMatchObject({ edgeHashes: [21, 22] });
  });

  it('leaves an edit that carried nothing as it was', () => {
    const { document } = chamfered();
    const edit = resizeBox(document);
    expect(
      withCarriedSelections(document, [edit], {
        ...document.derived,
        warnings: [],
        featureWarnings: []
      })
    ).toEqual({ commands: [edit] });
  });

  it('refuses the commit when a carried selection cannot be stored', () => {
    const { document, chamfer } = chamfered();
    const result = withCarriedSelections(
      document,
      [resizeBox(document)],
      derivedWith(document, {
        featureId: chamfer.featureId,
        // Not the stored selection: writing `to` would lose an edge.
        from: [11, 13],
        to: [21, 22]
      })
    );
    expect(result).toEqual({
      refusal:
        '“Chamfer” can’t keep its edges through this change. Edit “Chamfer” and pick its edges again.'
    });
  });
});

describe('face reference repairs', () => {
  const reference = (hash: number) =>
    ({
      kind: 'face',
      producingFeatureId: toFeatureId('feature_box'),
      lineageName: `box.face.${hash}`,
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
  const repair = (
    featureId: FeatureId,
    hash: number,
    role?: 'opposite' | 'set'
  ): FaceReferenceRepair => ({
    featureId,
    faceHash: hash,
    faceReference: reference(hash),
    ...(role ? { role } : {})
  });
  const clean = (
    document: ProjectDocument,
    faceReferenceRepairs: FaceReferenceRepair[],
    featureWarnings: FeatureWarning[] = []
  ): DerivedState => ({
    ...document.derived,
    warnings: featureWarnings.map((warning) => warning.message),
    featureWarnings,
    faceReferenceRepairs
  });

  function model() {
    const base = addPrimitiveFeature(
      createProjectDocument('Faces', toUserId('user_faces')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const edited = directEditBody(base, {
      name: 'Distance',
      targetBodyId: base.bodyOrder[0]!,
      operation: {
        kind: 'set-face-distance',
        faceHash: 1,
        oppositeFaceHash: 2,
        sourceDistance: 30,
        moveMode: 'symmetric',
        distance: 32
      }
    });
    const shelled = shellBody(edited.document, {
      name: 'Shell',
      targetBodyId: edited.bodyId,
      openingFaceHashes: [3, 4],
      thickness: 1
    });
    const document = shelled.document;
    const [, distance, shell] = listFeaturesInOrder(document);
    return { document, distance: distance!, shell: shell! };
  }

  it('writes a direct edit’s face and its opposite face in one patch', () => {
    const { document, distance } = model();
    const command = topologyReferenceRepairCommand(
      document,
      clean(document, [
        repair(distance.featureId, 1),
        repair(distance.featureId, 2, 'opposite')
      ])
    );
    const repaired = command!.apply(document);
    const data = listFeaturesInOrder(repaired)[1]!.data;
    if (data.featureKind !== 'direct-edit') throw new Error('direct edit');
    expect(data.operation).toMatchObject({
      faceHash: 1,
      faceReference: { currentHash: 1 },
      oppositeFaceHash: 2,
      oppositeFaceReference: { currentHash: 2 }
    });
  });

  it('writes a face set only when every member is proven', () => {
    const { document, shell } = model();
    expect(
      topologyReferenceRepairCommand(
        document,
        clean(document, [repair(shell.featureId, 3, 'set')])
      )
    ).toBeNull();
    // A proof that is not a member of the stored set refuses the set.
    expect(
      topologyReferenceRepairCommand(
        document,
        clean(document, [
          repair(shell.featureId, 3, 'set'),
          repair(shell.featureId, 5, 'set')
        ])
      )
    ).toBeNull();
    const command = topologyReferenceRepairCommand(
      document,
      clean(document, [
        repair(shell.featureId, 4, 'set'),
        repair(shell.featureId, 3, 'set')
      ])
    );
    const data = listFeaturesInOrder(command!.apply(document))[2]!.data;
    if (data.featureKind !== 'shell') throw new Error('shell');
    expect(data.openingFaceReferences?.map((r) => r.currentHash)).toEqual([
      3, 4
    ]);
  });

  it('never moves a pick: a proof for another hash is ignored', () => {
    const { document, distance } = model();
    expect(
      topologyReferenceRepairCommand(
        document,
        clean(document, [
          repair(distance.featureId, 9),
          repair(distance.featureId, 1, 'opposite')
        ])
      )
    ).toBeNull();
  });

  it('writes advice from before the first failed or suppressed step only', () => {
    const { document, distance, shell } = model();
    const advice = [
      repair(distance.featureId, 1),
      repair(shell.featureId, 3, 'set'),
      repair(shell.featureId, 4, 'set')
    ];
    for (const kind of ['build-failed', 'refusal', 'suppressed'] as const) {
      const command = topologyReferenceRepairCommand(
        document,
        clean(document, advice, [
          {
            featureId: shell.featureId,
            featureName: 'Shell',
            message: 'Feature "Shell": stopped',
            kind
          }
        ])
      );
      const [, edited, stored] = listFeaturesInOrder(command!.apply(document));
      expect(edited!.data).toMatchObject({
        operation: { faceReference: { currentHash: 1 } }
      });
      expect(stored!.data).not.toHaveProperty('openingFaceReferences');
    }
    // An advisory is not an interruption.
    expect(
      topologyReferenceRepairCommand(
        document,
        clean(document, advice, [
          {
            featureId: distance.featureId,
            featureName: 'Distance',
            message: 'Feature "Distance": approximate',
            kind: 'advisory'
          }
        ])
      )
    ).not.toBeNull();
    expect(
      topologyReferenceRepairCommand(
        document,
        clean(document, advice, [
          {
            featureId: distance.featureId,
            featureName: 'Distance',
            message: 'Feature "Distance": failed',
            kind: 'build-failed'
          }
        ])
      )
    ).toBeNull();
  });
});
