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
import { primitiveCylinderHeightAncestor } from '../apps/web/src/lib/interaction/cylinderPrimitiveAncestry';

/**
 * Dragging the top cap of a rounded cylinder.
 *
 * Offsetting that face is not what the gesture means once the rim carries a
 * blend: the flat remainder is smaller than the part, so pushing it alone
 * grows a narrow boss out of the fillet instead of making the cylinder
 * taller. The UI resolves the cap back to the primitive that owns it and
 * edits `height` instead — this pins both halves of that: the kernel really
 * does name the blended cap, and the resulting solid is the taller rounded
 * cylinder rather than a stepped one.
 */

const user = toUserId('user_cap_height_drag');
const RADIUS = 10;
const FILLET = 3;

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

/** Cap area as a fraction of the disc the rounded rim should have left. */
function capRadiusRatio(cap: ReturnType<typeof topCapFace>) {
  return (cap?.geometry?.area ?? 0) / (Math.PI * (RADIUS - FILLET) ** 2);
}

describe('cylinder cap height drag', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  /** A cylinder with every outside edge rounded, as the screenshot has it. */
  async function roundedCylinder(height: number): Promise<{
    document: ProjectDocument;
    sourceBodyId: BodyId;
    filletBodyId: BodyId;
    derived: Awaited<ReturnType<ExactKernelAdapter['syncDocument']>>;
  }> {
    const base = addPrimitiveFeature(
      createProjectDocument('Rounded cylinder', user),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: RADIUS, height }
      }
    );
    const sourceBodyId = base.bodyOrder.at(-1)!;
    const primitive = await adapter.syncDocument(base);
    expect(primitive.warnings).toEqual([]);

    const rims = (
      primitive.bodyRepresentations[sourceBodyId]?.topology?.edges ?? []
    ).filter((edge) => edge.displayRole !== 'seam' && edge.reference);
    expect(rims).toHaveLength(2);

    const filleted = filletEdges(base, {
      name: 'Round All Outside Edges',
      targetBodyId: sourceBodyId,
      edgeHashes: rims.map((edge) => edge.hash),
      edgeReferences: rims.map((edge) => edge.reference!),
      size: FILLET
    });
    const derived = await adapter.syncDocument(filleted.document);
    expect(derived.warnings).toEqual([]);
    return {
      document: filleted.document,
      sourceBodyId,
      filletBodyId: filleted.bodyId,
      derived
    };
  }

  function cylinderFeatureId(document: ProjectDocument) {
    return listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Cylinder'
    )!.featureId;
  }

  it('resolves the blended top cap back to the cylinder it belongs to', async () => {
    const model = await roundedCylinder(20);
    const cap = topCapFace(model.derived.bodyRepresentations[model.filletBodyId]);

    // The blended cap is a *smaller* disc than the cylinder — this is exactly
    // why offsetting it in place is the wrong answer. (Reported face area is
    // a sampled measure, so compare it proportionally; the volumes below are
    // the exact numbers.)
    expect(cap?.geometry?.area).toBeLessThan(Math.PI * RADIUS ** 2);
    expect(capRadiusRatio(cap)).toBeCloseTo(1, 3);
    expect(cap?.reference?.lineageName).toBe('modifier.cylinder.face.cap.end');

    expect(
      primitiveCylinderHeightAncestor(
        model.document,
        model.filletBodyId,
        cap!.reference,
        cap!.hash
      )?.featureId
    ).toBe(cylinderFeatureId(model.document));
  });

  it('makes the whole cylinder taller and keeps the rounds intact', async () => {
    const model = await roundedCylinder(20);
    const grown = await adapter.syncDocument(
      updateFeature(model.document, {
        featureId: cylinderFeatureId(model.document),
        data: { dimensions: { radius: RADIUS, height: 28 } }
      })
    );
    expect(grown.warnings).toEqual([]);
    const body = grown.bodyRepresentations[model.filletBodyId];

    // Indistinguishable from building the taller rounded cylinder outright.
    const rebuilt = await roundedCylinder(28);
    expect(body!.volume).toBeCloseTo(
      rebuilt.derived.bodyRepresentations[rebuilt.filletBodyId]!.volume,
      6
    );
    // Still rounded, and still one blended cap rather than a new step.
    expect(
      body!.topology?.faces.filter(
        (face) => face.geometry?.surfaceType === 'torus'
      )
    ).toHaveLength(2);
    expect(capRadiusRatio(topCapFace(body))).toBeCloseTo(1, 3);
  });

  it('is a different solid from offsetting the blended cap in place', async () => {
    const model = await roundedCylinder(20);
    const cap = topCapFace(model.derived.bodyRepresentations[model.filletBodyId]);
    const offset = await adapter.syncDocument(
      directEditBody(model.document, {
        name: 'Offset face',
        targetBodyId: model.filletBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: cap!.hash,
          faceReference: cap!.reference,
          sourceSurfaceType: 'plane',
          sourceArea: cap!.geometry!.area,
          sourceCenter: cap!.geometry!.center,
          sourceNormal: cap!.geometry!.normal!,
          offset: 8
        }
      }).document
    );
    expect(offset.warnings).toEqual([]);

    // The old behaviour adds a boss the width of the flat remainder; the new
    // one adds a full-diameter slice. Both are exact — only one is the drag.
    const before =
      model.derived.bodyRepresentations[model.filletBodyId]!.volume;
    expect(offset.bodyRepresentations[model.filletBodyId]!.volume).toBeCloseTo(
      before + Math.PI * (RADIUS - FILLET) ** 2 * 8,
      3
    );
    const rebuilt = await roundedCylinder(28);
    expect(
      rebuilt.derived.bodyRepresentations[rebuilt.filletBodyId]!.volume
    ).toBeCloseTo(before + Math.PI * RADIUS ** 2 * 8, 3);
  });
});
