import { describe, expect, it } from 'vitest';
import type { Vector3 } from '@openzcad/shared';
import {
  extrudeBackArrowOrigin,
  extrudeDraftHinge,
  extrudeHandles,
  extrudeTakesBackDistance,
  extrudeTakesDraft,
  type ExtrudeHandleState
} from './extrude';

// A 20 × 10 rectangle on XY, longest sides along X.
const outline: Vector3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 20, y: 0, z: 0 },
  { x: 20, y: 10, z: 0 },
  { x: 0, y: 10, z: 0 }
];
const up = { x: 0, y: 0, z: 1 };
const blind: ExtrudeHandleState = {
  extent: 'blind',
  symmetric: false,
  distance: 8,
  backDistance: 0,
  draftAngle: 0
};

function turned(
  start: Vector3,
  axis: Vector3,
  degrees: number
): { x: number; y: number; z: number } {
  // Rodrigues, for a unit axis square to the start.
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const cross = {
    x: axis.y * start.z - axis.z * start.y,
    y: axis.z * start.x - axis.x * start.z,
    z: axis.x * start.y - axis.y * start.x
  };
  return {
    x: start.x * c + cross.x * s,
    y: start.y * c + cross.y * s,
    z: start.z * c + cross.z * s
  };
}

describe('in-place Extrude handles', () => {
  it('stands the back arrow on the profile, pointing away from the extrusion', () => {
    const [back] = extrudeHandles(outline, up, 'region', blind);
    expect(back).toMatchObject({
      valueId: 'backDistance',
      kind: 'linear',
      params: { direction: { z: -1 } }
    });
    // Inside, clear of the region's own arrow (the middle) and the draft rig.
    const origin = back?.kind === 'linear' ? back.params.origin : null;
    expect(origin?.x).toBeCloseTo(5);
    expect(origin?.y).toBeGreaterThan(5);
    expect(origin?.y).toBeLessThan(10);
    const [reversed] = extrudeHandles(outline, up, 'region', {
      ...blind,
      distance: -8
    });
    expect(reversed?.kind === 'linear' && reversed.params.direction.z).toBe(1);
    // A flipped side is a new rig; a new value is not.
    expect(reversed?.key).not.toBe(back?.key);
    const [moved] = extrudeHandles(outline, up, 'region', {
      ...blind,
      backDistance: 4
    });
    expect(moved?.key).toBe(back?.key);
  });

  it('hinges the draft rig on the longest side, a positive angle tapering inward', () => {
    const draft = extrudeHandles(outline, up, 'region', blind).find(
      (handle) => handle.valueId === 'draftAngle'
    );
    if (draft?.kind !== 'angle') throw new Error('Expected an angle rig');
    expect(draft.params.center).toEqual({ x: 10, y: 0, z: 0 });
    expect(draft.params.startDirection).toEqual(up);
    // Ten degrees of draft leans the wall towards the profile's inside (+Y).
    const leaned = turned(draft.params.startDirection, draft.params.axis, 10);
    expect(leaned.y).toBeGreaterThan(0);
    expect(leaned.z).toBeGreaterThan(0);
    // Extruded downward, the wall leaves the other way and still leans in.
    const down = extrudeHandles(outline, up, 'region', {
      ...blind,
      distance: -8
    }).find((handle) => handle.valueId === 'draftAngle');
    if (down?.kind !== 'angle') throw new Error('Expected an angle rig');
    const leanedDown = turned(down.params.startDirection, down.params.axis, 10);
    expect(leanedDown.y).toBeGreaterThan(0);
    expect(leanedDown.z).toBeLessThan(0);
  });

  it('offers each handle only where the extrude takes its value', () => {
    expect(extrudeTakesBackDistance(blind)).toBe(true);
    expect(extrudeTakesBackDistance({ ...blind, symmetric: true })).toBe(false);
    expect(extrudeTakesBackDistance({ ...blind, extent: 'to-face' })).toBe(
      false
    );
    expect(extrudeTakesDraft(blind)).toBe(true);
    expect(extrudeTakesDraft({ ...blind, symmetric: true })).toBe(false);
    expect(extrudeTakesDraft({ ...blind, backDistance: 2 })).toBe(false);
    expect(extrudeTakesDraft({ ...blind, extent: 'through-all' })).toBe(false);
    // To face tapers whatever Symmetric and Back held for Distance.
    expect(
      extrudeTakesDraft({ ...blind, extent: 'to-face', backDistance: 2 })
    ).toBe(true);
    expect(
      extrudeHandles(outline, up, 'region', {
        ...blind,
        extent: 'through-all'
      })
    ).toEqual([]);
  });

  it('waits for the extrusion to leave the sketch', () => {
    expect(
      extrudeHandles(outline, up, 'region', { ...blind, distance: 0 })
    ).toEqual([]);
    // A derived extent has no distance of its own to wait for.
    expect(
      extrudeHandles(outline, up, 'region', {
        ...blind,
        extent: 'to-face',
        distance: 0
      }).map((handle) => handle.valueId)
    ).toEqual(['draftAngle']);
  });

  it("finds a concave profile's inside from its winding, not its middle", () => {
    // A C open to +X, its back the longest side along x = 0: the vertex
    // mean (x = 6.7) lies beyond the arms' inner (reflex) side at x = 4.
    const c: Vector3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
      { x: 20, y: 2, z: 0 },
      { x: 4, y: 2, z: 0 },
      { x: 4, y: 28, z: 0 },
      { x: 20, y: 28, z: 0 },
      { x: 20, y: 30, z: 0 },
      { x: 0, y: 30, z: 0 }
    ];
    const hinge = extrudeDraftHinge(c, up)!;
    // The back, x = 0 from y = 30 to 0, whose inside is +X.
    expect(hinge.foot).toEqual({ x: 0, y: 15, z: 0 });
    expect(hinge.inward.x).toBeCloseTo(1);
    // A bridge whose underside (the notch's roof, y = 8) is its longest
    // side, a reflex one: the vertex mean (y ≈ 5.3) lies outside, under it,
    // but the material is above. Read either way round, the inside is +Y.
    const bridge: Vector3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 2, y: 8, z: 0 },
      { x: 38, y: 8, z: 0 },
      { x: 38, y: 0, z: 0 },
      { x: 40, y: 0, z: 0 },
      { x: 40, y: 10, z: 0 },
      { x: 20, y: 12, z: 0 },
      { x: 0, y: 10, z: 0 }
    ];
    for (const outline of [bridge, [...bridge].reverse()]) {
      const roof = extrudeDraftHinge(outline, up)!;
      expect(roof.foot).toEqual({ x: 20, y: 8, z: 0 });
      expect(roof.inward.y).toBeCloseTo(1);
    }
  });

  it('stands the back arrow inside a concave profile, never in its notch', () => {
    // A C open to +X: its vertex mean and the old average with the farthest
    // corner both land in the notch (x > 4, 2 < y < 28).
    const c: Vector3[] = [
      { x: 0, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
      { x: 20, y: 2, z: 0 },
      { x: 4, y: 2, z: 0 },
      { x: 4, y: 28, z: 0 },
      { x: 20, y: 28, z: 0 },
      { x: 20, y: 30, z: 0 },
      { x: 0, y: 30, z: 0 }
    ];
    const inside = (point: Vector3) => {
      let crossings = 0;
      for (let index = 0; index < c.length; index += 1) {
        const a = c[index]!;
        const b = c[(index + 1) % c.length]!;
        if (a.y <= point.y !== b.y <= point.y) {
          const x = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
          if (x > point.x) crossings += 1;
        }
      }
      return crossings % 2 === 1;
    };
    for (const outline of [c, [...c].reverse()]) {
      const hinge = extrudeDraftHinge(outline, up);
      const origin = extrudeBackArrowOrigin(
        outline,
        up,
        hinge?.foot ?? null,
        hinge?.along
      );
      expect(inside(origin)).toBe(true);
    }
  });

  it('has no hinge on a degenerate outline', () => {
    expect(extrudeDraftHinge(outline.slice(0, 2), up)).toBeNull();
    expect(
      extrudeDraftHinge([outline[0]!, outline[0]!, outline[0]!], up)
    ).toBeNull();
  });
});
