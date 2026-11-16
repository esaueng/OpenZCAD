import { beforeAll, describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  setNodeMetadata,
  standardPartBody,
  type HoleInput,
  type StandardPartInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  matchedStandardLengthMm,
  standardPartForHole,
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M17 slice 2 (schema v71): standard parts inserted into M01 holes — the
 * size a hole takes, the length matched to it, and the exact parts standing
 * in each bore, following the hole when it changes.
 */

const M6 = { system: 'iso', size: 'M6' } as const;

describe('M17 holes: matching', () => {
  it('sizes a screw by the hole standard and a dowel pin by its diameter', () => {
    expect(
      standardPartForHole(
        'screw',
        {
          standard: { ...M6, kind: 'clearance' },
          diameterMm: 6.6,
          through: true,
          boreMm: 10
        },
        'ansi',
        'hex'
      )
    ).toEqual({ partKind: 'screw', system: 'iso', size: 'M6', head: 'hex' });
    expect(
      standardPartForHole(
        'screw',
        { diameterMm: 6, through: true, boreMm: 10 },
        'iso'
      )
    ).toMatch(/standard hole/);
    expect(
      standardPartForHole(
        'dowel',
        { diameterMm: 6, through: false, boreMm: 15 },
        'iso'
      )
    ).toEqual({ partKind: 'dowel', system: 'iso', size: '6' });
    expect(
      standardPartForHole(
        'dowel',
        { diameterMm: 5.5, through: false, boreMm: 15 },
        'iso'
      )
    ).toMatch(/No ISO dowel pin is 5.5 mm/);
    // A countersunk ISO screw has no M2 row.
    expect(
      standardPartForHole(
        'screw',
        {
          standard: { system: 'iso', size: 'M2', kind: 'clearance' },
          diameterMm: 2.4,
          through: true,
          boreMm: 5
        },
        'iso',
        'countersunk'
      )
    ).toMatch(/no M2/);
  });

  it('matches the preferred length to the hole', () => {
    const screw = { partKind: 'screw', ...M6 } as const;
    // Through a 10 mm clearance hole, past an ISO 4032 nut (5.2) and two
    // pitches: 17.2 needs the 20.
    expect(
      matchedStandardLengthMm(screw, {
        standard: { ...M6, kind: 'clearance' },
        diameterMm: 6.6,
        through: true,
        boreMm: 10
      })
    ).toBe(20);
    // A blind tapped hole 12 deep, tapped 10: the longest within the thread.
    expect(
      matchedStandardLengthMm(screw, {
        standard: { ...M6, kind: 'tap-drill' },
        diameterMm: 5,
        through: false,
        boreMm: 12,
        threadMm: 10
      })
    ).toBe(10);
    // Through a tapped 8 mm plate: never past its far face.
    expect(
      matchedStandardLengthMm(screw, {
        standard: { ...M6, kind: 'tap-drill' },
        diameterMm: 5,
        through: true,
        boreMm: 8.5,
        threadMm: 8.5
      })
    ).toBe(8);
    // A countersunk head's own height is inside its length.
    const flat = { ...screw, head: 'countersunk' } as const;
    expect(
      matchedStandardLengthMm(flat, {
        standard: { ...M6, kind: 'tap-drill' },
        diameterMm: 5,
        through: false,
        boreMm: 12,
        threadMm: 12
      })
    ).toBe(12);
    const dowel = { partKind: 'dowel', system: 'iso', size: '6' } as const;
    expect(
      matchedStandardLengthMm(dowel, {
        diameterMm: 6,
        through: false,
        boreMm: 15
      })
    ).toBe(12);
    expect(
      matchedStandardLengthMm(dowel, {
        diameterMm: 6,
        through: true,
        boreMm: 15
      })
    ).toBe(16);
    expect(
      matchedStandardLengthMm(screw, {
        standard: { ...M6, kind: 'tap-drill' },
        diameterMm: 5,
        through: false,
        boreMm: 3
      })
    ).toMatch(/too shallow/);
  });
});

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

function plate(depth = 10): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Plate', toUserId('user_m17'), 'mm'),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth }
    }
  );
}

function topFace(derived: DerivedState, bodyId: BodyId) {
  const body = derived.bodyRepresentations[bodyId]!;
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 0.999 &&
      Math.abs(
        (face.geometry.centroid ?? face.geometry.center).z - body.bbox.max.z
      ) < 1e-6
  )!;
}

function failures(derived: DerivedState): string {
  const advice = (derived.featureWarnings ?? [])
    .filter((warning) => warning.kind === 'advisory')
    .map((warning) => warning.message);
  return [
    ...derived.warnings.filter(
      (warning) => !advice.some((message) => warning.includes(message))
    ),
    ...(derived.featureWarnings ?? [])
      .filter((warning) => warning.kind !== 'advisory')
      .map((warning) => warning.message)
  ].join('\n');
}

