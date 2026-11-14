/**
 * A planar face pushed outward until it runs into another part of its own
 * body: the bottom of a window pushed up to the top, the side of a slot
 * pushed across to the other side.
 *
 * Remus's `moveFaces` moves a face in place by re-limiting the faces it
 * shares an edge with, and the moment the swept face reaches any other face
 * it refuses ("swept face reaches nonadjacent face"): the topology would
 * change, which an in-place move does not do. Closing an opening is exactly
 * that change.
 *
 * Adding material by moving a face is the union of the body with the region
 * the face sweeps, and that region `S` is built here exactly, from planes:
 * the slab between the face's plane and its copy `offset` along the push,
 * cut by the plane of every side the face is re-limited by — a box split by
 * exact planes. For a convex face that is the region the kernel's own move
 * sweeps, whether the sides are parallel to the push (a prism) or lean in or
 * out (a drafted window's floor, growing or shrinking as it rises).
 *
 * **Reflex corners.** A face that is not convex (the L-shaped floor of a
 * window cut across a thicker strip of wall) is not the intersection of its
 * sides' half-spaces. Between sides parallel to the push its sweep is still
 * its prism, built as the union of the prisms of convex pieces of it, each
 * the same box cut by exact side planes. Each piece is cut off along the
 * extension of an edge, so every piece is bounded by the face's own side
 * planes and nothing new.
 *
 * **Blended corners.** A face whose edges are rounded by proven blends (a
 * window with filleted corners) moves together with them, between sides
 * parallel to the push. The chain of face and blends is a graph over the
 * face's sharp footprint, `e` high, and for a push `h ≥ e` its sweep is
 *
 *     body ∪ sweep(chain, h) = body ∪ S(h) ∪ (body ∩ S(e)) + h
 *
 * — the sharp slab covers everything below `h`, and the blend material
 * carried up supplies the rounded top. The exact boolean refuses a union
 * whose operands touch tangentially, which every blend beside a side of `S`
 * does, so the blends the sweep swallows (the face's own, and any whose
 * whole face lies in `S`) are first removed with the kernel's defeature.
 * That changes nothing the union keeps as long as each corner the removal
 * sharpens lies in `S`, which is checked; and the carried blend material is
 * accepted only where it already lies inside the result (the far side of a
 * closed window), so the result is exactly the move.
 *
 * The union only ever re-closes the body inside its own extent: a result
 * whose bounds grow past the body's (a window floor pushed out through the
 * top of its wall) is not the opening closing, and keeps the refusal, as
 * does everything outside the conditions above — a face with holes, a
 * reflex corner beside a leaning side or a blend, curved neighbours that are
 * not blends, an inward (material-removing) push, a push shorter than its
 * blends.
 */
import type { Vec3 } from '@openzcad/geometry';
import { exactFuse } from './exact-boolean-refusal';
import { unifyAndRequireValidSolid } from './kernel-validation';
import type { RemusKernel } from './remus-runtime';

/** The kernel's refusal for a face that sweeps into a nonadjacent face. */
const NONADJACENT_COLLISION =
  /swept face reaches nonadjacent face|sweep may contact a nonadjacent|crosses a nonadjacent source boundary/i;

/** |cos| between a neighbour's normal and the push still read as parallel. */
const PARALLEL_TOLERANCE = 1e-7;

export function isNonadjacentFaceCollision(error: unknown): boolean {
  return error instanceof Error && NONADJACENT_COLLISION.test(error.message);
}

interface Plane {
  point: Vec3;
  normal: Vec3;
}

function unit(vector: Vec3): Vec3 | null {
  const size = Math.hypot(vector.x, vector.y, vector.z);
  return size > 1e-12 && Number.isFinite(size)
    ? { x: vector.x / size, y: vector.y / size, z: vector.z / size }
    : null;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const along = (point: Vec3, direction: Vec3, distance: number): Vec3 => ({
  x: point.x + direction.x * distance,
  y: point.y + direction.y * distance,
  z: point.z + direction.z * distance
});
/** Signed distance of `point` from `plane`, positive along its normal. */
const height = (plane: Plane, point: Vec3) =>
  dot(
    {
      x: point.x - plane.point.x,
      y: point.y - plane.point.y,
      z: point.z - plane.point.z
    },
    plane.normal
  );

/** A planar face's exact plane, from the kernel's analytic `n · x = d`. */
function planeOf(kernel: RemusKernel, face: number): Plane | null {
  if (kernel.getSurfaceType(face) !== 'plane') return null;
  const params = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
    normal?: number[];
    d?: number;
  };
  const [x, y, z] = params.normal ?? [];
  const normal =
    x !== undefined && y !== undefined && z !== undefined
      ? unit({ x, y, z })
      : null;
  if (!normal || typeof params.d !== 'number' || !Number.isFinite(params.d)) {
    return null;
  }
  const scale = params.d / Math.hypot(x!, y!, z!);
  return { point: along({ x: 0, y: 0, z: 0 }, normal, scale), normal };
}

