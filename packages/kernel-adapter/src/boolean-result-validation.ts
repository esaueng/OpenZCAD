import { geometryTolerance } from '@openzcad/geometry';
import type { UnitSystem } from '@openzcad/shared';
import type { UnionBounds } from './union-connectivity';

export interface TriangleMeshClosure {
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentWindingEdges: number;
  triangles: number;
}

interface MeshEdgeUse {
  count: number;
  directionBalance: number;
}

const POSITION_QUANTIZATION_RATIO = 1e-6;
const MIN_POSITION_QUANTIZATION = 1e-9;
const IDENTITY_MATRIX = new Float64Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1
]);

/**
 * Inspect a disposable triangle projection after welding coincident vertices.
 * A solid mesh has two oppositely directed triangle uses for every edge.
 */
export function inspectTriangleMeshClosure(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>
): TriangleMeshClosure {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let maximumMagnitude = 0;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      if (!Number.isFinite(value)) {
        continue;
      }
      minimum[axis] = Math.min(minimum[axis]!, value);
      maximum[axis] = Math.max(maximum[axis]!, value);
      maximumMagnitude = Math.max(maximumMagnitude, Math.abs(value));
    }
  }
  const extent = Math.max(
    ...minimum.map((value, axis) => maximum[axis]! - value),
    0
  );
  // The projection crosses WASM as f32. Weld at one part per million of the
  // body extent, while accounting for f32 precision loss far from the origin.
  const positionQuantization = Math.max(
    MIN_POSITION_QUANTIZATION,
    extent * POSITION_QUANTIZATION_RATIO,
    maximumMagnitude * 2 ** -22
  );
  const quantize = (value: number): number =>
    Math.round(value / positionQuantization);
  const vertexKey = (index: number): string => {
    const offset = index * 3;
    return `${quantize(positions[offset] ?? 0)},${quantize(
      positions[offset + 1] ?? 0
    )},${quantize(positions[offset + 2] ?? 0)}`;
  };

  const edgeUses = new Map<string, MeshEdgeUse>();
  let triangles = 0;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const vertices = [
      vertexKey(indices[index] ?? 0),
      vertexKey(indices[index + 1] ?? 0),
      vertexKey(indices[index + 2] ?? 0)
    ];
    if (new Set(vertices).size !== 3) {
      continue;
    }
    triangles += 1;
    for (const [start, end] of [
      [vertices[0]!, vertices[1]!],
      [vertices[1]!, vertices[2]!],
      [vertices[2]!, vertices[0]!]
    ] as const) {
      const forward = start < end;
      const key = forward ? `${start}|${end}` : `${end}|${start}`;
      const use = edgeUses.get(key) ?? { count: 0, directionBalance: 0 };
      use.count += 1;
      use.directionBalance += forward ? 1 : -1;
      edgeUses.set(key, use);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentWindingEdges = 0;
  for (const use of edgeUses.values()) {
    if (use.count === 1) {
      boundaryEdges += 1;
    } else if (use.count > 2) {
      nonManifoldEdges += 1;
    } else if (Math.abs(use.directionBalance) === 2) {
      inconsistentWindingEdges += 1;
    }
  }
  return {
    boundaryEdges,
    nonManifoldEdges,
    inconsistentWindingEdges,
    triangles
  };
}

export function isClosedConsistentlyOrientedMesh(
  closure: TriangleMeshClosure
): boolean {
  return (
    closure.triangles > 0 &&
    closure.boundaryEdges === 0 &&
    closure.nonManifoldEdges === 0 &&
    closure.inconsistentWindingEdges === 0
  );
}

/**
 * Count face-connected components from a solid's exact edge-to-face adjacency.
 * This is a stronger contact oracle than vertex/face distance for solids that
 * meet across the interiors of coplanar faces, where neither operand has a
 * vertex on the other's boundary.
 */
