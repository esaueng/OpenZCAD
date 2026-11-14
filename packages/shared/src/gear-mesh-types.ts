import type {
  GearHand,
  GearSizing,
  GearType,
  UnitSystem,
  Vector3
} from './index';
import { UNIT_TO_MM, millimetresPerUnit } from './index';
import type { AssemblyFrame } from './assembly';
import type { RigidTransform } from './assembly-kinematics';

/**
 * M14 meshing-pair helper: the types and the light helpers that read a gear
 * (sizing, default first-tooth direction). Kept apart from the pair math in
 * `gear-mesh.ts`, so code that only asks "is this a gear?" stays small.
 */

/** One gear of a pair, its values resolved in document units. */
export interface GearMeshGear {
  gearType: GearType;
  /** Tooth count (a rack's teeth along its length). */
  teeth: number;
  /** Normal module, document units. */
  module: number;
  /** Normal pressure angle, degrees. */
  pressureAngleDeg: number;
  profileShift: number;
  /** Tip height above the reference circle, in modules (ISO 53: 1). */
  addendum: number;
  /** Root depth below the reference circle, in modules (ISO 53: 1.25). */
  dedendum: number;
  /** Circumferential tooth thinning at the pitch circle, document units. */
  backlash: number;
  /** 0 for a spur gear. */
  helixAngleDeg: number;
  hand: GearHand;
  herringbone: boolean;
  faceWidth: number;
  phaseDeg: number;
  /**
   * The gear's own frame in its body's modelled coordinates: the first cap's
   * centre (a rack's origin), the axis and the unit x direction.
   */
  frame: AssemblyFrame;
}

export type GearMeshRefusalCode =
  | 'gear-mesh:not-a-gear'
  | 'gear-mesh:teeth-on-body'
  | 'gear-mesh:moved'
  | 'gear-mesh:unresolved'
  | 'gear-mesh:unsupported-type'
  | 'gear-mesh:two-racks'
  | 'gear-mesh:two-internal'
  | 'gear-mesh:internal-rack'
  | 'gear-mesh:module-mismatch'
  | 'gear-mesh:pressure-angle-mismatch'
  | 'gear-mesh:helix-mismatch'
  | 'gear-mesh:helical-rack'
  | 'gear-mesh:herringbone-mismatch'
  | 'gear-mesh:same-hand'
  | 'gear-mesh:opposite-hand'
  | 'gear-mesh:ring-too-small'
  | 'gear-mesh:no-working-pressure-angle'
  | 'gear-mesh:tip-clearance'
  | 'gear-mesh:invalid-placement';

export interface GearMeshRefusal {
  code: GearMeshRefusalCode;
  /** Unit-free text; {@link gearMeshRefusalText} adds lengths with units. */
  message: string;
  /**
   * `gear-mesh:tip-clearance`: whose tips reach past the other gear's root
   * circle (the gear that stays put, or the one that meshes with it) and by
   * how much, in document units.
   */
  clearance?: { gear: 'base' | 'moving'; overlap: number };
}

export type GearMeshPairKind = 'external' | 'internal' | 'rack';

export interface GearMeshSolution {
  pair: GearMeshPairKind;
  /**
   * Between the two axes; for a rack, from the pinion's axis to the rack's
   * pitch line. Document units.
   */
  centerDistance: number;
  /** The same without profile shift: the sum (ring: difference) of pitch radii. */
  standardCenterDistance: number;
  /** Transverse working pressure angle, degrees. */
  workingPressureAngleDeg: number;
  /**
   * Turns of the second gear per turn of the first; negative when they turn
   * opposite ways. A rack pair gives its travel per pinion turn instead.
   */
  ratio: number | null;
  /** Rack travel per pinion turn, document units. */
  travelPerTurn: number | null;
  /** Circumferential play at the pitch circle: both thinnings. */
  backlash: number;
  /** The second gear's own frame where it lands, in the first's coordinates. */
  frame: AssemblyFrame;
  /** The second gear's modelled coordinates into the first's. */
  placement: RigidTransform;
}

/** Model units per module: a diametral pitch counts teeth per inch. */
export function gearModule(
  sizing: GearSizing,
  pitch: number,
  units: UnitSystem
): number {
  switch (sizing) {
    case 'module':
      return pitch;
    case 'circular-pitch':
      return pitch / Math.PI;
    case 'diametral-pitch':
      return UNIT_TO_MM.inch / millimetresPerUnit(units) / pitch;
  }
}