function positions(kernel: RemusKernel, vertices: Iterable<number>): Vec3[] {
  return Array.from(vertices, (vertex) => {
    const [x, y, z] = kernel.getVertexPosition(vertex);
    return { x: x!, y: y!, z: z! };
  });
}

/** A face that is one proven analytic blend region on its own. */
function isSingleFaceBlend(
  kernel: RemusKernel,
  solid: number,
  face: number
): boolean {
  try {
    const region = JSON.parse(kernel.getBlendRegion(solid, face)) as {
      faces?: number[];
    };
    return region.faces?.length === 1 && region.faces[0] === face;
  } catch {
    return false;
  }
}

/** A plane bounding a swept region, and the side of it the region is on. */
interface Side {
  plane: Plane;
  keepPositive: boolean;
}

/** What the push sweeps, read off the face's neighbourhood. */
interface SweepPlan {
  /** The face's own plane, its normal along the push. */
  base: Plane;
  /** The planes bounding the swept region, each kept on the face's side. */
  sides: Side[];
  /** The blends that travel with the face. */
  blends: number[];
  /** How far the blend chain rises above the face plane; 0 without blends. */
  blendHeight: number;
  /**
   * A face with a reflex corner is not the intersection of its sides'
   * half-spaces: its sweep is the union of convex pieces of it instead, each
   * bounded by its own `sides`. Null for a convex face.
   */
  pieces: Side[][] | null;
}

/** A corner of a face outline in the face's plane, and the side after it. */
interface OutlineCorner {
  u: number;
  v: number;
  /** Index of the side plane the edge from this corner to the next lies on. */
  line: number;
}

/** sin of the turn from `a - o` to `b - a`: negative turns right. */
function turn(o: OutlineCorner, a: OutlineCorner, b: OutlineCorner): number {
  const du = a.u - o.u;
  const dv = a.v - o.v;
  const eu = b.u - a.u;
  const ev = b.v - a.v;
  const size = Math.hypot(du, dv) * Math.hypot(eu, ev);
  return size > 0 ? (du * ev - dv * eu) / size : 0;
}

/** The outline without corners where it runs straight on. */
function withoutStraightCorners(outline: OutlineCorner[]): OutlineCorner[] {
  let corners = outline;
  while (corners.length > 3) {
    const n = corners.length;
    const index = corners.findIndex(
      (corner, i) =>
        Math.abs(
          turn(corners[(i + n - 1) % n]!, corner, corners[(i + 1) % n]!)
        ) <= 1e-9
    );
    if (index < 0) break;
    // The merged edge keeps the line of the one before: they share it.
    corners = corners.filter((_, i) => i !== index);
  }
  return corners;
}

/**
 * A simple counter-clockwise outline cut into convex pieces. At a reflex
 * corner the edge arriving there is carried on into the outline until it
 * meets the boundary, and that chord splits off the corner; every chord
 * extends an edge, so every side of every piece lies on one of the
 * outline's own lines. Null when the outline does not cut cleanly.
 */
