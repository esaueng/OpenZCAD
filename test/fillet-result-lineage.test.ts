import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Fillet/chamfer results used to drop to hash-only lineage, so an edge picked
 * on a filleted body was hash-only from birth — and a second modifier stacked
 * on the first died on any upstream parametric edit with "A selected edge no
 * longer exists." (reported live: cylinder → fillet → fillet, wall drag).
 * With cylinder-chain modifier results re-deriving semantic roles, picks on
 * filleted bodies carry v5 references again and stacked modifiers survive.
 * Non-cylinder chains stay hash-only, pinned below.
 */

const user = toUserId('user_fillet_lineage');

function cylinderDocument(radius: number, height: number): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  const document = addPrimitiveFeature(
    createProjectDocument('Stacked fillets', user),
    {
      name: 'Cyl',
      primitiveKind: 'cylinder',
      dimensions: { radius, height }
    }
  );
  return { document, bodyId: document.bodyOrder.at(-1)! };
}

function featureEdges(body: BodyRepresentation | undefined) {
  return (body?.topology?.edges ?? []).filter(
    (edge) => edge.displayRole !== 'seam'
  );
}

function edgeMaxZ(edge: { points: number[] }): number {
  let max = -Infinity;
  for (let index = 2; index < edge.points.length; index += 3) {
    max = Math.max(max, edge.points[index]!);
  }
  return max;
}

describe('fillet result lineage', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  /** Cylinder + top-rim fillet; optionally a second fillet on the bottom rim
   *  picked from the first fillet's derived body, with or without the
   *  published reference. */
  async function stackedChain(options: { secondWithReference: boolean }) {
    const { document, bodyId } = cylinderDocument(4.6, 28);
    const base = await adapter.syncDocument(document);
    const topRim = featureEdges(base.bodyRepresentations[bodyId]).find(
      (edge) => edgeMaxZ(edge) > 27
    )!;
    const first = filletEdges(document, {
      name: 'Fillet top',
      targetBodyId: bodyId,
      edgeHashes: [topRim.hash],
      edgeReferences: [topRim.reference!],
      size: 1
    });

    const derived = await adapter.syncDocument(first.document);
    expect(derived.warnings).toEqual([]);
    const firstBody = derived.bodyRepresentations[first.bodyId];
    const bottomRim = featureEdges(firstBody).find(
      (edge) => edgeMaxZ(edge) < 1e-6
    )!;
    const second = filletEdges(first.document, {
      name: 'Fillet bottom',
      targetBodyId: first.bodyId,
      edgeHashes: [bottomRim.hash],
      ...(options.secondWithReference && bottomRim.reference
        ? { edgeReferences: [bottomRim.reference] }
        : {}),
      size: 1
    });
    return { ...second, firstBody, bottomRim };
  }

  function withRadius(document: ProjectDocument, radius: number) {
    const cylinder = listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Cyl'
    )!;
    return updateFeature(document, {
      featureId: cylinder.featureId,
      data: { dimensions: { radius } }
    });
  }

  it('publishes semantic references on a filleted cylinder body', async () => {
    const chain = await stackedChain({ secondWithReference: false });
    // The pick channel this whole fix exists for: the first fillet's body
    // names its topology again, so the UI captures v5 references on it.
    expect(chain.bottomRim.reference?.lineageName).toBe(
      'modifier.cylinder.edge.rim.start'
    );
    const wall = chain.firstBody?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(wall?.reference?.lineageName).toBe('modifier.cylinder.face.wall');
  });

  it('keeps a stacked fillet when the cylinder radius changes (reported case)', async () => {
    const chain = await stackedChain({ secondWithReference: true });
    expect((await adapter.syncDocument(chain.document)).warnings).toEqual([]);

    const after = await adapter.syncDocument(withRadius(chain.document, 6.4));
    expect(after.warnings).toEqual([]);
    const body = after.bodyRepresentations[chain.bodyId];
    expect(body).toBeTruthy();

    // Identical to building the whole stacked chain at 6.4 from scratch.
    const rebuilt = await (async () => {
      const { document, bodyId } = cylinderDocument(6.4, 28);
      const base = await adapter.syncDocument(document);
      const topRim = featureEdges(base.bodyRepresentations[bodyId]).find(
        (edge) => edgeMaxZ(edge) > 27
      )!;
      const first = filletEdges(document, {
        name: 'Fillet top',
        targetBodyId: bodyId,
        edgeHashes: [topRim.hash],
        size: 1
      });
      const derived = await adapter.syncDocument(first.document);
      const bottomRim = featureEdges(
        derived.bodyRepresentations[first.bodyId]
      ).find((edge) => edgeMaxZ(edge) < 1e-6)!;
      const second = filletEdges(first.document, {
        name: 'Fillet bottom',
        targetBodyId: first.bodyId,
        edgeHashes: [bottomRim.hash],
        size: 1
      });
      const final = await adapter.syncDocument(second.document);
      expect(final.warnings).toEqual([]);
      return final.bodyRepresentations[second.bodyId]!.volume;
    })();
    expect(body!.volume).toBeCloseTo(rebuilt, 6);
  });

  it('still fails closed when the stacked fillet is hash-only', async () => {
    const chain = await stackedChain({ secondWithReference: false });
    expect((await adapter.syncDocument(chain.document)).warnings).toEqual([]);

    const after = await adapter.syncDocument(withRadius(chain.document, 6.4));
    expect(after.warnings).toEqual([
      'Feature "Fillet bottom": A selected edge no longer exists. Re-select the edges and re-create this feature.'
    ]);
    expect(after.bodyRepresentations[chain.bodyId]).toBeUndefined();
  });

  it('attributes only the generated blend on a non-cylinder modifier', async () => {
    const withBox = addPrimitiveFeature(
      createProjectDocument('Filleted box', user),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const bodyId = withBox.bodyOrder.at(-1)!;
    const base = await adapter.syncDocument(withBox);
    const edge = featureEdges(base.bodyRepresentations[bodyId]).find(
      (candidate) => candidate.reference
    )!;
    const filleted = filletEdges(withBox, {
      name: 'Box fillet',
      targetBodyId: bodyId,
      edgeHashes: [edge.hash],
      edgeReferences: [edge.reference!],
      size: 2
    });
    const derived = await adapter.syncDocument(filleted.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[filleted.bodyId];
    expect(
      (body?.topology?.edges ?? []).every((candidate) => !candidate.reference)
    ).toBe(true);
    const referencedFaces = (body?.topology?.faces ?? []).filter(
      (candidate) => candidate.reference
    );
    expect(referencedFaces).toHaveLength(1);
    expect(referencedFaces[0]?.geometry?.featureType).toBe('blend');
    const filletFeature = listFeaturesInOrder(filleted.document).at(-1)!;
    expect(referencedFaces[0]?.reference?.producingFeatureId).toBe(
      filletFeature.featureId
    );
  });
});
