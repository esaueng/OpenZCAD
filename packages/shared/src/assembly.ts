import type { BodyId, Vector3 } from './index';

/**
 * AS01/AS02/AS06/AS07 assemblies (schema v54). Canonical user content: which
 * bodies take part as components, which component is grounded, the joints
 * between them with their current values and limits, saved positions and
 * motion studies. A rebuild never reads it: moving a component only changes
 * its display placement, never the modelled solid. Schema v56 adds
 * `couplings`: linear relations between two joint values (meshed gears, a
 * rack and its pinion).
 *
 * Units: lengths in millimetres, angles in degrees (as `rotationDeg`).
 * Placements and frames are in the modelled coordinates of the component's
 * body, so the identity placement shows a body where it was modelled.
 */

export type AssemblyJointKind =
  'rigid' | 'revolute' | 'slider' | 'cylindrical' | 'ball' | 'planar';

export const ASSEMBLY_JOINT_KINDS: readonly AssemblyJointKind[] = [
  'rigid',
  'revolute',
  'slider',
  'cylindrical',
  'ball',
  'planar'
];

export type AssemblyDofUnit = 'deg' | 'mm';

/**
 * Each joint kind's free values, in order. All motion is expressed in the
 * parent frame: revolute turns about its Z axis, slider slides along Z,
 * cylindrical turns about and slides along Z, ball turns about Z then Y then
 * X (intrinsic), planar slides along X and Y and turns about Z.
 */
export const ASSEMBLY_JOINT_DOFS: Readonly<
  Record<AssemblyJointKind, readonly AssemblyDofUnit[]>
> = {
  rigid: [],
  revolute: ['deg'],
  slider: ['mm'],
  cylindrical: ['deg', 'mm'],
  ball: ['deg', 'deg', 'deg'],
  planar: ['mm', 'mm', 'deg']
};

/** Unit quaternion, three.js component order. */
export interface AssemblyQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** A rigid motion: rotate, then translate (mm). */
export interface AssemblyPlacement {
  translation: Vector3;
  rotation: AssemblyQuaternion;
}

/**
 * A right-handed orthonormal frame in a component's modelled coordinates.
 * Y is Z × X and is not stored.
 */
export interface AssemblyFrame {
  origin: Vector3;
  zAxis: Vector3;
  xAxis: Vector3;
}

export type AssemblyFrameSourceKind =
  'circle' | 'cylinder' | 'plane' | 'line' | 'vertex' | 'body';

/** Where a joint frame was picked; for display and later re-resolution. */
export interface AssemblyFrameSource {
  kind: AssemblyFrameSourceKind;
  /** Short human description, e.g. "Hole edge · centre". */
  label: string;
}

export interface AssemblyJointEnd {
  componentId: string;
  frame: AssemblyFrame;
  source?: AssemblyFrameSource;
}

export interface AssemblyDofLimit {
  min: number;
  max: number;
}

export interface AssemblyJoint {
  id: string;
  name: string;
  kind: AssemblyJointKind;
  parent: AssemblyJointEnd;
  child: AssemblyJointEnd;
  /** Current value per free motion, in {@link ASSEMBLY_JOINT_DOFS} order. */
  values: number[];
  /** Per free motion; null leaves that motion unlimited. */
  limits: (AssemblyDofLimit | null)[];
}

export interface AssemblyComponent {
  id: string;
  name: string;
  /**
   * The body this component shows. When a later feature remakes the body
   * under a new id (a fillet's result), the component follows that lineage.
   */
  bodyId: BodyId;
  grounded: boolean;
  /**
   * Where the component sits. Grounded and free components keep it; a
   * component placed through joints has it recomputed from its joints.
   */
  placement: AssemblyPlacement;
}

/** A saved set of joint values ("Open", "Closed"). */
export interface AssemblyPosition {
  id: string;
  name: string;
  values: Record<string, number[]>;
}

export type AssemblyEasing = 'linear' | 'ease';
export type AssemblyPlayback = 'once' | 'loop' | 'ping-pong';

