import type { PlaneBasis } from '@openzcad/geometry';
import type {
  SketchObjectData,
  SketchPlaneFrame,
  Vector3
} from '@openzcad/shared';

/**
 * Pure math for in-viewport sketching: pointer-to-plane projection, snapping,
 * drag-to-shape construction, camera poses, and cursor dimension labels.
 * Everything here is unit-testable without three.js or the DOM.
 */

export interface SketchPoint {
  x: number;
  y: number;
}

const MIN_PROFILE_SIZE = 0.5;

/** Quantizes a sketch point to the linear snap grid. */
export function snapSketchPoint(point: SketchPoint, step = 1): SketchPoint {
  return {
    x: Math.round(point.x / step) * step,
    y: Math.round(point.y / step) * step
  };
}

/**
 * Adaptive display spacing from the conventional 1-2-5 engineering sequence.
 * The returned model-unit step keeps minor lines near the requested pixel gap.
 */
export function adaptiveGridSpacing(
  worldPerPixel: number,
  targetPixels = 32
): number {
  const desired = Math.max(worldPerPixel, 1e-12) * Math.max(targetPixels, 1);
  const exponent = Math.floor(Math.log10(desired));
  const magnitude = 10 ** exponent;
  const normalized = desired / magnitude;
  const multiplier =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

/**
 * Places a point at an exact distance along the latest pointer direction.
 * A stationary pointer uses +X so click-then-type remains deterministic.
 */
export function pointAtDistanceAlongDirection(
  origin: SketchPoint,
  direction: SketchPoint,
  distance: number
): SketchPoint {
  const dx = direction.x - origin.x;
  const dy = direction.y - origin.y;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude <= 1e-12) {
    return { x: origin.x + distance, y: origin.y };
  }
  return {
    x: origin.x + (dx / magnitude) * distance,
    y: origin.y + (dy / magnitude) * distance
  };
}

/**
 * Builds a closed sketch object from a corner/center drag, or null while the
 * gesture is still too small to mean anything.
 */
export function sketchObjectFromDrag(
  tool: 'rectangle' | 'circle' | 'polygon',
  start: SketchPoint,
  end: SketchPoint
): SketchObjectData | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === 'rectangle') {
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    if (width < MIN_PROFILE_SIZE || height < MIN_PROFILE_SIZE) {
      return null;
    }
    return {
      objectKind: 'rectangle',
      width,
      height,
      centerX: (start.x + end.x) / 2,
      centerY: (start.y + end.y) / 2
    };
  }

  const radius = Math.hypot(dx, dy);
  if (radius < MIN_PROFILE_SIZE) {
    return null;
  }
  if (tool === 'circle') {
    return {
      objectKind: 'circle',
      radius,
      centerX: start.x,
      centerY: start.y
    };
  }
  return {
    objectKind: 'polygon',
    sides: 6,
    radius,
    centerX: start.x,
    centerY: start.y
  };
}

/** Circle whose two picked points are opposite endpoints of its diameter. */
export function circleObjectFromDiameter(
  first: SketchPoint,
  second: SketchPoint
): SketchObjectData | null {
  const diameter = Math.hypot(second.x - first.x, second.y - first.y);
  if (diameter < MIN_PROFILE_SIZE * 2) {
    return null;
  }
  return {
    objectKind: 'circle',
    radius: diameter / 2,
    centerX: (first.x + second.x) / 2,
    centerY: (first.y + second.y) / 2
  };
}

/**
 * Unique circumcircle through three points. Nearly collinear input is rejected
 * with a scale-aware determinant test instead of producing an unstable radius.
 */
export function circleObjectFromThreePoints(
  first: SketchPoint,
  second: SketchPoint,
  third: SketchPoint
): SketchObjectData | null {
  const determinant =
    2 *
    (first.x * (second.y - third.y) +
      second.x * (third.y - first.y) +
      third.x * (first.y - second.y));
  const span = Math.max(
    Math.hypot(second.x - first.x, second.y - first.y),
    Math.hypot(third.x - second.x, third.y - second.y),
    Math.hypot(first.x - third.x, first.y - third.y),
    1
  );
  if (Math.abs(determinant) <= span * span * 1e-9) {
    return null;
  }
  const firstSquared = first.x * first.x + first.y * first.y;
  const secondSquared = second.x * second.x + second.y * second.y;
  const thirdSquared = third.x * third.x + third.y * third.y;
  const centerX =
    (firstSquared * (second.y - third.y) +
      secondSquared * (third.y - first.y) +
      thirdSquared * (first.y - second.y)) /
    determinant;
  const centerY =
    (firstSquared * (third.x - second.x) +
      secondSquared * (first.x - third.x) +
      thirdSquared * (second.x - first.x)) /
    determinant;
  const radius = Math.hypot(first.x - centerX, first.y - centerY);
  if (!Number.isFinite(radius) || radius < MIN_PROFILE_SIZE) {
    return null;
  }
  return { objectKind: 'circle', radius, centerX, centerY };
}

