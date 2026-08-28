/**
 * Boolean and union support: fuse/unify wrappers, shared-volume probes for
 * operation inference, connectivity checks, and the tangent-union offset
 * suggestion. Kernel-facing but stateless; boolean policy (which operation a
 * feature performs) stays with the adapter's build loop.
 */
import type { RemusKernel } from './remus-runtime';
import type { BodyId } from '@openzcad/shared';
import {
  extrudeBoundsCanShareVolume,
  extrudeVolumeTolerance,
  type ExtrudeInferenceBody
} from './extrude-inference';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { displayTessellationForExtents } from './display-tessellation';
import {
  booleanFacetFallbackWarning,
  censusOfSolids,
  countFaceConnectedComponents,
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh,
  selectSafelyUnifiedSolid
} from './boolean-result-validation';
import type { UnionBounds } from './union-connectivity';
import type { ExactShape } from './exact-types';
import {
  GEOMETRY_EPSILON,
  transformMatrix
} from './exact-math';

export interface UnionFuseOperand {
  solid: number;
  name: string;
  bounds: UnionBounds;
}

/**
 * A move that turns a faceted union into an exact one, or nothing.
 *
 * The fuse facets where the operands meet tangentially, which for the shapes
 * this workspace makes is almost always an axis or a face sitting exactly in
 * one of the other operand's face planes. That is where a new primitive
 * lands: a box is corner-origin and a cylinder is axis-origin, so creating
 * one of each puts the cylinder's axis on the box's corner edge, and the
 * repair a user reaches for first — slide it along X — keeps the axis in the
 * y = 0 plane and fails again.
 *
 * So the remedy is worth naming exactly rather than describing. Each
 * candidate is TRIED, on copies, and only offered once the fuse it produces
 * is measured exact: a suggestion that does not work is worse than the
 * general advice it replaces, and this is the same reason
 * `edgeModifierSucceedsSmaller` probes instead of inferring.
 */
/**
 * Whether one solid tessellates to a closed, consistently oriented mesh —
 * the same question the strict union validation asks later, asked early.
 *
 * It has to be the same question. The refusal copy is emitted once: here if a
 * union is unacceptable, and by the strict pass otherwise. If these two
 * disagree, either a union is refused twice or the proved move never reaches
 * the sentence it belongs to. Both go through `inspectTriangleMeshClosure`
 * with the deflection the display pass picks for the body's own extents.
 */
export function solidMeshIsClosed(kernel: RemusKernel, solid: number): boolean {
  try {
    const bounds = kernel.boundingBox(solid);
    const tessellation = displayTessellationForExtents(
      bounds[3]! - bounds[0]!,
      bounds[4]! - bounds[1]!,
      bounds[5]! - bounds[2]!
    );
    const mesh = kernel.tessellateSolidGroupedBinary(
      solid,
      tessellation.linearDeflection,
      tessellation.angularDeflection
    );
    try {
      return isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(mesh.positions, mesh.indices)
      );
    } finally {
      mesh.free();
    }
  } catch {
    // A body that cannot even be tessellated is not one to offer a move for.
    return false;
  }
}

