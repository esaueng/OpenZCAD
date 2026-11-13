/**
 * Consumer-side acceptance gates for results the kernel reports as built.
 *
 * Some kernel operations return `ok` with geometry that contradicts their own
 * inputs: a subtract that hands back the target untouched although the tool
 * provably overlaps it, or a wall resize that leaves the blend along the wall
 * behind and caps it off with a new face. Every structural check passes on
 * such a body — it is closed, valid and exact — so nothing downstream can see
 * the defect. These gates compare the result against what the operation is
 * defined to do, and refuse by name when it did not.
 *
 * Each gate only refuses on proof: a point the kernel itself classifies
 * inside both operands, a point the operands' own tessellations enclose with
 * a margin of several chord deflections, or a face census the kernel itself
 * reports. A gate
 * that cannot decide accepts, so the gates never guess a nearest face and
 * never turn an unmeasurable case into a refusal.
 *
 * The refusals are typed ({@link ResultAcceptanceRefusal}) so a consumer can
 * tell "the kernel's result failed our acceptance check" from prose. The
 * adapter's own code stands in for the kernel's, which gave none: the kernel
 * reported success.
 *
 * Measured in the K10 combination matrix
 * (docs/plans/kernel-robustness-plan-2026-11-05.md, "Matrix results").
 */
import type { Vec3 } from '@openzcad/geometry';
import { KernelRefusal, type KernelRefusalCategory } from './kernel-refusal';
import type { RemusKernel } from './remus-runtime';
import { measureFaceGeometry } from './exact-measure';
import { edgeToFaceMapOf, surfaceTypeOf } from './exact-sync-memo';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';

/** The adapter's codes for a result it refused after the kernel built it. */
export type ResultAcceptanceCode =
  | 'cut_kept_tool_material'
  | 'resize_left_blend_behind'
  | 'resize_volume_mismatch';

/**
 * A result the kernel reported as built and the adapter refused.
 *
 * `family` is `validation`: the operation ran, and the body it produced
 * failed a check made after it. `category` follows the kernel's taxonomy so
 * the web app's sentence table can answer for it like any other refusal.
 */
export class ResultAcceptanceRefusal extends KernelRefusal {
  readonly acceptanceCode: ResultAcceptanceCode;

  constructor(init: {
    code: ResultAcceptanceCode;
    category: KernelRefusalCategory;
    /** The whole product sentence, starting with its own heading. */
    headline: string;
    /** What the check measured, kept behind the headline as detail. */
    detail: string;
  }) {
    super({
      family: 'validation',
      category: init.category,
      kernelCode: init.code,
      kernelMessage: init.detail,
      reason: init.headline,
      message: `${init.headline}\nAcceptance check ${init.code}: ${init.detail}`
    });
    this.name = 'ResultAcceptanceRefusal';
    this.acceptanceCode = init.code;
  }
}

/** Grid points per axis searched for a shared-material witness. */
const WITNESS_GRID = 8;

function formatPoint(point: readonly number[]): string {
  return `(${point.map((value) => Number(value.toPrecision(6))).join(', ')})`;
}

/**
 * A point the kernel classifies strictly inside the target, the tool and the
 * cut result — proof that the cut kept material it was asked to remove — or
 * null when the search finds none.
 *
 * Only for a subtract whose overlap could not be measured (the exact
 * intersect refused): with a measured overlap the removed-volume gate in the
 * Boolean builder already answers. The search is a deterministic grid over
 * the two bounding boxes' overlap, so it can miss a thin overlap; missing one
 * accepts the result, it never refuses one. A strictly interior point of
 * both operands has a neighbourhood of shared material, which a correct cut
 * removes entirely, so a single such point still inside the result settles
 * it.
 */
