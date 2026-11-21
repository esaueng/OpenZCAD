import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@openzcad/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder,
  normalizeDocument,
  renameParameter,
  setParameter,
  updateFeature
} from '@openzcad/document-core';
import { CommandManager } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
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
  extrudeFormValue,
  initialExtrudeDraft,
  type ExtrudeDraftContext
} from '../apps/web/src/lib/extrudeDraft';
import { extrudeShownValues } from '../apps/web/src/lib/extrudeShownValues';
import { extrudeTakesDraft } from '../apps/web/src/lib/inPlace/extrude';
import { featureValueSummary } from '../apps/web/src/lib/featureSummary';

/**
 * F01 (schema v126): per-side draft.
 *
 * A symmetric or two-sided blind extrude takes `draftAngleDeg` for the side
 * its distance runs to and `backDraftAngleDeg` for the other side. Each side
 * tapers from the start plane by its own angle (positive narrows as it
 * leaves). Every volume is a closed form: a square section's area is
 * quadratic in height, so the prismatoid rule is exact, and a round section
 * sweeps a cone frustum.
 */
const SQUARE: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 10,
  centerY: 10
};
const CIRCLE: SketchObjectData = {
  objectKind: 'circle',
  centerX: 10,
  centerY: 10,
  radius: 3
};

function tangent(deg: number): number {
  return Math.tan((deg * Math.PI) / 180);
}

/** The square swept `h` from the start plane, tapering by `deg`. */
function squareSide(h: number, deg: number): number {
  const t = tangent(deg);
  const area = (z: number) => (4 - 2 * z * t) ** 2;
  return (h / 6) * (area(0) + 4 * area(h / 2) + area(h));
}

/** The r 3 circle swept `h` from the start plane, tapering by `deg`. */
function circleSide(h: number, deg: number): number {
  const r0 = 3;
  const r1 = 3 - h * tangent(deg);
  return ((Math.PI * h) / 3) * (r0 * r0 + r0 * r1 + r1 * r1);
}

function project(name: string): ProjectDocument {
  return createProjectDocument(name, toUserId('user_per_side_draft'));
}

function sketch(
  document: ProjectDocument,
  objects: SketchObjectData[] = [SQUARE],
  offset = 0
) {
  return addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset },
    objects
  });
}

