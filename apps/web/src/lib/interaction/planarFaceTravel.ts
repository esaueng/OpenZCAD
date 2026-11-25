import type {
  BodyRepresentation,
  FaceTopology,
  Vector3
} from '@openzcad/shared';

/**
 * Approximate distance from a planar face to other parts of its own body,
 * measured along its outward normal on the display mesh.
 *
 * The exact kernel moves a face by sweeping it and letting only the faces it
 * shares an edge with stretch or shrink; the moment the swept face reaches
 * any other face it refuses ("swept face reaches nonadjacent face"). On the
 * demo bracket that is every inward offset past the 8 mm plate and every
 * outward one past the boss 6 mm above it — both legitimate refusals that the
 * card used to report as a generic kernel failure.
 *
 * This measures those two distances on the display mesh for an explanation
 * after the exact kernel refuses a move. The mesh and its deflection setting
 * do not certify the exact collision distance.
 *
 * Faces sharing an edge with the picked face are ignored, as the kernel
 * ignores them: they are the ones that stretch.
 */
export interface PlanarFaceTravel {
  /** Estimated material depth behind the face; null when nothing is measured. */
  inward: number | null;
  /** Estimated free space in front; null when nothing is measured. */
  outward: number | null;
  /**
   * Heuristic allowance around a mesh-derived distance. It is not a bound
   * on the distance to the exact surfaces.
   */
  tolerance: number;
}

interface PlaneFrame {
  origin: Vector3;
  normal: Vector3;
  u: Vector3;
  v: Vector3;
}

interface Triangle2 {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
}

/**
 * Pairwise work allowed per measurement. A face on a large imported body can
 * face a million obstacle triangles; past this the limits are simply unknown
 * and the kernel's own refusal speaks instead.
 */
const WORK_BUDGET = 4_000_000;

/**
 * Twice the requested display deflection ratio
 * (`DISPLAY_LINEAR_DEFLECTION_RATIO` in the kernel adapter).
 */
const CHORD_ALLOWANCE_RATIO = 4e-4;

const cache = new WeakMap<BodyRepresentation, Map<string, PlanarFaceTravel>>();

/**
 * What windowed sweeps of one face have measured, per direction: how far the
 * slab has been searched and the nearest obstacle found in it. A refused
 * drag asks again on every frame, each a little farther; searching twice
 * the asked reach answers most of those frames from here.
 */
interface SweepKnowledge {
  searchedTo: number;
  blockedAt: number;
  /** The reach whose slab exceeded the work budget; any wider one does too. */
  unmeasurableFrom: number;
}

const sweepCache = new WeakMap<
  BodyRepresentation,
  Map<string, SweepKnowledge>
>();

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalize(a: Vector3): Vector3 | null {
  const length = Math.hypot(a.x, a.y, a.z);
  if (!Number.isFinite(length) || length < 1e-12) return null;
  return { x: a.x / length, y: a.y / length, z: a.z / length };
}

function frameFor(normal: Vector3, origin: Vector3): PlaneFrame | null {
  const n = normalize(normal);
  if (!n) return null;
  const seed =
    Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = normalize(cross(n, seed));
  if (!u) return null;
  return { origin, normal: n, u, v: cross(n, u) };
}

/** In-plane coordinates and height above the plane. */
function local(
  frame: PlaneFrame,
  x: number,
  y: number,
  z: number
): [number, number, number] {
  const d = {
    x: x - frame.origin.x,
    y: y - frame.origin.y,
    z: z - frame.origin.z
  };
  return [dot(d, frame.u), dot(d, frame.v), dot(d, frame.normal)];
}

/**
 * Barycentric weights of (px, py) in a 2D triangle, or null outside it (and
 * for a triangle seen edge-on, which covers no area of the plane).
 */
function barycentric(
  t: Triangle2,
  px: number,
  py: number,
  epsilon: number
): [number, number, number] | null {
  const det = (t.by - t.cy) * (t.ax - t.cx) + (t.cx - t.bx) * (t.ay - t.cy);
  if (Math.abs(det) < 1e-18) return null;
  const a = ((t.by - t.cy) * (px - t.cx) + (t.cx - t.bx) * (py - t.cy)) / det;
  const b = ((t.cy - t.ay) * (px - t.cx) + (t.ax - t.cx) * (py - t.cy)) / det;
  const c = 1 - a - b;
  return a >= -epsilon && b >= -epsilon && c >= -epsilon ? [a, b, c] : null;
}

/** Parameters (s on p, t on q) where two 2D segments cross, if they do. */
function segmentCrossing(
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  q0x: number,
  q0y: number,
  q1x: number,
  q1y: number
): [number, number] | null {
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = q1x - q0x;
  const sy = q1y - q0y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-18) return null;
  const qpx = q0x - p0x;
  const qpy = q0y - p0y;
  const s = (qpx * sy - qpy * sx) / denominator;
  const t = (qpx * ry - qpy * rx) / denominator;
  return s >= 0 && s <= 1 && t >= 0 && t <= 1 ? [s, t] : null;
}

