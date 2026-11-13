import {
  IDENTITY_TRANSFORM,
  isGearMeshRefusal,
  meshGearPair,
  type AssemblyFrame,
  type GearMeshGear,
  type GearMeshSolution,
  type RigidTransform,
  type Vector3
} from '@openzcad/shared';
import type { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';

/**
 * M14 meshing-pair helper test support: resolved gears, the helper's
 * solution, and a probe that builds gears with the kernel where the helper
 * puts them and classifies a grid of points across the pitch point (a
 * boolean intersection of two involute gears is far slower and refuses as
 * not exact).
 */

export const DEG = Math.PI / 180;

/** An m 2, 20-tooth, 5 wide spur gear on Z at the origin, ISO 53 form. */
export function gear(overrides: Partial<GearMeshGear> = {}): GearMeshGear {
  return {
    gearType: 'external',
    teeth: 20,
    module: 2,
    pressureAngleDeg: 20,
    profileShift: 0,
    addendum: 1,
    dedendum: 1.25,
    backlash: 0,
    helixAngleDeg: 0,
    hand: 'right',
    herringbone: false,
    faceWidth: 5,
    phaseDeg: 0,
    frame: {
      origin: { x: 0, y: 0, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 }
    },
    ...overrides
  };
}

export function solved(
  a: GearMeshGear,
  b: GearMeshGear,
  current: RigidTransform = IDENTITY_TRANSFORM
): GearMeshSolution {
  const result = meshGearPair(a, b, current);
  if (isGearMeshRefusal(result)) throw new Error(result.message);
  return result;
}

/** Gear building and point sampling on one kernel (created by the caller). */
export function createGearMeshProbe(kernel: () => RemusKernel) {
  let lastDetails: unknown = null;

  /**
   * Builds `g` on `frame` (its x direction sent as given, as the adapter
   * sends a stored one), turned `turnDeg` more about its axis.
   */
  function build(g: GearMeshGear, frame: AssemblyFrame, turnDeg = 0): number {
    const v = (p: Vector3) => [p.x, p.y, p.z];
    const spec: Record<string, unknown> = {
      kind: g.gearType,
      module: g.module,
      teeth: g.teeth,
      faceWidth: g.faceWidth,
      pressureAngle: g.pressureAngleDeg,
      backlash: g.backlash,
      origin: v(frame.origin),
      axis: v(frame.zAxis),
      xDirection: v(frame.xAxis)
    };
    if (g.gearType !== 'rack') spec.phase = g.phaseDeg + turnDeg;
    if (g.profileShift) spec.profileShift = g.profileShift;
    if (g.helixAngleDeg) {
      spec.helixAngle = g.helixAngleDeg;
      spec.hand = g.hand;
      if (g.herringbone) spec.herringbone = true;
    }
    if (g.addendum !== 1) spec.addendum = g.addendum;
    if (g.dedendum !== 1.25) spec.dedendum = g.dedendum;
    if (g.gearType === 'internal')
      spec.rimDiameter =
        (g.teeth * g.module) / Math.cos(g.helixAngleDeg * DEG) + 12 * g.module;
    const result = kernel().makeGearDetailed(JSON.stringify(spec)) as {
      status: string;
      value?: unknown;
      details?: unknown;
    };
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    lastDetails = result.details;
    const value = result.value as number | { solid: number };
    return typeof value === 'number' ? value : value.solid;
  }

  /** Grid points inside both solids, and inside each, about `p`. */
  function overlap(
    s1: number,
    s2: number,
    p: Vector3,
    tangent: Vector3,
    normal: Vector3,
    pitch: number,
    module: number,
    zs: number[],
    step = 0.1
  ) {
    let both = 0;
    let first = 0;
    let second = 0;
    for (const z of zs)
      for (let i = -pitch; i <= pitch + 1e-9; i += step)
        for (
          let j = -0.8 * module;
          j <= 0.8 * module + 1e-9;
          j += 0.4 * module
        ) {
          const x = p.x + tangent.x * i + normal.x * j;
          const y = p.y + tangent.y * i + normal.y * j;
          const inA = kernel().classifyPoint(s1, x, y, z, 1e-7) === 'inside';
          const inB = kernel().classifyPoint(s2, x, y, z, 1e-7) === 'inside';
          if (inA) first += 1;
          if (inB) second += 1;
          if (inA && inB) both += 1;
        }
    return { both, first, second };
  }

  /** The pitch point and its tangent, for a pair of gears on Z axes. */
  function pitchPoint(a: GearMeshGear, mesh: GearMeshSolution) {
    const o = mesh.frame.origin;
    const d = Math.hypot(o.x, o.y);
    const u = { x: o.x / d, y: o.y / d, z: 0 };
    const rw =
      (((a.module / Math.cos(a.helixAngleDeg * DEG)) * a.teeth) / 2) *
      (mesh.centerDistance / mesh.standardCenterDistance);
    const sign = mesh.pair === 'internal' && a.gearType !== 'internal' ? -1 : 1;
    return {
      p: { x: sign * u.x * rw, y: sign * u.y * rw, z: 0 },
      tangent: { x: -u.y, y: u.x, z: 0 },
      normal: u
    };
  }

  return { build, overlap, pitchPoint, lastDetails: () => lastDetails };
}
