/**
 * Whether the turns of an in-place helical sweep clear one another, measured
 * from the profile's own curves.
 *
 * A screw about an axis carries the point at height `z` and angle `φ` to
 * `z + pitch·θ/2π`, `φ + θ`. Two profile points meet again after a turn
 * exactly when their values of `h = z − pitch·φ/2π` differ by a whole number
 * of pitches, so the coils stay apart while `h` spans less than one pitch
 * over the profile, and a pair one pitch apart is only reached once the
 * sweep turns far enough to bring the profile round to itself: a full turn,
 * less the angle the profile itself subtends at the axis.
 *
 * The kernel applies the same rule (`helicalSweepInPlace` refuses "coils
 * would overlap"), but reads the span from 48 points on each curve. On a
 * Ø3 mm circle whose extremes fall between those points it reads 2.9938 mm,
 * so a one-turn coil at a 2.997 mm pitch was built with its two end caps
 * overlapping in one plane (issue #2188). This module finds the extremes
 * themselves, each refined on its curve to machine precision, and the
 * builder refuses on that span before the kernel is asked.
 */
import { geometryTolerance } from '@openzcad/geometry';
import type { RemusKernel } from './remus-runtime';

type Triple = readonly [number, number, number];

/** The part of the kernel this module reads, so a test can supply a double. */
export type HelicalClearanceKernel = Pick<
  RemusKernel,
  | 'getFaceEdges'
  | 'getEdgeParamSpan'
  | 'evaluateEdgeCurve'
  | 'getNurbsCurveData'
>;

export interface HelicalSectionExtent {
  /** How far `z − pitch·φ/2π` ranges over the profile: what a turn must clear. */
  span: number;
  /** The angle the profile subtends at the axis, in radians. */
  angularWidth: number;
  /** The profile's nearest approach to the axis. */
  minRadius: number;
}

const TAU = 2 * Math.PI;
/** Samples on each polynomial span of a curve, before the extremes are refined. */
const SAMPLES_PER_SPAN = 48;
const MAX_SAMPLES_PER_EDGE = 4096;
const MAX_EDGES = 2048;
/** Golden-section steps: the bracket shrinks by 0.618 each, to below 1e-12. */
const REFINE_STEPS = 60;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

function dot(a: Triple, b: Triple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Triple, b: Triple): Triple {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

/** An angle difference brought into (−π, π]. */
function wrapped(angle: number): number {
  const turned = angle - TAU * Math.round(angle / TAU);
  return turned <= -Math.PI ? turned + TAU : turned;
}

/** How many polynomial pieces the edge's curve has: lines and arcs, a few. */
function spanCount(kernel: HelicalClearanceKernel, edge: number): number {
  try {
    const data = JSON.parse(kernel.getNurbsCurveData(edge)) as {
      distinctKnots?: unknown;
    };
    return Array.isArray(data.distinctKnots)
      ? Math.max(1, data.distinctKnots.length - 1)
      : 1;
  } catch {
    return 1;
  }
}

interface Sample {
  point: Triple;
  /** Along the axis from its origin. */
  z: number;
  /** About the axis, continuous along the profile. */
  phi: number;
  radius: number;
}

/**
 * The extreme of `value` on one edge near the sample that is largest among
 * its neighbours, found by golden-section search between those neighbours.
 * `sign` is −1 for a minimum.
 */
function refined(
  at: (t: number) => number,
  lo: number,
  hi: number,
  sign: 1 | -1
): number {
  let a = lo;
  let b = hi;
  let c = b - GOLDEN * (b - a);
  let d = a + GOLDEN * (b - a);
  let fc = sign * at(c);
  let fd = sign * at(d);
  let best = Math.max(fc, fd);
  for (let step = 0; step < REFINE_STEPS; step += 1) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - GOLDEN * (b - a);
      fc = sign * at(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + GOLDEN * (b - a);
      fd = sign * at(d);
    }
    best = Math.max(best, fc, fd);
  }
  return sign * best;
}

