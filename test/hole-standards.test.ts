import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  updateFeature,
  type HoleInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  ANSI_HOLE_SIZES,
  ISO_HOLE_SIZES,
  ISO_METRIC_COARSE_THREADS,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  holeStandardDiameterMm,
  holeStandardLabel,
  holeStandardProblem,
  holeStandardThread,
  toUserId,
  type BodyId,
  type DerivedState,
  type HoleStandard,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';

/**
 * M01 standard hole sizes (schema v65): ISO 273 clearance holes and ISO 2306
 * tap drills for ISO 261 coarse threads, and the ANSI close/free clearance
 * and 75% tap drills for UNC threads. The tables are checked against the
 * threads they serve; the builds against closed-form volumes.
 */

const MM_PER_INCH = 25.4;

describe('M01 standard hole tables', () => {
  it('lists every ISO 261 coarse size the threads table has', () => {
    expect(ISO_HOLE_SIZES.map((size) => size)).toEqual(
      ISO_METRIC_COARSE_THREADS.map((size) => `M${size.nominal}`)
    );
    for (const thread of ISO_METRIC_COARSE_THREADS) {
      expect(
        holeStandardThread({ system: 'iso', size: `M${thread.nominal}` })
      ).toEqual({ majorDiameterMm: thread.nominal, pitchMm: thread.pitch });
    }
  });

  it.each([
    ['iso', ISO_HOLE_SIZES],
    ['ansi', ANSI_HOLE_SIZES]
  ] as const)(
    '%s: a tap drill falls between the basic minor diameter and D − P/2',
    (system, sizes) => {
      for (const size of sizes) {
        const { majorDiameterMm: d, pitchMm: p } = holeStandardThread({
          system,
          size
        });
        const drill = holeStandardDiameterMm({
          system,
          size,
          kind: 'tap-drill'
        });
        expect(drill, size).toBeGreaterThanOrEqual(d - 1.0825 * p - 1e-9);
        expect(drill, size).toBeLessThanOrEqual(d - p / 2 + 1e-9);
      }
    }
  );

  it.each([
    ['iso', ISO_HOLE_SIZES, ['close', 'normal', 'loose']],
    ['ansi', ANSI_HOLE_SIZES, ['close', 'normal']]
  ] as const)(
    '%s: a clearance hole clears its screw, each fit wider than the last',
    (system, sizes, fits) => {
      let previousNominal = 0;
      for (const size of sizes) {
        const { majorDiameterMm: d } = holeStandardThread({ system, size });
        expect(d, size).toBeGreaterThan(previousNominal);
        previousNominal = d;
        let previous = d;
        for (const fit of fits) {
          const hole = holeStandardDiameterMm({
            system,
            size,
            kind: 'clearance',
            fit
          });
          expect(hole, `${size} ${fit}`).toBeGreaterThan(previous);
          previous = hole;
        }
      }
    }
  );

  it('reads the tables as the standards print them', () => {
    const mm = (standard: HoleStandard) => holeStandardDiameterMm(standard);
    expect(mm({ system: 'iso', size: 'M6', kind: 'clearance' })).toBe(6.6);
    expect(
      mm({ system: 'iso', size: 'M6', kind: 'clearance', fit: 'close' })
    ).toBe(6.4);
    expect(
      mm({ system: 'iso', size: 'M6', kind: 'clearance', fit: 'loose' })
    ).toBe(7);
    expect(mm({ system: 'iso', size: 'M6', kind: 'tap-drill' })).toBe(5);
    expect(mm({ system: 'iso', size: 'M8', kind: 'tap-drill' })).toBe(6.8);
    expect(
      mm({ system: 'ansi', size: '1/4', kind: 'tap-drill' }) / MM_PER_INCH
    ).toBeCloseTo(0.201, 12);
    expect(
      mm({ system: 'ansi', size: '#10', kind: 'clearance', fit: 'close' }) /
        MM_PER_INCH
    ).toBeCloseTo(0.196, 12);
    expect(holeStandardThread({ system: 'ansi', size: '1/4' })).toEqual({
      majorDiameterMm: 6.35,
      pitchMm: 1.27
    });
  });

  it('names a standard as a drawing would', () => {
    expect(
      holeStandardLabel({ system: 'iso', size: 'M6', kind: 'clearance' })
    ).toBe('M6 clearance (normal)');
    expect(
      holeStandardLabel({ system: 'iso', size: 'M6', kind: 'tap-drill' })
    ).toBe('M6×1 tap drill');
    expect(
      holeStandardLabel({ system: 'ansi', size: '1/4', kind: 'tap-drill' })
    ).toBe('1/4-20 UNC tap drill');
    expect(
      holeStandardLabel({
        system: 'ansi',
        size: '#10',
        kind: 'clearance',
        fit: 'close'
      })
    ).toBe('#10 clearance (close)');
  });

  it.each([
    [{ system: 'bsw', size: 'M6', kind: 'clearance' }, /ISO metric or ANSI/],
    [{ system: 'iso', size: 'M7', kind: 'clearance' }, /M7 is not an ISO/],
    [{ system: 'ansi', size: 'M6', kind: 'clearance' }, /not an ANSI inch/],
    [{ system: 'iso', size: 'M6', kind: 'counterbore' }, /clearance hole or/],
    [
      { system: 'iso', size: 'M6', kind: 'tap-drill', fit: 'close' },
      /Only a clearance hole has a fit/
    ],
    [
      { system: 'ansi', size: '1/4', kind: 'clearance', fit: 'loose' },
      /close and normal fits only/
    ],
    [{ system: 'iso', size: 'toString', kind: 'clearance' }, /not an ISO/]
  ])('refuses %j', (standard, message) => {
    expect(holeStandardProblem(standard)).toMatch(message);
  });
});

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

