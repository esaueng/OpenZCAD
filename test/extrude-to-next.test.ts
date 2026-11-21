import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@openzcad/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  listFeaturesInOrder,
  normalizeDocument,
  updateFeature
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  patternSourceProblem,
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import {
  extrudeEditCommand,
  extrudeEditInitial
} from '../apps/web/src/lib/extrudeEditing';
import {
  extrudeDraftRefusal,
  extrudeDraftValue,
  extrudeShownExtent,
  initialExtrudeDraft,
  type ExtrudeDraftContext
} from '../apps/web/src/lib/extrudeDraft';
import { extrudeShownValues } from '../apps/web/src/lib/extrudeShownValues';
import { featureValueSummary } from '../apps/web/src/lib/featureSummary';
import { regionExtrudeOutcome } from '../apps/web/src/lib/extrudeInference';

/**
 * F01 (schema v130): extrude up to the next face.
 *
 * The target is a hollow block: a 20 × 20 × 20 box lifted to z = 10..30 with
 * a 16 × 16 × 12 cavity at z = 14..26 (4928 mm³). A 4 × 4 profile under it
 * grows up to its underside; one on its top cuts down only to the cavity's
 * roof (through all would take the floor too). Every volume is a closed form.
 */
const AREA = 16;
const HOLLOW = 20 * 20 * 20 - 16 * 16 * 12;

function square(centerX = 10, centerY = 10): SketchObjectData {
  return { objectKind: 'rectangle', width: 4, height: 4, centerX, centerY };
}

function project(name: string): ProjectDocument {
  return createProjectDocument(name, toUserId('user_to_next'));
}

/** The hollow block, lifted so its underside sits at `z`. */
function hollow(document: ProjectDocument, z = 10) {
  let next = addPrimitiveFeature(document, {
    name: 'Shell',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 20 }
  });
  const outer = next.bodyOrder.at(-1)!;
  next = commandFactories
    .transformBody({
      name: 'Lift',
      targetBodyId: outer,
      translation: { x: 0, y: 0, z }
    })
    .apply(next);
  next = addPrimitiveFeature(next, {
    name: 'Void',
    primitiveKind: 'box',
    dimensions: { width: 16, height: 16, depth: 12 }
  });
  const inner = next.bodyOrder.at(-1)!;
  next = commandFactories
    .transformBody({
      name: 'Place void',
      targetBodyId: inner,
      translation: { x: 2, y: 2, z: z + 4 }
    })
    .apply(next);
  next = commandFactories
    .booleanBodies({
      name: 'Hollow',
      operation: 'subtract',
      targetBodyIds: [outer, inner]
    })
    .apply(next);
  return { document: next, bodyId: next.bodyOrder.at(-1)! };
}

function sketch(
  document: ProjectDocument,
  offset: number,
  objects = [square()]
) {
  return addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset },
    objects
  });
}

function toNext(
  operation: 'add' | 'cut',
  offset: number,
  distance: number,
  patch: Record<string, unknown> = {},
  base = hollow(project('Next'))
) {
  const sketched = sketch(base.document, offset, [
    (patch.profile as SketchObjectData | undefined) ?? square()
  ]);
  const { profile: _profile, ...rest } = patch;
  const result = extrudeSketch(sketched.document, {
    name: 'Reach',
    sketchId: sketched.sketchId,
    distance,
    operation,
    targetBodyId: base.bodyId,
    endCondition: 'to-next',
    ...rest
  });
  return { ...result, target: base.bodyId, sketched };
}