export interface AssemblyKeyframe {
  /** Seconds from the study's start. */
  t: number;
  value: number;
  /** How the value travels from the previous key into this one. */
  easing: AssemblyEasing;
}

export interface AssemblyTrack {
  jointId: string;
  /** Index into the joint's free values. */
  dof: number;
  /** Strictly increasing in time. */
  keys: AssemblyKeyframe[];
}

export interface AssemblyMotionStudy {
  id: string;
  name: string;
  durationS: number;
  playback: AssemblyPlayback;
  tracks: AssemblyTrack[];
}

/** One free motion of a joint: an index into its values. */
export interface AssemblyCouplingEnd {
  jointId: string;
  /** Index into the joint's free values ({@link ASSEMBLY_JOINT_DOFS}). */
  dof: number;
}

/**
 * Two joint motions that move together (schema v56): meshed gears, a rack
 * and its pinion. A linear relation between their values,
 *
 *   driven = ratio × driver + offset
 *
 * each in its own unit (degrees or the assembly's length unit), so an
 * external gear pair has ratio −z₁/z₂ (deg/deg) and a rack has its pinion's
 * pitch radius × π/180 (length per degree). The offset holds the phase the
 * pair was coupled at. Either side can be moved: the relation is solved
 * both ways, and both joints' limits bound the pair.
 */
export interface AssemblyCoupling {
  id: string;
  name: string;
  driver: AssemblyCouplingEnd;
  driven: AssemblyCouplingEnd;
  /** Never zero: the relation must run both ways. */
  ratio: number;
  offset: number;
  /**
   * The two gear parts the coupling was placed for (Place gears), in the
   * driver's and the driven joint's order. A gear need not be an end of its
   * joint: it may ride it through a rigid joint (a gear keyed to its shaft)
   * and share it with another gear, so the pair is recorded rather than
   * looked for. It lets the ratio be checked against the gears' teeth
   * later. Absent on a coupling that was not made from a gear pair. The
   * coupling goes when either part leaves the assembly.
   */
  gears?: AssemblyCouplingGears;
}

/** Component ids of a coupled gear pair. */
export interface AssemblyCouplingGears {
  driver: string;
  driven: string;
}

export interface AssemblySet {
  /** Display order. */
  components: AssemblyComponent[];
  joints: AssemblyJoint[];
  positions: AssemblyPosition[];
  studies: AssemblyMotionStudy[];
  /**
   * Schema v56. Absent means none, so a v54 assembly reads unchanged. The
   * couplings never form a loop: any two motions are linked at most one way.
   */
  couplings?: AssemblyCoupling[];
}

export type AssemblyUnsolvedReason =
  /** Both ends were already placed: the joint closes a loop (AS09). */
  | 'loop'
  /** Both ends are grounded, so the joint can never move. */
  | 'grounded-both';

/**
 * The joints the tree solve cannot move. A spanning forest in joint order
 * (Kruskal over a ground super-node, every grounded component counting as
 * one fixed body), so the joint that closes a loop is the one added last,
 * whatever the traversal order. Graph only: no frames, no values. A joint
 * naming a missing component is left out.
 */
export function unsolvedAssemblyJoints(
  set: Pick<AssemblySet, 'components' | 'joints'>
): Map<string, AssemblyUnsolvedReason> {
  const unsolved = new Map<string, AssemblyUnsolvedReason>();
  const GROUND = '\u0000ground';
  const grounded = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const c of set.components) {
    if (c.grounded) grounded.add(c.id);
    parentOf.set(c.id, c.grounded ? GROUND : c.id);
  }
  parentOf.set(GROUND, GROUND);
  const find = (id: string): string => {
    let root = id;
    for (;;) {
      const next = parentOf.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    parentOf.set(id, root);
    return root;
  };
  for (const joint of set.joints) {
    const a = joint.parent.componentId;
    const b = joint.child.componentId;
    if (!parentOf.has(a) || !parentOf.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) {
      unsolved.set(
        joint.id,
        grounded.has(a) && grounded.has(b) ? 'grounded-both' : 'loop'
      );
      continue;
    }
    parentOf.set(ra === GROUND ? rb : ra, ra === GROUND ? ra : rb);
  }
  return unsolved;
}

