import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  attachDerivedState,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  extrudeToFaceUnresolved,
  listFeaturesInOrder,
  normalizeDocument,
  setParameter,
  toFaceSignedDistance,
  updateFeature
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type ExtrudeToFaceTarget,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';
import { affectedFeatureTargets } from '../apps/web/src/lib/affectedFeatureTargets';
import {
  extrudeEditCommand,
  extrudePreviewMagnitude
} from '../apps/web/src/lib/extrudeEditing';

/**
 * F01 (schema v29): extrude up to a face, and extrude draft.
 *
 * To-face derives its distance from a lineage-named planar face at the
 * feature's history position on every rebuild, and shows an explicit
 * unresolved state when the face goes away. Draft tapers the walls about the
 * sketch plane. Every volume below is a closed form, not a recorded value.
 */
const TAN5 = Math.tan((5 * Math.PI) / 180);

/** Prismatoid volume: exact whenever the section area is quadratic in height. */
function simpson(area: (height: number) => number, height: number): number {
  return (height / 6) * (area(0) + 4 * area(height / 2) + area(height));
}

/** A rectangle w × h tapered by `angle` per wall, `height` from its plane. */
function draftedBox(w: number, h: number, height: number, tangent: number) {
  return simpson((z) => (w - 2 * z * tangent) * (h - 2 * z * tangent), height);
}

function frustum(r1: number, r2: number, height: number): number {
  return ((Math.PI * height) / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
}

const SQUARE: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 10,
  centerY: 10
};

function project(name: string): ProjectDocument {
  return createProjectDocument(name, toUserId('user_to_face'));
}

function box(
  document: ProjectDocument,
  name: string,
  dimensions: { width: number; height: number; depth: number | string }
) {
  const next = addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions
  });
  return { document: next, bodyId: next.bodyOrder.at(-1)! };
}

function sketch(
  document: ProjectDocument,
  object: SketchObjectData = SQUARE,
  offset = 0
) {
  return addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset },
    objects: [object]
  });
}

