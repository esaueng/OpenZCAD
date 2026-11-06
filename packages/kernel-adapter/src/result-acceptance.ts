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
 * inside both operands, or a face census the kernel itself reports. A gate
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