function convexPieces(
  outline: OutlineCorner[],
  tolerance: number
): OutlineCorner[][] | null {
  const pieces: OutlineCorner[][] = [];
  const pending = [withoutStraightCorners(outline)];
  while (pending.length > 0) {
    if (pieces.length + pending.length > 64) return null;
    const corners = pending.pop()!;
    const n = corners.length;
    if (n < 3) return null;
    const reflex = corners.findIndex(
      (corner, i) =>
        turn(corners[(i + n - 1) % n]!, corner, corners[(i + 1) % n]!) < -1e-9
    );
    if (reflex < 0) {
      pieces.push(corners);
      continue;
    }
    const from = corners[reflex]!;
    const previous = corners[(reflex + n - 1) % n]!;
    const length = Math.hypot(from.u - previous.u, from.v - previous.v);
    const du = (from.u - previous.u) / length;
    const dv = (from.v - previous.v) / length;
    let hit: { edge: number; t: number; s: number } | null = null;
    for (let edge = 0; edge < n; edge += 1) {
      if (edge === reflex || edge === (reflex + n - 1) % n) continue;
      const a = corners[edge]!;
      const b = corners[(edge + 1) % n]!;
      const eu = b.u - a.u;
      const ev = b.v - a.v;
      const denominator = du * ev - dv * eu;
      if (Math.abs(denominator) <= 1e-12 * Math.hypot(eu, ev)) continue;
      const wu = a.u - from.u;
      const wv = a.v - from.v;
      const t = (wu * ev - wv * eu) / denominator;
      const s = (wu * dv - wv * du) / denominator;
      const span = Math.hypot(eu, ev);
      if (
        t > tolerance &&
        s * span >= -tolerance &&
        (1 - s) * span >= -tolerance &&
        (hit === null || t < hit.t)
      ) {
        hit = { edge, t, s };
      }
    }
    if (hit === null) return null;
    const a = corners[hit.edge]!;
    const b = corners[(hit.edge + 1) % n]!;
    const span = Math.hypot(b.u - a.u, b.v - a.v);
    // Walks the outline forward from corner `start` to corner `end`.
    const walk = (start: number, end: number) => {
      const path: OutlineCorner[] = [];
      for (let i = start; ; i = (i + 1) % n) {
        path.push(corners[i]!);
        if (i === end) return path;
      }
    };
    // The chord leaves `from` along the line the arriving edge lies on.
    const chord = previous.line;
    let ahead: OutlineCorner[];
    let behind: OutlineCorner[];
    if (hit.s * span <= tolerance) {
      // The chord ends on corner `edge`.
      ahead = walk(reflex, hit.edge);
      behind = walk(hit.edge, reflex);
    } else if ((1 - hit.s) * span <= tolerance) {
      const end = (hit.edge + 1) % n;
      ahead = walk(reflex, end);
      behind = walk(end, reflex);
    } else {
      const point = {
        u: from.u + du * hit.t,
        v: from.v + dv * hit.t
      };
      ahead = [...walk(reflex, hit.edge), { ...point, line: chord }];
      behind = [
        { ...point, line: a.line },
        ...walk((hit.edge + 1) % n, reflex)
      ];
    }
    // Each half closes along the chord, which lies on the arriving line.
    ahead[ahead.length - 1] = { ...ahead.at(-1)!, line: chord };
    behind[behind.length - 1] = { ...behind.at(-1)!, line: chord };
    pending.push(withoutStraightCorners(ahead), withoutStraightCorners(behind));
  }
  return pieces;
}

function planSweep(
  kernel: RemusKernel,
  solid: number,
  face: number,
  direction: Vec3,
  center: Vec3
): SweepPlan | null {
  if (kernel.getFaceWires(face).length !== 1) return null;
  const own = planeOf(kernel, face);
  if (!own || Math.abs(dot(own.normal, direction)) < 1 - 1e-9) return null;
  const base = { point: own.point, normal: direction };
  const neighbours = Array.from(kernel.adjacentFaces(solid, face));
  if (neighbours.length === 0) return null;
  const smooth = new Set(kernel.getSolidSmoothEdges(solid));
  const blends = neighbours.filter(
    (neighbour) =>
      kernel.getSurfaceType(neighbour) !== 'plane' &&
      isSingleFaceBlend(kernel, solid, neighbour) &&
      Array.from(kernel.sharedEdges(face, neighbour)).every((edge) =>
        smooth.has(edge)
      )
  );
  const chain = new Set([face, ...blends]);
  const sideFaces = new Set<number>();
  for (const member of chain) {
    for (const neighbour of kernel.adjacentFaces(solid, member)) {
      if (!chain.has(neighbour)) sideFaces.add(neighbour);
    }
  }
  const sides: Side[] = [];
  const corners = positions(kernel, kernel.getFaceVertices(face));
  let convex = true;
  let parallel = true;
  for (const sideFace of sideFaces) {
    const plane = planeOf(kernel, sideFace);
    if (!plane) return null;
    const cos = dot(plane.normal, direction);
    if (Math.abs(cos) > PARALLEL_TOLERANCE) parallel = false;
    // Blends travel with the face only between sides parallel to the push.
    if (blends.length > 0 && !parallel) return null;
    // A side nearly along the face itself is a step, not a re-limit.
    if (Math.abs(cos) > 1 - 1e-6) return null;
    const side = height(plane, center);
    const keepPositive = side > 0;
    // Convex: the whole face lies on the side its centre does.
    const tolerance = 1e-7 * Math.max(1, Math.abs(side));
    if (
      Math.abs(side) <= 1e-9 ||
      corners.some((corner) => {
        const reach = height(plane, corner);
        return (keepPositive ? reach : -reach) < -tolerance;
      })
    ) {
      convex = false;
    }
    sides.push({ plane, keepPositive });
  }
  if (!convex) {
    // A reflex corner (the floor of a window cut across a thicker strip of
    // wall is an L). Between sides parallel to the push the sweep is the
    // face's prism, the union of the prisms of convex pieces of it; leaning
    // sides or blends keep the refusal.
    if (!parallel || blends.length > 0) return null;
    // Each edge of the face lies on the side face across it.
    const lineOf = new Map<number, number>();
    Array.from(sideFaces).forEach((sideFace, index) => {
      for (const edge of kernel.sharedEdges(face, sideFace)) {
        lineOf.set(edge, index);
      }
    });
    const planes = sides.map(({ plane }) => plane);
    const pieces = convexSides(kernel, face, direction, planes, lineOf);
    return pieces && { base, sides: [], blends, blendHeight: 0, pieces };
  }
  let blendHeight = 0;
  for (const blend of blends) {
    for (const corner of positions(kernel, kernel.getFaceVertices(blend))) {
      blendHeight = Math.max(blendHeight, height(base, corner));
    }
  }
  // A blend that drops below the face (a rounded outside edge) is not a
  // chain the slab covers.
  if (blends.length > 0 && !(blendHeight > 0)) return null;
  return { base, sides, blends, blendHeight, pieces: null };
}