export function cutRetainedToolMaterialWitness(
  kernel: RemusKernel,
  target: number,
  tool: number,
  result: number
): readonly [number, number, number] | null {
  const a = kernel.boundingBox(target);
  const b = kernel.boundingBox(tool);
  const low = [0, 1, 2].map((axis) => Math.max(a[axis]!, b[axis]!));
  const high = [0, 1, 2].map((axis) => Math.min(a[axis + 3]!, b[axis + 3]!));
  const spans = low.map((value, axis) => high[axis]! - value);
  if (spans.some((span) => !(span > 0))) return null;
  // Classification tolerance at one part per billion of the overlap, the
  // same relative floor the shared-volume measurement uses.
  const tolerance = Math.max(Math.hypot(...spans) * 1e-9, 1e-12);
  const inside = (solid: number, point: readonly number[]): boolean => {
    try {
      return (
        kernel.classifyPoint(
          solid,
          point[0]!,
          point[1]!,
          point[2]!,
          tolerance
        ) === 'inside'
      );
    } catch {
      return false;
    }
  };
  for (let i = 0; i < WITNESS_GRID; i += 1) {
    for (let j = 0; j < WITNESS_GRID; j += 1) {
      for (let k = 0; k < WITNESS_GRID; k += 1) {
        const point = [i, j, k].map(
          (step, axis) =>
            low[axis]! + ((step + 0.5) / WITNESS_GRID) * spans[axis]!
        ) as [number, number, number];
        if (
          inside(tool, point) &&
          inside(target, point) &&
          inside(result, point)
        ) {
          return point;
        }
      }
    }
  }
  return null;
}

/** The refusal for a cut that kept material its tool overlaps. */
export function cutKeptToolMaterialRefusal(
  operation: 'subtract' | 'cut',
  point: readonly number[]
): ResultAcceptanceRefusal {
  return new ResultAcceptanceRefusal({
    code: 'cut_kept_tool_material',
    category: 'internal',
    headline:
      `${operation === 'subtract' ? 'Subtract' : 'Cut'} refused: the exact ` +
      'kernel returned the target without removing the material the tool ' +
      'overlaps. The target and tools were left unchanged.',
    detail:
      `the kernel reported the cut as built, but point ${formatPoint(point)} ` +
      'lies inside the target, the tool and the result.'
  });
}

/**
 * A closed triangle mesh, held as plain arrays so the witness search below
 * never asks the kernel's point classifier anything.
 */
export interface ClosedMesh {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

function meshOf(
  kernel: RemusKernel,
  solid: number,
  deflection: number
): ClosedMesh | null {
  try {
    const mesh = kernel.tessellateSolid(solid, deflection);
    try {
      return {
        positions: mesh.positions.slice(),
        indices: mesh.indices.slice()
      };
    } finally {
      mesh.free();
    }
  } catch {
    return null;
  }
}

/**
 * The generalized winding number of a closed mesh about `point`: 1 inside,
 * 0 outside (Van Oosterom–Strackee solid angles, summed and divided by 4π).
 */
export function meshWindingNumber(
  mesh: ClosedMesh,
  point: readonly number[]
): number {
  const { positions, indices } = mesh;
  const [px, py, pz] = point as [number, number, number];
  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ax = positions[a]! - px;
    const ay = positions[a + 1]! - py;
    const az = positions[a + 2]! - pz;
    const bx = positions[b]! - px;
    const by = positions[b + 1]! - py;
    const bz = positions[b + 2]! - pz;
    const cx = positions[c]! - px;
    const cy = positions[c + 1]! - py;
    const cz = positions[c + 2]! - pz;
    const la = Math.hypot(ax, ay, az);
    const lb = Math.hypot(bx, by, bz);
    const lc = Math.hypot(cx, cy, cz);
    const det =
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
    const denominator =
      la * lb * lc +
      (ax * bx + ay * by + az * bz) * lc +
      (bx * cx + by * cy + bz * cz) * la +
      (cx * ax + cy * ay + cz * az) * lb;
    total += 2 * Math.atan2(det, denominator);
  }
  return total / (4 * Math.PI);
}

/** The distance from `point` to the nearest triangle of `mesh`. */
export function meshDistance(
  mesh: ClosedMesh,
  point: readonly number[]
): number {
  const { positions, indices } = mesh;
  let best = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const corner = (k: number): [number, number, number] => {
      const i = indices[t + k]! * 3;
      return [positions[i]!, positions[i + 1]!, positions[i + 2]!];
    };
    best = Math.min(
      best,
      pointTriangleDistance(point, corner(0), corner(1), corner(2))
    );
  }
  return best;
}