describe('M17 holes: document contract', () => {
  /** A plate with an M6 clearance hole, no geometry needed. */
  function holed(): { document: ProjectDocument; holeId: FeatureId } {
    const document = holeBody(plate(), {
      name: 'Hole 1',
      targetBodyId: last(plate()),
      faceHash: 1,
      style: 'simple',
      diameter: 6.6,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      standard: { ...M6, kind: 'clearance' }
    }).document;
    return {
      document,
      holeId: listFeaturesInOrder(document).at(-1)!.featureId
    };
  }
  const part = (holeId: FeatureId, patch: Partial<StandardPartInput> = {}) =>
    ({
      name: 'Screw',
      partKind: 'screw',
      ...M6,
      origin: { x: 20, y: 20, z: 10 },
      axis: { x: 0, y: 0, z: -1 },
      hole: { featureId: holeId },
      ...patch
    }) as StandardPartInput;

  it('stores a part in a hole, without a length, at schema v71', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
    const { document, holeId } = holed();
    expect(() =>
      commandFactories.standardPartBody(part(holeId)).validate(document)
    ).not.toThrow();
    const next = standardPartBody(document, part(holeId)).document;
    expect(listFeaturesInOrder(next).at(-1)!.data).toMatchObject({
      hole: { featureId: holeId }
    });
    expect(() => assertDocumentContentSchema(next)).not.toThrow();
    const old = {
      ...document,
      schemaVersion: 70
    } as unknown as ProjectDocument;
    expect(() => standardPartBody(old, part(holeId))).toThrow(
      /Parts inserted into holes require project schema v71/
    );
  });

  it('takes a part out of its hole when it is placed on a face', () => {
    const { document, holeId } = holed();
    const inHole = standardPartBody(document, part(holeId)).document;
    const partNode = listFeaturesInOrder(inHole).at(-1)!;
    const onFace = commandFactories
      .updateFeature({
        featureId: partNode.featureId,
        data: {
          featureKind: 'standard-part',
          length: 20,
          origin: { x: 5, y: 5, z: 10 }
        },
        clearData: ['hole']
      })
      .apply(inHole);
    const data = listFeaturesInOrder(onFace).at(-1)!.data;
    expect(data).toMatchObject({ length: 20, origin: { x: 5, y: 5, z: 10 } });
    expect(data).not.toHaveProperty('hole');
    expect(() => assertDocumentContentSchema(onFace)).not.toThrow();
  });

  it.each([
    [
      'a missing hole',
      { hole: { featureId: 'feat_gone' as FeatureId } },
      /into a hole feature/
    ],
    ['the wrong size', { size: 'M8' }, /takes an ISO M6, not M8/],
    ['a nut', { partKind: 'nut' }, /Only a screw or a dowel pin/],
    [
      'an unthreaded dowel size',
      { partKind: 'dowel', size: '6' },
      /No ISO dowel pin is 6.6 mm/
    ]
  ] as const)('refuses %s', (_label, patch, message) => {
    const { document, holeId } = holed();
    expect(() =>
      commandFactories
        .standardPartBody(part(holeId, patch as Partial<StandardPartInput>))
        .validate(document)
    ).toThrow(message);
  });
});

