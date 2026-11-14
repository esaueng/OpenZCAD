import {
  asBuiltChildFrame,
  frameFromAxis,
  frameInLocal,
  jointAddError,
  solveAssembly,
  transformPoint,
  type AssemblyDofLimit,
  type AssemblyJoint,
  type AssemblyJointKind,
  type AssemblyPlayback,
  type AssemblySet,
  type AssemblySolution,
  type BodyId,
  type RigidTransform,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import { ANIMATE_SPEEDS, assemblyLengthScale } from './assemblyUi';

/**
 * Set up motion (AS02/AS06): the quick way to make one part move against a
 * fixed base without picking joint geometry. The user chooses the base, the
 * part that moves, slide or turn, a world axis, the range and the cycle; the
 * result is an ordinary as-built slider or revolute joint whose frames sit
 * on that axis through the moving part's centre, so its current pose is
 * value 0 and nothing jumps. Pure: the card and the tests share it.
 */

export type MotionSetupMove = 'slide' | 'turn';
export type MotionSetupAxis = 'x' | 'y' | 'z';

export interface MotionSetupDraft {
  /** The part that stays put; grounded on Create when nothing places it. */
  baseId: string | null;
  /** The part that moves. */
  movingId: string | null;
  move: MotionSetupMove;
  axis: MotionSetupAxis;
  /** Runs the motion the other way along (or about) the axis. */
  reverse: boolean;
  /** Joint units: the document's length unit for a slide, degrees for a turn. */
  range: AssemblyDofLimit;
  mode: AssemblyPlayback;
  /** Seconds for one sweep across the range. */
  sweepS: number;
}

/** A body's box in its own modelled coordinates (before any placement). */
export interface MotionSetupBox {
  min: Vector3;
  max: Vector3;
}

export type MotionSetupBounds = (bodyId: BodyId) => MotionSetupBox | null;

export const MOTION_SETUP_AXES: readonly MotionSetupAxis[] = ['x', 'y', 'z'];

/** Set up motion's speeds: the same named speeds as a joint's Play. */
export const MOTION_SETUP_SWEEPS = ANIMATE_SPEEDS;

/** Used when the base's size along the axis is unknown (a mm project). */
export const DEFAULT_SLIDE_TRAVEL_MM = 50;
export const DEFAULT_TURN_RANGE_DEG: AssemblyDofLimit = { min: 0, max: 90 };

const AXIS_VECTORS: Readonly<Record<MotionSetupAxis, Vector3>> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 }
};

export function motionSetupJointKind(
  move: MotionSetupMove
): Extract<AssemblyJointKind, 'slider' | 'revolute'> {
  return move === 'slide' ? 'slider' : 'revolute';
}

export function motionSetupAxisVector(
  axis: MotionSetupAxis,
  reverse: boolean
): Vector3 {
  const v = AXIS_VECTORS[axis];
  return reverse ? { x: -v.x, y: -v.y, z: -v.z } : { ...v };
}

function boxCorners(box: MotionSetupBox): Vector3[] {
  const corners: Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) corners.push({ x, y, z });
  return corners;
}

function validBox(box: MotionSetupBox | null): box is MotionSetupBox {
  if (!box) return false;
  return [
    box.min.x,
    box.min.y,
    box.min.z,
    box.max.x,
    box.max.y,
    box.max.z
  ].every(Number.isFinite);
}

/** A box's centre where its component is placed now, in world coordinates. */
export function placedBoxCentre(
  pose: RigidTransform,
  box: MotionSetupBox
): Vector3 {
  return transformPoint(pose, {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2
  });
}

