import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  assemblyComponentBodies,
  createProjectDocument,
  type GearInput
} from '@openzcad/document-core';
import {
  cross3,
  dot3,
  frameInWorld,
  gearMeshFrame,
  solveAssembly,
  toUserId,
  type AssemblyFrame,
  type AssemblySet,
  type BodyId,
  type GearMeshGear,
  type RigidTransform,
  type Vector3
} from '@openzcad/shared';
import {
  createGearCouplingFromSetup,
  gearCouplingPlan,
  type GearCouplingResult
} from '../../apps/web/src/lib/assembly/gearCoupling';
import {
  gearMeshContext,
  type GearMeshDraft
} from '../../apps/web/src/lib/assembly/gearMesh';

/**
 * AS02 gear coupling test support: gears and plain parts as components of
 * one assembly, Place gears run for real, and where a placed pair's pitch
 * curves touch. Shared by the fast suite and the exact-kernel sampling.
 */
const owner = toUserId('user_gear_coupling');
export const IDS = {
  baseJointId: 'joint_base',
  jointId: 'joint_moving',
  couplingId: 'coupling_mesh'
};
export const Z: Vector3 = { x: 0, y: 0, z: 1 };

export function gearInput(
  name: string,
  overrides: Partial<GearInput> = {}
): GearInput {
  return {
    name,
    gearType: 'external',
    sizing: 'module',
    pitch: 2,
    teeth: 20,
    faceWidth: 5,
    origin: { x: 0, y: 0, z: 0 },
    axis: { x: 0, y: 0, z: 1 },
    ...overrides
  };
}

export interface Part {
  id: string;
  name: string;
  gear?: Partial<GearInput>;
}

/** Gears (and plain boxes) as floating components of one assembly. */
export function assembled(parts: Part[]) {
  const manager = new CommandManager(createProjectDocument('Gears', owner));
  for (const part of parts)
    manager.execute(
      part.gear
        ? commandFactories.gearBody(gearInput(part.name, part.gear))
        : commandFactories.addPrimitive({
            name: part.name,
            primitiveKind: 'box',
            dimensions: { width: 100, height: 100, depth: 2 }
          })
    );
  const bodies = manager.document.bodyOrder;
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: parts.map((part, index) => ({
        componentId: part.id,
        name: part.name,
        bodyId: bodies[index] as BodyId,
        grounded: false
      }))
    })
  );
  const status: string[] = [];
  const executed: AnyCommand[] = [];
  const context = () => {
    const document = manager.document;
    const live = assemblyComponentBodies(document);
    return gearMeshContext(document, (id) => live.get(id) ?? null)!;
  };
  const app = () => ({
    document: manager.document,
    execute: (command: AnyCommand) => {
      executed.push(command);
      manager.execute(command);
      return true;
    },
    onStatus: (message: string) => status.push(message)
  });
  const set = () => manager.document.assembly as AssemblySet;
  return { manager, context, app, set, status, executed };
}

export const PINION: Part = { id: 'pinion', name: 'Pinion', gear: {} };
export const WHEEL: Part = { id: 'wheel', name: 'Wheel', gear: { teeth: 40 } };
export const PLATE: Part = { id: 'plate', name: 'Plate' };

export const draft = (
  baseId: string,
  movingId: string,
  carrierId?: string
): GearMeshDraft => ({
  baseId,
  movingId,
  motion: 'coupled',
  ...(carrierId ? { carrierId } : {})
});

export function planned(
  fixture: ReturnType<typeof assembled>,
  pair: GearMeshDraft
): GearCouplingResult {
  const plan = gearCouplingPlan(fixture.context(), pair, IDS);
  if ('error' in plan) throw new Error(plan.error);
  return plan;
}

export function refusal(
  fixture: ReturnType<typeof assembled>,
  pair: GearMeshDraft
) {
  const plan = gearCouplingPlan(fixture.context(), pair, IDS);
  if (!('error' in plan)) throw new Error('expected a refusal');
  return plan;
}

export function gearOf(fixture: ReturnType<typeof assembled>, id: string) {
  return fixture.context().gearOf(id) as GearMeshGear;
}

export const add = (a: Vector3, b: Vector3, s = 1): Vector3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s
});
export const length = (a: Vector3) => Math.hypot(a.x, a.y, a.z);

/** A gear's frame and mid-face centre in the world under a solve. */
export function placedGear(
  fixture: ReturnType<typeof assembled>,
  id: string,
  poses: ReadonlyMap<string, RigidTransform>
): { gear: GearMeshGear; frame: AssemblyFrame; centre: Vector3 } {
  const gear = gearOf(fixture, id);
  const frame = frameInWorld(
    poses.get(id) as RigidTransform,
    gearMeshFrame(gear.frame) as AssemblyFrame
  );
  return {
    gear,
    frame,
    centre: add(frame.origin, frame.zAxis, gear.faceWidth / 2)
  };
}

/** Where the two parts' pitch curves touch, in the world. */
export function pitchPoint(
  fixture: ReturnType<typeof assembled>,
  plan: GearCouplingResult,
  baseId: string,
  movingId: string
): Vector3 {
  const poses = solveAssembly(fixture.set()).poses;
  const a = placedGear(fixture, baseId, poses);
  const b = placedGear(fixture, movingId, poses);
  if (plan.mesh.pair === 'rack') {
    const [rack, pinion] = a.gear.gearType === 'rack' ? [a, b] : [b, a];
    const normal = cross3(rack.frame.zAxis, rack.frame.xAxis);
    const side =
      dot3(add(pinion.centre, rack.frame.origin, -1), normal) < 0 ? -1 : 1;
    return add(
      pinion.centre,
      normal,
      (-side * pinion.gear.module * pinion.gear.teeth) / 2
    );
  }
  const between = add(b.centre, a.centre, -1);
  const u = add({ x: 0, y: 0, z: 0 }, between, 1 / length(between));
  const working =
    ((a.gear.module * a.gear.teeth) / 2) *
    (plan.mesh.centerDistance / plan.mesh.standardCenterDistance);
  // A pinion inside a ring touches it on the side away from the ring's axis.
  const sign =
    plan.mesh.pair === 'internal' && a.gear.gearType !== 'internal' ? -1 : 1;
  return add(a.centre, u, sign * working);
}

export type GearCouplingFixture = ReturnType<typeof assembled>;

/**
 * Places the pair through the card's own path and returns the plan with
 * the saved (randomly named) driver joint and coupling.
 */
export function place(
  fixture: GearCouplingFixture,
  pair: GearMeshDraft
): GearCouplingResult {
  const plan = planned(fixture, pair);
  if (
    createGearCouplingFromSetup(fixture.app(), fixture.context(), pair) === null
  )
    throw new Error(fixture.status.at(-1) ?? 'Place refused the pair.');
  const saved = fixture.set().couplings?.at(-1);
  if (!saved) throw new Error('Place saved no coupling.');
  return { ...plan, driverJointId: saved.driver.jointId, coupling: saved };
}
