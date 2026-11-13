import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  ASSEMBLY_COINCIDENT_ANGULAR_TOLERANCE,
  ASSEMBLY_COINCIDENT_LINEAR_TOLERANCE,
  couplingAddError,
  createId,
  cross3,
  dot3,
  frameInLocal,
  frameInWorld,
  gearMeshFrame,
  jointAddError,
  jointDofCount,
  solveAssembly,
  type AssemblyComponent,
  type AssemblyCoupling,
  type AssemblyDofLimit,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblySet,
  type AssemblySolution,
  type GearMeshGear,
  type GearMeshSolution,
  type Vector3
} from '@openzcad/shared';
import type { AssembleWorkspaceApp } from './assembleWorkspace';
import { unitLabel } from '../measurements';
import { assemblyRuntime } from './assemblyRuntime';
import type { GearMeshContext, GearMeshDraft } from './gearMesh';
import {
  gearMeshErrorText,
  gearMeshPlacement,
  midFrame,
  type GearMeshJointError
} from './gearMeshJoint';

/**
 * Place gears, turning together (AS02 gear coupling). Meshed gears turn
 * about their own fixed axes, so each needs its own joint on the part the
 * pair is mounted on (a plate, a housing): a revolute joint on a gear's
 * axis through its mid-face, a slider along a rack's teeth. A coupling then
 * ties the two joint values at the pair's ratio, with the offset that holds
 * the tooth phase the helper placed them at.
 *
 * The ratio is the helper's own (`meshGearPair`): turns of the second gear
 * per turn of the first as the two rotation vectors compare, so −z₁/z₂ for
 * an external pair and +z₁/z₂ inside a ring; a rack travels its pinion's
 * pitch circumference per turn. Each joint measures its value about its own
 * axis, so the stored ratio also carries the two axis senses.
 *
 * When the first gear already turns on a joint about its axis (it was set
 * up earlier, or it is the next gear of a train) that joint is reused and
 * the second gear joins the same part. Loaded with the card.
 */

export type GearCouplingRefusalCode =
  /** No other part in the assembly to mount the pair on. */
  | 'gear-coupling:no-carrier'
  /** The chosen mount is missing or is one of the two gears. */
  | 'gear-coupling:carrier'
  /** The first gear is held still by a rigid joint. */
  | 'gear-coupling:base-held'
  /** The first gear moves on a joint that is not about its own axis. */
  | 'gear-coupling:base-joint'
  /** The new joints would close a loop, so one of them could never move. */
  | 'gear-coupling:loop'
  /** Nothing holds the mount still, so the gears would carry it instead. */
  | 'gear-coupling:floating';

export interface GearCouplingResult {
  mesh: GearMeshSolution;
  /** The part both joints attach the gears to. */
  carrierId: string;
  /** The mount floats today: Place fixes it first. */
  groundCarrier: boolean;
  /** The first gear is fixed today: Place lets it move on its new joint. */
  releaseBase: boolean;
  /** The first gear's new joint; null when it already moves on one. */
  baseJoint: AssemblyJoint | null;
  /** The joint that drives the coupling (new or reused). */
  driverJointId: string;
  /** The second gear's joint, which also places it in mesh. */
  joint: AssemblyJoint;
  coupling: AssemblyCoupling;
}

export interface GearCouplingIds {
  baseJointId: string;
  jointId: string;
  couplingId: string;
}

const isRack = (gear: GearMeshGear) => gear.gearType === 'rack';

function add(a: Vector3, b: Vector3, scale = 1): Vector3 {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

/**
 * The frame a gear moves on, in the coordinates `frame` is in: a turn about
 * its axis through its mid-face, or for a rack a slide along its teeth (its
 * x direction becomes the joint's Z).
 */
function motionFrame(gear: GearMeshGear, frame: AssemblyFrame): AssemblyFrame {
  return isRack(gear)
    ? {
        origin: { ...frame.origin },
        zAxis: { ...frame.xAxis },
        xAxis: { ...frame.zAxis }
      }
    : midFrame(frame, gear.faceWidth);
}

function unusedName(taken: Iterable<string>, base: string): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let n = 2; ; n += 1)
    if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** The parts a pair can be mounted on: every part but the two gears. */
export function gearCarrierChoices(
  context: GearMeshContext,
  draft: Pick<GearMeshDraft, 'baseId' | 'movingId'>
): AssemblyComponent[] {
  return context.set.components.filter(
    (c) => c.id !== draft.baseId && c.id !== draft.movingId
  );
}

/** The fixed part first, else the first other part. */
export function defaultGearCarrier(
  context: GearMeshContext,
  draft: Pick<GearMeshDraft, 'baseId' | 'movingId'>
): string | null {
  const choices = gearCarrierChoices(context, draft);
  return (choices.find((c) => c.grounded) ?? choices[0])?.id ?? null;
}