/** Euclidean point–triangle distance (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangleDistance(
  p: readonly number[],
  a: readonly number[],
  b: readonly number[],
  c: readonly number[]
): number {
  const sub = (u: readonly number[], v: readonly number[]) => [
    u[0]! - v[0]!,
    u[1]! - v[1]!,
    u[2]! - v[2]!
  ];
  const dot = (u: readonly number[], v: readonly number[]) =>
    u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!;
  // The point `a + s·u` on an edge leaving `a`.
  const along = (s: number, u: readonly number[]) => [
    a[0]! + s * u[0]!,
    a[1]! + s * u[1]!,
    a[2]! + s * u[2]!
  ];
  const distanceTo = (q: readonly number[]) => Math.hypot(...sub(p, q));
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return distanceTo(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return distanceTo(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    return distanceTo(along(d1 / (d1 - d3), ab));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return distanceTo(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    return distanceTo(along(d2 / (d2 - d6), ac));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return distanceTo([
      b[0]! + w * (c[0]! - b[0]!),
      b[1]! + w * (c[1]! - b[1]!),
      b[2]! + w * (c[2]! - b[2]!)
    ]);
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return distanceTo([
    a[0]! + ab[0]! * v + ac[0]! * w,
    a[1]! + ab[1]! * v + ac[1]! * w,
    a[2]! + ab[2]! * v + ac[2]! * w
  ]);
}

/** Chord deflections a tessellated witness must clear on every boundary. */
const TESSELLATED_WITNESS_MARGIN = 4;

/** A cut that kept tool material, proved on the operands' tessellations. */
export interface TessellatedCutWitness {
  readonly point: readonly [number, number, number];
  /** The distance the point clears every mesh boundary by, model units. */
  readonly clearance: number;
  /** The chord deflection the three meshes were built at. */
  readonly deflection: number;
}

/**
 * {@link cutRetainedToolMaterialWitness} without the kernel's point
 * classifier: a point enclosed by the target's, the tool's and the result's
 * tessellations, clear of all three boundaries by several chord deflections.
 *
 * Issue #1242 filed a subtract whose result kept the overlap while the
 * kernel's own classifier misplaced that overlap for all four recipes, so a
 * gate built on the classifier alone accepted the unchanged target. Winding
 * numbers and point-to-triangle distances on the meshes are independent of
 * it. The meshes approximate the exact faces to a chord deflection, so a
 * point is only trusted when it clears every mesh by
 * {@link TESSELLATED_WITNESS_MARGIN} deflections: then the exact boundary
 * cannot lie between it and the mesh. A correct cut leaves such a point
 * outside the result by the same margin, so it never refuses one. Missing a
 * thin overlap accepts, as for the classifier search.
 */
export function cutRetainedToolMaterialMeshWitness(
  kernel: RemusKernel,
  target: number,
  tool: number,
  result: number
): TessellatedCutWitness | null {
  const a = kernel.boundingBox(target);
  const b = kernel.boundingBox(tool);
  const low = [0, 1, 2].map((axis) => Math.max(a[axis]!, b[axis]!));
  const high = [0, 1, 2].map((axis) => Math.min(a[axis + 3]!, b[axis + 3]!));
  const spans = low.map((value, axis) => high[axis]! - value);
  if (spans.some((span) => !(span > 0))) return null;
  // Fine against the overlap, bounded against the whole pair so a small
  // overlap of two large bodies does not tessellate them without limit.
  const pairSpan = Math.hypot(
    ...[0, 1, 2].map(
      (axis) =>
        Math.max(a[axis + 3]!, b[axis + 3]!) - Math.min(a[axis]!, b[axis]!)
    )
  );
  const deflection = Math.max(
    Math.min(Math.hypot(...spans) * 2e-3, MEASUREMENT_DEFLECTION),
    pairSpan * 2e-4
  );
  const margin = deflection * TESSELLATED_WITNESS_MARGIN;
  const targetMesh = meshOf(kernel, target, deflection);
  const toolMesh = meshOf(kernel, tool, deflection);
  if (!targetMesh || !toolMesh) return null;
  let resultMesh: ClosedMesh | null | undefined;
  const enclosedBy = (mesh: ClosedMesh, point: readonly number[]) =>
    meshWindingNumber(mesh, point) > 0.5 && meshDistance(mesh, point) > margin;
  for (let i = 0; i < WITNESS_GRID; i += 1) {
    for (let j = 0; j < WITNESS_GRID; j += 1) {
      for (let k = 0; k < WITNESS_GRID; k += 1) {
        const point = [i, j, k].map(
          (step, axis) =>
            low[axis]! + ((step + 0.5) / WITNESS_GRID) * spans[axis]!
        ) as [number, number, number];
        if (!enclosedBy(toolMesh, point) || !enclosedBy(targetMesh, point)) {
          continue;
        }
        // Only built once the operands demonstrably share material.
        resultMesh ??= meshOf(kernel, result, deflection);
        if (!resultMesh) return null;
        if (enclosedBy(resultMesh, point)) {
          return {
            point,
            clearance: Math.min(
              meshDistance(targetMesh, point),
              meshDistance(toolMesh, point),
              meshDistance(resultMesh, point)
            ),
            deflection
          };
        }
      }
    }
  }
  return null;
}

