import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assemblyComponentBodies,
  createProjectDocument,
  gearMeshGearOfBody,
  type GearInput
} from '@openzcad/document-core';
import {
  IDENTITY_TRANSFORM,
  axisAngleQuaternion,
  composeTransforms,
  cross3,
  dot3,
  frameInWorld,
  invertTransform,
  inverseInvolute,
  involute,
  isGearMeshRefusal,
  meshGearPair,
  solveAssembly,
  toUserId,
  transformPoint,
  type AssemblyFrame,
  type BodyId,
  type GearMeshGear,
  type GearMeshRefusal,
  type GearMeshSolution,
  type RigidTransform,
  type Vector3
} from '@openzcad/shared';
import { gearMeshContext } from '../apps/web/src/lib/assembly/gearMesh';
import { gearMeshJoint } from '../apps/web/src/lib/assembly/gearMeshJoint';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * M14 meshing-pair helper: the working centre distance and tooth phase of a
 * parallel-axis pair (external, internal, rack and pinion), its refusals,
 * the gear a body shows, and the revolute joint Assemble saves.
 */

const DEG = Math.PI / 180;
const Z: Vector3 = { x: 0, y: 0, z: 1 };
const X: Vector3 = { x: 1, y: 0, z: 0 };
const ORIGIN: Vector3 = { x: 0, y: 0, z: 0 };

function gear(overrides: Partial<GearMeshGear> = {}): GearMeshGear {
  return {
    gearType: 'external',
    teeth: 20,
    module: 2,
    pressureAngleDeg: 20,
    profileShift: 0,
    backlash: 0,
    helixAngleDeg: 0,
    hand: 'right',
    herringbone: false,
    faceWidth: 5,
    phaseDeg: 0,
    frame: { origin: ORIGIN, zAxis: Z, xAxis: X },
    ...overrides
  };
}

function solved(
  a: GearMeshGear,
  b: GearMeshGear,
  current: RigidTransform = IDENTITY_TRANSFORM
): GearMeshSolution {
  const result = meshGearPair(a, b, current);
  if (isGearMeshRefusal(result)) throw new Error(result.message);
  return result;
}

function refused(a: GearMeshGear, b: GearMeshGear): GearMeshRefusal {
  const result = meshGearPair(a, b, IDENTITY_TRANSFORM);
  if (!isGearMeshRefusal(result)) throw new Error('expected a refusal');
  return result;
}

function expectVector(actual: Vector3, expected: Vector3, digits = 9) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

/** Angle of `v` about `frame`'s axis from its x direction, radians. */
function angleIn(frame: AssemblyFrame, v: Vector3): number {
  const y = cross3(frame.zAxis, frame.xAxis);
  return Math.atan2(dot3(v, y), dot3(v, frame.xAxis));
}

/** `value` reduced into [-period/2, period/2). */
function wrap(value: number, period: number): number {
  return value - period * Math.floor(value / period + 0.5);
}

describe('involute helpers', () => {
  it('inverts the involute function', () => {
    for (const deg of [5, 14.5, 20, 22.3167, 25, 40, 60]) {
      expect(inverseInvolute(involute(deg * DEG)) / DEG).toBeCloseTo(deg, 10);
    }
    expect(Number.isNaN(inverseInvolute(0))).toBe(true);
    expect(Number.isNaN(inverseInvolute(-0.01))).toBe(true);
  });
});

