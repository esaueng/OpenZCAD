import * as THREE from 'three';
import {
  angleAboutAxisDeg,
  angleRigBasis,
  closestAxisT,
  unwrapSweepDeg
} from '@openzcad/viewport';
import {
  ASSEMBLY_JOINT_DOFS,
  clampToLimit,
  type AssemblyDragSpec,
  type AssemblyJoint,
  type Vector3
} from '@openzcad/shared';

/**
 * Dragging a component through its joint (AS02). Pure pointer-ray math over
 * the joint the kinematics names ({@link AssemblyDragSpec}): a turn reads
 * the pointer's angle about the fixed axis, a slide where the pointer ray
 * passes closest to the axis line. The value is absolute — measured from
 * where the drag began, never accumulated per event — so it soft-stops at a
 * limit and comes straight back off it when the pointer does.
 */

export interface AssemblyDragSession {
  spec: AssemblyDragSpec;
  /** The joint's values when the drag began; the other motions keep them. */
  baseValues: readonly number[];
  mode: 'angle' | 'linear';
  /** Angle: the circle the grabbed point travels, and its in-plane basis. */
  center: THREE.Vector3;
  axis: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  /** Pointer turn since the start, unwrapped across ±180°, degrees. */
  turnDeg: number;
  /** Linear: where along the axis the pointer started. */
  startT: number;
}

export interface AssemblyDragReading {
  /** The joint's full value list with the dragged motion replaced. */
  values: number[];
  /** The dragged motion's value, clamped. */
  value: number;
  /** Which limit the value is resting on, if any. */
  atLimit: 'min' | 'max' | null;
}

/** Below this |cos| between the ray and a turn plane the pointer reads nothing. */
const GRAZING_COS = 0.02;
/** A value within this of a limit reads as resting on it. */
const LIMIT_EPSILON = 1e-9;

function toThree(v: Vector3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

/**
 * Starts a drag of `spec`'s motion from the pointer ray and the point the
 * pointer grabbed (world). Null when the ray gives no reading to start from
 * (a turn plane seen edge-on, a slide axis seen end-on).
 */
export function beginAssemblyDrag(
  spec: AssemblyDragSpec,
  joint: Pick<AssemblyJoint, 'kind' | 'values'>,
  ray: THREE.Ray,
  grabPoint: Vector3
): AssemblyDragSession | null {
  const axis = toThree(spec.axis).normalize();
  const origin = toThree(spec.axisFrame.origin);
  const dofs = ASSEMBLY_JOINT_DOFS[joint.kind];
  const baseValues = dofs.map((_, index) =>
    index === spec.dof ? spec.startValue : (joint.values[index] ?? 0)
  );
  if (spec.unit === 'deg') {
    // The circle the grabbed point turns on: centred on the axis, in the
    // plane through the grab perpendicular to it.
    const grab = toThree(grabPoint);
    const center = origin
      .clone()
      .addScaledVector(axis, grab.clone().sub(origin).dot(axis));
    const { u, v } = angleRigBasis(axis, grab.clone().sub(center));
    const session: AssemblyDragSession = {
      spec,
      baseValues,
      mode: 'angle',
      center,
      axis,
      u,
      v,
      turnDeg: 0,
      startT: 0
    };
    // The pointer may not sit exactly on the grab; start the turn from
    // wherever the ray meets the plane so the part does not jump.
    const start = pointerAngle(session, ray);
    if (start === null) return null;
    const basis = angleRigBasis(
      axis,
      new THREE.Vector3()
        .addScaledVector(u, Math.cos(THREE.MathUtils.degToRad(start)))
        .addScaledVector(v, Math.sin(THREE.MathUtils.degToRad(start)))
    );
    session.u = basis.u;
    session.v = basis.v;
    return session;
  }
  const startT = closestAxisT(ray, origin, axis);
  if (startT === null) return null;
  return {
    spec,
    baseValues,
    mode: 'linear',
    center: origin,
    axis,
    u: new THREE.Vector3(),
    v: new THREE.Vector3(),
    turnDeg: 0,
    startT
  };
}

/** The pointer's angle on the session's circle, or null when edge-on. */
function pointerAngle(
  session: AssemblyDragSession,
  ray: THREE.Ray
): number | null {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    session.axis,
    session.center
  );
  if (Math.abs(ray.direction.dot(session.axis)) < GRAZING_COS) return null;
  const hit = ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return null;
  return angleAboutAxisDeg(session.center, session.u, session.v, hit);
}

/**
 * The reading for the pointer ray, or null when the ray gives none (the
 * caller keeps the last value). Updates the session's unwrapped turn. With
 * `step` the value is rounded to it before the limit clamps, so a limit is
 * always reachable exactly.
 */
export function readAssemblyDrag(
  session: AssemblyDragSession,
  ray: THREE.Ray,
  step = 0
): AssemblyDragReading | null {
  const { spec } = session;
  let delta: number;
  if (session.mode === 'angle') {
    const raw = pointerAngle(session, ray);
    if (raw === null) return null;
    // The turn nearest the last one, so a drag past ±180° keeps going.
    session.turnDeg = unwrapSweepDeg(
      session.turnDeg,
      raw,
      session.turnDeg - 360,
      session.turnDeg + 360
    );
    delta = session.turnDeg;
  } else {
    const t = closestAxisT(ray, session.center, session.axis);
    if (t === null) return null;
    delta = t - session.startT;
  }
  return assemblyDragReading(
    session,
    spec.startValue + spec.direction * delta,
    step
  );
}

/** The reading for a raw value of the dragged motion: stepped, then clamped. */
export function assemblyDragReading(
  session: Pick<AssemblyDragSession, 'spec' | 'baseValues'>,
  raw: number,
  step = 0
): AssemblyDragReading {
  const stepped = step > 0 ? Math.round(raw / step) * step : raw;
  // Fold the binary noise a decimal step leaves (0.30000000000000004).
  const clean = step > 0 ? Number(stepped.toFixed(6)) : stepped;
  const value = clampToLimit(clean === 0 ? 0 : clean, session.spec.limit);
  const limit = session.spec.limit;
  const atLimit = limit
    ? Math.abs(value - limit.max) <= LIMIT_EPSILON && raw >= limit.max
      ? 'max'
      : Math.abs(value - limit.min) <= LIMIT_EPSILON && raw <= limit.min
        ? 'min'
        : null
    : null;
  const values = [...session.baseValues];
  values[session.spec.dof] = value;
  return { values, value, atLimit };
}

/** "12.0°", "35.0° · max", "4.0 mm · min": the chip beside the cursor. */
export function formatAssemblyDragValue(
  value: number,
  unit: 'deg' | 'mm',
  atLimit: 'min' | 'max' | null
): string {
  const shown = Math.abs(value) < 0.05 ? 0 : value;
  const text =
    unit === 'deg' ? `${shown.toFixed(1)}°` : `${shown.toFixed(1)} mm`;
  return atLimit ? `${text} · ${atLimit}` : text;
}
