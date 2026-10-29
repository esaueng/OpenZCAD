import type {
  BodyRepresentation,
  FaceTopology,
  Vector3
} from '@openzcad/shared';
import type { CylinderPreviewProfile } from '@openzcad/viewport';
import { geometryTolerance } from '@openzcad/geometry';

const SNAP_MIN_PIXELS = 8;
const NICE_SNAP_FACTORS = [1, 2, 5, 10] as const;

export interface CylinderRadialFrame {
  axisOrigin: Vector3;
  axisDirection: Vector3;
  radialDirection: Vector3;
  radiusAtHit: number;
  concavity: 'hole' | 'boss';
}

function length(vector: Vector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalized(vector: Vector3): Vector3 | null {
  const magnitude = length(vector);
  return magnitude > 1e-9
    ? {
        x: vector.x / magnitude,
        y: vector.y / magnitude,
        z: vector.z / magnitude
      }
    : null;
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function pointDistance(left: Vector3, right: Vector3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

/**
 * Matches the immutable world-space axis of two regenerated cylindrical
 * faces. Kernel topology IDs may change when the radius changes, but the axis
 * endpoints must not; accepting reversed endpoints handles equivalent kernel
 * orientation without accepting a translated or resized axis.
 */
export function sameCylinderAxis(
  firstStart: Vector3,
  firstEnd: Vector3,
  secondStart: Vector3,
  secondEnd: Vector3,
  relativeTolerance = 1e-7
): boolean {
  const scale = Math.max(
    1,
    length(firstStart),
    length(firstEnd),
    length(secondStart),
    length(secondEnd),
    pointDistance(firstStart, firstEnd),
    pointDistance(secondStart, secondEnd)
  );
  const tolerance = scale * relativeTolerance;
  const aligned =
    pointDistance(firstStart, secondStart) <= tolerance &&
    pointDistance(firstEnd, secondEnd) <= tolerance;
  const reversed =
    pointDistance(firstStart, secondEnd) <= tolerance &&
    pointDistance(firstEnd, secondStart) <= tolerance;
  return aligned || reversed;
}

/**
 * The cylindrical face a committed radius edit left on the same axis at the
 * new radius: what stays selected once a drag applies, so the bore keeps its
 * handle instead of the selection falling back to the whole body. Null when
 * no face, or more than one, fits.
 */
export function findResizedCylinderFace(
  faces: readonly FaceTopology[],
  axisStart: Vector3,
  axisEnd: Vector3,
  radius: number
): FaceTopology | null {
  const axis = normalized({
    x: axisEnd.x - axisStart.x,
    y: axisEnd.y - axisStart.y,
    z: axisEnd.z - axisStart.z
  });
  if (!axis) return null;
  const scale = Math.max(1, radius, pointDistance(axisStart, axisEnd));
  const tolerance = scale * 1e-6;
  const offAxis = (point: Vector3) => {
    const relative = {
      x: point.x - axisStart.x,
      y: point.y - axisStart.y,
      z: point.z - axisStart.z
    };
    const along = dot(relative, axis);
    return Math.hypot(
      relative.x - axis.x * along,
      relative.y - axis.y * along,
      relative.z - axis.z * along
    );
  };
  const matches = faces.filter((face) => {
    const geometry = face.geometry;
    if (
      geometry?.surfaceType !== 'cylinder' ||
      geometry.radius === undefined ||
      !geometry.axisStart ||
      !geometry.axisEnd ||
      Math.abs(geometry.radius - radius) > tolerance
    ) {
      return false;
    }
    const direction = normalized({
      x: geometry.axisEnd.x - geometry.axisStart.x,
      y: geometry.axisEnd.y - geometry.axisStart.y,
      z: geometry.axisEnd.z - geometry.axisStart.z
    });
    return (
      direction !== null &&
      1 - Math.abs(dot(direction, axis)) <= 1e-9 &&
      offAxis(geometry.axisStart) <= tolerance &&
      offAxis(geometry.axisEnd) <= tolerance
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Whether scaling the whole disposable body projection is a faithful radius
 * preview. A standalone analytic cylinder has one cylindrical wall and two
 * planar caps; holes, blends, booleans, and other result bodies deliberately
 * stay on the exact-kernel preview path.
 */
export function supportsRadialCylinderPreview(
  body: BodyRepresentation | undefined,
  axisStart: Vector3,
  axisEnd: Vector3
): boolean {
  const faces = body?.topology?.faces;
  if (!faces || faces.length !== 3) {
    return false;
  }

  const axis = {
    x: axisEnd.x - axisStart.x,
    y: axisEnd.y - axisStart.y,
    z: axisEnd.z - axisStart.z
  };
  const axisLength = Math.hypot(axis.x, axis.y, axis.z);
  if (axisLength <= geometryTolerance(axisLength)) {
    return false;
  }

  let cylinderCount = 0;
  let planeCount = 0;
  for (const face of faces) {
    const geometry = face.geometry;
    if (geometry?.surfaceType === 'plane' && geometry.normal) {
      const normalLength = Math.hypot(
        geometry.normal.x,
        geometry.normal.y,
        geometry.normal.z
      );
      const parallel =
        normalLength > geometryTolerance(normalLength) &&
        1 -
          Math.abs(
            (axis.x * geometry.normal.x +
              axis.y * geometry.normal.y +
              axis.z * geometry.normal.z) /
              (axisLength * normalLength)
          ) <=
          geometryTolerance(1);
      if (!parallel) {
        return false;
      }
      planeCount += 1;
      continue;
    }
    if (
      geometry?.surfaceType === 'cylinder' &&
      geometry.axisStart &&
      geometry.axisEnd &&
      sameCylinderAxis(axisStart, axisEnd, geometry.axisStart, geometry.axisEnd)
    ) {
      cylinderCount += 1;
      continue;
    }
    return false;
  }

  return cylinderCount === 1 && planeCount === 2;
}

/**
 * Resolves the fixed cylinder axis and outward radial direction at a picked
 * point. Axis endpoints and hit points are already world-space exact-kernel
 * measurements, so this works unchanged after arbitrary body transforms.
 */
export function cylinderRadialFrame(
  hitPoint: Vector3,
  surfaceNormal: Vector3,
  axisStart: Vector3,
  axisEnd: Vector3
): CylinderRadialFrame | null {
  const axisDirection = normalized({
    x: axisEnd.x - axisStart.x,
    y: axisEnd.y - axisStart.y,
    z: axisEnd.z - axisStart.z
  });
  if (!axisDirection) {
    return null;
  }
  const fromAxisOrigin = {
    x: hitPoint.x - axisStart.x,
    y: hitPoint.y - axisStart.y,
    z: hitPoint.z - axisStart.z
  };
  const axialDistance = dot(fromAxisOrigin, axisDirection);
  const axisOrigin = {
    x: axisStart.x + axisDirection.x * axialDistance,
    y: axisStart.y + axisDirection.y * axialDistance,
    z: axisStart.z + axisDirection.z * axialDistance
  };
  const radial = {
    x: hitPoint.x - axisOrigin.x,
    y: hitPoint.y - axisOrigin.y,
    z: hitPoint.z - axisOrigin.z
  };
  const radiusAtHit = length(radial);
  const radialDirection = normalized(radial);
  if (!radialDirection) {
    return null;
  }
  return {
    axisOrigin,
    axisDirection,
    radialDirection,
    radiusAtHit,
    concavity: dot(surfaceNormal, radialDirection) < 0 ? 'hole' : 'boss'
  };
}

/** The smallest meaningful positive radius at the scale of this edit. */
export function cylinderRadiusTolerance(scale: number): number {
  return Number.isFinite(scale) ? geometryTolerance(Math.abs(scale)) : Infinity;
}

/**
 * A radius the exact edit would refuse as unchanged. Each edit has its own
 * gate: a through-hole resize refuses within 1e-6 (or a millionth of the
 * radius), a generic cylindrical-face resize within 1e-5 of the radius
 * (floored at 1e-9). A guard looser than the edit's suppresses a real
 * change; a tighter one sends a value the kernel then refuses as Failed.
 */
export function isUnchangedCylinderRadius(
  radius: number,
  sourceRadius: number,
  featureType?: 'through-hole' | 'blend'
): boolean {
  const scale = Math.abs(sourceRadius);
  const tolerance =
    featureType === 'through-hole'
      ? Math.max(1e-6, scale * 1e-6)
      : Math.max(1e-9, scale * 1e-5);
  return Math.abs(radius - sourceRadius) <= tolerance;
}

/**
 * Reject radii that are non-finite, inverted, or indistinguishable from zero
 * at the scale of the edit. There is deliberately no model-size ceiling:
 * exact-kernel validation decides whether a finite positive radius produces a
 * valid B-rep.
 */
export function isValidCylinderRadius(
  radius: number,
  referenceScale = radius
): boolean {
  const scale = Math.max(Math.abs(radius), Math.abs(referenceScale));
  return (
    Number.isFinite(radius) &&
    Number.isFinite(referenceScale) &&
    radius > cylinderRadiusTolerance(scale)
  );
}

/**
 * The direct-edit invariant: only radius changes. Invalid candidates are
 * withheld from preview instead of being silently replaced with an unrelated
 * fixed minimum or maximum.
 */
export function radiusFromRadialDelta(
  originalRadius: number,
  radialDelta: number
): number | null {
  if (!Number.isFinite(originalRadius) || !Number.isFinite(radialDelta)) {
    return null;
  }
  const radius = originalRadius + radialDelta;
  const editScale = Math.max(
    Math.abs(originalRadius),
    Math.abs(radialDelta),
    Math.abs(radius)
  );
  return isValidCylinderRadius(radius, editScale) ? radius : null;
}

/**
 * Unbounded zoom-adaptive radius snapping. The generic move gizmo intentionally
 * uses a finite table, but radius editing must remain usable for cylinders
 * below 0.01 units and above 1,000,000 units.
 */
export function cylinderRadiusSnapStep(worldPerPixel: number): number {
  if (!Number.isFinite(worldPerPixel) || worldPerPixel <= 0) {
    return 1;
  }
  const minimumStep = worldPerPixel * SNAP_MIN_PIXELS;
  const magnitude = 10 ** Math.floor(Math.log10(minimumStep));
  return (
    NICE_SNAP_FACTORS.map((factor) => factor * magnitude).find(
      (candidate) => candidate >= minimumStep
    ) ?? magnitude * 10
  );
}

/**
 * Snap the dimension the chip shows, not the radius underneath it. Snapping
 * the radius to 0.02 lands a diameter drag on Ø 10.32; in diameter mode the
 * same zoom-adaptive step is taken in diameter units, so the value reads
 * Ø 10.3 rather than an odd hundredth.
 */
export function snapCylinderRadius(
  radius: number,
  worldPerPixel: number,
  mode: 'diameter' | 'radius'
): number {
  const factor = mode === 'diameter' ? 2 : 1;
  const step = cylinderRadiusSnapStep(worldPerPixel);
  return (Math.round((radius * factor) / step) * step) / factor;
}

/** Recognized round-rim profile; history eligibility is checked by the caller. */
export function cylinderPreviewProfile(
  body: BodyRepresentation | undefined
): CylinderPreviewProfile | null {
  const faces = body?.topology?.faces;
  if (!faces || faces.length < 3 || faces.length > 5) return null;
  const walls = faces.filter(
    (face) => face.geometry?.surfaceType === 'cylinder'
  );
  const wall = walls[0]?.geometry;
  if (walls.length !== 1 || !wall?.axisStart || !wall.axisEnd || !wall.radius)
    return null;
  const { axisStart, axisEnd, radius } = wall;
  const difference = {
    x: axisEnd.x - axisStart.x,
    y: axisEnd.y - axisStart.y,
    z: axisEnd.z - axisStart.z
  };
  const span = length(difference);
  const tolerance = Math.max(radius, span, 1) * 1e-6;
  const axis = normalized(difference);
  if (
    !axis ||
    !Number.isFinite(span) ||
    span <= tolerance ||
    !Number.isFinite(radius) ||
    radius <= tolerance
  )
    return null;
  let caps = 0;
  let coreRadius = radius;
  const rims = new Set<number>();
  for (const face of faces) {
    const geometry = face.geometry;
    if (geometry === wall) continue;
    if (geometry?.surfaceType === 'plane' && geometry.normal) {
      const normal = normalized(geometry.normal);
      if (!normal || Math.abs(dot(normal, axis)) < 1 - 1e-6) return null;
      caps += 1;
    } else if (
      geometry?.surfaceType === 'torus' &&
      geometry.featureType === 'blend' &&
      geometry.torusCenter &&
      geometry.majorRadius &&
      geometry.minorRadius
    ) {
      const center = {
        x: geometry.torusCenter.x - axisStart.x,
        y: geometry.torusCenter.y - axisStart.y,
        z: geometry.torusCenter.z - axisStart.z
      };
      const axial = dot(center, axis);
      const end =
        Math.abs(axial) <= tolerance
          ? 0
          : Math.abs(axial - span) <= tolerance
            ? 1
            : null;
      const radial = {
        x: center.x - axis.x * axial,
        y: center.y - axis.y * axial,
        z: center.z - axis.z * axial
      };
      if (
        end === null ||
        rims.has(end) ||
        length(radial) > tolerance ||
        !Number.isFinite(geometry.majorRadius + geometry.minorRadius) ||
        Math.abs(geometry.majorRadius + geometry.minorRadius - radius) >
          tolerance ||
        geometry.majorRadius <= tolerance ||
        geometry.minorRadius <= tolerance
      )
        return null;
      rims.add(end);
      coreRadius = Math.min(coreRadius, geometry.majorRadius);
    } else return null;
  }
  return caps === 2 ? { axisStart, axisEnd, radius, coreRadius } : null;
}