describe('meshing-pair centre distance', () => {
  it('puts two standard spur gears at the sum of their pitch radii', () => {
    const mesh = solved(gear(), gear({ teeth: 40 }));
    expect(mesh.pair).toBe('external');
    expect(mesh.centerDistance).toBeCloseTo(60, 12);
    expect(mesh.standardCenterDistance).toBeCloseTo(60, 12);
    expect(mesh.workingPressureAngleDeg).toBeCloseTo(20, 10);
    // The 40-tooth gear turns half a turn, the other way.
    expect(mesh.ratio).toBeCloseTo(-0.5, 12);
    expect(mesh.travelPerTurn).toBeNull();
  });

  it('spreads a profile-shifted pair to its working pressure angle', () => {
    // inv α_w = inv 20° + 2 tan 20° (0.5 + 0) / 60; a = 60 cos 20° / cos α_w.
    const mesh = solved(gear({ profileShift: 0.5 }), gear({ teeth: 40 }));
    expect(mesh.centerDistance).toBeCloseTo(60.94650974720522, 9);
    expect(mesh.standardCenterDistance).toBeCloseTo(60, 12);
    expect(mesh.workingPressureAngleDeg).toBeCloseTo(22.31670690381982, 8);
  });

  it('reads a helical pair in the transverse section', () => {
    const left = { helixAngleDeg: 20, hand: 'left' as const };
    const right = { helixAngleDeg: 20, hand: 'right' as const };
    // m_t = 2 / cos 20°, so a = 60 / cos 20°.
    const standard = solved(gear(right), gear({ teeth: 40, ...left }));
    expect(standard.centerDistance).toBeCloseTo(63.850666348554725, 9);
    // α_t = atan(tan 20° / cos 20°) = 21.1728°.
    expect(standard.workingPressureAngleDeg).toBeCloseTo(21.17283218516298, 8);
    const shifted = solved(
      gear({ ...right, profileShift: 0.3 }),
      gear({ teeth: 40, ...left, profileShift: 0.2 })
    );
    expect(shifted.centerDistance).toBeCloseTo(64.8052313081006, 9);
    expect(shifted.workingPressureAngleDeg).toBeCloseTo(23.25456664662464, 8);
  });

  it('puts a pinion inside a ring at the difference of pitch radii', () => {
    const ring = gear({ gearType: 'internal', teeth: 60 });
    const mesh = solved(ring, gear());
    expect(mesh.pair).toBe('internal');
    expect(mesh.centerDistance).toBeCloseTo(40, 12);
    // The ring turns a third of a turn per pinion turn, the same way.
    expect(solved(gear(), ring).ratio).toBeCloseTo(1 / 3, 12);
    // inv α_w = inv 20° + 2 tan 20° (x₂ − x₁) / (z₂ − z₁).
    const shifted = solved(
      gear({ gearType: 'internal', teeth: 60, profileShift: 0.4 }),
      gear({ profileShift: 0.1 })
    );
    expect(shifted.centerDistance).toBeCloseTo(40.57069277913943, 9);
    expect(shifted.workingPressureAngleDeg).toBeCloseTo(22.10827026699517, 8);
    // Either way round.
    expect(
      solved(
        gear({ profileShift: 0.1 }),
        gear({ gearType: 'internal', teeth: 60, profileShift: 0.4 })
      ).centerDistance
    ).toBeCloseTo(40.57069277913943, 9);
  });

  it('stands a pinion its pitch radius plus its shift off a rack', () => {
    const rack = gear({ gearType: 'rack', teeth: 12 });
    const mesh = solved(rack, gear());
    expect(mesh.pair).toBe('rack');
    expect(mesh.centerDistance).toBeCloseTo(20, 12);
    expect(mesh.travelPerTurn).toBeCloseTo(40 * Math.PI, 12);
    expect(mesh.ratio).toBeNull();
    expect(
      solved(rack, gear({ profileShift: 0.3 })).centerDistance
    ).toBeCloseTo(20.6, 12);
  });

  it('reports both thinnings as the play without moving the centres', () => {
    const mesh = solved(
      gear({ backlash: 0.1 }),
      gear({ teeth: 40, backlash: 0.15 })
    );
    expect(mesh.centerDistance).toBeCloseTo(60, 12);
    expect(mesh.backlash).toBeCloseTo(0.25, 12);
  });
});