interface MovingJoint {
  joint: AssemblyJoint;
  /** The traversal reached the gear's side through the joint's child end. */
  forward: boolean;
  upstreamId: string;
}

/**
 * The joint a component moves on: the nearest joint with a free motion
 * between it and its root, through any rigid joints (a gear keyed to its
 * shaft). `held` names the rigid joint when nothing above it moves.
 */
function movingJointOf(
  set: AssemblySet,
  solution: AssemblySolution,
  componentId: string
): MovingJoint | { held: AssemblyJoint } | null {
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  let held: AssemblyJoint | null = null;
  const seen = new Set<string>();
  for (let at = componentId; !seen.has(at);) {
    seen.add(at);
    const link = solution.links.get(at);
    const joint = link ? joints.get(link.jointId) : undefined;
    if (!link || !joint) break;
    const upstreamId = link.forward
      ? joint.parent.componentId
      : joint.child.componentId;
    if (jointDofCount(joint.kind) > 0)
      return { joint, forward: link.forward, upstreamId };
    held ??= joint;
    at = upstreamId;
  }
  return held ? { held } : null;
}

/** The joint the first gear already moves on, and the part it is mounted on. */
export function gearBaseDrive(
  context: GearMeshContext,
  baseId: string | null
): { jointName: string; carrierId: string } | null {
  if (!baseId) return null;
  const found = movingJointOf(context.set, context.solution, baseId);
  return found && 'joint' in found
    ? { jointName: found.joint.name, carrierId: found.upstreamId }
    : null;
}

/**
 * The second gear's own motion per unit of the first's: degrees about its
 * axis per degree about the first's, or a rack's travel along its x
 * direction against its pinion's turn.
 */
function ownRatio(
  a: GearMeshGear,
  b: GearMeshGear,
  worldA: AssemblyFrame,
  worldB: AssemblyFrame,
  mesh: GearMeshSolution
): number {
  if (mesh.pair !== 'rack') {
    // The helper's ratio compares the rotation vectors; each joint counts
    // about its own axis, which may run against the other's.
    const sense = dot3(worldA.zAxis, worldB.zAxis) < 0 ? -1 : 1;
    return sense * (mesh.ratio ?? 0);
  }
  const [rack, pinionFrame, pinion] = isRack(a)
    ? [worldA, worldB, b]
    : [worldB, worldA, a];
  // The rack moves with the pinion's pitch point (rolling without slip):
  // ω·z × (−n·r), n from the rack's pitch line towards the pinion's axis.
  const normal = cross3(rack.zAxis, rack.xAxis);
  const centre = add(
    pinionFrame.origin,
    pinionFrame.zAxis,
    pinion.faceWidth / 2
  );
  const side = dot3(add(centre, rack.origin, -1), normal) < 0 ? -1 : 1;
  const along =
    -side * dot3(cross3(pinionFrame.zAxis, normal), rack.xAxis) < 0 ? -1 : 1;
  const perDegree = (mesh.travelPerTurn ?? 0) / 360;
  return isRack(a) ? along / perDegree : along * perDegree;
}

/**
 * How far a rack may slide with its teeth still under the pinion: the
 * pinion's place along the rack stays within the rack's length.
 */
function rackTravel(
  a: GearMeshGear,
  b: GearMeshGear,
  worldA: AssemblyFrame,
  worldB: AssemblyFrame,
  mesh: GearMeshSolution
): AssemblyDofLimit {
  const [rack, rackGear, pinionFrame, pinion] = isRack(a)
    ? [worldA, a, worldB, b]
    : [worldB, b, worldA, a];
  const pitch = (mesh.travelPerTurn ?? 0) / pinion.teeth;
  const length = rackGear.teeth * pitch;
  const centre = add(
    pinionFrame.origin,
    pinionFrame.zAxis,
    pinion.faceWidth / 2
  );
  const at = dot3(add(centre, rack.origin, -1), rack.xAxis);
  return { min: Math.min(0, at - length), max: Math.max(0, at) };
}

function refuse(code: string, error: string): GearMeshJointError {
  return { error, code };
}

/**
 * The joints and the coupling that make the pair move together, or why
 * they cannot be made.
 */
