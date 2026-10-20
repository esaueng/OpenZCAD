import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ProjectDocument,
  type SketchId,
  type SketchObjectData,
  type UnitSystem
} from '@openzcad/shared';
import {
  EXCHANGE_LOSS_CONTRACT,
  type SolidFormatContract,
  type SolidProperty
} from './support/exchange-loss-contract';
import {
  exportSolids,
  measureSketchSvg,
  reimportSolids,
  roundTripSketchDxf,
  sketchCoordinates,
  type SolidExchangeFormat,
  type SolidMeasure
} from './support/exchange-harness';

/**
 * Every exchange format against its written loss contract (ZC-202): export
 * a known model through the app's adapter, read it back the way the app
 * imports it, and check each property the contract says survives — and each
 * it says is dropped. The model is closed-form: a 20 × 10 × 5 block and an
 * R5 × 10 pin, 1000 + 250π mm³, spanning (0, −5, 0)–(45, 10, 10).
 */

const DEFLECTION = 0.08;
const VOLUME = 1000 + 250 * Math.PI;
const BOUNDS = { min: [0, -5, 0], max: [45, 10, 10] };
/** The pin's curved wall: the most a chordal mesh can lose is area × chord. */
const CURVED_AREA = 2 * Math.PI * 5 * 10;

const SOLID_FORMATS: [SolidExchangeFormat, SolidFormatContract][] = (
  ['step', 'stl-binary', 'stl', '3mf', 'obj', 'ply', 'glb'] as const
).map((format) => [format, EXCHANGE_LOSS_CONTRACT[format]]);

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});

