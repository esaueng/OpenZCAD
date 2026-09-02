/**
 * Face and body measurement over live kernel handles: area provenance,
 * face-geometry summaries for selection labels, and the through-hole
 * classification that gates validated direct edits. Read-only over the
 * kernel; the write half (resize/fill) stays with the adapter's direct-edit
 * methods.
 */
import type { RemusKernel } from './remus-runtime';
import type { Vec3 } from '@openzcad/geometry';
import type { FaceAreaProvenance, FaceGeometry } from '@openzcad/shared';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { faceVertexCentroid, isBlendFace } from './exact-brep';
import { planarFaceCentroid } from './exact-face-centroid';
import {
  DIRECT_EDIT_TOLERANCE,
  FULL_REVOLUTION,
  GEOMETRY_EPSILON,
  add,
  cross,
  finiteVec3,
  length,
  normalized,
  positiveFinite,
  scale,
  subtract
} from './exact-math';

/** Best-effort analytic measurements surfaced to the UI as FaceGeometry. */
/**
 * Analytic surface classes whose area comes back as a closed form.
 *
 * Measured against closed forms on the pinned build rather than assumed from
 * the presence of a deflection parameter: cylinder, sphere, cone and torus all
 * return at machine precision (rel ~1e-16). Anything not listed here is left
 * unclassified rather than guessed at, because a surface class this build has
 * not been measured on must not be advertised as exact.
 */
export const CLOSED_FORM_SURFACES = new Set([
  'cylinder',
  'sphere',
  'cone',
  'torus'
]);

/**
 * Planar boundary curves the kernel integrates exactly (Green's theorem over
 * the boundary, inner wires included). Ellipse, hyperbola and NURBS
 * boundaries keep the fixed 256-sample polygon fallback that no deflection
 * improves, so they stay 'sampled'.
 */
const EXACT_PLANAR_BOUNDARIES = new Set(['LINE', 'CIRCLE', 'PARABOLA']);

/**
 * Whether the face's area is exact.
 *
 * For a plane the answer is decided by its boundary: lines, circles and
 * parabolas integrate exactly, convex or not, while anything else is
 * inscribed with a fixed 256-point polygon. The check therefore stops at the
 * first boundary curve outside the exact set, and only planes pay for it at
 * all.
 */
export function measureAreaProvenance(
  kernel: RemusKernel,
  face: number,
  surfaceType: string
): FaceAreaProvenance | undefined {
  if (CLOSED_FORM_SURFACES.has(surfaceType)) {
    return 'exact';
  }
  if (surfaceType !== 'plane') {
    return undefined;
  }
  try {
    for (const edge of kernel.getFaceEdges(face)) {
      // getEdgeCurveType reports the analytic curve a NURBS edge represents,
      // but the kernel's exact integrator only runs on concrete curves, so
      // the storage has to agree before the area is called exact.
      if (
        !EXACT_PLANAR_BOUNDARIES.has(kernel.getEdgeCurveType(edge)) ||
        kernel.getEdgeNurbsData(edge) !== null
      ) {
        return 'sampled';
      }
    }
  } catch {
    // A face whose boundary cannot be walked is not one to make claims about.
    return undefined;
  }
  return 'exact';
}