/** {@link cutKeptToolMaterialRefusal} for a tessellated witness. */
export function cutKeptToolMaterialMeshRefusal(
  operation: 'subtract' | 'cut',
  witness: TessellatedCutWitness
): ResultAcceptanceRefusal {
  const refusal = cutKeptToolMaterialRefusal(operation, witness.point);
  return new ResultAcceptanceRefusal({
    code: 'cut_kept_tool_material',
    category: 'internal',
    headline: refusal.reason,
    detail:
      `the kernel reported the cut as built, but the tessellated target, ` +
      `tool and result all enclose point ${formatPoint(witness.point)} by ` +
      `at least ${Number(witness.clearance.toPrecision(3))} ` +
      `(chord deflection ${Number(witness.deflection.toPrecision(3))}).`
  });
}

/** The faces sharing an edge with `face` in `solid`, `face` excluded. */
function neighbourFaces(
  kernel: RemusKernel,
  solid: number,
  face: number
): Set<number> {
  const map = edgeToFaceMapOf(kernel, solid);
  const neighbours = new Set<number>();
  for (const edge of kernel.getFaceEdges(face)) {
    for (const other of map[String(edge)] ?? []) {
      if (other !== face) neighbours.add(other);
    }
  }
  return neighbours;
}

/** The cylindrical faces of `solid` on one axis at one radius. */
export function coaxialCylinderFacesAt(
  kernel: RemusKernel,
  solid: number,
  axisPoint: Vec3,
  axisDirection: Vec3,
  radius: number,
  axisTolerance: number,
  radiusTolerance: number
): number[] {
  return Array.from(kernel.getSolidFaces(solid)).filter((handle) => {
    const measured = measureFaceGeometry(kernel, handle);
    if (
      measured?.surfaceType !== 'cylinder' ||
      measured.radius === undefined ||
      !measured.axisStart ||
      Math.abs(measured.radius - radius) > radiusTolerance
    ) {
      return false;
    }
    const toAxis = {
      x: measured.axisStart.x - axisPoint.x,
      y: measured.axisStart.y - axisPoint.y,
      z: measured.axisStart.z - axisPoint.z
    };
    const along =
      toAxis.x * axisDirection.x +
      toAxis.y * axisDirection.y +
      toAxis.z * axisDirection.z;
    return (
      Math.hypot(
        toAxis.x - axisDirection.x * along,
        toAxis.y - axisDirection.y * along,
        toAxis.z - axisDirection.z * along
      ) <= axisTolerance
    );
  });
}

/**
 * How many faces of each curved surface type meet the wall faces.
 *
 * Planar neighbours are left out: caps and the faces a wall stands on are
 * re-trimmed by a resize, and a plane can legitimately appear where a wall
 * meets a stepped face. A curved neighbour of a cylindrical wall is a blend
 * band, a chamfer cone or another wall the boolean met, and every one of
 * them must still meet the wall after it moves: the move re-intersects or
 * rebuilds it, it does not leave it where it was.
 */