export function gearCouplingPlan(
  context: GearMeshContext,
  draft: GearMeshDraft,
  ids: GearCouplingIds
): GearCouplingResult | GearMeshJointError {
  const placed = gearMeshPlacement(context, draft);
  if ('error' in placed) return placed;
  const { set, solution } = context;
  const { base, moving, a, b, basePose, mesh, ownFrame } = placed;
  const frameA = gearMeshFrame(a.frame) as AssemblyFrame;
  const worldA = frameInWorld(basePose, frameA);
  const worldB = frameInWorld(basePose, mesh.frame);
  const kindOf = (gear: GearMeshGear) => (isRack(gear) ? 'slider' : 'revolute');
  const source = { kind: 'body' as const, label: 'Gear axis · meshed' };
  const rackSource = { kind: 'body' as const, label: 'Rack teeth · meshed' };
  const motionName = (component: AssemblyComponent, gear: GearMeshGear) =>
    `${component.name.slice(0, 60).trim()} ${isRack(gear) ? 'slide' : 'turn'}`;
  const taken = set.joints.map((j) => j.name);

  // The first gear's joint: the one it already moves on, else a new one.
  const existing = movingJointOf(set, solution, base.id);
  let carrierId: string;
  let baseJoint: AssemblyJoint | null = null;
  let driverJointId: string;
  let driverValue = 0;
  // +1 when a positive joint value moves the gear positively about its own
  // axis (a rack: along its own x direction).
  let driverSense = 1;
  if (existing && 'held' in existing)
    return refuse(
      'gear-coupling:base-held',
      `${base.name} is held still by ${existing.held.name}, a rigid joint. Remove that joint, or keep the pair fixed together.`
    );
  if (existing) {
    const { joint, forward, upstreamId } = existing;
    const upstreamPose = solution.poses.get(upstreamId);
    const axisFrame = upstreamPose
      ? frameInWorld(
          upstreamPose,
          forward ? joint.parent.frame : joint.child.frame
        )
      : null;
    const own = isRack(a) ? worldA.xAxis : worldA.zAxis;
    const cos = axisFrame ? dot3(axisFrame.zAxis, own) : 0;
    let onAxis =
      !!axisFrame &&
      joint.kind === kindOf(a) &&
      Math.abs(cos) >= 1 - ASSEMBLY_COINCIDENT_ANGULAR_TOLERANCE;
    if (onAxis && axisFrame && !isRack(a)) {
      // A turn must be about the gear's own axis line, not one beside it.
      const offset = add(worldA.origin, axisFrame.origin, -1);
      const off = add(offset, axisFrame.zAxis, -dot3(offset, axisFrame.zAxis));
      onAxis =
        Math.hypot(off.x, off.y, off.z) <= ASSEMBLY_COINCIDENT_LINEAR_TOLERANCE;
    }
    if (!onAxis)
      return refuse(
        'gear-coupling:base-joint',
        isRack(a)
          ? `${base.name} moves on ${joint.name}, which is not a slide along its teeth. Change that joint, or keep the pair fixed together.`
          : `${base.name} moves on ${joint.name}, which is not a turn about its own axis. Change that joint, or keep the pair fixed together.`
      );
    carrierId = upstreamId;
    driverJointId = joint.id;
    driverValue = solution.values.get(joint.id)?.[0] ?? joint.values[0] ?? 0;
    driverSense = (forward ? 1 : -1) * (cos < 0 ? -1 : 1);
  } else {
    const choices = gearCarrierChoices(context, draft);
    if (choices.length === 0)
      return refuse(
        'gear-coupling:no-carrier',
        'Gears that turn together need a part they are both mounted on (a plate or a housing). Add it to the assembly, or keep the pair fixed together.'
      );
    const chosen = draft.carrierId ?? defaultGearCarrier(context, draft);
    const carrier = choices.find((c) => c.id === chosen);
    if (!carrier)
      return refuse(
        'gear-coupling:carrier',
        'Choose the part both gears are mounted on.'
      );
    carrierId = carrier.id;
    const joined = jointAddError(set, carrier.id, base.id);
    if (joined) return { error: joined };
    const carrierPose = solution.poses.get(carrier.id);
    if (!carrierPose) return { error: 'Those parts are not placed.' };
    const own = motionFrame(a, frameA);
    const name = unusedName(taken, motionName(base, a));
    taken.push(name);
    baseJoint = {
      id: ids.baseJointId,
      name,
      kind: kindOf(a),
      parent: {
        componentId: carrier.id,
        frame: frameInLocal(carrierPose, frameInWorld(basePose, own)),
        source: isRack(a) ? rackSource : source
      },
      child: {
        componentId: base.id,
        frame: own,
        source: isRack(a) ? rackSource : source
      },
      values: [0],
      limits: [isRack(a) ? rackTravel(a, b, worldA, worldB, mesh) : null]
    };
    driverJointId = baseJoint.id;
  }

  const carrier = set.components.find((c) => c.id === carrierId);
  const carrierPose = solution.poses.get(carrierId);
  if (!carrier || !carrierPose) return { error: 'Those parts are not placed.' };
  const joined = jointAddError(set, carrierId, moving.id);
  if (joined) return { error: joined };

  // The second gear's joint places it in mesh at value 0: the parent frame
  // is where its own frame lands, seen from the mount.
  const joint: AssemblyJoint = {
    id: ids.jointId,
    name: unusedName(taken, motionName(moving, b)),
    kind: kindOf(b),
    parent: {
      componentId: carrierId,
      frame: frameInLocal(
        carrierPose,
        frameInWorld(basePose, motionFrame(b, mesh.frame))
      ),
      source: isRack(b) ? rackSource : source
    },
    child: {
      componentId: moving.id,
      frame: motionFrame(b, ownFrame),
      source: isRack(b) ? rackSource : source
    },
    values: [0],
    limits: [isRack(b) ? rackTravel(a, b, worldA, worldB, mesh) : null]
  };

  const ratio = driverSense * ownRatio(a, b, worldA, worldB, mesh);
  const coupling: AssemblyCoupling = {
    id: ids.couplingId,
    name: unusedName(
      (set.couplings ?? []).map((c) => c.name),
      mesh.pair === 'rack' ? 'Rack travel' : 'Gear ratio'
    ),
    driver: { jointId: driverJointId, dof: 0 },
    driven: { jointId: joint.id, dof: 0 },
    ratio,
    // The second joint is at 0 where the helper meshed the teeth: the
    // offset holds that phase wherever the first joint stands now.
    offset: 0 - ratio * driverValue
  };

  const groundCarrier =
    baseJoint !== null &&
    !carrier.grounded &&
    (solution.roles.get(carrierId) ?? 'free') === 'free';
  const releaseBase = baseJoint !== null && base.grounded;
  const trial: AssemblySet = {
    ...set,
    components: set.components.map((c) =>
      c.id === carrierId && groundCarrier
        ? { ...c, grounded: true }
        : c.id === base.id && releaseBase
          ? { ...c, grounded: false }
          : c
    ),
    joints: [...set.joints, ...(baseJoint ? [baseJoint] : []), joint]
  };
  const solved = solveAssembly(trial);
  // Each new joint must be the one that places its gear, from the mount.
  const places = (jointId: string, componentId: string) => {
    const link = solved.links.get(componentId);
    return link?.jointId === jointId && link.forward;
  };
  if (
    solved.unsolved.has(joint.id) ||
    (baseJoint !== null && solved.unsolved.has(baseJoint.id))
  )
    return refuse(
      'gear-coupling:loop',
      `${base.name}, ${moving.name} and ${carrier.name} are already connected, so the gears could not move on it. Remove the joint that connects them, or keep the pair fixed together.`
    );
  if (
    !places(joint.id, moving.id) ||
    (baseJoint !== null && !places(baseJoint.id, base.id))
  )
    return refuse(
      'gear-coupling:floating',
      `Nothing holds ${carrier.name} in place, so the gears have nothing to move on. Fix a part in place first.`
    );
  const refusal = couplingAddError(trial, coupling, solved.unsolved);
  if (refusal) return refuse(refusal.code, refusal.message);
  return {
    mesh,
    carrierId,
    groundCarrier,
    releaseBase,
    baseJoint,
    driverJointId,
    joint,
    coupling
  };
}