/** Sampled preview shared by every circle construction mode. */
export function circlePreviewPoints(
  circle: Extract<SketchObjectData, { objectKind: 'circle' }>,
  segments = 64
): SketchPoint[] {
  const radius = Number(circle.radius);
  const centerX = Number(circle.centerX);
  const centerY = Number(circle.centerY);
  if (
    !Number.isFinite(radius) ||
    !Number.isFinite(centerX) ||
    !Number.isFinite(centerY) ||
    radius <= 0
  ) {
    return [];
  }
  return Array.from({ length: Math.max(16, segments) }, (_, index) => {
    const angle = (index / Math.max(16, segments)) * Math.PI * 2;
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    };
  });
}

/** A line segment object between two sketch points. */
export function lineObjectFromPoints(
  a: SketchPoint,
  b: SketchPoint
): SketchObjectData | null {
  if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_PROFILE_SIZE) {
    return null;
  }
  return { objectKind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** Placeholder string a freshly placed text object carries. */
export const DEFAULT_TEXT_CONTENT = 'Text';
/** Em size, in model units, for a freshly placed text object. */
export const DEFAULT_TEXT_SIZE = 10;
/** Family a freshly placed text object uses. */
export const DEFAULT_TEXT_FAMILY = 'open-sans';

/**
 * Text is placed with a single click rather than a drag: its extent comes from
 * the string and the em size, not from how far the pointer travelled, so there
 * is nothing for a drag to mean. The click sets the baseline origin and the
 * Inspector takes over from there.
 */
export function textObjectFromPoint(point: SketchPoint): SketchObjectData {
  return {
    objectKind: 'text',
    text: DEFAULT_TEXT_CONTENT,
    fontFamily: DEFAULT_TEXT_FAMILY,
    fontStyle: 'regular',
    size: DEFAULT_TEXT_SIZE,
    x: point.x,
    y: point.y
  };
}

function positiveSweep(startAngle: number, endAngle: number): number {
  let sweep = (endAngle - startAngle) % (Math.PI * 2);
  if (sweep < 0) {
    sweep += Math.PI * 2;
  }
  return sweep;
}

/** A center-start-end arc, swept counter-clockwise from start to end. */
export function arcObjectFromPoints(
  center: SketchPoint,
  start: SketchPoint,
  end: SketchPoint
): SketchObjectData | null {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (radius < MIN_PROFILE_SIZE) {
    return null;
  }
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const sweep = positiveSweep(startAngle, endAngle);
  if (sweep < (Math.PI / 180) * 1) {
    return null;
  }
  const startAngleDeg = (startAngle * 180) / Math.PI;
  return {
    objectKind: 'arc',
    centerX: center.x,
    centerY: center.y,
    radius,
    startAngleDeg,
    endAngleDeg: startAngleDeg + (sweep * 180) / Math.PI
  };
}

/** Sampled preview for a center-start-end arc gesture. */
export function arcPreviewPoints(
  center: SketchPoint,
  start: SketchPoint,
  end: SketchPoint,
  segments = 64
): SketchPoint[] {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (radius < 1e-9) {
    return [center, end];
  }
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const sweep = positiveSweep(startAngle, endAngle);
  const steps = Math.max(
    4,
    Math.ceil((sweep / (Math.PI * 2)) * Math.max(8, segments))
  );
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = startAngle + (sweep * index) / steps;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius
    };
  });
}

export function arcDimension(
  center: SketchPoint,
  start: SketchPoint,
  end: SketchPoint
): { radius: number; sweepDeg: number } {
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  return {
    radius: Math.hypot(start.x - center.x, start.y - center.y),
    sweepDeg: (positiveSweep(startAngle, endAngle) * 180) / Math.PI
  };
}