describe('F01 up to next', { timeout: 90_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function derive(document: ProjectDocument) {
    return adapter.syncDocument(document);
  }

  describe('document contract', () => {
    it('stores the extent with its dormant distance, nothing derived, at the current schema', () => {
      const result = toNext('add', 0, 1);
      expect(listFeaturesInOrder(result.document).at(-1)!.data).toMatchObject({
        featureKind: 'extrude',
        distance: 1,
        operation: 'add',
        endCondition: 'to-next'
      });
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(130);
      expect(result.document.schemaVersion).toBe(
        PROJECT_DOCUMENT_SCHEMA_VERSION
      );
      const saved = JSON.parse(
        JSON.stringify(result.document)
      ) as ProjectDocument;
      expect(JSON.stringify(normalizeDocument(saved))).toBe(
        JSON.stringify(saved)
      );
    });

    it.each([
      [{ operation: 'new-body', targetBodyId: undefined }, /add or a cut only/],
      [{ operation: 'intersect' }, /add or a cut only/],
      [{ targetBodyId: undefined }, /one explicit target body/],
      [{ symmetric: true }, /not symmetric or two-sided/],
      [{ backDistance: 3 }, /not symmetric or two-sided/],
      [{ throughAllSide: 'forward' }, /no through-all side/]
    ])('refuses %o at entry', (patch, message) => {
      const base = hollow(project('Refusals'));
      const sketched = sketch(base.document, 0);
      expect(() =>
        extrudeSketch(sketched.document, {
          name: 'Bad',
          sketchId: sketched.sketchId,
          distance: 1,
          operation: 'add',
          targetBodyId: base.bodyId,
          endCondition: 'to-next',
          ...patch
        } as never)
      ).toThrow(message);
    });

    it('is not repeated by a feature pattern yet', () => {
      expect(
        patternSourceProblem(
          {
            featureKind: 'extrude',
            sketchId: 'sketch_a' as never,
            distance: 1,
            endCondition: 'to-next'
          },
          'Reach'
        )
      ).toMatch(/up to the next face, which a pattern cannot repeat yet/);
    });
  });

  describe('exact build', () => {
    it('grows an add up to the underside of the target', async () => {
      const result = toNext('add', 0, 1);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(HOLLOW + AREA * 10, 5);
      expect(body.bbox.min.z).toBeCloseTo(0, 9);
    });

    it('grows the other way for a negative distance', async () => {
      const result = toNext('add', 50, -1);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(HOLLOW + AREA * 20, 5);
      expect(body.bbox.max.z).toBeCloseTo(50, 9);
    });

    it('cuts from the top only down to the cavity, not through the floor', async () => {
      const result = toNext('cut', 30, -1);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        HOLLOW - AREA * 4,
        5
      );
    });

    it('starts from a start offset and tapers with a draft', async () => {
      const started = toNext('add', 0, 1, { startOffset: 4 });
      let derived = await derive(started.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[started.bodyId]!.volume).toBeCloseTo(
        HOLLOW + AREA * 6,
        5
      );
      const drafted = toNext('add', 0, 1, { draftAngleDeg: 2 });
      derived = await derive(drafted.document);
      expect(derived.warnings).toEqual([]);
      const t = Math.tan((2 * Math.PI) / 180);
      const area = (z: number) => (4 - 2 * z * t) ** 2;
      expect(derived.bodyRepresentations[drafted.bodyId]!.volume).toBeCloseTo(
        HOLLOW + (10 / 6) * (area(0) + 4 * area(5) + area(10)),
        5
      );
    });

    it('follows a moved target, with nothing derived stored', async () => {
      const result = toNext('add', 0, 1);
      const lift = listFeaturesInOrder(result.document).find(
        (feature) => feature.name === 'Lift'
      )!;
      const moved = updateFeature(result.document, {
        featureId: lift.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 20 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        }
      });
      const derived = await derive(moved);
      // The void kept its own placement (z = 14..26), so the shell, now at
      // z = 20..40, is open underneath: the post rises into the opening and
      // stops at the cavity's roof, z = 26.
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        8000 - 16 * 16 * 6 + AREA * 26,
        5
      );
      expect(listFeaturesInOrder(moved).at(-1)!.data).toMatchObject({
        distance: 1,
        endCondition: 'to-next'
      });
    });

    it.each([
      [
        'a profile partly off the target',
        'add',
        0,
        1,
        { profile: square(19, 10) },
        /does not meet Shell Body everywhere/
      ],
      [
        'a profile wholly off the target',
        'add',
        0,
        1,
        { profile: square(40, 10) },
        /does not meet Shell Body everywhere/
      ],
      [
        'an add that starts inside the target',
        'add',
        12,
        1,
        {},
        /starts inside Shell Body/
      ],
      [
        'a cut that starts outside the target',
        'cut',
        35,
        -1,
        {},
        /does not start in Shell Body/
      ],
      [
        'a target behind the start',
        'add',
        50,
        1,
        {},
        /lies entirely behind where the extrusion starts/
      ]
    ])(
      'refuses %s by name',
      async (_label, operation, offset, distance, patch, message) => {
        const result = toNext(
          operation as 'add' | 'cut',
          offset,
          distance,
          patch
        );
        const derived = await derive(result.document);
        expect(derived.warnings.join('\n')).toMatch(
          new RegExp(`Feature "Reach": .*${message.source}`)
        );
        // Refused, the feature adds nothing to its target.
        expect(
          derived.bodyRepresentations[result.bodyId]?.volume ?? HOLLOW
        ).toBeCloseTo(HOLLOW, 5);
      }
    );

    describe('review: a cut leaves at one next face, from a full start', () => {
      /** A 20 mm cube, optionally with a sealed 2 × 2 × 12 cavity at z 4–16. */
      function cube(cavity: boolean) {
        let document = addPrimitiveFeature(project('Cube'), {
          name: 'Cube',
          primitiveKind: 'box',
          dimensions: { width: 20, height: 20, depth: 20 }
        });
        let bodyId = document.bodyOrder.at(-1)!;
        if (cavity) {
          document = addPrimitiveFeature(document, {
            name: 'Pocket',
            primitiveKind: 'box',
            dimensions: { width: 2, height: 2, depth: 12 }
          });
          const pocket = document.bodyOrder.at(-1)!;
          document = commandFactories
            .transformBody({
              name: 'Sink',
              targetBodyId: pocket,
              translation: { x: 9, y: 9, z: 4 }
            })
            .apply(document);
          document = commandFactories
            .booleanBodies({
              name: 'Hollowed',
              operation: 'subtract',
              targetBodyIds: [bodyId, pocket]
            })
            .apply(document);
          bodyId = document.bodyOrder.at(-1)!;
        }
        return { document, bodyId };
      }

      it.each([
        [
          'a profile over a cavity it only partly covers',
          true,
          20,
          10,
          /does not leave .* at one next face/
        ],
        [
          'a profile that starts partly off the cube',
          false,
          20,
          19,
          /starts partly outside/
        ],
        [
          'a profile a hair above the cube',
          false,
          20.000004,
          10,
          /does not start in/
        ]
      ])('refuses %s by name', async (_label, cavity, z, centerX, message) => {
        const base = cube(cavity);
        const result = toNext(
          'cut',
          z,
          -1,
          { profile: square(centerX, 10) },
          base
        );
        const derived = await derive(result.document);
        expect(derived.warnings.join('\n')).toMatch(message);
        expect(
          derived.bodyRepresentations[result.bodyId]?.volume ?? 8000
        ).toBeCloseTo(cavity ? 8000 - 48 : 8000, 5);
      });

      it('cuts a tiny pocket through a broad plate (overlap at its own scale)', async () => {
        let document = addPrimitiveFeature(project('Plate'), {
          name: 'Plate',
          primitiveKind: 'box',
          dimensions: { width: 1000, height: 1000, depth: 10 }
        });
        const bodyId = document.bodyOrder.at(-1)!;
        const sketched = sketch(document, 10, [
          {
            objectKind: 'rectangle',
            width: 0.25,
            height: 0.25,
            centerX: 500,
            centerY: 500
          }
        ]);
        document = sketched.document;
        const cut = extrudeSketch(document, {
          name: 'Pin',
          sketchId: sketched.sketchId,
          distance: -1,
          operation: 'cut',
          targetBodyId: bodyId,
          endCondition: 'to-next'
        });
        const derived = await derive(cut.document);
        expect(derived.warnings).toEqual([]);
        expect(derived.bodyRepresentations[cut.bodyId]!.volume).toBeCloseTo(
          1000 * 1000 * 10 - 0.625,
          3
        );
      });
    });

    it('refuses once its target is deleted', async () => {
      const result = toNext('add', 0, 1);
      const hollowFeature = listFeaturesInOrder(result.document).find(
        (feature) => feature.name === 'Hollow'
      )!;
      const broken = deleteFeature(result.document, {
        featureId: hollowFeature.featureId
      });
      const derived = await derive(broken);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(/Feature "Reach"/);
    });
  });

  describe('edits and undo', () => {
    it('turns a blind add into up to next and back through the edit command', async () => {
      const base = hollow(project('Edit'));
      const sketched = sketch(base.document, 0);
      const created = extrudeSketch(sketched.document, {
        name: 'Reach',
        sketchId: sketched.sketchId,
        distance: 4,
        operation: 'add',
        targetBodyId: base.bodyId
      });
      const feature = listFeaturesInOrder(created.document).at(-1)!;
      const value = {
        name: 'Reach',
        sketchId: sketched.sketchId,
        distance: 4,
        symmetric: false,
        backDistance: 0,
        choice: { operation: 'add' as const, targetBodyId: base.bodyId }
      };
      const manager = new CommandManager(created.document);
      manager.execute(
        extrudeEditCommand(feature, { ...value, endCondition: 'to-next' })
      );
      const edited = listFeaturesInOrder(manager.document).at(-1)!;
      expect(edited.data).toMatchObject({ endCondition: 'to-next' });
      expect(extrudeEditInitial(edited)).toMatchObject({
        endCondition: 'to-next'
      });
      const derived = await derive(manager.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[created.bodyId]!.volume).toBeCloseTo(
        HOLLOW + AREA * 10,
        5
      );
      manager.execute(
        extrudeEditCommand(edited, { ...value, endCondition: 'blind' })
      );
      expect(
        listFeaturesInOrder(manager.document).at(-1)!.data
      ).not.toHaveProperty('endCondition');
      manager.undo();
      manager.undo();
      expect(
        listFeaturesInOrder(manager.document).at(-1)!.data
      ).not.toHaveProperty('endCondition');
    });
  });

  describe('editor rules', () => {
    const block = 'body_block' as BodyId;
    const ctx: ExtrudeDraftContext = {
      scope: {},
      units: 'mm',
      initial: { name: 'Extrude', sketchId: 'sketch_a' as never, distance: 0 },
      bodies: [{ bodyId: block, name: 'Block' }]
    };
    const base = initialExtrudeDraft(ctx.initial, true);

    it('offers Up to next for an add or a cut and sends its direction', () => {
      const add = {
        ...base,
        choice: { operation: 'add' as const, targetBodyId: block },
        endCondition: 'to-next' as const
      };
      expect(extrudeShownExtent(add, ctx)).toBe('to-next');
      expect(extrudeDraftRefusal(add, ctx, true)).toBeNull();
      expect(extrudeDraftValue(add, ctx)).toMatchObject({
        endCondition: 'to-next',
        distance: 1
      });
      expect(extrudeDraftValue({ ...add, distance: '-1' }, ctx)).toMatchObject({
        endCondition: 'to-next',
        distance: -1
      });
      // Off add and cut it reads as Distance and is never sent.
      const newBody = {
        ...add,
        choice: { operation: 'new-body' as const },
        distance: '5'
      };
      expect(extrudeShownExtent(newBody, ctx)).toBe('blind');
      expect(extrudeDraftValue(newBody, ctx)).toMatchObject({
        endCondition: 'blind'
      });
    });

    it('offers a start offset and a draft up to next, and reads it in the History row', () => {
      expect(
        extrudeShownValues({ extent: 'to-next', symmetric: false })
      ).toEqual(['startOffset', 'draftAngle']);
      expect(
        featureValueSummary(
          {
            featureId: 'feat_reach',
            name: 'Reach',
            data: {
              featureKind: 'extrude',
              distance: 1,
              endCondition: 'to-next',
              draftAngleDeg: 2
            }
          } as never,
          {},
          'mm'
        )
      ).toBe('Up to next · 2° draft');
      expect(
        regionExtrudeOutcome(
          {
            inference: { operation: 'add' },
            command: { payload: { endCondition: 'to-next' } }
          },
          1,
          'mm'
        )
      ).toBe('Extruded region up to the next face, added to the body.');
    });
  });
});
