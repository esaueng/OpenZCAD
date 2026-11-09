import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type DerivedState } from '@openzcad/shared';
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