/**
 * The profile face's extent under the screw about `axis` (a unit vector)
 * through `origin`, or null when its curves cannot be read; the kernel's own
 * check then stands alone, as it did before.
 */
export function helicalSectionExtent(
  kernel: HelicalClearanceKernel,
  face: number,
  origin: Triple,
  axis: Triple,
  pitch: number
): HelicalSectionExtent | null {
  let edges: number[];
  try {
    edges = [...new Set(Array.from(kernel.getFaceEdges(face)))];
  } catch {
    return null;
  }
  if (edges.length === 0 || edges.length > MAX_EDGES) return null;

  // The frame the angle is read in: `u` toward the first point read, so
  // the profile starts at angle zero, and `v` a quarter turn on from it the
  // way the kernel turns (right-handed about the axis).
  let u: Triple | null = null;
  let v: Triple | null = null;
  const locate = (point: Triple) => {
    const offset: Triple = [
      point[0] - origin[0],
      point[1] - origin[1],
      point[2] - origin[2]
    ];
    const z = dot(offset, axis);
    const radial: Triple = [
      offset[0] - axis[0] * z,
      offset[1] - axis[1] * z,
      offset[2] - axis[2] * z
    ];
    const radius = Math.hypot(radial[0], radial[1], radial[2]);
    if (u === null && radius > 0) {
      u = [radial[0] / radius, radial[1] / radius, radial[2] / radius];
      v = cross(axis, u);
    }
    const angle =
      u !== null && v !== null && radius > 0
        ? Math.atan2(dot(radial, v), dot(radial, u))
        : 0;
    return { z, radius, angle };
  };

  const anchored: Sample[] = [];
  let hMin = Infinity;
  let hMax = -Infinity;
  let phiMin = Infinity;
  let phiMax = -Infinity;
  let minRadius = Infinity;
  const height = (z: number, phi: number) => z - (pitch * phi) / TAU;

  try {
    for (const edge of edges) {
      const [t0, t1] = Array.from(kernel.getEdgeParamSpan(edge));
      if (
        t0 === undefined ||
        t1 === undefined ||
        !Number.isFinite(t0) ||
        !Number.isFinite(t1) ||
        t0 === t1
      ) {
        return null;
      }
      const count = Math.min(
        MAX_SAMPLES_PER_EDGE,
        SAMPLES_PER_SPAN * spanCount(kernel, edge)
      );
      const read = (t: number) => {
        const p = kernel.evaluateEdgeCurve(edge, t);
        const point: Triple = [p[0]!, p[1]!, p[2]!];
        return { point, ...locate(point) };
      };
      const parameters: number[] = [];
      const samples: Sample[] = [];
      for (let index = 0; index <= count; index += 1) {
        const t = t0 + ((t1 - t0) * index) / count;
        const here = read(t);
        if (
          !Number.isFinite(here.z) ||
          !Number.isFinite(here.radius) ||
          !(here.radius > 0)
        ) {
          // On the axis the angle has no value; the kernel refuses a
          // profile that touches the axis by name.
          return null;
        }
        const before = samples[samples.length - 1];
        let phi: number;
        if (before) {
          // Neighbouring points on a curve that keeps off the axis are less
          // than half a turn apart.
          phi = before.phi + wrapped(here.angle - before.phi);
        } else {
          // An edge takes up where the nearest point already placed stands:
          // the edge it joins end to end, or, for a hole, the nearest point
          // of the boundary round it. The straight line between them stays
          // inside the outer boundary, which does not enclose the axis, so
          // it too turns less than half a turn.
          const near = nearest(anchored, here.point);
          phi = near ? near.phi + wrapped(here.angle - near.phi) : 0;
        }
        parameters.push(t);
        samples.push({
          point: here.point,
          z: here.z,
          phi,
          radius: here.radius
        });
      }
      // Each sample that tops or bottoms its neighbours brackets an extreme
      // of the curve; refine it there. Strictly above the one before, so a
      // run of equal samples (a straight edge square to the axis) is read
      // once as it stands and not searched point by point.
      const valueAt =
        (pick: (z: number, phi: number, radius: number) => number, i: number) =>
        (t: number) => {
          const here = read(t);
          const base = samples[i]!;
          const phi = base.phi + wrapped(here.angle - base.phi);
          return pick(here.z, phi, here.radius);
        };
      const pickPhi = (_z: number, phi: number) => phi;
      const pickRadius = (_z: number, _phi: number, radius: number) => radius;
      for (let i = 0; i < samples.length; i += 1) {
        const here = samples[i]!;
        const h = height(here.z, here.phi);
        hMin = Math.min(hMin, h);
        hMax = Math.max(hMax, h);
        phiMin = Math.min(phiMin, here.phi);
        phiMax = Math.max(phiMax, here.phi);
        minRadius = Math.min(minRadius, here.radius);
        const prev = samples[i - 1];
        const next = samples[i + 1];
        if (!prev || !next) continue;
        const lo = parameters[i - 1]!;
        const hi = parameters[i + 1]!;
        const hPrev = height(prev.z, prev.phi);
        const hNext = height(next.z, next.phi);
        if (h > hPrev && h >= hNext) {
          hMax = Math.max(hMax, refined(valueAt(height, i), lo, hi, 1));
        }
        if (h < hPrev && h <= hNext) {
          hMin = Math.min(hMin, refined(valueAt(height, i), lo, hi, -1));
        }
        if (here.phi > prev.phi && here.phi >= next.phi) {
          phiMax = Math.max(phiMax, refined(valueAt(pickPhi, i), lo, hi, 1));
        }
        if (here.phi < prev.phi && here.phi <= next.phi) {
          phiMin = Math.min(phiMin, refined(valueAt(pickPhi, i), lo, hi, -1));
        }
        if (here.radius < prev.radius && here.radius <= next.radius) {
          minRadius = Math.min(
            minRadius,
            refined(valueAt(pickRadius, i), lo, hi, -1)
          );
        }
      }
      anchored.push(...samples);
    }
  } catch {
    return null;
  }
  if (
    !Number.isFinite(hMin) ||
    !Number.isFinite(hMax) ||
    !Number.isFinite(phiMin) ||
    !Number.isFinite(phiMax) ||
    !Number.isFinite(minRadius)
  ) {
    return null;
  }
  return {
    span: hMax - hMin,
    angularWidth: phiMax - phiMin,
    minRadius
  };
}

