import { describe, expect, it } from 'vitest';

import { formatDxfNumber, writeDxf } from '@openzcad/io-dxf';

/** Parse a DXF text into [code, value] pairs for structural assertions. */
function pairs(text: string): Array<[number, string]> {
  const lines = text.split('\r\n').filter((l) => l.length > 0);
  const out: Array<[number, string]> = [];
  for (let i = 0; i < lines.length; i += 2) {
    out.push([Number(lines[i]), lines[i + 1]!]);
  }
  return out;
}

describe('formatDxfNumber', () => {
  it('never emits exponent notation', () => {
    expect(formatDxfNumber(1e-7)).toBe('0.0000001');
    expect(formatDxfNumber(2e-9)).toBe('0.000000002');
    expect(formatDxfNumber(12345.678)).toBe('12345.678');
  });

  it('trims trailing zeros and normalizes signed zero', () => {
    expect(formatDxfNumber(2)).toBe('2');
    expect(formatDxfNumber(2.5)).toBe('2.5');
    expect(formatDxfNumber(-1e-12)).toBe('0');
    expect(formatDxfNumber(0)).toBe('0');
  });

  it('refuses non-finite coordinates', () => {
    expect(() => formatDxfNumber(Number.NaN)).toThrow(/not finite/);
  });

  it('refuses magnitudes toFixed would render with exponents', () => {
    for (const value of [1e21, -1e21, 1e30]) {
      expect(() => formatDxfNumber(value)).toThrow(/out of range/);
    }
    expect(formatDxfNumber(1e20)).not.toMatch(/e/i);
  });
});

describe('writeDxf', () => {
  it('wraps entities in an R12 skeleton that declares millimetres', () => {
    const text = writeDxf([]);
    const p = pairs(text);
    expect(p).toEqual([
      [0, 'SECTION'],
      [2, 'HEADER'],
      [9, '$ACADVER'],
      [1, 'AC1009'],
      // $INSUNITS 4 is millimetres; $MEASUREMENT 1 is the metric setup.
      [9, '$INSUNITS'],
      [70, '4'],
      [9, '$MEASUREMENT'],
      [70, '1'],
      [0, 'ENDSEC'],
      [0, 'SECTION'],
      [2, 'ENTITIES'],
      [0, 'ENDSEC'],
      [0, 'EOF']
    ]);
  });

  it('emits LINE, CIRCLE, and ARC with the standard group codes', () => {
    const text = writeDxf([
      { kind: 'line', start: [0, 0], end: [10, 5] },
      { kind: 'circle', center: [3, 4], radius: 2.5 },
      {
        kind: 'arc',
        center: [0, 0],
        radius: 3,
        startAngleDeg: 90,
        endAngleDeg: 180
      }
    ]);
    const p = pairs(text);
    const lineAt = p.findIndex(([c, v]) => c === 0 && v === 'LINE');
    expect(p.slice(lineAt, lineAt + 8)).toEqual([
      [0, 'LINE'],
      [8, '0'],
      [10, '0'],
      [20, '0'],
      [30, '0'],
      [11, '10'],
      [21, '5'],
      [31, '0']
    ]);
    const circleAt = p.findIndex(([c, v]) => c === 0 && v === 'CIRCLE');
    expect(p.slice(circleAt, circleAt + 6)).toEqual([
      [0, 'CIRCLE'],
      [8, '0'],
      [10, '3'],
      [20, '4'],
      [30, '0'],
      [40, '2.5']
    ]);
    const arcAt = p.findIndex(([c, v]) => c === 0 && v === 'ARC');
    expect(p.slice(arcAt, arcAt + 8)).toEqual([
      [0, 'ARC'],
      [8, '0'],
      [10, '0'],
      [20, '0'],
      [30, '0'],
      [40, '3'],
      [50, '90'],
      [51, '180']
    ]);
  });

  it('emits R12 polylines with 66=1, per-vertex entities, and SEQEND', () => {
    const text = writeDxf([
      {
        kind: 'polyline',
        points: [
          [0, 0],
          [1, 0],
          [1, 1]
        ],
        closed: true
      }
    ]);
    const p = pairs(text);
    const polyAt = p.findIndex(([c, v]) => c === 0 && v === 'POLYLINE');
    expect(p.slice(polyAt, polyAt + 4)).toEqual([
      [0, 'POLYLINE'],
      [8, '0'],
      [66, '1'],
      [70, '1']
    ]);
    const vertexCount = p.filter(([c, v]) => c === 0 && v === 'VERTEX').length;
    expect(vertexCount).toBe(3);
    const seqendAt = p.findIndex(([c, v]) => c === 0 && v === 'SEQEND');
    expect(seqendAt).toBeGreaterThan(polyAt);
    // An open polyline flags 70=0.
    const open = pairs(
      writeDxf([
        {
          kind: 'polyline',
          points: [
            [0, 0],
            [1, 0]
          ],
          closed: false
        }
      ])
    );
    const openPolyAt = open.findIndex(([c, v]) => c === 0 && v === 'POLYLINE');
    expect(open[openPolyAt + 3]).toEqual([70, '0']);
  });
});