describe('M17 holes: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function drilled(
    document: ProjectDocument,
    extra: Partial<HoleInput>
  ): Promise<{ document: ProjectDocument; holeId: FeatureId }> {
    const derived = await adapter.syncDocument(document);
    const face = topFace(derived, last(document));
    const next = holeBody(document, {
      name: 'Hole 1',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 6.6,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid',
      standard: { ...M6, kind: 'clearance' },
      ...extra
    }).document;
    return {
      document: next,
      holeId: listFeaturesInOrder(next).at(-1)!.featureId
    };
  }

  async function inserted(
    document: ProjectDocument,
    holeId: FeatureId,
    patch: Partial<StandardPartInput> = {}
  ) {
    const next = standardPartBody(document, {
      name: 'Screw',
      partKind: 'screw',
      ...M6,
      // Where it was inserted; the hole's bores decide where it builds.
      origin: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 0, z: 1 },
      hole: { featureId: holeId },
      ...patch
    }).document;
    const derived = await adapter.syncDocument(next);
    expect(failures(derived)).toBe('');
    return { document: next, body: derived.bodyRepresentations[last(next)]! };
  }

  it('stands an M6 screw in a clearance hole at its matched length', async () => {
    const base = plate();
    const { document, holeId } = await drilled(base, {});
    const { body } = await inserted(document, holeId);
    // Head on the top face (z 10, 6 high), 20 long through the 10 plate.
    expect(body.bbox.max.z).toBeCloseTo(16, 6);
    expect(body.bbox.min.z).toBeCloseTo(-10, 6);
    expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(10, 6);
    // The same solid as the screw placed there by hand.
    const plateBody = (await adapter.syncDocument(base)).bodyRepresentations[
      last(base)
    ]!;
    const cx = (plateBody.bbox.min.x + plateBody.bbox.max.x) / 2;
    const cy = (plateBody.bbox.min.y + plateBody.bbox.max.y) / 2;
    expect((body.bbox.min.x + body.bbox.max.x) / 2).toBeCloseTo(cx, 6);
    const byHand = await adapter.syncDocument(
      standardPartBody(createProjectDocument('P', toUserId('u'), 'mm'), {
        name: 'Screw',
        partKind: 'screw',
        ...M6,
        length: 20,
        origin: { x: cx, y: cy, z: 10 },
        axis: { x: 0, y: 0, z: -1 }
      }).document
    );
    expect(body.volume).toBeCloseTo(
      Object.values(byHand.bodyRepresentations)[0]!.volume,
      6
    );
  }, 900_000);

  it('seats on a counterbore floor and keeps a dragged length', async () => {
    const { document, holeId } = await drilled(plate(20), {
      style: 'counterbore',
      counterboreDiameter: 11,
      counterboreDepth: 6.5
    });
    const { body } = await inserted(document, holeId, { length: 25 });
    // The seat is 6.5 below the top (z 20): the head reaches 13.5 + 6.
    expect(body.bbox.max.z).toBeCloseTo(13.5 + 6, 6);
    expect(body.bbox.min.z).toBeCloseTo(13.5 - 25, 6);
  }, 900_000);

  it('stops short in a blind tapped hole, and follows the hole when it moves', async () => {
    const tapDrill = { ...M6, kind: 'tap-drill' } as const;
    const { document, holeId } = await drilled(plate(20), {
      depthMode: 'blind',
      depth: 12,
      diameter: 5,
      standard: tapDrill,
      tapped: { length: 10 }
    });
    const first = await inserted(document, holeId);
    // The longest preferred length within the 10 mm thread.
    expect(first.body.bbox.min.z).toBeCloseTo(10, 6);
    // Move the hole 5 along U: the screw goes with it.
    const hole = listFeaturesInOrder(first.document).find(
      (feature) => feature.featureId === holeId
    )!;
    const moved = commandFactories
      .updateFeature({
        featureId: holeId,
        data: {
          featureKind: 'hole',
          position: {
            ...(hole.data as { position: { u: number; v: number } }).position,
            u: 5
          }
        }
      })
      .apply(first.document);
    const derived = await adapter.syncDocument(moved);
    expect(failures(derived)).toBe('');
    const after = derived.bodyRepresentations[last(moved)]!;
    const shift = Math.hypot(
      after.bbox.min.x - first.body.bbox.min.x,
      after.bbox.min.y - first.body.bbox.min.y
    );
    expect(shift).toBeCloseTo(5, 6);
  }, 900_000);

  it('puts a part in every bore of a hole on sketch points', async () => {
    const base = plate();
    const sketched = addSketchFeature(base, {
      name: 'Points',
      planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
      objects: [
        { objectKind: 'point', x: 10, y: 10 },
        { objectKind: 'point', x: 30, y: 30 }
      ]
    });
    const pointIds = findSketch(
      sketched.document,
      sketched.sketchId
    )!.objectIds.map(String);
    const { document, holeId } = await drilled(sketched.document, {
      points: { sketchId: sketched.sketchId, pointIds }
    });
    const { body } = await inserted(document, holeId);
    // Two screws, one in each bore, 20 apart along each axis.
    expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(20 + 10, 6);
    const single = await drilled(sketched.document, {
      points: { sketchId: sketched.sketchId, pointIds: [pointIds[0]!] }
    });
    const one = await inserted(single.document, single.holeId);
    expect(body.volume).toBeCloseTo(2 * one.body.volume, 6);
  }, 900_000);

  it('refuses a part in a suppressed hole', async () => {
    const { document, holeId } = await drilled(plate(), {});
    const { document: withScrew } = await inserted(document, holeId);
    const hole = listFeaturesInOrder(withScrew).find(
      (feature) => feature.featureId === holeId
    )!;
    const suppressed = setNodeMetadata(withScrew, {
      nodeId: hole.id,
      metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
    });
    const derived = await adapter.syncDocument(suppressed);
    expect(failures(derived)).toMatch(/The hole this part is in is suppressed/);
  }, 900_000);

  it('fills a blind hole with a dowel pin and refuses a hole resized under it', async () => {
    const { document, holeId } = await drilled(plate(20), {
      depthMode: 'blind',
      depth: 15,
      diameter: 6,
      standard: undefined
    });
    const { body, document: withPin } = await inserted(document, holeId, {
      partKind: 'dowel',
      size: '6'
    });
    expect(body.bbox.min.z).toBeCloseTo(20 - 12, 6);
    const resized = commandFactories
      .updateFeature({
        featureId: holeId,
        data: { featureKind: 'hole', diameter: 7 }
      })
      .apply(withPin);
    const derived = await adapter.syncDocument(resized);
    expect(failures(derived)).toMatch(/No ISO dowel pin is 7 mm/);
  }, 900_000);
});