export const MAX_ASSEMBLY_COMPONENTS = 500;
export const MAX_ASSEMBLY_JOINTS = 1000;
export const MAX_ASSEMBLY_POSITIONS = 100;
export const MAX_ASSEMBLY_STUDIES = 50;
export const MAX_ASSEMBLY_TRACKS = 200;
export const MAX_ASSEMBLY_KEYS = 500;
export const MAX_ASSEMBLY_COUPLINGS = 1000;
/** Smallest coupling ratio magnitude; below it the relation cannot run back. */
export const MIN_ASSEMBLY_COUPLING_RATIO = 1e-9;
export const MAX_ASSEMBLY_NAME_LENGTH = 120;
export const MAX_ASSEMBLY_STUDY_SECONDS = 3600;
/** Largest stored length or angle magnitude; keeps arithmetic finite. */
export const MAX_ASSEMBLY_MAGNITUDE = 1e9;
/** Unit-length and orthogonality tolerance for stored frames and rotations. */
export const ASSEMBLY_UNIT_TOLERANCE = 1e-6;
const MAX_ASSEMBLY_ID_LENGTH = 64;

export function emptyAssemblySet(): AssemblySet {
  return { components: [], joints: [], positions: [], studies: [] };
}

export function isAssemblySetEmpty(set: AssemblySet): boolean {
  return (
    set.components.length === 0 &&
    set.joints.length === 0 &&
    set.positions.length === 0 &&
    set.studies.length === 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ASSEMBLY_ID_LENGTH
  );
}

function isName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value === value.trim() &&
    value.length <= MAX_ASSEMBLY_NAME_LENGTH
  );
}

function isNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_ASSEMBLY_MAGNITUDE
  );
}

function isVector(value: unknown): value is Vector3 {
  return (
    isRecord(value) &&
    isNumber(value.x) &&
    isNumber(value.y) &&
    isNumber(value.z)
  );
}

