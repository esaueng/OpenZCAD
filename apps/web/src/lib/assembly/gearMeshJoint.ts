import { commandFactories } from '@openzcad/command-system';
import {
  composeTransforms,
  createId,
  invertTransform,
  isGearMeshRefusal,
  jointAddError,
  gearMeshFrame,
  meshGearPair,
  solveAssembly,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblySet,
  type GearMeshGear,
  type GearMeshRefusal,
  type GearMeshSolution
} from '@openzcad/shared';
import type { AssembleWorkspaceApp } from './assembleWorkspace';
import { assemblyRuntime } from './assemblyRuntime';
import type { GearMeshContext, GearMeshDraft } from './gearMesh';

/**
 * Mesh gears' pair math and joint (M14 meshing-pair helper): loaded with
 * the Mesh gears card, so the entry chunk carries only the gear check.
 */

/** "Gear mesh", "Gear mesh 2"…: an unused joint name. */
export function gearMeshJointName(set: AssemblySet): string {
  const names = new Set(set.joints.map((j) => j.name));
  if (!names.has('Gear mesh')) return 'Gear mesh';
  for (let n = 2; ; n += 1)
    if (!names.has(`Gear mesh ${n}`)) return `Gear mesh ${n}`;
}

export interface GearMeshResult {
  joint: AssemblyJoint;
  /** The base floats today: Mesh fixes it first. */
  groundBase: boolean;
  mesh: GearMeshSolution;
}

function midFrame(frame: AssemblyFrame, faceWidth: number): AssemblyFrame {
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

/**
 * The joint that meshes the pair, or why it cannot. A revolute joint on the
 * moving gear's axis through its mid-face: the parent frame where that axis
 * lands in the base gear's coordinates, the child frame on the moving
 * gear's own axis, so value 0 is the meshed pose.
 */
export function gearMeshJoint(
  context: GearMeshContext,
  draft: GearMeshDraft,
  id: string,
  name = gearMeshJointName(context.set)
): GearMeshResult | { error: string; code?: GearMeshRefusal['code'] } {
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
  if (isGearMeshRefusal(mesh)) return { error: mesh.message, code: mesh.code };

  // B's own frame as the helper and the kernel read it (unit axis, square
  // x direction), so a stored axis length cannot shift the saved joint.
  const ownFrame = gearMeshFrame(b.frame);
  if (!ownFrame) return { error: `${moving.name}’s axis has no direction.` };
  const own = midFrame(ownFrame, b.faceWidth);
  const landed = midFrame(mesh.frame, b.faceWidth);
  const source = { kind: 'body' as const, label: 'Gear axis · meshed' };
  const joint: AssemblyJoint = {
    id,
    name,
    kind: 'revolute',
    parent: { componentId: base.id, frame: landed, source },
    child: { componentId: moving.id, frame: own, source },
    values: [0],
    limits: [null]
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
    app.onStatus(result.error);
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
  app.onStatus(`${result.joint.name} is in place: the gears mesh.`);
  return id;
}
