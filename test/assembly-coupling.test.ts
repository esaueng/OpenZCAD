import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands,
  isAssemblyOnlyCommand,
  replayCommands
} from '@openzcad/command-system';
import {
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';
import {
  ASSEMBLY_JOINT_DOFS,
  IDENTITY_PLACEMENT,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  assemblySetError,
  coupledDofLimit,
  coupledJointValues,
  couplingAddError,
  couplingGroups,
  couplingLimitsConflict,
  couplingOffsetAtPose,
  dragSpecFor,
  motionStudyValues,
  solveAssembly,
  toUserId,
  transformPoint,
  type AssemblyCoupling,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblyJointKind,
  type AssemblySet,
  type BodyId,
  type ProjectDocument,
  type RigidTransform,
  type Vector3
} from '@openzcad/shared';

/**
 * AS02 gear coupling (schema v55): joint values tied by a ratio and an
 * offset. The solve is exact and linear, either side drives, both joints'
 * limits bound the pair, and anything that would lock or over-constrain
 * the pair is refused by code.
 */
const v = (x: number, y: number, z: number): Vector3 => ({ x, y, z });
const frameAt = (x: number, y = 0): AssemblyFrame => ({
  origin: v(x, y, 0),
  zAxis: v(0, 0, 1),
  xAxis: v(1, 0, 0)
});
/** A slide along world X: the joint's Z is the slide direction. */
const SLIDE_X: AssemblyFrame = {
  origin: v(0, -20, 0),
  zAxis: v(1, 0, 0),
  xAxis: v(0, 0, 1)
};

function component(id: string, grounded = false) {
  return {
    id,
    name: id,
    bodyId: `body_${id}` as BodyId,
    grounded,
    placement: IDENTITY_PLACEMENT
  };
}

function joint(
  id: string,
  kind: AssemblyJointKind,
  child: string,
  frame: AssemblyFrame,
  values: number[] = ASSEMBLY_JOINT_DOFS[kind].map(() => 0)
): AssemblyJoint {
  return {
    id,
    name: id,
    kind,
    parent: { componentId: 'plate', frame },
    child: { componentId: child, frame },
    values,
    limits: ASSEMBLY_JOINT_DOFS[kind].map(() => null)
  };
}

function coupling(
  id: string,
  driver: string,
  driven: string,
  ratio: number,
  offset = 0
): AssemblyCoupling {
  return {
    id,
    name: id,
    driver: { jointId: driver, dof: 0 },
    driven: { jointId: driven, dof: 0 },
    ratio,
    offset
  };
}

/** A 20-tooth and a 30-tooth gear on a fixed plate, 50 apart (m 2). */
function gearPair(ratio = -20 / 30, offset = 0): AssemblySet {
  return {
    components: [component('plate', true), component('a'), component('b')],
    joints: [
      joint('turn_a', 'revolute', 'a', frameAt(0)),
      joint('turn_b', 'revolute', 'b', frameAt(50))
    ],
    positions: [],
    studies: [],
    couplings: [coupling('mesh', 'turn_a', 'turn_b', ratio, offset)]
  };
}

const drive = (jointId: string, value: number) =>
  new Map<string, readonly number[]>([[jointId, [value]]]);

function valuesOf(set: AssemblySet, overrides?: ReturnType<typeof drive>) {
  const solved = solveAssembly(set, overrides).values;
  return Object.fromEntries([...solved].map(([id, list]) => [id, list[0]]));
}

describe('coupled joint values (AS02 gear coupling)', () => {
  it('turns an external pair opposite ways at −z1/z2', () => {
    const set = gearPair();
    expect(valuesOf(set, drive('turn_a', 30))).toEqual({
      turn_a: 30,
      turn_b: -20
    });
    // The driven gear really turns: a point on its rim moves about its axis.
    const pose = solveAssembly(set, drive('turn_a', 90)).poses.get(
      'b'
    ) as RigidTransform;
    const rim = transformPoint(pose, v(80, 0, 0));
    expect(rim.x).toBeCloseTo(50 + 30 * Math.cos((-60 * Math.PI) / 180), 9);
    expect(rim.y).toBeCloseTo(30 * Math.sin((-60 * Math.PI) / 180), 9);
    // The driver's own pose is unchanged by the coupling.
    const driver = solveAssembly(set, drive('turn_a', 90)).poses.get(
      'a'
    ) as RigidTransform;
    expect(transformPoint(driver, v(20, 0, 0)).y).toBeCloseTo(20, 9);
  });

  it('turns an internal pair the same way at +z1/z2', () => {
    const set = gearPair(17 / 54);
    expect(valuesOf(set, drive('turn_a', 54)).turn_b).toBeCloseTo(17, 12);
    expect(valuesOf(set, drive('turn_a', -108)).turn_b).toBeCloseTo(-34, 12);
  });

  it('moves a rack by pitch radius × angle', () => {
    const radius = 20;
    const set: AssemblySet = {
      components: [component('plate', true), component('a'), component('b')],
      joints: [
        joint('turn', 'revolute', 'a', frameAt(0)),
        joint('slide', 'slider', 'b', SLIDE_X)
      ],
      positions: [],
      studies: [],
      couplings: [coupling('rack', 'turn', 'slide', (radius * Math.PI) / 180)]
    };
    const solved = solveAssembly(set, drive('turn', 90));
    expect(solved.values.get('slide')?.[0]).toBeCloseTo(
      (radius * Math.PI) / 2,
      12
    );
    // One full turn is one pitch circumference of travel.
    expect(valuesOf(set, drive('turn', 360)).slide).toBeCloseTo(
      2 * Math.PI * radius,
      12
    );
    const rack = solved.poses.get('b') as RigidTransform;
    expect(transformPoint(rack, v(0, -20, 0)).x).toBeCloseTo(
      (radius * Math.PI) / 2,
      9
    );
  });

  it('keeps the phase the pair was coupled at', () => {
    const set = gearPair();
    (set.joints[0] as AssemblyJoint).values = [12];
    (set.joints[1] as AssemblyJoint).values = [7];
    const offset = couplingOffsetAtPose(set, set.couplings![0]!);
    expect(offset).toBeCloseTo(7 + (20 / 30) * 12, 12);
    set.couplings![0]!.offset = offset;
    // Nothing moves at the pose it was coupled at…
    expect(valuesOf(set).turn_a).toBe(12);
    expect(valuesOf(set).turn_b).toBeCloseTo(7, 12);
    // …and every later pose keeps that phase.
    expect(valuesOf(set, drive('turn_a', 42)).turn_b).toBeCloseTo(
      7 - (20 / 30) * 30,
      12
    );
  });

  it('runs both ways: moving the driven gear turns the driver', () => {
    const set = gearPair();
    expect(valuesOf(set, drive('turn_b', -20))).toEqual({
      turn_a: 30,
      turn_b: -20
    });
  });

  it('carries motion through an idler to the far gear', () => {
    const set = gearPair();
    set.components.push(component('c'));
    set.joints.push(joint('turn_c', 'revolute', 'c', frameAt(100)));
    set.couplings!.push(coupling('mesh_2', 'turn_b', 'turn_c', -30 / 15));
    // a → b → c: the idler cancels out, 20/15 the same way as a.
    expect(valuesOf(set, drive('turn_a', 30)).turn_c).toBeCloseTo(40, 12);
    expect(valuesOf(set, drive('turn_c', 40)).turn_a).toBeCloseTo(30, 12);
    expect(couplingGroups(set)).toHaveLength(1);
    expect(couplingGroups(set)[0]?.members.map((m) => m.jointId)).toEqual([
      'turn_a',
      'turn_b',
      'turn_c'
    ]);
  });

  it('stops the driver where the driven joint’s limit stops', () => {
    const set = gearPair(-2);
    (set.joints[1] as AssemblyJoint).limits = [{ min: -20, max: 20 }];
    expect(valuesOf(set, drive('turn_a', 30))).toEqual({
      turn_a: 10,
      turn_b: -20
    });
    expect(valuesOf(set, drive('turn_a', -45))).toEqual({
      turn_a: -10,
      turn_b: 20
    });
    // The driver's own limit still counts, and the tighter one wins.
    (set.joints[0] as AssemblyJoint).limits = [{ min: -5, max: 40 }];
    expect(coupledDofLimit(set, 'turn_a', 0)).toEqual({ min: -5, max: 10 });
    expect(coupledDofLimit(set, 'turn_b', 0)).toEqual({ min: -20, max: 10 });
    expect(valuesOf(set, drive('turn_a', -45))).toEqual({
      turn_a: -5,
      turn_b: 10
    });
    // A drag reads the narrowed range, so its soft stop is the real one.
    const spec = dragSpecFor(set, solveAssembly(set), 'a');
    expect(spec?.limit).toEqual({ min: -5, max: 10 });
  });

  it('leaves uncoupled joints exactly as before', () => {
    const set = gearPair();
    set.components.push(component('c'));
    set.joints.push(joint('turn_c', 'revolute', 'c', frameAt(100), [5]));
    expect(valuesOf(set, drive('turn_c', 33))).toEqual({
      turn_a: 0,
      turn_b: 0,
      turn_c: 33
    });
    const plain = { ...set, couplings: undefined };
    delete plain.couplings;
    expect(
      coupledJointValues(plain, drive('turn_a', 30)).get('turn_b')
    ).toEqual([0]);
  });

  it('follows a motion study that keys either gear', () => {
    const set = gearPair();
    set.studies.push({
      id: 'study',
      name: 'Spin',
      durationS: 2,
      playback: 'once',
      tracks: [
        {
          jointId: 'turn_a',
          dof: 0,
          keys: [
            { t: 0, value: 0, easing: 'linear' },
            { t: 2, value: 90, easing: 'linear' }
          ]
        }
      ]
    });
    const at = (t: number) =>
      solveAssembly(set, motionStudyValues(set, set.studies[0]!, t)).values;
    expect(at(1).get('turn_a')).toEqual([45]);
    expect(at(1).get('turn_b')?.[0]).toBeCloseTo(-30, 12);
    expect(at(2).get('turn_b')?.[0]).toBeCloseTo(-60, 12);
  });
});

describe('coupling refusals', () => {
  const code = (
    set: AssemblySet,
    draft: Parameters<typeof couplingAddError>[1],
    unsolved?: ReadonlyMap<string, unknown>
  ) => couplingAddError(set, draft, unsolved)?.code ?? null;
  const ends = (driver: string, driven: string) => ({
    driver: { jointId: driver, dof: 0 },
    driven: { jointId: driven, dof: 0 }
  });

  function train(): AssemblySet {
    const set = gearPair();
    set.components.push(component('c'), component('d'));
    set.joints.push(
      joint('turn_c', 'revolute', 'c', frameAt(100)),
      joint('weld', 'rigid', 'd', frameAt(150))
    );
    set.couplings!.push(coupling('mesh_2', 'turn_b', 'turn_c', -2));
    return set;
  }

  it('refuses a joint coupled to itself, a rigid joint and a missing one', () => {
    const set = train();
    expect(code(set, { ...ends('turn_a', 'turn_a'), ratio: 1 })).toBe(
      'coupling:self'
    );
    expect(code(set, { ...ends('turn_a', 'weld'), ratio: 1 })).toBe(
      'coupling:no-motion'
    );
    expect(code(set, { ...ends('turn_a', 'nope'), ratio: 1 })).toBe(
      'coupling:unknown-joint'
    );
    expect(
      code(set, {
        driver: { jointId: 'turn_a', dof: 1 },
        driven: { jointId: 'weld', dof: 0 },
        ratio: 1
      })
    ).toBe('coupling:no-motion');
  });

  it('refuses a ratio that is zero or not a number', () => {
    const set = gearPair();
    set.couplings = [];
    for (const ratio of [0, Number.NaN, Infinity, 1e-12])
      expect(code(set, { ...ends('turn_a', 'turn_b'), ratio })).toBe(
        'coupling:ratio'
      );
  });

  it('refuses a loop: redundant at the same ratio, a conflict at another', () => {
    const set = train();
    // a → b at −2/3 and b → c at −2 already give a → c at +4/3.
    expect(code(set, { ...ends('turn_a', 'turn_c'), ratio: 4 / 3 })).toBe(
      'coupling:redundant'
    );
    expect(code(set, { ...ends('turn_c', 'turn_a'), ratio: 3 / 4 })).toBe(
      'coupling:redundant'
    );
    expect(code(set, { ...ends('turn_a', 'turn_c'), ratio: -4 / 3 })).toBe(
      'coupling:conflict'
    );
    // The same ratio at another phase locks the train too.
    expect(
      code(set, { ...ends('turn_a', 'turn_c'), ratio: 4 / 3, offset: 5 })
    ).toBe('coupling:conflict');
    expect(code(set, { ...ends('turn_a', 'turn_b'), ratio: 1 })).toBe(
      'coupling:conflict'
    );
  });

  it('refuses a joint that never moves', () => {
    const set = gearPair();
    set.couplings = [];
    expect(
      code(
        set,
        { ...ends('turn_a', 'turn_b'), ratio: 1 },
        new Map([['turn_b', 'loop']])
      )
    ).toBe('coupling:joint-not-solved');
  });

  it('refuses limits that leave no shared position', () => {
    const set = gearPair();
    set.couplings = [];
    (set.joints[0] as AssemblyJoint).limits = [{ min: 0, max: 10 }];
    (set.joints[1] as AssemblyJoint).limits = [{ min: 100, max: 200 }];
    (set.joints[1] as AssemblyJoint).values = [100];
    expect(
      code(set, { ...ends('turn_a', 'turn_b'), ratio: 1, offset: 0 })
    ).toBe('coupling:limits');
    // Holding the current pose (no offset given) is always reachable.
    expect(code(set, { ...ends('turn_a', 'turn_b'), ratio: 1 })).toBeNull();
    set.couplings = [coupling('mesh', 'turn_a', 'turn_b', 1, 0)];
    expect(couplingLimitsConflict(set)).toBe('mesh');
  });

  it('validation refuses stored loops and malformed couplings', () => {
    const set = train();
    expect(assemblySetError(set)).toBeNull();
    const looped = structuredClone(set);
    looped.couplings!.push(coupling('mesh_3', 'turn_c', 'turn_a', 3 / 4));
    expect(assemblySetError(looped)).toMatch(/already coupled/);
    const broken = (edit: (c: AssemblyCoupling) => void) => {
      const copy = structuredClone(set);
      edit(copy.couplings![0]!);
      return assemblySetError(copy);
    };
    expect(broken((c) => (c.ratio = 0))).toMatch(/unusable ratio/);
    expect(broken((c) => (c.driven.jointId = 'weld'))).toMatch(/does not have/);
    expect(broken((c) => (c.driven.jointId = 'turn_a'))).toMatch(/to itself/);
    expect(broken((c) => (c.driver.jointId = 'gone'))).toMatch(
      /does not exist/
    );
    expect(broken((c) => (c.offset = Number.NaN))).toMatch(/offset/);
    expect(broken((c) => (c.name = ' '))).toMatch(/name/);
    expect(
      assemblySetError({ ...set, couplings: null as unknown as [] })
    ).toMatch(/couplings are malformed/);
    // A stored loop never hangs or double-counts the solve: it is left out.
    expect(couplingGroups(looped)[0]?.couplingIds).toEqual(['mesh', 'mesh_2']);
  });
});

describe('coupling commands (schema v55)', () => {
  const owner = toUserId('user_coupling');

  function assembled() {
    const manager = new CommandManager(createProjectDocument('Gears', owner));
    for (const name of ['Plate', 'Gear A', 'Gear B'])
      manager.execute(
        commandFactories.addPrimitive({
          name,
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        })
      );
    const bodies = manager.document.bodyOrder;
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: ['plate', 'a', 'b'].map((id, index) => ({
          componentId: id,
          name: id,
          bodyId: bodies[index] as BodyId,
          grounded: id === 'plate'
        }))
      })
    );
    manager.execute(
      commandFactories.addAssemblyJoint({
        joint: joint('turn_a', 'revolute', 'a', frameAt(0), [12])
      })
    );
    manager.execute(
      commandFactories.addAssemblyJoint({
        joint: joint('turn_b', 'revolute', 'b', frameAt(50), [7])
      })
    );
    return manager;
  }

  const couple = (offset?: number) =>
    commandFactories.addAssemblyCoupling({
      coupling: {
        id: 'mesh',
        name: ' Gear ratio ',
        driver: { jointId: 'turn_a', dof: 0 },
        driven: { jointId: 'turn_b', dof: 0 },
        ratio: -20 / 30,
        ...(offset === undefined ? {} : { offset })
      }
    });
  const values = (document: ProjectDocument) =>
    Object.fromEntries(
      document.assembly!.joints.map((j) => [j.id, j.values[0]])
    );

  it('couples at the current pose, undoes and redoes as one step', () => {
    const manager = assembled();
    const before = structuredClone(manager.document.assembly);
    manager.execute(couple());
    const stored = manager.document.assembly!.couplings!;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('Gear ratio');
    expect(stored[0]?.offset).toBeCloseTo(7 + (20 / 30) * 12, 12);
    expect(values(manager.document).turn_a).toBe(12);
    expect(values(manager.document).turn_b).toBeCloseTo(7, 12);
    expect(manager.undoIsAssemblyOnly).toBe(true);
    manager.undo();
    expect(manager.document.assembly).toEqual(before);
    expect('couplings' in manager.document.assembly!).toBe(false);
    manager.redo();
    expect(manager.document.assembly!.couplings).toEqual(stored);
  });

  it('saves a pose on either joint with its mate following', () => {
    const manager = assembled();
    manager.execute(couple(0));
    // An explicit offset moves the driven gear onto it.
    expect(values(manager.document)).toEqual({ turn_a: 12, turn_b: -8 });
    manager.execute(
      commandFactories.setAssemblyPose({ values: { turn_a: [30] } })
    );
    expect(values(manager.document)).toEqual({ turn_a: 30, turn_b: -20 });
    manager.execute(
      commandFactories.setAssemblyPose({ values: { turn_b: [-40] } })
    );
    expect(values(manager.document).turn_a).toBeCloseTo(60, 12);
    expect(values(manager.document).turn_b).toBe(-40);
    // A typed value on the joint itself leads the same way.
    manager.execute(
      commandFactories.updateAssemblyJoint({ jointId: 'turn_b', values: [10] })
    );
    expect(values(manager.document).turn_a).toBeCloseTo(-15, 12);
    // A saved position is applied with the coupling still holding.
    manager.execute(
      commandFactories.saveAssemblyPosition({
        positionId: 'pos',
        name: 'Open',
        values: { turn_a: [90], turn_b: [-60] }
      })
    );
    manager.execute(
      commandFactories.setAssemblyPose({
        values: manager.document.assembly!.positions[0]!.values
      })
    );
    expect(values(manager.document)).toEqual({ turn_a: 90, turn_b: -60 });
  });

  it('clamps the pair at a limit and refuses limits that cannot be met', () => {
    const manager = assembled();
    manager.execute(couple(0));
    manager.execute(
      commandFactories.updateAssemblyJoint({
        jointId: 'turn_b',
        limits: [{ min: -20, max: 20 }]
      })
    );
    manager.execute(
      commandFactories.setAssemblyPose({ values: { turn_a: [300] } })
    );
    expect(values(manager.document)).toEqual({ turn_a: 30, turn_b: -20 });
    const before = manager.document;
    expect(() =>
      manager.execute(
        commandFactories.updateAssemblyJoint({
          jointId: 'turn_a',
          limits: [{ min: 100, max: 200 }]
        })
      )
    ).toThrow(/no position every joint can reach/);
    expect(manager.document).toBe(before);
  });

  it('refuses a second coupling of the same pair and a rigid joint', () => {
    const manager = assembled();
    manager.execute(couple());
    const again = commandFactories.addAssemblyCoupling({
      coupling: {
        id: 'mesh_2',
        name: 'Again',
        driver: { jointId: 'turn_b', dof: 0 },
        driven: { jointId: 'turn_a', dof: 0 },
        ratio: 2
      }
    });
    expect(() => manager.execute(again)).toThrow(/would lock them/);
    manager.execute(
      commandFactories.updateAssemblyJoint({ jointId: 'turn_b', kind: 'rigid' })
    );
    // Changing a coupled joint's kind drops its coupling with it.
    expect('couplings' in manager.document.assembly!).toBe(false);
    expect(() => manager.execute(couple())).toThrow(/rigid joint/);
  });

  it('edits the ratio about the current pose and removes the coupling', () => {
    const manager = assembled();
    manager.execute(couple());
    manager.execute(
      commandFactories.updateAssemblyCoupling({ couplingId: 'mesh', ratio: 2 })
    );
    const edited = manager.document.assembly!.couplings![0]!;
    expect(edited.ratio).toBe(2);
    expect(values(manager.document).turn_a).toBe(12);
    expect(values(manager.document).turn_b).toBeCloseTo(7, 12);
    expect(edited.offset).toBeCloseTo(7 - 24, 12);
    expect(() =>
      manager.execute(
        commandFactories.updateAssemblyCoupling({
          couplingId: 'mesh',
          ratio: 0
        })
      )
    ).toThrow(/not zero/);
    manager.execute(
      commandFactories.deleteAssemblyCoupling({ couplingId: 'mesh' })
    );
    expect('couplings' in manager.document.assembly!).toBe(false);
    // Uncoupled again: the gears move alone.
    manager.execute(
      commandFactories.setAssemblyPose({ values: { turn_a: [50] } })
    );
    expect(values(manager.document).turn_b).toBeCloseTo(7, 12);
  });

  it('drops a coupling with either of its joints', () => {
    const manager = assembled();
    manager.execute(couple());
    manager.execute(
      commandFactories.deleteAssemblyJoint({ jointId: 'turn_b' })
    );
    expect('couplings' in manager.document.assembly!).toBe(false);
    manager.undo();
    expect(manager.document.assembly!.couplings).toHaveLength(1);
    manager.execute(
      commandFactories.deleteAssemblyComponent({ componentId: 'a' })
    );
    expect('couplings' in manager.document.assembly!).toBe(false);
  });

  it('makes two joints and their coupling one undo step as a transaction', () => {
    const manager = assembled();
    const together = composeCommands('Couple gears', [
      commandFactories.setAssemblyPose({ values: { turn_a: [0] } }),
      couple()
    ]);
    // The app admits it in Assemble as it does a single assembly command,
    // and never a transaction that also models.
    expect(isAssemblyOnlyCommand(together)).toBe(true);
    expect(isAssemblyOnlyCommand(couple())).toBe(true);
    expect(
      isAssemblyOnlyCommand(
        composeCommands('Mixed', [
          couple(),
          commandFactories.addPrimitive({
            name: 'Box',
            primitiveKind: 'box',
            dimensions: { width: 1, height: 1, depth: 1 }
          })
        ])
      )
    ).toBe(false);
    manager.execute(together);
    expect(manager.document.assembly!.couplings).toHaveLength(1);
    expect(manager.undoIsAssemblyOnly).toBe(true);
    manager.undo();
    expect('couplings' in manager.document.assembly!).toBe(false);
    expect(values(manager.document).turn_a).toBe(12);
  });

  it('replays, saves and reopens to the same couplings', () => {
    const manager = assembled();
    manager.execute(couple());
    manager.execute(
      commandFactories.setAssemblyPose({ values: { turn_a: [33] } })
    );
    const replayed = replayCommands(
      createProjectDocument('Gears', owner),
      manager.document.commandLog
    );
    expect(replayed.assembly).toEqual(manager.document.assembly);
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    expect(() => assertStorableDocument(saved)).not.toThrow();
    const opened = normalizeDocument(saved);
    expect(opened.assembly).toEqual(manager.document.assembly);
    expect(solveAssembly(opened.assembly!).values).toEqual(
      solveAssembly(manager.document.assembly!).values
    );
  });

  it('is additive: a v54 assembly opens unchanged, couplings need v55', () => {
    const manager = assembled();
    const plain = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    const opened = normalizeDocument({
      ...plain,
      schemaVersion: 54
    } as unknown as ProjectDocument);
    expect(opened.assembly).toEqual(manager.document.assembly);
    expect('couplings' in opened.assembly!).toBe(false);

    manager.execute(couple());
    expect(manager.document.schemaVersion).toBe(
      PROJECT_DOCUMENT_SCHEMA_VERSION
    );
    const coupled = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    expect(() =>
      normalizeDocument({
        ...coupled,
        schemaVersion: 54
      } as unknown as ProjectDocument)
    ).toThrow(/schema v55/);
    const broken = structuredClone(coupled);
    broken.assembly!.couplings![0]!.ratio = 0;
    expect(() => assertStorableDocument(broken)).toThrow(/unusable ratio/);
  });
});
