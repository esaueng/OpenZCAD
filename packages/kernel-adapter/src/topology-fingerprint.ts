import { GEOMETRY_LINEAR_TOLERANCE, type Vec3 } from '@openzcad/geometry';

/**
 * Kernel-neutral topology identity (ADR-011).
 *
 * Both exact kernels persist face and edge references as FNV-1a hashes of the
 * signature strings built here, so a hash written under one kernel resolves
 * under the other. Every signature input must therefore be an exact geometric
 * quantity both kernels agree on bit-for-bit after quantization: analytic
 * lengths, vertex positions, curve evaluations — never tessellated
 * measurements, traversal ordinals, or parameterization-phase-dependent
 * samples (kernels seam and phase closed curves differently).
 *
 * The open-edge signature is byte-identical to the scheme BrepKit has always
 * persisted, so existing open-edge references keep their values. Closed edges
 * and faces changed format; the BrepKit adapter keeps resolving their legacy
 * hashes by registering both generations in its lookup maps.
 */

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/** Direction components are quantized 1000× finer than coordinates. */
const AXIS_SCALE = 1000;

export function quantizeCoordinate(value: number): number {
  const quantized = Math.round(value / GEOMETRY_LINEAR_TOLERANCE);
  return Object.is(quantized, -0) ? 0 : quantized;
}

export function fingerprintOfSignature(signature: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  const unsigned = hash >>> 0;
  return unsigned === 0 ? 1 : unsigned;
}

function quantizedDirectionComponents(
  direction: Vec3
): [number, number, number] {
  return [
    quantizeCoordinate(direction.x * AXIS_SCALE),
    quantizeCoordinate(direction.y * AXIS_SCALE),
    quantizeCoordinate(direction.z * AXIS_SCALE)
  ];
}

function shouldFlipDirection(direction: Vec3): boolean {
  for (const component of quantizedDirectionComponents(direction)) {
    if (component < 0) {
      return true;
    }
    if (component > 0) {
      return false;
    }
  }
  return false;
}

export function canonicalizeDirection(direction: Vec3): {
  direction: Vec3;
  flipped: boolean;
} {
  const flipped = shouldFlipDirection(direction);
  return {
    direction: flipped
      ? { x: -direction.x, y: -direction.y, z: -direction.z }
      : direction,
    flipped
  };
}

/**
 * A direction's sign is not stable across rebuilds or kernels; pick the
 * lexicographically positive representative.
 */
export function canonicalDirection(direction: Vec3): Vec3 {
  return canonicalizeDirection(direction).direction;
}

function quantizedPoint(point: Vec3): string {
  return `${quantizeCoordinate(point.x)},${quantizeCoordinate(point.y)},${quantizeCoordinate(point.z)}`;
}

function quantizedDirection(direction: Vec3): string {
  return quantizedDirectionComponents(direction).join(',');
}

export interface OpenEdgeSample {
  closed: false;
  /** BrepKit's curve-type vocabulary: LINE, CIRCLE, ELLIPSE, BSPLINE_CURVE. */
  curveType: string;
  length: number;
  endpoints: [Vec3, Vec3];
  midpoint: Vec3;
}

export interface ClosedEdgeSample {
  closed: true;
  curveType: string;
  length: number;
  /**
   * Mean of four samples equally spaced across the parameter domain — for a
   * full circle or ellipse this is exactly the curve's centre, independent of
   * where each kernel seams the curve or which phase its parameterization
   * starts at.
   */
  center: Vec3;
  /** Curve plane normal, already canonicalized; null when degenerate. */
  axis: Vec3 | null;
}

export type EdgeSample = OpenEdgeSample | ClosedEdgeSample;

export function edgeSignatureOf(sample: EdgeSample): string {
  if (sample.closed) {
    return [
      sample.curveType,
      quantizeCoordinate(sample.length),
      'C',
      quantizedPoint(sample.center),
      sample.axis ? quantizedDirection(sample.axis) : 'na'
    ].join(':');
  }
  const endpoints = [sample.endpoints[0], sample.endpoints[1]]
    .map((point) => [point.x, point.y, point.z])
    .sort((a, b) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    });
  return [
    sample.curveType,
    quantizeCoordinate(sample.length),
    ...endpoints.flat().map(quantizeCoordinate),
    quantizeCoordinate(sample.midpoint.x),
    quantizeCoordinate(sample.midpoint.y),
    quantizeCoordinate(sample.midpoint.z)
  ].join(':');
}

