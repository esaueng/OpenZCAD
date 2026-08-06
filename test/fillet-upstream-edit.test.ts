import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
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
  type EdgeTopologyReferenceV5,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Cylinder-rim coverage for edge modifiers under upstream parameter edits.
 *
 * A rim is a CLOSED edge, so its content hash embeds its circumference and a
 * radius edit orphans every stored hash at once — the adversarial case the
 * v5 lineage resolution in `resolveEdgeModifierEdges` exists for. The box
 * variant is pinned in exact-kernel-adapter.test.ts; these tests pin the
 * closed-edge shape of the problem (the reported repro: r 4.6 → 6.4 mm under
 * a 1 mm rim fillet), the chamfer path through the same resolver, that a
 * single-rim modifier lands on the SAME rim rather than its sibling, replay
 * determinism (what snapshot undo relies on), and exact STEP export of the
 * resized result.
 */

const user = toUserId('user_fillet_edit');

/** Non-seam edges — the same set the app's "select all edges" offers. */
function selectableEdges(body: BodyRepresentation | undefined) {
  return (body?.topology?.edges ?? []).filter(
    (edge) => edge.displayRole !== 'seam'
  );
}

function edgeSelection(body: BodyRepresentation | undefined): {
  edgeHashes: number[];
  edgeReferences: EdgeTopologyReferenceV5[];
} {
  const edges = selectableEdges(body);
  const edgeHashes = edges.map((edge) => edge.hash);
  const edgeReferences = edges.flatMap((edge) =>
    edge.reference ? [edge.reference] : []
  );
  return { edgeHashes, edgeReferences };
}

/** Max |z| over an edge's sampled points, to tell the two rims apart. */
function edgeMaxZ(edge: { points: number[] }): number {
  let max = 0;
  for (let index = 2; index < edge.points.length; index += 3) {
    max = Math.max(max, Math.abs(edge.points[index]!));
  }
  return max;
}

function cylinderDocument(radius: number, height: number): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  const document = addPrimitiveFeature(
    createProjectDocument('Filleted cylinder', user),
    {
      name: 'Cyl',
      primitiveKind: 'cylinder',
      dimensions: { radius, height }
    }
  );
  return { document, bodyId: document.bodyOrder.at(-1)! };
}

