import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
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
 * Direct edits under parametric edits. A direct edit used to drop its result
 * body to hash-only lineage, which made every downstream reference — and the
 * direct edit's own face pick — brittle: all the stored hashes embed
 * radius-dependent measurements. With lineage re-derived on primitive
 * direct-edit results and faces resolved reference-first, a cap offset (a
 * radius-independent operation) now survives an upstream cylinder radius
 * change, and so does a fillet stacked after it. Operations saved without a
 * v5 reference keep the fail-closed hash behaviour.
 */

const user = toUserId('user_direct_edit_chain');

function cylinderDocument(radius: number, height: number): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  const document = addPrimitiveFeature(
    createProjectDocument('Offset cylinder', user),
    {
      name: 'Cyl',
      primitiveKind: 'cylinder',
      dimensions: { radius, height }
    }
  );
  return { document, bodyId: document.bodyOrder.at(-1)! };
}

/** The planar face with the highest exact center — the top cap. */
function topCapFace(body: BodyRepresentation | undefined) {
  const planes = (body?.topology?.faces ?? []).filter(
    (face) => face.geometry?.surfaceType === 'plane'
  );
  return planes.sort(
    (left, right) =>
      (right.geometry?.center.z ?? 0) - (left.geometry?.center.z ?? 0)
  )[0];
}

/** The non-seam closed edge whose sampled points sit highest. */
function topRimEdge(body: BodyRepresentation | undefined) {
  const edges = (body?.topology?.edges ?? []).filter(
    (edge) => edge.displayRole !== 'seam'
  );
  const maxZ = (points: number[]): number => {
    let max = -Infinity;
    for (let index = 2; index < points.length; index += 3) {
      max = Math.max(max, points[index]!);
    }
    return max;
  };
  return edges.sort((left, right) => maxZ(right.points) - maxZ(left.points))[0];
}

describe('direct edits across cylinder radius edits', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  /** Cylinder + cap offset (+ optional rim fillet), returning derived state. */
  async function offsetChain(
    radius: number,
    options: { withReference: boolean; withFillet: boolean }
  ) {
    const { document, bodyId } = cylinderDocument(radius, 20);
    const base = await adapter.syncDocument(document);
    expect(base.warnings).toEqual([]);
    const cap = topCapFace(base.bodyRepresentations[bodyId]);
    expect(cap?.geometry?.normal).toBeTruthy();
    expect(cap?.reference?.lineageName).toBe('primitive.cylinder.face.cap.end');

    const offset = directEditBody(document, {
      name: 'Offset cap',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: cap!.hash,
        ...(options.withReference ? { faceReference: cap!.reference } : {}),
        sourceSurfaceType: 'plane',
        sourceArea: cap!.geometry!.area,
        sourceCenter: cap!.geometry!.center,
        sourceNormal: cap!.geometry!.normal!,
        offset: 5
      }
    });

    if (!options.withFillet) {
      return { document: offset.document, bodyId, filletBodyId: null };
    }

    const offsetDerived = await adapter.syncDocument(offset.document);
    expect(offsetDerived.warnings).toEqual([]);
    const rim = topRimEdge(offsetDerived.bodyRepresentations[bodyId]);
    // The re-derived lineage must republish the rim under the primitive —
    // this is what lets the UI capture a reference on a post-edit body.
    expect(rim?.reference?.lineageName).toBe('primitive.cylinder.edge.rim.end');

    const filleted = filletEdges(offset.document, {
      name: 'Rim fillet',
      targetBodyId: bodyId,
      edgeHashes: [rim!.hash],
      edgeReferences: [rim!.reference!],
      size: 1
    });
    return {
      document: filleted.document,
      bodyId,
      filletBodyId: filleted.bodyId
    };
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

  it('regenerates a cap offset and rim fillet when the cylinder radius changes', async () => {
    const chain = await offsetChain(10, {
      withReference: true,
      withFillet: true
    });
    const before = await adapter.syncDocument(chain.document);
    expect(before.warnings).toEqual([]);

    const after = await adapter.syncDocument(withRadius(chain.document, 12));
    expect(after.warnings).toEqual([]);
    const body = after.bodyRepresentations[chain.filletBodyId!];
    expect(body).toBeTruthy();

    // Identical to building the r=12 chain from scratch.
    const reference = await offsetChain(12, {
      withReference: true,
      withFillet: true
    });
    const rebuilt = await adapter.syncDocument(reference.document);
    expect(rebuilt.warnings).toEqual([]);
    expect(body!.volume).toBeCloseTo(
      rebuilt.bodyRepresentations[reference.filletBodyId!]!.volume,
      6
    );
  });

  it('keeps a reference-free cap offset fail-closed after a radius edit', async () => {
    const chain = await offsetChain(10, {
      withReference: false,
      withFillet: false
    });
    // The chain replays cleanly while nothing upstream moves.
    expect((await adapter.syncDocument(chain.document)).warnings).toEqual([]);

    const after = await adapter.syncDocument(withRadius(chain.document, 12));
    expect(after.warnings).toEqual([
      'Feature "Offset cap": A selected face no longer exists. Re-select the face(s) and re-create this feature.'
    ]);
    // The failed edit leaves the resized primitive untouched.
    expect(after.bodyRepresentations[chain.bodyId]?.volume).toBeCloseTo(
      Math.PI * 12 ** 2 * 20,
      3
    );
  });
});