describe('meshing-pair placement and phase', () => {
  it('turns the second spur gear so a space faces the first gear’s tooth', () => {
    const mesh = solved(gear(), gear({ teeth: 40 }));
    // Coaxial now, so it goes along A's x direction, mid-faces level.
    expectVector(mesh.frame.origin, { x: 60, y: 0, z: 0 });
    expectVector(mesh.frame.zAxis, Z);
    // Tooth 0 half a 9° pitch off the line back to A: 180° − 4.5°.
    expectVector(mesh.frame.xAxis, {
      x: Math.cos(175.5 * DEG),
      y: Math.sin(175.5 * DEG),
      z: 0
    });
    // The placement maps B's own frame there.
    expectVector(transformPoint(mesh.placement, ORIGIN), mesh.frame.origin);
  });

  it('goes towards where the second gear is and keeps its axis sense', () => {
    // B sits up and to the left (135°), upside down.
    const flipped: RigidTransform = {
      t: { x: -30, y: 30, z: 9 },
      q: axisAngleQuaternion(X, Math.PI)
    };
    const mesh = solved(gear({ faceWidth: 6 }), gear({ teeth: 40 }), flipped);
    const u = { x: -Math.SQRT1_2, y: Math.SQRT1_2, z: 0 };
    // Mid-face of B (5 wide, axis −Z) on A's mid-face (z 3).
    expectVector(mesh.frame.origin, { x: 60 * u.x, y: 60 * u.y, z: 5.5 });
    expectVector(mesh.frame.zAxis, { x: 0, y: 0, z: -1 });
  });

  it('interleaves at every phase, hand and orientation', () => {
    // For each pair, B's tooth sits half a pitch from A's along the common
    // tangent at the pitch point, in the mid-face plane.
    const cases: [GearMeshGear, GearMeshGear, RigidTransform][] = [
      [
        gear({ phaseDeg: 7 }),
        gear({ teeth: 33, phaseDeg: -11 }),
        IDENTITY_TRANSFORM
      ],
      [
        gear({ helixAngleDeg: 20, phaseDeg: 3 }),
        gear({ teeth: 31, helixAngleDeg: 20, hand: 'left', faceWidth: 9 }),
        { t: { x: 10, y: -40, z: 0 }, q: axisAngleQuaternion(X, Math.PI) }
      ],
      [
        gear({ gearType: 'internal', teeth: 57, phaseDeg: 2 }),
        gear({ teeth: 19, phaseDeg: 13 }),
        { t: { x: 0, y: 5, z: 0 }, q: axisAngleQuaternion(Z, 1) }
      ],
      [
        gear({ teeth: 19, phaseDeg: 13 }),
        gear({ gearType: 'internal', teeth: 57, phaseDeg: 2 }),
        IDENTITY_TRANSFORM
      ]
    ];
    for (const [a, b, current] of cases) {
      const mesh = solved(a, b, current);
      const mt = a.module / Math.cos(a.helixAngleDeg * DEG);
      const rA = (mt * a.teeth) / 2;
      const rB = (mt * b.teeth) / 2;
      const cA = { x: 0, y: 0, z: a.faceWidth / 2 };
      const cB = {
        x: mesh.frame.origin.x + mesh.frame.zAxis.x * (b.faceWidth / 2),
        y: mesh.frame.origin.y + mesh.frame.zAxis.y * (b.faceWidth / 2),
        z: mesh.frame.origin.z + mesh.frame.zAxis.z * (b.faceWidth / 2)
      };
      expect(cB.z).toBeCloseTo(cA.z, 9);
      const line = { x: cB.x - cA.x, y: cB.y - cA.y, z: 0 };
      expect(Math.hypot(line.x, line.y)).toBeCloseTo(mesh.centerDistance, 9);
      const u = {
        x: line.x / mesh.centerDistance,
        y: line.y / mesh.centerDistance,
        z: 0
      };
      const internal = mesh.pair === 'internal';
      const dA =
        internal && a.gearType !== 'internal' ? { x: -u.x, y: -u.y, z: 0 } : u;
      const dB = internal ? dA : { x: -u.x, y: -u.y, z: 0 };
      const tooth = (g: GearMeshGear, r: number) =>
        g.phaseDeg * DEG +
        (g.helixAngleDeg === 0
          ? 0
          : ((g.hand === 'right' ? 1 : -1) *
              (g.faceWidth / 2) *
              Math.tan(g.helixAngleDeg * DEG)) /
            r);
      // Arc offsets of tooth 0 from the pitch point, along A's tangent.
      const tA = cross3(Z, dA);
      const tB = cross3(mesh.frame.zAxis, dB);
      const sense = Math.sign(dot3(tA, tB));
      const arcA = rA * (tooth(a, rA) - angleIn(a.frame, dA));
      const arcB = sense * rB * (tooth(b, rB) - angleIn(mesh.frame, dB));
      const pitch = (2 * Math.PI * rA) / a.teeth;
      expect(Math.abs(wrap(arcB - arcA - pitch / 2, pitch))).toBeLessThan(1e-9);
    }
  });

  it('phases a pinion on a rack wherever along it the pinion sits', () => {
    const rack = gear({ gearType: 'rack', teeth: 12 });
    for (const [x, phaseDeg] of [
      [20, 4],
      [3.3, 0],
      [70, -17]
    ] as const) {
      const pinion = gear({ teeth: 15, phaseDeg });
      const current: RigidTransform = {
        t: { x, y: 25, z: 0 },
        q: IDENTITY_TRANSFORM.q
      };
      const mesh = solved(rack, pinion, current);
      // Centre r + x·m above the pitch line, mid-faces level, where it was.
      const centre = {
        x: mesh.frame.origin.x,
        y: mesh.frame.origin.y,
        z: mesh.frame.origin.z + 2.5
      };
      expectVector(centre, { x, y: 15, z: 2.5 });
      // Pinion tooth 0's arc offset from the pitch point (straight down),
      // along +X, is half a pitch from a rack tooth's at (k + ½)·p − x.
      const pitch = 2 * Math.PI;
      const down = { x: 0, y: -1, z: 0 };
      const arc = 15 * (phaseDeg * DEG - angleIn(mesh.frame, down));
      expect(
        Math.abs(wrap(arc - (pitch / 2 - x) - pitch / 2, pitch))
      ).toBeLessThan(1e-9);
    }
  });

  it('places a rack against a pinion that stays put', () => {
    const pinion = gear({ teeth: 15, profileShift: 0.3 });
    const rack = gear({ gearType: 'rack', teeth: 12 });
    const mesh = solved(pinion, rack);
    // The pinion seen from the rack sits on its tooth side, 15.6 above its
    // pitch line, and the placements are inverse.
    const pinionInRack = solved(rack, pinion, invertTransform(mesh.placement));
    expect(pinionInRack.centerDistance).toBeCloseTo(15.6, 12);
    const back = composeTransforms(mesh.placement, pinionInRack.placement);
    expectVector(transformPoint(back, { x: 1, y: 2, z: 3 }), {
      x: 1,
      y: 2,
      z: 3
    });
    const rackFrame = frameInWorld(mesh.placement, rack.frame);
    const n = cross3(rackFrame.zAxis, rackFrame.xAxis);
    // Pinion centre (0, 0, 2.5) is 15.6 along the rack's tooth direction.
    expect(
      dot3(
        {
          x: -rackFrame.origin.x,
          y: -rackFrame.origin.y,
          z: -rackFrame.origin.z
        },
        n
      )
    ).toBeCloseTo(15.6, 9);
  });
});

