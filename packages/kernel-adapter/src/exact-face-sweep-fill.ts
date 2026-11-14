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
 * does everything outside the conditions above — a face with holes or a
 * reflex corner, curved neighbours that are not blends, an inward
 * (material-removing) push, a push shorter than its blends.
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

/** What the push sweeps, read off the face's neighbourhood. */
interface SweepPlan {
  /** The face's own plane, its normal along the push. */
  base: Plane;
  /** The planes bounding the swept region, each kept on the face's side. */
  sides: { plane: Plane; keepPositive: boolean }[];
  /** The blends that travel with the face. */
  blends: number[];
  /** How far the blend chain rises above the face plane; 0 without blends. */
  blendHeight: number;
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
  const sides: SweepPlan['sides'] = [];
  const corners = positions(kernel, kernel.getFaceVertices(face));
  for (const sideFace of sideFaces) {
    const plane = planeOf(kernel, sideFace);
    if (!plane) return null;
    const cos = dot(plane.normal, direction);
    // Blends travel with the face only between sides parallel to the push.
    if (blends.length > 0 && Math.abs(cos) > PARALLEL_TOLERANCE) return null;
    // A side nearly along the face itself is a step, not a re-limit.
    if (Math.abs(cos) > 1 - 1e-6) return null;
    const side = height(plane, center);
    if (Math.abs(side) <= 1e-9) return null;
    const keepPositive = side > 0;
    // Convex: the whole face lies on the side its centre does.
    const tolerance = 1e-7 * Math.max(1, Math.abs(side));
    for (const corner of corners) {
      const reach = height(plane, corner);
      if ((keepPositive ? reach : -reach) < -tolerance) return null;
    }
    sides.push({ plane, keepPositive });
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
  return { base, sides, blends, blendHeight };
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
    // Blends the sweep swallows: the face's own, and any lying wholly in it.
    const swallowed = new Set(plan.blends);
    for (const candidate of kernel.getSolidFaces(solid)) {
      if (
        !swallowed.has(candidate) &&
        kernel.getSurfaceType(candidate) !== 'plane' &&
        positions(kernel, kernel.getFaceVertices(candidate)).every((point) =>
          inSweep(plan, offset, point, slack)
        ) &&
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
        if (isNew && !inSweep(plan, offset, point, slack)) return null;
      }
    }
    const fused = exactFuse(
      kernel,
      base,
      sweptRegion(kernel, solid, plan, offset)
    );
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