function plate(units: UnitSystem, size: number, depth: number) {
  return addPrimitiveFeature(
    createProjectDocument('Plate', toUserId('user_m01'), units),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: size, height: size, depth }
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

function warningText(derived: DerivedState): string {
  return [
    ...derived.warnings,
    ...(derived.featureWarnings ?? []).map((warning) => warning.message)
  ].join('\n');
}

function boreRadii(derived: DerivedState, bodyId: BodyId): number[] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.flatMap((face) =>
    face.geometry?.surfaceType === 'cylinder'
      ? [face.geometry.radius ?? NaN]
      : []
  );
}

describe('M01 standard hole sizes: document contract', () => {
  const input = (document: ProjectDocument): HoleInput => ({
    name: 'Hole',
    targetBodyId: last(document),
    faceHash: 1,
    style: 'simple',
    diameter: 6.6,
    depthMode: 'through',
    position: { u: 0, v: 0 },
    standard: { system: 'iso', size: 'M6', kind: 'clearance', fit: 'normal' }
  });

  it('stores the standard at schema v65', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(65);
    const document = plate('mm', 40, 10);
    const holed = holeBody(document, input(document)).document;
    expect(listFeaturesInOrder(holed).at(-1)!.data).toMatchObject({
      standard: { system: 'iso', size: 'M6', kind: 'clearance' }
    });
    expect(() => assertDocumentContentSchema(holed)).not.toThrow();
  });

  it('refuses a standard on a document that declares schema v64', () => {
    const document = plate('mm', 40, 10);
    const old = {
      ...document,
      schemaVersion: 64
    } as unknown as ProjectDocument;
    expect(() => holeBody(old, input(document))).toThrow(
      /Standard hole sizes require project schema v65/
    );
  });

  it('refuses a size the table does not have, on add and on edit', () => {
    const document = plate('mm', 40, 10);
    expect(() =>
      holeBody(document, {
        ...input(document),
        standard: { system: 'iso', size: 'M7', kind: 'clearance' }
      })
    ).toThrow(/M7 is not an ISO metric size/);
    const holed = holeBody(document, input(document)).document;
    const featureId = listFeaturesInOrder(holed).at(-1)!.featureId;
    expect(() =>
      updateFeature(holed, {
        featureId,
        data: {
          featureKind: 'hole',
          standard: {
            system: 'ansi',
            size: '1/4',
            kind: 'clearance',
            fit: 'loose'
          }
        }
      })
    ).toThrow(/close and normal fits only/);
    expect(
      listFeaturesInOrder(
        updateFeature(holed, { featureId, clearData: ['standard'] })
      ).at(-1)!.data
    ).not.toHaveProperty('standard');
  });
});

