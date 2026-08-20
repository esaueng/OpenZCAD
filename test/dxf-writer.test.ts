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
});

describe('writeDxf', () => {
  it('wraps entities in an R12 skeleton', () => {
    const text = writeDxf([]);
    const p = pairs(text);
    expect(p).toEqual([
      [0, 'SECTION'],
      [2, 'HEADER'],
      [9, '$ACADVER'],
      [1, 'AC1009'],
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
      { kind: 'arc', center: [0, 0], radius: 3, startAngleDeg: 90, endAngleDeg: 180 }
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
      { kind: 'polyline', points: [[0, 0], [1, 0], [1, 1]], closed: true }
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
    const open = pairs(writeDxf([{ kind: 'polyline', points: [[0, 0], [1, 0]], closed: false }]));
    const openPolyAt = open.findIndex(([c, v]) => c === 0 && v === 'POLYLINE');
    expect(open[openPolyAt + 3]).toEqual([70, '0']);
  });
});