describe('edge modifiers across cylinder radius edits', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  /** The derived volume of a fresh radius/height cylinder + 1 mm modifier. */
  async function rebuiltFromScratch(
    kind: 'fillet' | 'chamfer',
    radius: number,
    height: number
  ): Promise<number> {
    const { document, bodyId } = cylinderDocument(radius, height);
    const base = await adapter.syncDocument(document);
    const selection = edgeSelection(base.bodyRepresentations[bodyId]);
    const modify = kind === 'fillet' ? filletEdges : chamferEdges;
    const modified = modify(document, {
      name: 'Reference modifier',
      targetBodyId: bodyId,
      ...selection,
      size: 1
    });
    const derived = await adapter.syncDocument(modified.document);
    expect(derived.warnings).toEqual([]);
    return derived.bodyRepresentations[modified.bodyId]!.volume;
  }

  it('keeps a both-rim fillet when the cylinder radius changes (reported case)', async () => {
    const { document, bodyId } = cylinderDocument(4.6, 28);
    const base = await adapter.syncDocument(document);
    expect(base.warnings).toEqual([]);
    const selection = edgeSelection(base.bodyRepresentations[bodyId]);
    expect(selection.edgeHashes).toHaveLength(2);
    // The kernel proves a v5 reference for both rims; without them this test
    // would silently degrade into the legacy hash-only scenario below.
    expect(selection.edgeReferences).toHaveLength(2);

    const filleted = filletEdges(document, {
      name: 'Rim fillet',
      targetBodyId: bodyId,
      ...selection,
      size: 1
    });
    const before = await adapter.syncDocument(filleted.document);
    expect(before.warnings).toEqual([]);
    const beforeVolume =
      before.bodyRepresentations[filleted.bodyId]!.volume;

    const cylinder = listFeaturesInOrder(filleted.document).find(
      (feature) => feature.name === 'Cyl'
    )!;
    const edited = updateFeature(filleted.document, {
      featureId: cylinder.featureId,
      data: { dimensions: { radius: 6.4 } }
    });

    const after = await adapter.syncDocument(edited);
    expect(after.warnings).toEqual([]);
    const body = after.bodyRepresentations[filleted.bodyId];
    expect(body).toBeTruthy();
    // Same geometry a user would get building 6.4 + fillet from scratch.
    expect(body!.volume).toBeCloseTo(
      await rebuiltFromScratch('fillet', 6.4, 28),
      6
    );

    // Undo is a snapshot swap followed by a full rebuild: replaying the
    // pre-edit document must reproduce the original filleted geometry.
    const undone = await adapter.syncDocument(filleted.document);
    expect(undone.warnings).toEqual([]);
    expect(
      undone.bodyRepresentations[filleted.bodyId]!.volume
    ).toBeCloseTo(beforeVolume, 6);
  });

  it('keeps a both-rim chamfer when the cylinder radius changes', async () => {
    const { document, bodyId } = cylinderDocument(4.6, 28);
    const base = await adapter.syncDocument(document);
    const selection = edgeSelection(base.bodyRepresentations[bodyId]);
    expect(selection.edgeReferences).toHaveLength(2);

    const chamfered = chamferEdges(document, {
      name: 'Rim chamfer',
      targetBodyId: bodyId,
      ...selection,
      size: 1
    });
    expect((await adapter.syncDocument(chamfered.document)).warnings).toEqual(
      []
    );

    const cylinder = listFeaturesInOrder(chamfered.document).find(
      (feature) => feature.name === 'Cyl'
    )!;
    const edited = updateFeature(chamfered.document, {
      featureId: cylinder.featureId,
      data: { dimensions: { radius: 6.4 } }
    });

    const after = await adapter.syncDocument(edited);
    expect(after.warnings).toEqual([]);
    expect(
      after.bodyRepresentations[chamfered.bodyId]!.volume
    ).toBeCloseTo(await rebuiltFromScratch('chamfer', 6.4, 28), 6);
  });

  it('resolves a single-rim fillet to the same rim, not its sibling', async () => {
    // rim.start and rim.end share every hash ingredient except position, so a
    // resolution scheme that survives the resize but lands on the WRONG rim
    // would pass any volume assertion. Assert position instead.
    const { document, bodyId } = cylinderDocument(4.6, 28);
    const base = await adapter.syncDocument(document);
    const edges = selectableEdges(base.bodyRepresentations[bodyId]);
    const topRim = edges.find((edge) => edgeMaxZ(edge) > 27)!;
    expect(topRim).toBeTruthy();
    expect(topRim.reference).toBeTruthy();

    const filleted = filletEdges(document, {
      name: 'Top rim fillet',
      targetBodyId: bodyId,
      edgeHashes: [topRim.hash],
      edgeReferences: [topRim.reference!],
      size: 1
    });
    const cylinder = listFeaturesInOrder(filleted.document).find(
      (feature) => feature.name === 'Cyl'
    )!;
    const edited = updateFeature(filleted.document, {
      featureId: cylinder.featureId,
      data: { dimensions: { radius: 6.4 } }
    });

    const after = await adapter.syncDocument(edited);
    expect(after.warnings).toEqual([]);
    const filletedEdges =
      after.bodyRepresentations[filleted.bodyId]!.topology!.edges;
    // The bottom rim stays sharp: a full circle at z = 0 with radius 6.4.
    const bottom = filletedEdges.find(
      (edge) =>
        edgeMaxZ(edge) < 1e-6 &&
        Math.hypot(edge.points[0]!, edge.points[1]!) > 6.4 - 1e-4
    );
    expect(bottom).toBeTruthy();
    // The top rim is blended: nothing remains at both z = 28 and radius 6.4.
    const sharpTop = filletedEdges.find((edge) => {
      for (let index = 0; index + 2 < edge.points.length; index += 3) {
        if (
          Math.abs(edge.points[index + 2]! - 28) < 1e-6 &&
          Math.hypot(edge.points[index]!, edge.points[index + 1]!) > 6.4 - 1e-4
        ) {
          return true;
        }
      }
      return false;
    });
    expect(sharpTop).toBeUndefined();
  });

  it('still fails closed for a hash-only legacy fillet', async () => {
    const { document, bodyId } = cylinderDocument(4.6, 28);
    const base = await adapter.syncDocument(document);
    const { edgeHashes } = edgeSelection(base.bodyRepresentations[bodyId]);

    const filleted = filletEdges(document, {
      name: 'Legacy fillet',
      targetBodyId: bodyId,
      edgeHashes,
      size: 1
    });
    const cylinder = listFeaturesInOrder(filleted.document).find(
      (feature) => feature.name === 'Cyl'
    )!;
    const edited = updateFeature(filleted.document, {
      featureId: cylinder.featureId,
      data: { dimensions: { radius: 6.4 } }
    });

    const after = await adapter.syncDocument(edited);
    expect(after.warnings).toEqual([
      'Feature "Legacy fillet": A selected edge no longer exists.'
    ]);
    expect(after.bodyRepresentations[filleted.bodyId]).toBeUndefined();
    // The resized cylinder itself is intact.
    expect(after.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 6.4 ** 2 * 28,
      3
    );
  });

  it('exports the resized filleted body as exact STEP', async () => {
    const { document, bodyId } = cylinderDocument(4.6, 28);
    const base = await adapter.syncDocument(document);
    const selection = edgeSelection(base.bodyRepresentations[bodyId]);

    const filleted = filletEdges(document, {
      name: 'Rim fillet',
      targetBodyId: bodyId,
      ...selection,
      size: 1
    });
    const cylinder = listFeaturesInOrder(filleted.document).find(
      (feature) => feature.name === 'Cyl'
    )!;
    const edited = updateFeature(filleted.document, {
      featureId: cylinder.featureId,
      data: { dimensions: { radius: 6.4 } }
    });
    const derived = await adapter.syncDocument(edited);
    expect(derived.warnings).toEqual([]);
    const derivedVolume =
      derived.bodyRepresentations[filleted.bodyId]!.volume;

    const step = await adapter.exportStep(edited, [filleted.bodyId]);
    expect(step.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(1);
    const inspection = await adapter.inspectStep(step);
    expect(inspection.solid).toBe(true);
    expect(inspection.volume).toBeCloseTo(derivedVolume, 3);
  });
});