export function edgeFingerprintOf(sample: EdgeSample): number {
  return fingerprintOfSignature(edgeSignatureOf(sample));
}

/** Endpoint coincidence after quantization decides closedness identically on both kernels. */
export function isClosedEdge(start: Vec3, end: Vec3): boolean {
  return (
    quantizeCoordinate(start.x) === quantizeCoordinate(end.x) &&
    quantizeCoordinate(start.y) === quantizeCoordinate(end.y) &&
    quantizeCoordinate(start.z) === quantizeCoordinate(end.z)
  );
}

export interface FaceSample {
  /** Shared lowercase vocabulary: plane, cylinder, cone, sphere, torus, bspline. */
  surfaceType: string;
  /** Sum of unique boundary edge lengths — exact on both kernels. */
  perimeter: number;
  /** Analytic surface signature; empty for types without a shared reading. */
  analytic: string;
  /** Mean of unique boundary vertex positions; null for vertex-free faces. */
  centroid: Vec3 | null;
}

export function faceSignatureOf(sample: FaceSample): string {
  return [
    sample.surfaceType,
    'P',
    quantizeCoordinate(sample.perimeter),
    sample.analytic,
    sample.centroid ? quantizedPoint(sample.centroid) : 'nc'
  ].join(':');
}

export function faceFingerprintOf(sample: FaceSample): number {
  return fingerprintOfSignature(faceSignatureOf(sample));
}

/** Plane as canonical (normal, signed offset); sign-flips cancel jointly. */
export function planeAnalyticSignature(
  unitNormal: Vec3,
  offset: number
): string {
  const { direction: normal, flipped } = canonicalizeDirection(unitNormal);
  return `pl${quantizedDirection(normal)};d${quantizeCoordinate(flipped ? -offset : offset)}`;
}

/**
 * Cylinder as canonical axis + axis foot + radius. The foot (the axis point
 * nearest the origin) is stable even when the parametric origin slides along
 * the axis between rebuilds or kernels.
 */
export function cylinderAnalyticSignature(
  axisPoint: Vec3,
  unitAxis: Vec3,
  radius: number
): string {
  const axis = canonicalDirection(unitAxis);
  const along =
    axisPoint.x * axis.x + axisPoint.y * axis.y + axisPoint.z * axis.z;
  const foot = {
    x: axisPoint.x - along * axis.x,
    y: axisPoint.y - along * axis.y,
    z: axisPoint.z - along * axis.z
  };
  return `cy${quantizedDirection(axis)};ft${quantizedPoint(foot)};r${quantizeCoordinate(radius)}`;
}

/**
 * Fail-closed diagnostics for unresolved references. Hashes in [1, count]
 * are almost certainly 1-based traversal ordinals persisted by the pre-ADR-011
 * OpenCascade adapter; interpreting them positionally is exactly the silent
 * wrong-geometry failure this contract exists to prevent.
 */
export function unresolvedReferenceError(
  kind: 'edge' | 'face',
  hash: number,
  candidateCount: number
): Error {
  if (Number.isInteger(hash) && hash >= 1 && hash <= candidateCount) {
    return new Error(
      `A selected ${kind} was saved by an older version of OpenZCAD that ` +
        `recorded positions instead of geometry. Re-select the ${kind}` +
        `${kind === 'edge' ? 's' : '(s)'} and re-create this feature.`
    );
  }
  // This feature was saved without stable references, so no parameter value
  // can bring the orphaned hash back — say what actually repairs it.
  return new Error(
    `A selected ${kind} no longer exists. Re-select the ${kind}${kind === 'edge' ? 's' : '(s)'} and re-create this feature.`
  );
}

export function ambiguousReferenceError(kind: 'edge' | 'face'): Error {
  return new Error(`A selected ${kind} is geometrically ambiguous.`);
}
