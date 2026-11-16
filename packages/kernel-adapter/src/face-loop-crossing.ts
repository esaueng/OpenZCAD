/**
 * Planar faces whose boundary loops cross: a defect the kernel's validator
 * does not report.
 *
 * A face with holes is one outer loop and inner loops that lie inside it and
 * apart from each other. A blend can leave a face that breaks that and still
 * passes `validateSolidDetailed` with no error. Measured on the pinned
 * kernel: a 0.5 fillet along a plate outline that passes 0.137 outside the
 * base circle of a fused R7.75 hub moves the plate face's outer loop (its
 * spring line, 0.5 in) to 0.363 INSIDE the hub's base circle. The kernel
 * neither trims the face nor refuses, the two loops cross, the face covers
 * two lens-shaped regions it should not and leaves two holes it should not,
 * and the tessellation is open there. Those holes are in the model, not only
 * in its display mesh.
 *
 * Only planar faces are checked: their loops can be compared in the plane
 * without a parameter-space projection, and a plane is where this defect has
 * been seen.
 */
import type { Vec3 } from '@openzcad/geometry';
import type { RemusKernel } from './remus-runtime';
import { chainWireLoop } from './exact-face-centroid';
import { cross, dot, normalized, subtract } from './exact-math';
import { surfaceTypeOf } from './exact-sync-memo';

/**
 * How far one loop must reach past the other before it counts as crossing,
 * relative to the solid's largest bounding-box extent.
 *
 * The loops are compared as sampled polylines, so a boundary that genuinely
 * touches another (a hole tangent to the outline, two holes meeting at a
 * point) can measure a small false penetration: at most the two chord
 * deflections plus the kernel's own geometric tolerance. Sampling at a
 * quarter of this tolerance keeps that error well inside it. On the 40 mm
 * plate that motivated the check the tolerance is 4e-4 and the measured
 * crossing is 0.363, so the bound sits three orders of magnitude from the
 * defect while staying clear of every touching case.
 */
export const FACE_LOOP_CROSSING_TOLERANCE_RATIO = 1e-5;

/** The absolute floor of that tolerance, for very small solids. */
const FACE_LOOP_CROSSING_MIN_TOLERANCE = 1e-6;

/** A point in a face's plane. */
export interface Point2 {
  u: number;
  v: number;
}

interface Loop2 {
  points: Point2[];
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  /** Twice the signed area. */
  doubleArea: number;
}

/** One face whose loops cross, and by how much. */
export interface FaceLoopCrossing {
  face: number;
  /** How far one loop reaches past another, in model units. */
  depth: number;
}

function loopOf(points: Point2[]): Loop2 {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  let doubleArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const next = points[(index + 1) % points.length]!;
    minU = Math.min(minU, point.u);
    maxU = Math.max(maxU, point.u);
    minV = Math.min(minV, point.v);
    maxV = Math.max(maxV, point.v);
    doubleArea += point.u * next.v - next.u * point.v;
  }
  return { points, minU, maxU, minV, maxV, doubleArea };
}

function inBox(loop: Loop2, point: Point2, margin: number): boolean {
  return (
    point.u >= loop.minU - margin &&
    point.u <= loop.maxU + margin &&
    point.v >= loop.minV - margin &&
    point.v <= loop.maxV + margin
  );
}

/** Even-odd containment of a point in a closed polyline. */
function contains(loop: Loop2, point: Point2): boolean {
  if (!inBox(loop, point, 0)) return false;
  let inside = false;
  const points = loop.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[i]!;
    const b = points[j]!;
    if (
      a.v > point.v !== b.v > point.v &&
      point.u < ((b.u - a.u) * (point.v - a.v)) / (b.v - a.v) + a.u
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Distance from a point to a closed polyline. */
function distanceTo(loop: Loop2, point: Point2): number {
  let best = Infinity;
  const points = loop.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const a = points[j]!;
    const b = points[i]!;
    const du = b.u - a.u;
    const dv = b.v - a.v;
    const lengthSquared = du * du + dv * dv;
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point.u - a.u) * du + (point.v - a.v) * dv) / lengthSquared
            )
          );
    best = Math.min(
      best,
      Math.hypot(point.u - (a.u + t * du), point.v - (a.v + t * dv))
    );
  }
  return best;
}

/**
 * How far any point of `probe` lies on the wrong side of `boundary` by more
 * than `tolerance`: outside it when `mustBeInside`, inside it otherwise.
 * Zero when none does.
 */
function penetration(
  probe: Loop2,
  boundary: Loop2,
  mustBeInside: boolean,
  tolerance: number
): number {
  let deepest = 0;
  for (const point of probe.points) {
    // A point outside the boundary's box (by more than the tolerance) is
    // outside the boundary, and at least that far from it.
    if (!inBox(boundary, point, tolerance)) {
      if (mustBeInside) {
        deepest = Math.max(deepest, distanceTo(boundary, point));
      }
      continue;
    }
    if (contains(boundary, point) === mustBeInside) continue;
    const depth = distanceTo(boundary, point);
    if (depth > tolerance) deepest = Math.max(deepest, depth);
  }
  return deepest;
}

