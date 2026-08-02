/**
 * Viewport display sampling for sketch objects.
 *
 * A text object is not one polyline: a string is many disconnected regions,
 * each with an outer boundary and possibly counters, so the display helper
 * returns a list. These points are for drawing only — the solid is built from
 * the exact beziers the profile path carries, never from these.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setTextFontProvider } from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';
import { FontLibrary } from '../packages/geometry/src/text/loader';
import { nodeFontDataSource } from '../packages/geometry/src/text/nodeFontSource';
import { objectPolylines } from '../apps/web/src/lib/objectPolyline';

const resolve = (value: unknown): number => Number(value);
const library = new FontLibrary(nodeFontDataSource());

const text = (
  overrides: Partial<Extract<SketchObjectData, { objectKind: 'text' }>> = {}
): SketchObjectData => ({
  objectKind: 'text',
  text: 'Bo',
  fontFamily: 'open-sans',
  fontStyle: 'regular',
  size: 10,
  x: 0,
  y: 0,
  ...overrides
});

beforeAll(async () => {
  await library.load('open-sans', 'regular');
});

afterEach(() => {
  setTextFontProvider(null);
});

describe('objectPolylines', () => {
  it('still returns one run for an ordinary object', () => {
    const runs = objectPolylines(
      {
        objectKind: 'rectangle',
        width: 10,
        height: 4,
        centerX: 0,
        centerY: 0
      },
      resolve
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.points).toHaveLength(4);
    expect(runs[0]!.closed).toBe(true);
  });

  it('leaves an arc open and a circle closed', () => {
    expect(
      objectPolylines(
        {
          objectKind: 'arc',
          radius: 5,
          centerX: 0,
          centerY: 0,
          startAngleDeg: 0,
          endAngleDeg: 90
        },
        resolve
      )[0]!.closed
    ).toBe(false);
    expect(
      objectPolylines(
        { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 },
        resolve
      )[0]!.closed
    ).toBe(true);
  });

  it('draws one closed loop per glyph region and per counter', () => {
    setTextFontProvider((family, style) => library.peek(family, style));
    const runs = objectPolylines(text(), resolve);
    // 'B' is an outer plus two counters, 'o' is an outer plus one.
    expect(runs).toHaveLength(5);
    expect(runs.every((run) => run.closed)).toBe(true);
    expect(runs.every((run) => run.points.length >= 3)).toBe(true);
    // Sampled finely enough to look like a letter, not a triangle.
    expect(Math.max(...runs.map((run) => run.points.length))).toBeGreaterThan(
      20
    );
  });

  it('follows the position and size the object stores', () => {
    setTextFontProvider((family, style) => library.peek(family, style));
    const at = (data: SketchObjectData) => {
      const points = objectPolylines(data, resolve).flatMap(
        (run) => run.points
      );
      return {
        minX: Math.min(...points.map((point) => point.x)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y))
      };
    };
    const base = at(text());
    const moved = at(text({ x: 25, y: 7 }));
    expect(moved.minX - base.minX).toBeCloseTo(25, 6);
    expect(moved.maxY - base.maxY).toBeCloseTo(7, 6);
    const bigger = at(text({ size: 20 }));
    expect(bigger.maxX - bigger.minX).toBeCloseTo(
      (base.maxX - base.minX) * 2,
      6
    );
  });

  it('draws nothing until the face is loaded, rather than throwing', () => {
    setTextFontProvider(null);
    expect(objectPolylines(text(), resolve)).toEqual([]);
    setTextFontProvider((family, style) => library.peek(family, style));
    // A style whose file was never loaded is the same non-blocking miss.
    expect(objectPolylines(text({ fontStyle: 'bold' }), resolve)).toEqual([]);
    expect(objectPolylines(text(), resolve).length).toBeGreaterThan(0);
  });
});
