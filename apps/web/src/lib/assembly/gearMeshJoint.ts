import { commandFactories } from '@openzcad/command-system';
import {
  composeTransforms,
  createId,
  invertTransform,
  isGearMeshRefusal,
  jointAddError,
  GEAR_PLACEMENT_UNUSABLE,
  gearMeshFrame,
  gearMeshRefusalText,
  meshGearPair,
  solveAssembly,
  type AssemblyComponent,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblySet,
  type GearMeshGear,
  type GearMeshRefusal,
  type GearMeshSolution,
  type RigidTransform
} from '@openzcad/shared';
import type { AssembleWorkspaceApp } from './assembleWorkspace';
import { unitLabel } from '../measurements';
import { assemblyRuntime } from './assemblyRuntime';
import type { GearMeshContext, GearMeshDraft } from './gearMesh';

/**
 * Mesh gears' pair math and joint (M14 meshing-pair helper): loaded with
 * the Mesh gears card, so the entry chunk carries only the gear check.
 */

/** "Gear placement", "Gear placement 2"…: an unused joint name. */
export function gearMeshJointName(set: AssemblySet): string {
  const names = new Set(set.joints.map((j) => j.name));
  if (!names.has('Gear placement')) return 'Gear placement';
  for (let n = 2; ; n += 1)
    if (!names.has(`Gear placement ${n}`)) return `Gear placement ${n}`;
}

/** Why Mesh cannot place the pair; `refusal` keeps the helper's details. */
export interface GearMeshJointError {
  error: string;
  /** A meshing-pair refusal, or a `gear-coupling:`/`coupling:` one. */
  code?: GearMeshRefusal['code'] | (string & {});
  refusal?: GearMeshRefusal;
}

/** The error's text, its lengths in the document's unit. */
export function gearMeshErrorText(error: GearMeshJointError, unit: string) {
  return error.refusal ? gearMeshRefusalText(error.refusal, unit) : error.error;
}

export interface GearMeshResult {
  joint: AssemblyJoint;
  /** The base floats today: Mesh fixes it first. */
  groundBase: boolean;
  mesh: GearMeshSolution;
}

export function midFrame(
  frame: AssemblyFrame,
  faceWidth: number
): AssemblyFrame {
  const half = faceWidth / 2;
  return {
    origin: {
      x: frame.origin.x + frame.zAxis.x * half,
      y: frame.origin.y + frame.zAxis.y * half,
      z: frame.origin.z + frame.zAxis.z * half
    },
    zAxis: { ...frame.zAxis },
    xAxis: { ...frame.xAxis }
  };
}

/** The pair as placed: both gears read, posed and meshed. */
export interface GearMeshPlacement {
  base: AssemblyComponent;
  moving: AssemblyComponent;
  a: GearMeshGear;
  b: GearMeshGear;
  basePose: RigidTransform;
  mesh: GearMeshSolution;
  /** The moving gear's own frame as the kernel reads it. */
  ownFrame: AssemblyFrame;
}

/**
 * Where the moving gear lands against the base, or why the pair cannot
 * mesh. Shared by the fixed and the turning ways of saving it.
 */
export function gearMeshPlacement(
  context: GearMeshContext,
  draft: GearMeshDraft
): GearMeshPlacement | GearMeshJointError {
  const { set, solution } = context;
  const base = set.components.find((c) => c.id === draft.baseId);
  const moving = set.components.find((c) => c.id === draft.movingId);
  if (!base) return { error: 'Choose the gear that stays put.' };
  if (!moving) return { error: 'Choose the gear that meshes with it.' };
  if (base.id === moving.id) return { error: 'Choose two different gears.' };
  for (const component of [base, moving]) {
    const gear = context.gearOf(component.id);
    if (isGearMeshRefusal(gear))
      return {
        error:
          gear.code === 'gear-mesh:not-a-gear'
            ? `${component.name} is not a gear.`
            : gear.message,
        code: gear.code
      };
  }
  if (moving.grounded)
    return {
      error: `${moving.name} is fixed in place. Unfix it, or choose another gear to place.`
    };
  const refusal = jointAddError(set, base.id, moving.id);
  if (refusal) return { error: refusal };
  const basePose = solution.poses.get(base.id);
  const movingPose = solution.poses.get(moving.id);
  if (!basePose || !movingPose) return { error: 'Those parts are not placed.' };
  const a = context.gearOf(base.id) as GearMeshGear;
  const b = context.gearOf(moving.id) as GearMeshGear;
  const current = composeTransforms(invertTransform(basePose), movingPose);
  const mesh = meshGearPair(a, b, current);
  if (isGearMeshRefusal(mesh))
    return { error: mesh.message, code: mesh.code, refusal: mesh };

  // B's own frame as the helper and the kernel read it (unit axis, square
  // x direction), so a stored axis length cannot shift the saved joint.
  const ownFrame = gearMeshFrame(b.frame);
  if (!ownFrame)
    return {
      error: `${moving.name} cannot be placed: ${GEAR_PLACEMENT_UNUSABLE}.`,
      code: 'gear-mesh:invalid-placement'
    };
  return { base, moving, a, b, basePose, mesh, ownFrame };
}

/**
 * The joint that meshes the pair, or why it cannot. A rigid joint on the
 * moving gear's axis through its mid-face: the parent frame where that axis
 * lands in the base gear's coordinates, the child frame on the moving
 * gear's own axis, so the pair retains its meshed pose without independent rotation.
 */
export function gearMeshJoint(
  context: GearMeshContext,
  draft: GearMeshDraft,
  id: string,
  name = gearMeshJointName(context.set)
): GearMeshResult | GearMeshJointError {
  const placed = gearMeshPlacement(context, draft);
  if ('error' in placed) return placed;
  const { set, solution } = context;
  const { base, moving, b, mesh, ownFrame } = placed;
  const own = midFrame(ownFrame, b.faceWidth);
  const landed = midFrame(mesh.frame, b.faceWidth);
  const source = { kind: 'body' as const, label: 'Gear axis · meshed' };
  const joint: AssemblyJoint = {
    id,
    name,
    kind: 'rigid',
    parent: { componentId: base.id, frame: landed, source },
    child: { componentId: moving.id, frame: own, source },
    values: [],
    limits: []
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
  if (solveAssembly(trial).unsolved.has(id))
    return {
      error: `${moving.name} and ${base.name} are already connected, so this would close a loop.`
    };
  return { joint, groundBase, mesh };
}

/**
 * Mesh gears' Mesh: fixes a floating base gear first (as Set up motion
 * does), then adds the meshing joint and selects it.
 */
export function createGearMeshFromSetup(
  app: AssembleWorkspaceApp,
  context: GearMeshContext,
  draft: GearMeshDraft
): string | null {
  const id = createId<'AssemblyJoint'>('joint');
  const result = gearMeshJoint(context, draft, id);
  if ('error' in result) {
    app.onStatus(
      gearMeshErrorText(
        result,
        unitLabel('length', app.document?.units ?? 'mm')
      )
    );
    return null;
  }
  if (
    result.groundBase &&
    draft.baseId &&
    !app.execute(
      commandFactories.updateAssemblyComponent(
        { componentId: draft.baseId, grounded: true },
        'Fix base in place'
      )
    )
  )
    return null;
  if (!app.execute(commandFactories.addAssemblyJoint({ joint: result.joint })))
    return null;
  assemblyRuntime.closeGearMesh();
  assemblyRuntime.selectJoint(id);
  app.onStatus(
    `${result.joint.name} is in place: the gears are fixed in mesh.`
  );
  return id;
}