describe('writeDxf units', () => {
  const header = (text: string) => pairs(text.split('ENTITIES')[0]!);

  it('declares millimetres and a metric drawing by default', () => {
    expect(header(writeDxf([]))).toEqual(
      expect.arrayContaining([
        [9, '$INSUNITS'],
        [70, '4'],
        [9, '$MEASUREMENT'],
        [70, '1']
      ])
    );
  });

  it.each([
    ['inch', '1', '0'],
    ['cm', '5', '1'],
    ['m', '6', '1']
  ] as const)(
    'declares %s as $INSUNITS %s, $MEASUREMENT %s',
    (units, code, measurement) => {
      const lines = header(writeDxf([], { units }));
      const insunits = lines.findIndex(([, value]) => value === '$INSUNITS');
      const metric = lines.findIndex(([, value]) => value === '$MEASUREMENT');
      expect(lines[insunits + 1]).toEqual([70, code]);
      expect(lines[metric + 1]).toEqual([70, measurement]);
    }
  );
});

describe('writeDxf layers and text', () => {
  it('puts each entity on its layer, 0 when absent', () => {
    const p = pairs(
      writeDxf([
        { kind: 'line', start: [0, 0], end: [1, 0], layer: 'BEND_UP' },
        { kind: 'circle', center: [0, 0], radius: 1 },
        {
          kind: 'arc',
          center: [0, 0],
          radius: 1,
          startAngleDeg: 0,
          endAngleDeg: 90,
          layer: 'ETCH'
        },
        {
          kind: 'polyline',
          points: [
            [0, 0],
            [1, 1]
          ],
          closed: false,
          layer: 'CUT'
        }
      ])
    );
    const layerOf = (type: string) =>
      p[p.findIndex(([c, v]) => c === 0 && v === type) + 1];
    expect(layerOf('LINE')).toEqual([8, 'BEND_UP']);
    expect(layerOf('CIRCLE')).toEqual([8, '0']);
    expect(layerOf('ARC')).toEqual([8, 'ETCH']);
    expect(layerOf('POLYLINE')).toEqual([8, 'CUT']);
    expect(layerOf('VERTEX')).toEqual([8, 'CUT']);
  });

  it('declares layers and the line types they use in a TABLES section', () => {
    const text = writeDxf([], {
      layers: [
        { name: '0' },
        { name: 'BEND_UP', color: 3, lineType: 'DASHED' },
        { name: 'BEND_NOTES', color: 2 }
      ]
    });
    const p = pairs(text);
    const tablesAt = p.findIndex(([c, v]) => c === 2 && v === 'TABLES');
    const entitiesAt = p.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
    const headerEnd = p.findIndex(([c, v]) => c === 0 && v === 'ENDSEC');
    expect(tablesAt).toBeGreaterThan(headerEnd);
    expect(entitiesAt).toBeGreaterThan(tablesAt);
    const tables = p.slice(tablesAt, entitiesAt);
    expect(tables).toEqual(
      expect.arrayContaining([
        [2, 'CONTINUOUS'],
        [2, 'DASHED']
      ])
    );
    const bendUpAt = tables.findIndex(([c, v]) => c === 2 && v === 'BEND_UP');
    expect(tables.slice(bendUpAt, bendUpAt + 4)).toEqual([
      [2, 'BEND_UP'],
      [70, '0'],
      [62, '3'],
      [6, 'DASHED']
    ]);
    const notesAt = tables.findIndex(([c, v]) => c === 2 && v === 'BEND_NOTES');
    expect(tables.slice(notesAt + 2, notesAt + 4)).toEqual([
      [62, '2'],
      [6, 'CONTINUOUS']
    ]);
    // No DASHED line type is declared when no layer uses it.
    expect(writeDxf([], { layers: [{ name: 'CUT' }] })).not.toContain('DASHED');
    // Without layers the file is exactly the historical layout.
    expect(writeDxf([], { layers: [] })).toBe(writeDxf([]));
  });

  it('writes TEXT with height, rotation and alignment', () => {
    const p = pairs(
      writeDxf([
        {
          kind: 'text',
          position: [5, 6],
          height: 2.5,
          text: 'UP 90 R1.5',
          layer: 'BEND_NOTES'
        },
        {
          kind: 'text',
          position: [1, 2],
          height: 1,
          text: 'DOWN',
          rotationDeg: 90,
          align: 'center'
        }
      ])
    );
    const first = p.findIndex(([c, v]) => c === 0 && v === 'TEXT');
    expect(p.slice(first, first + 7)).toEqual([
      [0, 'TEXT'],
      [8, 'BEND_NOTES'],
      [10, '5'],
      [20, '6'],
      [30, '0'],
      [40, '2.5'],
      [1, 'UP 90 R1.5']
    ]);
    // A left-aligned unrotated text writes no rotation or alignment groups.
    expect(p[first + 7]).toEqual([0, 'TEXT']);
    const second = first + 7;
    expect(p.slice(second + 7, second + 12)).toEqual([
      [50, '90'],
      [72, '1'],
      [11, '1'],
      [21, '2'],
      [31, '0']
    ]);
  });

  it('escapes non-ASCII text and refuses what R12 cannot carry', () => {
    const p = pairs(
      writeDxf([
        { kind: 'text', position: [0, 0], height: 1, text: 'UP 90° Ø4' }
      ])
    );
    expect(p).toContainEqual([1, String.raw`UP 90\U+00B0 \U+00D84`]);
    const text = (value: string) =>
      writeDxf([{ kind: 'text', position: [0, 0], height: 1, text: value }]);
    expect(() => text('two\nlines')).toThrow(/single line/);
    expect(() => text('tab\there')).toThrow(/U\+9/);
    expect(() => text('😀')).toThrow(/U\+1F600/);
    expect(() =>
      writeDxf([{ kind: 'text', position: [0, 0], height: 0, text: 'x' }])
    ).toThrow(/height/);
  });

  it('refuses layer names and colours R12 readers reject', () => {
    expect(() =>
      writeDxf([{ kind: 'line', start: [0, 0], end: [1, 0], layer: 'bend up' }])
    ).toThrow(/layer name/);
    expect(() =>
      writeDxf([{ kind: 'line', start: [0, 0], end: [1, 0], layer: '' }])
    ).toThrow(/layer name/);
    expect(() =>
      writeDxf([], { layers: [{ name: 'A' }, { name: 'A' }] })
    ).toThrow(/twice/);
    expect(() => writeDxf([], { layers: [{ name: 'A', color: 0 }] })).toThrow(
      /ACI/
    );
    expect(() => writeDxf([], { layers: [{ name: 'A', color: 256 }] })).toThrow(
      /ACI/
    );
  });
});