/**
 * Intersects a world-space ray with the sketch plane and returns the point in
 * sketch-local (u, v) coordinates; null when the ray is parallel or hits
 * behind the origin.
 */
export function screenRayToPlanePoint(
  rayOrigin: Vector3,
  rayDirection: Vector3,
  basis: PlaneBasis
): SketchPoint | null {
  const denominator =
    rayDirection.x * basis.normal.x +
    rayDirection.y * basis.normal.y +
    rayDirection.z * basis.normal.z;
  if (Math.abs(denominator) < 1e-9) {
    return null;
  }
  const t =
    ((basis.origin.x - rayOrigin.x) * basis.normal.x +
      (basis.origin.y - rayOrigin.y) * basis.normal.y +
      (basis.origin.z - rayOrigin.z) * basis.normal.z) /
    denominator;
  if (t < 0) {
    return null;
  }
  const hit = {
    x: rayOrigin.x + rayDirection.x * t - basis.origin.x,
    y: rayOrigin.y + rayDirection.y * t - basis.origin.y,
    z: rayOrigin.z + rayDirection.z * t - basis.origin.z
  };
  return {
    x: hit.x * basis.u.x + hit.y * basis.u.y + hit.z * basis.u.z,
    y: hit.x * basis.v.x + hit.y * basis.v.y + hit.z * basis.v.z
  };
}

/**
 * Axis lock for chained lines: within ~5° of horizontal or vertical the
 * segment snaps exactly onto the axis, mirroring the reference's right-angle
 * indicator.
 */
export function axisLockPoint(
  anchor: SketchPoint,
  point: SketchPoint
): { point: SketchPoint; lockedAxis: 'horizontal' | 'vertical' | null } {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) {
    return { point, lockedAxis: null };
  }
  const threshold = Math.tan((5 * Math.PI) / 180);
  if (Math.abs(dy) <= Math.abs(dx) * threshold) {
    return { point: { x: point.x, y: anchor.y }, lockedAxis: 'horizontal' };
  }
  if (Math.abs(dx) <= Math.abs(dy) * threshold) {
    return { point: { x: anchor.x, y: point.y }, lockedAxis: 'vertical' };
  }
  return { point, lockedAxis: null };
}

/**
 * Camera pose facing the sketch plane head-on from the given distance. Planes
 * whose normal is parallel to world +Z get a hair of -Y mixed in, exactly like
 * the standard top view, so OrbitControls never sees a degenerate up axis.
 */
export function sketchEntryPose(
  basis: PlaneBasis,
  distance: number
): { position: Vector3; target: Vector3 } {
  const clamped = Math.max(distance, 1);
  let direction = { ...basis.normal };
  if (Math.abs(direction.z) > 0.9999 && Math.abs(direction.y) < 1e-6) {
    const sign = direction.z >= 0 ? 1 : -1;
    const magnitude = Math.hypot(0.0001, 1);
    direction = { x: 0, y: -0.0001 / magnitude, z: sign / magnitude };
  }
  return {
    position: {
      x: basis.origin.x + direction.x * clamped,
      y: basis.origin.y + direction.y * clamped,
      z: basis.origin.z + direction.z * clamped
    },
    target: { ...basis.origin }
  };
}

/**
 * Builds an orthonormal right-handed sketch frame on a planar face, using the
 * same reference-axis convention as the kernel's cylinder frames so repeated
 * derivations agree.
 */