function nearest(samples: readonly Sample[], point: Triple): Sample | null {
  let best: Sample | null = null;
  let bestDistance = Infinity;
  for (const sample of samples) {
    const distance =
      (sample.point[0] - point[0]) ** 2 +
      (sample.point[1] - point[1]) ** 2 +
      (sample.point[2] - point[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sample;
    }
  }
  return best;
}

/**
 * Why the turns of this in-place helical sweep would run into one another,
 * or null when they clear.
 *
 * The coils overlap when the sweep turns far enough to bring the profile
 * round to itself and one turn climbs no more than the profile spans. Coils
 * that only touch are refused too: two turns meeting along a curve are not a
 * solid. A sweep short of a full turn is left alone, whatever its pitch.
 */
export function helicalCoilOverlap(
  extent: HelicalSectionExtent,
  pitch: number,
  turns: number
): string | null {
  const climb = Math.abs(pitch);
  // The angle left between the two ends of the coil, and the gap that
  // leaves at the profile's nearest point to the axis.
  const slack = TAU * (1 - turns) - extent.angularWidth;
  if (slack * extent.minRadius > geometryTolerance(extent.minRadius)) {
    return null;
  }
  if (extent.span < climb - geometryTolerance(Math.max(extent.span, climb))) {
    return null;
  }
  return `helical sweep coils would overlap: the profile spans ${String(extent.span)} along the axis, leaving no clearance at the pitch ${String(climb)}`;
}
