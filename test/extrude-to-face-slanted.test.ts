import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  attachDerivedState,
  createProjectDocument,
  extrudeSketch,
  extrudeToFaceUnresolved,
  listFeaturesInOrder,
  toFaceReach,
  updateFeature,
  TO_FACE_SLANT_COSINE_LIMIT
} from '@openzcad/document-core';
import { commandFactories } from '@openzcad/command-system';
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
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';
import { toFaceReachEstimate } from '../apps/web/src/lib/extrudeToFace';
import {
  extrudeDraftRefusal,
  initialExtrudeDraft,
  type ExtrudeDraftContext
} from '../apps/web/src/lib/extrudeDraft';

/**
 * F01: extrude up to a slanted face.
 *
 * The target is a 20 × 20 × 2 ceiling turned `deg` about X through the
 * point (10, 10, z) on its underside, right over the middle of the 4 × 4
 * profile at (10, 10). The underside then rises linearly across the square,
 * as z + tan(deg) (y − 10), so the post's mean height is z (its volume is
 * 16 z exactly) and its highest corner stands at z + 2 tan(deg). A face
 * parallel to the sketch keeps the blind path it always had; these lean.
 */
const SQUARE: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 10,
  centerY: 10
};
const AREA = 16;
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180);

function project(name: string): ProjectDocument {
  return createProjectDocument(name, toUserId('user_slanted_face'));
}

/**
 * The ceiling with its underside at `z`, turned `deg` about X through the
 * middle of its underside (the turn is made about the pivot before the lift).
 */
function ceiling(document: ProjectDocument, z: number, deg: number) {
  const made = addPrimitiveFeature(document, {
    name: 'Ceiling',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 2 }
  });
  const bodyId = made.bodyOrder.at(-1)!;
  const moved = commandFactories
    .transformBody({
      name: 'Lift',
      targetBodyId: bodyId,
      translation: { x: 0, y: 0, z },
      rotationDeg: { x: deg, y: 0, z: 0 },
      pivot: { x: 10, y: 10, z: 0 }
    })
    .apply(made);
  return { document: moved, bodyId };
}