export function measureFaceGeometry(
  kernel: RemusKernel,
  face: number
): FaceGeometry | undefined {
  const surfaceType = kernel.getSurfaceType(face);
  const centroid = faceVertexCentroid(kernel, face);
  const areaProvenance = measureAreaProvenance(kernel, face, surfaceType);
  const geometry: FaceGeometry = {
    surfaceType,
    area: kernel.faceArea(face, MEASUREMENT_DEFLECTION),
    ...(areaProvenance ? { areaProvenance } : {}),
    center: centroid ?? { x: 0, y: 0, z: 0 }
  };
  if (surfaceType === 'plane') {
    try {
      const normal = kernel.getFaceNormal(face);
      geometry.normal = {
        x: normal[0]!,
        y: normal[1]!,
        z: normal[2]!
      };
      // The plane's own equation, n·x = d, completed here because it is
      // arithmetic on two values already in hand rather than a kernel call.
      // `center` is the mean of the face's vertices and every one of them lies
      // on the plane, so any affine combination of them does too — which makes
      // this exact, and makes an exact point-to-plane distance computable
      // without a kernel round trip.
      geometry.planeOffset =
        geometry.normal.x * geometry.center.x +
        geometry.normal.y * geometry.center.y +
        geometry.normal.z * geometry.center.z;
      // Last, and never inside anything the fields above depend on: the
      // centroid is one optional measurement, and it must not be able to cost
      // this face its normal or its plane equation.
      const measured = planarFaceCentroid(kernel, face, geometry.normal);
      if (measured) {
        geometry.centroid = measured.centroid;
      }
    } catch {
      // NURBS-backed planes have no analytic normal; leave both unset. These
      // are exactly the imported-STEP faces a raw pick tends to land on, so
      // the absence is load-bearing rather than incidental.
    }
    return geometry;
  }
  if (
    surfaceType !== 'cylinder' &&
    surfaceType !== 'sphere' &&
    surfaceType !== 'torus' &&
    surfaceType !== 'cone'
  ) {
    return geometry;
  }
  let parameters: unknown;
  try {
    parameters = JSON.parse(kernel.getAnalyticSurfaceParams(face));
  } catch {
    return geometry;
  }
  const record = (parameters ?? {}) as Record<string, unknown>;
  if (surfaceType === 'torus') {
    const center = finiteVec3(record.center);
    const rawAxis = finiteVec3(record.axis);
    const axis = rawAxis ? normalized(rawAxis) : null;
    const majorRadius = positiveFinite(
      record.majorRadius ?? record.major_radius
    );
    const minorRadius = positiveFinite(
      record.minorRadius ?? record.minor_radius
    );
    if (center && majorRadius !== null && minorRadius !== null) {
      geometry.torusCenter = center;
      geometry.majorRadius = majorRadius;
      geometry.minorRadius = minorRadius;
      if (axis) {
        geometry.axis = axis;
      }
    }
    return geometry;
  }
  if (surfaceType === 'cone') {
    const apex = finiteVec3(record.apex);
    const rawAxis = finiteVec3(record.axis);
    const axis = rawAxis ? normalized(rawAxis) : null;
    const halfAngle = positiveFinite(
      record.halfAngle ?? record.half_angle ?? record.semiAngle
    );
    if (apex && axis && halfAngle !== null && halfAngle < Math.PI / 2) {
      geometry.apex = apex;
      geometry.axis = axis;
      geometry.halfAngle = halfAngle;
    }
    return geometry;
  }
  const radius = positiveFinite(record.radius);
  if (surfaceType === 'sphere') {
    // The corner patch a vertex blend leaves behind is a sphere of the blend
    // radius. It has no axis, so the radius is all that carries over.
    if (radius !== null) {
      geometry.radius = radius;
      geometry.diameter = radius * 2;
    }
    return geometry;
  }
  const origin = finiteVec3(record.origin);
  const rawAxis = finiteVec3(record.axis);
  const axis = rawAxis ? normalized(rawAxis) : null;
  if (!origin || !axis || radius === null) {
    return geometry;
  }
  geometry.radius = radius;
  geometry.diameter = radius * 2;
  const domain = Array.from(kernel.getSurfaceDomain(face));
  if (domain.length === 4 && domain.every(Number.isFinite)) {
    const axialMin = Math.min(domain[2]!, domain[3]!);
    const axialMax = Math.max(domain[2]!, domain[3]!);
    geometry.axisStart = {
      x: origin.x + axis.x * axialMin,
      y: origin.y + axis.y * axialMin,
      z: origin.z + axis.z * axialMin
    };
    geometry.axisEnd = {
      x: origin.x + axis.x * axialMax,
      y: origin.y + axis.y * axialMax,
      z: origin.z + axis.z * axialMax
    };
    geometry.axialLength = axialMax - axialMin;
  }
  return geometry;
}

/** A cylindrical face the kernel has proven to be an open internal bore. */
export interface ThroughHoleGeometry extends FaceGeometry {
  radius: number;
  diameter: number;
  axisStart: Vec3;
  axisEnd: Vec3;
  axialLength: number;
  featureType: 'through-hole';
  editableDimension: 'diameter';
}

export type ThroughHoleClassification =
  { status: 'through-hole' } | { status: 'refused'; message: string };

