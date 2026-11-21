import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@openzcad/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  attachDerivedState,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder,
  normalizeDocument,
  patternBody,
  renameParameter,
  setParameter,
  toFaceExtent,
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
 * F01 (schema v121): an extrude that starts off its sketch plane.
 *
 * `startOffset` moves where the extrusion starts along the sketch normal.
 * Every extent measured from the sketch plane is measured from the start
 * plane instead, and a to-face extrude runs from it to the face. It is
 * resolved on every rebuild and never folded into `distance`. Every volume
 * below is a closed form over a 4 × 4 square profile.
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
  return createProjectDocument(name, toUserId('user_start_offset'));
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

describe('F01 start offset', { timeout: 60_000 }, () => {
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

  /** A blind extrude of the square with `patch` (a start offset, a span). */
  function blind(patch: Record<string, unknown>, document = project('Blind')) {
    const sketched = sketch(document);
    const result = extrudeSketch(sketched.document, {
      name: 'Riser',
      sketchId: sketched.sketchId,
      distance: 10,
      ...patch
    });
    return { ...result, sketched };
  }

  /** A post from its start up to the ceiling's underside at `z`. */
  async function post(
    startOffset: number | string | undefined,
    extra: Record<string, unknown> = {},
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
      ...(startOffset === undefined ? {} : { startOffset }),
      ...extra
    });
    return { ...result, target, sketched };
  }

  describe('shared span rule', () => {
    it('measures from the start to the face, whichever side of the start the face lies', () => {
      expect(toFaceExtent(25, 5, 0)).toBe(20);
      expect(toFaceExtent(25, -5, 0)).toBe(30);
      expect(toFaceExtent(-13, -3, 0)).toBe(-10);
      expect(toFaceExtent(-13, 2, 0)).toBe(-15);
      // A start beyond the face runs back to it; a face on the sketch plane
      // is reached from a start off it.
      expect(toFaceExtent(25, 30, 0)).toBe(-5);
      expect(toFaceExtent(0, -5, 0)).toBe(5);
      expect(toFaceExtent(25, 30, 1)).toBe(-4);
      // A start on the face, or an offset reaching the start, leaves none.
      expect(toFaceExtent(25, 25, 0)).toBeNull();
      expect(toFaceExtent(25, 21, 5)).toBeNull();
      expect(toFaceExtent(25, Number.NaN, 0)).toBeNull();
      // With no start offset it is exactly the v113 rule.
      for (const [face, offset] of [
        [25, 5],
        [25, -3],
        [-13, 3],
        [25, 25],
        [-13, 14]
      ] as const) {
        expect(toFaceExtent(face, 0, offset)).toBe(
          toFaceOffsetEnd(face, offset)
        );
      }
      // Review: a huge offset past a face near the sketch plane is the same
      // span under both rules (the tolerance scales by the planes only).
      expect(toFaceExtent(0.0001, 0, -100001)).toBe(
        toFaceOffsetEnd(0.0001, -100001)
      );
      expect(toFaceExtent(0.0001, 0, -100001)).not.toBeNull();
    });
  });

  describe('document contract', () => {
    it('stores the start offset as given, nothing derived, at the current schema', () => {
      const result = blind({ startOffset: 5 });
      expect(listFeaturesInOrder(result.document).at(-1)!.data).toMatchObject({
        featureKind: 'extrude',
        distance: 10,
        startOffset: 5
      });
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(121);
      expect(result.document.schemaVersion).toBe(
        PROJECT_DOCUMENT_SCHEMA_VERSION
      );
    });

    it('drops a zero start offset, and opens an extrude without one byte for byte', () => {
      expect(
        listFeaturesInOrder(blind({ startOffset: 0 }).document).at(-1)!.data
      ).not.toHaveProperty('startOffset');
      for (const patch of [{}, { startOffset: 'lift' }]) {
        const saved = JSON.parse(
          JSON.stringify(blind(patch).document)
        ) as ProjectDocument;
        const loaded = normalizeDocument(saved);
        expect(JSON.stringify(loaded)).toBe(JSON.stringify(saved));
      }
    });

    it.each([
      [
        {
          operation: 'cut',
          targetBodyId: 'TARGET',
          endCondition: 'through-all',
          throughAllSide: 'forward',
          startOffset: 2
        },
        /through-all extrude .* has no start offset/
      ],
      [{ startOffset: Infinity }, /Start offset must be a finite length/],
      [{ startOffset: ' ' }, /Start offset must be a number or an expression/]
    ])('refuses %o at entry', (patch, message) => {
      const block = addPrimitiveFeature(project('Refusals'), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const blockId = block.bodyOrder.at(-1)!;
      const sketched = sketch(block);
      expect(() =>
        extrudeSketch(sketched.document, {
          name: 'Bad',
          sketchId: sketched.sketchId,
          distance: 2,
          ...Object.fromEntries(
            Object.entries(patch).map(([key, value]) => [
              key,
              value === 'TARGET' ? blockId : value
            ])
          )
        })
      ).toThrow(message);
    });

    it('rewrites a start offset expression when its parameter is renamed', () => {
      const result = blind(
        { startOffset: 'lift' },
        setParameter(project('Rename'), { name: 'lift', expression: '5' })
      );
      const renamed = renameParameter(result.document, {
        name: 'lift',
        newName: 'raise'
      });
      expect(listFeaturesInOrder(renamed).at(-1)!.data).toMatchObject({
        startOffset: 'raise'
      });
    });
  });

  describe('exact build', () => {
    it.each([
      ['a positive distance', { startOffset: 5 }, 10, 5, 15],
      ['a negative distance', { startOffset: 5, distance: -10 }, 10, -5, 5],
      ['a start below the sketch', { startOffset: -3 }, 10, -3, 7],
      [
        'a symmetric span about the start plane',
        { startOffset: 5, symmetric: true },
        10,
        0,
        10
      ],
      [
        'a back distance behind the start plane',
        { startOffset: 5, backDistance: 3 },
        13,
        2,
        15
      ]
    ])(
      'starts %s off the sketch plane',
      async (_label, patch, height, minZ, maxZ) => {
        const result = blind(patch);
        const derived = await derive(result.document);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[result.bodyId]!;
        expect(body.volume).toBeCloseTo(AREA * height, 6);
        expect(body.bbox.min.z).toBeCloseTo(minZ, 9);
        expect(body.bbox.max.z).toBeCloseTo(maxZ, 9);
      }
    );

    it('follows a parameter start offset, with no stored position', async () => {
      const result = blind(
        { startOffset: 'lift' },
        setParameter(project('Lift'), { name: 'lift', expression: '5' })
      );
      const raised = setParameter(result.document, {
        name: 'lift',
        expression: '12'
      });
      const derived = await derive(raised);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(AREA * 10, 6);
      expect(body.bbox.min.z).toBeCloseTo(12, 9);
      expect(listFeaturesInOrder(raised).at(-1)!.data).toMatchObject({
        distance: 10,
        startOffset: 'lift'
      });
    });

    it('runs a to-face extrude from the start plane to the face', async () => {
      const result = await post(5);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(AREA * 20, 6);
      expect(body.bbox.min.z).toBeCloseTo(5, 9);
      expect(body.bbox.max.z).toBeCloseTo(25, 9);
    });

    it('combines a start offset with an offset from the face', async () => {
      const result = await post(-5, { toFaceOffset: 5 });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      // From z = -5 up to 5 short of the face at 25.
      expect(body.volume).toBeCloseTo(AREA * 25, 6);
      expect(body.bbox.min.z).toBeCloseTo(-5, 9);
      expect(body.bbox.max.z).toBeCloseTo(20, 9);
    });

    it('refuses a start on the face, or an offset reaching the start, by name, not as an unresolved face', async () => {
      for (const [start, extra, message] of [
        [25, {}, /Feature "Post": Start offset 25 reaches the face/],
        [
          21,
          { toFaceOffset: 5 },
          /Feature "Post": Offset from face 5 reaches where the extrusion starts: the face is only 4 from the start/
        ]
      ] as const) {
        const result = await post(start, extra);
        const derived = await derive(result.document);
        expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
        const warnings = derived.warnings.join('\n');
        expect(warnings).toMatch(message);
        expect(warnings).not.toMatch(/Target face is unresolved/);
      }
    });

    it('runs back to a face below a start beyond it', async () => {
      const result = await post(30);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      // From z = 30 down to the face at 25.
      expect(body.volume).toBeCloseTo(AREA * 5, 6);
      expect(body.bbox.min.z).toBeCloseTo(25, 9);
      expect(body.bbox.max.z).toBeCloseTo(30, 9);
    });

    it('reaches a face on the sketch plane from a start offset, and refuses it without one', async () => {
      // A ceiling whose underside lies on the sketch plane at z = 0.
      for (const [startOffset, height] of [
        [-5, 5],
        [0, null]
      ] as const) {
        const result = await post(startOffset, {}, 0);
        const derived = await derive(result.document);
        if (height === null) {
          expect(derived.warnings.join('\n')).toMatch(
            /Target face is unresolved: the face lies on the sketch plane/
          );
        } else {
          expect(derived.warnings).toEqual([]);
          const body = derived.bodyRepresentations[result.bodyId]!;
          expect(body.volume).toBeCloseTo(AREA * height, 6);
          expect(body.bbox.min.z).toBeCloseTo(-5, 9);
          expect(body.bbox.max.z).toBeCloseTo(0, 9);
        }
      }
    });

    it('cuts a pocket that starts inside the target and leaves through its top', async () => {
      const document = addPrimitiveFeature(project('Pocket'), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const blockId = document.bodyOrder.at(-1)!;
      const sketched = sketch(document);
      const cut = extrudeSketch(sketched.document, {
        name: 'Pocket',
        sketchId: sketched.sketchId,
        distance: 5,
        startOffset: 7,
        operation: 'cut',
        targetBodyId: blockId
      });
      const derived = await derive(cut.document);
      expect(derived.warnings).toEqual([]);
      // From z = 7 up through the top at z = 10.
      expect(derived.bodyRepresentations[cut.bodyId]!.volume).toBeCloseTo(
        20 * 20 * 10 - AREA * 3,
        6
      );
    });

    it('grows a boss whose offset start cap lies on the target face, as one sketched there does', async () => {
      const slab = () =>
        addPrimitiveFeature(project('Boss'), {
          name: 'Slab',
          primitiveKind: 'box',
          dimensions: { width: 20, height: 20, depth: 10 }
        });
      const volumes: number[] = [];
      for (const [sketchZ, startOffset] of [
        [10, 0],
        [8, 2]
      ] as const) {
        const document = slab();
        const slabId = document.bodyOrder.at(-1)!;
        const sketched = sketch(document, sketchZ);
        const boss = extrudeSketch(sketched.document, {
          name: 'Boss',
          sketchId: sketched.sketchId,
          distance: 5,
          startOffset,
          operation: 'add',
          targetBodyId: slabId
        });
        const derived = await derive(boss.document);
        expect(derived.warnings).toEqual([]);
        volumes.push(derived.bodyRepresentations[boss.bodyId]!.volume);
      }
      expect(volumes[0]).toBeCloseTo(4000 + AREA * 5, 6);
      expect(volumes[1]).toBeCloseTo(volumes[0]!, 6);
    });

    it('does not let a pattern repeat a through-all copy its source refuses', async () => {
      // Created at a start offset of 0 (accepted), then the parameter moves
      // it off the sketch plane, which through all refuses.
      let document = setParameter(project('Pattern'), {
        name: 'lift',
        expression: '0'
      });
      document = addPrimitiveFeature(document, {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 20, depth: 10 }
      });
      const blockId = document.bodyOrder.at(-1)!;
      const sketched = sketch(document, 2);
      const cut = extrudeSketch(sketched.document, {
        name: 'Hole',
        sketchId: sketched.sketchId,
        distance: 1,
        startOffset: 'lift',
        operation: 'cut',
        targetBodyId: blockId,
        endCondition: 'through-all',
        throughAllSide: 'forward'
      });
      const holeId = listFeaturesInOrder(cut.document).at(-1)!.featureId;
      const patterned = patternBody(cut.document, {
        name: 'Holes',
        targetBodyId: cut.bodyId,
        patternKind: 'linear',
        count: 3,
        axis: 'x',
        spacing: 15,
        sourceFeatureIds: [holeId]
      }).document;
      const accepted = await derive(patterned);
      expect(accepted.warnings).toEqual([]);
      const moved = setParameter(patterned, { name: 'lift', expression: '3' });
      const derived = await derive(moved);
      const warnings = derived.warnings.join('\n');
      expect(warnings).toMatch(/Feature "Hole": .*has no start offset/);
      expect(warnings).toMatch(/Feature "Holes": .*has no start offset/);
    });

    it('hinges a draft on the start plane, keeping the profile there', async () => {
      const result = blind({ startOffset: 5, draftAngleDeg: 2 });
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      const t = Math.tan((2 * Math.PI) / 180);
      const h = 10;
      const area = (z: number) => (4 - 2 * z * t) ** 2;
      expect(body.volume).toBeCloseTo(
        (h / 6) * (area(0) + 4 * area(h / 2) + area(h)),
        5
      );
      // The full 4 × 4 section sits on the start plane at z = 5.
      expect(body.bbox.min.z).toBeCloseTo(5, 9);
      expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(4, 6);
    });
  });

  describe('edits and undo', () => {
    it('round-trips the start offset through the edit command and clears it at zero', async () => {
      const result = blind({ startOffset: 5 });
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      expect(extrudeEditInitial(feature)).toMatchObject({ startOffset: 5 });
      const value = {
        name: 'Riser',
        sketchId: result.sketched.sketchId,
        distance: 10,
        symmetric: false,
        backDistance: 0,
        choice: { operation: 'new-body' as const }
      };
      const manager = new CommandManager(result.document);
      manager.execute(
        extrudeEditCommand(feature, { ...value, startOffset: -2 })
      );
      expect(listFeaturesInOrder(manager.document).at(-1)!.data).toMatchObject({
        startOffset: -2
      });
      let derived = await derive(manager.document);
      expect(
        derived.bodyRepresentations[result.bodyId]!.bbox.min.z
      ).toBeCloseTo(-2, 9);
      manager.execute(
        extrudeEditCommand(listFeaturesInOrder(manager.document).at(-1)!, value)
      );
      expect(
        listFeaturesInOrder(manager.document).at(-1)!.data
      ).not.toHaveProperty('startOffset');
      manager.undo();
      manager.undo();
      expect(listFeaturesInOrder(manager.document).at(-1)!.data).toMatchObject({
        startOffset: 5
      });
      derived = await derive(manager.document);
      expect(
        derived.bodyRepresentations[result.bodyId]!.bbox.min.z
      ).toBeCloseTo(5, 9);
    });

    it('refuses an update that adds through all beside a start offset', () => {
      let document = addPrimitiveFeature(project('Through'), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const blockId = document.bodyOrder.at(-1)!;
      const sketched = sketch(document);
      document = extrudeSketch(sketched.document, {
        name: 'Pocket',
        sketchId: sketched.sketchId,
        distance: 5,
        startOffset: 7,
        operation: 'cut',
        targetBodyId: blockId
      }).document;
      const featureId = listFeaturesInOrder(document).at(-1)!.featureId;
      expect(() =>
        updateFeature(document, {
          featureId,
          data: { endCondition: 'through-all', throughAllSide: 'forward' }
        })
      ).toThrow(/has no start offset/);
    });
  });

  describe('editor rules', () => {
    const sketchId = 'sketch_layout' as never;
    function context(reach: number | null): ExtrudeDraftContext {
      return {
        scope: { lift: 4 },
        units: 'mm',
        initial: { name: 'Extrude', sketchId, distance: 0 },
        bodies: [{ bodyId: 'block' as BodyId, name: 'Block' }],
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

    it('sends a typed start offset except through all, and none at zero', () => {
      const ctx = context(25);
      const base = {
        ...initialExtrudeDraft(ctx.initial, true),
        choice: { operation: 'new-body' as const },
        distance: '10'
      };
      expect(
        extrudeDraftValue({ ...base, startOffset: 'lift' }, ctx)
      ).toMatchObject({ startOffset: 'lift' });
      expect(
        extrudeDraftValue({ ...base, startOffset: '0' }, ctx)
      ).not.toHaveProperty('startOffset');
      expect(
        extrudeDraftValue(
          {
            ...base,
            choice: { operation: 'cut', targetBodyId: 'block' as BodyId },
            endCondition: 'through-all',
            startOffset: '3'
          },
          ctx
        )
      ).not.toHaveProperty('startOffset');
    });

    it('refuses a start offset that does not evaluate or passes the face end before Apply', () => {
      const draft = {
        ...initialExtrudeDraft(context(25).initial, true),
        choice: { operation: 'new-body' as const },
        endCondition: 'to-face' as const,
        toFace: target
      };
      expect(
        extrudeDraftRefusal(
          { ...draft, startOffset: 'nope' },
          context(25),
          true
        )
      ).toMatch(/^Start offset: /);
      expect(
        extrudeDraftRefusal({ ...draft, startOffset: '25' }, context(25), true)
      ).toMatch(/Start offset reaches the face/);
      expect(
        extrudeDraftRefusal(
          { ...draft, startOffset: '21', faceOffset: '5' },
          context(25),
          true
        )
      ).toMatch(/Offset from face reaches where the extrusion starts/);
      // A start beyond the face runs back to it.
      expect(
        extrudeDraftRefusal({ ...draft, startOffset: '30' }, context(25), true)
      ).toBeNull();
      // A face on the sketch plane needs a start offset to be reached.
      expect(
        extrudeDraftRefusal({ ...draft, startOffset: '0' }, context(0), true)
      ).toMatch(/lies on the sketch plane; give a start offset/);
      expect(
        extrudeDraftRefusal({ ...draft, startOffset: '-5' }, context(0), true)
      ).toBeNull();
      // A stored face on the sketch plane, refused as unresolved with no
      // start, is reached by typing a start: no re-pick needed.
      const stored = {
        ...context(0),
        initial: { ...context(0).initial, toFace: target },
        toFacePicking: { ...context(0).toFacePicking!, unresolved: true }
      };
      expect(
        extrudeDraftRefusal({ ...draft, startOffset: '-5' }, stored, true)
      ).toBeNull();
      expect(
        extrudeDraftRefusal({ ...draft, startOffset: '0' }, stored, true)
      ).toMatch(/no longer exists here/);
      expect(
        extrudeDraftRefusal(
          { ...draft, startOffset: 'lift' },
          context(25),
          true
        )
      ).toBeNull();
      expect(
        extrudeDraftRefusal({ ...draft, startOffset: '-2' }, context(-10), true)
      ).toBeNull();
    });

    it('offers the start offset except through all', () => {
      expect(extrudeShownValues({ extent: 'blind', symmetric: false })).toEqual(
        ['distance', 'backDistance', 'startOffset', 'draftAngle']
      );
      expect(
        extrudeShownValues({ extent: 'to-face', symmetric: false })
      ).toEqual(['faceOffset', 'startOffset', 'draftAngle']);
      expect(
        extrudeShownValues({ extent: 'through-all', symmetric: false })
      ).toEqual([]);
    });

    it('reads the start offset in the history row', () => {
      const row = (data: Record<string, unknown>) =>
        featureValueSummary(
          {
            featureId: 'feat_riser',
            name: 'Riser',
            data: { featureKind: 'extrude', distance: 10, ...data }
          } as never,
          { lift: 1.5 },
          'mm'
        );
      expect(row({ startOffset: 5 })).toBe('10 mm · starts 5 mm off');
      expect(row({ startOffset: 'lift', draftAngleDeg: 2 })).toBe(
        '10 mm · starts 1.5 mm off · 2° draft'
      );
      expect(row({ startOffset: -2, symmetric: true })).toBe(
        '10 mm symmetric · starts -2 mm off'
      );
      expect(row({ endCondition: 'to-face', toFace: {}, startOffset: 3 })).toBe(
        'To face · starts 3 mm off'
      );
      expect(row({ startOffset: 0 })).toBe('10 mm');
    });
  });
});