function length3(v: Vector3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function isUnitVector(value: unknown): value is Vector3 {
  return (
    isVector(value) && Math.abs(length3(value) - 1) <= ASSEMBLY_UNIT_TOLERANCE
  );
}

function placementError(value: unknown): string | null {
  if (!isRecord(value) || !isVector(value.translation))
    return 'has no placement.';
  const q = value.rotation;
  if (
    !isRecord(q) ||
    !isNumber(q.x) ||
    !isNumber(q.y) ||
    !isNumber(q.z) ||
    !isNumber(q.w) ||
    Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > ASSEMBLY_UNIT_TOLERANCE
  )
    return 'has a placement rotation that is not a unit quaternion.';
  return null;
}

function frameError(value: unknown): string | null {
  if (!isRecord(value) || !isVector(value.origin))
    return 'has a frame without an origin.';
  if (!isUnitVector(value.zAxis) || !isUnitVector(value.xAxis))
    return 'has a frame whose axes are not unit length.';
  const z = value.zAxis;
  const x = value.xAxis;
  if (Math.abs(z.x * x.x + z.y * x.y + z.z * x.z) > ASSEMBLY_UNIT_TOLERANCE)
    return 'has a frame whose axes are not perpendicular.';
  return null;
}

const FRAME_SOURCE_KINDS: readonly AssemblyFrameSourceKind[] = [
  'circle',
  'cylinder',
  'plane',
  'line',
  'vertex',
  'body'
];

function jointEndError(
  value: unknown,
  componentIds: Set<string>
): string | null {
  if (!isRecord(value) || !isId(value.componentId))
    return 'has an end without a component.';
  if (!componentIds.has(value.componentId))
    return `joins component ${value.componentId}, which does not exist.`;
  const frame = frameError(value.frame);
  if (frame) return frame;
  if (value.source !== undefined) {
    const source = value.source;
    if (
      !isRecord(source) ||
      !FRAME_SOURCE_KINDS.includes(source.kind as AssemblyFrameSourceKind) ||
      typeof source.label !== 'string' ||
      source.label.length > MAX_ASSEMBLY_NAME_LENGTH
    )
      return 'has a malformed frame source.';
  }
  return null;
}

function valuesError(
  values: unknown,
  count: number,
  what: string
): string | null {
  if (!Array.isArray(values) || values.length !== count)
    return `${what} needs ${count} value${count === 1 ? '' : 's'}.`;
  if (!values.every(isNumber))
    return `${what} has a value that is not a number.`;
  return null;
}

function jointError(value: unknown, componentIds: Set<string>): string | null {
  if (!isRecord(value) || !isId(value.id))
    return 'An assembly joint has no id.';
  const id = value.id;
  if (!isName(value.name)) return `Joint ${id} has no usable name.`;
  if (!ASSEMBLY_JOINT_KINDS.includes(value.kind as AssemblyJointKind))
    return `Joint ${id} has an unknown kind.`;
  const dofs = ASSEMBLY_JOINT_DOFS[value.kind as AssemblyJointKind];
  for (const side of ['parent', 'child'] as const) {
    const error = jointEndError(value[side], componentIds);
    if (error) return `Joint ${id} ${error}`;
  }
  const parent = value.parent as AssemblyJointEnd;
  const child = value.child as AssemblyJointEnd;
  if (parent.componentId === child.componentId)
    return `Joint ${id} joins a component to itself.`;
  const values = valuesError(value.values, dofs.length, `Joint ${id}`);
  if (values) return values;
  if (!Array.isArray(value.limits) || value.limits.length !== dofs.length)
    return `Joint ${id} needs one limit entry per free motion.`;
  for (const [index, limit] of value.limits.entries()) {
    if (limit === null) continue;
    if (!isRecord(limit) || !isNumber(limit.min) || !isNumber(limit.max))
      return `Joint ${id} has a malformed limit.`;
    if (limit.min > limit.max)
      return `Joint ${id} has a limit with min above max.`;
    const current = (value.values as number[])[index] as number;
    if (current < limit.min || current > limit.max)
      return `Joint ${id} sits outside its limits.`;
  }
  return null;
}

function studyError(
  value: unknown,
  joints: Map<string, AssemblyJointKind>
): string | null {
  if (!isRecord(value) || !isId(value.id)) return 'A motion study has no id.';
  const id = value.id;
  if (!isName(value.name)) return `Motion study ${id} has no usable name.`;
  if (
    !isNumber(value.durationS) ||
    value.durationS <= 0 ||
    value.durationS > MAX_ASSEMBLY_STUDY_SECONDS
  )
    return `Motion study ${id} has an unusable duration.`;
  if (!['once', 'loop', 'ping-pong'].includes(value.playback as string))
    return `Motion study ${id} has an unknown playback mode.`;
  if (!Array.isArray(value.tracks) || value.tracks.length > MAX_ASSEMBLY_TRACKS)
    return `Motion study ${id} has a malformed track list.`;
  const seen = new Set<string>();
  for (const track of value.tracks) {
    if (!isRecord(track) || !isId(track.jointId))
      return `Motion study ${id} has a track without a joint.`;
    const kind = joints.get(track.jointId);
    if (!kind) return `Motion study ${id} drives a joint that does not exist.`;
    const dofCount = ASSEMBLY_JOINT_DOFS[kind].length;
    if (
      typeof track.dof !== 'number' ||
      !Number.isInteger(track.dof) ||
      track.dof < 0 ||
      track.dof >= dofCount
    )
      return `Motion study ${id} drives a motion its joint does not have.`;
    const key = `${track.jointId}/${track.dof}`;
    if (seen.has(key)) return `Motion study ${id} drives one motion twice.`;
    seen.add(key);
    if (
      !Array.isArray(track.keys) ||
      track.keys.length === 0 ||
      track.keys.length > MAX_ASSEMBLY_KEYS
    )
      return `Motion study ${id} has a track without keys.`;
    let previous = -Infinity;
    for (const k of track.keys) {
      if (!isRecord(k) || !isNumber(k.t) || !isNumber(k.value))
        return `Motion study ${id} has a malformed key.`;
      if (k.easing !== 'linear' && k.easing !== 'ease')
        return `Motion study ${id} has a key with an unknown easing.`;
      if (k.t < 0 || k.t > value.durationS)
        return `Motion study ${id} has a key outside its duration.`;
      if (k.t <= previous) return `Motion study ${id} has keys out of order.`;
      previous = k.t;
    }
  }
  return null;
}

/** Why a value is not a valid assembly section, or null when it is one. */
export function assemblySetError(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.components) ||
    !Array.isArray(value.joints) ||
    !Array.isArray(value.positions) ||
    !Array.isArray(value.studies)
  )
    return 'The assembly section is malformed.';
  if (value.components.length > MAX_ASSEMBLY_COMPONENTS)
    return `An assembly holds at most ${MAX_ASSEMBLY_COMPONENTS} components.`;
  if (value.joints.length > MAX_ASSEMBLY_JOINTS)
    return `An assembly holds at most ${MAX_ASSEMBLY_JOINTS} joints.`;
  if (value.positions.length > MAX_ASSEMBLY_POSITIONS)
    return `An assembly holds at most ${MAX_ASSEMBLY_POSITIONS} positions.`;
  if (value.studies.length > MAX_ASSEMBLY_STUDIES)
    return `An assembly holds at most ${MAX_ASSEMBLY_STUDIES} motion studies.`;

  const componentIds = new Set<string>();
  const bodies = new Set<string>();
  for (const component of value.components) {
    if (!isRecord(component) || !isId(component.id))
      return 'An assembly component has no id.';
    const id = component.id;
    if (componentIds.has(id)) return `Component ${id} is listed twice.`;
    componentIds.add(id);
    if (!isName(component.name)) return `Component ${id} has no usable name.`;
    if (!isId(component.bodyId)) return `Component ${id} has no body.`;
    if (bodies.has(component.bodyId))
      return `Body ${component.bodyId} is in the assembly twice.`;
    bodies.add(component.bodyId);
    if (typeof component.grounded !== 'boolean')
      return `Component ${id} has no grounded state.`;
    const placement = placementError(component.placement);
    if (placement) return `Component ${id} ${placement}`;
  }

  const joints = new Map<string, AssemblyJointKind>();
  const pairs = new Set<string>();
  for (const joint of value.joints) {
    const error = jointError(joint, componentIds);
    if (error) return error;
    const j = joint as AssemblyJoint;
    if (joints.has(j.id)) return `Joint ${j.id} is listed twice.`;
    joints.set(j.id, j.kind);
    const pair = [j.parent.componentId, j.child.componentId].sort().join('|');
    if (pairs.has(pair))
      return `Joint ${j.id} joins two components that are already joined.`;
    pairs.add(pair);
  }

  const positionIds = new Set<string>();
  for (const position of value.positions) {
    if (!isRecord(position) || !isId(position.id))
      return 'A saved position has no id.';
    if (positionIds.has(position.id))
      return `Position ${position.id} is listed twice.`;
    positionIds.add(position.id);
    if (!isName(position.name))
      return `Position ${position.id} has no usable name.`;
    if (!isRecord(position.values))
      return `Position ${position.id} has no values.`;
    for (const [jointId, values] of Object.entries(position.values)) {
      const kind = joints.get(jointId);
      if (!kind)
        return `Position ${position.id} sets a joint that does not exist.`;
      const error = valuesError(
        values,
        ASSEMBLY_JOINT_DOFS[kind].length,
        `Position ${position.id}`
      );
      if (error) return error;
    }
  }

  const studyIds = new Set<string>();
  for (const study of value.studies) {
    const error = studyError(study, joints);
    if (error) return error;
    const id = (study as AssemblyMotionStudy).id;
    if (studyIds.has(id)) return `Motion study ${id} is listed twice.`;
    studyIds.add(id);
  }
  return couplingsError(
    value.couplings,
    joints,
    value as unknown as AssemblySet
  );
}

