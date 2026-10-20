import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  attachDerivedState,
  createProjectDocument,
  extrudeSketch,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ExtrudeToFaceTarget,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { faceSketchAttachment } from '../../../apps/web/src/lib/faceSketchAttachment';
import { OcctStepKernelAdapter } from './occt-step';

/**
 * F01 (schema v29) across both kernels: extrude to a face and extrude draft.
 * Each volume is checked against its closed form on both, not one kernel
 * against the other. The constructions are independent: production drafts
 * planar walls with the Remus draft and lofts a round wall into a cone,
 * while the reference builds OCCT's own drafted prism.
 */
const user = toUserId('user_extrude_options_parity');
const TAN5 = Math.tan((5 * Math.PI) / 180);

function simpson(area: (height: number) => number, height: number): number {
  return (height / 6) * (area(0) + 4 * area(height / 2) + area(height));
}

function draftedBox(w: number, h: number, height: number, tangent: number) {
  return simpson((z) => (w - 2 * z * tangent) * (h - 2 * z * tangent), height);
}

const RECT: SketchObjectData = {
  objectKind: 'rectangle',
  width: 20,
  height: 12,
  centerX: 0,
  centerY: 0
};

function profile(
  object: SketchObjectData,
  document = createProjectDocument('Profile', user)
) {
  return addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [object]
  });
}

describe('F01 to-face and draft: Remus and OCCT closed forms', () => {
  let remus: ExactKernelAdapter;
  let occt: OcctStepKernelAdapter;
  beforeAll(async () => {
    remus = await createExactKernelAdapter();
    occt = await OcctStepKernelAdapter.create();
  });
  afterAll(() => {
    remus.dispose();
    occt.dispose();
  });

  async function both(
    document: ProjectDocument,
    bodyId: BodyId,
    expected: number
  ) {
    for (const adapter of [remus, occt]) {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const volume = derived.bodyRepresentations[bodyId]?.volume;
      expect(volume).toBeDefined();
      expect(Math.abs(volume! - expected)).toBeLessThan(expected * 1e-6);
    }
  }

  it.each([
    [5, draftedBox(20, 12, 10, TAN5)],
    [-5, draftedBox(20, 12, 10, -TAN5)]
  ])(
    'drafts a 20 × 12 rectangle by %d° to the prismatoid volume',
    async (angle, expected) => {
      const sketched = profile(RECT);
      const result = extrudeSketch(sketched.document, {
        name: 'Boss',
        sketchId: sketched.sketchId,
        distance: 10,
        draftAngleDeg: angle
      });
      await both(result.document, result.bodyId, expected);
    }
  );

  it('drafts a circle to the cone frustum volume', async () => {
    const sketched = profile({
      objectKind: 'circle',
      radius: 5,
      centerX: 0,
      centerY: 0
    });
    const result = extrudeSketch(sketched.document, {
      name: 'Boss',
      sketchId: sketched.sketchId,
      distance: 10,
      draftAngleDeg: 5
    });
    const r2 = 5 - 10 * TAN5;
    await both(
      result.document,
      result.bodyId,
      ((Math.PI * 10) / 3) * (25 + 5 * r2 + r2 * r2)
    );
  });

  it('extrudes to a lineage-named face, straight and drafted', async () => {
    let document = createProjectDocument('To face', user);
    document = addPrimitiveFeature(document, {
      name: 'Ceiling',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 2 }
    });
    const ceilingId = document.bodyOrder[0]!;
    document = transformBody(document, {
      name: 'Lift',
      targetBodyId: ceilingId,
      translation: { x: 0, y: 0, z: 25 }
    }).document;
    const built = attachDerivedState(
      document,
      await remus.syncDocument(document)
    );
    const underside = built.derived.bodyRepresentations[
      ceilingId
    ]!.topology!.faces.find((face) => (face.geometry?.normal?.z ?? 0) < -0.99)!;
    const attachment = faceSketchAttachment({
      bodyId: ceilingId,
      pickedHash: underside.hash,
      face: underside
    });
    if (!attachment.ok || attachment.attachment !== 'associative') {
      throw new Error('Expected an associative face.');
    }
    const toFace = attachment.planeRef as ExtrudeToFaceTarget;
    const sketched = profile(
      {
        objectKind: 'rectangle',
        width: 4,
        height: 4,
        centerX: 10,
        centerY: 10
      },
      document
    );
    const straight = extrudeSketch(sketched.document, {
      name: 'Post',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'to-face',
      toFace
    });
    await both(straight.document, straight.bodyId, 4 * 4 * 25);
    const drafted = extrudeSketch(sketched.document, {
      name: 'Tapered post',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'to-face',
      toFace,
      draftAngleDeg: 2
    });
    await both(
      drafted.document,
      drafted.bodyId,
      draftedBox(4, 4, 25, Math.tan((2 * Math.PI) / 180))
    );
  });
});
