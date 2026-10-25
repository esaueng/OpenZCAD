import type { PlaneBasis } from '@openzcad/geometry';
import type {
  DatumAxisLine,
  FeatureId,
  RevolveAxis,
  SketchId,
  Vector3
} from '@openzcad/shared';

/**
 * The in-place Revolve: pick a profile, pick an axis, drag the angle.
 *
 * Pure geometry for the command. It names which lines a revolve may turn
 * about, matches a picked sketch line to one of them, and places the angle
 * handle. The viewport draws and picks; App owns the command state; this
 * module only answers questions, so every rule here is unit-tested.
 */

/** A line the profile may revolve about, and how the feature stores it. */
export interface RevolveAxisCandidate {
  id: string;
  label: string;
  origin: Vector3;
  direction: Vector3;
  /** The stored choice: an in-sketch axis, or a datum axis reference. */
  choice: { axis: RevolveAxis } | { datumFeatureId: FeatureId };
}

/** What the command has picked so far. */
export interface RevolveSlots {
  sketchId: SketchId | null;
  axis: RevolveAxisCandidate | null;
}

/** World units a line may sit off the sketch plane and still count as in it. */
const IN_PLANE_TOLERANCE = 1e-6;
/** Sketch units a picked line's ends may sit off a sketch axis. */
const ON_AXIS_TOLERANCE = 1e-6;

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scaled(a: Vector3, s: number): Vector3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function added(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function length(a: Vector3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/**
 * Every line a profile on this sketch can revolve about: the sketch's own
 * horizontal and vertical axes, then each resolved datum axis lying in the
 * sketch plane (the kernel refuses one that leaves it, so it is never
 * offered). Datum axes are named by the caller's label map.
 */
export function revolveAxisCandidates(
  basis: PlaneBasis,
  datumAxes: Record<FeatureId, DatumAxisLine> | undefined,
  datumLabel: (featureId: FeatureId) => string
): RevolveAxisCandidate[] {
  const candidates: RevolveAxisCandidate[] = [
    {
      id: 'sketch-horizontal',
      label: 'Sketch horizontal axis',
      origin: basis.origin,
      direction: basis.u,
      choice: { axis: 'horizontal' }
    },
    {
      id: 'sketch-vertical',
      label: 'Sketch vertical axis',
      origin: basis.origin,
      direction: basis.v,
      choice: { axis: 'vertical' }
    }
  ];
  for (const [featureId, line] of Object.entries(datumAxes ?? {}) as [
    FeatureId,
    DatumAxisLine
  ][]) {
    const offPlane = Math.abs(
      dot(sub(line.origin, basis.origin), basis.normal)
    );
    const tilt = Math.abs(dot(line.direction, basis.normal));
    if (offPlane > IN_PLANE_TOLERANCE || tilt > IN_PLANE_TOLERANCE) continue;
    candidates.push({
      id: `datum:${featureId}`,
      label: datumLabel(featureId),
      origin: line.origin,
      direction: line.direction,
      choice: { datumFeatureId: featureId }
    });
  }
  // A datum axis lying along a sketch axis would draw over it, and a click
  // could not say which was meant. The datum is the user's own construction
  // (and follows its sources), so it stands in for the sketch axis.
  return candidates.filter(
    (candidate) =>
      !('axis' in candidate.choice) ||
      !candidates.some(
        (other) =>
          'datumFeatureId' in other.choice && collinear(candidate, other)
      )
  );
}

/** Whether two lines are the same line, either way round. */
function collinear(
  a: Pick<RevolveAxisCandidate, 'origin' | 'direction'>,
  b: Pick<RevolveAxisCandidate, 'origin' | 'direction'>
): boolean {
  const da = scaled(a.direction, 1 / length(a.direction));
  const db = scaled(b.direction, 1 / length(b.direction));
  if (Math.abs(Math.abs(dot(da, db)) - 1) > IN_PLANE_TOLERANCE) return false;
  const offset = sub(b.origin, a.origin);
  const across = sub(offset, scaled(da, dot(offset, da)));
  return length(across) <= IN_PLANE_TOLERANCE;
}

/**
 * The sketch axis a picked sketch line lies on, in sketch coordinates, or
 * null. A rectangle's side drawn along the vertical axis is the recording's
 * case: picking it means "revolve about the vertical axis".
 */
export function sketchAxisForLine(
  start: { x: number; y: number },
  end: { x: number; y: number }
): RevolveAxis | null {
  if (Math.hypot(end.x - start.x, end.y - start.y) <= ON_AXIS_TOLERANCE) {
    return null;
  }
  if (
    Math.abs(start.x) <= ON_AXIS_TOLERANCE &&
    Math.abs(end.x) <= ON_AXIS_TOLERANCE
  ) {
    return 'vertical';
  }
  if (
    Math.abs(start.y) <= ON_AXIS_TOLERANCE &&
    Math.abs(end.y) <= ON_AXIS_TOLERANCE
  ) {
    return 'horizontal';
  }
  return null;
}

/** Where the angle handle sits for a profile and an axis. */
export interface RevolveRigPlacement {
  center: Vector3;
  axis: Vector3;
  startDirection: Vector3;
  radius: number;
}

/**
 * Places the angle handle for a profile (its outline in world space) turned
 * about `axis`: centred on the axis level with the profile's middle, zero
 * degrees pointing at the profile, and drawn just outside its farthest
 * point so the circle wraps the solid it will sweep. Null when the profile
 * lies on the axis, which no revolve can turn.
 */
export function revolveRigPlacement(
  outline: readonly Vector3[],
  axis: Pick<RevolveAxisCandidate, 'origin' | 'direction'>
): RevolveRigPlacement | null {
  if (outline.length === 0) return null;
  const direction = scaled(axis.direction, 1 / length(axis.direction));
  let middle = { x: 0, y: 0, z: 0 };
  for (const point of outline) middle = added(middle, point);
  middle = scaled(middle, 1 / outline.length);
  const along = dot(sub(middle, axis.origin), direction);
  const center = added(axis.origin, scaled(direction, along));
  let farthest = 0;
  for (const point of outline) {
    const offset = sub(point, axis.origin);
    const radial = sub(offset, scaled(direction, dot(offset, direction)));
    farthest = Math.max(farthest, length(radial));
  }
  const toward = sub(middle, center);
  if (farthest <= 1e-9 || length(toward) <= 1e-9) return null;
  return {
    center,
    axis: direction,
    startDirection: scaled(toward, 1 / length(toward)),
    radius: farthest * 1.15
  };
}

/** The one-line hint for the next thing the command needs. */
export function revolveHint(slots: RevolveSlots): string {
  if (!slots.sketchId) return 'Pick a sketch profile to revolve';
  if (!slots.axis) {
    return 'Pick the axis to turn around';
  }
  return 'Drag the angle, or type a value · Enter to finish · Esc cancels';
}

/** The smallest sweep kept; the kernel accepts every angle in `(0, 360]`. */
export const MIN_REVOLVE_ANGLE = 1e-3;

/** Revolve angles the kernel accepts are `(0, 360]`. */
export function clampRevolveAngle(value: number): number {
  if (!Number.isFinite(value)) return 360;
  return Math.min(360, Math.max(MIN_REVOLVE_ANGLE, value));
}

/** Whether an entered angle is one a revolve can store as typed. */
export function revolveAngleInRange(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 360;
}