export function countFaceConnectedComponents(
  faceHandles: ArrayLike<number>,
  edgeToFaces: Readonly<Record<string, readonly number[]>>
): number {
  const faces = [...new Set(Array.from(faceHandles))];
  if (faces.length === 0) {
    return 0;
  }

  const faceSet = new Set(faces);
  const parent = new Map(faces.map((face) => [face, face]));
  const rank = new Map(faces.map((face) => [face, 0]));
  const find = (face: number): number => {
    let root = face;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let current = face;
    while (parent.get(current) !== current) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    if (rank.get(leftRoot)! < rank.get(rightRoot)!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parent.set(rightRoot, leftRoot);
    if (rank.get(leftRoot) === rank.get(rightRoot)) {
      rank.set(leftRoot, rank.get(leftRoot)! + 1);
    }
  };

  for (const adjacentFaces of Object.values(edgeToFaces)) {
    const connectedFaces = adjacentFaces.filter((face) => faceSet.has(face));
    const first = connectedFaces[0];
    if (first === undefined) {
      continue;
    }
    for (let index = 1; index < connectedFaces.length; index += 1) {
      union(first, connectedFaces[index]!);
    }
  }

  return new Set(faces.map((face) => find(face))).size;
}

// ---------------------------------------------------------------------------
// Face-count census.
// ---------------------------------------------------------------------------

/** Faces of a solid, split by whether their surface is analytic or planar. */
export interface FaceCensus {
  faces: number;
  /** Faces whose surface is anything other than a plane. */
  curvedFaces: number;
}

export interface BooleanFaceCensus {
  operands: FaceCensus;
  result: FaceCensus;
}

/**
 * Growth allowed before a boolean result is treated as a faceting fallback.
 *
 * A legitimate boolean splits faces where the operands intersect, which can
 * multiply the face count by a few. A meshed fallback replaces every surface
 * with triangles and lands in the hundreds or thousands. The additive slack
 * keeps small operands (a six-face box cut by a six-face box) clear of the
 * multiplicative bound.
 */
const FACET_FALLBACK_FACTOR = 4;
const FACET_FALLBACK_SLACK = 32;

const FACET_FALLBACK_LEAD = 'The boolean returned a faceted approximation';

/**
 * What to say when no specific remedy has been proved.
 *
 * Naming a single cause here was a mistake worth not repeating: measured on a
 * box and a cylinder, repositioning clears the fallback for a small round
 * operand and clears nothing at all for one wider than the box it meets, so
 * "this is a tangency, move it" is confidently wrong half the time. The caller
 * appends a concrete move only when it has fused that exact move and measured
 * the result exact; this text covers the rest without pretending to a
 * diagnosis, and points at the operation that is known to stay exact on the
 * same operands.
 */
const FACET_FALLBACK_REMEDY =
  'The result is watertight, but its curved surfaces are now planar facets and will ' +
  'export that way. Repositioning the overlap sometimes clears it; otherwise keep the ' +
  'bodies separate, or subtract instead — the same operands still cut exactly.';

export interface FaceCensusSubject {
  getSolidFaces(solid: number): ArrayLike<number>;
  getSurfaceType(face: number): string;
}

export function censusOfSolids(
  kernel: FaceCensusSubject,
  solids: readonly number[]
): FaceCensus {
  let faces = 0;
  let curvedFaces = 0;
  for (const solid of solids) {
    for (const face of Array.from(kernel.getSolidFaces(solid))) {
      faces += 1;
      if (kernel.getSurfaceType(face) !== 'plane') {
        curvedFaces += 1;
      }
    }
  }
  return { faces, curvedFaces };
}

/**
 * The signal that a boolean silently fell back to a faceted result.
 *
 * BrepKit's booleans can abandon exact surface intersection on sliver and
 * near-tangent contacts and return a triangulated, all-planar approximation
 * instead — which is exactly what thin glyph stems and touching letters
 * produce. That result is watertight, valid, has a plausible volume, and its
 * triangle count is unremarkable, so none of the existing checks see it. What
 * changes is the faces: every curved surface becomes planar, and the count
 * explodes.
 *
 * Both conditions are reported because either alone has a false positive.
 * Losing every curved face is normal when the operands had none; a large face
 * count is normal for a genuinely complicated result. Together they are not.
 */
export function booleanFacetFallbackWarning(
  census: BooleanFaceCensus
): string | null {
  const lostCurvature =
    census.operands.curvedFaces > 0 && census.result.curvedFaces === 0;
  const exploded =
    census.result.faces >
    census.operands.faces * FACET_FALLBACK_FACTOR + FACET_FALLBACK_SLACK;
  if (!lostCurvature && !exploded) {
    return null;
  }
  const detail = [
    `${census.operands.faces} operand faces (${census.operands.curvedFaces} curved)`,
    `${census.result.faces} result faces (${census.result.curvedFaces} curved)`
  ].join(' became ');
  if (lostCurvature && exploded) {
    return `${FACET_FALLBACK_LEAD} instead of exact surfaces: ${detail}. ${FACET_FALLBACK_REMEDY}`;
  }
  if (lostCurvature) {
    // Same fallback, caught by the curvature test alone because a smaller
    // round operand facets into too few faces to trip the count test. It
    // earns the same remedy: without one this reads as a property of the
    // result rather than as something the user can act on.
    return `The boolean replaced every curved surface with planar faces: ${detail}. ${FACET_FALLBACK_REMEDY}`;
  }
  return (
    `The boolean produced far more faces than its operands: ${detail}. ` +
    'This is usually a sliver or near-tangent contact being approximated.'
  );
}

export interface UnionOperandBounds {
  name: string;
  bounds: UnionBounds;
  /**
   * Exact AABB sides reached by a non-planar face. Only those sides can move
   * inward when a curved boundary is replaced by an inscribed approximation.
   */
  curvedExtents?: {
    min?: Partial<Record<BoundsAxis, boolean>>;
    max?: Partial<Record<BoundsAxis, boolean>>;
  };
}

export interface UnionExtentValidation {
  operands: readonly UnionOperandBounds[];
  result: UnionBounds;
  units: UnitSystem;
  /** Upper bound for AABB drift when the kernel returns a faceted fallback. */
  approximationTolerance: number;
}

type BoundsAxis = 'x' | 'y' | 'z';

interface MissingUnionExtent {
  operand: UnionOperandBounds;
  axis: BoundsAxis;
  side: 'minimum' | 'maximum';
  resultValue: number;
  operandValue: number;
  missing: number;
}

function formatLength(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 0.001 || magnitude >= 100_000)) {
    return value.toExponential(3);
  }
  return Number(value.toPrecision(7)).toString();
}

