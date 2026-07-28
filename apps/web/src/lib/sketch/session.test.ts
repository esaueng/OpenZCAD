import { describe, expect, it } from 'vitest';
import { PLANE_BASES } from '@openzcad/geometry';
import {
  arcDimension,
  arcObjectFromPoints,
  arcPreviewPoints,
  axisLockPoint,
  dimensionForInProgress,
  frameFromFace,
  lineObjectFromPoints,
  nearestSnapTarget,
  screenRayToPlanePoint,
  sketchEntryPose,
  sketchObjectFromDrag,
  snapSketchPoint,
  snapTargetsForObject
} from './session';

describe('snapSketchPoint / sketchObjectFromDrag', () => {
  it('snaps to the grid step', () => {
    expect(snapSketchPoint({ x: 3.4, y: -2.6 }, 1)).toEqual({ x: 3, y: -3 });
    expect(snapSketchPoint({ x: 3.4, y: -2.6 }, 0.5)).toEqual({
      x: 3.5,
      y: -2.5
    });
  });

  it('builds shapes from drags and rejects slivers', () => {
    expect(
      sketchObjectFromDrag('rectangle', { x: 0, y: 0 }, { x: 10, y: 6 })
    ).toMatchObject({ objectKind: 'rectangle', width: 10, height: 6 });
    expect(
      sketchObjectFromDrag('circle', { x: 2, y: 1 }, { x: 5, y: 5 })
    ).toMatchObject({ objectKind: 'circle', radius: 5 });
    expect(
      sketchObjectFromDrag('rectangle', { x: 0, y: 0 }, { x: 0.2, y: 9 })
    ).toBeNull();
  });

  it('builds line objects and rejects zero-length ones', () => {
    expect(lineObjectFromPoints({ x: 0, y: 0 }, { x: 8, y: 6 })).toMatchObject({
      objectKind: 'line',
      x2: 8,
      y2: 6
    });
    expect(lineObjectFromPoints({ x: 1, y: 1 }, { x: 1.1, y: 1 })).toBeNull();
  });

  it('builds center-start-end arcs with a positive sweep', () => {
    const arc = arcObjectFromPoints(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 }
    );
    expect(arc).toMatchObject({
      objectKind: 'arc',
      radius: 10,
      startAngleDeg: 0,
      endAngleDeg: 90
    });
    const preview = arcPreviewPoints(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
      16
    );
    expect(preview[0]).toEqual({ x: 10, y: 0 });
    expect(preview.at(-1)?.x).toBeCloseTo(0);
    expect(preview.at(-1)?.y).toBeCloseTo(10);
    expect(
      arcDimension({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 })
    ).toEqual({ radius: 10, sweepDeg: 90 });
  });

  it('rejects arcs whose radius is below the sketch tolerance', () => {
    expect(
      arcObjectFromPoints({ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0, y: 0.1 })
    ).toBeNull();
  });

  it('rejects a zero-sweep arc instead of silently making a circle', () => {
    expect(
      arcObjectFromPoints({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 })
    ).toBeNull();
  });
});

describe('screenRayToPlanePoint', () => {
  it('projects rays onto the XY plane in local coordinates', () => {
    const point = screenRayToPlanePoint(
      { x: 3, y: 4, z: 10 },
      { x: 0, y: 0, z: -1 },
      PLANE_BASES.XY
    );
    expect(point?.x).toBeCloseTo(3);
    expect(point?.y).toBeCloseTo(4);
  });

  it('returns null for parallel or behind-origin rays', () => {
    expect(
      screenRayToPlanePoint(
        { x: 0, y: 0, z: 10 },
        { x: 1, y: 0, z: 0 },
        PLANE_BASES.XY
      )
    ).toBeNull();
    expect(
      screenRayToPlanePoint(
        { x: 0, y: 0, z: 10 },
        { x: 0, y: 0, z: 1 },
        PLANE_BASES.XY
      )
    ).toBeNull();
  });

  it('respects the XZ plane handedness', () => {
    const point = screenRayToPlanePoint(
      { x: 5, y: -10, z: 7 },
      { x: 0, y: 1, z: 0 },
      PLANE_BASES.XZ
    );
    // XZ basis: u = +X, v = -Z.
    expect(point?.x).toBeCloseTo(5);
    expect(point?.y).toBeCloseTo(-7);
  });
});

describe('axisLockPoint', () => {
  it('locks near-horizontal and near-vertical segments', () => {
    const horizontal = axisLockPoint({ x: 0, y: 0 }, { x: 20, y: 1 });
    expect(horizontal.lockedAxis).toBe('horizontal');
    expect(horizontal.point).toEqual({ x: 20, y: 0 });
    const vertical = axisLockPoint({ x: 0, y: 0 }, { x: -0.5, y: 15 });
    expect(vertical.lockedAxis).toBe('vertical');
    expect(vertical.point).toEqual({ x: 0, y: 15 });
  });

  it('leaves diagonal segments free', () => {
    const diagonal = axisLockPoint({ x: 0, y: 0 }, { x: 10, y: 9 });
    expect(diagonal.lockedAxis).toBeNull();
    expect(diagonal.point).toEqual({ x: 10, y: 9 });
  });
});

