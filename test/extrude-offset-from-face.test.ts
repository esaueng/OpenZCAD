import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@openzcad/shared';
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
  renameParameter,
  setParameter,
  toFaceOffsetEnd,
  updateFeature
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
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
import {
  extrudeEditCommand,
  extrudeEditInitial
} from '../apps/web/src/lib/extrudeEditing';
import {
  extrudeDraftRefusal,
  extrudeDraftValue,
  initialExtrudeDraft,
  type ExtrudeDraftContext
} from '../apps/web/src/lib/extrudeDraft';
import { extrudeShownValues } from '../apps/web/src/lib/extrudeShownValues';
import { featureValueSummary } from '../apps/web/src/lib/featureSummary';

/**
 * F01 (schema v113): extrude to a face with an offset from it.
 *
 * `toFaceOffset` rides on a to-face extrude: positive stops short of the
 * face, negative passes it. It is applied on every rebuild to the distance
 * the face resolves to there, so moving the face moves the end, and nothing
 * derived is stored. Every volume below is a closed form: a 4 × 4 square
 * profile swept from the sketch plane to the face, less the offset.
 */
const SQUARE: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 10,
  centerY: 10
};
const AREA = 16;

function project(name: string): ProjectDocument {
  return createProjectDocument(name, toUserId('user_offset_face'));
}

function sketch(document: ProjectDocument, offset = 0) {
  return addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset },
    objects: [SQUARE]
  });
}

/** A 20 × 20 × 2 ceiling lifted so its underside sits at `z`. */
function ceiling(document: ProjectDocument, z: number) {
  const made = addPrimitiveFeature(document, {
    name: 'Ceiling',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 2 }
  });
  const bodyId = made.bodyOrder.at(-1)!;
  const moved = commandFactories.transformBody({
    name: 'Lift',
    targetBodyId: bodyId,
    translation: { x: 0, y: 0, z }
  });
  return { document: moved.apply(made), bodyId };
}

