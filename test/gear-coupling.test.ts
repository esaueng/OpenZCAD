import { afterEach, describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  IDENTITY_TRANSFORM,
  frameInWorld,
  invertTransform,
  solveAssembly,
  transformPoint,
  type AssemblyFrame,
  type AssemblyJoint,
  type FeatureNode,
  type RigidTransform,
  type Vector3
} from '@openzcad/shared';
import { assemblyRuntime } from '../apps/web/src/lib/assembly/assemblyRuntime';
import {
  createGearCouplingFromSetup,
  gearBaseDrive,
  type GearCouplingResult
} from '../apps/web/src/lib/assembly/gearCoupling';
import {
  gearCouplingMismatch,
  gearPairCoupling
} from '../apps/web/src/lib/assembly/gearCouplingCheck';
import { gearMeshJoint } from '../apps/web/src/lib/assembly/gearMeshJoint';
import {
  PINION,
  PLATE,
  WHEEL,
  Z,
  add,
  assembled,
  draft,
  length,
  pitchPoint,
  place,
  planned,
  refusal,
  type GearCouplingFixture,
  type Part
} from './support/gearCoupling';

/**
 * AS02 gear coupling from Place gears: the joints and the coupling a meshed
 * pair is saved with. The ratio's size and sign are checked against the
 * physics rather than a formula: where the teeth meet (the pitch point)
 * both parts must move at the same velocity, for every pair kind and
 * either axis sense. The exact-kernel tooth sampling is in
 * `gear-coupling-kernel.test.ts` (full suite).
 */
afterEach(() => assemblyRuntime.reset());

/**
 * Drives the coupling's driver a small step and returns how far each part's
 * material at `point` moved: with the right ratio the two are the same.
 */
function slip(
  fixture: GearCouplingFixture,
  plan: GearCouplingResult,
  baseId: string,
  movingId: string,
  point: Vector3
) {
  const set = fixture.set();
  const before = solveAssembly(set);
  const from = before.values.get(plan.driverJointId)?.[0] ?? 0;
  const step = 1e-3;
  const after = solveAssembly(
    set,
    new Map([[plan.driverJointId, [from + step]]])
  );
  const moved = (id: string) => {
    const local = transformPoint(
      invertTransform(before.poses.get(id) as RigidTransform),
      point
    );
    return add(
      transformPoint(after.poses.get(id) as RigidTransform, local),
      point,
      -1
    );
  };
  const base = moved(baseId);
  const moving = moved(movingId);
  return { base, moving, gap: length(add(base, moving, -1)) };
}

function expectNoSlip(
  fixture: GearCouplingFixture,
  plan: GearCouplingResult,
  baseId: string,
  movingId: string
) {
  const point = pitchPoint(fixture, plan, baseId, movingId);
  const { base, gap } = slip(fixture, plan, baseId, movingId, point);
  // Both really move, and together. What is left is the two arcs curving
  // apart, second order in the step (about 1e-5 of the travel); a wrong
  // sign would leave twice the travel, a wrong tooth count a few percent.
  expect(length(base)).toBeGreaterThan(1e-5);
  expect(gap).toBeLessThan(1e-3 * length(base));
}

