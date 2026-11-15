import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  draftBody,
  filletEdges,
  listFeaturesInOrder,
  shellBody,
  updateFeature
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';

/**
 * Production QA 2026-11-14 P1 #8: changing an early feature was refused with
 * "A selected edge no longer exists" although the edge still did. The
 * same-day follow-up fixed Shell and Draft naming (#1500) and could not
 * reproduce the box and early-chamfer cases; these pin every case it listed
 * as an edit that must REBUILD: no blocking warning (a typed
 * `reference_missing` is exactly the defect), an exact body with a closed
 * mesh, and the edit visibly applied downstream.
 */

const user = toUserId('user_qa_p1_edits');
const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

async function rebuilds(document: ProjectDocument): Promise<number> {
  const derived = await adapter.syncDocument(document);
  const blocking = (derived.featureWarnings ?? []).filter(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );
  expect(blocking.map((warning) => warning.message)).toEqual([]);
  const body = derived.bodyRepresentations[last(document)]!;
  expect(body.exportableStep).toBe(true);
  expect(
    isClosedConsistentlyOrientedMesh(
      inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
    )
  ).toBe(true);
  return body.volume;
}

const topology = (derived: DerivedState, id: BodyId) =>
  derived.bodyRepresentations[id]!.topology!;
const normal = (face: FaceTopology) =>
  face.geometry?.normal ?? { x: 0, y: 0, z: 0 };
const upFace = (derived: DerivedState, id: BodyId, z: number) =>
  topology(derived, id).faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      normal(face).z > 0.99 &&
      Math.abs(face.geometry.center.z - z) < 1e-6
  )!;
const loopAt = (derived: DerivedState, id: BodyId, z: number) => {
  const face = upFace(derived, id, z);
  return topology(derived, id).edges.filter(
    (edge) =>
      edge.displayRole !== 'seam' &&
      (edge.adjacentFaceHashes ?? []).includes(face.hash)
  );
};
const pickEdges = (edges: EdgeTopology[]) => ({
  edgeHashes: edges.map((edge) => edge.hash),
  ...(edges.every((edge) => edge.reference)
    ? { edgeReferences: edges.map((edge) => edge.reference!) }
    : {})
});
const box = (width: number, height: number, depth: number) =>
  addPrimitiveFeature(createProjectDocument('QA P1 #8', user), {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width, height, depth }
  });
/** Change the box primitive's dimensions in place. */
function editBox(
  document: ProjectDocument,
  dimensions: Partial<Record<'width' | 'height' | 'depth', number>>
): ProjectDocument {
  const root = listFeaturesInOrder(document).find(
    (feature) => feature.data.featureKind === 'primitive'
  )!;
  if (root.data.featureKind !== 'primitive') throw new Error('fixture');
  return updateFeature(document, {
    featureId: root.featureId,
    data: { dimensions: { ...root.data.dimensions, ...dimensions } }
  });
}

describe('QA 2026-11-14 P1 #8: an early edit keeps its downstream edges', () => {
  it('box height 6 → 8 under top-loop chamfers', async () => {
    const document = box(60, 40, 6);
    const base = await adapter.syncDocument(document);
    const chamfered = chamferEdges(document, {
      name: 'Bevel',
      targetBodyId: last(document),
      ...pickEdges(loopAt(base, last(document), 6)),
      size: 1
    });
    const before = await rebuilds(chamfered.document);
    const after = await rebuilds(editBox(chamfered.document, { depth: 8 }));
    // The chamfers ride up with the top: the body gains the 2 mm slab.
    expect(after - before).toBeCloseTo(60 * 40 * 2, 6);
  }, 300_000);

  it('box depth 40 → 18 under a top-edge fillet', async () => {
    const document = box(60, 40, 20);
    const base = await adapter.syncDocument(document);
    const filleted = filletEdges(document, {
      name: 'Round',
      targetBodyId: last(document),
      ...pickEdges(loopAt(base, last(document), 20).slice(0, 1)),
      size: 3
    });
    const before = await rebuilds(filleted.document);
    const after = await rebuilds(editBox(filleted.document, { height: 18 }));
    expect(after).toBeLessThan(before);
    // The rounded edge is still rounded: less than the sharp 60 × 18 × 20.
    expect(after).toBeLessThan(60 * 18 * 20 - 1);
  }, 300_000);

  it('shelled box height 30 → 40', async () => {
    const document = box(60, 40, 30);
    const base = await adapter.syncDocument(document);
    const opening = upFace(base, last(document), 30);
    const shelled = shellBody(document, {
      name: 'Shell',
      targetBodyId: last(document),
      openingFaceHashes: [opening.hash],
      ...(opening.reference
        ? { openingFaceReferences: [opening.reference] }
        : {}),
      thickness: 2
    });
    const shell = (depth: number) =>
      60 * 40 * depth - (60 - 4) * (40 - 4) * (depth - 2);
    expect(await rebuilds(shelled.document)).toBeCloseTo(shell(30), 6);
    expect(
      await rebuilds(editBox(shelled.document, { depth: 40 }))
    ).toBeCloseTo(shell(40), 6);
  }, 300_000);

  it.each([3, 10, 30])(
    'draft 2° → %s° under a top-edge fillet',
    async (angle) => {
      const document = box(40, 40, 20);
      const base = await adapter.syncDocument(document);
      const sides = topology(base, last(document)).faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          Math.abs(normal(face).z) < 1e-6
      );
      const drafted = draftBody(document, {
        name: 'Draft',
        targetBodyId: last(document),
        faceHashes: sides.map((face) => face.hash),
        ...(sides.every((face) => face.reference)
          ? { faceReferences: sides.map((face) => face.reference!) }
          : {}),
        pullDirection: { x: 0, y: 0, z: 1 },
        neutralPoint: { x: 0, y: 0, z: 0 },
        angleDeg: 2
      });
      const draftedBase = await adapter.syncDocument(drafted.document);
      const filleted = filletEdges(drafted.document, {
        name: 'Round',
        targetBodyId: drafted.bodyId,
        ...pickEdges(loopAt(draftedBase, drafted.bodyId, 20).slice(0, 1)),
        size: 1
      });
      const before = await rebuilds(filleted.document);
      const draft = listFeaturesInOrder(filleted.document).find(
        (feature) => feature.data.featureKind === 'draft'
      )!;
      const after = await rebuilds(
        updateFeature(filleted.document, {
          featureId: draft.featureId,
          data: { angleDeg: angle }
        })
      );
      // A steeper outward draft adds material.
      expect(after).toBeGreaterThan(before);
    },
    300_000
  );
});