/** The key one joint motion has in a coupling graph. */
export function couplingEndKey(end: AssemblyCouplingEnd): string {
  return `${end.jointId}/${end.dof}`;
}

/**
 * Why a coupling list is malformed, or null. Structure only: which motions
 * exist, a usable ratio, no loop, and no joint the solve can never move
 * (grounding both of its parts after it was coupled would leave its mate
 * turning alone). Whether the joints' limits leave the pair a shared
 * position is judged where they are edited (`couplingAddError`), since a
 * limit is not part of this list.
 */
function couplingsError(
  value: unknown,
  joints: Map<string, AssemblyJointKind>,
  set: Pick<AssemblySet, 'components' | 'joints'>
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'The assembly couplings are malformed.';
  if (value.length > MAX_ASSEMBLY_COUPLINGS)
    return `An assembly holds at most ${MAX_ASSEMBLY_COUPLINGS} couplings.`;
  const ids = new Set<string>();
  const group = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    for (;;) {
      const next = group.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    group.set(key, root);
    return root;
  };
  for (const coupling of value) {
    if (!isRecord(coupling) || !isId(coupling.id))
      return 'An assembly coupling has no id.';
    const id = coupling.id;
    if (ids.has(id)) return `Coupling ${id} is listed twice.`;
    ids.add(id);
    if (!isName(coupling.name)) return `Coupling ${id} has no usable name.`;
    for (const side of ['driver', 'driven'] as const) {
      const end = coupling[side];
      if (!isRecord(end) || !isId(end.jointId))
        return `Coupling ${id} has an end without a joint.`;
      const kind = joints.get(end.jointId);
      if (!kind) return `Coupling ${id} links a joint that does not exist.`;
      if (
        typeof end.dof !== 'number' ||
        !Number.isInteger(end.dof) ||
        end.dof < 0 ||
        end.dof >= ASSEMBLY_JOINT_DOFS[kind].length
      )
        return `Coupling ${id} links a motion its joint does not have.`;
    }
    const driver = coupling.driver as AssemblyCouplingEnd;
    const driven = coupling.driven as AssemblyCouplingEnd;
    if (driver.jointId === driven.jointId)
      return `Coupling ${id} links a joint to itself.`;
    if (
      !isNumber(coupling.ratio) ||
      Math.abs(coupling.ratio) < MIN_ASSEMBLY_COUPLING_RATIO
    )
      return `Coupling ${id} has an unusable ratio.`;
    if (!isNumber(coupling.offset))
      return `Coupling ${id} has an offset that is not a number.`;
    if (coupling.gears !== undefined) {
      const gears = coupling.gears;
      if (!isRecord(gears) || !isId(gears.driver) || !isId(gears.driven))
        return `Coupling ${id} has a malformed gear pair.`;
      if (gears.driver === gears.driven)
        return `Coupling ${id} names one gear twice.`;
      for (const componentId of [gears.driver, gears.driven])
        if (!set.components.some((c) => c.id === componentId))
          return `Coupling ${id} names gear ${componentId}, which is not in the assembly.`;
    }
    const a = find(couplingEndKey(driver));
    const b = find(couplingEndKey(driven));
    if (a === b)
      return `Coupling ${id} links two motions that are already coupled.`;
    group.set(a, b);
  }
  if (value.length > 0) {
    const unsolved = unsolvedAssemblyJoints(set);
    for (const coupling of value as AssemblyCoupling[])
      for (const end of [coupling.driver, coupling.driven])
        if (unsolved.has(end.jointId))
          return `Coupling ${coupling.id} links joint ${end.jointId}, which cannot move.`;
  }
  return null;
}

/** Fails closed on a malformed assembly section; absent is valid. */
export function assertAssemblySet(value: unknown): void {
  if (value === undefined) return;
  const error = assemblySetError(value);
  if (error) throw new Error(error);
}