/** Point-in-solid classification, treating any kernel failure as unknown. */
export function classifySolidPoint(
  kernel: RemusKernel,
  solid: number,
  point: Vec3
): 'inside' | 'outside' | 'boundary' | 'unknown' {
  let classification: string;
  try {
    classification = kernel.classifyPoint(
      solid,
      point.x,
      point.y,
      point.z,
      DIRECT_EDIT_TOLERANCE
    );
  } catch {
    return 'unknown';
  }
  return classification === 'inside' ||
    classification === 'outside' ||
    classification === 'boundary'
    ? classification
    : 'unknown';
}

/**
 * Decide whether a cylindrical face is a through-hole: an internal bore that
 * opens at both ends, as opposed to a blind pocket or an external wall.
 *
 * OpenCascade answers the bore/wall half of that question from the face's
 * orientation flag — a hollow tube's outer wall and its bore share the same
 * void axis and the same two open ends, and only the orientation separates
 * them. Remus has no such flag (`getShapeOrientation` documents that every
 * face reports `forward`, and a cylinder's parametric normal points away from
 * the axis whether it walls a bore or a boss), so the same distinction is
 * taken from the material itself: just outside a bore's wall is solid, just
 * outside an outer wall is air. Everything else — full revolution, void
 * along the axis, both ends open — mirrors the OpenCascade classifier.
 *
 * A case that cannot be settled is refused by name rather than guessed at.
 */
export function classifyThroughHoleFace(
  kernel: RemusKernel,
  solid: number,
  face: number,
  geometry: FaceGeometry | undefined
): ThroughHoleClassification {
  if (!geometry) {
    return refuseThroughHole('The selected face could not be measured.');
  }
  if (geometry.surfaceType !== 'cylinder') {
    return refuseThroughHole(
      `The selected face is a ${geometry.surfaceType} surface, not a cylindrical through-hole.`
    );
  }
  if (
    geometry.radius === undefined ||
    geometry.diameter === undefined ||
    !geometry.axisStart ||
    !geometry.axisEnd ||
    geometry.axialLength === undefined
  ) {
    return refuseThroughHole(
      'The selected cylindrical face has no analytic axis, so it cannot be measured as a through-hole.'
    );
  }
  const domain = Array.from(kernel.getSurfaceDomain(face));
  if (
    domain.length !== 4 ||
    !domain.every(Number.isFinite) ||
    Math.abs(Math.abs(domain[1]! - domain[0]!) - FULL_REVOLUTION) > 1e-5
  ) {
    return refuseThroughHole(
      'The selected face covers only part of its cylinder, so it is not a complete through-hole bore.'
    );
  }
  const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart));
  if (!axis || geometry.axialLength <= GEOMETRY_EPSILON) {
    return refuseThroughHole(
      'The selected cylindrical face has a degenerate axis.'
    );
  }

  // The same probe distance OpenCascade uses to step off each end of the bore.
  const axialProbe = Math.max(
    DIRECT_EDIT_TOLERANCE * 10,
    geometry.radius * 0.02,
    geometry.axialLength * 0.01
  );
  const center = scale(add(geometry.axisStart, geometry.axisEnd), 0.5);
  if (classifySolidPoint(kernel, solid, center) !== 'outside') {
    return refuseThroughHole(
      'The selected cylindrical face encloses material along its axis, so it is a boss rather than a hole.'
    );
  }
  if (
    classifySolidPoint(
      kernel,
      solid,
      subtract(geometry.axisStart, scale(axis, axialProbe))
    ) !== 'outside' ||
    classifySolidPoint(
      kernel,
      solid,
      add(geometry.axisEnd, scale(axis, axialProbe))
    ) !== 'outside'
  ) {
    return refuseThroughHole(
      'The selected cylindrical face does not open at both ends, so it is a blind pocket rather than a through-hole.'
    );
  }

  // Radial probe: far enough off the wall for the kernel to resolve which side
  // of it the point sits on, and small enough that any real wall still
  // contains it. Sampling four bearings rather than one keeps a single
  // intersecting feature from deciding the answer on its own.
  const radialProbe = Math.max(
    DIRECT_EDIT_TOLERANCE * 100,
    geometry.radius * 1e-3
  );
  const reference =
    Math.abs(axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const bearingU = normalized(cross(reference, axis));
  if (!bearingU) {
    return refuseThroughHole(
      'The selected cylindrical face has no measurable radial direction.'
    );
  }
  const bearingV = cross(axis, bearingU);
  const outsideWall = [0, 0.25, 0.5, 0.75].map((turn) => {
    const angle = turn * FULL_REVOLUTION;
    const offset = geometry.radius! + radialProbe;
    return classifySolidPoint(
      kernel,
      solid,
      add(
        center,
        add(
          scale(bearingU, Math.cos(angle) * offset),
          scale(bearingV, Math.sin(angle) * offset)
        )
      )
    );
  });
  if (outsideWall.every((classification) => classification === 'inside')) {
    return { status: 'through-hole' };
  }
  if (outsideWall.every((classification) => classification === 'outside')) {
    return refuseThroughHole(
      'The selected cylindrical face has material only on its inside, so it is an external wall rather than a bore.'
    );
  }
  return refuseThroughHole(
    'The selected cylindrical face is not surrounded by material around its whole circumference, so it cannot be classified as a through-hole.'
  );
}

