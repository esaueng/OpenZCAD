/**
 * ADR-011 identity sampling over live Remus handles: edge/face fingerprints,
 * kernel-neutral witnesses, and fingerprint-indexed handle lookup. These are
 * the read-only bridge between kernel handles and the persisted topology
 * identity contracts in `topology-fingerprint`.
 */
import type { RemusKernel } from './remus-runtime';
import type { Vec3 } from '@openzcad/geometry';
import type {
  EdgeWitnessV1,
  FaceWitnessV1,
  QuantizedTopologyPoint
} from '@openzcad/shared';
import {
  canonicalizeDirection,
  cylinderAnalyticSignature,
  edgeFingerprintOf,
  faceFingerprintOf,
  isClosedEdge,
  planeAnalyticSignature,
  quantizeCoordinate,
  type EdgeSample
} from './topology-fingerprint';
import { faceVertexCentroid } from './exact-brep';
import {
  cross,
  dot,
  finiteVec3,
  normalized,
  pointAt,
  quantizeEdgeCoordinate,
  scale,
  subtract
} from './exact-math';
import { canonicalDirection } from './topology-fingerprint';
import { topologyHashOfWitness } from './topology-lineage';

/** Chord tolerance for identity sampling; mirrors the display default. */
export const MEASUREMENT_DEFLECTION = 0.08;

/** Sample the ADR-011 edge identity quantities from a Remus edge. */
export function edgeSampleOf(kernel: RemusKernel, edge: number): EdgeSample {
  const vertices = Array.from(kernel.getEdgeVertices(edge));
  const start = pointAt(vertices, 0);
  const end = pointAt(vertices, 3);
  const curveType = kernel.getEdgeCurveType(edge);
  const length = kernel.edgeLength(edge);
  const domain = Array.from(kernel.getEdgeCurveParameters(edge));
  const first = domain[0] ?? 0;
  const span = (domain[1] ?? 1) - first;
  if (!isClosedEdge(start, end)) {
    return {
      closed: false,
      curveType,
      length,
      endpoints: [start, end],
      midpoint: pointAt(
        Array.from(kernel.evaluateEdgeCurve(edge, first + span / 2)),
        0
      )
    };
  }
  const center = { x: 0, y: 0, z: 0 };
  for (let sample = 0; sample < 4; sample += 1) {
    const point = Array.from(
      kernel.evaluateEdgeCurve(edge, first + (span * sample) / 4)
    );
    center.x += (point[0] ?? 0) / 4;
    center.y += (point[1] ?? 0) / 4;
    center.z += (point[2] ?? 0) / 4;
  }
  const tangentA = pointAt(
    Array.from(kernel.evaluateEdgeCurveD1(edge, first)),
    3
  );
  const tangentB = pointAt(
    Array.from(kernel.evaluateEdgeCurveD1(edge, first + span / 4)),
    3
  );
  const axis = normalized(cross(tangentA, tangentB));
  return {
    closed: true,
    curveType,
    length,
    center,
    axis: axis ? canonicalDirection(axis) : null
  };
}

export function edgeFingerprint(kernel: RemusKernel, edge: number): number {
  return edgeFingerprintOf(edgeSampleOf(kernel, edge));
}

/**
 * The pre-ADR-011 Remus scheme: closed curves hashed their seam vertex and
 * mid-parameter point, both of which depend on Remus's parameterization
 * phase. Persisted documents still hold these values, so resolution maps
 * register them alongside the kernel-neutral fingerprint. (For open edges the
 * two schemes produce identical signatures.)
 */
export function legacyEdgeFingerprint(kernel: RemusKernel, edge: number): number {
  const vertices = Array.from(kernel.getEdgeVertices(edge));
  const endpoints = [vertices.slice(0, 3), vertices.slice(3, 6)].sort(
    (a, b) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    }
  );
  const domain = Array.from(kernel.getEdgeCurveParameters(edge));
  const midpoint = Array.from(
    kernel.evaluateEdgeCurve(edge, ((domain[0] ?? 0) + (domain[1] ?? 1)) / 2)
  );
  const signature = [
    kernel.getEdgeCurveType(edge),
    quantizeEdgeCoordinate(kernel.edgeLength(edge)),
    ...endpoints.flat().map(quantizeEdgeCoordinate),
    ...midpoint.map(quantizeEdgeCoordinate)
  ].join(':');
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned === 0 ? 1 : unsigned;
}

export function registerHandle(
  map: Map<number, number[]>,
  hash: number,
  handle: number
): void {
  const handles = map.get(hash) ?? [];
  handles.push(handle);
  map.set(hash, handles);
}