/**
 * The sides of each convex piece of a face with a reflex corner, every one
 * the exact plane of a side face of the face (`planes`, indexed per edge by
 * `lineOf`); null when an edge has no side face or the outline does not cut
 * cleanly.
 */
function convexSides(
  kernel: RemusKernel,
  face: number,
  direction: Vec3,
  planes: readonly Plane[],
  lineOf: ReadonlyMap<number, number>
): Side[][] | null {
  const wire = kernel.getFaceWires(face)[0]!;
  const loop = Array.from(kernel.getWireEdges(wire), (edge) => {
    const ends = kernel.getEdgeVertices(edge);
    const start = kernel.isEdgeForwardInWire(edge, wire) ? 0 : 3;
    const end = 3 - start;
    return {
      edge,
      start: { x: ends[start]!, y: ends[start + 1]!, z: ends[start + 2]! },
      end: { x: ends[end]!, y: ends[end + 1]!, z: ends[end + 2]! }
    };
  });
  if (loop.length < 3) return null;
  // Lengths in the outline are measured from its first corner. The
  // tolerance follows the face's own size, plus what rounding leaves of
  // coordinates far from the origin: an absolute size would grow past a
  // thin rib's width on a part placed far away.
  const origin = loop[0]!.start;
  let extent = 0;
  let magnitude = 0;
  for (const { start } of loop) {
    extent = Math.max(
      extent,
      Math.hypot(start.x - origin.x, start.y - origin.y, start.z - origin.z)
    );
    magnitude = Math.max(
      magnitude,
      Math.abs(start.x),
      Math.abs(start.y),
      Math.abs(start.z)
    );
  }
  const tolerance = 1e-7 * Math.max(1, extent) + 1e-12 * magnitude;
  // In-plane axes: any direction across the push, and the one across both.
  const axis =
    Math.abs(direction.x) < 0.6 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const across = unit(cross(direction, axis))!;
  const third = cross(direction, across);
  const outline: OutlineCorner[] = [];
  for (const { edge, start } of loop) {
    const line = lineOf.get(edge);
    if (line === undefined) return null;
    const offset = {
      x: start.x - origin.x,
      y: start.y - origin.y,
      z: start.z - origin.z
    };
    outline.push({ u: dot(offset, across), v: dot(offset, third), line });
  }
  let area = 0;
  for (let i = 0; i < outline.length; i += 1) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    area += a.u * b.v - b.u * a.v;
  }
  if (Math.abs(area) <= tolerance * tolerance) return null;
  if (area < 0) {
    // Made counter-clockwise: reversed, each edge keeps its line but now
    // starts at what was its end corner.
    const reversed = outline.slice().reverse();
    const n = reversed.length;
    outline.splice(
      0,
      n,
      ...reversed.map((corner, i) => ({
        ...corner,
        line: reversed[(i + 1) % n]!.line
      }))
    );
  }
  const pieces = convexPieces(outline, tolerance);
  if (!pieces) return null;
  return pieces.map((piece) => {
    // A point inside the convex piece says which side of each plane it is.
    const inside = piece.reduce(
      (sum, corner) => ({
        u: sum.u + corner.u / piece.length,
        v: sum.v + corner.v / piece.length
      }),
      { u: 0, v: 0 }
    );
    const probe = {
      x: origin.x + across.x * inside.u + third.x * inside.v,
      y: origin.y + across.y * inside.u + third.y * inside.v,
      z: origin.z + across.z * inside.u + third.z * inside.v
    };
    return [...new Set(piece.map((corner) => corner.line))].map((line) => {
      const plane = planes[line]!;
      return { plane, keepPositive: height(plane, probe) > 0 };
    });
  });
}