/**
 * Pure. Mesh-derived inward and outward distance estimates for a planar face.
 * Null means "not measured", never zero.
 *
 * The minimum height of a triangulated obstacle over the face's footprint is
 * reached at a vertex of their overlap, so three candidate sets cover it
 * exactly for the mesh: obstacle vertices over the face, face vertices under
 * an obstacle, and crossings of an obstacle edge with a face edge.
 */
export function planarFaceTravel(
  representation: BodyRepresentation,
  face: FaceTopology
): PlanarFaceTravel {
  const key = `${face.topologyId}:${face.hash}`;
  let perBody = cache.get(representation);
  const cached = perBody?.get(key);
  if (cached) return cached;
  const result = measure(representation, face) ?? {
    inward: null,
    outward: null,
    tolerance: toleranceOf(representation)
  };
  if (!perBody) {
    perBody = new Map();
    cache.set(representation, perBody);
  }
  perBody.set(key, result);
  return result;
}

/**
 * Pure. Whether the display mesh shows the prism a planar face sweeps
 * through on a move of `offset` (signed along its outward normal) empty of
 * every face it does not share an edge with, allowing the mesh's own
 * tolerance past the end of the move. Null when the mesh cannot say.
 *
 * Only the triangles whose heights reach into the swept slab are measured,
 * so a heavily tessellated body — a thread, a knurl — that exhausts the
 * work budget of {@link planarFaceTravel} can still be answered. Like that
 * estimate, this does not certify what the exact kernel will build; it
 * decides only whether the display shows anything in the way.
 */
export function planarFaceSweepClear(
  representation: BodyRepresentation,
  face: FaceTopology,
  offset: number
): boolean | null {
  if (!Number.isFinite(offset) || offset === 0) return null;
  const key = `${face.topologyId}:${face.hash}:${offset > 0 ? '+' : '-'}`;
  let perBody = sweepCache.get(representation);
  const known = perBody?.get(key) ?? {
    searchedTo: 0,
    blockedAt: Infinity,
    unmeasurableFrom: Infinity
  };
  if (!perBody) {
    perBody = new Map();
    sweepCache.set(representation, perBody);
  }
  perBody.set(key, known);
  const reach = Math.abs(offset) + toleranceOf(representation);
  if (reach > known.searchedTo) {
    if (reach >= known.unmeasurableFrom) return null;
    // The wider search can exceed the work budget where the asked one
    // would not; fall back to the asked reach before giving up.
    let searched = Math.min(2 * reach, known.unmeasurableFrom);
    let travel = measure(representation, face, slab(offset, searched));
    if (!travel && searched > reach) {
      known.unmeasurableFrom = searched;
      searched = reach;
      travel = measure(representation, face, slab(offset, searched));
    }
    if (!travel) {
      known.unmeasurableFrom = reach;
      return null;
    }
    const nearest = offset > 0 ? travel.outward : travel.inward;
    known.searchedTo = searched;
    known.blockedAt = Math.min(known.blockedAt, nearest ?? Infinity);
  }
  return reach < known.blockedAt;
}

/** Heights above the face's plane that a move of `offset` sweeps through. */
function slab(offset: number, reach: number): [number, number] {
  return offset > 0 ? [0, reach] : [-reach, 0];
}

function toleranceOf(representation: BodyRepresentation): number {
  const { min, max } = representation.bbox;
  const extent = Math.max(max.x - min.x, max.y - min.y, max.z - min.z, 0);
  return Number.isFinite(extent)
    ? Math.max(extent * CHORD_ALLOWANCE_RATIO, 1e-5)
    : 1e-5;
}

/**
 * The measurement, or null when it cannot be made. `window` restricts it to
 * obstacles whose heights above the face's plane reach into [low, high]; a
 * height outside the window is not recorded.
 */
