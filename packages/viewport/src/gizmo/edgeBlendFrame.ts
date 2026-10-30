import type { HandleVec3 } from './DragRig';

/**
 * Where a fillet/chamfer arrow stands on an edge, and which way it points.
 *
 * The arrow stands on the edge along the bisector of the two faces that meet
 * there — 45° to each on a square edge — the way the blend's own surface
 * moves as it grows: into the material at an outside (convex) edge, out into
 * the corner at an inside (concave) one. `travel` is how far the middle of
 * the fillet arc, or of the chamfer flat, moves along the bisector per unit
 * of value, so the arrow can ride the blend and stay under the hand.
 *
 * Normals come from the display mesh, not the exact surfaces: the mesh is the
 * one thing every face has, analytic or not, and facets only tilt the arrow
 * by a chord's angle. `travel` is therefore approximate on curved faces, and
 * bounded by {@link MIN_EDGE_TRAVEL} and {@link MAX_EDGE_TRAVEL} so a nearly
 * flat or knife edge does not turn a pixel of drag into a huge or a vanishing
 * value — there the arrow sits a little off the true blend surface instead.
 */
export interface EdgeBlendFrame {
  origin: HandleVec3;
  /** Unit bisector of the faces, the way a growing blend's surface moves. */
  direction: HandleVec3;
  /**
   * Blend-surface travel per unit value along `direction`, by operation.
   * Absent when the two faces at the edge could not be read; the arrow then
   * stays on the edge and points away from the body's middle.
   */
  travel?: { fillet: number; chamfer: number };
}

/** One face bounding the edge, as a run of the body's display triangles. */
export interface EdgeBlendFace {
  /** Distinguishes the faces; triangles of one key are one face. */
  key: string | number;
  triangleStart: number;
  triangleCount: number;
}

export interface EdgeBlendFrameInput {
  /** The edge polyline, xyz-interleaved. */
  points: ArrayLike<number>;
  /** World xyz triples of the body's display mesh. */
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** The faces the edge bounds; fewer than two distinct keys falls back. */
  faces: readonly EdgeBlendFace[];
  bodyCenter: HandleVec3;
  /**
   * A point to stand the arrow nearest to — the click that picked the edge,
   * or where the arrow stood before. Absent, an open edge takes its middle
   * and a closed one the point nearest `viewer`.
   */
  near?: HandleVec3 | null;
  /** The camera position, for a closed edge with no `near`. */
  viewer?: HandleVec3 | null;
}

/** Bounds on travel per unit value; see {@link EdgeBlendFrame}. */
export const MIN_EDGE_TRAVEL = 0.25;
export const MAX_EDGE_TRAVEL = 8;

type V = [number, number, number];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const length = (a: V) => Math.hypot(a[0], a[1], a[2]);
const toVec = (a: V): HandleVec3 => ({ x: a[0], y: a[1], z: a[2] });
const fromVec = (a: HandleVec3): V => [a.x, a.y, a.z];

function pointAt(values: ArrayLike<number>, index: number): V {
  return [values[index * 3]!, values[index * 3 + 1]!, values[index * 3 + 2]!];
}

/** Closest point on segment ab to p, and the segment's parameter there. */
function closestOnSegment(p: V, a: V, b: V): { point: V; t: number } {
  const ab = sub(b, a);
  const span = dot(ab, ab);
  const t = span > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / span)) : 0;
  return { point: add(a, scale(ab, t)), t };
}

/**
 * The anchor on the polyline and the edge's tangent there. An open edge with
 * nothing to stand near takes its arc-length middle — not the middle sample,
 * which on a two-point line is an end vertex.
 */
function anchorOnPolyline(
  samples: V[],
  near: V | null,
  viewer: V | null
): { point: V; tangent: V } | null {
  if (samples.length < 2) return null;
  const closed = length(sub(samples[0]!, samples.at(-1)!)) < 1e-9;
  let target = near;
  if (!target && closed && viewer) target = viewer;
  let best: { point: V; segment: number; distance: number } | null = null;
  if (target) {
    for (let i = 0; i + 1 < samples.length; i++) {
      const { point } = closestOnSegment(target, samples[i]!, samples[i + 1]!);
      const distance = length(sub(point, target));
      if (!best || distance < best.distance) {
        best = { point, segment: i, distance };
      }
    }
  } else {
    let total = 0;
    for (let i = 0; i + 1 < samples.length; i++) {
      total += length(sub(samples[i + 1]!, samples[i]!));
    }
    let walked = 0;
    for (let i = 0; i + 1 < samples.length; i++) {
      const step = length(sub(samples[i + 1]!, samples[i]!));
      if (walked + step >= total / 2 || i + 2 === samples.length) {
        const t = step > 0 ? (total / 2 - walked) / step : 0;
        best = {
          point: add(
            samples[i]!,
            scale(
              sub(samples[i + 1]!, samples[i]!),
              Math.min(1, Math.max(0, t))
            )
          ),
          segment: i,
          distance: 0
        };
        break;
      }
      walked += step;
    }
  }
  if (!best) return null;
  const run = sub(samples[best.segment + 1]!, samples[best.segment]!);
  const runLength = length(run);
  return {
    point: best.point,
    tangent: runLength > 0 ? scale(run, 1 / runLength) : [0, 0, 0]
  };
}