/**
 * How far this planar face's loops cross, or 0 when they do not or cannot be
 * read. A boundary that cannot be walked is not evidence against the face.
 */
function planarFaceLoopCrossing(
  kernel: RemusKernel,
  face: number,
  tolerance: number
): number {
  const wires = Array.from(kernel.getFaceWires(face));
  if (wires.length < 2) return 0;
  const normal = kernel.getFaceNormal(face);
  const zAxis = normalized({ x: normal[0]!, y: normal[1]!, z: normal[2]! });
  if (!zAxis) return 0;
  const helper: Vec3 =
    Math.abs(zAxis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const uAxis = normalized(cross(helper, zAxis));
  if (!uAxis) return 0;
  const vAxis = cross(zAxis, uAxis);

  const loops: Point2[][] = [];
  let origin: Vec3 | null = null;
  for (const wire of wires) {
    const walked = chainWireLoop(kernel, wire, tolerance / 4);
    if (!walked) return 0;
    origin ??= walked.loop[0]!;
    const base = origin;
    loops.push(
      walked.loop.map((point) => {
        const offset = subtract(point, base);
        return { u: dot(offset, uAxis), v: dot(offset, vAxis) };
      })
    );
  }
  return loopCrossingDepth(loops, tolerance);
}

/**
 * How far one of a face's closed boundary loops reaches past another, or 0
 * when none does by more than `tolerance`.
 *
 * The loops of a sound face are one outer loop with every other loop inside
 * it, apart from each other; loops may touch, which is why only a reach past
 * `tolerance` counts. Where two polygons cross, the region between them is
 * bounded by the crossing points and by vertices of the two loops, and the
 * crossing points alone cannot enclose anything, so some vertex lies on the
 * wrong side of the other loop. Each loop's vertices are measured against the
 * other loop, and the reported depth is the deepest such vertex — a lower
 * bound on how far the loops cross.
 */
export function loopCrossingDepth(
  rings: readonly (readonly Point2[])[],
  tolerance: number
): number {
  if (rings.length < 2) return 0;
  const loops = rings.map((ring) => loopOf([...ring]));
  // The outer loop is the one enclosing the most area, as in
  // `planarFaceCentroid`: a stored winding cannot be trusted to say which.
  // When the loops cross, the largest is still the one the others poke out
  // of, so the choice does not hide the defect.
  const outerIndex = loops.reduce(
    (best, loop, index) =>
      Math.abs(loop.doubleArea) > Math.abs(loops[best]!.doubleArea)
        ? index
        : best,
    0
  );
  const outer = loops[outerIndex]!;
  const inners = loops.filter((_, index) => index !== outerIndex);
  let deepest = 0;
  for (const [index, inner] of inners.entries()) {
    // A hole must lie inside the outline, and the outline must not run
    // inside the hole.
    deepest = Math.max(
      deepest,
      penetration(inner, outer, true, tolerance),
      penetration(outer, inner, false, tolerance)
    );
    // Two holes must not overlap.
    for (const other of inners.slice(index + 1)) {
      if (
        other.maxU < inner.minU - tolerance ||
        other.minU > inner.maxU + tolerance ||
        other.maxV < inner.minV - tolerance ||
        other.minV > inner.maxV + tolerance
      ) {
        continue;
      }
      deepest = Math.max(
        deepest,
        penetration(inner, other, false, tolerance),
        penetration(other, inner, false, tolerance)
      );
    }
  }
  return deepest > tolerance ? deepest : 0;
}

/**
 * The first planar face of these solids whose loops cross, or `null` when
 * none does.
 *
 * Total by contract: every kernel read can raise on an unusual face, and a
 * face that cannot be measured is skipped rather than reported. This only
 * ever adds a refusal, so a measurement it cannot make must not become one.
 */
export function crossingFaceLoops(
  kernel: RemusKernel,
  solids: readonly number[]
): FaceLoopCrossing | null {
  for (const solid of solids) {
    let faces: number[];
    let tolerance: number;
    try {
      faces = Array.from(kernel.getSolidFaces(solid));
      const bounds = kernel.boundingBox(solid);
      const extent = Math.max(
        bounds[3]! - bounds[0]!,
        bounds[4]! - bounds[1]!,
        bounds[5]! - bounds[2]!
      );
      tolerance = Math.max(
        FACE_LOOP_CROSSING_MIN_TOLERANCE,
        extent * FACE_LOOP_CROSSING_TOLERANCE_RATIO
      );
      if (!Number.isFinite(tolerance)) continue;
    } catch {
      continue;
    }
    for (const face of faces) {
      try {
        if (surfaceTypeOf(kernel, face) !== 'plane') continue;
        const depth = planarFaceLoopCrossing(kernel, face, tolerance);
        if (depth > 0) return { face, depth };
      } catch {
        // Not measurable; see above.
      }
    }
  }
  return null;
}
