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
  gearMeshRefusalText,
  gearPlacementFrame,
  gearToothCircles,
  isGearMeshRefusal,
  meshGearPair,
  solveAssembly,
  toUserId,
  transformPoint,
  type AssemblyFrame,
  type BodyId,
  type GearMeshGear,
  type GearMeshRefusal,
  type RigidTransform,
  type Vector3
} from '@openzcad/shared';
import { gearMeshContext } from '../apps/web/src/lib/assembly/gearMesh';
import { gearMeshJoint } from '../apps/web/src/lib/assembly/gearMeshJoint';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  createGearMeshProbe,
  DEG,
  gear,
  solved
} from './support/gearMeshKernel';

/**
 * M14 meshing-pair helper: the working centre distance and tooth phase of a
 * parallel-axis pair (external, internal, rack and pinion), its refusals,
 * the gear a body shows, and the revolute joint Assemble saves.
 */

const Z: Vector3 = { x: 0, y: 0, z: 1 };
const X: Vector3 = { x: 1, y: 0, z: 0 };
const ORIGIN: Vector3 = { x: 0, y: 0, z: 0 };

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

  it('reads a herringbone’s hands with the axis sense it will have', () => {
    const upsideDown: RigidTransform = {
      t: { x: 0, y: 0, z: 10 },
      q: axisAngleQuaternion(X, Math.PI)
    };
    const herringbone = { helixAngleDeg: 20, herringbone: true };
    const right = gear(herringbone);
    const left = gear({ ...herringbone, teeth: 27, hand: 'left' });
    const sameRight = gear({ ...herringbone, teeth: 27 });
    const meshes = (a: GearMeshGear, b: GearMeshGear, t: RigidTransform) =>
      !isGearMeshRefusal(meshGearPair(a, b, t));
    const code = (a: GearMeshGear, b: GearMeshGear, t: RigidTransform) => {
      const result = meshGearPair(a, b, t);
      return isGearMeshRefusal(result) ? result.code : null;
    };
    // Facing the same way: opposite stored hands, as for a single helix.
    expect(meshes(right, left, IDENTITY_TRANSFORM)).toBe(true);
    expect(code(right, sameRight, IDENTITY_TRANSFORM)).toBe(
      'gear-mesh:same-hand'
    );
    // Turned end for end, the wheel meets the pinion with its other half:
    // the same stored hand meshes and opposite stored hands do not.
    expect(meshes(right, sameRight, upsideDown)).toBe(true);
    expect(code(right, left, upsideDown)).toBe('gear-mesh:same-hand');
    // In a ring the rule turns over too.
    const ring = gear({ ...herringbone, gearType: 'internal', teeth: 60 });
    expect(meshes(ring, right, IDENTITY_TRANSFORM)).toBe(true);
    expect(
      meshes(ring, gear({ ...herringbone, hand: 'left' }), upsideDown)
    ).toBe(true);
    expect(code(ring, right, upsideDown)).toBe('gear-mesh:opposite-hand');
    // A single helix keeps its hand end for end: opposite hands either way.
    const single = { helixAngleDeg: 20 };
    expect(
      meshes(gear(single), gear({ ...single, hand: 'left' }), upsideDown)
    ).toBe(true);
    expect(code(gear(single), gear(single), upsideDown)).toBe(
      'gear-mesh:same-hand'
    );
  });

  it('refuses tips that would dig into the mate’s roots', () => {
    // Two m 2, 20-tooth gears at 40: the wheel's root at 20 − 0.5·2 = 19
    // leaves the pinion's 22 tip 1 too long.
    const shallow = refused(gear(), gear({ dedendum: 0.5 }));
    expect(shallow.code).toBe('gear-mesh:tip-clearance');
    expect(shallow.clearance?.gear).toBe('base');
    expect(shallow.clearance?.overlap).toBeCloseTo(1, 12);
    // The plain message carries no length; the card adds the unit.
    expect(shallow.message).not.toMatch(/\d/);
    expect(gearMeshRefusalText(shallow, 'mm')).toMatch(
      /^The gear that stays put reaches 1 mm past the other gear/
    );
    expect(gearMeshRefusalText(shallow, 'in')).toMatch(/reaches 1 in past/);
    // The other way round, it is the meshing gear whose tips are too long.
    const other = refused(gear({ dedendum: 0.5 }), gear());
    expect(other.clearance?.gear).toBe('moving');
    expect(gearMeshRefusalText(other, 'mm')).toMatch(
      /^The gear that meshes with it reaches 1 mm past/
    );
    // Zero clearance (addendum = dedendum) still meshes.
    expect(
      isGearMeshRefusal(
        meshGearPair(gear(), gear({ dedendum: 1 }), IDENTITY_TRANSFORM)
      )
    ).toBe(false);
    // A ring whose inner tips (40 − 1.5·2 = 37) pass the pinion's root
    // (20 + 17.5 from the ring's centre).
    expect(
      refused(gear({ gearType: 'internal', teeth: 40, addendum: 1.5 }), gear())
        .code
    ).toBe('gear-mesh:tip-clearance');
    // A pinion too long for the ring's root: 20 + 23.1 past 40 + 2.5.
    expect(
      refused(
        gear({ gearType: 'internal', teeth: 40 }),
        gear({ addendum: 1.55 })
      ).code
    ).toBe('gear-mesh:tip-clearance');
    // A rack tooth 3 tall under a pinion root 2.5 above the pitch line, and
    // a pinion tip 2 below the line over a rack root only 1.8 deep.
    expect(
      refused(gear({ gearType: 'rack', teeth: 12, addendum: 1.5 }), gear()).code
    ).toBe('gear-mesh:tip-clearance');
    expect(
      refused(gear(), gear({ gearType: 'rack', teeth: 12, dedendum: 0.9 })).code
    ).toBe('gear-mesh:tip-clearance');
    // Large shifts on both gears grow the tips more than the working
    // distance grows, as the kernel does not shorten tips.
    expect(
      refused(gear({ profileShift: 0.8 }), gear({ profileShift: 0.8 })).code
    ).toBe('gear-mesh:tip-clearance');
  });

  it('reads a placement as the kernel does, never substituting an x direction', () => {
    const origin = { x: 1, y: 2, z: 3 };
    // Almost along the axis: the tiny perpendicular part is the x direction.
    const near = gearPlacementFrame(
      origin,
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 1e-5, z: 1 }
    )!;
    expectVector(near.xAxis, { x: 0, y: 1, z: 0 }, 12);
    // A long axis and a tilted x direction: unit axis, x squared to it.
    const tilted = gearPlacementFrame(
      origin,
      { x: 0, y: 0, z: 3 },
      { x: 0.2, y: 1, z: 5 }
    )!;
    expectVector(tilted.zAxis, Z, 12);
    expectVector(
      tilted.xAxis,
      { x: 0.2 / Math.hypot(0.2, 1), y: 1 / Math.hypot(0.2, 1), z: 0 },
      12
    );
    // The kernel refuses only when the projection has no length at all:
    // 1e-160 still places (its square is subnormal), 1e-200 does not.
    expect(
      gearPlacementFrame(origin, Z, { x: 0, y: 1e-160, z: 1 })
    ).not.toBeNull();
    expect(gearPlacementFrame(origin, Z, { x: 0, y: 1e-200, z: 1 })).toBeNull();
    expect(gearPlacementFrame(origin, Z, { x: 0, y: 0, z: -2 })).toBeNull();
    expect(gearPlacementFrame(origin, { x: 0, y: 0, z: 0 }, X)).toBeNull();
    const parallel = meshGearPair(
      gear({ frame: { origin, zAxis: Z, xAxis: { x: 0, y: 0, z: 1 } } }),
      gear(),
      IDENTITY_TRANSFORM
    );
    expect(isGearMeshRefusal(parallel) && parallel.code).toBe(
      'gear-mesh:invalid-placement'
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

  it('reads a stored x direction almost along the axis as the kernel does', () => {
    const manager = new CommandManager(createProjectDocument('Gears', owner));
    manager.execute(
      commandFactories.gearBody(
        gearInput('Gear', { xDirection: { x: 0, y: 0.00001, z: 1 } })
      )
    );
    const read = gearMeshGearOfBody(
      manager.document,
      manager.document.bodyOrder[0] as BodyId
    );
    if (isGearMeshRefusal(read)) throw new Error(read.message);
    expectVector(read.frame.xAxis, { x: 0, y: 1, z: 0 }, 12);
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

  it('places a gear stored with a non-unit axis where the helper says', () => {
    // The wheel's axis is stored as (0, 0, 2): the kernel reads a direction.
    const { manager, context } = assembled({ axis: { x: 0, y: 0, z: 2 } });
    const wheel = context.gearOf('comp_b');
    if (isGearMeshRefusal(wheel)) throw new Error(wheel.message);
    expectVector(wheel.frame.zAxis, Z);
    // The joint path also squares a raw gear's frame itself.
    const raw = {
      ...context,
      gearOf: (id: string) =>
        id === 'comp_b'
          ? { ...wheel, frame: { ...wheel.frame, zAxis: { x: 0, y: 0, z: 2 } } }
          : context.gearOf(id)
    };
    for (const ctx of [context, raw]) {
      const result = gearMeshJoint(
        ctx,
        { baseId: 'comp_a', movingId: 'comp_b' },
        'joint_mesh'
      );
      if ('error' in result) throw new Error(result.error);
      const set = manager.document.assembly!;
      const solution = solveAssembly({
        ...set,
        components: set.components.map((c) =>
          c.id === 'comp_a' ? { ...c, grounded: true } : c
        ),
        joints: [result.joint]
      });
      const pose = composeTransforms(
        invertTransform(solution.poses.get('comp_a')!),
        solution.poses.get('comp_b')!
      );
      const landed = frameInWorld(pose, { origin: ORIGIN, zAxis: Z, xAxis: X });
      expectVector(landed.origin, result.mesh.frame.origin);
      expectVector(landed.origin, { x: 60, y: 0, z: 0 });
      expectVector(landed.zAxis, result.mesh.frame.zAxis);
      expectVector(landed.xAxis, result.mesh.frame.xAxis);
    }
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
 * The kernel's own teeth, cheaply: the tip and root circles it reports, a
 * pinion on a rack and a gear whose x direction is stored almost along its
 * axis, each built by Remus where the helper puts it and sampled on a grid
 * across the pitch point. The slower spur, ring, helical and herringbone
 * samplings are in `gear-mesh-kernel.test.ts` (full suite).
 */
describe('meshed pairs on the exact kernel', { timeout: 120_000 }, () => {
  let kernel: RemusKernel;
  beforeAll(() => {
    kernel = new RemusKernel();
  });
  afterAll(() => kernel.free());
  const { build, overlap, pitchPoint, lastDetails } = createGearMeshProbe(
    () => kernel
  );

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
  it('reads the tip and root circles the kernel cuts', () => {
    for (const g of [
      gear(),
      gear({ profileShift: 0.4, teeth: 23 }),
      gear({ helixAngleDeg: 20, profileShift: -0.2 }),
      gear({ addendum: 0.8, dedendum: 1.4 }),
      gear({ gearType: 'internal', teeth: 50, profileShift: 0.2 }),
      gear({ gearType: 'internal', teeth: 50, addendum: 0.8 })
    ]) {
      build(g, g.frame);
      const { geometry } = lastDetails() as {
        geometry: { tipDiameter: number; rootDiameter: number };
      };
      const circles = gearToothCircles(g);
      expect(circles.tip * 2).toBeCloseTo(geometry.tipDiameter, 9);
      expect(circles.root * 2).toBeCloseTo(geometry.rootDiameter, 9);
    }
  });

  it('phases a gear whose x direction is stored almost along its axis', () => {
    // Stored x (0, 0.00001, 1) on a Z axis: the kernel keeps the tiny +Y
    // part, so tooth 0 points along +Y, not along a substituted +X.
    const stored: AssemblyFrame = {
      origin: { x: 0, y: 0, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      xAxis: { x: 0, y: 0.00001, z: 1 }
    };
    const a = gear({ teeth: 22, frame: stored });
    const b = gear({ teeth: 27, backlash: 0.2 });
    const mesh = solved(a, b);
    const { p, tangent, normal } = pitchPoint(a, mesh);
    // A is built from the stored frame exactly as the adapter sends it.
    const sa = build(a, stored);
    const meshed = overlap(
      sa,
      build(b, mesh.frame),
      p,
      tangent,
      normal,
      2 * Math.PI,
      2,
      [2.5],
      0.2
    );
    expect(meshed.both).toBe(0);
    expect(meshed.first).toBeGreaterThan(15);
    expect(meshed.second).toBeGreaterThan(15);
  });
});
