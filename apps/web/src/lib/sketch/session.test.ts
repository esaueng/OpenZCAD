import { describe, expect, it, vi } from 'vitest';
import type { SketchObjectData } from '@openzcad/shared';
import {
  PLANE_BASES,
  frameForPlaneRef,
  newCanonicalPlaneRef,
  type PlaneBasis
} from '@openzcad/geometry';
import { projectToScreen } from '@openzcad/viewport';
import * as THREE from 'three';
import {
  arcDimension,
  arcObjectFromPoints,
  arcPreviewPoints,
  adaptiveGridSpacing,
  axisLockPoint,
  circleObjectFromDiameter,
  circleObjectFromThreePoints,
  circlePreviewPoints,
  centerInferenceSegments,
  collectSketchSnapTargets,
  SKETCH_SNAP_LIMITS,
  SketchSnapLimitError,
  angleForInProgress,
  dimensionForInProgress,
  frameFromFace,
  lineObjectFromPoints,
  nearestSnapTarget,
  nearestCenterGuideTarget,
  pointAtDistanceAlongDirection,
  rankSnapTargets,
  resolveSketchSnap,
  screenRayToPlanePoint,
  sketchEntryPose,
  sketchEntryUp,
  sketchContentFramePoints,
  sketchObjectFromDrag,
  snapSketchPoint,
  snapTargetsForObject,
  placeSketchObjectGrabPoint,
  sketchObjectGrabPoint,
  sketchObjectMovable,
  sketchObjectRotatable,
  sketchMovePointerRole,
  rebaseSketchMove,
  sameRotation,
  sketchHandleAtScreen,
  SKETCH_ROTATE_RING_BAND_PX,
  SKETCH_ROTATE_RING_RADIUS_PX,
  SketchMovePointerGate,
  sketchMoveChanged,
  rotateTextObject,
  textRotationFromRingDrag,
  translateSketchObject
} from './session';