describe('meshing-pair refusals', () => {
  it('refuses pairs that cannot mesh, by code', () => {
    const cases: [GearMeshGear, GearMeshGear, GearMeshRefusal['code']][] = [
      [gear(), gear({ gearType: 'bevel' }), 'gear-mesh:unsupported-type'],
      [
        gear({ gearType: 'worm' }),
        gear({ gearType: 'worm-wheel' }),
        'gear-mesh:unsupported-type'
      ],
      [
        gear({ gearType: 'enveloping-wheel' }),
        gear(),
        'gear-mesh:unsupported-type'
      ],
      [
        gear({ gearType: 'rack' }),
        gear({ gearType: 'rack' }),
        'gear-mesh:two-racks'
      ],
      [
        gear({ gearType: 'internal', teeth: 60 }),
        gear({ gearType: 'internal', teeth: 50 }),
        'gear-mesh:two-internal'
      ],
      [
        gear({ gearType: 'internal', teeth: 60 }),
        gear({ gearType: 'rack' }),
        'gear-mesh:internal-rack'
      ],
      [gear(), gear({ module: 2.5 }), 'gear-mesh:module-mismatch'],
      [
        gear(),
        gear({ pressureAngleDeg: 14.5 }),
        'gear-mesh:pressure-angle-mismatch'
      ],
      [
        gear(),
        gear({ helixAngleDeg: 15, hand: 'left' }),
        'gear-mesh:helix-mismatch'
      ],
      [
        gear({ helixAngleDeg: 20 }),
        gear({ helixAngleDeg: 25, hand: 'left' }),
        'gear-mesh:helix-mismatch'
      ],
      [
        gear({ gearType: 'rack' }),
        gear({ helixAngleDeg: 20 }),
        'gear-mesh:helical-rack'
      ],
      [
        gear({ helixAngleDeg: 20 }),
        gear({ helixAngleDeg: 20 }),
        'gear-mesh:same-hand'
      ],
      [
        gear({ gearType: 'internal', teeth: 60, helixAngleDeg: 20 }),
        gear({ helixAngleDeg: 20, hand: 'left' }),
        'gear-mesh:opposite-hand'
      ],
      [
        gear({ helixAngleDeg: 20, herringbone: true }),
        gear({ helixAngleDeg: 20, hand: 'left' }),
        'gear-mesh:herringbone-mismatch'
      ],
      [
        gear({ gearType: 'internal', teeth: 20 }),
        gear({ teeth: 20 }),
        'gear-mesh:ring-too-small'
      ],
      [
        gear({ profileShift: -3 }),
        gear({ profileShift: -3 }),
        'gear-mesh:no-working-pressure-angle'
      ]
    ];
    for (const [a, b, code] of cases) expect(refused(a, b).code).toBe(code);
    expect(refused(gear(), gear({ module: 2.5 })).message).toBe(
      'Their modules differ (2 and 2.5); meshing gears need the same module or pitch.'
    );
  });

  it('meshes a module-sized gear with the same tooth sized by circular pitch', () => {
    // The resolved module is what matters: 2π circular pitch is module 2.
    expect(
      isGearMeshRefusal(
        meshGearPair(
          gear(),
          gear({ module: (2 * Math.PI) / Math.PI }),
          IDENTITY_TRANSFORM
        )
      )
    ).toBe(false);
  });
});