/**
 * Place, turning together: fixes a floating mount, frees a fixed first
 * gear, adds the joints and the coupling — one undo step — and selects the
 * driving joint so it can be dragged or played at once.
 */
export function createGearCouplingFromSetup(
  app: AssembleWorkspaceApp,
  context: GearMeshContext,
  draft: GearMeshDraft
): string | null {
  const plan = gearCouplingPlan(context, draft, {
    baseJointId: createId<'AssemblyJoint'>('joint'),
    jointId: createId<'AssemblyJoint'>('joint'),
    couplingId: createId<'AssemblyCoupling'>('coupling')
  });
  if ('error' in plan) {
    app.onStatus(
      gearMeshErrorText(plan, unitLabel('length', app.document?.units ?? 'mm'))
    );
    return null;
  }
  const commands: AnyCommand[] = [];
  if (plan.groundCarrier)
    commands.push(
      commandFactories.updateAssemblyComponent(
        { componentId: plan.carrierId, grounded: true },
        'Fix mount in place'
      )
    );
  if (plan.releaseBase && draft.baseId)
    commands.push(
      commandFactories.updateAssemblyComponent(
        { componentId: draft.baseId, grounded: false },
        'Let gear move'
      )
    );
  if (plan.baseJoint)
    commands.push(commandFactories.addAssemblyJoint({ joint: plan.baseJoint }));
  commands.push(
    commandFactories.addAssemblyJoint({ joint: plan.joint }),
    commandFactories.addAssemblyCoupling({ coupling: plan.coupling })
  );
  if (!app.execute(composeCommands('Place gears to move together', commands)))
    return null;
  assemblyRuntime.closeGearMesh();
  assemblyRuntime.selectJoint(plan.driverJointId);
  app.onStatus(
    `${plan.coupling.name} is in place: moving one gear moves the other.`
  );
  return plan.coupling.id;
}