export function exactUnionOffsetSuggestion(
  kernel: RemusKernel,
  operands: readonly UnionFuseOperand[],
  units: string
): string | null {
  if (operands.length !== 2) {
    return null;
  }
  const [anchor, mover] = operands as [UnionFuseOperand, UnionFuseOperand];
  const centre = (bounds: UnionBounds, axis: 'x' | 'y' | 'z') =>
    (bounds.min[axis] + bounds.max[axis]) / 2;
  const axes = ['x', 'y', 'z'] as const;
  const toCentre = {
    x: centre(anchor.bounds, 'x') - centre(mover.bounds, 'x'),
    y: centre(anchor.bounds, 'y') - centre(mover.bounds, 'y'),
    z: centre(anchor.bounds, 'z') - centre(mover.bounds, 'z')
  };
  // One axis first, because a single number is the easiest move to carry out.
  // A ball or a ring created against the box's corner needs all three before
  // it sits anywhere clean, so the combined move is tried after them.
  const candidates: { x: number; y: number; z: number }[] = [
    ...axes.map((axis) => ({
      x: axis === 'x' ? toCentre.x : 0,
      y: axis === 'y' ? toCentre.y : 0,
      z: axis === 'z' ? toCentre.z : 0
    })),
    toCentre
  ];
  const operandCensus = censusOfSolids(kernel, [anchor.solid, mover.solid]);
  const format = (value: number) => {
    const rounded = Number(
      Math.abs(value) < 1 ? value.toFixed(3) : value.toFixed(2)
    );
    return `${rounded > 0 ? '+' : ''}${rounded}`;
  };
  for (const offset of candidates) {
    const moves = axes.filter(
      (axis) => Math.abs(offset[axis]) > GEOMETRY_EPSILON
    );
    if (moves.length === 0) {
      continue;
    }
    let candidate: number;
    try {
      const moved = kernel.copySolid(mover.solid);
      kernel.transformSolid(
        moved,
        transformMatrix(offset, { x: 0, y: 0, z: 0 })
      );
      // Through `fuseUniformSolid`, the same call the real union makes, not a
      // bare `fuseAll`. The unification step it adds is not cosmetic: without
      // it a candidate can fail the solid check below that the actual edit
      // would have accepted, and the probe then reports no move exists when
      // one plainly does.
      candidate = fuseUniformSolid(kernel, [
        kernel.copySolid(anchor.solid),
        moved
      ]);
    } catch {
      continue;
    }
    // A candidate that swallows the mover inside the anchor also loses every
    // curved face, so it fails this same check rather than being offered as a
    // move that makes the user's new body disappear.
    if (
      booleanFacetFallbackWarning({
        operands: operandCensus,
        result: censusOfSolids(kernel, [candidate])
      }) !== null
    ) {
      continue;
    }
    // And it has to be a solid. Faceting is not the only way a tangency
    // fails, so clearing the facet check alone would let this offer a move
    // that trades one refusal for the other — worse than the general advice
    // it replaces, which is the one thing this must never be.
    try {
      if (
        kernel.validateSolid(candidate) !== 0 ||
        !solidMeshIsClosed(kernel, candidate)
      ) {
        continue;
      }
    } catch {
      continue;
    }
    const described = moves
      .map(
        (axis) => `${format(offset[axis])} ${units} in ${axis.toUpperCase()}`
      )
      .join(', ');
    return `Moving ${mover.name} ${described} clears it.`;
  }
  return null;
}

export function collapseShape(kernel: RemusKernel, shape: ExactShape): number {
  if (shape.solids.length === 0) {
    throw new Error('Exact body contains no solids.');
  }
  return shape.solids.length === 1
    ? shape.solids[0]!
    : fuseUniformSolid(kernel, shape.solids);
}

/**
 * Boolean union can leave adjacent coplanar faces split along the source-solid
 * boundary. The result is one valid solid, but those fragments render as false
 * seams and make a manufactured part look assembled from separate plates.
 * Remus unifies only faces on the same underlying surface, so real part
 * boundaries, holes, blends, and sharp corners remain intact.
 */
export function unifyBooleanFaces(kernel: RemusKernel, solid: number): number {
  kernel.unifyFaces(solid);
  return solid;
}

export function unifyUnionFaces(kernel: RemusKernel, solid: number): number {
  return selectSafelyUnifiedSolid(kernel, solid, (candidate) =>
    isStrictBooleanSolid(kernel, candidate)
  );
}

export function fuseUniformSolid(kernel: RemusKernel, solids: number[]): number {
  const fused = kernel.fuseAll(Uint32Array.from(solids));
  return unifyUnionFaces(kernel, fused);
}

/**
 * Bounds of one face's disposable display projection.
 *
 * Remus's numeric handles are entity-local: a face handle is not a solid
 * handle, even when the two happen to share the same integer. Passing a face
 * to `boundingBox` used to work accidentally while that integer also named a
 * live solid. Tessellating the face is the supported face-level query, and
 * its deflection matches the approximation allowance used by the caller.
 */
export function tessellatedFaceBounds(
  kernel: RemusKernel,
  face: number
): Float64Array {
  const mesh = kernel.tessellateFace(face, MEASUREMENT_DEFLECTION);
  try {
    const bounds = new Float64Array([
      Infinity,
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
      -Infinity
    ]);
    for (let index = 0; index + 2 < mesh.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const coordinate = mesh.positions[index + axis]!;
        bounds[axis] = Math.min(bounds[axis]!, coordinate);
        bounds[axis + 3] = Math.max(bounds[axis + 3]!, coordinate);
      }
    }
    if (!Array.from(bounds).every(Number.isFinite)) {
      throw new Error('The exact kernel returned an empty face projection.');
    }
    return bounds;
  } finally {
    mesh.free();
  }
}

