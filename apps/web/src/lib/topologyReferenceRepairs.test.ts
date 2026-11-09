import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type DerivedState } from '@openzcad/shared';
import { topologyReferenceRepairCommand } from './topologyReferenceRepairs';

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

describe('carried edge selections', () => {
  it('persists where a hash-only selection now is', () => {
    const { document, chamfer } = chamfered();
    const command = topologyReferenceRepairCommand(
      document,
      derivedWith(document, {
        featureId: chamfer.featureId,
        from: [11, 12],
        to: [21, 22]
      })
    );
    expect(command).not.toBeNull();
    const repaired = listFeaturesInOrder(command!.apply(document)).at(-1)!;
    expect(repaired.data).toMatchObject({ edgeHashes: [21, 22] });
  });

  it('ignores a repair that does not describe the stored selection', () => {
    const { document, chamfer } = chamfered();
    for (const repair of [
      // A different selection: the user re-picked since that rebuild.
      { featureId: chamfer.featureId, from: [11, 13], to: [21, 22] },
      // Two stored edges cannot become one.
      { featureId: chamfer.featureId, from: [11, 12], to: [21, 21] },
      { featureId: chamfer.featureId, from: [11, 12], to: [21] }
    ]) {
      expect(
        topologyReferenceRepairCommand(document, derivedWith(document, repair))
      ).toBeNull();
    }
  });

  it('never rewrites a partially built model', () => {
    const { document, chamfer } = chamfered();
    const derived = derivedWith(document, {
      featureId: chamfer.featureId,
      from: [11, 12],
      to: [21, 22]
    });
    expect(
      topologyReferenceRepairCommand(document, {
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
      })
    ).toBeNull();
  });
});