describe('F01 to a slanted face', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function derive(document: ProjectDocument) {
    return adapter.syncDocument(document);
  }

  /**
   * The ceiling's underside (`nz` −1) or top (+1) after turning `deg` about
   * X: the face whose outward normal is ±Z turned by `deg`, whichever way
   * the turn runs.
   */
  async function face(
    document: ProjectDocument,
    bodyId: BodyId,
    nz: 1 | -1,
    deg: number
  ): Promise<ExtrudeToFaceTarget> {
    const built = attachDerivedState(document, await derive(document));
    const faces = built.derived.bodyRepresentations[bodyId]!.topology!.faces;
    const s = Math.sin((deg * Math.PI) / 180);
    const c = nz * cos(deg);
    const score = (normal: { y: number; z: number } | undefined) =>
      normal
        ? Math.max(normal.y * s + normal.z * c, -normal.y * s + normal.z * c)
        : -Infinity;
    const picked = faces.reduce((best, candidate) =>
      score(candidate.geometry?.normal) > score(best.geometry?.normal)
        ? candidate
        : best
    );
    const attachment = faceSketchAttachment({
      bodyId,
      pickedHash: picked.hash,
      face: picked
    });
    if (!attachment.ok || attachment.attachment !== 'associative') {
      throw new Error('Expected an associative planar face.');
    }
    return attachment.planeRef as ExtrudeToFaceTarget;
  }

  async function post(
    deg: number,
    patch: Record<string, unknown> = {},
    z = 25,
    sketchOffset = 0,
    square: Partial<SketchObjectData> = {}
  ) {
    const lifted = ceiling(project('Slanted'), z, deg);
    const target = await face(lifted.document, lifted.bodyId, -1, deg);
    const sketched = addSketchFeature(lifted.document, {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: sketchOffset },
      objects: [{ ...SQUARE, ...square } as SketchObjectData]
    });
    const result = extrudeSketch(sketched.document, {
      name: 'Post',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'to-face',
      toFace: target,
      ...patch
    });
    return { ...result, target, sketched, ceilingId: lifted.bodyId };
  }

  describe('shared reach rule', () => {
    const sketch = {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 }
    };
    const leaning = (deg: number, z = 25) => ({
      point: { x: 0, y: 0, z },
      normal: {
        x: 0,
        y: Math.sin((deg * Math.PI) / 180),
        z: -cos(deg)
      }
    });

    it('keeps the parallel distance and reaches a leaning face up to the slant limit', () => {
      expect(toFaceReach(sketch, leaning(0))).toEqual({
        height: 25,
        slanted: false
      });
      expect(toFaceReach(sketch, leaning(30))).toEqual({
        height: 25,
        slanted: true
      });
      expect(toFaceReach(sketch, leaning(-80, -4))).toEqual({
        height: -4,
        slanted: true
      });
      expect(cos(84)).toBeGreaterThan(TO_FACE_SLANT_COSINE_LIMIT);
      expect(toFaceReach(sketch, leaning(88))).toBeNull();
      // Review: a slanted face whose middle sits level with the sketch is
      // still reachable; the build reads the way from the profile.
      expect(toFaceReach(sketch, leaning(30, 0))).toEqual({
        height: 0,
        slanted: true
      });
    });
  });

  describe('exact build', () => {
    it.each([10, -25, 40])(
      'ends a post on a face turned %s° (closed form)',
      async (deg) => {
        const result = await post(deg);
        const derived = await derive(result.document);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[result.bodyId]!;
        expect(body.volume).toBeCloseTo(AREA * 25, 6);
        expect(body.bbox.min.z).toBeCloseTo(0, 9);
        expect(body.bbox.max.z).toBeCloseTo(25 + 2 * Math.abs(tan(deg)), 6);
      }
    );

    it('stops short by an offset measured square to the face', async () => {
      const result = await post(30, { toFaceOffset: 3 });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        AREA * (25 - 3 / cos(30)),
        6
      );
    });

    it('runs from a start offset to the slanted face', async () => {
      const result = await post(20, { startOffset: 5 });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(AREA * 20, 6);
      expect(body.bbox.min.z).toBeCloseTo(5, 9);
    });

    it('reaches down to a slanted face below the sketch', async () => {
      const lifted = ceiling(project('Below'), -12, 15);
      // The ceiling's top face, 2 above its turned underside.
      const target = await face(lifted.document, lifted.bodyId, 1, 15);
      const sketched = addSketchFeature(lifted.document, {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [SQUARE]
      });
      const result = extrudeSketch(sketched.document, {
        name: 'Down',
        sketchId: sketched.sketchId,
        distance: 1,
        endCondition: 'to-face',
        toFace: target
      });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      // The top face passes 2 / cos(15°) above the pivot over the middle.
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        AREA * (12 - 2 / cos(15)),
        6
      );
    });

    it('cuts a pocket down to a slanted floor on another body', async () => {
      let document = addPrimitiveFeature(project('Floor'), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const blockId = document.bodyOrder.at(-1)!;
      // A slab whose turned top face passes through (10, 10, 4).
      const slab = ceiling(document, 2, 12);
      document = slab.document;
      const floor = await face(document, slab.bodyId, 1, 12);
      const sketched = addSketchFeature(document, {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
        objects: [SQUARE]
      });
      const cut = extrudeSketch(sketched.document, {
        name: 'Pocket',
        sketchId: sketched.sketchId,
        distance: -1,
        operation: 'cut',
        targetBodyId: blockId,
        endCondition: 'to-face',
        toFace: floor
      });
      const derived = await derive(cut.document);
      expect(derived.warnings).toEqual([]);
      // Turned about (10, 10, 2), the top face sits 2 / cos(12°) above it
      // over the middle; the pocket runs from z = 10 down to there.
      expect(derived.bodyRepresentations[cut.bodyId]!.volume).toBeCloseTo(
        20 * 20 * 10 - AREA * (10 - 2 - 2 / cos(12)),
        6
      );
    });

    it('drafts toward a slanted face, narrower than the straight post', async () => {
      const result = await post(10, { draftAngleDeg: 2 });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const volume = derived.bodyRepresentations[result.bodyId]!.volume;
      const t = tan(2);
      const area = (h: number) => (4 - 2 * h * t) ** 2;
      const lowest = 25 - 2 * tan(10);
      // Between the drafted post cut level at its lowest corner and the
      // straight one.
      expect(volume).toBeLessThan(AREA * 25);
      expect(volume).toBeGreaterThan(
        (lowest / 6) * (area(0) + 4 * area(lowest / 2) + area(lowest))
      );
    });

    it('reaches down to a face whose middle is level with the sketch, from a profile wholly above it (review)', async () => {
      // Turned 30° through (10, 10, 0): the plane is z = tan 30° (y − 10).
      // A square at y = 0–4 lies wholly above it, so the post runs down.
      const result = await post(30, {}, 0, 0, { centerY: 2 });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        AREA * tan(30) * 8,
        6
      );
    });

    it('reaches a slanted face with a flaring draft whose walls meet it past the profile (re-check)', async () => {
      // A face turned 30°: the outward 1.2° draft's walls meet it later than
      // the profile's own corners do. Bounded between the straight post and
      // the post flared to its highest corner.
      const result = await post(30, { draftAngleDeg: -1.2 });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const volume = derived.bodyRepresentations[result.bodyId]!.volume;
      expect(volume).toBeGreaterThan(AREA * 25);
      const t = tan(1.2);
      const top = 25 + 2 * tan(30) * 1.1;
      expect(volume).toBeLessThan((4 + 2 * top * t) ** 2 * top);
    });

    it('chooses the way for a round profile beside a level face middle, then the kernel refuses its elliptical section by name (re-check)', async () => {
      // Turned −30° through (10, 10, 0): the plane rises over y < 10, and a
      // circle there sits wholly under it. The way is no longer refused as
      // unclear; the exact split of a round wall by a slanted plane (an
      // ellipse) is not in the kernel yet, and says so.
      const result = await post(-30, {}, 0, 0, {
        objectKind: 'circle',
        centerX: 10,
        centerY: 3,
        radius: 1.5
      } as never);
      const warnings = (await derive(result.document)).warnings.join('\n');
      expect(warnings).not.toMatch(/unresolved|unclear/);
      expect(warnings).toMatch(
        /Feature "Post": Extrude "Post" could not be cut at the slanted face: .*ellipse/
      );
    });

    it('refuses a face that crosses the profile where it starts, by name', async () => {
      // Turned 80° through (10, 10, 1): the plane passes z = 0 inside the
      // square.
      const result = await post(80, {}, 1);
      const derived = await derive(result.document);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Feature "Post": Extrude "Post": the slanted face crosses the profile where the extrusion starts/
      );
    });

    it('follows the face as it turns, with nothing derived stored', async () => {
      const result = await post(10);
      const lift = listFeaturesInOrder(result.document).find(
        (feature) => feature.name === 'Lift'
      )!;
      const turned = updateFeature(result.document, {
        featureId: lift.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 30 },
            rotationDeg: { x: 35, y: 0, z: 0 },
            pivot: { x: 10, y: 10, z: 0 }
          }
        }
      });
      const derived = await derive(turned);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(AREA * 30, 6);
      expect(body.bbox.max.z).toBeCloseTo(30 + 2 * tan(35), 6);
      expect(listFeaturesInOrder(turned).at(-1)!.data).toMatchObject({
        distance: 1,
        endCondition: 'to-face'
      });
    });

    it('reads a face turned nearly square to the sketch as unresolved', async () => {
      const result = await post(87);
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      const derived = await derive(result.document);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Target face is unresolved: the face is nearly perpendicular/
      );
      expect(
        extrudeToFaceUnresolved(feature, derived.featureWarnings ?? [])
      ).toBe(true);
    });
  });

  describe('editor', () => {
    it('describes a slanted face as reachable and waits for the build on offsets', async () => {
      const result = await post(30);
      const built = attachDerivedState(
        result.document,
        await derive(result.document)
      );
      const feature = listFeaturesInOrder(built).at(-1)!;
      if (feature.data.featureKind !== 'extrude') throw new Error('extrude');
      const reach = toFaceReachEstimate(
        built,
        feature.data.sketchId,
        feature.data.toFace!
      );
      expect(reach?.slanted).toBe(true);
      expect(reach?.height).toBeGreaterThan(0);
      const ctx: ExtrudeDraftContext = {
        scope: {},
        units: 'mm',
        initial: { name: 'Post', sketchId: feature.data.sketchId, distance: 1 },
        bodies: [],
        toFacePicking: {
          armed: false,
          onPick: () => {},
          cancel: () => {},
          describe: () => ({
            label: 'Ceiling',
            distance: reach!.height,
            slanted: true
          }),
          setterRef: { current: null }
        }
      };
      const draft = {
        ...initialExtrudeDraft(ctx.initial, false),
        choice: { operation: 'new-body' as const },
        endCondition: 'to-face' as const,
        toFace: feature.data.toFace!
      };
      // Past the face's own point, but the build decides for a slanted face.
      expect(
        extrudeDraftRefusal({ ...draft, faceOffset: '40' }, ctx, true)
      ).toBeNull();
      expect(
        extrudeDraftRefusal({ ...draft, startOffset: '40' }, ctx, true)
      ).toBeNull();
    });
  });
});