async function referenceModel(units: UnitSystem = 'mm') {
  const scale = units === 'inch' ? 1 / 25.4 : units === 'cm' ? 0.1 : 1;
  let document = createProjectDocument(
    'Exchange',
    toUserId('user_exchange'),
    units
  );
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20 * scale, height: 10 * scale, depth: 5 * scale }
  });
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 5 * scale, height: 10 * scale }
  });
  document = transformBody(document, {
    name: 'Place the pin',
    targetBodyId: document.bodyOrder.at(-1)!,
    translation: { x: 40 * scale, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
  const derived = await adapter.syncDocument(document);
  expect(derived.warnings).toEqual([]);
  const synced: ProjectDocument = { ...document, derived };
  const bodyIds = [...derived.exportableBodyIds];
  expect(bodyIds).toHaveLength(2);
  const bodyNames = bodyIds.map(
    (bodyId) => derived.bodyRepresentations[bodyId]!.name
  );
  return { document: synced, bodyIds, bodyNames };
}

function expectBounds(measure: SolidMeasure, tolerance: number) {
  for (let axis = 0; axis < 3; axis += 1) {
    expect(
      Math.abs(measure.bounds.min[axis]! - BOUNDS.min[axis]!)
    ).toBeLessThanOrEqual(tolerance);
    expect(
      Math.abs(measure.bounds.max[axis]! - BOUNDS.max[axis]!)
    ).toBeLessThanOrEqual(tolerance);
  }
}

/** One contract property, checked against a measured reimport. */
function checkSolidProperty(
  property: SolidProperty,
  kept: boolean,
  measure: SolidMeasure,
  context: { format: SolidExchangeFormat; units: UnitSystem; exact: boolean }
) {
  const tolerance = context.exact ? 1e-6 : DEFLECTION + 1e-4;
  switch (property) {
    case 'body-count':
      expect(measure.bodyCount).toBe(kept ? 2 : 1);
      return;
    case 'bounds':
      expectBounds(measure, tolerance);
      return;
    case 'volume':
      if (context.exact) {
        expect(measure.volume).toBeCloseTo(VOLUME, 3);
      } else {
        // Chords sit inside the wall: the mesh loses volume, bounded by
        // the curved area times the chord tolerance, and never gains it.
        expect(measure.volume).toBeLessThanOrEqual(VOLUME + 1e-3);
        expect(VOLUME - measure.volume).toBeLessThanOrEqual(
          CURVED_AREA * DEFLECTION
        );
      }
      return;
    case 'watertight':
      expect(measure.watertight).toBe(kept);
      return;
    case 'exact-faces':
      expect(measure.exactFaces).toBe(kept);
      return;
    case 'declared-units': {
      const expected =
        context.format === 'glb' ? 'm' : kept ? context.units : null;
      expect(measure.declaredUnits).toBe(expected);
      return;
    }
    case 'body-names':
      expect(measure.bodyNames).toBe(kept);
      return;
    case 'body-colors':
      expect(measure.bodyColors).toBe(kept);
      return;
    case 'history':
      // No neutral format carries features: the reimport is geometry.
      expect(kept).toBe(false);
      return;
  }
}

describe(
  'export → reimport against the loss contract',
  { timeout: 120_000 },
  () => {
    it('lists every format the exporters write, and nothing else', () => {
      const contracted = Object.keys(EXCHANGE_LOSS_CONTRACT).sort();
      expect(contracted).toEqual(
        [
          '3mf',
          'dxf',
          'glb',
          'obj',
          'ply',
          'step',
          'stl',
          'stl-binary',
          'svg'
        ].sort()
      );
      for (const [format, contract] of Object.entries(EXCHANGE_LOSS_CONTRACT)) {
        const keeps = new Set<string>(contract.keeps);
        // A property is kept or dropped, never both, and every drop says why.
        for (const dropped of contract.drops) {
          expect(keeps.has(dropped), `${format} ${dropped}`).toBe(false);
          expect(
            (contract.notes as Record<string, string | undefined>)[dropped],
            `${format} ${dropped}`
          ).toBeTruthy();
        }
      }
    });

    it('keeps the prose contract in step with the table', () => {
      const prose = readFileSync(
        new URL('../docs/exchange-loss-contract.md', import.meta.url),
        'utf8'
      );
      for (const contract of Object.values(EXCHANGE_LOSS_CONTRACT)) {
        expect(prose).toContain(contract.label);
      }
    });

    for (const [format, contract] of SOLID_FORMATS) {
      for (const units of ['mm', 'inch'] as const) {
        it(`${contract.label} written in ${units} keeps and drops what the contract says`, async () => {
          const { document, bodyIds, bodyNames } = await referenceModel();
          const bytes = await exportSolids(adapter, document, bodyIds, format, {
            units,
            deflection: DEFLECTION
          });
          // The import is told the export unit where the file cannot say it —
          // the choice the unitless-import prompt asks the user to make.
          const measure = await reimportSolids(format, bytes, {
            reading: units,
            bodyNames
          });
          const context = { format, units, exact: format === 'step' };
          for (const property of contract.keeps) {
            checkSolidProperty(property, true, measure, context);
          }
          for (const property of contract.drops) {
            checkSolidProperty(property, false, measure, context);
          }
        });
      }
    }

    it('keeps every body a separate object inside a 3MF package, though the import merges them', async () => {
      const { document, bodyIds } = await referenceModel();
      const measure = await reimportSolids(
        '3mf',
        await exportSolids(adapter, document, bodyIds, '3mf')
      );
      expect(measure.fileObjects).toBe(2);
      expect(measure.bodyCount).toBe(1);
    });

    it('writes the same physical part from an inch project as from a millimetre one', async () => {
      const mm = await referenceModel('mm');
      const inch = await referenceModel('inch');
      for (const [format] of SOLID_FORMATS) {
        for (const units of ['mm', 'inch'] as const) {
          const fromInch = await reimportSolids(
            format,
            await exportSolids(adapter, inch.document, inch.bodyIds, format, {
              units
            }),
            { reading: units }
          );
          const fromMm = await reimportSolids(
            format,
            await exportSolids(adapter, mm.document, mm.bodyIds, format, {
              units
            }),
            { reading: units }
          );
          for (let axis = 0; axis < 3; axis += 1) {
            expect(fromInch.bounds.min[axis]).toBeCloseTo(
              fromMm.bounds.min[axis]!,
              3
            );
            expect(fromInch.bounds.max[axis]).toBeCloseTo(
              fromMm.bounds.max[axis]!,
              3
            );
          }
        }
      }
    });

    it('round-trips a 25.4 mm STEP block as exactly one inch', async () => {
      const document = addPrimitiveFeature(
        createProjectDocument('Inch block', toUserId('user_exchange')),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 25.4, height: 25.4, depth: 25.4 }
        }
      );
      const synced = {
        ...document,
        derived: await adapter.syncDocument(document)
      };
      const bodyIds = [...synced.derived.exportableBodyIds];
      const step = await adapter.exportStep(synced, bodyIds, { units: 'inch' });
      // The numbers in the file are inches: the far corner is (1, 1, 1), to
      // the last bit of the scale (25.4 × (1 / 25.4) is 1 − 1 ulp in doubles).
      const coordinates = [
        ...step.matchAll(/CARTESIAN_POINT\('[^']*',\s*\(([^)]*)\)\)/g)
      ].flatMap(([, list]) => list!.split(',').map(Number));
      expect(coordinates.length).toBeGreaterThan(0);
      expect(Math.max(...coordinates)).toBeCloseTo(1, 12);
      expect(step).toContain("CONVERSION_BASED_UNIT('INCH'");
      // The reader converts the declared inch back to 25.4 mm.
      const measure = await reimportSolids(
        'step',
        new TextEncoder().encode(step)
      );
      expect(measure.declaredUnits).toBe('inch');
      expect(measure.bounds.max[0]).toBeCloseTo(25.4, 6);
      expect(measure.volume).toBeCloseTo(25.4 ** 3, 3);
    });

    it('states centimetres and metres as SI lengths', async () => {
      const { document, bodyIds } = await referenceModel();
      for (const units of ['cm', 'm'] as const) {
        const measure = await reimportSolids(
          'step',
          await exportSolids(adapter, document, bodyIds, 'step', { units })
        );
        expect(measure.declaredUnits).toBe(units);
        expectBounds(measure, 1e-6);
      }
    });
  }
);

describe(
  'sketch exchange against the loss contract',
  { timeout: 120_000 },
  () => {
    const objects: SketchObjectData[] = [
      { objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 0 },
      { objectKind: 'line', x1: 30, y1: 0, x2: 30, y2: 20 },
      { objectKind: 'circle', centerX: 10, centerY: 10, radius: 5 },
      {
        objectKind: 'arc',
        centerX: 30,
        centerY: 10,
        radius: 4,
        startAngleDeg: 0,
        endAngleDeg: 90
      },
      // Reference geometry the drawing must not carry.
      { objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 20, construction: true }
    ];

    function sketchDocument(units: UnitSystem): {
      document: ProjectDocument;
      sketchId: SketchId;
    } {
      const scale = units === 'inch' ? 1 / 25.4 : 1;
      const scaled = objects.map((object) => {
        switch (object.objectKind) {
          case 'line':
            return {
              ...object,
              x1: Number(object.x1) * scale,
              y1: Number(object.y1) * scale,
              x2: Number(object.x2) * scale,
              y2: Number(object.y2) * scale
            };
          case 'circle':
          case 'arc':
            return {
              ...object,
              centerX: Number(object.centerX) * scale,
              centerY: Number(object.centerY) * scale,
              radius: Number(object.radius) * scale
            };
          default:
            return object;
        }
      });
      return addSketchFeature(
        createProjectDocument(
          'Sketch exchange',
          toUserId('user_exchange'),
          units
        ),
        {
          name: 'Profile',
          planeRef: { type: 'canonical', plane: 'XZ', offset: 3 },
          objects: scaled
        }
      );
    }

    const expected = sketchCoordinates(objects, 1);
    const expectedKinds = { line: 2, circle: 1, arc: 1 };

    for (const units of ['mm', 'inch'] as const) {
      it(`DXF written in ${units} comes back as the same curves, constraints and plane dropped`, async () => {
        const contract = EXCHANGE_LOSS_CONTRACT.dxf;
        expect(contract.keeps).toEqual([
          'curve-kinds',
          'coordinates',
          'declared-units'
        ]);
        for (const documentUnits of ['mm', 'inch'] as const) {
          const { document, sketchId } = sketchDocument(documentUnits);
          const measure = await roundTripSketchDxf(
            adapter,
            document,
            sketchId,
            units
          );
          expect(measure.kinds).toEqual(expectedKinds);
          expect(measure.declaredUnits).toBe(units);
          expect(measure.coordinates).toHaveLength(expected.length);
          measure.coordinates.forEach((value, index) =>
            // The writer's nine decimals are 25 pm in inches, 1 pm in mm.
            expect(value).toBeCloseTo(expected[index]!, 7)
          );
          // Dropped: the construction line, and the XZ plane at offset 3 —
          // the file's coordinates are sketch-local, so nothing says where.
          expect(measure.text).not.toMatch(/\bXZ\b/);
        }
      });
    }

    it('DXF in inches writes inch numbers, not millimetres', async () => {
      const { document, sketchId } = sketchDocument('mm');
      const { text } = await roundTripSketchDxf(
        adapter,
        document,
        sketchId,
        'inch'
      );
      // 30 mm is 1.1811… in; the header says inches and an imperial drawing.
      expect(text).toMatch(/\$INSUNITS\r\n\s*70\r\n\s*1\r\n/);
      expect(text).toMatch(/\$MEASUREMENT\r\n\s*70\r\n\s*0\r\n/);
      // The first line ends at x = 30 mm: group 11 carries it, in inches.
      expect(text).toMatch(/\r\n11\r\n1\.181102362\r\n/);
      expect(text).not.toMatch(/\r\n11\r\n30\r\n/);
    });

    it('SVG states its physical size and keeps the curves, though nothing reads it back', async () => {
      const contract = EXCHANGE_LOSS_CONTRACT.svg;
      expect(contract.reimport).toBe(false);
      const { document, sketchId } = sketchDocument('mm');
      const measure = await measureSketchSvg(adapter, document, sketchId);
      expect(measure.kinds).toEqual(expectedKinds);
      expect(measure.declaredUnits).toBe('mm');
      // Lines and the circle compare directly; the arc is a path command.
      const direct = sketchCoordinates(
        objects.filter((object) => object.objectKind !== 'arc'),
        1
      );
      measure.coordinates.forEach((value, index) =>
        expect(value).toBeCloseTo(direct[index]!, 6)
      );
      // The drawing's box: x 0–34 (the arc reaches 34), y 0–20, plus half a
      // stroke of margin on each side.
      expect(measure.physicalSize![0]).toBeGreaterThan(34);
      expect(measure.physicalSize![0]).toBeLessThan(34.5);
      expect(measure.physicalSize![1] - 20).toBeCloseTo(
        measure.physicalSize![0] - 34,
        6
      );

      const inch = sketchDocument('inch');
      const inchMeasure = await measureSketchSvg(
        adapter,
        inch.document,
        inch.sketchId
      );
      expect(inchMeasure.declaredUnits).toBe('inch');
      expect(inchMeasure.physicalSize![0]).toBeCloseTo(
        measure.physicalSize![0],
        6
      );
    });
  }
);