/** Face measurements plus the editable feature semantics the UI offers. */
export function measureOwnedFaceGeometry(
  kernel: RemusKernel,
  solid: number,
  face: number
): FaceGeometry | undefined {
  const geometry = measureFaceGeometry(kernel, face);
  if (!geometry) {
    return undefined;
  }
  if (isBlendFace(kernel, solid, face)) {
    geometry.featureType = 'blend';
    const blendRadius =
      geometry.surfaceType === 'torus'
        ? geometry.minorRadius
        : geometry.surfaceType === 'cylinder'
          ? geometry.radius
          : undefined;
    if (blendRadius !== undefined) {
      geometry.blendRadius = blendRadius;
      const region = measureBlendRegion(kernel, solid, face);
      if (
        region &&
        Math.abs(region.radius - blendRadius) <=
          Math.max(blendRadius * 1e-5, 1e-9)
      ) {
        geometry.editableDimension = 'blendRadius';
        geometry.blendRegionKey = region.key;
        geometry.blendRegionFaceCount = region.faces.length;
      }
    }
  } else if (
    geometry.surfaceType === 'cylinder' &&
    classifyThroughHoleFace(kernel, solid, face, geometry).status ===
      'through-hole'
  ) {
    geometry.featureType = 'through-hole';
    geometry.editableDimension = 'diameter';
  }
  return geometry;
}

export interface BlendCarrierSnapshot {
  surfaceClass: 'torus' | 'cylinder';
  radius: number;
  center: Vec3;
  axis: Vec3;
}

export interface BlendRegionMeasurement {
  faces: number[];
  radius: number;
  key: string;
}

/** Read one exact kernel grouping proof without trusting JS-side adjacency. */
export function measureBlendRegion(
  kernel: RemusKernel,
  solid: number,
  face: number
): BlendRegionMeasurement | null {
  try {
    const value: unknown = JSON.parse(kernel.getBlendRegion(solid, face));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const candidate = value as { faces?: unknown; radius?: unknown };
    if (
      !Array.isArray(candidate.faces) ||
      candidate.faces.length === 0 ||
      typeof candidate.radius !== 'number' ||
      !Number.isFinite(candidate.radius) ||
      candidate.radius <= 0
    ) {
      return null;
    }
    const faces = candidate.faces.filter(
      (handle): handle is number =>
        typeof handle === 'number' &&
        Number.isSafeInteger(handle) &&
        handle >= 0 &&
        handle <= 0xffff_ffff
    );
    if (
      faces.length !== candidate.faces.length ||
      new Set(faces).size !== faces.length ||
      !faces.includes(face)
    ) {
      return null;
    }
    faces.sort((left, right) => left - right);
    return {
      faces,
      radius: candidate.radius,
      key: `${solid}:${faces.join(',')}`
    };
  } catch {
    // Older pins and unsupported analytic regions both fail closed here.
    return null;
  }
}

