import { describe, expect, it } from 'vitest';
import {
  resolveSnap,
  translationToSnap,
  SNAP_PRIORITY,
  type ScreenPoint,
  type SnapCandidate,
  type Vec3
} from './SnapEngine';

/** Projects x/y straight through and treats negative z as behind the camera. */
const project = (point: Vec3): ScreenPoint | null =>
  point.z < 0 ? null : { x: point.x, y: point.y };

const at = (
  kind: SnapCandidate['kind'],
  x: number,
  y: number,
  z = 0
): SnapCandidate => ({ kind, point: { x, y, z } });

describe('nothing to snap to', () => {
  it('returns null with no candidates', () => {
    expect(resolveSnap([], { x: 0, y: 0 }, project)).toBeNull();
  });

  it('ignores a candidate outside the radius', () => {
    expect(
      resolveSnap([at('endpoint', 100, 100)], { x: 0, y: 0 }, project)
    ).toBeNull();
  });

  it('ignores what the camera cannot see', () => {
    // Behind the viewer still projects to a finite point, so it would
    // otherwise compete for the cursor.
    expect(
      resolveSnap([at('endpoint', 2, 2, -5)], { x: 0, y: 0 }, project)
    ).toBeNull();
  });
});

describe('the more specific kind wins', () => {
  it('takes a vertex over an edge that passes nearer', () => {
    // Every point along an edge is a candidate, so an edge running past a
    // corner can always offer something a pixel closer. The corner is what
    // the user is aiming at.
    const resolved = resolveSnap(
      [at('on-edge', 0, 1), at('endpoint', 0, 6)],
      { x: 0, y: 0 },
      project
    );
    expect(resolved?.candidate.kind).toBe('endpoint');
  });

  it('ranks every kind from most specific to least', () => {
    const order = (
      ['endpoint', 'intersection', 'center', 'midpoint', 'on-edge', 'on-face'] as const
    ).map((kind) => SNAP_PRIORITY[kind]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it('does not let a distant vertex outrank a near one', () => {
    const resolved = resolveSnap(
      [at('endpoint', 0, 9), at('endpoint', 0, 2)],
      { x: 0, y: 0 },
      project
    );
    expect(resolved?.candidate.point.y).toBe(2);
  });

  it('reports where the glyph goes and how far off it was', () => {
    const resolved = resolveSnap(
      [at('center', 3, 4)],
      { x: 0, y: 0 },
      project
    );
    expect(resolved?.screen).toEqual({ x: 3, y: 4 });
    expect(resolved?.distancePx).toBeCloseTo(5, 6);
  });

  it('honours a caller that wants a tighter radius', () => {
    const candidates = [at('endpoint', 0, 8)];
    expect(resolveSnap(candidates, { x: 0, y: 0 }, project, 12)).not.toBeNull();
    expect(resolveSnap(candidates, { x: 0, y: 0 }, project, 4)).toBeNull();
  });
});

describe('landing the handle on the point', () => {
  it('moves the body by the gap between the handle and the point', () => {
    const translation = translationToSnap(
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 5, z: 5 },
      { x: 8, y: 1, z: 5 }
    );
    expect(translation).toEqual({ x: 3, y: -4, z: 0 });
  });

  it('accounts for how far the body has already been dragged', () => {
    // The handle has travelled with the body; snapping is measured from
    // where it started, not from where the body sits now.
    const translation = translationToSnap(
      { x: 10, y: 0, z: 0 },
      { x: 5, y: 5, z: 5 },
      { x: 5, y: 5, z: 5 }
    );
    expect(translation).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('puts the handle exactly on the point, not near it', () => {
    const start = { x: -3, y: 7, z: 2 };
    const pivot = { x: 1.25, y: -0.5, z: 9 };
    const point = { x: 40.125, y: 3, z: -12.5 };
    const translation = translationToSnap(start, pivot, point);
    // Where the handle ends up: its start position plus the change applied.
    expect(pivot.x + (translation.x - start.x)).toBe(point.x);
    expect(pivot.y + (translation.y - start.y)).toBe(point.y);
    expect(pivot.z + (translation.z - start.z)).toBe(point.z);
  });
});