const owner = toUserId('user_gear_mesh');

function gearInput(
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

function twoGears(b: Partial<GearInput> = {}) {
  const manager = new CommandManager(createProjectDocument('Gears', owner));
  manager.execute(
    commandFactories.gearBody(gearInput('Pinion', { backlash: 0.1 }))
  );
  manager.execute(
    commandFactories.gearBody(
      gearInput('Wheel', { teeth: 40, backlash: 0.1, ...b })
    )
  );
  const [a, w] = manager.document.bodyOrder as [BodyId, BodyId];
  return { manager, a, w };
}

describe('the gear a body shows', () => {
  it('reads a new gear’s values in document units', () => {
    const manager = new CommandManager(
      createProjectDocument('Gears', owner, 'inch')
    );
    manager.execute(
      commandFactories.gearBody(
        gearInput('Gear', {
          sizing: 'diametral-pitch',
          pitch: 10,
          helixAngleDeg: 15,
          hand: 'left',
          profileShift: 0.2,
          axis: { x: 0, y: 1, z: 0 }
        })
      )
    );
    const bodyId = manager.document.bodyOrder[0] as BodyId;
    const read = gearMeshGearOfBody(manager.document, bodyId);
    if (isGearMeshRefusal(read)) throw new Error(read.message);
    expect(read.module).toBeCloseTo(0.1, 12);
    expect(read.pressureAngleDeg).toBe(20);
    expect(read.helixAngleDeg).toBe(15);
    expect(read.hand).toBe('left');
    expect(read.profileShift).toBe(0.2);
    // The adapter's default first-tooth direction for a Y axis: world +X.
    expectVector(read.frame.xAxis, X);
  });

  it('refuses a body that is not a gear, or a gear moved after it was made', () => {
    const { manager, a } = twoGears();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const box = manager.document.bodyOrder[2] as BodyId;
    expect(
      (gearMeshGearOfBody(manager.document, box) as GearMeshRefusal).code
    ).toBe('gear-mesh:not-a-gear');
    manager.execute(
      commandFactories.transformBody({
        name: 'Move 1',
        targetBodyId: a,
        translation: { x: 5, y: 0, z: 0 }
      })
    );
    expect(
      (gearMeshGearOfBody(manager.document, a) as GearMeshRefusal).code
    ).toBe('gear-mesh:moved');
  });
});

describe('Mesh gears in an assembly', () => {
  function assembled(b: Partial<GearInput> = {}) {
    const fixture = twoGears(b);
    fixture.manager.execute(
      commandFactories.addAssemblyComponents({
        components: [
          {
            componentId: 'comp_a',
            name: 'Pinion',
            bodyId: fixture.a,
            grounded: false
          },
          {
            componentId: 'comp_b',
            name: 'Wheel',
            bodyId: fixture.w,
            grounded: false
          }
        ]
      })
    );
    const document = fixture.manager.document;
    const bodies = assemblyComponentBodies(document);
    const context = gearMeshContext(document, (id) => bodies.get(id) ?? null)!;
    return { ...fixture, context };
  }

  it('saves a revolute joint that places the wheel in mesh', () => {
    const { manager, context } = assembled();
    const result = gearMeshJoint(
      context,
      { baseId: 'comp_a', movingId: 'comp_b' },
      'joint_mesh'
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.joint.kind).toBe('revolute');
    expect(result.joint.name).toBe('Gear mesh');
    expect(result.joint.values).toEqual([0]);
    expect(result.groundBase).toBe(true);
    expect(result.mesh.centerDistance).toBeCloseTo(60, 12);
    expect(result.mesh.backlash).toBeCloseTo(0.2, 12);
    manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_a',
        grounded: true
      })
    );
    manager.execute(commandFactories.addAssemblyJoint({ joint: result.joint }));
    const solution = solveAssembly(manager.document.assembly!);
    expect(solution.unsolved.size).toBe(0);
    const pose = composeTransforms(
      invertTransform(solution.poses.get('comp_a')!),
      solution.poses.get('comp_b')!
    );
    // The wheel's own frame lands where the helper put it.
    const landed = frameInWorld(pose, {
      origin: ORIGIN,
      zAxis: Z,
      xAxis: X
    });
    expectVector(landed.origin, result.mesh.frame.origin);
    expectVector(landed.xAxis, result.mesh.frame.xAxis);
    // Turning the joint turns the wheel about its own axis, in place.
    const turned = solveAssembly({
      ...manager.document.assembly!,
      joints: manager.document.assembly!.joints.map((j) => ({
        ...j,
        values: [90]
      }))
    });
    const centre = transformPoint(turned.poses.get('comp_b')!, {
      x: 0,
      y: 0,
      z: 2.5
    });
    expectVector(centre, { x: 60, y: 0, z: 2.5 });
  });

  it('refuses a mismatched pair and a part that is not a gear, by reason', () => {
    const { context } = assembled({ pitch: 2.5 });
    const result = gearMeshJoint(
      context,
      { baseId: 'comp_a', movingId: 'comp_b' },
      'joint_mesh'
    );
    expect('code' in result && result.code).toBe('gear-mesh:module-mismatch');
  });
});

