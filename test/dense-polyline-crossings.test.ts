import { describe, expect, it } from 'vitest';
import { densePolylineCrosses } from './support/densePolylineCrossing';

type Point = { x: number; y: number };

/** The original quadratic oracle, retained independently of sweep discovery. */
function legacyCrosses(points: Point[]) {
  const n = points.length - 1;
  const bounds = points.slice(1).map((point, index) => ({
    minX: Math.min(points[index]!.x, point.x),
    maxX: Math.max(points[index]!.x, point.x),
    minY: Math.min(points[index]!.y, point.y),
    maxY: Math.max(points[index]!.y, point.y)
  }));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 2; j < n; j += 1) {
      const a = bounds[i]!;
      const b = bounds[j]!;
      if (
        a.maxX < b.minX ||
        b.maxX < a.minX ||
        a.maxY < b.minY ||
        b.maxY < a.minY
      )
        continue;
      const a0 = points[i]!;
      const a1 = points[i + 1]!;
      const b0 = points[j]!;
      const b1 = points[j + 1]!;
      const d = (a1.x - a0.x) * (b1.y - b0.y) - (a1.y - a0.y) * (b1.x - b0.x);
      if (d === 0) continue;
      const r =
        ((b0.x - a0.x) * (b1.y - b0.y) - (b0.y - a0.y) * (b1.x - b0.x)) / d;
      const q =
        ((b0.x - a0.x) * (a1.y - a0.y) - (b0.y - a0.y) * (a1.x - a0.x)) / d;
      if (r > 0 && r < 1 && q > 0 && q < 1) return true;
    }
  }
  return false;
}

describe('dense oracle candidate sweep', () => {
  it('preserves crossings, endpoint exclusions, adjacent chords and degenerate spans', () => {
    const fixtures: [Point[], boolean][] = [
      [[], false],
      [[{ x: 0, y: 0 }], false],
      [
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 1, y: 0 }
        ],
        false
      ],
      [
        [
          { x: 0, y: 0 },
          { x: 2, y: 2 },
          { x: 0, y: 2 },
          { x: 2, y: 0 }
        ],
        true
      ],
      [
        [
          { x: 1, y: 0 },
          { x: 1, y: 2 },
          { x: 0, y: 1 },
          { x: 2, y: 1 }
        ],
        true
      ],
      [
        [
          { x: 0, y: 0 },
          { x: 2, y: 2 },
          { x: 3, y: 0 },
          { x: 2, y: 2 }
        ],
        false
      ],
      [
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 0 }
        ],
        false
      ]
    ];
    for (const [points, expected] of fixtures) {
      expect(legacyCrosses(points)).toBe(expected);
      expect(densePolylineCrosses(points)).toBe(expected);
    }
  });

  it('matches the original pair scan on seeded, tied and reversed coordinates at several scales', () => {
    let state = 192837;
    const random = () =>
      (state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32;
    for (let trial = 0; trial < 160; trial += 1) {
      const points = Array.from({ length: 3 + (trial % 61) }, () => ({
        x: trial % 2 ? Math.round(random() * 8) : random() * 8,
        y: trial % 3 ? Math.round(random() * 8) : random() * 8
      }));
      for (const scale of [1e-6, 1, 1e6]) {
        for (const ordered of [points, [...points].reverse()]) {
          const scaled = ordered.map(({ x, y }) => ({
            x: x * scale,
            y: y * scale
          }));
          expect(densePolylineCrosses(scaled)).toBe(legacyCrosses(scaled));
        }
      }
    }
  });
});