describe('M01 standard hole sizes: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function drill(
    units: UnitSystem,
    size: number,
    depth: number,
    extra: Partial<HoleInput>
  ) {
    const document = plate(units, size, depth);
    const derived = await adapter.syncDocument(document);
    const face = topFace(derived, last(document));
    return holeBody(document, {
      name: 'Hole',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 6,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid',
      ...extra
    }).document;
  }

  it('drills an ISO clearance hole to its table diameter, not the stored one', async () => {
    // The stored diameter is deliberately wrong: the table is what is read.
    const document = await drill('mm', 40, 10, {
      diameter: 99,
      standard: { system: 'iso', size: 'M6', kind: 'clearance' }
    });
    const derived = await adapter.syncDocument(document);
    expect(warningText(derived)).toBe('');
    expect(boreRadii(derived, last(document))).toEqual([
      expect.closeTo(3.3, 9)
    ]);
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      40 * 40 * 10 - Math.PI * 3.3 ** 2 * 10,
      6
    );
  }, 120_000);

  it('drills a blind ISO tap drill, and returns to the stored diameter when cleared', async () => {
    const document = await drill('mm', 40, 10, {
      depthMode: 'blind',
      depth: 8,
      standard: { system: 'iso', size: 'M8', kind: 'tap-drill' }
    });
    const derived = await adapter.syncDocument(document);
    expect(warningText(derived)).toBe('');
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      40 * 40 * 10 - Math.PI * 3.4 ** 2 * 8,
      6
    );
    const cleared = updateFeature(document, {
      featureId: listFeaturesInOrder(document).at(-1)!.featureId,
      clearData: ['standard']
    });
    const plain = await adapter.syncDocument(cleared);
    expect(boreRadii(plain, last(cleared))).toEqual([expect.closeTo(3, 9)]);
  }, 120_000);

  it('drills an ANSI tap drill in an inch document, in inches', async () => {
    const document = await drill('inch', 2, 0.5, {
      standard: { system: 'ansi', size: '1/4', kind: 'tap-drill' }
    });
    const derived = await adapter.syncDocument(document);
    expect(warningText(derived)).toBe('');
    const [radius] = boreRadii(derived, last(document));
    expect(radius).toBeCloseTo(0.201 / 2, 9);
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      2 * 2 * 0.5 - Math.PI * (0.201 / 2) ** 2 * 0.5,
      9
    );
  }, 120_000);

  it('sizes every bore on sketch points by the table', async () => {
    const base = plate('mm', 40, 10);
    const derived = await adapter.syncDocument(base);
    const face = topFace(derived, last(base));
    const sketched = addSketchFeature(base, {
      name: 'Points',
      planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
      objects: [
        { objectKind: 'point', x: 10, y: 10 },
        { objectKind: 'point', x: 30, y: 30 }
      ]
    });
    const document = holeBody(sketched.document, {
      name: 'Holes',
      targetBodyId: last(base),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 3.3,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      points: {
        sketchId: sketched.sketchId,
        pointIds: findSketch(
          sketched.document,
          sketched.sketchId
        )!.objectIds.map(String)
      },
      standard: { system: 'iso', size: 'M4', kind: 'tap-drill' }
    }).document;
    const built = await adapter.syncDocument(document);
    expect(warningText(built)).toBe('');
    expect(boreRadii(built, last(document))).toEqual([
      expect.closeTo(1.65, 9),
      expect.closeTo(1.65, 9)
    ]);
  }, 120_000);
});