export function frameFromFace(
  center: Vector3,
  normal: Vector3
): SketchPlaneFrame {
  const magnitude = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const zAxis = {
    x: normal.x / magnitude,
    y: normal.y / magnitude,
    z: normal.z / magnitude
  };
  const reference =
    Math.abs(zAxis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const xRaw = {
    x: reference.y * zAxis.z - reference.z * zAxis.y,
    y: reference.z * zAxis.x - reference.x * zAxis.z,
    z: reference.x * zAxis.y - reference.y * zAxis.x
  };
  const xMagnitude = Math.hypot(xRaw.x, xRaw.y, xRaw.z) || 1;
  const xAxis = {
    x: xRaw.x / xMagnitude,
    y: xRaw.y / xMagnitude,
    z: xRaw.z / xMagnitude
  };
  const yAxis = {
    x: zAxis.y * xAxis.z - zAxis.z * xAxis.y,
    y: zAxis.z * xAxis.x - zAxis.x * xAxis.z,
    z: zAxis.x * xAxis.y - zAxis.y * xAxis.x
  };
  return { origin: { ...center }, xAxis, yAxis, zAxis };
}

/** The live cursor dimension for an in-progress entity. */
export function dimensionForInProgress(
  tool: 'line' | 'circle' | 'rectangle',
  start: SketchPoint,
  current: SketchPoint
): string {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const round = (value: number): number => Math.round(value * 10) / 10;
  if (tool === 'circle') {
    return `⌀ ${round(Math.hypot(dx, dy) * 2)}`;
  }
  if (tool === 'rectangle') {
    return `${round(Math.abs(dx))} × ${round(Math.abs(dy))}`;
  }
  return `${round(Math.hypot(dx, dy))}`;
}

// ---------------------------------------------------------------------------
// Entity snapping (endpoint / midpoint / center)
// ---------------------------------------------------------------------------

export type SnapTargetKind =
  | 'origin'
  | 'endpoint'
  | 'intersection'
  | 'center'
  | 'midpoint'
  | 'quadrant'
  | 'horizontal'
  | 'vertical'
  | 'grid';

export interface SnapTarget extends SketchPoint {
  kind: SnapTargetKind;
  /** Stable within one evaluated sketch; used by hysteresis and Tab cycling. */
  id?: string;
  sourceId?: string;
}

export type SketchInferenceSegment = readonly [SketchPoint, SketchPoint];

export const SKETCH_SNAP_PRIORITY: Record<SnapTargetKind, number> = {
  origin: 0,
  endpoint: 1,
  intersection: 2,
  center: 3,
  midpoint: 4,
  quadrant: 5,
  horizontal: 6,
  vertical: 6,
  grid: 7
};

export const SKETCH_SNAP_LABELS: Record<SnapTargetKind, string> = {
  origin: 'Origin',
  endpoint: 'Endpoint',
  intersection: 'Intersection',
  center: 'Center',
  midpoint: 'Midpoint',
  quadrant: 'Quadrant',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  grid: 'Grid'
};

export const SKETCH_SNAP_GLYPHS: Record<SnapTargetKind, string> = {
  origin: '⊕',
  endpoint: '□',
  intersection: '×',
  center: '○',
  midpoint: '△',
  quadrant: '◇',
  horizontal: '—',
  vertical: '│',
  grid: '•'
};

/**
 * Snap candidates for one committed sketch object. Points resolve through the
 * same parameter scope as the renderer, so expressions snap at their evaluated
 * positions.
 */
export function snapTargetsForObject(
  data: SketchObjectData,
  resolve: (value: unknown) => number,
  sourceId?: string
): SnapTarget[] {
  let index = 0;
  const target = (kind: SnapTargetKind, x: number, y: number): SnapTarget => ({
    x,
    y,
    kind,
    ...(sourceId ? { sourceId, id: `${sourceId}:${kind}:${index++}` } : {})
  });
  switch (data.objectKind) {
    case 'line': {
      const x1 = resolve(data.x1);
      const y1 = resolve(data.y1);
      const x2 = resolve(data.x2);
      const y2 = resolve(data.y2);
      return [
        target('endpoint', x1, y1),
        target('endpoint', x2, y2),
        target('midpoint', (x1 + x2) / 2, (y1 + y2) / 2)
      ];
    }
    case 'rectangle': {
      const halfWidth = resolve(data.width) / 2;
      const halfHeight = resolve(data.height) / 2;
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const corners: SnapTarget[] = [
        target('endpoint', cx - halfWidth, cy - halfHeight),
        target('endpoint', cx + halfWidth, cy - halfHeight),
        target('endpoint', cx + halfWidth, cy + halfHeight),
        target('endpoint', cx - halfWidth, cy + halfHeight)
      ];
      return [
        ...corners,
        target('center', cx, cy),
        target('midpoint', cx - halfWidth, cy),
        target('midpoint', cx + halfWidth, cy),
        target('midpoint', cx, cy - halfHeight),
        target('midpoint', cx, cy + halfHeight)
      ];
    }
    case 'circle': {
      const radius = resolve(data.radius);
      const centerX = resolve(data.centerX);
      const centerY = resolve(data.centerY);
      return [
        target('center', centerX, centerY),
        target('quadrant', centerX + radius, centerY),
        target('quadrant', centerX, centerY + radius),
        target('quadrant', centerX - radius, centerY),
        target('quadrant', centerX, centerY - radius)
      ];
    }
    case 'polygon':
      return [target('center', resolve(data.centerX), resolve(data.centerY))];
    case 'arc': {
      const radius = resolve(data.radius);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const start = (resolve(data.startAngleDeg) * Math.PI) / 180;
      const end = (resolve(data.endAngleDeg) * Math.PI) / 180;
      let sweep = end - start;
      if (sweep <= 0) {
        sweep += Math.PI * 2;
      }
      const onArc = (angle: number): SketchPoint => ({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius
      });
      const arcStart = onArc(start);
      const arcEnd = onArc(start + sweep);
      const arcMid = onArc(start + sweep / 2);
      return [
        target('endpoint', arcStart.x, arcStart.y),
        target('endpoint', arcEnd.x, arcEnd.y),
        target('midpoint', arcMid.x, arcMid.y),
        target('center', cx, cy)
      ];
    }
    case 'text':
      // The baseline origin is the one point that exists without parsed font
      // data, and it is the handle a user drags, so it is the snap target.
      return [target('endpoint', resolve(data.x), resolve(data.y))];
  }
}

interface SnapSegment {
  id: string;
  a: SketchPoint;
  b: SketchPoint;
}

function snapSegmentsForObject(
  id: string,
  data: SketchObjectData,
  resolve: (value: unknown) => number
): SnapSegment[] {
  if (data.objectKind === 'line') {
    return [
      {
        id,
        a: { x: resolve(data.x1), y: resolve(data.y1) },
        b: { x: resolve(data.x2), y: resolve(data.y2) }
      }
    ];
  }
  if (data.objectKind !== 'rectangle') {
    return [];
  }
  const halfWidth = resolve(data.width) / 2;
  const halfHeight = resolve(data.height) / 2;
  const centerX = resolve(data.centerX);
  const centerY = resolve(data.centerY);
  const points = [
    { x: centerX - halfWidth, y: centerY - halfHeight },
    { x: centerX + halfWidth, y: centerY - halfHeight },
    { x: centerX + halfWidth, y: centerY + halfHeight },
    { x: centerX - halfWidth, y: centerY + halfHeight }
  ];
  return points.map((point, index) => ({
    id: `${id}:${index}`,
    a: point,
    b: points[(index + 1) % points.length]!
  }));
}

function segmentIntersection(
  first: SnapSegment,
  second: SnapSegment
): SketchPoint | null {
  const firstX = first.b.x - first.a.x;
  const firstY = first.b.y - first.a.y;
  const secondX = second.b.x - second.a.x;
  const secondY = second.b.y - second.a.y;
  const denominator = firstX * secondY - firstY * secondX;
  const scale = Math.max(
    Math.hypot(firstX, firstY),
    Math.hypot(secondX, secondY),
    1
  );
  if (Math.abs(denominator) <= scale * scale * 1e-12) {
    return null;
  }
  const deltaX = second.a.x - first.a.x;
  const deltaY = second.a.y - first.a.y;
  const firstT = (deltaX * secondY - deltaY * secondX) / denominator;
  const secondT = (deltaX * firstY - deltaY * firstX) / denominator;
  const epsilon = 1e-9;
  if (
    firstT < -epsilon ||
    firstT > 1 + epsilon ||
    secondT < -epsilon ||
    secondT > 1 + epsilon
  ) {
    return null;
  }
  return {
    x: first.a.x + firstT * firstX,
    y: first.a.y + firstT * firstY
  };
}

/** Exact point candidates from the evaluated sketch, including line crossings. */
export function collectSketchSnapTargets(
  objects: readonly { id: string; data: SketchObjectData }[],
  resolve: (value: unknown) => number
): SnapTarget[] {
  const targets: SnapTarget[] = [
    { id: 'sketch-origin', x: 0, y: 0, kind: 'origin' }
  ];
  const segments: SnapSegment[] = [];
  for (const object of objects) {
    targets.push(...snapTargetsForObject(object.data, resolve, object.id));
    segments.push(...snapSegmentsForObject(object.id, object.data, resolve));
  }
  for (let first = 0; first < segments.length; first += 1) {
    for (let second = first + 1; second < segments.length; second += 1) {
      if (
        segments[first]!.id.split(':')[0] === segments[second]!.id.split(':')[0]
      ) {
        continue;
      }
      const point = segmentIntersection(segments[first]!, segments[second]!);
      if (point) {
        targets.push({
          id: `intersection:${segments[first]!.id}:${segments[second]!.id}`,
          ...point,
          kind: 'intersection'
        });
      }
    }
  }
  return targets;
}

export interface RankedSnapTarget {
  target: SnapTarget;
  distance: number;
}

/** Deterministic candidate order: semantic priority, distance, then stable id. */
export function rankSnapTargets(
  point: SketchPoint,
  targets: readonly SnapTarget[],
  tolerance: number
): RankedSnapTarget[] {
  return targets
    .map((target) => ({
      target,
      distance: Math.hypot(point.x - target.x, point.y - target.y)
    }))
    .filter((candidate) => candidate.distance <= tolerance)
    .sort((first, second) => {
      const priority =
        SKETCH_SNAP_PRIORITY[first.target.kind] -
        SKETCH_SNAP_PRIORITY[second.target.kind];
      if (priority !== 0) {
        return priority;
      }
      if (Math.abs(first.distance - second.distance) > 1e-12) {
        return first.distance - second.distance;
      }
      return (first.target.id ?? '').localeCompare(second.target.id ?? '');
    });
}

export interface SketchSnapResolution {
  target: SnapTarget;
  candidates: RankedSnapTarget[];
}

/** Candidate resolution with sticky hysteresis and explicit overlap cycling. */
export function resolveSketchSnap(
  point: SketchPoint,
  targets: readonly SnapTarget[],
  tolerance: number,
  options: {
    lockedId?: string | null;
    cycle?: number;
    hysteresis?: number;
  } = {}
): SketchSnapResolution | null {
  const locked = options.lockedId
    ? targets.find((target) => target.id === options.lockedId)
    : undefined;
  if (
    locked &&
    Math.hypot(point.x - locked.x, point.y - locked.y) <=
      tolerance * (options.hysteresis ?? 1.5)
  ) {
    return {
      target: locked,
      candidates: rankSnapTargets(point, targets, tolerance)
    };
  }
  const candidates = rankSnapTargets(point, targets, tolerance);
  if (candidates.length === 0) {
    return null;
  }
  const index =
    (((options.cycle ?? 0) % candidates.length) + candidates.length) %
    candidates.length;
  return { target: candidates[index]!.target, candidates };
}

/**
 * Nearest snap target within `tolerance` (sketch units) of the pointer, or
 * null. Ties resolve in target order, so callers should order targets
 * endpoint-first when stacking kinds.
 */
export function nearestSnapTarget(
  point: SketchPoint,
  targets: readonly SnapTarget[],
  tolerance: number
): SnapTarget | null {
  return resolveSketchSnap(point, targets, tolerance)?.target ?? null;
}

/**
 * Finds the closest exact center worth previewing before the tighter snap
 * tolerance engages. This is a visual discovery aid only; callers must still
 * use `resolveSketchSnap` to commit an exact point.
 */
export function nearestCenterGuideTarget(
  point: SketchPoint,
  targets: readonly SnapTarget[],
  tolerance: number
): SnapTarget | null {
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    return null;
  }
  return (
    targets
      .filter((target) => target.kind === 'origin' || target.kind === 'center')
      .map((target) => ({
        target,
        distance: Math.hypot(point.x - target.x, point.y - target.y)
      }))
      .filter((candidate) => candidate.distance <= tolerance)
      .sort((first, second) => {
        if (Math.abs(first.distance - second.distance) > 1e-12) {
          return first.distance - second.distance;
        }
        const priority =
          SKETCH_SNAP_PRIORITY[first.target.kind] -
          SKETCH_SNAP_PRIORITY[second.target.kind];
        return priority !== 0
          ? priority
          : (first.target.id ?? '').localeCompare(second.target.id ?? '');
      })[0]?.target ?? null
  );
}

/** Full horizontal and vertical construction guides through an exact center. */
export function centerInferenceSegments(
  target: SnapTarget,
  halfSpan: number
): SketchInferenceSegment[] {
  if (
    (target.kind !== 'origin' && target.kind !== 'center') ||
    !Number.isFinite(halfSpan) ||
    halfSpan <= 0
  ) {
    return [];
  }
  return [
    [
      { x: target.x - halfSpan, y: target.y },
      { x: target.x + halfSpan, y: target.y }
    ],
    [
      { x: target.x, y: target.y - halfSpan },
      { x: target.x, y: target.y + halfSpan }
    ]
  ];
}
