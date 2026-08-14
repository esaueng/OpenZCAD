import { describe, expect, it } from 'vitest';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';
import { objectPolylines } from '../apps/web/src/lib/objectPolyline';

const resolve = (value: unknown) => Number(value);

describe('untrusted sketch bounds', () => {
  it('rejects polygons above the shared side limit before allocating points', () => {
    const polygon = {
      objectKind: 'polygon',
      sides: 1_000_000,
      radius: 10,
      centerX: 0,
      centerY: 0
    } satisfies SketchObjectData;

    expect(() => objectPolylines(polygon, resolve)).toThrow(/3 to 64/);
    const analysis = computeSketchProfileAnalysis(
      [{ id: 'polygon', data: polygon }],
      resolve
    );
    expect(analysis.profiles).toEqual([]);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-parameter' })
    );
  });

  it('rejects multi-turn arc sweeps before deriving a render step count', () => {
    const arc = {
      objectKind: 'arc',
      centerX: 0,
      centerY: 0,
      radius: 10,
      startAngleDeg: 0,
      endAngleDeg: 1_000_000_000_000
    } satisfies SketchObjectData;

    expect(() => objectPolylines(arc, resolve)).toThrow(/at most 360/);
    const analysis = computeSketchProfileAnalysis(
      [{ id: 'arc', data: arc }],
      resolve
    );
    expect(analysis.profiles).toEqual([]);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-parameter' })
    );
  });
});
