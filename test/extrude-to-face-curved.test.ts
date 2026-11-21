import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@openzcad/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  extrudeToFaceUnresolved,
  listFeaturesInOrder,
  normalizeDocument,
  updateFeature
} from '@openzcad/document-core';
import { commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ExtrudeToSurfaceTarget,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * F01 (schema v131): extrude up to a curved face.
 *
 * The target is a cylinder of radius 10, 40 long, lying along Y with its
 * axis at x = 0, z = 30 (y from −20 to 20). A 4 × 4 profile centred under
 * the axis grows up to the cylinder's underside, z = 30 − √(100 − x²); its
 * volume is the closed form 4 · (4 · 30 − ∫₋₂² √(100 − x²) dx).
 */
const SQUARE: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 0,
  centerY: 0
};

/** ∫ √(r² − x²) dx from −h to h. */
function chordArea(r: number, h: number): number {
  return h * Math.sqrt(r * r - h * h) + r * r * Math.asin(h / r);
}

/** The post under (or, `inside`, within) a cylinder of radius `r` at z = `zc`. */
function underside(zc: number, r: number, bottom = 0): number {
  return 4 * (4 * (zc - bottom) - chordArea(r, 2));
}

function project(name: string): ProjectDocument {
  return createProjectDocument(name, toUserId('user_curved_face'));
}

/**
 * The cylinder lying along Y with its axis at height `z`, first spun `spin`
 * degrees about its own axis (which moves only its seam).
 */
function log(document: ProjectDocument, z = 30, spin = 0) {
  let made = addPrimitiveFeature(document, {
    name: 'Log',
    primitiveKind: 'cylinder',
    dimensions: { radius: 10, height: 40 }
  });
  const bodyId = made.bodyOrder.at(-1)!;
  if (spin !== 0) {
    made = commandFactories
      .transformBody({
        name: 'Spin',
        targetBodyId: bodyId,
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: spin },
        pivot: { x: 0, y: 0, z: 0 }
      })
      .apply(made);
  }
  const laid = commandFactories
    .transformBody({
      name: 'Lay',
      targetBodyId: bodyId,
      translation: { x: 0, y: 0, z: z - 20 },
      rotationDeg: { x: 90, y: 0, z: 0 },
      pivot: { x: 0, y: 0, z: 20 }
    })
    .apply(made);
  return { document: laid, bodyId };
}