/**
 * The phase and distance against the kernel's own teeth: both gears built
 * by Remus where the helper puts them, then a grid of points across the
 * pitch point, a pitch either way along the tangent and a module either
 * side of the pitch line, classified against both. (A boolean intersection
 * of two involute gears is far slower and refuses as not exact.)
 */
describe('meshed pairs on the exact kernel', { timeout: 120_000 }, () => {
  let kernel: RemusKernel;
  beforeAll(() => {
    kernel = new RemusKernel();
  });
  afterAll(() => kernel.free());

  function build(g: GearMeshGear, frame: AssemblyFrame, turnDeg = 0): number {
    const v = (p: Vector3) => [p.x, p.y, p.z];
    const spec: Record<string, unknown> = {
      kind: g.gearType,
      module: g.module,
      teeth: g.teeth,
      faceWidth: g.faceWidth,
      pressureAngle: g.pressureAngleDeg,
      backlash: g.backlash,
      origin: v(frame.origin),
      axis: v(frame.zAxis),
      xDirection: v(frame.xAxis)
    };
    if (g.gearType !== 'rack') spec.phase = g.phaseDeg + turnDeg;
    if (g.profileShift) spec.profileShift = g.profileShift;
    if (g.helixAngleDeg) {
      spec.helixAngle = g.helixAngleDeg;
      spec.hand = g.hand;
    }
    if (g.gearType === 'internal')
      spec.rimDiameter =
        (g.teeth * g.module) / Math.cos(g.helixAngleDeg * DEG) + 12 * g.module;
    const result = kernel.makeGearDetailed(JSON.stringify(spec)) as {
      status: string;
      value?: unknown;
    };
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    const value = result.value as number | { solid: number };
    return typeof value === 'number' ? value : value.solid;
  }

  /** Grid points inside both solids, and inside each, about `p`. */
  function overlap(
    s1: number,
    s2: number,
    p: Vector3,
    tangent: Vector3,
    normal: Vector3,
    pitch: number,
    module: number,
    zs: number[]
  ) {
    let both = 0;
    let first = 0;
    let second = 0;
    for (const z of zs)
      for (let i = -pitch; i <= pitch + 1e-9; i += 0.1)
        for (
          let j = -0.8 * module;
          j <= 0.8 * module + 1e-9;
          j += 0.4 * module
        ) {
          const x = p.x + tangent.x * i + normal.x * j;
          const y = p.y + tangent.y * i + normal.y * j;
          const inA = kernel.classifyPoint(s1, x, y, z, 1e-7) === 'inside';
          const inB = kernel.classifyPoint(s2, x, y, z, 1e-7) === 'inside';
          if (inA) first += 1;
          if (inB) second += 1;
          if (inA && inB) both += 1;
        }
    return { both, first, second };
  }

  /** The pitch point and its tangent, for a pair of gears on Z axes. */
  function pitchPoint(a: GearMeshGear, mesh: GearMeshSolution) {
    const o = mesh.frame.origin;
    const d = Math.hypot(o.x, o.y);
    const u = { x: o.x / d, y: o.y / d, z: 0 };
    const rw =
      (((a.module / Math.cos(a.helixAngleDeg * DEG)) * a.teeth) / 2) *
      (mesh.centerDistance / mesh.standardCenterDistance);
    const sign = mesh.pair === 'internal' && a.gearType !== 'internal' ? -1 : 1;
    return {
      p: { x: sign * u.x * rw, y: sign * u.y * rw, z: 0 },
      tangent: { x: -u.y, y: u.x, z: 0 },
      normal: u
    };
  }

  it('interleaves an external spur pair with its play and no more', () => {
    const a = gear({ backlash: 0.1, phaseDeg: 5 });
    const b = gear({ teeth: 31, backlash: 0.1, profileShift: 0.25 });
    const mesh = solved(a, b);
    const { p, tangent, normal } = pitchPoint(a, mesh);
    const sa = build(a, a.frame);
    const pitch = 2 * Math.PI;
    const at = (turnMm: number) =>
      overlap(
        sa,
        build(b, mesh.frame, (turnMm / (31 * 1)) * (180 / Math.PI)),
        p,
        tangent,
        normal,
        pitch,
        2,
        [2.5]
      );
    const meshed = at(0);
    expect(meshed.both).toBe(0);
    // Both gears' teeth are on the grid: the pair is in mesh, not apart.
    expect(meshed.first).toBeGreaterThan(40);
    expect(meshed.second).toBeGreaterThan(40);
    // Turned past half the 0.2 play either way, the teeth collide: the
    // centres are no further apart than the working distance.
    expect(at(0.35).both).toBeGreaterThan(0);
    expect(at(-0.35).both).toBeGreaterThan(0);
    // Half a pitch out, tooth meets tooth.
    expect(at(pitch / 2).both).toBeGreaterThan(20);
  });

  it('interleaves an opposite-hand helical pair across the face', () => {
    const a = gear({ helixAngleDeg: 20, phaseDeg: 2 });
    const b = gear({
      teeth: 27,
      helixAngleDeg: 20,
      hand: 'left',
      backlash: 0.1
    });
    const mesh = solved(a, b);
    const { p, tangent, normal } = pitchPoint(a, mesh);
    const sa = build(a, a.frame);
    const pitch = (2 * Math.PI) / Math.cos(20 * DEG);
    const meshed = overlap(
      sa,
      build(b, mesh.frame),
      p,
      tangent,
      normal,
      pitch,
      2,
      [0.5, 4.5]
    );
    expect(meshed.both).toBe(0);
    expect(meshed.first).toBeGreaterThan(40);
    // The same placement with a right-hand wheel collides: hands matter.
    const wrongHand = mesh;
    expect(
      overlap(
        sa,
        build({ ...b, hand: 'right' }, wrongHand.frame),
        p,
        tangent,
        normal,
        pitch,
        2,
        [0.5, 4.5]
      ).both
    ).toBeGreaterThan(0);
  });

  it('interleaves a pinion inside its ring', () => {
    const ring = gear({ gearType: 'internal', teeth: 54, backlash: 0.1 });
    const pinion = gear({ teeth: 17, phaseDeg: 7, backlash: 0.1 });
    const mesh = solved(ring, pinion);
    const { p, tangent, normal } = pitchPoint(ring, mesh);
    const sr = build(ring, ring.frame);
    const pitch = 2 * Math.PI;
    const meshed = overlap(
      sr,
      build(pinion, mesh.frame),
      p,
      tangent,
      normal,
      pitch,
      2,
      [2.5]
    );
    expect(meshed.both).toBe(0);
    expect(meshed.first).toBeGreaterThan(40);
    expect(meshed.second).toBeGreaterThan(40);
    const off = overlap(
      sr,
      build(pinion, mesh.frame, 180 / 17),
      p,
      tangent,
      normal,
      pitch,
      2,
      [2.5]
    );
    expect(off.both).toBeGreaterThan(20);
  });

  it('interleaves a pinion on a rack', () => {
    const rack = gear({ gearType: 'rack', teeth: 12, backlash: 0.1 });
    const pinion = gear({ teeth: 15, phaseDeg: 4 });
    const current: RigidTransform = {
      t: { x: 23, y: 20, z: 0 },
      q: IDENTITY_TRANSFORM.q
    };
    const mesh = solved(rack, pinion, current);
    const sr = build(rack, rack.frame);
    const p = { x: 23, y: 0, z: 0 };
    const pitch = 2 * Math.PI;
    const meshed = overlap(
      sr,
      build(pinion, mesh.frame),
      p,
      X,
      { x: 0, y: 1, z: 0 },
      pitch,
      2,
      [2.5]
    );
    expect(meshed.both).toBe(0);
    expect(meshed.first).toBeGreaterThan(40);
    expect(meshed.second).toBeGreaterThan(40);
    const off = overlap(
      sr,
      build(pinion, mesh.frame, 12),
      p,
      X,
      { x: 0, y: 1, z: 0 },
      pitch,
      2,
      [2.5]
    );
    expect(off.both).toBeGreaterThan(20);
  });
});
