import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
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
  type FaceTopology,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';

/**
 * The roles a filleted or chamfered box republishes for its own sides.
 *
 * Before `rederiveBoxModifierLineage` those six faces carried no reference at
 * all, so every pick on a blended block was hash-only: it could not resolve
 * back to the primitive, and it stopped resolving at all the moment anything
 * upstream re-fingerprinted the body. This file pins the roles themselves and
 * the one consequence that is invisible from the role list — that an edit
 * carrying the reference survives an upstream parametric change, where
 * `test/direct-edit-face-repair.test.ts` shows the reference-free variant
 * silently dropping out of replay.
 *
 * The cylinder side of the same dispatcher is already pinned by
 * `test/cylinder-cap-height-drag.test.ts`, which asserts a filleted cylinder's
 * cap still names `modifier.cylinder.face.cap.end`; it is not repeated here.
 */

const user = toUserId('user_box_modifier_lineage');
const WIDTH = 40;
const HEIGHT = 24;
const DEPTH = 10;
const BLEND = 1.5;

const SIDE_NORMALS: Record<string, Vector3> = {
  'x-min': { x: -1, y: 0, z: 0 },
  'x-max': { x: 1, y: 0, z: 0 },
  'y-min': { x: 0, y: -1, z: 0 },
  'y-max': { x: 0, y: 1, z: 0 },
  'z-min': { x: 0, y: 0, z: -1 },
  'z-max': { x: 0, y: 0, z: 1 }
};

function topFace(body: BodyRepresentation): FaceTopology {
  const face = (body.topology?.faces ?? [])
    .filter(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        candidate.geometry.normal !== undefined &&
        Math.abs(candidate.geometry.normal.z - 1) < 1e-9
    )
    .sort(
      (left, right) =>
        (right.geometry?.center.z ?? 0) - (left.geometry?.center.z ?? 0)
    )[0];
  expect(face, 'the body must expose a +z planar face').toBeDefined();
  return face!;
}

describe('box modifier lineage', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => {
    adapter.dispose();
  });

  async function blendedBox(
    kind: 'fillet' | 'chamfer',
    width = WIDTH
  ): Promise<{
    document: ProjectDocument;
    primitiveBodyId: BodyId;
    bodyId: BodyId;
    body: BodyRepresentation;
  }> {
    const base = addPrimitiveFeature(
      createProjectDocument('Box modifier lineage', user),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width, height: HEIGHT, depth: DEPTH }
      }
    );
    const primitiveBodyId = base.bodyOrder[0]!;
    const first = await adapter.syncDocument(base);
    expect(first.warnings).toEqual([]);
    const edges = (
      first.bodyRepresentations[primitiveBodyId]?.topology?.edges ?? []
    ).filter((edge) => edge.displayRole !== 'seam' && edge.reference);
    expect(edges).toHaveLength(12);

    const modify = kind === 'fillet' ? filletEdges : chamferEdges;
    const modified = modify(base, {
      name: kind === 'fillet' ? 'Blend all edges' : 'Break all edges',
      targetBodyId: primitiveBodyId,
      edgeHashes: edges.map((edge) => edge.hash),
      edgeReferences: edges.map((edge) => edge.reference!),
      size: BLEND
    });
    const derived = await adapter.syncDocument(modified.document);
    expect(derived.warnings).toEqual([]);
    return {
      document: modified.document,
      primitiveBodyId,
      bodyId: modified.bodyId,
      body: derived.bodyRepresentations[modified.bodyId]!
    };
  }

  for (const kind of ['fillet', 'chamfer'] as const) {
    it(`names all six sides of a ${kind}ed box`, async () => {
      const model = await blendedBox(kind);
      const named = (model.body.topology?.faces ?? []).filter((face) =>
        face.reference?.lineageName.startsWith('modifier.box.face.')
      );
      expect(named.map((face) => face.reference!.lineageName).sort()).toEqual(
        Object.keys(SIDE_NORMALS)
          .map((side) => `modifier.box.face.${side}`)
          .sort()
      );

      for (const face of named) {
        const side = face.reference!.lineageName.replace(
          'modifier.box.face.',
          ''
        );
        // A reference whose hash has moved on is not evidence about this
        // face; the ancestry walk refuses it, so the pin has to check it.
        expect(
          face.reference!.currentHash,
          `${side} publishes a stale hash`
        ).toBe(face.hash);
        expect(face.geometry?.surfaceType).toBe('plane');
        const normal = face.geometry?.normal;
        expect(normal, `${side} has no exact normal`).toBeDefined();
        const expected = SIDE_NORMALS[side]!;
        expect(normal!.x).toBeCloseTo(expected.x, 9);
        expect(normal!.y).toBeCloseTo(expected.y, 9);
        expect(normal!.z).toBeCloseTo(expected.z, 9);
      }
    });
  }

  it('carries an offset edit through an upstream width change', async () => {
    const model = await blendedBox('fillet');
    const face = topFace(model.body);
    expect(face.reference?.lineageName).toBe('modifier.box.face.z-max');

    // Deliberately the RAW op, not the planner's route: this is the *local*
    // push/pull semantics, kept here only to pin that the new reference
    // re-resolves after an upstream edit. What the gesture should build on a
    // blended box is pinned in `test/box-face-dimension-drag.test.ts`.
    const edited = directEditBody(model.document, {
      name: 'Offset face',
      targetBodyId: model.bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: face.hash,
        faceReference: face.reference,
        sourceSurfaceType: 'plane',
        sourceArea: face.geometry!.area,
        sourceCenter: face.geometry!.center,
        sourceNormal: face.geometry!.normal!,
        offset: 5
      }
    }).document;
    const built = await adapter.syncDocument(edited);
    expect(built.warnings).toEqual([]);

    const primitive = listFeaturesInOrder(edited).find(
      (feature) => feature.name === 'Block'
    )!;
    const widened = updateFeature(edited, {
      featureId: primitive.featureId,
      data: { dimensions: { width: 50, height: HEIGHT, depth: DEPTH } }
    });
    const after = await adapter.syncDocument(widened);
    // The hash-only variant of this edit loses its face here and drops out of
    // replay with "no longer exists" (direct-edit-face-repair.test.ts).
    expect(after.warnings).toEqual([]);

    // Oracle: the widened blended box measured on its own, plus the prism the
    // local op raises over the picked face's outline.
    const wide = await blendedBox('fillet', 50);
    const wideTop = topFace(wide.body);
    expect(wideTop.geometry!.area).toBeCloseTo(
      (50 - 2 * BLEND) * (HEIGHT - 2 * BLEND),
      6
    );
    const expected = wide.body.volume + wideTop.geometry!.area * 5;
    // The reported planar area is the face's outline rectangle while the
    // solid's own corners are rounded, so the two routes differ by a few
    // thousandths of a mm3 rather than exactly.
    expect(
      Math.abs(after.bodyRepresentations[model.bodyId]!.volume - expected),
      `edited ${after.bodyRepresentations[model.bodyId]!.volume} vs ${expected}`
    ).toBeLessThan(0.01);
  });
});