/** Exact analytic identity used to authorize and re-check a blend edit. */
export function blendCarrierSnapshot(
  geometry: FaceGeometry | undefined
): BlendCarrierSnapshot | null {
  if (geometry?.featureType !== 'blend' || geometry.blendRadius === undefined) {
    return null;
  }
  if (
    geometry.surfaceType === 'torus' &&
    geometry.torusCenter &&
    geometry.axis
  ) {
    return {
      surfaceClass: 'torus',
      radius: geometry.blendRadius,
      center: geometry.torusCenter,
      axis: geometry.axis
    };
  }
  if (
    geometry.surfaceType === 'cylinder' &&
    geometry.axisStart &&
    geometry.axisEnd
  ) {
    const axis = normalized(subtract(geometry.axisEnd, geometry.axisStart));
    if (!axis) {
      return null;
    }
    return {
      surfaceClass: 'cylinder',
      radius: geometry.blendRadius,
      center: scale(add(geometry.axisStart, geometry.axisEnd), 0.5),
      axis
    };
  }
  return null;
}

export interface BlendRegionSnapshot extends BlendCarrierSnapshot {
  regionKey: string;
  faceCount: number;
}

/**
 * Re-prove a recorded blend seed, its carrier, and region — and, when a
 * source radius is given, that the band still has it. A lineage-resolved
 * seed passes no radius: its identity is proven by role, and the band's
 * current radius is what the edit then works from.
 */
export function requireBlendRegion(
  kernel: RemusKernel,
  solid: number,
  face: number,
  sourceRadius?: number
): BlendRegionSnapshot {
  const geometry = measureOwnedFaceGeometry(kernel, solid, face);
  const carrier = blendCarrierSnapshot(geometry);
  if (
    !carrier ||
    geometry?.editableDimension !== 'blendRadius' ||
    !geometry.blendRegionKey ||
    geometry.blendRegionFaceCount === undefined
  ) {
    throw new Error(
      'Selected face is not a proven constant-radius analytic blend region.'
    );
  }
  if (
    sourceRadius !== undefined &&
    Math.abs(carrier.radius - sourceRadius) >
      Math.max(sourceRadius * 1e-5, 1e-9)
  ) {
    throw new Error(
      'The selected blend no longer matches its recorded radius.'
    );
  }
  return {
    ...carrier,
    regionKey: geometry.blendRegionKey,
    faceCount: geometry.blendRegionFaceCount
  };
}

/**
 * Re-validate that the resolved face is still the through-hole the operation
 * was recorded against. A rebuild that drifted must fail here rather than
 * resize whichever face happened to inherit the fingerprint.
 */
export function requireThroughHole(
  kernel: RemusKernel,
  solid: number,
  face: number,
  sourceDiameter?: number,
  sourceAxisStart?: Vec3,
  sourceAxisEnd?: Vec3
): ThroughHoleGeometry {
  const geometry = measureFaceGeometry(kernel, face);
  const classification = classifyThroughHoleFace(kernel, solid, face, geometry);
  if (classification.status !== 'through-hole' || !geometry) {
    throw new Error(
      classification.status === 'refused'
        ? classification.message
        : 'Selected face is not a complete through-hole cylinder.'
    );
  }
  geometry.featureType = 'through-hole';
  geometry.editableDimension = 'diameter';
  const hole = geometry as ThroughHoleGeometry;
  if (
    sourceDiameter !== undefined &&
    Math.abs(hole.diameter - sourceDiameter) >
      Math.max(DIRECT_EDIT_TOLERANCE, sourceDiameter * 1e-6)
  ) {
    throw new Error(
      'Selected face no longer matches its recorded source diameter.'
    );
  }
  if (sourceAxisStart && sourceAxisEnd) {
    const axisTolerance = Math.max(
      DIRECT_EDIT_TOLERANCE,
      hole.axialLength * 1e-6,
      hole.radius * 1e-6
    );
    const sameDirection =
      length(subtract(hole.axisStart, sourceAxisStart)) <= axisTolerance &&
      length(subtract(hole.axisEnd, sourceAxisEnd)) <= axisTolerance;
    const reversedDirection =
      length(subtract(hole.axisStart, sourceAxisEnd)) <= axisTolerance &&
      length(subtract(hole.axisEnd, sourceAxisStart)) <= axisTolerance;
    if (!sameDirection && !reversedDirection) {
      throw new Error(
        'Selected face no longer matches its recorded hole axis.'
      );
    }
  }
  return hole;
}
export function refuseThroughHole(message: string): ThroughHoleClassification {
  return { status: 'refused', message };
}
