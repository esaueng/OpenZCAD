import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder,
  normalizeDocument,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type ThroughAllSide
} from '@openzcad/shared';
import {
  extrudeDraftValue,
  extrudeShownExtent,
  initialExtrudeDraft,
  type ExtrudeDraftContext
} from '../apps/web/src/lib/extrudeDraft';
import { regionExtrudeOutcome } from '../apps/web/src/lib/extrudeInference';

/**
 * F01: an add through all. The extrusion fills the target's whole span
 * along the sketch normal, on the chosen side or both, and joins the target.
 * The plate is 40 × 40 × `plate_t` at z = 0; the 4 × 4 profile straddles its
 * edge at x = 40, so half of it (2 × 4) grows beside the plate. No schema
 * change: an older client refuses an add through all by name.
 */
const PLATE = 40 * 40 * 10;
const BESIDE = 2 * 4;

function plate(thickness: number | string = 10): {
  document: ProjectDocument;
  plateId: BodyId;
} {
  let document = createProjectDocument(
    'Add through all',
    toUserId('user_through_all_add')
  );
  document = setParameter(document, {
    name: 'plate_t',
    expression: String(thickness)
  });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 40, depth: 'plate_t' }
  });
  return { document, plateId: document.bodyOrder[0]! };
}

function add(
  document: ProjectDocument,
  plateId: BodyId,
  side: ThroughAllSide,
  planeZ = 5,
  centerX = 40
) {
  const sketched = addSketchFeature(document, {
    name: 'Tab sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: planeZ },
    objects: [
      { objectKind: 'rectangle', width: 4, height: 4, centerX, centerY: 20 }
    ]
  });
  return extrudeSketch(sketched.document, {
    name: 'Tab',
    sketchId: sketched.sketchId,
    distance: 1,
    operation: 'add',
    targetBodyId: plateId,
    endCondition: 'through-all',
    throughAllSide: side
  });
}

describe('F01 add through all', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  it('stores the add with its side, loading byte for byte', () => {
    const { document, plateId } = plate();
    const result = add(document, plateId, 'both');
    expect(listFeaturesInOrder(result.document).at(-1)!.data).toMatchObject({
      operation: 'add',
      endCondition: 'through-all',
      throughAllSide: 'both'
    });
    const saved = JSON.parse(
      JSON.stringify(result.document)
    ) as ProjectDocument;
    expect(JSON.stringify(normalizeDocument(saved))).toBe(
      JSON.stringify(saved)
    );
  });

  it.each([
    ['new-body', /available for a cut or an add only/],
    ['intersect', /available for a cut or an add only/]
  ])('refuses through all on %s at entry', (operation, message) => {
    const { document, plateId } = plate();
    const sketched = addSketchFeature(document, {
      name: 'S',
      planeRef: { type: 'canonical', plane: 'XY', offset: 5 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 20,
          centerY: 20
        }
      ]
    });
    expect(() =>
      extrudeSketch(sketched.document, {
        name: 'Bad',
        sketchId: sketched.sketchId,
        distance: 1,
        operation: operation as 'new-body',
        ...(operation === 'new-body' ? {} : { targetBodyId: plateId }),
        endCondition: 'through-all',
        throughAllSide: 'both'
      })
    ).toThrow(message);
  });

  it('fills the whole thickness on both sides and joins the plate', async () => {
    const { document, plateId } = plate();
    const result = add(document, plateId, 'both');
    const derived = await adapter.syncDocument(result.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[result.bodyId]!;
    expect(body.volume).toBeCloseTo(PLATE + BESIDE * 10, 6);
    expect(body.bbox.min.z).toBeCloseTo(0, 9);
    expect(body.bbox.max.z).toBeCloseTo(10, 9);
    expect(body.bbox.max.x).toBeCloseTo(42, 9);
  });

  it.each([
    ['forward', 5, 10],
    ['backward', 5, 0]
  ] as const)(
    'fills %s from the sketch to the far side of the plate',
    async (side, planeZ, end) => {
      const { document, plateId } = plate();
      const result = add(document, plateId, side, planeZ);
      const derived = await adapter.syncDocument(result.document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      expect(body.volume).toBeCloseTo(PLATE + BESIDE * 5, 6);
      expect(
        side === 'forward' ? body.bbox.max.z : body.bbox.min.z
      ).toBeCloseTo(end, 9);
    }
  );

  it('follows a thicker plate, with no stored depth', async () => {
    const { document, plateId } = plate('plate_t');
    const result = add(
      setParameter(document, { name: 'plate_t', expression: '10' }),
      plateId,
      'both'
    );
    const thicker = setParameter(result.document, {
      name: 'plate_t',
      expression: '16'
    });
    const derived = await adapter.syncDocument(thicker);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[result.bodyId]!.volume).toBeCloseTo(
      40 * 40 * 16 + BESIDE * 16,
      6
    );
    expect(listFeaturesInOrder(thicker).at(-1)!.data).toMatchObject({
      distance: 1
    });
  });

  it('refuses a side the plate does not reach, by name', async () => {
    const { document, plateId } = plate();
    const result = add(document, plateId, 'forward', 20);
    const derived = await adapter.syncDocument(result.document);
    expect(derived.warnings.join('\n')).toMatch(
      /Through-all has no target in the selected direction \(target Plate.*side forward\)/
    );
  });

  describe('editor', () => {
    const plateId = 'body_plate' as BodyId;
    const ctx: ExtrudeDraftContext = {
      scope: {},
      units: 'mm',
      initial: { name: 'Extrude', sketchId: 'sketch_a' as never, distance: 0 },
      bodies: [{ bodyId: plateId, name: 'Plate' }]
    };

    it('offers Through all on Add and sends it with its side', () => {
      const draft = {
        ...initialExtrudeDraft(ctx.initial, true),
        choice: { operation: 'add' as const, targetBodyId: plateId },
        endCondition: 'through-all' as const,
        throughAllSide: 'both' as const
      };
      expect(extrudeShownExtent(draft, ctx)).toBe('through-all');
      expect(extrudeDraftValue(draft, ctx)).toMatchObject({
        endCondition: 'through-all',
        throughAllSide: 'both'
      });
      expect(
        regionExtrudeOutcome(
          {
            inference: { operation: 'add' },
            command: { payload: { endCondition: 'through-all' } }
          },
          1,
          'mm'
        )
      ).toBe(
        'Extruded the region through all of the target, added to the body.'
      );
    });
  });
});