/** Whether `point` lies in the closed swept region `sweepHeight` high. */
function inSweep(
  plan: SweepPlan,
  sweepHeight: number,
  point: Vec3,
  tolerance: number
): boolean {
  const rise = height(plan.base, point);
  if (rise < -tolerance || rise > sweepHeight + tolerance) return false;
  return plan.sides.every(({ plane, keepPositive }) => {
    const reach = height(plane, point);
    return (keepPositive ? reach : -reach) >= -tolerance;
  });
}

/**
 * The region from `lift` to `lift + sweepHeight` above the face plane, cut
 * by every side plane: a box over the body split by exact planes.
 */
function sweptRegion(
  kernel: RemusKernel,
  solid: number,
  plan: SweepPlan,
  sweepHeight: number,
  lift = 0
): number {
  const [minX, minY, minZ, maxX, maxY, maxZ] = kernel.boundingBox(solid);
  const margin =
    sweepHeight +
    lift +
    1 +
    0.1 * Math.hypot(maxX! - minX!, maxY! - minY!, maxZ! - minZ!);
  let region = kernel.makeBox(
    maxX! - minX! + 2 * margin,
    maxY! - minY! + 2 * margin,
    maxZ! - minZ! + 2 * margin
  );
  kernel.transformSolid(
    region,
    // prettier-ignore
    Float64Array.from([
      1, 0, 0, minX! - margin,
      0, 1, 0, minY! - margin,
      0, 0, 1, minZ! - margin,
      0, 0, 0, 1
    ])
  );
  const cut = (plane: Plane, keepPositive: boolean) => {
    const halves = kernel.split(
      region,
      plane.point.x,
      plane.point.y,
      plane.point.z,
      plane.normal.x,
      plane.normal.y,
      plane.normal.z
    );
    const [positive, negative] = [halves[0], halves[1]];
    if (positive === undefined || negative === undefined) {
      throw new Error('The swept region could not be cut.');
    }
    kernel.deleteSolid(keepPositive ? negative : positive);
    region = keepPositive ? positive : negative;
  };
  const normal = plan.base.normal;
  cut({ point: along(plan.base.point, normal, lift), normal }, true);
  cut(
    { point: along(plan.base.point, normal, lift + sweepHeight), normal },
    false
  );
  for (const side of plan.sides) cut(side.plane, side.keepPositive);
  return region;
}

/**
 * The body with `blends` removed, one blend band per defeature: the kernel
 * heals one complete analytic band at a time. Each removal renumbers the
 * faces, so the next blend is found again by its exact surface.
 */
function removeBlends(
  kernel: RemusKernel,
  solid: number,
  blends: ReadonlySet<number>
): number {
  const surfaces = Array.from(blends, (blend) =>
    kernel.getAnalyticSurfaceParams(blend)
  );
  let current = solid;
  for (const surface of surfaces) {
    const matches = Array.from(kernel.getSolidFaces(current)).filter(
      (face) =>
        kernel.getSurfaceType(face) !== 'plane' &&
        kernel.getAnalyticSurfaceParams(face) === surface
    );
    if (matches.length !== 1) {
      throw new Error('A swallowed blend could not be found again.');
    }
    current = kernel.defeature(current, Uint32Array.from(matches));
  }
  return current;
}

/**
 * The body with `face` pushed `offset` outward past whatever it runs into,
 * or null when the push is not one of the exact cases above or the result
 * is not a valid exact solid inside the body's own extent. A null leaves the
 * caller's own refusal standing, which still describes the collision
 * accurately.
 */