function curvedNeighbourCensus(
  kernel: RemusKernel,
  solid: number,
  walls: readonly number[]
): Map<string, number> {
  const wallSet = new Set(walls);
  const neighbours = new Set<number>();
  for (const wall of walls) {
    for (const face of neighbourFaces(kernel, solid, wall)) {
      if (!wallSet.has(face)) neighbours.add(face);
    }
  }
  const census = new Map<string, number>();
  for (const face of neighbours) {
    const type = surfaceTypeOf(kernel, face);
    if (type === 'plane') continue;
    census.set(type, (census.get(type) ?? 0) + 1);
  }
  return census;
}

/** Ratio the measured volume change may differ from the sleeve estimate by. */
const RESIZE_VOLUME_RATIO = 3;

export interface WallResizeAcceptance {
  sourceSolid: number;
  sourceWall: number;
  sourceRadius: number;
  output: number;
  newRadius: number;
  axisPoint: Vec3;
  axisDirection: Vec3;
  axisTolerance: number;
  radiusTolerance: number;
}

/**
 * Refuses a wall resize the kernel built without carrying the wall's
 * neighbours along, or whose volume change is far from the sleeve it swept.
 *
 * Measured on the pin: a box/boss union with an r 2 seam fillet, the boss
 * wall resized from r 6 to r 7, comes back closed and valid with the fillet
 * band untouched at r 6 and a new downward annulus capping it at the band's
 * top. The groove under that annulus is 46.9 mm³ of missing material, and
 * the volume change equals the bare sleeve exactly, so only the census can
 * see it: the band no longer meets the wall.
 *
 * The volume bound is deliberately loose. The swept sleeve is estimated
 * from the wall's own area, θ·L·|r₁² − r₀²|/2 for a wall of angular span θ
 * and length L, which blends that follow the wall change only by a fraction
 * of. A change outside [estimate/3, 3·estimate] means the kernel did not do
 * the resize it reports — notably the untouched original, a change of zero.
 */
export function assertWallResizeAccepted(
  kernel: RemusKernel,
  input: WallResizeAcceptance
): void {
  const headline = `The wall could not be resized to radius ${Number(input.newRadius.toPrecision(6))}`;
  const before = curvedNeighbourCensus(kernel, input.sourceSolid, [
    input.sourceWall
  ]);
  const walls = coaxialCylinderFacesAt(
    kernel,
    input.output,
    input.axisPoint,
    input.axisDirection,
    input.newRadius,
    input.axisTolerance,
    input.radiusTolerance
  );
  if (walls.length === 0) return;
  const after = curvedNeighbourCensus(kernel, input.output, walls);
  const lost = [...before].filter(
    ([type, count]) => (after.get(type) ?? 0) < count
  );
  if (lost.length > 0) {
    const describe = (census: Map<string, number>) =>
      [...census].map(([type, count]) => `${count} ${type}`).join(', ') ||
      'none';
    throw new ResultAcceptanceRefusal({
      code: 'resize_left_blend_behind',
      category: 'unsupported',
      headline:
        `${headline}: the blend or chamfer along its edge would be left ` +
        'behind at the old size. Remove the blend, resize the wall, then ' +
        'add the blend again.',
      detail:
        `curved faces meeting the wall before the resize: ${describe(before)}; ` +
        `after: ${describe(after)}.`
    });
  }
  const area = kernel.faceArea(input.sourceWall, MEASUREMENT_DEFLECTION);
  const expected =
    (area * Math.abs(input.newRadius ** 2 - input.sourceRadius ** 2)) /
    (2 * input.sourceRadius);
  if (!(expected > 0) || !Number.isFinite(expected)) return;
  const change = Math.abs(
    kernel.volume(input.output, MEASUREMENT_DEFLECTION) -
      kernel.volume(input.sourceSolid, MEASUREMENT_DEFLECTION)
  );
  if (
    change < expected / RESIZE_VOLUME_RATIO ||
    change > expected * RESIZE_VOLUME_RATIO
  ) {
    throw new ResultAcceptanceRefusal({
      code: 'resize_volume_mismatch',
      category: 'internal',
      headline: `${headline}: the exact kernel returned a body whose volume does not match the resize.`,
      detail:
        `the volume changed by ${Number(change.toPrecision(6))}; the swept ` +
        `wall implies about ${Number(expected.toPrecision(6))} ` +
        `(accepted ${RESIZE_VOLUME_RATIO}× either way).`
    });
  }
}
