import { describe, expect, it } from 'vitest';
import {
  declareStepLengthUnit,
  declareThreeMfUnit,
  DEFAULT_MESH_ANGULAR_TOLERANCE,
  DEVIATION_SAMPLE_TRIANGLES,
  explicitAngularTolerance,
  exportLengthScale,
  measureMeshDeviation
} from './export-units';

const STEP = [
  'DATA;',
  '#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
  '#2 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );',
  "#4 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07), #1, 'distance_accuracy_value', 'confusion accuracy');",
  "#40 = CARTESIAN_POINT('', (1., 2., 3.));",
  'ENDSEC;'
].join('\n');

describe('export length scale', () => {
  it('is numbers in the export unit per document number', () => {
    expect(exportLengthScale('mm', 'mm')).toBe(1);
    expect(exportLengthScale('inch', 'mm')).toBe(25.4);
    expect(exportLengthScale('mm', 'inch')).toBeCloseTo(1 / 25.4, 15);
    expect(exportLengthScale('m', 'cm')).toBe(100);
  });
});

describe('declareStepLengthUnit', () => {
  it('leaves a millimetre export byte for byte', () => {
    expect(declareStepLengthUnit(STEP, 'mm')).toBe(STEP);
  });

  it('restates the one length unit as SI centimetres or metres', () => {
    expect(declareStepLengthUnit(STEP, 'cm')).toContain(
      '#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI.,.METRE.) );'
    );
    expect(declareStepLengthUnit(STEP, 'm')).toContain(
      '#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );'
    );
  });

  it('states inches as 25.4 mm through fresh entity ids', () => {
    const inch = declareStepLengthUnit(STEP, 'inch');
    expect(inch).toContain(
      "#1 = ( CONVERSION_BASED_UNIT('INCH',#41) LENGTH_UNIT() NAMED_UNIT(#43) );"
    );
    expect(inch).toContain(
      '#41 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#42);'
    );
    expect(inch).toContain(
      '#42 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );'
    );
    expect(inch).toContain(
      '#43 = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);'
    );
    // The uncertainty and every other reference to #1 now mean inches.
    expect(inch).toContain('LENGTH_MEASURE(1.E-07), #1,');
  });

  it('refuses a writer whose unit it does not recognise, rather than mislabel', () => {
    const changed = STEP.replace('.MILLI.', '.MICRO.');
    expect(() => declareStepLengthUnit(changed, 'inch')).toThrow(
      /could not be restated in inch/
    );
    const twice = `${STEP}\n#99 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`;
    expect(() => declareStepLengthUnit(twice, 'cm')).toThrow(
      /could not be restated/
    );
  });
});

describe('declareThreeMfUnit', () => {
  const model = (attributes: string) =>
    `<?xml version="1.0"?>\n<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${attributes}>\n<resources/></model>`;

  it('rewrites the declared millimetre unit', () => {
    expect(declareThreeMfUnit(model(' unit="millimeter"'), 'inch')).toContain(
      'core/2015/02" unit="inch">'
    );
  });

  it('adds the attribute when the writer relied on the millimetre default', () => {
    expect(declareThreeMfUnit(model(''), 'cm')).toContain(
      '<model unit="centimeter" xmlns='
    );
  });

  it('refuses a package already declared in another unit', () => {
    expect(() => declareThreeMfUnit(model(' unit="inch"'), 'mm')).toThrow(
      /declared "inch"/
    );
  });
});

describe('explicitAngularTolerance', () => {
  it('sends nothing for the kernel default, so the writers take their own path', () => {
    expect(explicitAngularTolerance(undefined)).toBeNull();
    expect(explicitAngularTolerance(DEFAULT_MESH_ANGULAR_TOLERANCE)).toBeNull();
    expect(explicitAngularTolerance(0.1)).toBe(0.1);
  });

  it('refuses angles that are not a usable tolerance', () => {
    expect(() => explicitAngularTolerance(0)).toThrow(/positive/);
    expect(() => explicitAngularTolerance(Number.NaN)).toThrow(/positive/);
    expect(() => explicitAngularTolerance(2)).toThrow(/90°/);
  });
});

describe('measureMeshDeviation', () => {
  // Two faces: a plane (face 7) and a curved face (face 9), one triangle each.
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1];
  const indices = [0, 1, 2, 3, 4, 5];

  it('measures every corner, and curved faces at centroids and edge midpoints too', () => {
    const asked: string[] = [];
    const result = measureMeshDeviation({
      positions,
      indices,
      faceOffsets: [0, 3, 6],
      faces: [7, 9],
      isPlanar: (face) => face === 7,
      distance: (x, y, z, face) => {
        asked.push(`${face}:${x},${y},${z}`);
        return 0.25;
      }
    });
    // The plane: its three stored corners. The curved face: three corners,
    // the centroid and three edge midpoints.
    expect(asked.filter((entry) => entry.startsWith('7:'))).toEqual([
      '7:0,0,0',
      '7:1,0,0',
      '7:0,1,0'
    ]);
    expect(asked.filter((entry) => entry.startsWith('9:'))).toHaveLength(7);
    expect(result).toEqual({
      maxDeviation: 0.25,
      sampledTriangles: 2,
      totalTriangles: 2
    });
  });

  it('reports a planar facet whose stored corner is off its plane', () => {
    // Float32 corners of a tilted or distant plane can miss it; skipping
    // planes would report 0 for a file whose facets are not exact.
    const result = measureMeshDeviation({
      positions,
      indices: [0, 1, 2],
      faceOffsets: [0, 3],
      faces: [7],
      isPlanar: () => true,
      distance: (x) => (x === 1 ? 0.3 : 0)
    });
    expect(result.maxDeviation).toBe(0.3);
  });

  it('measures a corner shared by two facets of one face once', () => {
    let calls = 0;
    measureMeshDeviation({
      positions,
      indices: [0, 1, 2, 0, 2, 3],
      faceOffsets: [0, 6],
      faces: [7],
      isPlanar: () => true,
      distance: () => {
        calls += 1;
        return 0;
      }
    });
    expect(calls).toBe(4);
  });

  it('strides past the sample budget and says how many it measured', () => {
    const triangles = DEVIATION_SAMPLE_TRIANGLES * 2 + 1;
    const result = measureMeshDeviation({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: Array.from({ length: triangles * 3 }, (_, i) => i % 3),
      faceOffsets: [0, triangles * 3],
      faces: [1],
      isPlanar: () => false,
      distance: () => 0
    });
    expect(result.totalTriangles).toBe(triangles);
    expect(result.sampledTriangles).toBeLessThanOrEqual(
      DEVIATION_SAMPLE_TRIANGLES
    );
    expect(result.sampledTriangles).toBeGreaterThan(
      DEVIATION_SAMPLE_TRIANGLES / 2
    );
  });
});