describe('sketchEntryPose', () => {
  it('faces the plane head-on from the given distance', () => {
    const pose = sketchEntryPose(PLANE_BASES.XZ, 100);
    expect(pose.position).toEqual({ x: 0, y: 100, z: 0 });
    expect(pose.target).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('tilts the top view a hair off +Z to keep orbit math stable', () => {
    const pose = sketchEntryPose(PLANE_BASES.XY, 50);
    expect(pose.position.y).toBeLessThan(0);
    expect(pose.position.z).toBeCloseTo(50, 1);
  });
});

describe('frameFromFace', () => {
  it('builds right-handed orthonormal frames', () => {
    const frame = frameFromFace({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 2 });
    const dot = (a: { x: number; y: number; z: number }, b: typeof a) =>
      a.x * b.x + a.y * b.y + a.z * b.z;
    expect(dot(frame.xAxis, frame.yAxis)).toBeCloseTo(0);
    expect(dot(frame.xAxis, frame.zAxis)).toBeCloseTo(0);
    expect(dot(frame.zAxis, frame.zAxis)).toBeCloseTo(1);
    // x × y = z (right-handed)
    expect(
      frame.xAxis.y * frame.yAxis.z - frame.xAxis.z * frame.yAxis.y
    ).toBeCloseTo(frame.zAxis.x);
  });
});

describe('dimensionForInProgress', () => {
  it('formats per tool', () => {
    expect(
      dimensionForInProgress('circle', { x: 0, y: 0 }, { x: 3, y: 4 })
    ).toBe('⌀ 10');
    expect(
      dimensionForInProgress('rectangle', { x: 0, y: 0 }, { x: 8, y: -6 })
    ).toBe('8 × 6');
    expect(dimensionForInProgress('line', { x: 0, y: 0 }, { x: 3, y: 4 })).toBe(
      '5'
    );
  });
});

describe('sketch entity snapping', () => {
  const identity = (value: unknown): number => Number(value);

  it('collects endpoints and the midpoint of a line', () => {
    const targets = snapTargetsForObject(
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 4 },
      identity
    );
    expect(targets).toEqual([
      { x: 0, y: 0, kind: 'endpoint' },
      { x: 10, y: 4, kind: 'endpoint' },
      { x: 5, y: 2, kind: 'midpoint' }
    ]);
  });

  it('collects rectangle corners, edge midpoints, and center', () => {
    const targets = snapTargetsForObject(
      { objectKind: 'rectangle', width: 8, height: 4, centerX: 10, centerY: 6 },
      identity
    );
    expect(targets).toContainEqual({ x: 6, y: 4, kind: 'endpoint' });
    expect(targets).toContainEqual({ x: 14, y: 8, kind: 'endpoint' });
    expect(targets).toContainEqual({ x: 10, y: 6, kind: 'center' });
    expect(targets).toContainEqual({ x: 10, y: 4, kind: 'midpoint' });
    expect(targets).toHaveLength(9);
  });

  it('collects circle and arc centers plus arc endpoints', () => {
    expect(
      snapTargetsForObject(
        { objectKind: 'circle', radius: 5, centerX: 3, centerY: -2 },
        identity
      )
    ).toEqual([{ x: 3, y: -2, kind: 'center' }]);

    const arcTargets = snapTargetsForObject(
      {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 10,
        startAngleDeg: 0,
        endAngleDeg: 90
      },
      identity
    );
    expect(arcTargets).toContainEqual({ x: 0, y: 0, kind: 'center' });
    const start = arcTargets.find(
      (target) => target.kind === 'endpoint' && target.x === 10
    );
    expect(start).toMatchObject({ y: 0 });
    const end = arcTargets.find(
      (target) => target.kind === 'endpoint' && target.x !== 10
    );
    expect(end?.x).toBeCloseTo(0);
    expect(end?.y).toBeCloseTo(10);
  });

  it('snaps to the nearest target inside the tolerance only', () => {
    const targets = snapTargetsForObject(
      { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      identity
    );
    expect(nearestSnapTarget({ x: 0.3, y: 0.2 }, targets, 0.5)).toMatchObject({
      x: 0,
      y: 0,
      kind: 'endpoint'
    });
    expect(nearestSnapTarget({ x: 5, y: 0.4 }, targets, 0.5)).toMatchObject({
      kind: 'midpoint'
    });
    expect(nearestSnapTarget({ x: 2, y: 2 }, targets, 0.5)).toBeNull();
  });
});