export function edgeHandlesByFingerprint(
  kernel: RemusKernel,
  solid: number
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const edge of kernel.getSolidEdges(solid)) {
    // Three schemes, registered together because a persisted selection may
    // hold any of them. The witness hash is the one `BodyTopology` publishes
    // and therefore the one a user's selection actually stores; registering
    // it is not redundant with the fingerprint, because the two order an open
    // edge's endpoints by different keys — `edgeSignatureOf` sorts the raw
    // coordinates and `edgeWitnessOf` sorts the quantized ones. They agree
    // until two endpoints tie after quantization on the leading axis, which
    // is exactly what a partial revolve produces: its cut-plane edges sit at
    // a numerical zero of ~1e-16, so 2 of a 90 degree wedge's 12 edges hashed
    // one way when published and another way when resolved, and were
    // unselectable for every downstream feature.
    for (const hash of new Set([
      edgeFingerprint(kernel, edge),
      legacyEdgeFingerprint(kernel, edge),
      topologyHashOfWitness('edge', edgeWitnessOf(kernel, edge))
    ])) {
      registerHandle(result, hash, edge);
    }
  }
  return result;
}

export function analyticParamsSignature(kernel: RemusKernel, face: number): string {
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    return '';
  }
  if (!parameters || typeof parameters !== 'object') {
    return '';
  }
  const record = parameters as Record<string, unknown>;
  const parts: string[] = [];
  const origin = finiteVec3(record.origin);
  const axis = finiteVec3(record.axis);
  if (axis) {
    const unit = normalized(axis);
    if (unit) {
      // Canonical sign: a surface's axis may flip between rebuilds.
      const canonical = canonicalDirection(unit);
      parts.push(
        `ax${quantizeEdgeCoordinate(canonical.x * 1000)}` +
          `,${quantizeEdgeCoordinate(canonical.y * 1000)}` +
          `,${quantizeEdgeCoordinate(canonical.z * 1000)}`
      );
      if (origin) {
        // The axis foot (origin projected onto the axis-orthogonal plane
        // through zero) is stable even when the parametric origin slides
        // along the axis between rebuilds.
        const along =
          origin.x * canonical.x +
          origin.y * canonical.y +
          origin.z * canonical.z;
        parts.push(
          `ft${quantizeEdgeCoordinate(origin.x - along * canonical.x)}` +
            `,${quantizeEdgeCoordinate(origin.y - along * canonical.y)}` +
            `,${quantizeEdgeCoordinate(origin.z - along * canonical.z)}`
        );
      }
    }
  }
  for (const key of ['radius', 'majorRadius', 'minorRadius', 'semiAngle']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${key[0]}${quantizeEdgeCoordinate(value)}`);
    }
  }
  return parts.join(':');
}

/**
 * Geometric fingerprint of a face (ADR-011): surface class, quantized
 * boundary perimeter, canonical analytic parameters for planes and cylinders,
 * and the boundary vertex centroid — all exact quantities both kernels agree
 * on, unlike the tessellated area the previous scheme used. Stable across
 * identical rebuilds; any real geometry change moves it, so face-referencing
 * features fail closed instead of editing the wrong face (the same contract
 * ADR-008/ADR-010 establish for edges).
 */
export function faceFingerprint(kernel: RemusKernel, face: number): number {
  const surfaceType = kernel.getSurfaceType(face);
  let perimeter = 0;
  for (const edge of kernel.getFaceEdges(face)) {
    perimeter += kernel.edgeLength(edge);
  }
  let analytic = '';
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    parameters = null;
  }
  const record = (parameters ?? {}) as Record<string, unknown>;
  if (surfaceType === 'plane') {
    const rawNormal = finiteVec3(record.normal);
    const normal = rawNormal ? normalized(rawNormal) : null;
    const offset = record.d;
    if (normal && typeof offset === 'number' && Number.isFinite(offset)) {
      analytic = planeAnalyticSignature(normal, offset);
    }
  } else if (surfaceType === 'cylinder') {
    const origin = finiteVec3(record.origin);
    const rawAxis = finiteVec3(record.axis);
    const axis = rawAxis ? normalized(rawAxis) : null;
    const radius = record.radius;
    if (
      origin &&
      axis &&
      typeof radius === 'number' &&
      Number.isFinite(radius)
    ) {
      analytic = cylinderAnalyticSignature(origin, axis, radius);
    }
  }
  return faceFingerprintOf({
    surfaceType,
    perimeter,
    analytic,
    centroid: faceVertexCentroid(kernel, face)
  });
}

export function quantizedPoint(point: Vec3): QuantizedTopologyPoint {
  return [
    quantizeCoordinate(point.x),
    quantizeCoordinate(point.y),
    quantizeCoordinate(point.z)
  ];
}

export function quantizedDirectionOf(direction: Vec3): QuantizedTopologyPoint | null {
  const unit = normalized(direction);
  if (!unit) {
    return null;
  }
  const canonical = canonicalDirection(unit);
  return [
    quantizeCoordinate(canonical.x * 1000),
    quantizeCoordinate(canonical.y * 1000),
    quantizeCoordinate(canonical.z * 1000)
  ];
}

export function edgeWitnessOf(kernel: RemusKernel, edge: number): EdgeWitnessV1 {
  const sample = edgeSampleOf(kernel, edge);
  if (sample.closed) {
    return {
      curveType: sample.curveType,
      length: quantizeCoordinate(sample.length),
      closed: true,
      center: quantizedPoint(sample.center),
      axis: sample.axis ? quantizedDirectionOf(sample.axis) : null
    };
  }
  const endpoints = sample.endpoints.map(quantizedPoint).sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = left[index]! - right[index]!;
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  }) as [QuantizedTopologyPoint, QuantizedTopologyPoint];
  return {
    curveType: sample.curveType,
    length: quantizeCoordinate(sample.length),
    closed: false,
    endpoints,
    midpoint: quantizedPoint(sample.midpoint)
  };
}

export function remusFaceClosure(
  kernel: RemusKernel,
  face: number,
  surfaceType: string
): FaceWitnessV1['closure'] {
  switch (surfaceType) {
    case 'plane':
      return { u: 'open', v: 'open' };
    case 'cylinder':
    case 'cone':
    case 'sphere':
      return { u: 'closed', v: 'open' };
    case 'torus':
      return { u: 'closed', v: 'closed' };
    case 'bspline':
    case 'nurbs': {
      try {
        const decoded: unknown = JSON.parse(
          kernel.getNurbsSurfaceDataParity(face)
        );
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
          return { u: 'unknown', v: 'unknown' };
        }
        const record = decoded as Record<string, unknown>;
        return {
          u:
            typeof record.isPeriodicU === 'boolean'
              ? record.isPeriodicU
                ? 'closed'
                : 'open'
              : 'unknown',
          v:
            typeof record.isPeriodicV === 'boolean'
              ? record.isPeriodicV
                ? 'closed'
                : 'open'
              : 'unknown'
        };
      } catch {
        return { u: 'unknown', v: 'unknown' };
      }
    }
    default:
      return { u: 'unknown', v: 'unknown' };
  }
}

export function faceWitnessOf(kernel: RemusKernel, face: number): FaceWitnessV1 {
  const surfaceType = kernel.getSurfaceType(face);
  let perimeter = 0;
  for (const edge of kernel.getFaceEdges(face)) {
    perimeter += kernel.edgeLength(edge);
  }
  let analytic: FaceWitnessV1['analytic'] = { kind: 'none' };
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    parameters = null;
  }
  const record = (parameters ?? {}) as Record<string, unknown>;
  if (surfaceType === 'plane') {
    const rawNormal = finiteVec3(record.normal);
    const unit = rawNormal ? normalized(rawNormal) : null;
    const rawOffset = record.d;
    if (unit && typeof rawOffset === 'number' && Number.isFinite(rawOffset)) {
      const { direction: normal, flipped } = canonicalizeDirection(unit);
      analytic = {
        kind: 'plane',
        normal: quantizedDirectionOf(normal)!,
        offset: quantizeCoordinate(flipped ? -rawOffset : rawOffset)
      };
    }
  } else if (surfaceType === 'cylinder') {
    const origin = finiteVec3(record.origin);
    const rawAxis = finiteVec3(record.axis);
    const unit = rawAxis ? normalized(rawAxis) : null;
    const radius = record.radius;
    if (
      origin &&
      unit &&
      typeof radius === 'number' &&
      Number.isFinite(radius)
    ) {
      const axis = canonicalDirection(unit);
      const along = dot(origin, axis);
      analytic = {
        kind: 'cylinder',
        axis: quantizedDirectionOf(axis)!,
        axisFoot: quantizedPoint(subtract(origin, scale(axis, along))),
        radius: quantizeCoordinate(radius)
      };
    }
  }
  const centroid = faceVertexCentroid(kernel, face);
  return {
    surfaceType,
    perimeter: quantizeCoordinate(perimeter),
    centroid: centroid ? quantizedPoint(centroid) : null,
    analytic,
    closure: remusFaceClosure(kernel, face, surfaceType)
  };
}

/** The pre-ADR-011 Remus face scheme, kept only for persisted references. */
export function legacyFaceFingerprint(kernel: RemusKernel, face: number): number {
  const centroid = faceVertexCentroid(kernel, face);
  const signature = [
    kernel.getSurfaceType(face),
    quantizeEdgeCoordinate(
      Math.sqrt(Math.max(kernel.faceArea(face, MEASUREMENT_DEFLECTION), 0))
    ),
    analyticParamsSignature(kernel, face),
    centroid
      ? [centroid.x, centroid.y, centroid.z]
          .map(quantizeEdgeCoordinate)
          .join(',')
      : 'nc'
  ].join(':');
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned === 0 ? 1 : unsigned;
}

export function faceHandlesByFingerprint(
  kernel: RemusKernel,
  solid: number
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const face of kernel.getSolidFaces(solid)) {
    const hash = faceFingerprint(kernel, face);
    registerHandle(result, hash, face);
    const legacy = legacyFaceFingerprint(kernel, face);
    if (legacy !== hash) {
      registerHandle(result, legacy, face);
    }
  }
  return result;
}