export function sweepFaceIntoBody(
  kernel: RemusKernel,
  solid: number,
  face: number,
  outwardNormal: Vec3,
  center: Vec3,
  offset: number
): number | null {
  if (!(offset > 0) || !Number.isFinite(offset)) return null;
  const direction = unit(outwardNormal);
  if (!direction) return null;
  try {
    if (kernel.getSurfaceType(face) !== 'plane') return null;
    // The recorded normal is the outward one; a point just in front of the
    // face's centre must then lie outside the body. A non-convex face whose
    // centroid misses it fails this too, which only declines the fallback.
    const probe = Math.max(1e-4, Math.sqrt(kernel.faceArea(face, 0.1)) * 1e-4);
    const ahead = along(center, direction, probe);
    if (
      kernel.classifyPoint(solid, ahead.x, ahead.y, ahead.z, probe * 1e-2) !==
      'outside'
    ) {
      return null;
    }
    const plan = planSweep(kernel, solid, face, direction, center);
    if (!plan || offset < plan.blendHeight) return null;
    const before = kernel.boundingBox(solid);
    const extent = Math.hypot(
      before[3]! - before[0]!,
      before[4]! - before[1]!,
      before[5]! - before[2]!
    );
    const slack = 1e-7 * Math.max(1, extent);
    // A face with a reflex corner sweeps the union of its convex pieces.
    const parts = (plan.pieces ?? [plan.sides]).map((sides) => ({
      ...plan,
      sides
    }));
    const swept = (point: Vec3) =>
      parts.some((part) => inSweep(part, offset, point, slack));
    // Blends the sweep swallows: the face's own, and any lying wholly in it.
    const swallowed = new Set(plan.blends);
    for (const candidate of kernel.getSolidFaces(solid)) {
      if (
        !swallowed.has(candidate) &&
        kernel.getSurfaceType(candidate) !== 'plane' &&
        positions(kernel, kernel.getFaceVertices(candidate)).every(swept) &&
        isSingleFaceBlend(kernel, solid, candidate)
      ) {
        swallowed.add(candidate);
      }
    }
    let base = solid;
    if (swallowed.size > 0) {
      base = removeBlends(kernel, solid, swallowed);
      // Every corner the removal sharpened must lie in the sweep, where the
      // union fills it again; anywhere else the union would keep it sharp.
      const known = positions(kernel, kernel.getSolidVertices(solid));
      for (const point of positions(kernel, kernel.getSolidVertices(base))) {
        const isNew = known.every(
          (other) =>
            Math.hypot(
              point.x - other.x,
              point.y - other.y,
              point.z - other.z
            ) > slack
        );
        if (isNew && !swept(point)) return null;
      }
    }
    let region = sweptRegion(kernel, solid, parts[0]!, offset);
    if (parts.length > 1) {
      // The pieces are fused into one prism first: the exact boolean takes
      // that against the window's walls and ceiling where it refuses each
      // piece in turn, and where a prism extruded from the face itself
      // comes out with inconsistently oriented edges at the ceiling.
      for (const part of parts.slice(1)) {
        region = exactFuse(
          kernel,
          region,
          sweptRegion(kernel, solid, part, offset)
        );
      }
      unifyAndRequireValidSolid(
        kernel,
        region,
        'The swept region of the face did not build as a valid solid.'
      );
    }
    const fused = exactFuse(kernel, base, region);
    unifyAndRequireValidSolid(
      kernel,
      fused,
      'Pushing the face into the body did not produce a valid solid.'
    );
    if (plan.blendHeight > 0) {
      // The blend material carried up by `offset` must already be material
      // of the result: the slab it lies in, fused on, adds nothing.
      const carried = exactFuse(
        kernel,
        fused,
        sweptRegion(kernel, solid, plan, plan.blendHeight, offset)
      );
      const grown = kernel.volume(carried, 0.01) - kernel.volume(fused, 0.01);
      kernel.deleteSolid(carried);
      if (Math.abs(grown) > 1e-9 * Math.max(1, kernel.volume(fused, 0.01))) {
        return null;
      }
    }
    const after = kernel.boundingBox(fused);
    for (let axis = 0; axis < 3; axis += 1) {
      if (
        after[axis]! < before[axis]! - slack ||
        after[axis + 3]! > before[axis + 3]! + slack
      ) {
        return null;
      }
    }
    return fused;
  } catch {
    return null;
  }
}