/**
 * The face's normal where it meets `point`, with the edge tangent removed,
 * and a point of the face just beside the edge. Averages every triangle that
 * touches the point, so an anchor on a facet seam reads between the two.
 */
function faceNearEdge(
  input: EdgeBlendFrameInput,
  faces: readonly EdgeBlendFace[],
  point: V,
  tangent: V
): { normal: V; inside: V } | null {
  let bestDistance = Number.POSITIVE_INFINITY;
  const touching: { normal: V; centroid: V; distance: number }[] = [];
  for (const face of faces) {
    for (let t = 0; t < face.triangleCount; t++) {
      const base = (face.triangleStart + t) * 3;
      if (base + 2 >= input.indices.length) break;
      const a = pointAt(input.vertices, input.indices[base]!);
      const b = pointAt(input.vertices, input.indices[base + 1]!);
      const c = pointAt(input.vertices, input.indices[base + 2]!);
      const normal = cross(sub(b, a), sub(c, a));
      const area = length(normal);
      if (area < 1e-12) continue;
      let distance = Number.POSITIVE_INFINITY;
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a]
      ] as [V, V][]) {
        distance = Math.min(
          distance,
          length(sub(closestOnSegment(point, u, v).point, point))
        );
      }
      bestDistance = Math.min(bestDistance, distance);
      touching.push({
        normal: scale(normal, 1 / area),
        centroid: scale(add(add(a, b), c), 1 / 3),
        distance
      });
    }
  }
  if (touching.length === 0) return null;
  const tolerance = bestDistance + 1e-6 * Math.max(1, length(point));
  let normal: V = [0, 0, 0];
  let inside: V = [0, 0, 0];
  let count = 0;
  for (const entry of touching) {
    if (entry.distance > tolerance) continue;
    normal = add(normal, entry.normal);
    inside = add(inside, entry.centroid);
    count += 1;
  }
  normal = sub(normal, scale(tangent, dot(normal, tangent)));
  const size = length(normal);
  if (size < 1e-9 || count === 0) return null;
  return { normal: scale(normal, 1 / size), inside: scale(inside, 1 / count) };
}

/** Pure. See {@link EdgeBlendFrame}. Null for a polyline with no span. */
export function edgeBlendFrame(
  input: EdgeBlendFrameInput
): EdgeBlendFrame | null {
  const samples: V[] = [];
  for (let i = 0; i + 2 < input.points.length; i += 3) {
    samples.push([
      input.points[i]!,
      input.points[i + 1]!,
      input.points[i + 2]!
    ]);
  }
  const anchor = anchorOnPolyline(
    samples,
    input.near ? fromVec(input.near) : null,
    input.viewer ? fromVec(input.viewer) : null
  );
  if (!anchor) return null;
  const origin = toVec(anchor.point);
  const outward = sub(anchor.point, fromVec(input.bodyCenter));
  const reach = length(outward);
  const fallback: EdgeBlendFrame = {
    origin,
    direction:
      reach > 1e-9 ? toVec(scale(outward, 1 / reach)) : { x: 0, y: 0, z: 1 }
  };

  const byKey = new Map<string | number, EdgeBlendFace[]>();
  for (const face of input.faces) {
    byKey.set(face.key, [...(byKey.get(face.key) ?? []), face]);
  }
  if (byKey.size !== 2) return fallback;
  const [first, second] = [...byKey.values()].map((faces) =>
    faceNearEdge(input, faces, anchor.point, anchor.tangent)
  );
  if (!first || !second) return fallback;
  const sum = add(first.normal, second.normal);
  const sumLength = length(sum);
  // Faces folded flat onto each other (a knife edge) have no bisector.
  if (sumLength < 1e-6) return fallback;
  // Each face's inside lies behind the other's plane at an outside edge. A
  // mesh wound inside out flips both normals and this test together, so the
  // direction it picks is the same either way.
  const behind =
    dot(sub(first.inside, anchor.point), second.normal) +
    dot(sub(second.inside, anchor.point), first.normal);
  const direction = scale(sum, (behind < 0 ? -1 : 1) / sumLength);
  // θ between the face normals; the blended wedge spans π − θ.
  const cosTheta = Math.min(1, Math.max(-1, dot(first.normal, second.normal)));
  const halfTheta = Math.acos(cosTheta) / 2;
  const bounded = (travel: number) =>
    Math.min(MAX_EDGE_TRAVEL, Math.max(MIN_EDGE_TRAVEL, travel));
  return {
    origin,
    direction: toVec(direction),
    travel: {
      // The arc's middle sits r / cos(θ/2) − r from the sharp edge.
      fillet: bounded(1 / Math.cos(halfTheta) - 1),
      // The flat's middle sits d · sin(θ/2) from it.
      chamfer: bounded(Math.sin(halfTheta))
    }
  };
}