/**
 * How much interior volume these solids share, summed over every pair.
 *
 * Zero means they can be summed safely. A positive figure means summing
 * double-counts, and its SIZE is what tells a caller afterwards whether a
 * fuse actually merged anything — which is why this returns a quantity
 * rather than the boolean the first cut of it returned. By inclusion-
 * exclusion the pairwise total is the exact correction where no three solids
 * share a region and an overestimate where they do, so it is a lower bound on
 * what a successful merge must remove, never an upper one.
 *
 * TOUCHING IS NOT OVERLAPPING, and the distinction is the whole point. Two
 * boxes meeting exactly on a face sum to their true union, so fusing them
 * would change topology and lineage while moving no number; two boxes that
 * interpenetrate are counted twice by any caller that sums per-solid volumes.
 * Only the second case is a defect, so only the second case is reported here.
 *
 * Bounding boxes filter first, so the exact intersect — much the more
 * expensive call, and the one that can throw — runs only on pairs that could
 * possibly share volume. A patterned row's boxes overlap only between
 * neighbours, so the kernel work stays near-linear in the instance count even
 * though the box scan is quadratic.
 *
 * The floor is a fraction of the pair's own bounding diagonal CUBED, not an
 * absolute figure. A volume is L^3: an absolute floor would call a
 * millimetre-scale overlap empty and a kilometre-scale rounding error real.
 * This is the same dimensional mistake this project has now found in the
 * kernel five times, and it is not worth making again here.
 */
export function sharedSolidVolume(kernel: RemusKernel, solids: number[]): number {
  if (solids.length < 2) {
    return 0;
  }
  let total = 0;
  const boxes = solids.map((solid) => kernel.boundingBox(solid));
  for (let left = 0; left < solids.length; left += 1) {
    for (let right = left + 1; right < solids.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const spans = [0, 1, 2].map(
        (axis) =>
          Math.min(a[axis + 3]!, b[axis + 3]!) - Math.max(a[axis]!, b[axis]!)
      );
      if (spans.some((span) => span <= 0)) {
        continue;
      }
      const diagonal = Math.hypot(
        Math.max(a[3]! - a[0]!, b[3]! - b[0]!),
        Math.max(a[4]! - a[1]!, b[4]! - b[1]!),
        Math.max(a[5]! - a[2]!, b[5]! - b[2]!)
      );
      const floor = diagonal ** 3 * 1e-9;
      // The box overlap is an upper bound on the shared volume, so a pair
      // whose boxes barely graze cannot clear the floor and need not be
      // intersected at all.
      if (spans[0]! * spans[1]! * spans[2]! <= floor) {
        continue;
      }
      let shared: number;
      try {
        shared = kernel.volume(
          kernel.intersect(solids[left]!, solids[right]!),
          MEASUREMENT_DEFLECTION
        );
      } catch {
        // A refused intersection is not evidence of disjointness. The boxes
        // already say these two could share volume, so fail toward fusing: a
        // needless fuse costs time, a missed one reports a wrong volume. The
        // box overlap stands in for a figure the kernel would not give.
        total += spans[0]! * spans[1]! * spans[2]!;
        continue;
      }
      if (shared > floor) {
        total += shared;
      }
    }
  }
  return total;
}

export function inferenceBodyForShape(
  kernel: RemusKernel,
  shape: ExactShape,
  bodyId: BodyId,
  name: string
): ExtrudeInferenceBody {
  if (shape.solids.length === 0) {
    throw new Error(`Body "${name}" contains no exact solids.`);
  }
  const boxes = shape.solids.map((solid) => kernel.boundingBox(solid));
  return {
    bodyId,
    name,
    volume: shape.solids.reduce(
      (total, solid) => total + kernel.volume(solid, MEASUREMENT_DEFLECTION),
      0
    ),
    bbox: {
      min: {
        x: Math.min(...boxes.map((box) => box[0]!)),
        y: Math.min(...boxes.map((box) => box[1]!)),
        z: Math.min(...boxes.map((box) => box[2]!))
      },
      max: {
        x: Math.max(...boxes.map((box) => box[3]!)),
        y: Math.max(...boxes.map((box) => box[4]!)),
        z: Math.max(...boxes.map((box) => box[5]!))
      }
    }
  };
}

