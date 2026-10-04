import type { PlaneBasis } from '@openzcad/geometry';
import type { SketchMoveHandle } from '../interaction/machine';
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
 * World-space points bounding the sketch's committed content: every object's
 * snap targets, lifted through the plane basis. Circle quadrants, rectangle
 * corners, and arc endpoints bound their entities exactly, so the set frames
 * the sketch without sampling curves.
 */
export function sketchContentFramePoints(
  objects: ReadonlyArray<{ data: SketchObjectData }>,
  resolve: (value: unknown) => number,
  basis: PlaneBasis
): Vector3[] {
  const points: Vector3[] = [];
  for (const object of objects) {
    for (const target of snapTargetsForObject(object.data, resolve)) {
      points.push({
        x: basis.origin.x + basis.u.x * target.x + basis.v.x * target.y,
        y: basis.origin.y + basis.u.y * target.x + basis.v.y * target.y,
        z: basis.origin.z + basis.u.z * target.x + basis.v.z * target.y
      });
    }
  }
  return points;
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

/**
 * Direction of an in-progress line from its anchor, in degrees
 * counter-clockwise from +X in [0, 360), to one decimal. Shown beside the
 * length so a typed length and a watched angle place a line exactly.
 */
export function angleForInProgress(
  start: SketchPoint,
  current: SketchPoint
): number {
  const degrees =
    (Math.atan2(current.y - start.y, current.x - start.x) * 180) / Math.PI;
  const wrapped = ((degrees % 360) + 360) % 360;
  const rounded = Math.round(wrapped * 10) / 10;
  return rounded === 360 ? 0 : rounded;
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
  /**
   * The constraint-schema name of this snap point on its source object, set
   * only where `SketchPointRef` has one (line/arc start and end, circle and
   * arc centers). First-class rather than parsed back out of `id`, whose
   * index is an opaque per-object counter that reordering would corrupt
   * silently.
   */
  pointRef?: 'start' | 'end' | 'center';
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
  vertical: '|',
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
  const target = (
    kind: SnapTargetKind,
    x: number,
    y: number,
    pointRef?: 'start' | 'end' | 'center'
  ): SnapTarget => ({
    x,
    y,
    kind,
    ...(pointRef ? { pointRef } : {}),
    ...(sourceId ? { sourceId, id: `${sourceId}:${kind}:${index++}` } : {})
  });
  switch (data.objectKind) {
    case 'line': {
      const x1 = resolve(data.x1);
      const y1 = resolve(data.y1);
      const x2 = resolve(data.x2);
      const y2 = resolve(data.y2);
      return [
        target('endpoint', x1, y1, 'start'),
        target('endpoint', x2, y2, 'end'),
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
        target('center', centerX, centerY, 'center'),
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
        target('endpoint', arcStart.x, arcStart.y, 'start'),
        target('endpoint', arcEnd.x, arcEnd.y, 'end'),
        target('midpoint', arcMid.x, arcMid.y),
        target('center', cx, cy, 'center')
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

/** Work and allocation bounds for synchronous, pointer-consumed snap data. */
export const SKETCH_SNAP_LIMITS = {
  objects: 1024,
  segments: 512,
  pairs: 65_536,
  targets: 8192,
  objectIdLength: 256
} as const;

export class SketchSnapLimitError extends RangeError {
  readonly budget: keyof typeof SKETCH_SNAP_LIMITS;

  constructor(budget: keyof typeof SKETCH_SNAP_LIMITS) {
    const label = {
      objects: 'sketch objects',
      segments: 'line and rectangle segments',
      pairs: 'segment pairs',
      targets: 'snap targets',
      objectIdLength: 'object ID characters'
    }[budget];
    super(
      `Geometry snapping is unavailable: this sketch exceeds the limit of ${SKETCH_SNAP_LIMITS[budget]} ${label}. Origin and grid snapping remain available. Reduce sketch complexity to restore geometry snapping.`
    );
    this.budget = budget;
    this.name = 'SketchSnapLimitError';
  }
}

/** Refuse before parameter evaluation, allocation, or the quadratic pair loop. */
function checkSketchSnapInput(
  objects: readonly { id: string; data: SketchObjectData }[]
): void {
  if (objects.length > SKETCH_SNAP_LIMITS.objects) {
    throw new SketchSnapLimitError('objects');
  }
  let segments = 0;
  for (const object of objects) {
    if (object.id.length > SKETCH_SNAP_LIMITS.objectIdLength) {
      throw new SketchSnapLimitError('objectIdLength');
    }
    segments +=
      object.data.objectKind === 'line'
        ? 1
        : object.data.objectKind === 'rectangle'
          ? 4
          : 0;
    if (segments > SKETCH_SNAP_LIMITS.segments) {
      throw new SketchSnapLimitError('segments');
    }
  }
  // Include skipped same-object pairs: the loop still visits those pairs.
  if ((segments * (segments - 1)) / 2 > SKETCH_SNAP_LIMITS.pairs) {
    throw new SketchSnapLimitError('pairs');
  }
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
  checkSketchSnapInput(objects);
  const targets: SnapTarget[] = [
    { id: 'sketch-origin', x: 0, y: 0, kind: 'origin' }
  ];
  const appendTargets = (candidates: SnapTarget[]): void => {
    if (targets.length + candidates.length > SKETCH_SNAP_LIMITS.targets) {
      // Refuse the whole collection; a partial result changes snap semantics.
      throw new SketchSnapLimitError('targets');
    }
    targets.push(...candidates);
  };
  const segments: SnapSegment[] = [];
  for (const object of objects) {
    appendTargets(snapTargetsForObject(object.data, resolve, object.id));
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
        appendTargets([
          {
            id: `intersection:${segments[first]!.id}:${segments[second]!.id}`,
            ...point,
            kind: 'intersection'
          }
        ]);
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

// ---------------------------------------------------------------------------
// Drag-move of a committed object
// ---------------------------------------------------------------------------

/**
 * Whether a stored value is a plain number a drag may overwrite. An
 * expression (`width / 2`, a parameter name) is the user's intent, and a drag
 * that wrote a number over it would cut the link without saying so; such an
 * object keeps its exact-entry fields and offers no drag.
 */
function isLiteralNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return (
    typeof value === 'string' &&
    /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/.test(value)
  );
}

/** The stored fields a translation rewrites, per object kind. */
function positionFields(data: SketchObjectData): [string, string][] {
  switch (data.objectKind) {
    case 'line':
      return [
        ['x1', 'y1'],
        ['x2', 'y2']
      ];
    case 'text':
      return [['x', 'y']];
    default:
      return [['centerX', 'centerY']];
  }
}

/** True when every position field is a literal number a drag can rewrite. */
export function sketchObjectMovable(data: SketchObjectData): boolean {
  const record = data as unknown as Record<string, unknown>;
  return positionFields(data).every(
    ([x, y]) => isLiteralNumber(record[x]) && isLiteralNumber(record[y])
  );
}

/** True for a text object whose rotation is absent or a literal number. */
export function sketchObjectRotatable(data: SketchObjectData): boolean {
  return (
    data.objectKind === 'text' &&
    sketchObjectMovable(data) &&
    (data.rotation === undefined || isLiteralNumber(data.rotation))
  );
}

/**
 * The one point a closed object is dragged by: the centre of a circle,
 * rectangle or polygon, and the baseline origin of text — the same points
 * `snapTargetsForObject` already offers. Lines and arcs have none; they are
 * grabbed anywhere along the curve. Null too when a field cannot resolve.
 */
export function sketchObjectGrabPoint(
  data: SketchObjectData,
  resolve: (value: unknown) => number
): SketchPoint | null {
  try {
    switch (data.objectKind) {
      case 'circle':
      case 'rectangle':
      case 'polygon':
        return { x: resolve(data.centerX), y: resolve(data.centerY) };
      case 'text':
        return { x: resolve(data.x), y: resolve(data.y) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * The object moved by (`dx`, `dy`). Sizes, angles and text attributes are
 * kept as written; only the position fields change, so the result goes
 * through the same entity-edit path the exact fields use.
 */
export function translateSketchObject(
  data: SketchObjectData,
  dx: number,
  dy: number,
  resolve: (value: unknown) => number
): SketchObjectData {
  const next = { ...data } as unknown as Record<string, unknown>;
  for (const [x, y] of positionFields(data)) {
    next[x] = resolve(next[x]) + dx;
    next[y] = resolve(next[y]) + dy;
  }
  return next as unknown as SketchObjectData;
}

/**
 * The object moved so its grab point lands exactly on `target`. Writing the
 * target itself, rather than adding a delta to the old position, keeps a
 * snapped centre bit-exact on the point it snapped to.
 */
export function placeSketchObjectGrabPoint(
  data: SketchObjectData,
  target: SketchPoint
): SketchObjectData {
  switch (data.objectKind) {
    case 'circle':
    case 'rectangle':
    case 'polygon':
      return { ...data, centerX: target.x, centerY: target.y };
    case 'text':
      return { ...data, x: target.x, y: target.y };
    default:
      return data;
  }
}

/**
 * Text rotation after dragging the ring from `from` to `to` about `origin`.
 * Whole degrees unless `free` (Shift), normalised to (-180, 180] so the
 * field reads the way a person would type it.
 */
export function textRotationFromRingDrag(
  origin: SketchPoint,
  from: SketchPoint,
  to: SketchPoint,
  startRotationDeg: number,
  free = false
): number {
  const start = Math.atan2(from.y - origin.y, from.x - origin.x);
  const end = Math.atan2(to.y - origin.y, to.x - origin.x);
  let degrees = startRotationDeg + ((end - start) * 180) / Math.PI;
  if (!free) {
    degrees = Math.round(degrees);
  }
  degrees = ((((degrees + 180) % 360) + 360) % 360) - 180;
  if (degrees === -180) {
    degrees = 180;
  }
  return Object.is(degrees, -0) ? 0 : degrees;
}

/**
 * Whose a pointer event is while a sketch object drag may be held: the
 * pointer that holds it (`owner`), another pointer arriving mid-drag
 * (`other`: a second finger or a stylus, which the viewport ignores
 * entirely, so it can neither start a second move nor end, select through
 * or cancel the first), or any pointer when no drag is held (`free`).
 */
export function sketchMovePointerRole(
  heldPointerId: number | null | undefined,
  pointerId: number
): 'free' | 'owner' | 'other' {
  if (heldPointerId === null || heldPointerId === undefined) {
    return 'free';
  }
  return heldPointerId === pointerId ? 'owner' : 'other';
}

/**
 * Whether two rotations, in degrees, point the same way: equal modulo a
 * full turn, within a hair. A stored 360 and a dragged 0 are one angle.
 */
export function sameRotation(first: number, second: number): boolean {
  const difference = (((first - second) % 360) + 360) % 360;
  return Math.min(difference, 360 - difference) < 1e-9;
}

/**
 * Text turned to `rotationDeg`. When that is the angle the object already
 * has — a ring dragged back to where it started — the object comes back
 * untouched, so an absent rotation stays absent and a stored 360 stays 360.
 */
export function rotateTextObject(
  data: SketchObjectData,
  rotationDeg: number
): SketchObjectData {
  if (data.objectKind !== 'text') {
    return data;
  }
  const current = data.rotation === undefined ? 0 : Number(data.rotation);
  if (Number.isFinite(current) && sameRotation(rotationDeg, current)) {
    return data;
  }
  return { ...data, rotation: rotationDeg };
}

/**
 * Whether a drag changed what the object means. Position fields and text
 * rotation compare by value — an absent rotation is 0, a stored `'12.5'` is
 * 12.5, and rotations compare modulo a full turn — so a gesture that ends
 * where it began commits nothing: no solve, no undo entry, no rewritten
 * data. Every other field must match exactly.
 */
export function sketchMoveChanged(
  original: SketchObjectData,
  next: SketchObjectData,
  resolve: (value: unknown) => number
): boolean {
  const before = original as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  const valued = new Set(positionFields(original).flat());
  if (original.objectKind === 'text') {
    valued.add('rotation');
  }
  const numeric = (record: Record<string, unknown>, key: string) =>
    key === 'rotation' && record[key] === undefined ? 0 : resolve(record[key]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === 'rotation' && valued.has(key)) {
      if (!sameRotation(numeric(before, key), numeric(after, key))) {
        return true;
      }
    } else if (valued.has(key)) {
      if (numeric(before, key) !== numeric(after, key)) {
        return true;
      }
    } else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Pointers whose remaining events the viewport ignores: one that pressed
 * while another pointer held a sketch object drag, and one whose own drag
 * Escape or Enter already ended. Each stays ignored — its moves, its release
 * and its cancel — until its own release or cancel arrives, whatever the
 * other pointers do meanwhile: a second finger that outlasts the drag, or
 * a held mouse whose Escape-ended drag another pointer interrupts, must not
 * land as a selection click.
 */
export class SketchMovePointerGate {
  private readonly ignored = new Set<number>();

  /**
   * A press. True when it must be ignored: another pointer holds a drag.
   * A press from a free pointer retires any stale entry for its id, since
   * a release lost off the canvas would otherwise ignore the id forever.
   */
  press(heldPointerId: number | null | undefined, pointerId: number): boolean {
    if (sketchMovePointerRole(heldPointerId, pointerId) === 'other') {
      this.ignored.add(pointerId);
      return true;
    }
    this.ignored.delete(pointerId);
    return false;
  }

  /**
   * A drag ended by the keyboard while its pointer is still down: its
   * release is the end of a gesture already finished, not a click.
   */
  suppress(pointerId: number): void {
    this.ignored.add(pointerId);
  }

  /** True while this pointer's events are being ignored. */
  ignores(pointerId: number): boolean {
    return this.ignored.has(pointerId);
  }

  /** A release or cancel. True when it ends an ignored press. */
  release(pointerId: number): boolean {
    return this.ignored.delete(pointerId);
  }
}

/**
 * Screen radius, in CSS pixels, within which a press takes the selected
 * object's grab point. Matches the drawn handle plus a finger's slack.
 */
export const SKETCH_GRAB_RADIUS_PX = 11;
/**
 * The text rotation ring's radius and the half-width of the band a press
 * must land in. The ring is drawn by `.sketch-rotate-ring` at this size.
 */
export const SKETCH_ROTATE_RING_RADIUS_PX = 34;
export const SKETCH_ROTATE_RING_BAND_PX = 7;

/**
 * Which drawn handle a press lands on, measured where both are drawn: in
 * screen pixels. The dot and the ring are screen-space circles around the
 * grab point's projection, so a press on any visible part of them hits,
 * however obliquely the plane is seen; a plane-space distance would stretch
 * along the foreshortened axis and miss.
 */
export function sketchHandleAtScreen(
  pointer: SketchPoint,
  grab: SketchPoint,
  rotatable: boolean
): SketchMoveHandle | null {
  const distance = Math.hypot(pointer.x - grab.x, pointer.y - grab.y);
  if (distance <= SKETCH_GRAB_RADIUS_PX) {
    return 'translate';
  }
  if (
    rotatable &&
    Math.abs(distance - SKETCH_ROTATE_RING_RADIUS_PX) <=
      SKETCH_ROTATE_RING_BAND_PX
  ) {
    return 'rotate';
  }
  return null;
}

/**
 * The drag's change replayed onto the object as it is now. Another tab or a
 * collaborator may have edited the object while the pointer held it; the
 * drag owns only its position (and a text rotation), so those move by the
 * drag's delta and every other field keeps the concurrent edit. Null when
 * the move can no longer apply: the object changed kind, or the field the
 * drag writes now holds an expression.
 */
export function rebaseSketchMove(
  original: SketchObjectData,
  moved: SketchObjectData,
  current: SketchObjectData,
  resolve: (value: unknown) => number
): SketchObjectData | null {
  if (JSON.stringify(current) === JSON.stringify(original)) {
    return moved;
  }
  if (
    current.objectKind !== original.objectKind ||
    !sketchObjectMovable(current)
  ) {
    return null;
  }
  const before = original as unknown as Record<string, unknown>;
  const after = moved as unknown as Record<string, unknown>;
  const next = { ...current } as unknown as Record<string, unknown>;
  for (const field of positionFields(original).flat()) {
    const delta = resolve(after[field]) - resolve(before[field]);
    if (delta === 0) {
      continue;
    }
    // Where the concurrent edit left the field alone, take the dragged
    // value itself, so a snapped point stays bit-exact.
    next[field] =
      resolve(next[field]) === resolve(before[field])
        ? after[field]
        : resolve(next[field]) + delta;
  }
  if (original.objectKind === 'text') {
    const angle = (value: unknown) =>
      value === undefined ? 0 : resolve(value);
    const turn = angle(after.rotation) - angle(before.rotation);
    if (!sameRotation(turn, 0)) {
      if (next.rotation !== undefined && !isLiteralNumber(next.rotation)) {
        return null;
      }
      const turned = angle(next.rotation) + turn;
      next.rotation = ((((turned + 180) % 360) + 360) % 360) - 180 || 0;
      if (next.rotation === -180) {
        next.rotation = 180;
      }
    }
  }
  return next as unknown as SketchObjectData;
}