describe('Place gears, turning together', () => {
  it('gives each gear a joint on the mount and couples them at −z1/z2', () => {
    const fixture = assembled([PINION, WHEEL, PLATE]);
    const plan = planned(fixture, draft('pinion', 'wheel'));
    expect(plan.carrierId).toBe('plate');
    expect(plan.groundCarrier).toBe(true);
    expect(plan.releaseBase).toBe(false);
    expect(plan.baseJoint).toMatchObject({
      kind: 'revolute',
      name: 'Pinion turn',
      values: [0],
      limits: [null]
    });
    expect(plan.baseJoint?.parent.componentId).toBe('plate');
    expect(plan.joint).toMatchObject({ kind: 'revolute', name: 'Wheel turn' });
    expect(plan.coupling).toMatchObject({
      name: 'Gear ratio',
      driver: { jointId: 'joint_base', dof: 0 },
      driven: { jointId: 'joint_moving', dof: 0 }
    });
    expect(plan.coupling.ratio).toBeCloseTo(-0.5, 12);
    expect(plan.coupling.offset).toBeCloseTo(0, 12);

    // The same pose the fixed placement saves: nothing else moved.
    const rigid = gearMeshJoint(
      fixture.context(),
      { baseId: 'pinion', movingId: 'wheel' },
      'joint_rigid'
    );
    if ('error' in rigid) throw new Error(rigid.error);
    const id = createGearCouplingFromSetup(
      fixture.app(),
      fixture.context(),
      draft('pinion', 'wheel')
    );
    expect(id).not.toBeNull();
    expect(fixture.executed.map((c) => c.kind)).toEqual(['transaction']);
    expect(
      fixture.manager.document.commandLog.slice(-4).map((c) => c.kind)
    ).toEqual([
      'assembly.component.update',
      'assembly.joint.add',
      'assembly.joint.add',
      'assembly.coupling.add'
    ]);
    const set = fixture.set();
    expect(set.joints.map((j) => j.kind)).toEqual(['revolute', 'revolute']);
    expect(set.couplings).toHaveLength(1);
    const solution = solveAssembly(set);
    expect(solution.unsolved.size).toBe(0);
    const landed = frameInWorld(solution.poses.get('wheel')!, {
      origin: { x: 0, y: 0, z: 0 },
      zAxis: Z,
      xAxis: { x: 1, y: 0, z: 0 }
    });
    expect(
      length(add(landed.origin, rigid.mesh.frame.origin, -1))
    ).toBeLessThan(1e-9);
    expect(length(add(landed.xAxis, rigid.mesh.frame.xAxis, -1))).toBeLessThan(
      1e-9
    );
    expect(solution.poses.get('pinion')).toEqual(IDENTITY_TRANSFORM);

    // Driving either joint turns its mate.
    const driven = solveAssembly(set, new Map([[set.joints[0]!.id, [40]]]));
    expect(driven.values.get(set.joints[1]!.id)?.[0]).toBeCloseTo(-20, 12);
    const back = solveAssembly(set, new Map([[set.joints[1]!.id, [15]]]));
    expect(back.values.get(set.joints[0]!.id)?.[0]).toBeCloseTo(-30, 12);
    expect(fixture.status.at(-1)).toBe(
      'Gear ratio is in place: moving one gear moves the other.'
    );

    // One undo takes the joints, the coupling and the fixing back.
    fixture.manager.undo();
    expect(fixture.manager.document.assembly?.joints).toEqual([]);
    expect(fixture.manager.document.assembly?.couplings).toBeUndefined();
    expect(
      fixture.manager.document.assembly?.components.every((c) => !c.grounded)
    ).toBe(true);
  });

  it('keeps the teeth rolling without slip for an external pair', () => {
    const fixture = assembled([PINION, WHEEL, PLATE]);
    const plan = place(fixture, draft('pinion', 'wheel'));
    expect(plan.coupling.ratio).toBeCloseTo(-0.5, 12);
    expectNoSlip(fixture, plan, 'pinion', 'wheel');
  });

  it('flips the stored sign when the second gear faces the other way', () => {
    const fixture = assembled([
      PINION,
      {
        id: 'wheel',
        name: 'Wheel',
        gear: {
          teeth: 40,
          origin: { x: 0, y: 0, z: 5 },
          axis: { x: 0, y: 0, z: -1 }
        }
      },
      PLATE
    ]);
    const plan = place(fixture, draft('pinion', 'wheel'));
    // Each joint counts about its own axis: against each other, the two
    // values now run the same way while the gears still counter-rotate.
    expect(plan.coupling.ratio).toBeCloseTo(0.5, 12);
    expectNoSlip(fixture, plan, 'pinion', 'wheel');
  });

  it('turns a pinion and its ring the same way, whichever stays put', () => {
    const ring: Part = {
      id: 'ring',
      name: 'Ring',
      gear: { gearType: 'internal', teeth: 54, rimDiameter: 130 }
    };
    const planet: Part = { id: 'planet', name: 'Planet', gear: { teeth: 17 } };
    const outer = assembled([ring, planet, PLATE]);
    const fromRing = place(outer, draft('ring', 'planet'));
    expect(fromRing.coupling.ratio).toBeCloseTo(54 / 17, 12);
    expectNoSlip(outer, fromRing, 'ring', 'planet');

    const inner = assembled([planet, ring, PLATE]);
    const fromPlanet = place(inner, draft('planet', 'ring'));
    expect(fromPlanet.coupling.ratio).toBeCloseTo(17 / 54, 12);
    expectNoSlip(inner, fromPlanet, 'planet', 'ring');
  });

  it('slides a rack by its pinion’s pitch radius times the angle', () => {
    const rack: Part = {
      id: 'rack',
      name: 'Rack',
      gear: { gearType: 'rack', teeth: 12 }
    };
    // Modelled part-way along the rack, so it can roll either way.
    const pinion: Part = {
      id: 'pinion',
      name: 'Pinion',
      gear: { teeth: 15, origin: { x: 30, y: 20, z: 0 } }
    };
    // 15 teeth, m 2: pitch radius 15, so π·15/180 per degree.
    const perDegree = (Math.PI * 15) / 180;

    const turning = assembled([pinion, rack, PLATE]);
    const fromPinion = place(turning, draft('pinion', 'rack'));
    expect(fromPinion.joint.kind).toBe('slider');
    expect(fromPinion.joint.name).toBe('Rack slide');
    expect(Math.abs(fromPinion.coupling.ratio)).toBeCloseTo(perDegree, 12);
    expectNoSlip(turning, fromPinion, 'pinion', 'rack');
    // The rack's travel keeps its teeth under the pinion: its length, 12π·2.
    const limit = fromPinion.joint.limits[0]!;
    expect(limit.max - limit.min).toBeCloseTo(12 * Math.PI * 2, 9);
    expect(limit.min).toBeLessThanOrEqual(0);
    expect(limit.max).toBeGreaterThanOrEqual(0);
    // …and that limit stops the pinion, through the coupling.
    const set = turning.set();
    const far = solveAssembly(
      set,
      new Map([[fromPinion.driverJointId, [100_000]]])
    );
    const slide = far.values.get(fromPinion.coupling.driven.jointId)![0]!;
    expect([limit.min, limit.max]).toContain(slide);
    expect(far.values.get(fromPinion.driverJointId)![0]).toBeCloseTo(
      (slide - fromPinion.coupling.offset) / fromPinion.coupling.ratio,
      9
    );

    const sliding = assembled([rack, pinion, PLATE]);
    const fromRack = place(sliding, draft('rack', 'pinion'));
    expect(fromRack.baseJoint?.kind).toBe('slider');
    expect(fromRack.joint.kind).toBe('revolute');
    expect(Math.abs(fromRack.coupling.ratio)).toBeCloseTo(1 / perDegree, 12);
    expectNoSlip(sliding, fromRack, 'rack', 'pinion');
  });

  it('lets a fixed first gear go, and says so', () => {
    const fixture = assembled([PINION, WHEEL, PLATE]);
    fixture.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'pinion',
        grounded: true
      })
    );
    const plan = planned(fixture, draft('pinion', 'wheel', 'plate'));
    expect(plan.releaseBase).toBe(true);
    expect(plan.groundCarrier).toBe(true);
    place(fixture, draft('pinion', 'wheel', 'plate'));
    const grounded = fixture
      .set()
      .components.filter((c) => c.grounded)
      .map((c) => c.id);
    expect(grounded).toEqual(['plate']);
    expect(solveAssembly(fixture.set()).unsolved.size).toBe(0);
  });

  function revolute(
    id: string,
    child: string,
    frame: AssemblyFrame,
    parent = 'plate',
    values = [0]
  ): AssemblyJoint {
    return {
      id,
      name: id,
      kind: 'revolute',
      parent: { componentId: parent, frame },
      child: { componentId: child, frame },
      values,
      limits: [null]
    };
  }
  const MID: AssemblyFrame = {
    origin: { x: 0, y: 0, z: 2.5 },
    zAxis: Z,
    xAxis: { x: 1, y: 0, z: 0 }
  };

  /** A pinion already turning on the plate, at `value`, about ±its axis. */
  function onShaft(value: number, reversed = false) {
    const fixture = assembled([PINION, WHEEL, PLATE]);
    fixture.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'plate',
        grounded: true
      })
    );
    const frame = reversed ? { ...MID, zAxis: { x: 0, y: 0, z: -1 } } : MID;
    fixture.manager.execute(
      commandFactories.addAssemblyJoint({
        joint: {
          ...revolute('shaft', 'pinion', frame, 'plate', [value]),
          name: 'Shaft'
        }
      })
    );
    return fixture;
  }

  it('reuses the joint the first gear already turns on, at its current angle', () => {
    const fixture = onShaft(25);
    expect(gearBaseDrive(fixture.context(), 'pinion')).toEqual({
      jointName: 'Shaft',
      carrierId: 'plate'
    });
    const plan = place(fixture, draft('pinion', 'wheel'));
    expect(plan.baseJoint).toBeNull();
    expect(plan.driverJointId).toBe('shaft');
    expect(plan.groundCarrier).toBe(false);
    expect(plan.coupling.ratio).toBeCloseTo(-0.5, 12);
    // The wheel was meshed against the pinion as it stands, turned 25°: the
    // offset holds that phase, so nothing moves at the pose it was placed.
    expect(plan.coupling.offset).toBeCloseTo(12.5, 12);
    const values = solveAssembly(fixture.set()).values;
    expect(values.get('shaft')).toEqual([25]);
    expect(values.get(plan.coupling.driven.jointId)?.[0]).toBeCloseTo(0, 12);
    expectNoSlip(fixture, plan, 'pinion', 'wheel');
    expect(fixture.set().joints).toHaveLength(2);
  });

  it('reads the sense of a reused joint from its axis and its direction', () => {
    // The joint's axis runs against the gear's: its value counts backwards.
    const reversed = onShaft(10, true);
    const against = place(reversed, draft('pinion', 'wheel'));
    expect(against.coupling.ratio).toBeCloseTo(0.5, 12);
    expectNoSlip(reversed, against, 'pinion', 'wheel');
    // The gear is the joint's parent end: the value turns the plate's side.
    const parent = assembled([PINION, WHEEL, PLATE]);
    parent.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'plate',
        grounded: true
      })
    );
    parent.manager.execute(
      commandFactories.addAssemblyJoint({
        joint: { ...revolute('shaft', 'plate', MID, 'pinion', [10]) }
      })
    );
    const flipped = place(parent, draft('pinion', 'wheel'));
    expect(flipped.driverJointId).toBe('shaft');
    expect(flipped.coupling.ratio).toBeCloseTo(0.5, 12);
    expectNoSlip(parent, flipped, 'pinion', 'wheel');
  });

  it('adds a third gear to the train through the second’s joint', () => {
    const idler: Part = { id: 'idler', name: 'Idler', gear: { teeth: 30 } };
    const fixture = assembled([PINION, WHEEL, idler, PLATE]);
    const first = place(fixture, draft('pinion', 'wheel', 'plate'));
    const second = place(fixture, draft('wheel', 'idler'));
    expect(second.baseJoint).toBeNull();
    expect(second.driverJointId).toBe(first.coupling.driven.jointId);
    expect(second.coupling.name).toBe('Gear ratio 2');
    expect(second.coupling.ratio).toBeCloseTo(-40 / 30, 12);
    expectNoSlip(fixture, second, 'wheel', 'idler');
    // Pinion → wheel → idler: the wheel cancels, 20/30 the same way.
    const set = fixture.set();
    const driven = solveAssembly(
      set,
      new Map([[first.driverJointId, [90]]])
    ).values;
    expect(driven.get(second.coupling.driven.jointId)?.[0]).toBeCloseTo(60, 9);
    expect(solveAssembly(set).unsolved.size).toBe(0);
  });

  it('warns when a gear’s teeth no longer match the stored ratio', () => {
    const fixture = assembled([PINION, WHEEL, PLATE]);
    const plan = place(fixture, draft('pinion', 'wheel'));
    const coupling = () => fixture.set().couplings![0]!;
    expect(gearPairCoupling(fixture.context(), 'wheel', 'pinion')?.id).toBe(
      plan.coupling.id
    );
    expect(gearPairCoupling(fixture.context(), 'wheel', 'plate')).toBeNull();
    expect(gearCouplingMismatch(fixture.context(), coupling())).toBeNull();
    // The wheel is edited from 40 to 45 teeth: the coupling keeps 20/40.
    const wheel = Object.values(fixture.manager.document.nodes).find(
      (node) => node.kind === 'feature' && node.name === 'Wheel'
    ) as FeatureNode;
    const retooth = (teeth: number) =>
      fixture.manager.execute(
        commandFactories.updateFeature({
          featureId: wheel.featureId,
          data: { teeth }
        })
      );
    retooth(45);
    expect(coupling().ratio).toBeCloseTo(-0.5, 12);
    expect(gearCouplingMismatch(fixture.context(), coupling())).toBe(
      'Pinion and Wheel no longer match Gear ratio: their teeth now give 0.4444 turns per turn, and it was placed for 0.5 turns per turn. Remove it and place the gears again.'
    );
    // Back at the count it was placed with, the warning goes.
    retooth(40);
    expect(gearCouplingMismatch(fixture.context(), coupling())).toBeNull();

    // A rack pair: the pinion's teeth set the travel per turn.
    const rack: Part = {
      id: 'rack',
      name: 'Rack',
      gear: { gearType: 'rack', teeth: 12 }
    };
    const pinion: Part = {
      id: 'pinion',
      name: 'Pinion',
      gear: { teeth: 15, origin: { x: 30, y: 20, z: 0 } }
    };
    const sliding = assembled([pinion, rack, PLATE]);
    place(sliding, draft('pinion', 'rack'));
    const saved = () => sliding.set().couplings![0]!;
    expect(gearCouplingMismatch(sliding.context(), saved())).toBeNull();
    const pinionFeature = Object.values(sliding.manager.document.nodes).find(
      (node) => node.kind === 'feature' && node.name === 'Pinion'
    ) as FeatureNode;
    sliding.manager.execute(
      commandFactories.updateFeature({
        featureId: pinionFeature.featureId,
        data: { teeth: 18 }
      })
    );
    expect(gearCouplingMismatch(sliding.context(), saved())).toMatch(
      /their teeth now give 113\.0973 of travel per turn, and it was placed for 94\.2478 of travel per turn/
    );
  });

  it('checks the gears it was placed for, also keyed to a shared shaft', () => {
    // plate → revolute shaft → rigid pinion, and a second gear (a cog)
    // keyed to the same shaft, each meshing its own wheel. Neither gear is
    // an end of the shaft's joint, and both ride it.
    const fixture = assembled([
      PINION,
      WHEEL,
      {
        id: 'cog',
        name: 'Cog',
        gear: { teeth: 30, origin: { x: 0, y: 0, z: 10 } }
      },
      {
        id: 'rim',
        name: 'Rim',
        gear: { teeth: 60, origin: { x: 0, y: 0, z: 10 } }
      },
      PLATE,
      { id: 'shaft', name: 'Shaft' }
    ]);
    fixture.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'plate',
        grounded: true
      })
    );
    const rigid = (id: string, child: string): AssemblyJoint => ({
      ...revolute(id, child, MID, 'shaft'),
      kind: 'rigid',
      values: [],
      limits: []
    });
    for (const joint of [
      { ...revolute('shaft_turn', 'shaft', MID), name: 'Shaft turn' },
      rigid('key_pinion', 'pinion'),
      rigid('key_cog', 'cog')
    ])
      fixture.manager.execute(commandFactories.addAssemblyJoint({ joint }));

    const first = place(fixture, draft('pinion', 'wheel'));
    expect(first.baseJoint).toBeNull();
    expect(first.driverJointId).toBe('shaft_turn');
    expect(first.coupling.gears).toEqual({ driver: 'pinion', driven: 'wheel' });
    expect(first.coupling.ratio).toBeCloseTo(-0.5, 12);
    expectNoSlip(fixture, first, 'pinion', 'wheel');
    const second = place(fixture, draft('cog', 'rim'));
    expect(second.driverJointId).toBe('shaft_turn');
    expect(second.coupling.gears).toEqual({ driver: 'cog', driven: 'rim' });
    expectNoSlip(fixture, second, 'cog', 'rim');

    const coupling = (id: string) =>
      fixture.set().couplings!.find((c) => c.id === id)!;
    const context = () => fixture.context();
    // Each pair is found by its gears, though both share the shaft's joint.
    expect(gearPairCoupling(context(), 'wheel', 'pinion')?.id).toBe(
      first.coupling.id
    );
    expect(gearPairCoupling(context(), 'cog', 'rim')?.id).toBe(
      second.coupling.id
    );
    expect(gearPairCoupling(context(), 'pinion', 'rim')).toBeNull();
    expect(
      gearCouplingMismatch(context(), coupling(first.coupling.id))
    ).toBeNull();
    // The keyed pinion goes from 20 to 30 teeth: its coupling keeps 20/40.
    const pinion = Object.values(fixture.manager.document.nodes).find(
      (node) => node.kind === 'feature' && node.name === 'Pinion'
    ) as FeatureNode;
    fixture.manager.execute(
      commandFactories.updateFeature({
        featureId: pinion.featureId,
        data: { teeth: 30 }
      })
    );
    expect(coupling(first.coupling.id).ratio).toBeCloseTo(-0.5, 12);
    expect(gearCouplingMismatch(context(), coupling(first.coupling.id))).toBe(
      'Pinion and Wheel no longer match Gear ratio: their teeth now give 0.75 turns per turn, and it was placed for 0.5 turns per turn. Remove it and place the gears again.'
    );
    // The other pair on the same shaft is untouched.
    expect(
      gearCouplingMismatch(context(), coupling(second.coupling.id))
    ).toBeNull();
    // A coupling that records no gear pair is never judged.
    const { gears: _gears, ...bare } = coupling(first.coupling.id);
    expect(gearCouplingMismatch(context(), bare)).toBeNull();
  });

  it('refuses by code what cannot turn together', () => {
    const bare = assembled([PINION, WHEEL]);
    expect(refusal(bare, draft('pinion', 'wheel')).code).toBe(
      'gear-coupling:no-carrier'
    );
    const fixture = assembled([PINION, WHEEL, PLATE]);
    expect(refusal(fixture, draft('pinion', 'wheel', 'wheel')).code).toBe(
      'gear-coupling:carrier'
    );
    // The fixed placement's own refusals still come first.
    expect(refusal(fixture, draft('pinion', 'plate')).error).toBe(
      'Plate is not a gear.'
    );

    // Held still by a rigid joint: nothing to drive.
    const held = assembled([PINION, WHEEL, PLATE]);
    held.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'plate',
        grounded: true
      })
    );
    held.manager.execute(
      commandFactories.addAssemblyJoint({
        joint: {
          ...revolute('weld', 'pinion', MID),
          kind: 'rigid',
          values: [],
          limits: [],
          name: 'Weld'
        }
      })
    );
    const heldRefusal = refusal(held, draft('pinion', 'wheel'));
    expect(heldRefusal.code).toBe('gear-coupling:base-held');
    expect(heldRefusal.error).toContain('Weld');

    // Turning about an axis that is not the gear's own.
    const offAxis = assembled([PINION, WHEEL, PLATE]);
    offAxis.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'plate',
        grounded: true
      })
    );
    offAxis.manager.execute(
      commandFactories.addAssemblyJoint({
        joint: revolute('hinge', 'pinion', {
          ...MID,
          origin: { x: 7, y: 0, z: 2.5 }
        })
      })
    );
    expect(refusal(offAxis, draft('pinion', 'wheel')).code).toBe(
      'gear-coupling:base-joint'
    );

    // The second gear already hangs off the mount: its joint would loop.
    const joined = assembled([PINION, WHEEL, PLATE]);
    joined.manager.execute(
      commandFactories.addAssemblyJoint({
        joint: revolute('other', 'wheel', MID)
      })
    );
    expect(refusal(joined, draft('pinion', 'wheel', 'plate')).error).toMatch(
      /already joined by other/
    );
    const spare: Part = { id: 'arm', name: 'Arm' };
    const looped = assembled([PINION, WHEEL, PLATE, spare]);
    for (const joint of [
      revolute('plate_arm', 'arm', MID),
      revolute('arm_wheel', 'wheel', MID, 'arm')
    ])
      looped.manager.execute(commandFactories.addAssemblyJoint({ joint }));
    expect(refusal(looped, draft('pinion', 'wheel', 'plate')).code).toBe(
      'gear-coupling:loop'
    );
    // Nothing was saved by any refusal.
    expect(looped.set().couplings).toBeUndefined();
  });
});