describe('snapSketchPoint / sketchObjectFromDrag', () => {
  it('chooses adaptive grid spacing from the 1-2-5 sequence', () => {
    expect(adaptiveGridSpacing(0.01)).toBe(0.5);
    expect(adaptiveGridSpacing(0.04)).toBe(2);
    expect(adaptiveGridSpacing(0.2)).toBe(10);
  });

  it('snaps to the grid step', () => {
    expect(snapSketchPoint({ x: 3.4, y: -2.6 }, 1)).toEqual({ x: 3, y: -3 });
    expect(snapSketchPoint({ x: 3.4, y: -2.6 }, 0.5)).toEqual({
      x: 3.5,
      y: -2.5
    });
  });

  it('uses a deterministic direction for click-then-type exact entry', () => {
    expect(
      pointAtDistanceAlongDirection({ x: 2, y: 3 }, { x: 2, y: 3 }, 25)
    ).toEqual({ x: 27, y: 3 });
    expect(
      pointAtDistanceAlongDirection({ x: 0, y: 0 }, { x: 3, y: 4 }, 10)
    ).toEqual({ x: 6, y: 8 });
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

  it('builds circles from opposite diameter endpoints', () => {
    expect(circleObjectFromDiameter({ x: -4, y: 2 }, { x: 6, y: 2 })).toEqual({
      objectKind: 'circle',
      radius: 5,
      centerX: 1,
      centerY: 2
    });
    expect(
      circleObjectFromDiameter({ x: 0, y: 0 }, { x: 0.2, y: 0 })
    ).toBeNull();
  });

  it('builds a unique three-point circle and rejects collinear input', () => {
    const circle = circleObjectFromThreePoints(
      { x: 5, y: 0 },
      { x: 0, y: 5 },
      { x: -5, y: 0 }
    );
    expect(circle).toMatchObject({
      objectKind: 'circle',
      centerX: 0,
      centerY: 0,
      radius: 5
    });
    expect(
      circleObjectFromThreePoints(
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 1e-12 }
      )
    ).toBeNull();
    expect(
      circle && circle.objectKind === 'circle'
        ? circlePreviewPoints(circle, 32)
        : []
    ).toHaveLength(32);
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

  // Screen direction of a +10 step along the plane's u and v axes, seen from
  // the entry pose with world +Z up — the camera the sketch glide arrives at
  // on a canonical plane.
  const screenAxes = (basis: PlaneBasis) => {
    const pose = sketchEntryPose(basis, 200);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    camera.updateMatrixWorld();
    const at = (u: number, v: number) =>
      projectToScreen(
        new THREE.Vector3(
          basis.origin.x + basis.u.x * u + basis.v.x * v,
          basis.origin.y + basis.u.y * u + basis.v.y * v,
          basis.origin.z + basis.u.z * u + basis.v.z * v
        ),
        camera,
        800,
        800
      )!;
    const origin = at(0, 0);
    const u = at(10, 0);
    const v = at(0, 10);
    return {
      u: { x: u.x - origin.x, y: u.y - origin.y },
      v: { x: v.x - origin.x, y: v.y - origin.y }
    };
  };

  it('enters every new canonical sketch reading +u right and +v up', () => {
    for (const plane of ['XY', 'XZ', 'YZ'] as const) {
      const basis = frameForPlaneRef(newCanonicalPlaneRef(plane, 0), Number);
      const { u, v } = screenAxes(basis);
      expect(u.x, `${plane} +u`).toBeGreaterThan(10);
      expect(Math.abs(u.y), `${plane} +u`).toBeLessThan(0.5);
      // Screen y grows downward, so up is negative.
      expect(v.y, `${plane} +v`).toBeLessThan(-10);
      expect(Math.abs(v.x), `${plane} +v`).toBeLessThan(0.5);
    }
  });

  it('enters a new Front (XZ) sketch from the front of the model', () => {
    const basis = frameForPlaneRef(newCanonicalPlaneRef('XZ', 0), Number);
    expect(sketchEntryPose(basis, 100).position).toEqual({
      x: 0,
      y: -100,
      z: 0
    });
  });

  it('keeps a revision-1 XZ sketch on the pose it was drawn against', () => {
    // Saved documents' XZ sketches still resolve to the old basis, entered
    // from behind the model; the measured mirror is what they always showed.
    const { u, v } = screenAxes(PLANE_BASES.XZ);
    expect(u.x).toBeLessThan(-10);
    expect(v.y).toBeGreaterThan(10);
  });

  it('tilts the top view a hair off +Z to keep orbit math stable', () => {
    const pose = sketchEntryPose(PLANE_BASES.XY, 50);
    expect(pose.position.y).toBeLessThan(0);
    expect(pose.position.z).toBeCloseTo(50, 1);
  });

  it('keeps world up on canonical planes, offset or not', () => {
    for (const basis of Object.values(PLANE_BASES)) {
      expect(sketchEntryUp(basis)).toBeNull();
      expect(sketchEntryUp({ ...basis, origin: { x: 3, y: -4, z: 12 } })).toBe(
        null
      );
      expect(sketchEntryPose(basis, 80).up).toBeNull();
    }
  });

  it('rolls a top-face sketch so +u reads rightward and +v upward', () => {
    const frame = frameFromFace({ x: 31, y: 25, z: 10 }, { x: 0, y: 0, z: 1 });
    // Premise: the stored frame's u runs along world -Y on a top face.
    expect(frame.xAxis.y).toBeCloseTo(-1, 9);
    const basis = {
      origin: frame.origin,
      u: frame.xAxis,
      v: frame.yAxis,
      normal: frame.zAxis
    };
    const pose = sketchEntryPose(basis, 120);
    expect(pose.up).toEqual(frame.yAxis);

    const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 4000);
    camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    camera.up.set(pose.up!.x, pose.up!.y, pose.up!.z);
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z);
    camera.updateMatrixWorld(true);
    const at = (x: number, y: number) =>
      projectToScreen(
        new THREE.Vector3(
          basis.origin.x + basis.u.x * x + basis.v.x * y,
          basis.origin.y + basis.u.y * x + basis.v.y * y,
          basis.origin.z + basis.u.z * x + basis.v.z * y
        ),
        camera,
        900,
        600
      )!;
    const origin = at(0, 0);
    const stepU = at(10, 0);
    const stepV = at(0, 10);
    expect(stepU.x - origin.x).toBeGreaterThan(1);
    expect(Math.abs(stepU.y - origin.y)).toBeLessThan(1e-6);
    // Screen y grows downward.
    expect(origin.y - stepV.y).toBeGreaterThan(1);
    expect(Math.abs(stepV.x - origin.x)).toBeLessThan(1e-6);
    // Even without the held roll, world up projects onto v here.
    const worldUp = new THREE.PerspectiveCamera();
    worldUp.up.set(0, 0, 1);
    worldUp.position.copy(camera.position);
    worldUp.lookAt(pose.target.x, pose.target.y, pose.target.z);
    worldUp.updateMatrixWorld(true);
    const screenUp = new THREE.Vector3().setFromMatrixColumn(
      worldUp.matrixWorld,
      1
    );
    expect(screenUp.x).toBeCloseTo(1, 6);
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

describe('angleForInProgress', () => {
  it('measures counter-clockwise from +X, wrapped to [0, 360)', () => {
    expect(angleForInProgress({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(53.1);
    expect(angleForInProgress({ x: 0, y: 0 }, { x: -1, y: 0 })).toBe(180);
    expect(angleForInProgress({ x: 0, y: 0 }, { x: 0, y: -2 })).toBe(270);
    expect(angleForInProgress({ x: 5, y: 5 }, { x: 9, y: 5 })).toBe(0);
    // A hair below the +X axis rounds to 360, which must read as 0.
    expect(angleForInProgress({ x: 0, y: 0 }, { x: 1000, y: -0.5 })).toBe(0);
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
      { x: 0, y: 0, kind: 'endpoint', pointRef: 'start' },
      { x: 10, y: 4, kind: 'endpoint', pointRef: 'end' },
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

  it('collects circle centers and quadrants plus arc endpoints', () => {
    const circleTargets = snapTargetsForObject(
      { objectKind: 'circle', radius: 5, centerX: 3, centerY: -2 },
      identity
    );
    expect(circleTargets).toContainEqual({
      x: 3,
      y: -2,
      kind: 'center',
      pointRef: 'center'
    });
    expect(circleTargets).toContainEqual({ x: 8, y: -2, kind: 'quadrant' });
    expect(circleTargets).toHaveLength(5);

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
    expect(arcTargets).toContainEqual({
      x: 0,
      y: 0,
      kind: 'center',
      pointRef: 'center'
    });
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

  it('ranks semantic specificity before distance and cycles deterministically', () => {
    const targets = [
      { id: 'mid', x: 0, y: 0.1, kind: 'midpoint' as const },
      { id: 'end', x: 0, y: 0.4, kind: 'endpoint' as const }
    ];
    expect(rankSnapTargets({ x: 0, y: 0 }, targets, 1)[0]?.target.id).toBe(
      'end'
    );
    expect(
      resolveSketchSnap({ x: 0, y: 0 }, targets, 1, { cycle: 1 })?.target.id
    ).toBe('mid');
  });

  it('holds a snap through the hysteresis radius', () => {
    const targets = [
      { id: 'a', x: 0, y: 0, kind: 'endpoint' as const },
      { id: 'b', x: 0.9, y: 0, kind: 'endpoint' as const }
    ];
    expect(
      resolveSketchSnap({ x: 0.8, y: 0 }, targets, 1, { lockedId: 'a' })?.target
        .id
    ).toBe('a');
    expect(
      resolveSketchSnap({ x: 1.6, y: 0 }, targets, 1, { lockedId: 'a' })?.target
        .id
    ).toBe('b');
  });

  it('collects the sketch origin and exact crossings', () => {
    const targets = collectSketchSnapTargets(
      [
        {
          id: 'horizontal',
          data: { objectKind: 'line', x1: -5, y1: 0, x2: 5, y2: 0 }
        },
        {
          id: 'vertical',
          data: { objectKind: 'line', x1: 2, y1: -5, x2: 2, y2: 5 }
        }
      ],
      identity
    );
    expect(targets).toContainEqual({
      id: 'sketch-origin',
      x: 0,
      y: 0,
      kind: 'origin'
    });
    expect(targets).toContainEqual(
      expect.objectContaining({ x: 2, y: 0, kind: 'intersection' })
    );
  });

  type SnapObject = { id: string; data: SketchObjectData };

  const parallelLines = (count: number) =>
    Array.from({ length: count }, (_, index): SnapObject => ({
      id: `line-${index}`,
      data: {
        objectKind: 'line',
        x1: -10,
        y1: index,
        x2: 10,
        y2: index
      }
    }));

  it('refuses oversized inputs before evaluating any parameters', () => {
    const resolve = vi.fn(identity);
    const cases = [
      {
        objects: Array.from(
          { length: SKETCH_SNAP_LIMITS.objects + 1 },
          (_, i): SnapObject => ({
            id: `circle-${i}`,
            data: {
              objectKind: 'circle',
              radius: 1,
              centerX: 0,
              centerY: 0
            }
          })
        ),
        budget: 'objects'
      },
      {
        objects: parallelLines(SKETCH_SNAP_LIMITS.segments + 1),
        budget: 'segments'
      },
      // 363 segments make 65,703 visited pairs, even when all are parallel.
      { objects: parallelLines(363), budget: 'pairs' },
      {
        objects: [
          {
            ...parallelLines(1)[0]!,
            id: 'x'.repeat(SKETCH_SNAP_LIMITS.objectIdLength + 1)
          }
        ],
        budget: 'objectIdLength'
      }
    ];
    for (const { objects, budget } of cases) {
      expect(() => collectSketchSnapTargets(objects, resolve)).toThrow(
        expect.objectContaining({ name: 'SketchSnapLimitError', budget })
      );
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('counts rectangle edges and skipped same-source pairs in the work budget', () => {
    const resolve = vi.fn(identity);
    const rectangles = Array.from({ length: 91 }, (): SnapObject => ({
      id: 'same-source',
      data: {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 0,
        centerY: 0
      }
    }));
    expect(() => collectSketchSnapTargets(rectangles, resolve)).toThrow(
      expect.objectContaining({ budget: 'pairs' })
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('retains normal snap points at the input and pair budget boundaries', () => {
    const circles = Array.from(
      { length: SKETCH_SNAP_LIMITS.objects },
      (_, i): SnapObject => ({
        id: `circle-${i}`,
        data: {
          objectKind: 'circle',
          radius: 2,
          centerX: i,
          centerY: 0
        }
      })
    );
    expect(collectSketchSnapTargets(circles, identity)).toHaveLength(5121);
    const lines = parallelLines(362);
    lines[0]!.id = 'x'.repeat(SKETCH_SNAP_LIMITS.objectIdLength);
    expect(collectSketchSnapTargets(lines, identity)).toHaveLength(1087);
  });

  it('refuses dense crossing output atomically instead of returning a partial snap set', () => {
    const crossings = parallelLines(128).map((object, index): SnapObject => ({
      ...object,
      data: {
        objectKind: 'line',
        x1: -10,
        y1: -(index + 1),
        x2: 10,
        y2: index + 1
      }
    }));
    expect(
      collectSketchSnapTargets(crossings.slice(0, 125), identity)
    ).toHaveLength(8126);
    expect(() => collectSketchSnapTargets(crossings, identity)).toThrow(
      expect.objectContaining({ budget: 'targets' })
    );
    expect(() => collectSketchSnapTargets(crossings, identity)).toThrow(
      SketchSnapLimitError
    );
  });

  it('previews the nearest center without changing the snap tolerance', () => {
    const targets = [
      { id: 'origin', x: 0, y: 0, kind: 'origin' as const },
      { id: 'rect-center', x: 8, y: 0, kind: 'center' as const },
      { id: 'endpoint', x: 6, y: 0, kind: 'endpoint' as const }
    ];
    expect(nearestCenterGuideTarget({ x: 6.5, y: 0 }, targets, 4)?.id).toBe(
      'rect-center'
    );
    expect(nearestCenterGuideTarget({ x: 6.5, y: 0 }, targets, 1)).toBeNull();
  });

  it('builds orthogonal center guides only for exact center targets', () => {
    expect(
      centerInferenceSegments({ x: 4, y: -2, kind: 'center' }, 10)
    ).toEqual([
      [
        { x: -6, y: -2 },
        { x: 14, y: -2 }
      ],
      [
        { x: 4, y: -12 },
        { x: 4, y: 8 }
      ]
    ]);
    expect(centerInferenceSegments({ x: 4, y: -2, kind: 'grid' }, 10)).toEqual(
      []
    );
  });
});

describe('sketchContentFramePoints', () => {
  const resolve = (value: unknown) => value as number;

  it('lifts a circle through a non-XY basis, quadrants included', () => {
    const points = sketchContentFramePoints(
      [
        {
          data: {
            objectKind: 'circle',
            centerX: 10,
            centerY: 0,
            radius: 5
          } as never
        }
      ],
      resolve,
      PLANE_BASES.XZ
    );
    // XZ basis: sketch x → world x, sketch y → world z.
    expect(points).toContainEqual({ x: 10, y: 0, z: 0 });
    expect(points).toContainEqual({ x: 15, y: 0, z: 0 });
    expect(points).toContainEqual({ x: 10, y: 0, z: 5 });
    // Every lifted point stays on the sketch plane (world y = 0 for XZ).
    for (const point of points) {
      expect(point.y).toBe(0);
    }
  });

  it('returns no points for an empty sketch', () => {
    expect(sketchContentFramePoints([], resolve, PLANE_BASES.XY)).toEqual([]);
  });
});

describe('sketch object drag-move helpers', () => {
  const resolve = (value: unknown) => Number(value);
  const circle: SketchObjectData = {
    objectKind: 'circle',
    radius: 5,
    centerX: -15,
    centerY: 20
  };
  const text: SketchObjectData = {
    objectKind: 'text',
    text: 'Boa',
    fontFamily: 'open-sans',
    fontStyle: 'regular',
    size: 8,
    x: 3,
    y: 4
  };
  const line: SketchObjectData = {
    objectKind: 'line',
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 5
  };

  it('grabs closed shapes by their centre and text by its baseline origin', () => {
    expect(sketchObjectGrabPoint(circle, resolve)).toEqual({ x: -15, y: 20 });
    expect(
      sketchObjectGrabPoint(
        {
          objectKind: 'rectangle',
          width: 4,
          height: 2,
          centerX: 1,
          centerY: 2
        },
        resolve
      )
    ).toEqual({ x: 1, y: 2 });
    expect(
      sketchObjectGrabPoint(
        { objectKind: 'polygon', sides: 6, radius: 3, centerX: 7, centerY: 8 },
        resolve
      )
    ).toEqual({ x: 7, y: 8 });
    expect(sketchObjectGrabPoint(text, resolve)).toEqual({ x: 3, y: 4 });
    // Lines and arcs are grabbed anywhere along the curve instead.
    expect(sketchObjectGrabPoint(line, resolve)).toBeNull();
  });

  it('lands a grab point exactly on the snapped target', () => {
    expect(placeSketchObjectGrabPoint(circle, { x: 0, y: 0 })).toEqual({
      ...circle,
      centerX: 0,
      centerY: 0
    });
    expect(placeSketchObjectGrabPoint(text, { x: 12.5, y: -1 })).toEqual({
      ...text,
      x: 12.5,
      y: -1
    });
  });

  it('translates every position field and nothing else', () => {
    expect(translateSketchObject(line, 2, -3, resolve)).toEqual({
      objectKind: 'line',
      x1: 2,
      y1: -3,
      x2: 12,
      y2: 2
    });
    const arc: SketchObjectData = {
      objectKind: 'arc',
      centerX: 1,
      centerY: 1,
      radius: 4,
      startAngleDeg: 0,
      endAngleDeg: 90,
      construction: true
    };
    expect(translateSketchObject(arc, 1, 1, resolve)).toEqual({
      ...arc,
      centerX: 2,
      centerY: 2
    });
  });

  it('refuses a drag that would overwrite an expression', () => {
    expect(sketchObjectMovable(circle)).toBe(true);
    expect(sketchObjectMovable({ ...circle, centerX: '12.5' })).toBe(true);
    expect(sketchObjectMovable({ ...circle, centerX: 'offset * 2' })).toBe(
      false
    );
    expect(sketchObjectMovable({ ...line, y2: 'height' })).toBe(false);
    // A size expression is kept as written, so it does not block a move.
    expect(sketchObjectMovable({ ...circle, radius: 'r' })).toBe(true);
    expect(sketchObjectRotatable(text)).toBe(true);
    expect(sketchObjectRotatable({ ...text, rotation: 30 })).toBe(true);
    expect(sketchObjectRotatable({ ...text, rotation: 'angle' })).toBe(false);
    expect(sketchObjectRotatable(circle)).toBe(false);
  });

  it('turns text by the angle the ring was dragged through', () => {
    const origin = { x: 0, y: 0 };
    // A quarter turn counter-clockwise from +X to +Y.
    expect(
      textRotationFromRingDrag(origin, { x: 10, y: 0 }, { x: 0, y: 10 }, 0)
    ).toBe(90);
    // Whole degrees unless free, normalised to (-180, 180].
    expect(
      textRotationFromRingDrag(origin, { x: 10, y: 0 }, { x: 10, y: 0.3 }, 0)
    ).toBe(2);
    expect(
      textRotationFromRingDrag(
        origin,
        { x: 10, y: 0 },
        { x: 10, y: 0.3 },
        0,
        true
      )
    ).toBeCloseTo(1.718, 3);
    expect(
      textRotationFromRingDrag(origin, { x: 10, y: 0 }, { x: -10, y: 0 }, 90)
    ).toBe(-90);
    expect(
      textRotationFromRingDrag(origin, { x: 10, y: 0 }, { x: 0, y: -10 }, -90)
    ).toBe(180);
  });
});

describe('sketchMovePointerRole', () => {
  it('lets only the holding pointer drive a sketch object drag', () => {
    // No drag: every pointer is free to press.
    expect(sketchMovePointerRole(null, 1)).toBe('free');
    expect(sketchMovePointerRole(undefined, 2)).toBe('free');
    // Pointer 1 holds the drag: a second press, move, release or cancel
    // from pointer 2 is ignored, and pointer 1's release still ends it.
    expect(sketchMovePointerRole(1, 2)).toBe('other');
    expect(sketchMovePointerRole(1, 1)).toBe('owner');
    // Pointer id 0 is a real id (the first touch), not "no drag".
    expect(sketchMovePointerRole(0, 0)).toBe('owner');
    expect(sketchMovePointerRole(0, 1)).toBe('other');
  });
});

describe('a drag that ends where it began commits nothing', () => {
  const resolve = (value: unknown) => Number(value);
  const text: SketchObjectData = {
    objectKind: 'text',
    text: 'Boa',
    fontFamily: 'open-sans',
    fontStyle: 'regular',
    size: 8,
    x: 3,
    y: 4
  };

  it('keeps an absent text rotation absent when the ring returns to the start', () => {
    const origin = { x: 3, y: 4 };
    const from = { x: 13, y: 4 };
    const rotation = textRotationFromRingDrag(origin, from, from, 0);
    const turned = rotateTextObject(text, rotation);
    expect(rotation).toBe(0);
    expect(turned).not.toHaveProperty('rotation');
    // No change means no commit, so no solve and no undo entry.
    expect(sketchMoveChanged(text, turned, resolve)).toBe(false);
    // An explicit 0 is the same value as the absent default.
    expect(sketchMoveChanged(text, { ...text, rotation: 0 }, resolve)).toBe(
      false
    );
    expect(sketchMoveChanged(text, rotateTextObject(text, 15), resolve)).toBe(
      true
    );
  });

  it('compares positions by value and everything else exactly', () => {
    const circle: SketchObjectData = {
      objectKind: 'circle',
      radius: 5,
      centerX: '12.5',
      centerY: 2
    };
    expect(
      sketchMoveChanged(
        circle,
        placeSketchObjectGrabPoint(circle, { x: 12.5, y: 2 }),
        resolve
      )
    ).toBe(false);
    expect(
      sketchMoveChanged(
        circle,
        placeSketchObjectGrabPoint(circle, { x: 13, y: 2 }),
        resolve
      )
    ).toBe(true);
    expect(
      sketchMoveChanged(
        text,
        translateSketchObject(text, 0, 0, resolve),
        resolve
      )
    ).toBe(false);
    expect(sketchMoveChanged(text, { ...text, text: 'Bob' }, resolve)).toBe(
      true
    );
  });
});

describe('SketchMovePointerGate', () => {
  it('ignores a second pointer through its own release, in either order', () => {
    const gate = new SketchMovePointerGate();
    // Pointer 1 presses with no drag held and starts one.
    expect(gate.press(null, 1)).toBe(false);
    // Pointer 2 presses while 1 holds the drag: ignored, moves included.
    expect(gate.press(1, 2)).toBe(true);
    expect(gate.ignores(2)).toBe(true);
    // Pointer 1 releases first and commits: its release is not swallowed.
    expect(gate.release(1)).toBe(false);
    // The drag is over, but pointer 2's late release is still swallowed,
    // so it cannot land as a selection click.
    expect(gate.ignores(2)).toBe(true);
    expect(gate.release(2)).toBe(true);
    expect(gate.ignores(2)).toBe(false);
    // The usual order works too: 2 lets go while 1 still holds the drag.
    expect(gate.press(1, 3)).toBe(true);
    expect(gate.release(3)).toBe(true);
    expect(gate.release(3)).toBe(false);
  });

  it('a fresh press retires an ignored id whose release never arrived', () => {
    const gate = new SketchMovePointerGate();
    expect(gate.press(1, 2)).toBe(true);
    // Pointer 2's release was lost off the canvas; ids are reused.
    expect(gate.press(null, 2)).toBe(false);
    expect(gate.ignores(2)).toBe(false);
  });
});

describe('SketchMovePointerGate suppression', () => {
  it('a keyboard-ended drag swallows only its own pointer’s release', () => {
    const gate = new SketchMovePointerGate();
    expect(gate.press(null, 1)).toBe(false);
    // Escape (or Enter) ends pointer 1's drag while it is still down.
    gate.suppress(1);
    // Pointer 2 presses before pointer 1 lets go: it is a fresh press of its
    // own and must not retire pointer 1's suppression.
    expect(gate.press(null, 2)).toBe(false);
    expect(gate.ignores(1)).toBe(true);
    // Pointer 1's late release over empty canvas is swallowed, not a click.
    expect(gate.release(1)).toBe(true);
    expect(gate.ignores(1)).toBe(false);
    // Pointer 2 was never suppressed: its release is its own.
    expect(gate.release(2)).toBe(false);
  });
});

describe('a move edited under the drag', () => {
  const resolve = (value: unknown) => Number(value);
  const circle: SketchObjectData = {
    objectKind: 'circle',
    radius: 5,
    centerX: -15,
    centerY: 20
  };

  it('keeps the concurrent edit and applies the drag on top of it', () => {
    const moved = placeSketchObjectGrabPoint(circle, { x: 0, y: 0 });
    // A collaborator changed the radius while the centre was held.
    const current: SketchObjectData = { ...circle, radius: 8 };
    expect(rebaseSketchMove(circle, moved, current, resolve)).toEqual({
      objectKind: 'circle',
      radius: 8,
      centerX: 0,
      centerY: 0
    });
    // Unedited: the drag's own data, untouched.
    expect(rebaseSketchMove(circle, moved, circle, resolve)).toBe(moved);
  });

  it('moves a concurrently moved object by the drag’s delta', () => {
    const text: SketchObjectData = {
      objectKind: 'text',
      text: 'Boa',
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 8,
      x: 3,
      y: 4
    };
    const moved = placeSketchObjectGrabPoint(text, { x: 10, y: 4 });
    const current: SketchObjectData = { ...text, text: 'Bob', size: 9, x: 5 };
    expect(rebaseSketchMove(text, moved, current, resolve)).toEqual({
      ...current,
      x: 12,
      y: 4
    });
    // A turn replays as a turn from wherever the rotation now is.
    const turned = rotateTextObject(text, 30);
    expect(
      rebaseSketchMove(text, turned, { ...text, rotation: 160 }, resolve)
    ).toEqual({ ...text, rotation: -170 });
  });

  it('refuses when the drag can no longer apply', () => {
    const moved = placeSketchObjectGrabPoint(circle, { x: 0, y: 0 });
    expect(
      rebaseSketchMove(circle, moved, { ...circle, centerX: 'offset' }, resolve)
    ).toBeNull();
    expect(
      rebaseSketchMove(
        circle,
        moved,
        { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 },
        resolve
      )
    ).toBeNull();
  });
});

describe('sketchHandleAtScreen', () => {
  it('hits the visible ring edge on an obliquely seen plane', () => {
    // The XY plane seen from well off its normal, as after an orbit.
    const width = 1280;
    const height = 720;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    camera.position.set(0, -160, 90);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const origin = new THREE.Vector3(0, 0, 0);
    const grab = projectToScreen(origin, camera, width, height)!;
    expect(grab).not.toBeNull();

    // Plane point under a screen pixel, by ray against z = 0.
    const planeAt = (pixel: { x: number; y: number }) => {
      const ndc = new THREE.Vector2(
        (pixel.x / width) * 2 - 1,
        1 - (pixel.y / height) * 2
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
        new THREE.Vector3()
      )!;
    };
    const worldPerPixel =
      (2 *
        camera.position.distanceTo(origin) *
        Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) /
      height;

    // Presses on the drawn ring, beside and above its centre.
    for (const offset of [
      { x: SKETCH_ROTATE_RING_RADIUS_PX, y: 0 },
      { x: 0, y: -SKETCH_ROTATE_RING_RADIUS_PX }
    ]) {
      const pointer = { x: grab.x + offset.x, y: grab.y + offset.y };
      expect(sketchHandleAtScreen(pointer, grab, true)).toBe('rotate');
      expect(sketchHandleAtScreen(pointer, grab, false)).toBeNull();
    }
    // The foreshortened press, measured on the plane instead, lands well
    // outside the ring's band: the miss this test guards against.
    const above = planeAt({
      x: grab.x,
      y: grab.y - SKETCH_ROTATE_RING_RADIUS_PX
    });
    const planePixels = above.distanceTo(origin) / worldPerPixel;
    expect(
      Math.abs(planePixels - SKETCH_ROTATE_RING_RADIUS_PX)
    ).toBeGreaterThan(SKETCH_ROTATE_RING_BAND_PX);

    expect(
      sketchHandleAtScreen({ x: grab.x + 4, y: grab.y - 3 }, grab, true)
    ).toBe('translate');
    expect(
      sketchHandleAtScreen({ x: grab.x + 80, y: grab.y }, grab, true)
    ).toBeNull();
  });
});

describe('a full-turn rotation dragged back to its start', () => {
  const resolve = (value: unknown) => Number(value);
  const text = (
    rotation: number
  ): Extract<SketchObjectData, { objectKind: 'text' }> => ({
    objectKind: 'text',
    text: 'Boa',
    fontFamily: 'open-sans',
    fontStyle: 'regular',
    size: 8,
    x: 3,
    y: 4,
    rotation
  });

  it('keeps a stored 360 or -360 verbatim and commits nothing', () => {
    for (const stored of [360, -360, 720]) {
      const original = text(stored);
      const origin = { x: 3, y: 4 };
      const from = { x: 13, y: 4 };
      // The ring readout is normalised, so it reports 0 for a full turn.
      const angle = textRotationFromRingDrag(origin, from, from, stored);
      expect(angle).toBe(0);
      const turned = rotateTextObject(original, angle);
      // The same object back: no rewritten field, so no commit, no solve
      // and no undo entry.
      expect(turned).toBe(original);
      expect(sketchMoveChanged(original, turned, resolve)).toBe(false);
      // Even a rewritten 0 reads as the same angle.
      expect(
        sketchMoveChanged(original, { ...original, rotation: 0 }, resolve)
      ).toBe(false);
      expect(rebaseSketchMove(original, turned, original, resolve)).toBe(
        turned
      );
    }
    expect(sameRotation(360, 0)).toBe(true);
    expect(sameRotation(-360, 0)).toBe(true);
    expect(sameRotation(359.5, 0)).toBe(false);
    expect(sketchMoveChanged(text(360), text(10), resolve)).toBe(true);
  });
});
