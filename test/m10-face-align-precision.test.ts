import { describe, expect, it } from 'vitest';
import type { Vector3 } from '@openzcad/shared';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { faceAlignPlacement } from '../apps/web/src/lib/inPlace/faceAlign';
import { eulerDegrees } from '../apps/web/src/lib/inPlace/primitives';

/**
 * M10 (slice 5b) review: Align stores its turn as Move's ZYX Euler degrees,
 * and the kernel replays the Move from those degrees. Near a quarter turn
 * about Y (gimbal lock in that convention) an `asin` extraction loses half
 * the digits: a 1000 mm face aligned onto a target a hair off −X came back
 * about 5e-6 mm out of flat. Every case here replays the STORED Move through
 * the kernel's own `transformMatrix` and measures the moved face's extreme
 * points against the target plane, for faces up to 10 m across.
 */

/** The repository's linear tolerance, in mm. */
const LINEAR_TOLERANCE = 1e-6;
/** Half the side of the square face measured: a 10 m face. */
const HALF = 5000;

const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const unit = (a: Vector3): Vector3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const neg = (a: Vector3): Vector3 => ({ x: -a.x, y: -a.y, z: -a.z });

/** `v` turned `deg` right-handed about a world axis. */
function turn(axis: 'x' | 'y' | 'z', deg: number, v: Vector3): Vector3 {
  const t = (deg * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  if (axis === 'x')
    return { x: v.x, y: c * v.y - s * v.z, z: s * v.y + c * v.z };
  if (axis === 'y')
    return { x: c * v.x + s * v.z, y: v.y, z: -s * v.x + c * v.z };
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y, z: v.z };
}

/** A deterministic generator, so a failure names a reproducible case. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * The worst distance of the moved face's corners from where they belong
 * (the target plane plus `offset`), after the stored Move is replayed by the
 * kernel's matrix.
 */
function worstFlatness(
  moving: Vector3,
  target: Vector3,
  options: { flip?: boolean; offset?: number; centre?: Vector3 } = {}
): number {
  const m = unit(moving);
  const t = unit(target);
  const centre = options.centre ?? { x: 123.25, y: -48.5, z: 310.75 };
  const on = { x: -40, y: 75, z: -12.5 };
  const offset = options.offset ?? 0;
  const placement = faceAlignPlacement({
    moving: { normal: m, point: centre },
    target: { normal: t, point: on },
    flip: options.flip,
    offset
  });
  if (!placement) throw new Error('No placement.');
  const matrix = transformMatrix(
    placement.translation,
    placement.rotationDeg,
    1,
    placement.pivot
  );
  const apply = (p: Vector3): Vector3 => ({
    x: matrix[0]! * p.x + matrix[1]! * p.y + matrix[2]! * p.z + matrix[3]!,
    y: matrix[4]! * p.x + matrix[5]! * p.y + matrix[6]! * p.z + matrix[7]!,
    z: matrix[8]! * p.x + matrix[9]! * p.y + matrix[10]! * p.z + matrix[11]!
  });
  const helper =
    Math.abs(m.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = unit(cross(m, helper));
  const v = cross(m, u);
  let worst = 0;
  for (const su of [-1, 0, 1]) {
    for (const sv of [-1, 0, 1]) {
      const corner = {
        x: centre.x + HALF * (su * u.x + sv * v.x),
        y: centre.y + HALF * (su * u.y + sv * v.y),
        z: centre.z + HALF * (su * u.z + sv * v.z)
      };
      const moved = apply(corner);
      const height = dot(
        { x: moved.x - on.x, y: moved.y - on.y, z: moved.z - on.z },
        t
      );
      worst = Math.max(worst, Math.abs(height - offset));
    }
  }
  return worst;
}

const AXES = ['x', 'y', 'z'] as const;
const PRINCIPAL: Vector3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 }
];
/** How far off an exact quarter turn, in degrees: down to the last bits. */
const NEAR = [0, 1e-14, 1e-12, 1e-10, 3.3e-8, 5.73e-7, 1e-6, 1e-4, 1e-2];

describe('Align stores a turn the kernel replays flat (M10 review)', () => {
  it('keeps a 1000 mm face flat on a target a hair off −X (the reported case)', () => {
    const target = unit({ x: -1, y: 0, z: -1e-8 });
    expect(worstFlatness({ x: 0, y: 0, z: 1 }, target)).toBeLessThan(
      LINEAR_TOLERANCE
    );
  });

  it('keeps faces flat for turns within a hair of a quarter turn about each axis', () => {
    let worst = 0;
    let at = '';
    for (const axis of AXES) {
      for (const moving of PRINCIPAL) {
        for (const sign of [1, -1]) {
          for (const near of NEAR) {
            for (const away of [1, -1]) {
              const deg = sign * 90 + away * near;
              // Face to face wants the turned normal against the target.
              const target = neg(turn(axis, deg, moving));
              for (const flip of [false, true]) {
                const flipped = flip ? neg(target) : target;
                const error = worstFlatness(moving, flipped, {
                  flip,
                  offset: 1.5
                });
                if (error > worst) {
                  worst = error;
                  at = `${axis} ${deg} ${JSON.stringify(moving)} flip=${flip}`;
                }
              }
            }
          }
        }
      }
    }
    expect(worst, at).toBeLessThan(LINEAR_TOLERANCE);
  });

  it('keeps faces flat for random normals, and for random ones near gimbal lock', () => {
    const random = seeded(0x5eed);
    const direction = () =>
      unit({ x: random() - 0.5, y: random() - 0.5, z: random() - 0.5 });
    let worst = 0;
    let at = '';
    for (let index = 0; index < 4000; index += 1) {
      const moving = direction();
      // Half the cases are arbitrary; half put the face a tiny turn off a
      // quarter turn about a random world axis from where it started.
      const target =
        index % 2 === 0
          ? direction()
          : neg(
              turn(
                AXES[index % 3]!,
                (random() < 0.5 ? 90 : -90) + (random() - 0.5) * 1e-6,
                moving
              )
            );
      const error = worstFlatness(moving, target, {
        offset: (random() - 0.5) * 10
      });
      if (error > worst) {
        worst = error;
        at = JSON.stringify({ moving, target });
      }
    }
    expect(worst, at).toBeLessThan(LINEAR_TOLERANCE);
  });

  it('extracts Euler degrees that compose back to the rotation near gimbal lock', () => {
    // Columns of Ry(90° − ε) for tiny ε, and the same after a turn about Z.
    for (const eps of [0, 1e-15, 1e-12, 1e-9, 1e-7, 1e-5]) {
      for (const about of [0, 30, -135]) {
        const b = Math.PI / 2 - eps;
        const x0 = { x: Math.cos(b), y: 0, z: -Math.sin(b) };
        const y0 = { x: 0, y: 1, z: 0 };
        const z0 = { x: Math.sin(b), y: 0, z: Math.cos(b) };
        const [x, y, z] = [x0, y0, z0].map((c) => turn('z', about, c));
        const deg = eulerDegrees(x!, y!, z!);
        const m = transformMatrix({ x: 0, y: 0, z: 0 }, deg);
        const columns = [x!, y!, z!];
        for (const [col, c] of columns.entries()) {
          expect(Math.abs(m[col]! - c.x)).toBeLessThan(1e-10);
          expect(Math.abs(m[4 + col]! - c.y)).toBeLessThan(1e-10);
          expect(Math.abs(m[8 + col]! - c.z)).toBeLessThan(1e-10);
        }
      }
    }
  });
});