describe('F01 per-side draft', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function derive(document: ProjectDocument) {
    return adapter.syncDocument(document);
  }

  function extrude(
    patch: Record<string, unknown>,
    objects: SketchObjectData[] = [SQUARE],
    document = project('Draft')
  ) {
    const sketched = sketch(document, objects);
    const result = extrudeSketch(sketched.document, {
      name: 'Boss',
      sketchId: sketched.sketchId,
      distance: 10,
      ...patch
    });
    return { ...result, sketched };
  }

  describe('document contract', () => {
    it('stores both drafts as given on a symmetric extrude, at the current schema', () => {
      const result = extrude({
        symmetric: true,
        draftAngleDeg: 2,
        backDraftAngleDeg: 3
      });
      expect(listFeaturesInOrder(result.document).at(-1)!.data).toMatchObject({
        symmetric: true,
        draftAngleDeg: 2,
        backDraftAngleDeg: 3
      });
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(126);
      expect(result.document.schemaVersion).toBe(
        PROJECT_DOCUMENT_SCHEMA_VERSION
      );
    });

    it('drops a zero back draft, and opens a drafted extrude byte for byte', () => {
      expect(
        listFeaturesInOrder(
          extrude({ symmetric: true, backDraftAngleDeg: 0 }).document
        ).at(-1)!.data
      ).not.toHaveProperty('backDraftAngleDeg');
      for (const patch of [
        { draftAngleDeg: 2 },
        { backDistance: 4, backDraftAngleDeg: 'taper' }
      ]) {
        const saved = JSON.parse(
          JSON.stringify(extrude(patch).document)
        ) as ProjectDocument;
        expect(JSON.stringify(normalizeDocument(saved))).toBe(
          JSON.stringify(saved)
        );
      }
    });

    it.each([
      [{ backDraftAngleDeg: 2 }, /Back draft tapers the side behind/],
      // Review: a negative back distance is no back side.
      [
        { backDistance: -2, backDraftAngleDeg: 3 },
        /Back draft tapers the side behind/
      ],
      [
        { backDistance: 0, backDraftAngleDeg: 2 },
        /Back draft tapers the side behind/
      ],
      [
        { symmetric: true, backDraftAngleDeg: 89 },
        /Back draft angle must be between -89 and 89/
      ],
      [
        { symmetric: true, backDraftAngleDeg: ' ' },
        /Back draft angle must be a number or an expression/
      ]
    ])('refuses %o at entry', (patch, message) => {
      expect(() => extrude(patch)).toThrow(message);
    });

    it('refuses a draft on a through-all cut, as before', () => {
      const block = addPrimitiveFeature(project('Through'), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      expect(() =>
        extrude(
          {
            operation: 'cut',
            targetBodyId: block.bodyOrder.at(-1)!,
            endCondition: 'through-all',
            throughAllSide: 'both',
            draftAngleDeg: 2
          },
          [SQUARE],
          block
        )
      ).toThrow(/through-all cut has no draft/);
    });

    it('refuses clearing the back side while a back draft stays behind', () => {
      const result = extrude({ backDistance: 4, backDraftAngleDeg: 2 });
      const featureId = listFeaturesInOrder(result.document).at(-1)!.featureId;
      expect(() =>
        updateFeature(result.document, {
          featureId,
          data: { backDistance: 0 }
        })
      ).toThrow(/Back draft tapers the side behind/);
    });

    it('rewrites a back draft expression when its parameter is renamed', () => {
      const result = extrude(
        { symmetric: true, backDraftAngleDeg: 'taper' },
        [SQUARE],
        setParameter(project('Rename'), { name: 'taper', expression: '2' })
      );
      const renamed = renameParameter(result.document, {
        name: 'taper',
        newName: 'slope'
      });
      expect(listFeaturesInOrder(renamed).at(-1)!.data).toMatchObject({
        backDraftAngleDeg: 'slope'
      });
    });
  });

  describe('exact build', () => {
    it.each([
      [
        'a symmetric front draft with a straight back',
        { symmetric: true, draftAngleDeg: 2 },
        squareSide(5, 2) + 16 * 5,
        -5,
        5
      ],
      [
        'the same draft on both symmetric sides',
        { symmetric: true, draftAngleDeg: 2, backDraftAngleDeg: 2 },
        2 * squareSide(5, 2),
        -5,
        5
      ],
      [
        'a straight front with a back draft only',
        { symmetric: true, backDraftAngleDeg: 3 },
        16 * 5 + squareSide(5, 3),
        -5,
        5
      ],
      [
        'a two-sided taper and flare',
        { backDistance: 6, draftAngleDeg: 3, backDraftAngleDeg: -2 },
        squareSide(10, 3) + squareSide(6, -2),
        -6,
        10
      ],
      [
        'a reversed two-sided extrusion',
        {
          distance: -10,
          backDistance: 6,
          draftAngleDeg: 3,
          backDraftAngleDeg: 1
        },
        squareSide(10, 3) + squareSide(6, 1),
        -10,
        6
      ],
      [
        'drafted sides about a start plane',
        {
          symmetric: true,
          startOffset: 5,
          draftAngleDeg: 2,
          backDraftAngleDeg: 2
        },
        2 * squareSide(5, 2),
        0,
        10
      ]
    ])('builds %s', async (_label, patch, volume, minZ, maxZ) => {
      const result = extrude(patch);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(volume, 5);
      expect(body.bbox.min.z).toBeCloseTo(minZ, 9);
      expect(body.bbox.max.z).toBeCloseTo(maxZ, 9);
    });

    it('builds a round profile drafted on one side and straight on the other', async () => {
      const result = extrude({ backDistance: 4, draftAngleDeg: 2 }, [CIRCLE]);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        circleSide(10, 2) + Math.PI * 9 * 4,
        4
      );
    });

    it('keeps a barely drafted round back side beside a straight front (review)', async () => {
      const result = extrude({ backDistance: 4, backDraftAngleDeg: 0.001 }, [
        CIRCLE
      ]);
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        Math.PI * 9 * 10 + circleSide(4, 0.001),
        5
      );
    });

    it('builds a round profile as two cone frustums', async () => {
      const result = extrude(
        { backDistance: 4, draftAngleDeg: 2, backDraftAngleDeg: 5 },
        [CIRCLE]
      );
      const derived = await derive(result.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        circleSide(10, 2) + circleSide(4, 5),
        4
      );
    });

    it('follows a parameter back draft, with nothing derived stored', async () => {
      const result = extrude(
        { symmetric: true, backDraftAngleDeg: 'taper' },
        [SQUARE],
        setParameter(project('Taper'), { name: 'taper', expression: '1' })
      );
      const steeper = setParameter(result.document, {
        name: 'taper',
        expression: '4'
      });
      const derived = await derive(steeper);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        16 * 5 + squareSide(5, 4),
        5
      );
      expect(listFeaturesInOrder(steeper).at(-1)!.data).toMatchObject({
        distance: 10,
        backDraftAngleDeg: 'taper'
      });
    });

    it('refuses a back taper that closes the section by name', async () => {
      // 4 wide, 2 per side: tan(30°) × 4 > 2, so the back side closes up.
      const result = extrude({
        backDistance: 4,
        backDraftAngleDeg: 30
      });
      const derived = await derive(result.document);
      expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
      expect(derived.warnings.join('\n')).toMatch(
        /Extrude "Boss" \(back side\)/
      );
    });

    it('cuts a drafted pocket with the side inside the block', async () => {
      const block = addPrimitiveFeature(project('Pocket'), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      const blockId: BodyId = block.bodyOrder.at(-1)!;
      const sketched = sketch(block, [SQUARE], 10);
      const cut = extrudeSketch(sketched.document, {
        name: 'Pocket',
        sketchId: sketched.sketchId,
        distance: 3,
        backDistance: 4,
        backDraftAngleDeg: 5,
        operation: 'cut',
        targetBodyId: blockId
      });
      const derived = await derive(cut.document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[cut.bodyId]!.volume).toBeCloseTo(
        20 * 20 * 10 - squareSide(4, 5),
        5
      );
    });
  });

  describe('edits and undo', () => {
    it('round-trips a back draft through the edit command and clears it', async () => {
      const result = extrude({ symmetric: true, draftAngleDeg: 2 });
      const feature = listFeaturesInOrder(result.document).at(-1)!;
      const value = {
        name: 'Boss',
        sketchId: result.sketched.sketchId,
        distance: 10,
        symmetric: true,
        choice: { operation: 'new-body' as const },
        draftAngleDeg: 2
      };
      const manager = new CommandManager(result.document);
      manager.execute(
        extrudeEditCommand(feature, { ...value, backDraftAngleDeg: 3 })
      );
      const edited = listFeaturesInOrder(manager.document).at(-1)!;
      expect(edited.data).toMatchObject({ backDraftAngleDeg: 3 });
      expect(extrudeEditInitial(edited)).toMatchObject({
        draftAngleDeg: 2,
        backDraftAngleDeg: 3
      });
      let derived = await derive(manager.document);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        squareSide(5, 2) + squareSide(5, 3),
        5
      );
      manager.execute(extrudeEditCommand(edited, value));
      expect(
        listFeaturesInOrder(manager.document).at(-1)!.data
      ).not.toHaveProperty('backDraftAngleDeg');
      manager.undo();
      manager.undo();
      expect(
        listFeaturesInOrder(manager.document).at(-1)!.data
      ).not.toHaveProperty('backDraftAngleDeg');
      derived = await derive(manager.document);
      expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
        squareSide(5, 2) + 16 * 5,
        5
      );
    });
  });

  describe('editor rules', () => {
    const sketchId = 'sketch_layout' as never;
    const ctx: ExtrudeDraftContext = {
      scope: { taper: 2 },
      units: 'mm',
      initial: { name: 'Extrude', sketchId, distance: 0 },
      bodies: []
    };
    const base = {
      ...initialExtrudeDraft(ctx.initial, true),
      choice: { operation: 'new-body' as const },
      distance: '10'
    };

    it('drafts a symmetric or two-sided extrusion and sends the back draft', () => {
      expect(
        extrudeDraftRefusal(
          { ...base, symmetric: true, draftAngle: '2' },
          ctx,
          true
        )
      ).toBeNull();
      expect(
        extrudeDraftValue(
          {
            ...base,
            backDistance: '4',
            draftAngle: '2',
            backDraftAngle: 'taper'
          },
          ctx
        )
      ).toMatchObject({ draftAngleDeg: 2, backDraftAngleDeg: 'taper' });
      expect(
        extrudeDraftValue(
          { ...base, symmetric: true, backDraftAngle: '0' },
          ctx
        )
      ).not.toHaveProperty('backDraftAngleDeg');
    });

    it('holds a back draft without a back side, and refuses one that does not evaluate', () => {
      // Review: a hidden back draft never blocks the edit; it is held, not
      // sent, until a back side returns.
      const held = { ...base, backDraftAngle: '2' };
      expect(extrudeDraftRefusal(held, ctx, true)).toBeNull();
      expect(extrudeDraftValue(held, ctx)).not.toHaveProperty(
        'backDraftAngleDeg'
      );
      expect(
        extrudeDraftValue({ ...held, symmetric: true }, ctx)
      ).toMatchObject({ backDraftAngleDeg: 2 });
      // A negative back distance is no back side (review).
      expect(
        extrudeFormValue({ ...held, backDistance: '-2' }, ctx)
      ).not.toHaveProperty('backDraftAngleDeg');
      expect(
        extrudeShownValues({
          extent: 'blind',
          symmetric: false,
          backDistance: -2
        })
      ).not.toContain('backDraftAngle');
      expect(
        extrudeDraftRefusal(
          { ...base, symmetric: true, backDraftAngle: 'nope' },
          ctx,
          true
        )
      ).toMatch(/^Back draft angle: /);
      expect(
        extrudeDraftRefusal(
          { ...base, symmetric: true, backDraftAngle: '89' },
          ctx,
          true
        )
      ).toMatch(/Back draft must be between/);
    });

    it('offers the back draft only with a back side, and the draft rig except through all', () => {
      expect(
        extrudeShownValues({ extent: 'blind', symmetric: true })
      ).toContain('backDraftAngle');
      expect(
        extrudeShownValues({
          extent: 'blind',
          symmetric: false,
          backDistance: 4
        })
      ).toContain('backDraftAngle');
      expect(
        extrudeShownValues({
          extent: 'blind',
          symmetric: false,
          backDistance: 0
        })
      ).not.toContain('backDraftAngle');
      expect(
        extrudeShownValues({ extent: 'to-face', symmetric: false })
      ).not.toContain('backDraftAngle');
      const handle = {
        extent: 'blind' as const,
        symmetric: true,
        distance: 10,
        backDistance: 0,
        draftAngle: 0
      };
      expect(extrudeTakesDraft(handle)).toBe(true);
      expect(extrudeTakesDraft({ ...handle, extent: 'through-all' })).toBe(
        false
      );
    });

    it('reads both drafts in the history row', () => {
      const row = (data: Record<string, unknown>) =>
        featureValueSummary(
          {
            featureId: 'feat_boss',
            name: 'Boss',
            data: { featureKind: 'extrude', distance: 10, ...data }
          } as never,
          {},
          'mm'
        );
      expect(
        row({ symmetric: true, draftAngleDeg: 2, backDraftAngleDeg: 3 })
      ).toBe('10 mm symmetric · 2° draft · 3° back draft');
      expect(row({ backDistance: 4, backDraftAngleDeg: -1 })).toBe(
        '10 + 4 mm · -1° back draft'
      );
    });
  });
});