function measure(
  representation: BodyRepresentation,
  face: FaceTopology,
  window: readonly [number, number] = [-Infinity, Infinity]
): PlanarFaceTravel | null {
  const tolerance = toleranceOf(representation);
  const geometry = face.geometry;
  const topology = representation.topology;
  const { vertices, indices } = representation.mesh;
  if (
    geometry?.surfaceType !== 'plane' ||
    !geometry.normal ||
    !topology ||
    face.triangleCount <= 0
  ) {
    return null;
  }
  // Adjacency is the kernel's edge-to-face map. Without it the faces that
  // would stretch cannot be told from the ones in the way, and guessing
  // would refuse offsets the kernel builds.
  const adjacent = new Set<number>();
  let adjacencyKnown = true;
  for (const edge of topology.edges) {
    if (!edge.adjacentFaceHashes) {
      adjacencyKnown = false;
      break;
    }
    if (edge.adjacentFaceHashes.includes(face.hash)) {
      for (const hash of edge.adjacentFaceHashes) adjacent.add(hash);
    }
  }
  if (!adjacencyKnown) return null;
  adjacent.add(face.hash);

  const firstVertex = indices[face.triangleStart * 3];
  if (firstVertex === undefined) return null;
  const frame = frameFor(geometry.normal, {
    x: vertices[firstVertex * 3]!,
    y: vertices[firstVertex * 3 + 1]!,
    z: vertices[firstVertex * 3 + 2]!
  });
  if (!frame) return null;

  const toLocal = (index: number) =>
    local(
      frame,
      vertices[index * 3]!,
      vertices[index * 3 + 1]!,
      vertices[index * 3 + 2]!
    );

  // The picked face, flattened into its plane.
  const footprint: Triangle2[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (
    let triangle = face.triangleStart;
    triangle < face.triangleStart + face.triangleCount;
    triangle += 1
  ) {
    const [ax, ay] = toLocal(indices[triangle * 3]!);
    const [bx, by] = toLocal(indices[triangle * 3 + 1]!);
    const [cx, cy] = toLocal(indices[triangle * 3 + 2]!);
    footprint.push({ ax, ay, bx, by, cx, cy });
    minX = Math.min(minX, ax, bx, cx);
    minY = Math.min(minY, ay, by, cy);
    maxX = Math.max(maxX, ax, bx, cx);
    maxY = Math.max(maxY, ay, by, cy);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  // Heights at or below this are the face's own plane: coplanar neighbours
  // and edges it merely touches, not something it would run into.
  const flat = Math.max(1e-6, span * 1e-7);
  const inside = span * 1e-9;

  const [low, high] = window;
  const excluded = new Uint8Array(indices.length / 3);
  for (const other of topology.faces) {
    if (!adjacent.has(other.hash)) continue;
    for (let k = 0; k < other.triangleCount; k += 1) {
      excluded[other.triangleStart + k] = 1;
    }
  }

  // Obstacle triangles whose shadow can overlap the footprint's box.
  const obstacles: Array<{
    triangle: Triangle2;
    heights: [number, number, number];
  }> = [];
  const triangleCount = indices.length / 3;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    if (excluded[triangle]) continue;
    const a = toLocal(indices[triangle * 3]!);
    const b = toLocal(indices[triangle * 3 + 1]!);
    const c = toLocal(indices[triangle * 3 + 2]!);
    if (
      Math.max(a[0], b[0], c[0]) < minX ||
      Math.min(a[0], b[0], c[0]) > maxX ||
      Math.max(a[1], b[1], c[1]) < minY ||
      Math.min(a[1], b[1], c[1]) > maxY ||
      Math.max(a[2], b[2], c[2]) < low ||
      Math.min(a[2], b[2], c[2]) > high
    ) {
      continue;
    }
    obstacles.push({
      triangle: { ax: a[0], ay: a[1], bx: b[0], by: b[1], cx: c[0], cy: c[1] },
      heights: [a[2], b[2], c[2]]
    });
  }
  if (obstacles.length * footprint.length * 12 > WORK_BUDGET) {
    return null;
  }

  let outward = Infinity;
  let inward = Infinity;
  const record = (height: number) => {
    if (height < low || height > high) return;
    if (height > flat) outward = Math.min(outward, height);
    else if (height < -flat) inward = Math.min(inward, -height);
  };
  const overFootprint = (x: number, y: number) =>
    footprint.some((piece) => barycentric(piece, x, y, inside) !== null);

  for (const { triangle, heights } of obstacles) {
    const corners: Array<[number, number, number]> = [
      [triangle.ax, triangle.ay, heights[0]],
      [triangle.bx, triangle.by, heights[1]],
      [triangle.cx, triangle.cy, heights[2]]
    ];
    // Obstacle vertices standing over the face.
    for (const [x, y, height] of corners) {
      if (overFootprint(x, y)) record(height);
    }
    for (const piece of footprint) {
      const faceCorners: Array<[number, number]> = [
        [piece.ax, piece.ay],
        [piece.bx, piece.by],
        [piece.cx, piece.cy]
      ];
      // Face vertices standing under the obstacle.
      for (const [x, y] of faceCorners) {
        const weights = barycentric(triangle, x, y, inside);
        if (weights) {
          record(
            weights[0] * heights[0] +
              weights[1] * heights[1] +
              weights[2] * heights[2]
          );
        }
      }
      // Obstacle edges crossing face edges.
      for (let i = 0; i < 3; i += 1) {
        const [p0x, p0y, h0] = corners[i]!;
        const [p1x, p1y, h1] = corners[(i + 1) % 3]!;
        for (let j = 0; j < 3; j += 1) {
          const [q0x, q0y] = faceCorners[j]!;
          const [q1x, q1y] = faceCorners[(j + 1) % 3]!;
          const crossing = segmentCrossing(
            p0x,
            p0y,
            p1x,
            p1y,
            q0x,
            q0y,
            q1x,
            q1y
          );
          if (crossing) record(h0 + (h1 - h0) * crossing[0]);
        }
      }
    }
  }
  return {
    inward: Number.isFinite(inward) ? inward : null,
    outward: Number.isFinite(outward) ? outward : null,
    tolerance
  };
}
