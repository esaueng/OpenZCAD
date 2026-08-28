/**
 * Area centroid of a planar face — the point a user means by "the middle of
 * this face".
 *
 * This exists because `FaceGeometry.center` is the mean of the face's VERTEX
 * positions, which is frozen (it is an ADR-011 witness input and a direct-edit
 * authorization pin) and is not the centre of anything: a disc bounded by one
 * closed circular edge has a single seam vertex, so its vertex mean sits on the
 * RIM, one radius away from where the face looks centred.
 *
 * The integral is Green's theorem over the face's own boundary wires, so hole
 * wires — which run opposite the outer wire — subtract themselves without being
 * identified as holes. Straight boundaries integrate exactly; a curved boundary
 * is inscribed with a polygon dense enough that the residual is far below any
 * modelling tolerance, and says so through {@link PlanarFaceCentroid.provenance}.
 */
import type { Vec3 } from '@openzcad/geometry';
import type { FaceAreaProvenance } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import { cross, normalized, subtract } from './exact-math';

/**
 * Sampling density for a curved boundary edge, relative to that edge's own
 * length, so the inscribed polygon is equally faithful on a 0.5 mm fillet and
 * on a 2 m rim. At this ratio a full circle comes back as roughly 900 segments
 * and its centroid is exact to rounding; the worst case, a single asymmetric
 * arc, lands within about 1e-5 of the face's own size.
 */
const CURVE_SAMPLE_RATIO = 1e-5;

/** Endpoint match for chaining a wire's edges, relative to the loop's extent. */
const CHAIN_TOLERANCE_RATIO = 1e-7;

export interface PlanarFaceCentroid {
  readonly centroid: Vec3;
  /** `exact` only when every boundary edge is a straight line. */
  readonly provenance: FaceAreaProvenance;
}

function pointAt(values: ArrayLike<number>, index: number): Vec3 {
  return {
    x: values[index * 3]!,
    y: values[index * 3 + 1]!,
    z: values[index * 3 + 2]!
  };
}

/**
 * One boundary edge as a polyline running from its start vertex to its end
 * vertex. A closed edge repeats its seam point, which the chainer drops.
 */