describe('F01 to-face and draft', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function synced(document: ProjectDocument) {
    return attachDerivedState(document, await adapter.syncDocument(document));
  }

  /** The planar face of `bodyId` whose outward normal is `nz` along Z. */
  async function face(
    document: ProjectDocument,
    bodyId: BodyId,
    nz: 1 | -1
  ): Promise<ExtrudeToFaceTarget> {
    const built = await synced(document);
    const faces = built.derived.bodyRepresentations[bodyId]!.topology!.faces;
    const picked = faces.find(
      (candidate) => (candidate.geometry?.normal?.z ?? 0) * nz > 0.99
    )!;
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

  async function derive(document: ProjectDocument) {
    return adapter.syncDocument(document);
  }

  /** A 20 × 20 × 2 ceiling lifted so its underside sits at `z`. */
  function ceiling(document: ProjectDocument, z: number | string) {
    const made = box(document, 'Ceiling', {
      width: 20,
      height: 20,
      depth: 2
    });
    const moved = commandFactories.transformBody({
      name: 'Lift',
      targetBodyId: made.bodyId,
      translation: { x: 0, y: 0, z }
    });
    return { document: moved.apply(made.document), bodyId: made.bodyId };
  }

  describe('document contract', () => {
    it('stores the face and the angle, nothing derived, and pins schema v29', async () => {
      const lifted = ceiling(project('Contract'), 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      const result = extrudeSketch(sketched.document, {
        name: 'Post',
        sketchId: sketched.sketchId,
        distance: 1,
        endCondition: 'to-face',
        toFace: target,
        draftAngleDeg: 3
      });
      const data = listFeaturesInOrder(result.document).at(-1)!.data;
      expect(data).toMatchObject({
        featureKind: 'extrude',
        distance: 1,
        endCondition: 'to-face',
        draftAngleDeg: 3
      });
      expect(data).toHaveProperty('toFace.faceReference.kind', 'face');
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(29);
    });

    it('opens an older extrude and a v29 one exactly as written', async () => {
      const lifted = ceiling(project('Load'), 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      const legacy = extrudeSketch(sketched.document, {
        name: 'Legacy',
        sketchId: sketched.sketchId,
        distance: 5
      });
      const current = extrudeSketch(legacy.document, {
        name: 'Current',
        sketchId: sketched.sketchId,
        distance: 1,
        endCondition: 'to-face',
        toFace: target,
        draftAngleDeg: 'angle_param'
      });
      const saved = JSON.parse(
        JSON.stringify(current.document)
      ) as ProjectDocument;
      // Byte for byte: loading never rewrites a stored extrude.
      expect(JSON.stringify(normalizeDocument(saved))).toBe(
        JSON.stringify(saved)
      );
      const legacyData = listFeaturesInOrder(normalizeDocument(saved)).find(
        (feature) => feature.name === 'Legacy'
      )!.data;
      expect(legacyData).not.toHaveProperty('endCondition');
      expect(legacyData).not.toHaveProperty('draftAngleDeg');
    });

    it('writes neither field for a plain blind extrude, and drops a zero draft', () => {
      const sketched = sketch(project('Blind'));
      const plain = extrudeSketch(sketched.document, {
        name: 'Plain',
        sketchId: sketched.sketchId,
        distance: 5,
        draftAngleDeg: 0
      });
      const data = listFeaturesInOrder(plain.document).at(-1)!.data;
      expect(Object.keys(data).sort()).toEqual(
        ['distance', 'featureKind', 'sketchId'].sort()
      );
    });

    it.each([
      [{ endCondition: 'to-face' }, /planar face with a qualified lineage/],
      [{ toFace: 'TARGET' }, /Only an extrude to a face names a target face/],
      [
        { endCondition: 'to-face', toFace: 'TARGET', symmetric: true },
        /not symmetric or two-sided/
      ],
      [
        { endCondition: 'to-face', toFace: 'TARGET', backDistance: 2 },
        /not symmetric or two-sided/
      ],
      [
        {
          endCondition: 'to-face',
          toFace: 'TARGET',
          throughAllSide: 'forward'
        },
        /no through-all side/
      ],
      [{ draftAngleDeg: 90 }, /between -89 and 89/],
      [{ draftAngleDeg: Number.NaN }, /between -89 and 89/],
      [{ draftAngleDeg: 4, symmetric: true }, /one-sided extrusion/],
      [{ draftAngleDeg: 4, backDistance: 3 }, /one-sided extrusion/],
      [
        {
          draftAngleDeg: 4,
          operation: 'cut',
          targetBodyId: 'TARGET_BODY',
          endCondition: 'through-all',
          throughAllSide: 'forward'
        },
        /through-all cut has no draft/
      ]
    ])('refuses %o at entry', async (patch, message) => {
      const lifted = ceiling(project('Refusals'), 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      const input = Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [
          key,
          value === 'TARGET'
            ? target
            : value === 'TARGET_BODY'
              ? lifted.bodyId
              : value
        ])
      );
      expect(() =>
        extrudeSketch(sketched.document, {
          name: 'Bad',
          sketchId: sketched.sketchId,
          distance: 2,
          ...input
        })
      ).toThrow(message);
    });

    it('refuses a target face on a body made later in history', async () => {
      const sketched = sketch(project('Order'));
      const blind = extrudeSketch(sketched.document, {
        name: 'Early',
        sketchId: sketched.sketchId,
        distance: 5
      });
      const lifted = ceiling(blind.document, 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const early = listFeaturesInOrder(lifted.document).find(
        (feature) => feature.name === 'Early'
      )!;
      expect(() =>
        commandFactories
          .updateFeature({
            featureId: early.featureId,
            data: { endCondition: 'to-face', toFace: target }
          })
          .validate(lifted.document)
      ).toThrow(/would run before the body it uses exists/);
    });

    it('takes a resolved-zero back distance as one-sided for to-face', async () => {
      const lifted = ceiling(project('Zero back'), 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      const result = extrudeSketch(sketched.document, {
        name: 'Post',
        sketchId: sketched.sketchId,
        distance: 1,
        backDistance: '0 mm',
        endCondition: 'to-face',
        toFace: target
      });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        400,
        6
      );
    });

    it('switches back to blind by clearing the extent, through one undoable edit', async () => {
      const lifted = ceiling(project('Switch'), 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      const result = extrudeSketch(sketched.document, {
        name: 'Post',
        sketchId: sketched.sketchId,
        distance: 7,
        endCondition: 'to-face',
        toFace: target
      });
      const featureId = listFeaturesInOrder(result.document).at(-1)!.featureId;
      const manager = new CommandManager(result.document);
      manager.execute(
        commandFactories.updateFeature({
          featureId,
          clearData: ['endCondition', 'toFace']
        })
      );
      const data = listFeaturesInOrder(manager.document).at(-1)!.data;
      expect(data).not.toHaveProperty('toFace');
      expect(data).toMatchObject({ distance: 7 });
      manager.undo();
      expect(listFeaturesInOrder(manager.document).at(-1)!.data).toMatchObject({
        endCondition: 'to-face'
      });
      // A face left behind with a blind extent is refused.
      expect(() =>
        updateFeature(result.document, {
          featureId,
          clearData: ['endCondition']
        })
      ).toThrow(/Only an extrude to a face names a target face/);
    });
  });

  describe('shared to-face reach test', () => {
    it('refuses a 0.05° tilt and a face on the sketch plane, as the build does', () => {
      const sketchPlane = {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 }
      };
      const tilt = (0.05 * Math.PI) / 180;
      expect(
        toFaceSignedDistance(sketchPlane, {
          point: { x: 0, y: 0, z: 25 },
          normal: { x: 0, y: Math.sin(tilt), z: -Math.cos(tilt) }
        })
      ).toBeNull();
      expect(
        toFaceSignedDistance(sketchPlane, {
          point: { x: 3, y: 4, z: 0 },
          normal: { x: 0, y: 0, z: 1 }
        })
      ).toBeNull();
      expect(
        toFaceSignedDistance(sketchPlane, {
          point: { x: 3, y: 4, z: -12 },
          normal: { x: 0, y: 0, z: 1 }
        })
      ).toBe(-12);
    });
  });

  describe('extrude edit command', () => {
    it('switches an extent and a draft without leaving a stale field behind', async () => {
      const lifted = ceiling(project('Edit'), 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      const result = extrudeSketch(sketched.document, {
        name: 'Post',
        sketchId: sketched.sketchId,
        distance: 25,
        endCondition: 'to-face',
        toFace: target,
        draftAngleDeg: 2
      });
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      const value = {
        name: 'Post',
        sketchId: sketched.sketchId,
        distance: 25,
        symmetric: false,
        backDistance: 0,
        choice: { operation: 'new-body' as const }
      };
      const blind = extrudeEditCommand(feature, {
        ...value,
        endCondition: 'blind'
      }).apply(result.document);
      const data = listFeaturesInOrder(blind).at(-1)!.data;
      expect(data).not.toHaveProperty('endCondition');
      expect(data).not.toHaveProperty('toFace');
      expect(data).not.toHaveProperty('draftAngleDeg');
      const back = extrudeEditCommand(listFeaturesInOrder(blind).at(-1)!, {
        ...value,
        endCondition: 'to-face',
        toFace: target,
        draftAngleDeg: 4
      }).apply(blind);
      expect(listFeaturesInOrder(back).at(-1)!.data).toMatchObject({
        endCondition: 'to-face',
        draftAngleDeg: 4
      });
      expect(() =>
        extrudeEditCommand(feature, { ...value, endCondition: 'to-face' })
      ).toThrow(/Pick the face/);
      expect(
        extrudePreviewMagnitude(
          { distance: 'gone', endCondition: 'to-face' },
          () => {
            throw new Error('dormant');
          }
        )
      ).toBe(1);
    });
  });

  describe('to-face exact build', () => {
    async function post(z: number | string = 25, draftAngleDeg?: number) {
      const lifted = ceiling(project('To face'), z);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      return {
        ...extrudeSketch(sketched.document, {
          name: 'Post',
          sketchId: sketched.sketchId,
          distance: 1,
          endCondition: 'to-face',
          toFace: target,
          ...(draftAngleDeg === undefined ? {} : { draftAngleDeg })
        }),
        ceilingId: lifted.bodyId
      };
    }

    it('extrudes a new body from the sketch plane to the face, not the dormant distance', async () => {
      const result = await post(25);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(4 * 4 * 25, 6);
      expect(body.bbox.max.z).toBeCloseTo(25, 9);
    });

    it('follows the face when its body moves, with no stored depth', async () => {
      const result = await post(25);
      const lift = listFeaturesInOrder(result.document).find(
        (feature) => feature.name === 'Lift'
      )!;
      const moved = updateFeature(result.document, {
        featureId: lift.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 40 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        }
      });
      const derived = await derive(moved);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        4 * 4 * 40,
        6
      );
      // The stored feature still holds only the dormant distance.
      expect(listFeaturesInOrder(moved).at(-1)!.data).toMatchObject({
        distance: 1
      });
    });

    it('extrudes backward to a face below the sketch plane', async () => {
      const lifted = ceiling(project('Below'), -12);
      // The ceiling's top face sits at z = -10.
      const target = await face(lifted.document, lifted.bodyId, 1);
      const sketched = sketch(lifted.document);
      const result = extrudeSketch(sketched.document, {
        name: 'Down',
        sketchId: sketched.sketchId,
        distance: 1,
        endCondition: 'to-face',
        toFace: target
      });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(4 * 4 * 10, 6);
      expect(body.bbox.min.z).toBeCloseTo(-10, 9);
    });

    it('cuts a pocket from the top down to the floor face of the same block', async () => {
      let document = project('Pocket');
      const block = box(document, 'Block', {
        width: 20,
        height: 20,
        depth: 10
      });
      document = block.document;
      const shelf = box(document, 'Shelf', {
        width: 30,
        height: 30,
        depth: 1
      });
      const lowered = commandFactories.transformBody({
        name: 'Lower',
        targetBodyId: shelf.bodyId,
        translation: { x: -5, y: -5, z: 3 }
      });
      document = lowered.apply(shelf.document);
      // The shelf's top face (z = 4) is the floor the pocket stops on.
      const floor = await face(document, shelf.bodyId, 1);
      const sketched = sketch(document, SQUARE, 10);
      const result = extrudeSketch(sketched.document, {
        name: 'Pocket',
        sketchId: sketched.sketchId,
        distance: -1,
        operation: 'cut',
        targetBodyId: block.bodyId,
        endCondition: 'to-face',
        toFace: floor
      });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        20 * 20 * 10 - 4 * 4 * 6,
        6
      );
    });

    it('shows an explicit unresolved state when the face goes away, and a re-pick repairs it', async () => {
      // A roof beside the ceiling, made before the post, to re-pick onto.
      let document = project('Repair');
      const roof = box(document, 'Roof', { width: 6, height: 6, depth: 1 });
      document = commandFactories
        .transformBody({
          name: 'Raise roof',
          targetBodyId: roof.bodyId,
          translation: { x: 7, y: 7, z: 18 }
        })
        .apply(roof.document);
      const lifted = ceiling(document, 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      const result = extrudeSketch(sketched.document, {
        name: 'Post',
        sketchId: sketched.sketchId,
        distance: 1,
        endCondition: 'to-face',
        toFace: target
      });
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      const ceilingFeature = listFeaturesInOrder(result.document).find(
        (candidate) => candidate.name === 'Ceiling'
      )!;
      // Delete the ceiling: the face the post reaches is gone.
      const broken = deleteFeature(result.document, {
        featureId: ceilingFeature.featureId
      });
      const derived = await derive(broken);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Feature "Post": Target face is unresolved: the body that carried the face was deleted/
      );
      expect(extrudeToFaceUnresolved(feature, derived.warnings)).toBe(true);
      expect(extrudeToFaceUnresolved(feature, [])).toBe(false);

      // Re-pick the roof's underside: one undoable edit resolves the post.
      const repaired = await face(broken, roof.bodyId, -1);
      const manager = new CommandManager(broken);
      manager.execute(
        commandFactories.updateFeature({
          featureId: feature.featureId,
          data: { toFace: repaired }
        })
      );
      const fixed = await derive(manager.document);
      expect(fixed.warnings.filter((w) => w.includes('"Post"'))).toEqual([]);
      expect(fixed.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        4 * 4 * 18,
        6
      );
      manager.undo();
      expect(listFeaturesInOrder(manager.document).at(-1)!.data).toHaveProperty(
        'toFace.bodyId',
        lifted.bodyId
      );
    });

    it('names the to-face extrude among the features an upstream edit affects', async () => {
      const result = await post(25);
      const lift = listFeaturesInOrder(result.document).find(
        (feature) => feature.name === 'Lift'
      )!;
      expect(
        affectedFeatureTargets(result.document, lift.featureId).map(
          (target) => target.featureName
        )
      ).toContain('Post');
    });

    it('refuses as unresolved when the face is no longer parallel', async () => {
      const result = await post(25);
      const lift = listFeaturesInOrder(result.document).find(
        (feature) => feature.name === 'Lift'
      )!;
      const tilted = updateFeature(result.document, {
        featureId: lift.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 25 },
            rotationDeg: { x: 10, y: 0, z: 0 }
          }
        }
      });
      const derived = await derive(tilted);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Feature "Post": Target face is unresolved: the face is no longer parallel/
      );
      // Tilting it back resolves the same stored face again.
      const level = updateFeature(tilted, {
        featureId: lift.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 25 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        }
      });
      const again = await derive(level);
      expect(again.warnings).toEqual([]);
      expect(again.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        400,
        6
      );
    });

    it('drafts a to-face extrusion over the derived distance', async () => {
      const result = await post(25, 2);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        draftedBox(4, 4, 25, Math.tan((2 * Math.PI) / 180)),
        6
      );
    });
  });

  describe('draft exact build', () => {
    async function drafted(
      object: SketchObjectData,
      distance: number,
      draftAngleDeg: number | string
    ) {
      const sketched = sketch(project('Draft'), object);
      const result = extrudeSketch(sketched.document, {
        name: 'Boss',
        sketchId: sketched.sketchId,
        distance,
        draftAngleDeg
      });
      const derived = await derive(result.document);
      return { derived, body: derived.bodyRepresentations[result.bodyId] };
    }

    const RECT: SketchObjectData = {
      objectKind: 'rectangle',
      width: 20,
      height: 12,
      centerX: 0,
      centerY: 0
    };

    it('tapers a rectangle inward by a positive angle (closed-form prismatoid)', async () => {
      const { derived, body } = await drafted(RECT, 10, 5);
      expect(derived.warnings).toEqual([]);
      expect(body!.volume).toBeCloseTo(draftedBox(20, 12, 10, TAN5), 6);
      // The profile is the neutral section: the base keeps its size.
      expect(body!.bbox.max.x - body!.bbox.min.x).toBeCloseTo(20, 9);
      expect(body!.faceCount).toBe(6);
    });

    it('narrows the cap of a 5 mm draft to 20 - 10 tan 5° = 19.1251', async () => {
      const { body } = await drafted(RECT, 5, 5);
      const cap = body!.topology!.faces.find(
        (candidate) => (candidate.geometry?.normal?.z ?? 0) > 0.99
      )!;
      expect(cap.geometry!.area).toBeCloseTo(
        (20 - 10 * TAN5) * (12 - 10 * TAN5),
        6
      );
      expect(20 - 10 * TAN5).toBeCloseTo(19.1251, 4);
    });

    it('flares outward for a negative angle', async () => {
      const { derived, body } = await drafted(RECT, 10, -5);
      expect(derived.warnings).toEqual([]);
      expect(body!.volume).toBeCloseTo(draftedBox(20, 12, 10, -TAN5), 6);
    });

    it('tapers away from the sketch plane for a reversed extrusion too', async () => {
      const { derived, body } = await drafted(RECT, -10, 5);
      expect(derived.warnings).toEqual([]);
      expect(body!.volume).toBeCloseTo(draftedBox(20, 12, 10, TAN5), 6);
      expect(body!.bbox.min.z).toBeCloseTo(-10, 9);
    });

    it('turns a circle into an exact cone frustum', async () => {
      const { derived, body } = await drafted(
        {
          objectKind: 'circle',
          radius: 5,
          centerX: 3,
          centerY: -2
        },
        10,
        5
      );
      expect(derived.warnings).toEqual([]);
      expect(body!.volume).toBeCloseTo(frustum(5, 5 - 10 * TAN5, 10), 6);
      expect(
        body!.topology!.faces.map((face) => face.geometry?.surfaceType).sort()
      ).toEqual(['cone', 'plane', 'plane']);
    });

    it('resolves a draft expression', async () => {
      const { derived, body } = await drafted(RECT, 10, '10 / 2');
      expect(derived.warnings).toEqual([]);
      expect(body!.volume).toBeCloseTo(draftedBox(20, 12, 10, TAN5), 6);
    });

    it('refuses a taper that closes the profile up, by name', async () => {
      const { derived, body } = await drafted(RECT, 100, 30);
      expect(body).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Feature "Boss": Extrude "Boss".*(closes up|not a valid closed solid|could not be drafted)/
      );
    });

    it('cuts a drafted pocket into a block', async () => {
      let document = project('Drafted pocket');
      const block = box(document, 'Block', {
        width: 40,
        height: 40,
        depth: 10
      });
      document = block.document;
      const sketched = sketch(
        document,
        { ...RECT, centerX: 20, centerY: 20 },
        10
      );
      const result = extrudeSketch(sketched.document, {
        name: 'Pocket',
        sketchId: sketched.sketchId,
        distance: -6,
        operation: 'cut',
        targetBodyId: block.bodyId,
        draftAngleDeg: 5
      });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        40 * 40 * 10 - draftedBox(20, 12, 6, TAN5),
        6
      );
    });

    it('reads a resolved zero as the one-sided default, at entry and on rebuild', async () => {
      let document = setParameter(project('Zeroes'), {
        name: 'taper',
        expression: '0'
      });
      const sketched = sketch(document, RECT);
      document = sketched.document;
      // A unit-bearing zero back distance does not make it two-sided.
      const unit = extrudeSketch(document, {
        name: 'Unit zero',
        sketchId: sketched.sketchId,
        distance: 10,
        backDistance: '0 mm',
        draftAngleDeg: 5
      });
      const derived = await derive(unit.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[unit.bodyId]!.volume).toBeCloseTo(
        draftedBox(20, 12, 10, TAN5),
        6
      );
      // A draft parameter at 0 beside a symmetric extrusion is accepted...
      const parametric = extrudeSketch(document, {
        name: 'Taper',
        sketchId: sketched.sketchId,
        distance: 10,
        symmetric: true,
        draftAngleDeg: 'taper'
      });
      expect(
        (await derive(parametric.document)).bodyRepresentations[
          parametric.bodyId
        ]!.volume
      ).toBeCloseTo(2400, 6);
      // ...and refused by name once the parameter leaves 0.
      const tapered = setParameter(parametric.document, {
        name: 'taper',
        expression: '3'
      });
      const refused = await derive(tapered);
      expect(refused.bodyRepresentations[parametric.bodyId]).toBeUndefined();
      expect(refused.warnings.join('\n')).toMatch(
        /Feature "Taper": Draft applies to a one-sided extrusion/
      );
    });

    it('rebuilds a straight extrude unchanged when the draft is cleared', async () => {
      const sketched = sketch(project('Clear draft'), RECT);
      const result = extrudeSketch(sketched.document, {
        name: 'Boss',
        sketchId: sketched.sketchId,
        distance: 10,
        draftAngleDeg: 5
      });
      const featureId = listFeaturesInOrder(result.document).at(-1)!.featureId;
      const cleared = updateFeature(result.document, {
        featureId,
        clearData: ['draftAngleDeg']
      });
      const derived = await derive(cleared);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        2400,
        9
      );
    });
  });
});