/**
 * Whether two solids share material or meet exactly.
 *
 * Shared volume alone cannot answer this: two solids meeting at a face — a
 * boss grown off the face it was sketched on — have none, and read as
 * disjoint by volume while being perfectly joinable. Exact distance is what
 * separates that from a solid sitting apart in space.
 *
 * The tolerance matches `union-connectivity`'s contact rule, and is
 * deliberately numerical rather than a modeling tolerance: touching must
 * never be stretched to bridge a real empty gap. A bounding-box test is not
 * enough here — two solids can share an overlapping box and still be well
 * clear of each other.
 */
export function solidsShareMaterialOrTouch(
  kernel: RemusKernel,
  left: number,
  right: number
): boolean {
  try {
    if (
      kernel.volume(kernel.intersect(left, right), MEASUREMENT_DEFLECTION) > 0
    ) {
      return true;
    }
  } catch {
    // A refused intersection is not evidence of separation; the distance
    // query below answers contact directly. It is also the path for kernels
    // that report penetration depth instead of zero for intersecting solids.
  }
  try {
    const distance = kernel.solidToSolidDistance(left, right)[0];
    if (distance === undefined || !Number.isFinite(distance) || distance < 0) {
      return false;
    }
    const boxes = [kernel.boundingBox(left), kernel.boundingBox(right)];
    const scale = Math.max(
      1,
      ...boxes.flatMap((box) => [
        Math.hypot(box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!),
        ...Array.from(box, Math.abs)
      ])
    );
    return distance <= Number.EPSILON * scale * 128;
  } catch {
    return false;
  }
}

/** Whether any solid of one shape shares material with or touches the other. */
export function shapesShareMaterialOrTouch(
  kernel: RemusKernel,
  left: ExactShape,
  right: ExactShape
): boolean {
  for (const leftSolid of left.solids) {
    for (const rightSolid of right.solids) {
      if (solidsShareMaterialOrTouch(kernel, leftSolid, rightSolid)) {
        return true;
      }
    }
  }
  return false;
}

/** Exact common material between two body shapes; tangency returns zero. */
export function sharedShapeVolume(
  kernel: RemusKernel,
  left: ExactShape,
  right: ExactShape,
  leftBody: ExtrudeInferenceBody,
  rightBody: ExtrudeInferenceBody
): number {
  if (!extrudeBoundsCanShareVolume(leftBody.bbox, rightBody.bbox)) {
    return 0;
  }
  let total = 0;
  for (const leftSolid of left.solids) {
    const leftBox = kernel.boundingBox(leftSolid);
    for (const rightSolid of right.solids) {
      const rightBox = kernel.boundingBox(rightSolid);
      const pairBounds = (box: Float64Array): ExtrudeInferenceBody['bbox'] => ({
        min: { x: box[0]!, y: box[1]!, z: box[2]! },
        max: { x: box[3]!, y: box[4]!, z: box[5]! }
      });
      if (
        !extrudeBoundsCanShareVolume(pairBounds(leftBox), pairBounds(rightBox))
      ) {
        continue;
      }
      try {
        total += Math.max(
          0,
          kernel.volume(
            kernel.intersect(leftSolid, rightSolid),
            MEASUREMENT_DEFLECTION
          )
        );
      } catch (error) {
        throw new Error(
          'The exact kernel could not measure extrusion overlap; the stored operation was not changed.',
          { cause: error }
        );
      }
    }
  }
  return total > extrudeVolumeTolerance(leftBody, rightBody) ? total : 0;
}

/**
 * Face unification is allowed to replace the raw Union only when the copied
 * result remains a strict topological solid. The final Union acceptance gate
 * below separately checks its disposable viewport projection.
 */
export function isStrictBooleanSolid(kernel: RemusKernel, solid: number): boolean {
  try {
    return kernel.validateSolid(solid) === 0;
  } catch {
    return false;
  }
}

export function isFaceConnectedSolid(kernel: RemusKernel, solid: number): boolean {
  try {
    return (
      countFaceConnectedComponents(
        kernel.getSolidFaces(solid),
        JSON.parse(kernel.edgeToFaceMap(solid)) as Record<string, number[]>
      ) === 1
    );
  } catch {
    return false;
  }
}