describe('F01 offset from face', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function derive(document: ProjectDocument) {
    return adapter.syncDocument(document);
  }

  /** The planar face of `bodyId` whose outward normal is `nz` along Z. */
  async function face(
    document: ProjectDocument,
    bodyId: BodyId,
    nz: 1 | -1
  ): Promise<ExtrudeToFaceTarget> {
    const built = attachDerivedState(document, await derive(document));
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

  /** A post from z = 0 up to the ceiling's underside at `z`, offset. */
  async function post(
    toFaceOffset: number | string | undefined,
    z = 25,
    document = project('Post')
  ) {
    const lifted = ceiling(document, z);
    const target = await face(lifted.document, lifted.bodyId, -1);
    const sketched = sketch(lifted.document);
    const result = extrudeSketch(sketched.document, {
      name: 'Post',
      sketchId: sketched.sketchId,
      distance: 1,
      endCondition: 'to-face',
      toFace: target,
      ...(toFaceOffset === undefined ? {} : { toFaceOffset })
    });
    return { ...result, target, ceilingId: lifted.bodyId, sketched };
  }

  describe('shared end rule', () => {
    it('stops short for a positive offset and passes for a negative one, on either side', () => {
      expect(toFaceOffsetEnd(25, 5)).toBe(20);
      expect(toFaceOffsetEnd(25, -3)).toBe(28);
      expect(toFaceOffsetEnd(-13, 3)).toBe(-10);
      expect(toFaceOffsetEnd(-13, -2)).toBe(-15);
      // Reaching or crossing the sketch plane extrudes nothing (or the
      // wrong way), so it has no end.
      expect(toFaceOffsetEnd(25, 25)).toBeNull();
      expect(toFaceOffsetEnd(25, 30)).toBeNull();
      expect(toFaceOffsetEnd(-13, 14)).toBeNull();
      expect(toFaceOffsetEnd(25, Number.NaN)).toBeNull();
    });
  });

  describe('document contract', () => {
    it('stores the offset beside the face, nothing derived, and pins the current schema (v113)', async () => {
      const result = await post(5);
      const data = listFeaturesInOrder(result.document).at(-1)!.data;
      expect(data).toMatchObject({
        featureKind: 'extrude',
        distance: 1,
        endCondition: 'to-face',
        toFaceOffset: 5
      });
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(113);
      expect(result.document.schemaVersion).toBe(
        PROJECT_DOCUMENT_SCHEMA_VERSION
      );
    });

    it('drops a zero offset, and opens a to-face extrude without one byte for byte', async () => {
      const zero = await post(0);
      expect(
        listFeaturesInOrder(zero.document).at(-1)!.data
      ).not.toHaveProperty('toFaceOffset');
      // A to-face extrude with no offset (the v29 shape) loads unchanged and
      // gains no offset field; one with an offset keeps it as written.
      for (const toFaceOffset of [undefined, 'gap']) {
        const saved = JSON.parse(
          JSON.stringify((await post(toFaceOffset)).document)
        ) as ProjectDocument;
        const loaded = normalizeDocument(saved);
        expect(JSON.stringify(loaded)).toBe(JSON.stringify(saved));
        const data = listFeaturesInOrder(loaded).at(-1)!.data;
        if (toFaceOffset === undefined) {
          expect(data).not.toHaveProperty('toFaceOffset');
        } else {
          expect(data).toMatchObject({ toFaceOffset });
        }
      }
    });

    it.each([
      [{ toFaceOffset: 2 }, /Only an extrude to a face has an offset/],
      [
        { endCondition: 'to-face', toFace: 'TARGET', toFaceOffset: Infinity },
        /finite length/
      ],
      [
        { endCondition: 'to-face', toFace: 'TARGET', toFaceOffset: '  ' },
        /number or an expression/
      ]
    ])('refuses %o at entry', async (patch, message) => {
      const lifted = ceiling(project('Refusals'), 25);
      const target = await face(lifted.document, lifted.bodyId, -1);
      const sketched = sketch(lifted.document);
      const input = Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [
          key,
          value === 'TARGET' ? target : value
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

    it('refuses clearing the extent while an offset stays behind', async () => {
      const result = await post(5);
      const featureId = listFeaturesInOrder(result.document).at(-1)!.featureId;
      expect(() =>
        updateFeature(result.document, {
          featureId,
          clearData: ['endCondition', 'toFace']
        })
      ).toThrow(/Only an extrude to a face has an offset/);
      const blind = updateFeature(result.document, {
        featureId,
        clearData: ['endCondition', 'toFace', 'toFaceOffset']
      });
      expect(listFeaturesInOrder(blind).at(-1)!.data).not.toHaveProperty(
        'toFaceOffset'
      );
    });

    it('rewrites an offset expression when its parameter is renamed', async () => {
      const result = await post(
        'gap',
        25,
        setParameter(project('Rename'), { name: 'gap', expression: '5' })
      );
      const renamed = renameParameter(result.document, {
        name: 'gap',
        newName: 'clearance'
      });
      expect(listFeaturesInOrder(renamed).at(-1)!.data).toMatchObject({
        toFaceOffset: 'clearance'
      });
    });
  });

  describe('exact build', () => {
    it('stops short of the face by a positive offset', async () => {
      const result = await post(5);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(AREA * 20, 6);
      expect(body.bbox.max.z).toBeCloseTo(20, 9);
    });

    it('passes the face by a negative offset', async () => {
      const result = await post(-3);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(AREA * 28, 6);
      expect(body.bbox.max.z).toBeCloseTo(28, 9);
    });

    it('offsets toward the sketch plane for a face below it', async () => {
      const lifted = ceiling(project('Below'), -12);
      // The ceiling's top face sits at z = -10.
      const target = await face(lifted.document, lifted.bodyId, 1);
      const sketched = sketch(lifted.document);
      const result = extrudeSketch(sketched.document, {
        name: 'Down',
        sketchId: sketched.sketchId,
        distance: 1,
        endCondition: 'to-face',
        toFace: target,
        toFaceOffset: 4
      });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(AREA * 6, 6);
      expect(body.bbox.min.z).toBeCloseTo(-6, 9);
      expect(body.bbox.max.z).toBeCloseTo(0, 9);
    });

    it('follows a parameter offset and a moved face, with no stored depth', async () => {
      const result = await post(
        'gap',
        25,
        setParameter(project('Moving'), { name: 'gap', expression: '5' })
      );
      const widened = setParameter(result.document, {
        name: 'gap',
        expression: '10'
      });
      let derived = await derive(widened);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        AREA * 15,
        6
      );
      const lift = listFeaturesInOrder(widened).find(
        (feature) => feature.name === 'Lift'
      )!;
      const moved = updateFeature(widened, {
        featureId: lift.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 40 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        }
      });
      derived = await derive(moved);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        AREA * 30,
        6
      );
      expect(listFeaturesInOrder(moved).at(-1)!.data).toMatchObject({
        distance: 1,
        toFaceOffset: 'gap'
      });
    });

    it('refuses an offset that reaches the sketch plane by name, not as an unresolved face', async () => {
      const result = await post(25);
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      const derived = await derive(result.document);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Feature "Post": Offset from face 25 reaches the sketch plane: the face is only 25 away/
      );
      expect(
        extrudeToFaceUnresolved(feature, derived.featureWarnings ?? [])
      ).toBe(false);
    });

    it('refuses once the face moves closer than the offset, and recovers when it moves back', async () => {
      const result = await post(10);
      const lift = listFeaturesInOrder(result.document).find(
        (feature) => feature.name === 'Lift'
      )!;
      const lowered = updateFeature(result.document, {
        featureId: lift.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 8 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        }
      });
      const refused = await derive(lowered);
      expect(refused.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(refused.warnings.join('\n')).toMatch(
        /Offset from face 10 reaches the sketch plane/
      );
      const restored = await derive(result.document);
      expect(restored.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        AREA * 15,
        6
      );
    });

    it('reports a deleted face as unresolved, offset or not', async () => {
      const result = await post(5);
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      const ceilingFeature = listFeaturesInOrder(result.document).find(
        (candidate) => candidate.name === 'Ceiling'
      )!;
      const broken = deleteFeature(result.document, {
        featureId: ceilingFeature.featureId
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

    it('cuts a pocket that stops short of the floor face, leaving a web', async () => {
      // Block 20 × 20 × 10 with a shelf whose top face (z = 4) is the floor.
      let document = project('Pocket');
      document = addPrimitiveFeature(document, {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const blockId = document.bodyOrder.at(-1)!;
      document = addPrimitiveFeature(document, {
        name: 'Shelf',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 30, depth: 1 }
      });
      const shelfId = document.bodyOrder.at(-1)!;
      document = commandFactories
        .transformBody({
          name: 'Lower',
          targetBodyId: shelfId,
          translation: { x: -5, y: -5, z: 3 }
        })
        .apply(document);
      const floor = await face(document, shelfId, 1);
      const sketched = sketch(document, 10);
      const result = extrudeSketch(sketched.document, {
        name: 'Pocket',
        sketchId: sketched.sketchId,
        distance: -1,
        operation: 'cut',
        targetBodyId: blockId,
        endCondition: 'to-face',
        toFace: floor,
        toFaceOffset: 1.5
      });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      // From z = 10 down to z = 4 + 1.5.
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        20 * 20 * 10 - AREA * 4.5,
        6
      );
    });

    it('drafts the walls of an offset extrusion over the derived height', async () => {
      const result = await post(5);
      const featureId = listFeaturesInOrder(result.document).at(-1)!.featureId;
      const drafted = updateFeature(result.document, {
        featureId,
        data: { draftAngleDeg: 2 }
      });
      const derived = await derive(drafted);
      expect(derived.warnings).toEqual([]);
      const t = Math.tan((2 * Math.PI) / 180);
      const h = 20;
      const area = (z: number) => (4 - 2 * z * t) ** 2;
      const prismatoid = (h / 6) * (area(0) + 4 * area(h / 2) + area(h));
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        prismatoid,
        5
      );
    });
  });

  describe('edits and undo', () => {
    it('round-trips the offset through the edit command and clears it with the extent', async () => {
      const result = await post(5);
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      expect(extrudeEditInitial(feature)).toMatchObject({
        endCondition: 'to-face',
        toFaceOffset: 5
      });
      const value = {
        name: 'Post',
        sketchId: result.sketched.sketchId,
        distance: 1,
        symmetric: false,
        backDistance: 0,
        choice: { operation: 'new-body' as const }
      };
      const manager = new CommandManager(result.document);
      manager.execute(
        extrudeEditCommand(feature, {
          ...value,
          endCondition: 'to-face',
          toFace: result.target,
          toFaceOffset: -2
        })
      );
      expect(listFeaturesInOrder(manager.document).at(-1)!.data).toMatchObject({
        toFaceOffset: -2
      });
      let derived = await derive(manager.document);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        AREA * 27,
        6
      );
      // Ending on the face again clears the offset rather than storing 0.
      manager.execute(
        extrudeEditCommand(listFeaturesInOrder(manager.document).at(-1)!, {
          ...value,
          endCondition: 'to-face',
          toFace: result.target
        })
      );
      expect(
        listFeaturesInOrder(manager.document).at(-1)!.data
      ).not.toHaveProperty('toFaceOffset');
      // Switching to Distance clears the face and its offset together.
      manager.undo();
      manager.execute(
        extrudeEditCommand(listFeaturesInOrder(manager.document).at(-1)!, {
          ...value,
          endCondition: 'blind'
        })
      );
      const blind = listFeaturesInOrder(manager.document).at(-1)!.data;
      expect(blind).not.toHaveProperty('toFace');
      expect(blind).not.toHaveProperty('toFaceOffset');
      manager.undo();
      manager.undo();
      expect(listFeaturesInOrder(manager.document).at(-1)!.data).toMatchObject({
        toFaceOffset: 5
      });
      derived = await derive(manager.document);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        AREA * 20,
        6
      );
    });
  });

  describe('editor rules', () => {
    const sketchId = 'sketch_layout' as never;
    function context(reach: number | null): ExtrudeDraftContext {
      return {
        scope: { gap: 4 },
        units: 'mm',
        initial: { name: 'Extrude', sketchId, distance: 0 },
        bodies: [],
        toFacePicking: {
          armed: false,
          onPick: () => {},
          cancel: () => {},
          describe: () => ({ label: 'Ceiling', distance: reach }),
          setterRef: { current: null }
        }
      };
    }
    const target = { bodyId: 'ceiling' } as unknown as ExtrudeToFaceTarget;

    it('sends a typed offset with the face, and none at zero or off To face', () => {
      const ctx = context(25);
      const base = initialExtrudeDraft(ctx.initial, true);
      expect(
        extrudeDraftValue(
          {
            ...base,
            choice: { operation: 'new-body' },
            endCondition: 'to-face',
            toFace: target,
            faceOffset: 'gap'
          },
          ctx
        )
      ).toEqual(
        expect.objectContaining({
          endCondition: 'to-face',
          toFaceOffset: 'gap'
        })
      );
      expect(
        extrudeDraftValue(
          {
            ...base,
            choice: { operation: 'new-body' },
            endCondition: 'to-face',
            toFace: target,
            faceOffset: '0'
          },
          ctx
        )
      ).not.toHaveProperty('toFaceOffset');
      expect(
        extrudeDraftValue(
          {
            ...base,
            choice: { operation: 'new-body' },
            distance: '5',
            faceOffset: '3'
          },
          ctx
        )
      ).not.toHaveProperty('toFaceOffset');
    });

    it('refuses an offset that does not evaluate or reaches the sketch plane before Apply', () => {
      const draft = {
        ...initialExtrudeDraft(context(25).initial, true),
        choice: { operation: 'new-body' as const },
        endCondition: 'to-face' as const,
        toFace: target
      };
      expect(
        extrudeDraftRefusal({ ...draft, faceOffset: 'nope' }, context(25), true)
      ).toMatch(/^Offset from face: /);
      expect(
        extrudeDraftRefusal({ ...draft, faceOffset: '25' }, context(25), true)
      ).toMatch(/reaches the sketch plane/);
      expect(
        extrudeDraftRefusal({ ...draft, faceOffset: '-5' }, context(-3), true)
      ).toBeNull();
      expect(
        extrudeDraftRefusal({ ...draft, faceOffset: '5' }, context(-3), true)
      ).toMatch(/reaches the sketch plane/);
      expect(
        extrudeDraftRefusal({ ...draft, faceOffset: 'gap' }, context(25), true)
      ).toBeNull();
    });

    it('offers the offset value only to a face', () => {
      expect(
        extrudeShownValues({ extent: 'to-face', symmetric: false })
      ).toEqual(['faceOffset', 'startOffset', 'draftAngle']);
      expect(extrudeShownValues({ extent: 'blind', symmetric: false })).toEqual(
        ['distance', 'backDistance', 'startOffset', 'draftAngle']
      );
    });

    it('reads the offset in the history row', () => {
      const row = (toFaceOffset?: number | string) =>
        featureValueSummary(
          {
            featureId: 'feat_post',
            name: 'Post',
            data: {
              featureKind: 'extrude',
              distance: 1,
              endCondition: 'to-face',
              toFace: {},
              ...(toFaceOffset === undefined ? {} : { toFaceOffset }),
              draftAngleDeg: 2
            }
          } as never,
          { gap: 1.5 },
          'mm'
        );
      expect(row()).toBe('To face · 2° draft');
      expect(row(3)).toBe('To face · 3 mm short · 2° draft');
      expect(row(-2)).toBe('To face · 2 mm past · 2° draft');
      expect(row('gap')).toBe('To face · 1.5 mm short · 2° draft');
    });
  });
});