/** How far a placed box reaches along a world axis, in model units. */
export function placedBoxExtent(
  pose: RigidTransform,
  box: MotionSetupBox,
  axis: MotionSetupAxis
): number {
  let min = Infinity;
  let max = -Infinity;
  for (const corner of boxCorners(box)) {
    const value = transformPoint(pose, corner)[axis];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min;
}

/**
 * The default slide: far enough to lift the moving part clear of its base —
 * the base's size along the axis, rounded up to 5 mm (¼ in) — or 50 mm (2 in)
 * when that size is not known. A part sitting in a holder slides out of it.
 * Model coordinates are in the document's unit, so the steps follow it.
 */
export function defaultSlideTravel(
  basePose: RigidTransform | undefined,
  baseBox: MotionSetupBox | null,
  axis: MotionSetupAxis,
  lengthUnit: UnitSystem = 'mm'
): number {
  const scale = assemblyLengthScale(lengthUnit);
  if (!basePose || !validBox(baseBox)) return scale.travel;
  const extent = placedBoxExtent(basePose, baseBox, axis);
  if (!(extent > 0)) return scale.travel;
  const steps = Math.ceil(extent / scale.round - 1e-9);
  const travel = Math.min(200, Math.max(1, steps)) * scale.round;
  // 0.25 × 3 is 0.75, not 0.7500000000000001.
  return Number(travel.toFixed(scale.decimals + 2));
}

export interface MotionSetupContext {
  set: AssemblySet;
  /** The saved solution (no transient values). */
  solution: AssemblySolution;
  /** The live body a component shows (follows the body's lineage). */
  bodyOf(componentId: string): BodyId | null;
  bounds?: MotionSetupBounds;
  /** The document's unit; absent reads as mm. */
  lengthUnit?: UnitSystem;
}

function componentBox(
  context: MotionSetupContext,
  componentId: string | null
): MotionSetupBox | null {
  if (!componentId || !context.bounds) return null;
  const bodyId = context.bodyOf(componentId);
  const box = bodyId ? context.bounds(bodyId) : null;
  return validBox(box) ? box : null;
}

/** The default range for a move: lift clear of the base, or a quarter turn. */
export function defaultMotionRange(
  context: MotionSetupContext,
  draft: Pick<MotionSetupDraft, 'baseId' | 'move' | 'axis'>
): AssemblyDofLimit {
  if (draft.move === 'turn') return { ...DEFAULT_TURN_RANGE_DEG };
  const pose = draft.baseId
    ? context.solution.poses.get(draft.baseId)
    : undefined;
  return {
    min: 0,
    max: defaultSlideTravel(
      pose,
      componentBox(context, draft.baseId),
      draft.axis,
      context.lengthUnit
    )
  };
}

/**
 * The parts Set up motion can move against a base: not the base, not fixed,
 * and not already moved by a joint — a second joint would close a loop, and
 * one between the same two parts is refused outright. The way to change an
 * existing motion is that joint's own controls.
 */
export function motionSetupMovers(
  context: Pick<MotionSetupContext, 'set' | 'solution'>,
  baseId: string | null
): AssemblySet['components'] {
  const { set, solution } = context;
  return set.components.filter(
    (c) =>
      c.id !== baseId &&
      !c.grounded &&
      (solution.roles.get(c.id) ?? 'free') === 'free' &&
      (baseId === null || jointAddError(set, baseId, c.id) === null)
  );
}

/**
 * Why Set up motion has nothing to offer, or null when it does: every part
 * is fixed or already moves on a joint.
 */
export function motionSetupUnavailableReason(
  context: Pick<MotionSetupContext, 'set' | 'solution'>
): string | null {
  const { set } = context;
  if (set.components.length < 2) return 'Add a second part to move it.';
  const anyMover = set.components.some(
    (base) => motionSetupMovers(context, base.id).length > 0
  );
  if (anyMover) return null;
  return set.joints.length > 0
    ? 'Every part is fixed or already moves on a joint. Open a joint to change its motion.'
    : 'Every part is fixed. Unfix one to make it move.';
}

/**
 * Where a new setup starts: the fixed part as the base, the first part that
 * is not joined yet as the one that moves, sliding up Z clear of the base and
 * back, as one lifts a tool out of its holder. When the fixed part has no
 * part left to move against it, the first base that does is chosen instead.
 */
export function defaultMotionSetup(
  context: MotionSetupContext
): MotionSetupDraft {
  const { set } = context;
  const preferred =
    set.components.find((c) => c.grounded) ?? set.components[0] ?? null;
  const bases = [
    ...(preferred ? [preferred] : []),
    ...set.components.filter((c) => c.id !== preferred?.id)
  ];
  const base =
    bases.find((c) => motionSetupMovers(context, c.id).length > 0) ?? preferred;
  const moving =
    motionSetupMovers(context, base?.id ?? null)[0] ??
    set.components.find((c) => c.id !== base?.id && !c.grounded) ??
    set.components.find((c) => c.id !== base?.id) ??
    null;
  const draft = {
    baseId: base?.id ?? null,
    movingId: moving?.id ?? null,
    move: 'slide' as const,
    axis: 'z' as const
  };
  return {
    ...draft,
    reverse: false,
    range: defaultMotionRange(context, draft),
    mode: 'ping-pong',
    sweepS: 1.5
  };
}

const AXIS_LABEL: Readonly<Record<MotionSetupAxis, string>> = {
  x: 'X',
  y: 'Y',
  z: 'Z'
};

export function motionSetupAxisLabel(axis: MotionSetupAxis): string {
  return AXIS_LABEL[axis];
}

export interface MotionSetupResult {
  joint: AssemblyJoint;
  /** The base floats today: Create fixes it first so the motion has ground. */
  groundBase: boolean;
}

function nameOf(set: AssemblySet, componentId: string | null): string {
  return set.components.find((c) => c.id === componentId)?.name ?? 'The part';
}

/** "Lid slide", "Lid slide 2"…: an unused joint name. */
export function motionSetupJointName(
  set: AssemblySet,
  draft: Pick<MotionSetupDraft, 'movingId' | 'move'>
): string {
  const base = `${nameOf(set, draft.movingId).slice(0, 60).trim()} ${draft.move}`;
  const names = new Set(set.joints.map((j) => j.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1)
    if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/**
 * The joint a setup makes, or why it cannot. As-built: both frames sit on
 * the chosen world axis through the moving part's centre (its placed box),
 * so the parts stay where they are and the current pose is value 0.
 */
export function motionSetupJoint(
  context: MotionSetupContext,
  draft: MotionSetupDraft,
  id: string,
  name = motionSetupJointName(context.set, draft)
): MotionSetupResult | { error: string } {
  const { set, solution } = context;
  const base = set.components.find((c) => c.id === draft.baseId);
  const moving = set.components.find((c) => c.id === draft.movingId);
  if (!base) return { error: 'Choose the part that stays put.' };
  if (!moving) return { error: 'Choose the part that moves.' };
  if (base.id === moving.id)
    return { error: 'The moving part must be a different part from the base.' };
  if (moving.grounded)
    return {
      error: `${moving.name} is fixed in place. Unfix it, or choose another part to move.`
    };
  const { min, max } = draft.range;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min))
    return { error: 'Give the motion a range: “to” must be more than “from”.' };
  const refusal = jointAddError(set, base.id, moving.id);
  if (refusal) return { error: refusal };
  const basePose = solution.poses.get(base.id);
  const movingPose = solution.poses.get(moving.id);
  if (!basePose || !movingPose) return { error: 'Those parts are not placed.' };

  const box = componentBox(context, moving.id);
  const origin = box ? placedBoxCentre(movingPose, box) : { ...movingPose.t };
  const world = frameFromAxis(
    origin,
    motionSetupAxisVector(draft.axis, draft.reverse)
  );
  if (!world) return { error: 'That axis has no direction.' };
  const kind = motionSetupJointKind(draft.move);
  const parentFrame = frameInLocal(basePose, world);
  const childFrame = asBuiltChildFrame(basePose, parentFrame, movingPose, kind);
  const source = {
    kind: 'body' as const,
    label: `${motionSetupAxisLabel(draft.axis)} axis · part centre`
  };
  const joint: AssemblyJoint = {
    id,
    name,
    kind,
    parent: { componentId: base.id, frame: parentFrame, source },
    child: { componentId: moving.id, frame: childFrame, source },
    values: [Math.min(max, Math.max(min, 0))],
    limits: [{ min, max }]
  };
  const groundBase =
    !base.grounded && (solution.roles.get(base.id) ?? 'free') === 'free';
  const trial: AssemblySet = {
    ...set,
    components: groundBase
      ? set.components.map((c) =>
          c.id === base.id ? { ...c, grounded: true } : c
        )
      : set.components,
    joints: [...set.joints, joint]
  };
  if (solveAssembly(trial).unsolved.has(id)) {
    const link = solution.links.get(moving.id);
    const via = link
      ? set.joints.find((j) => j.id === link.jointId)?.name
      : undefined;
    return {
      error: via
        ? `${moving.name} already moves on ${via}. Open that joint to change its motion.`
        : `${moving.name} and ${base.name} are already connected, so this would close a loop.`
    };
  }
  return { joint, groundBase };
}

/**
 * Body boxes from the built display meshes, computed once per body for one
 * set of representations (mesh vertices are in modelled coordinates).
 */
export function meshBoundsLookup(
  representations: Readonly<
    Record<string, { mesh?: { vertices?: ArrayLike<number> } } | undefined>
  >
): MotionSetupBounds {
  const cache = new Map<BodyId, MotionSetupBox | null>();
  return (bodyId) => {
    const cached = cache.get(bodyId);
    if (cached !== undefined) return cached;
    const vertices = representations[bodyId]?.mesh?.vertices;
    let box: MotionSetupBox | null = null;
    if (vertices && vertices.length >= 3) {
      const min = { x: Infinity, y: Infinity, z: Infinity };
      const max = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (let index = 0; index + 2 < vertices.length; index += 3) {
        const x = vertices[index] as number;
        const y = vertices[index + 1] as number;
        const z = vertices[index + 2] as number;
        if (x < min.x) min.x = x;
        if (y < min.y) min.y = y;
        if (z < min.z) min.z = z;
        if (x > max.x) max.x = x;
        if (y > max.y) max.y = y;
        if (z > max.z) max.z = z;
      }
      box = validBox({ min, max }) ? { min, max } : null;
    }
    cache.set(bodyId, box);
    return box;
  };
}