function edgePolyline(
  kernel: RemusKernel,
  edge: number
): { points: Vec3[]; curved: boolean } | null {
  const curveType = kernel.getEdgeCurveType(edge);
  if (curveType === 'LINE') {
    const vertices = kernel.getEdgeVertices(edge);
    if (vertices.length < 6) {
      return null;
    }
    return { points: [pointAt(vertices, 0), pointAt(vertices, 1)], curved: false };
  }
  const edgeLength = kernel.edgeLength(edge);
  if (!Number.isFinite(edgeLength) || edgeLength <= 0) {
    return null;
  }
  const flat = kernel.sampleEdge(edge, edgeLength * CURVE_SAMPLE_RATIO);
  if (flat.length < 6) {
    return null;
  }
  const points: Vec3[] = [];
  for (let index = 0; index * 3 < flat.length; index += 1) {
    points.push(pointAt(flat, index));
  }
  return { points, curved: true };
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function extentOf(points: readonly Vec3[]): number {
  let extent = 0;
  for (const point of points) {
    extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
  }
  return extent;
}

/**
 * Walks a wire's edges into one closed loop of points.
 *
 * `getWireEdges` returns a set, not a traversal — measured, a box face comes
 * back as edges 3, 6, 5, 4 — so the loop has to be rebuilt by matching
 * endpoints, and an edge whose stored direction runs against the loop has to be
 * reversed. Returns null rather than a guess if the edges do not close.
 */
function chainWireLoop(
  kernel: RemusKernel,
  wire: number
): { loop: Vec3[]; curved: boolean } | null {
  const edges = Array.from(kernel.getWireEdges(wire));
  if (edges.length === 0) {
    return null;
  }
  const segments: Vec3[][] = [];
  let curved = false;
  for (const edge of edges) {
    const polyline = edgePolyline(kernel, edge);
    if (!polyline) {
      return null;
    }
    curved ||= polyline.curved;
    segments.push(polyline.points);
  }

  const tolerance = Math.max(
    1e-12,
    extentOf(segments.flat()) * CHAIN_TOLERANCE_RATIO
  );
  const used = new Array<boolean>(segments.length).fill(false);
  const loop = [...segments[0]!];
  used[0] = true;
  for (let joined = 1; joined < segments.length; joined += 1) {
    const tail = loop[loop.length - 1]!;
    let next = -1;
    let reversed = false;
    for (let index = 0; index < segments.length; index += 1) {
      if (used[index]) {
        continue;
      }
      const candidate = segments[index]!;
      if (distance(tail, candidate[0]!) <= tolerance) {
        next = index;
        reversed = false;
        break;
      }
      if (distance(tail, candidate[candidate.length - 1]!) <= tolerance) {
        next = index;
        reversed = true;
        break;
      }
    }
    if (next < 0) {
      return null;
    }
    used[next] = true;
    const points = reversed ? [...segments[next]!].reverse() : segments[next]!;
    // The joint point is already the loop's tail.
    loop.push(...points.slice(1));
  }
  if (distance(loop[0]!, loop[loop.length - 1]!) > tolerance) {
    return null;
  }
  loop.pop();
  return loop.length >= 3 ? { loop, curved } : null;
}

/**
 * The face's area centroid, or null when its boundary cannot be walked.
 *
 * `normal` only fixes the plane the boundary is projected onto; the returned
 * point does not depend on which in-plane axes are chosen, so it stays the
 * same value whatever frame a caller later builds on it.
 */
export function planarFaceCentroid(
  kernel: RemusKernel,
  face: number,
  normal: Vec3
): PlanarFaceCentroid | null {
  const zAxis = normalized(normal);
  if (!zAxis) {
    return null;
  }
  const worldAxes: readonly Vec3[] = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 }
  ];
  const helper = worldAxes.reduce((best, candidate) =>
    Math.abs(
      zAxis.x * candidate.x + zAxis.y * candidate.y + zAxis.z * candidate.z
    ) <
    Math.abs(zAxis.x * best.x + zAxis.y * best.y + zAxis.z * best.z)
      ? candidate
      : best
  );
  const uAxis = normalized(cross(helper, zAxis));
  if (!uAxis) {
    return null;
  }
  const vAxis = cross(zAxis, uAxis);

  let wires: number[];
  try {
    wires = Array.from(kernel.getFaceWires(face));
  } catch {
    return null;
  }
  if (wires.length === 0) {
    return null;
  }

  const loops: Array<{ loop: Vec3[]; curved: boolean }> = [];
  for (const wire of wires) {
    const walked = chainWireLoop(kernel, wire);
    if (!walked) {
      return null;
    }
    loops.push(walked);
  }

  // Every loop projects against the same origin, so the outer wire and its
  // holes share one coordinate system.
  const origin = loops[0]!.loop[0]!;
  let curved = false;
  const wireSums = loops.map(({ loop, curved: loopCurved }) => {
    curved ||= loopCurved;
    const flat = loop.map((point) => {
      const offset = subtract(point, origin);
      return {
        u: offset.x * uAxis.x + offset.y * uAxis.y + offset.z * uAxis.z,
        v: offset.x * vAxis.x + offset.y * vAxis.y + offset.z * vAxis.z
      };
    });
    let doubleArea = 0;
    let momentU = 0;
    let momentV = 0;
    for (let index = 0; index < flat.length; index += 1) {
      const current = flat[index]!;
      const next = flat[(index + 1) % flat.length]!;
      const term = current.u * next.v - next.u * current.v;
      doubleArea += term;
      momentU += (current.u + next.u) * term;
      momentV += (current.v + next.v) * term;
    }
    return { doubleArea, momentU, momentV };
  });

  // A hole must subtract, and its stored winding cannot say so: the kernel
  // exposes no per-wire orientation, and a chained loop inherits the direction
  // of whichever edge it started from — measured, the two ends of one drilled
  // box chained the same hole in opposite directions, and the unsigned sum put
  // that face's centroid on the wrong side of the hole. Orientation is
  // therefore taken from the geometry instead: holes lie inside the outer
  // wire, so the largest loop is the outer one and every other loop subtracts.
  const outer = wireSums.reduce(
    (best, candidate, index) =>
      Math.abs(candidate.doubleArea) > Math.abs(wireSums[best]!.doubleArea)
        ? index
        : best,
    0
  );
  let doubleArea = 0;
  let momentU = 0;
  let momentV = 0;
  for (const [index, sum] of wireSums.entries()) {
    if (sum.doubleArea === 0) {
      continue;
    }
    const orient = (index === outer ? 1 : -1) * Math.sign(sum.doubleArea);
    doubleArea += sum.doubleArea * orient;
    momentU += sum.momentU * orient;
    momentV += sum.momentV * orient;
  }
  if (!Number.isFinite(doubleArea) || doubleArea <= 0) {
    return null;
  }
  const u = momentU / (3 * doubleArea);
  const v = momentV / (3 * doubleArea);
  const centroid = {
    x: origin.x + uAxis.x * u + vAxis.x * v,
    y: origin.y + uAxis.y * u + vAxis.y * v,
    z: origin.z + uAxis.z * u + vAxis.z * v
  };
  if (!Number.isFinite(centroid.x + centroid.y + centroid.z)) {
    return null;
  }
  return { centroid, provenance: curved ? 'sampled' : 'exact' };
}