/**
 * A union is a superset of every operand, so its exact AABB must contain every
 * operand AABB. M4's tangent cylindrical-boss failure violates that necessary
 * invariant while still returning a valid six-face solid: the result is the
 * plate alone and the boss's axial extent disappears.
 *
 * This deliberately does not predict the union's volume or topology. Valid
 * containment, touching, overlapping, and crossing booleans all satisfy the
 * same superset invariant, and small kernel AABB noise is tolerated at the
 * model's scale.
 */
export function droppedUnionOperandWarning(
  input: UnionExtentValidation
): string | null {
  const coordinateScale = Math.max(
    1,
    ...[
      input.result,
      ...input.operands.map((operand) => operand.bounds)
    ].flatMap((bounds) => [
      Math.abs(bounds.min.x),
      Math.abs(bounds.min.y),
      Math.abs(bounds.min.z),
      Math.abs(bounds.max.x),
      Math.abs(bounds.max.y),
      Math.abs(bounds.max.z)
    ])
  );
  const numericTolerance = geometryTolerance(coordinateScale);
  const approximationTolerance = Number.isFinite(input.approximationTolerance)
    ? Math.max(0, input.approximationTolerance)
    : 0;
  const missing: MissingUnionExtent[] = [];
  for (const operand of input.operands) {
    for (const axis of ['x', 'y', 'z'] as const) {
      const operandSpan = operand.bounds.max[axis] - operand.bounds.min[axis];
      const tightTolerance = Math.max(
        numericTolerance,
        Math.min(approximationTolerance, Math.abs(operandSpan) * 1e-3)
      );
      const minimumMissing = input.result.min[axis] - operand.bounds.min[axis];
      const minimumTolerance = operand.curvedExtents?.min?.[axis]
        ? Math.max(numericTolerance, approximationTolerance)
        : tightTolerance;
      if (minimumMissing > minimumTolerance) {
        missing.push({
          operand,
          axis,
          side: 'minimum',
          resultValue: input.result.min[axis],
          operandValue: operand.bounds.min[axis],
          missing: minimumMissing
        });
      }
      const maximumMissing = operand.bounds.max[axis] - input.result.max[axis];
      const maximumTolerance = operand.curvedExtents?.max?.[axis]
        ? Math.max(numericTolerance, approximationTolerance)
        : tightTolerance;
      if (maximumMissing > maximumTolerance) {
        missing.push({
          operand,
          axis,
          side: 'maximum',
          resultValue: input.result.max[axis],
          operandValue: operand.bounds.max[axis],
          missing: maximumMissing
        });
      }
    }
  }
  const loss = missing.sort((left, right) => right.missing - left.missing)[0];
  if (!loss) {
    return null;
  }
  const units = input.units;
  return (
    `Union dropped geometry from operand "${loss.operand.name}": the result's ${loss.side} ${loss.axis} is ` +
    `${formatLength(loss.resultValue)} ${units}, but the operand reaches ${formatLength(loss.operandValue)} ${units} ` +
    `(${formatLength(loss.missing)} ${units} missing). ` +
    'A cylindrical boss can trigger this kernel failure at exact tangency; move the operand slightly off tangency while keeping positive overlap, then try again.'
  );
}

interface BooleanFaceUnifier {
  copyAndTransformSolid(solid: number, matrix: Float64Array): number;
  unifyFaces(solid: number): number;
}

/**
 * Face healing mutates a solid in place. Run it on a copy and keep the raw
 * boolean whenever healing throws or degrades an otherwise usable result.
 */
export function selectSafelyUnifiedSolid(
  kernel: BooleanFaceUnifier,
  rawSolid: number,
  isAcceptable: (solid: number) => boolean
): number {
  try {
    const candidate = kernel.copyAndTransformSolid(rawSolid, IDENTITY_MATRIX);
    kernel.unifyFaces(candidate);
    if (isAcceptable(candidate)) {
      return candidate;
    }
  } catch {
    // The raw result is still available because healing ran on a copy.
  }
  return rawSolid;
}
