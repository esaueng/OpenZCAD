import { describe, expect, it } from 'vitest';
import { localPolygonUnion2d } from './polygonUnion';
import { TextGeometryError } from './types';

/** `[x0, y0, x1, y1, ...]`, first point not repeated. */
function loop(...points: number[]): Float64Array {
  return Float64Array.from(points);
}

/** Counter-clockwise rectangle. */
function rect(x0: number, y0: number, x1: number, y1: number): Float64Array {
  return loop(x0, y0, x1, y0, x1, y1, x0, y1);
}

/** Clockwise rectangle — the hole convention. */
function hole(x0: number, y0: number, x1: number, y1: number): Float64Array {
  return loop(x0, y0, x0, y1, x1, y1, x1, y0);
}

function signedArea(flat: Float64Array): number {
  let twice = 0;
  const count = flat.length / 2;
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    twice += flat[i * 2]! * flat[j * 2 + 1]! - flat[j * 2]! * flat[i * 2 + 1]!;
  }
  return twice / 2;
}

function totalArea(loops: readonly Float64Array[]): number {
  return loops.reduce((sum, item) => sum + signedArea(item), 0);
}

function closes(flat: Float64Array): boolean {
  return flat.length >= 6 && flat.length % 2 === 0;
}

describe('localPolygonUnion2d', () => {
  it('passes a single simple loop through unchanged in area and winding', () => {
    const result = localPolygonUnion2d([rect(0, 0, 2, 2)]);
    expect(result.length).toBe(1);
    expect(signedArea(result[0]!)).toBeCloseTo(4, 9);
  });

  it('merges two overlapping squares into one boundary', () => {
    const result = localPolygonUnion2d([rect(0, 0, 2, 2), rect(1, 1, 3, 3)]);
    expect(result.length).toBe(1);
    expect(result.every(closes)).toBe(true);
    // 4 + 4 − 1 shared unit square.
    expect(totalArea(result)).toBeCloseTo(7, 9);
    expect(signedArea(result[0]!)).toBeGreaterThan(0);
  });

  it('leaves disjoint squares as two loops', () => {
    const result = localPolygonUnion2d([rect(0, 0, 1, 1), rect(5, 5, 6, 6)]);
    expect(result.length).toBe(2);
    expect(totalArea(result)).toBeCloseTo(2, 9);
    expect(result.every((item) => signedArea(item) > 0)).toBe(true);
  });

  it('returns a CCW outer and a CW hole for an annulus', () => {
    const result = localPolygonUnion2d([rect(0, 0, 4, 4), hole(1, 1, 3, 3)]);
    expect(result.length).toBe(2);
    const outer = result.find((item) => signedArea(item) > 0);
    const inner = result.find((item) => signedArea(item) < 0);
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(signedArea(outer!)).toBeCloseTo(16, 9);
    expect(signedArea(inner!)).toBeCloseTo(-4, 9);
  });

  it('fills a hole that another shape covers', () => {
    const result = localPolygonUnion2d([
      rect(0, 0, 4, 4),
      hole(1, 1, 3, 3),
      rect(0.5, 0.5, 3.5, 3.5)
    ]);
    expect(result.length).toBe(1);
    expect(signedArea(result[0]!)).toBeCloseTo(16, 9);
  });

  it('partially covers a hole and keeps the rest of it', () => {
    const result = localPolygonUnion2d([
      rect(0, 0, 4, 4),
      hole(1, 1, 3, 3),
      rect(2, 0.5, 3.5, 3.5)
    ]);
    // The hole shrinks from 2×2 to the 1×2 strip the cover misses.
    expect(totalArea(result)).toBeCloseTo(16 - 2, 9);
    expect(result.some((item) => signedArea(item) < 0)).toBe(true);
  });

  it('resolves a slit annulus drawn as one contour', () => {
    // The classic single-contour annulus: around the outside, in along a
    // zero-width slit, around the inside the other way, back out. The slit
    // edges have material on both sides and must vanish, leaving a clean
    // outer and a clean hole.
    const figure = loop(
      0, 0,
      6, 0,
      6, 6,
      0, 6,
      0, 3,
      1, 3,
      1, 5,
      5, 5,
      5, 1,
      1, 1,
      1, 3,
      0, 3
    );
    const result = localPolygonUnion2d([figure]);
    expect(result.length).toBe(2);
    const outer = result.find((item) => signedArea(item) > 0);
    const inner = result.find((item) => signedArea(item) < 0);
    expect(signedArea(outer!)).toBeCloseTo(36, 9);
    expect(signedArea(inner!)).toBeCloseTo(-16, 9);
  });

  it('resolves a P-shaped self-crossing contour into outer plus counter', () => {
    // Two overlapping strokes traced as one path that crosses itself twice —
    // the way a font draws a 'P'. The counter only exists after the crossings
    // are found; before that the contour is a single self-intersecting loop.
    const figure = loop(
      2, 0,
      2, 6,
      5, 6,
      5, 3,
      1.6, 3,
      1.6, 2,
      5.5, 2,
      5.5, 7,
      1, 7,
      1, 0
    );
    const result = localPolygonUnion2d([figure]);
    expect(result.length).toBe(2);
    expect(result.filter((item) => signedArea(item) > 0).length).toBe(1);
    expect(result.filter((item) => signedArea(item) < 0).length).toBe(1);
    for (const item of result) {
      const keys = new Set<string>();
      for (let i = 0; i < item.length; i += 2) {
        keys.add(`${item[i]!.toFixed(9)},${item[i + 1]!.toFixed(9)}`);
      }
      expect(keys.size, 'output loops must be simple').toBe(item.length / 2);
    }
    expect(totalArea(result)).toBeGreaterThan(0);
  });

  it('collapses coincident edges from repeated shapes', () => {
    // Two identical squares: every edge is duplicated exactly.
    const result = localPolygonUnion2d([rect(0, 0, 2, 2), rect(0, 0, 2, 2)]);
    expect(result.length).toBe(1);
    expect(signedArea(result[0]!)).toBeCloseTo(4, 9);
  });

  it('handles a collinear overlapping edge run', () => {
    // Shifted copies share the top and bottom edges over a stretch — the 'll'
    // case that a naive crossings-only split cannot see.
    const result = localPolygonUnion2d([rect(0, 0, 2, 1), rect(1, 0, 3, 1)]);
    expect(result.length).toBe(1);
    expect(signedArea(result[0]!)).toBeCloseTo(3, 9);
  });

  it('drops degenerate loops instead of emitting them', () => {
    expect(localPolygonUnion2d([])).toEqual([]);
    expect(localPolygonUnion2d([loop(0, 0, 1, 1)])).toEqual([]);
  });

  it('is deterministic', () => {
    const input = [rect(0, 0, 2, 2), rect(1, 1, 3, 3), hole(0.2, 0.2, 0.6, 0.6)];
    const first = localPolygonUnion2d(input).map((item) => [...item]);
    const second = localPolygonUnion2d(input).map((item) => [...item]);
    expect(second).toEqual(first);
  });

  it('never returns a broken loop over a randomized sweep', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let failures = 0;
    for (let trial = 0; trial < 200; trial += 1) {
      const loops: Float64Array[] = [];
      const count = 2 + Math.floor(random() * 4);
      for (let i = 0; i < count; i += 1) {
        const x = Math.round(random() * 40) / 4;
        const y = Math.round(random() * 40) / 4;
        const w = 0.5 + Math.round(random() * 20) / 4;
        const h = 0.5 + Math.round(random() * 20) / 4;
        loops.push(rect(x, y, x + w, y + h));
      }
      try {
        const result = localPolygonUnion2d(loops);
        for (const item of result) {
          expect(closes(item)).toBe(true);
        }
        const largest = Math.max(...loops.map(signedArea));
        expect(totalArea(result)).toBeGreaterThanOrEqual(largest - 1e-9);
      } catch (error) {
        if (!(error instanceof TextGeometryError)) {
          throw error;
        }
        failures += 1;
      }
    }
    expect(failures).toBe(0);
  });
});