describe('F01 to a curved face', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function derive(document: ProjectDocument) {
    return adapter.syncDocument(document);
  }

  async function wall(
    document: ProjectDocument,
    bodyId: BodyId
  ): Promise<ExtrudeToSurfaceTarget> {
    const derived = await derive(document);
    const face = derived.bodyRepresentations[bodyId]!.topology!.faces.find(
      (candidate) => candidate.geometry?.surfaceType === 'cylinder'
    )!;
    return {
      type: 'surface',
      bodyId,
      faceReference: face.reference!,
      sourceCentroid: face.geometry!.centroid ?? face.geometry!.center
    };
  }

  async function post(
    patch: Record<string, unknown> = {},
    sketchZ = 0,
    profile = SQUARE,
    spin = 0
  ) {
    const laid = log(project('Curved'), 30, spin);
    const target = await wall(laid.document, laid.bodyId);
    const sketched = addSketchFeature(laid.document, {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: sketchZ },
      objects: [profile]
    });
    const result = extrudeSketch(sketched.document, {
      name: 'Post',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'to-face',
      toSurface: target,
      ...patch
    });
    return { ...result, target, laid, sketched };
  }

  describe('document contract', () => {
    it('stores the curved face beside the extent, at the current schema, byte for byte', async () => {
      const result = await post();
      const data = listFeaturesInOrder(result.document).at(-1)!.data;
      expect(data).toMatchObject({
        endCondition: 'to-face',
        toSurface: { type: 'surface', bodyId: result.laid.bodyId }
      });
      expect(data).not.toHaveProperty('toFace');
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(131);
      const saved = JSON.parse(
        JSON.stringify(result.document)
      ) as ProjectDocument;
      expect(JSON.stringify(normalizeDocument(saved))).toBe(
        JSON.stringify(saved)
      );
    });

    it('refuses a curved face without the extent, a bad one, or both kinds at once', async () => {
      const result = await post();
      const sketchId = result.sketched.sketchId;
      expect(() =>
        extrudeSketch(result.sketched.document, {
          name: 'Bad',
          sketchId,
          distance: 1,
          toSurface: result.target
        })
      ).toThrow(/Only an extrude to a face names a target face/);
      expect(() =>
        extrudeSketch(result.sketched.document, {
          name: 'Bad',
          sketchId,
          distance: 1,
          endCondition: 'to-face',
          toSurface: { ...result.target, faceReference: undefined } as never
        })
      ).toThrow(/qualified lineage reference/);
      expect(() =>
        extrudeSketch(result.sketched.document, {
          name: 'Bad',
          sketchId,
          distance: 1,
          endCondition: 'to-face',
          toSurface: result.target,
          toFace: { type: 'face' } as never
        })
      ).toThrow(/a planar face or a curved one, not both/);
    });
  });

  describe('exact build', () => {
    it('ends a post on the cylinder from outside (closed form)', async () => {
      const result = await post();
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(underside(30, 10), 5);
      expect(body.bbox.min.z).toBeCloseTo(0, 9);
      expect(body.bbox.max.z).toBeCloseTo(30 - Math.sqrt(96), 6);
    });

    it('stops short by an offset from the cylinder, and starts from a start offset', async () => {
      const short = await post({ toFaceOffset: 2 });
      let derived = await derive(short.document);
      expect(derived.warnings).toEqual([]);
      // 2 short of the wall: the cylinder grows to radius 12.
      expect(derived.bodyRepresentations[short.bodyId]!.volume).toBeCloseTo(
        underside(30, 12),
        5
      );
      const started = await post({ startOffset: 5 });
      derived = await derive(started.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[started.bodyId]!.volume).toBeCloseTo(
        underside(30, 10, 5),
        5
      );
    });

    it('reaches the wall from inside the cylinder', async () => {
      // Sketched on the axis plane z = 30, inside the log, growing up.
      const result = await post({}, 30);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      // Up to z = 30 + √(100 − x²): the chord area over the 4-wide square.
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        4 * chordArea(10, 2),
        5
      );
    });

    describe('review', () => {
      it('refuses a profile that straddles the cylinder from inside', async () => {
        const result = await post({}, 30, { ...SQUARE, centerX: 9 });
        const derived = await derive(result.document);
        expect(derived.warnings.join('\n')).toMatch(
          /part of the profile starts outside the curved face's cylinder/
        );
      });

      it('takes the way from the stored sign inside, whatever the seam', async () => {
        for (const spin of [0, 60, 150]) {
          const result = await post({ distance: -1 }, 30, SQUARE, spin);
          const derived = await derive(result.document);
          expect(derived.warnings).toEqual([]);
          const body = derived.bodyRepresentations[result.bodyId]!;
          expect(body.volume).toBeCloseTo(4 * chordArea(10, 2), 5);
          expect(body.bbox.max.z).toBeCloseTo(30, 9);
        }
      });

      it('reaches a wall moved outward by a negative offset from inside', async () => {
        const result = await post({ toFaceOffset: -2 }, 30);
        const derived = await derive(result.document);
        expect(derived.warnings).toEqual([]);
        expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
          4 * chordArea(12, 2),
          5
        );
      });

      it('validates the curved target body at command entry', async () => {
        const result = await post();
        const command = commandFactories.extrudeSketch({
          name: 'Ghost',
          sketchId: result.sketched.sketchId,
          distance: 1,
          endCondition: 'to-face',
          toSurface: { ...result.target, bodyId: 'body_missing' as BodyId }
        });
        expect(() => command.validate(result.document)).toThrow(
          /The target face's body body_missing does not exist/
        );
      });
    });

    it('follows the cylinder as it moves, with nothing derived stored', async () => {
      const result = await post();
      const lay = listFeaturesInOrder(result.document).find(
        (feature) => feature.name === 'Lay'
      )!;
      const raised = updateFeature(result.document, {
        featureId: lay.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 20 },
            rotationDeg: { x: 90, y: 0, z: 0 },
            pivot: { x: 0, y: 0, z: 20 }
          }
        }
      });
      const derived = await derive(raised);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        underside(40, 10),
        5
      );
      expect(listFeaturesInOrder(raised).at(-1)!.data).toMatchObject({
        distance: 1
      });
    });

    it('refuses a profile that passes the cylinder by, by name', async () => {
      const result = await post({}, 0, { ...SQUARE, centerX: 12 });
      const derived = await derive(result.document);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Feature "Post": Extrude "Post" does not meet the curved face everywhere/
      );
    });

    it('reads a deleted cylinder as unresolved', async () => {
      const result = await post();
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      const log = listFeaturesInOrder(result.document).find(
        (candidate) => candidate.name === 'Log'
      )!;
      const broken = deleteFeature(result.document, {
        featureId: log.featureId
      });
      const derived = await derive(broken);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Feature "Post": Target face is unresolved/
      );
      expect(
        extrudeToFaceUnresolved(feature, derived.featureWarnings ?? [])
      ).toBe(true);
    });

    it('cuts a cradle into a block down to the cylinder', async () => {
      const laid = log(project('Cradle'), 30);
      const target = await wall(laid.document, laid.bodyId);
      let document = addPrimitiveFeature(laid.document, {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 4, height: 4, depth: 25 }
      });
      const blockId = document.bodyOrder.at(-1)!;
      document = commandFactories
        .transformBody({
          name: 'Place',
          targetBodyId: blockId,
          translation: { x: -2, y: -2, z: 0 }
        })
        .apply(document);
      const sketched = addSketchFeature(document, {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [SQUARE]
      });
      // Cut from the bottom up to the cylinder's underside: what is left of
      // the 4 × 4 × 25 block is its top, above the curve.
      const cut = extrudeSketch(sketched.document, {
        name: 'Cradle',
        sketchId: sketched.sketchId,
        distance: 1,
        operation: 'cut',
        targetBodyId: blockId,
        endCondition: 'to-face',
        toSurface: target
      });
      const derived = await derive(cut.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[cut.bodyId]!.volume).toBeCloseTo(
        4 * 4 * 25 - underside(30, 10),
        5
      );
    });
  });
});
