import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import { toFeatureId, toUserId } from '@openzcad/shared';

/**
 * A fillet's stored references only cover the hashes it was created with.
 * When an edit grows the edge set the references cannot be completed — the
 * new pick lands on the blended result body, whose lineage the consumed
 * source does not carry — so the edit must fall back to a hash-only
 * selection instead of failing the reference/hash match in the commit.
 */
const edgeReference = {
  kind: 'edge' as const,
  producingFeatureId: toFeatureId('feat_box'),
  lineageName: 'box.edge.front-top',
  currentHash: 42,
  witnessVersion: 1 as const,
  witness: {
    curveType: 'LINE',
    length: 10_000_000,
    closed: false as const,
    endpoints: [
      [0, 0, 0],
      [10_000_000, 0, 0]
    ] as [[number, number, number], [number, number, number]],
    midpoint: [5_000_000, 0, 0] as [number, number, number]
  }
};

function filletedBox() {
  const base = addPrimitiveFeature(
    createProjectDocument('Edge modifier edit', toUserId('user_1')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    }
  );
  const document = filletEdges(base, {
    name: 'Fillet edges',
    targetBodyId: base.bodyOrder[0]!,
    edgeHashes: [42],
    edgeReferences: [edgeReference],
    size: 1
  }).document;
  const fillet = listFeaturesInOrder(document).find(
    (feature) => feature.data.featureKind === 'fillet'
  )!;
  return { document, fillet };
}

describe('editing a fillet edge set', () => {
  it('drops the stored references when the hashes grow without them', () => {
    const { document, fillet } = filletedBox();
    const next = updateFeature(document, {
      featureId: fillet.featureId,
      data: { edgeHashes: [42, 77], edgeReferences: undefined, radius: 1 }
    });
    const data = listFeaturesInOrder(next).find(
      (feature) => feature.featureId === fillet.featureId
    )!.data;
    expect(data.featureKind).toBe('fillet');
    if (data.featureKind !== 'fillet') return;
    expect(data.edgeHashes).toEqual([42, 77]);
    expect(data.edgeReferences).toBeUndefined();
  });

  it('keeps the references on an edit that only changes the size', () => {
    const { document, fillet } = filletedBox();
    const next = updateFeature(document, {
      featureId: fillet.featureId,
      data: { radius: 2 }
    });
    const data = listFeaturesInOrder(next).find(
      (feature) => feature.featureId === fillet.featureId
    )!.data;
    if (data.featureKind !== 'fillet') throw new Error('kind changed');
    expect(data.radius).toBe(2);
    expect(data.edgeReferences).toEqual([edgeReference]);
  });
});