/**
 * A gear's first-tooth direction when none is stored: world +X off the
 * axis, or world +Y when the axis lies along X. Matches the kernel build.
 */
export function defaultGearXDirection(axis: Vector3): Vector3 {
  const length = Math.hypot(axis.x, axis.y, axis.z);
  const unit = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
  const reference =
    Math.abs(unit.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const along =
    reference.x * unit.x + reference.y * unit.y + reference.z * unit.z;
  const projected = {
    x: reference.x - unit.x * along,
    y: reference.y - unit.y * along,
    z: reference.z - unit.z * along
  };
  const size = Math.hypot(projected.x, projected.y, projected.z);
  return {
    x: projected.x / size,
    y: projected.y / size,
    z: projected.z / size
  };
}

/**
 * The smallest share of a gear's x direction that may remain once its part
 * along the axis is removed. Below it the projection is dominated by
 * rounding: the kernel and this helper compute it in different (equally
 * valid) floating-point orders and can disagree on the tooth phase by whole
 * pitches. At 1e-6 the rounding of the projection (a few units in the last
 * place of |x|, about 1e-16·|x|) turns the x direction by at most ~1e-10
 * rad, far inside any backlash, while any direction more than about 0.2
 * arc-seconds off the axis is still accepted.
 */
export const GEAR_X_DIRECTION_MIN_REMAINDER = 1e-6;

/** Why a gear's placement cannot be read. */
export const GEAR_PLACEMENT_UNUSABLE =
  'its axis has no direction, or its reference (x) direction lies almost along the axis; re-pick the reference direction';

/**
 * A gear's placement frame the way the kernel builds it from the same
 * values: the axis made unit length, and the stored x direction with its
 * component along the axis removed, made unit length. It never substitutes
 * another direction. It is null when the axis has no length, or when the
 * x direction's remainder off the axis is under
 * {@link GEAR_X_DIRECTION_MIN_REMAINDER} of its length: there the tooth
 * phase is ill-conditioned (the kernel may still build it, but the helper
 * cannot promise the same phase), so the gear is refused rather than
 * placed on a guess.
 */
export function gearPlacementFrame(
  origin: Vector3,
  axis: Vector3,
  xDirection: Vector3
): AssemblyFrame | null {
  const zz = axis.x * axis.x + axis.y * axis.y + axis.z * axis.z;
  if (!(zz > 0) || !Number.isFinite(zz)) return null;
  const zl = Math.sqrt(zz);
  const z = { x: axis.x / zl, y: axis.y / zl, z: axis.z / zl };
  const along = xDirection.x * z.x + xDirection.y * z.y + xDirection.z * z.z;
  const p = {
    x: xDirection.x - z.x * along,
    y: xDirection.y - z.y * along,
    z: xDirection.z - z.z * along
  };
  const pp = p.x * p.x + p.y * p.y + p.z * p.z;
  const xx =
    xDirection.x * xDirection.x +
    xDirection.y * xDirection.y +
    xDirection.z * xDirection.z;
  if (!(pp > 0) || !Number.isFinite(pp) || !Number.isFinite(xx)) return null;
  const pl = Math.sqrt(pp);
  if (pl < GEAR_X_DIRECTION_MIN_REMAINDER * Math.sqrt(xx)) return null;
  return {
    origin: { ...origin },
    zAxis: z,
    xAxis: { x: p.x / pl, y: p.y / pl, z: p.z / pl }
  };
}

/** A refusal's text, its lengths written with `unit` (e.g. "mm", "in"). */
export function gearMeshRefusalText(
  refusal: GearMeshRefusal,
  unit: string
): string {
  const clearance = refusal.clearance;
  if (refusal.code !== 'gear-mesh:tip-clearance' || !clearance)
    return refusal.message;
  const who =
    clearance.gear === 'base'
      ? 'The gear that stays put'
      : 'The gear that meshes with it';
  const by = String(Number(clearance.overlap.toPrecision(6)));
  return `${who} reaches ${by} ${unit} past the other gear’s root circle at this centre distance; shorten its addendum, deepen the other’s dedendum or reduce the profile shift.`;
}

export function isGearMeshRefusal(
  value: GearMeshSolution | GearMeshRefusal | GearMeshGear
): value is GearMeshRefusal {
  return 'code' in value && 'message' in value;
}
