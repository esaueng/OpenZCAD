import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_JOINT_DOFS,
  IDENTITY_PLACEMENT,
  asBuiltChildFrame,
  assemblySetError,
  axisAngleQuaternion,
  composeTransforms,
  dragSpecFor,
  evaluateTrack,
  flipFrame,
  frameFromAxis,
  frameInWorld,
  jointAddError,
  jointSweepRange,
  jointSweepValue,
  motionStudyValues,
  placementToTransform,
  playbackTime,
  rotateVector,
  solveAssembly,
  transformPoint,
  transformToMatrix4,
  transformToPlacement,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblyJointKind,
  type AssemblySet,
  type BodyId,
  type RigidTransform,
  type Vector3
} from '@openzcad/shared';

/**
 * AS02/AS06/AS07 kinematics: exact tree forward kinematics, honest loop
 * reporting, drag mapping and time-pure playback. Lengths mm, angles deg.
 */
const TOL = 1e-9;
const v = (x: number, y: number, z: number): Vector3 => ({ x, y, z });
const Z_FRAME: AssemblyFrame = {
  origin: v(0, 0, 0),
  zAxis: v(0, 0, 1),
  xAxis: v(1, 0, 0)
};

function expectPoint(actual: Vector3, expected: Vector3, tol = TOL) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tol);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tol);
  expect(Math.abs(actual.z - expected.z)).toBeLessThanOrEqual(tol);
}

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
  parent: string,
  child: string,
  values: number[] = ASSEMBLY_JOINT_DOFS[kind].map(() => 0),
  frames: { parent?: AssemblyFrame; child?: AssemblyFrame } = {}
): AssemblyJoint {
  return {
    id,
    name: id,
    kind,
    parent: { componentId: parent, frame: frames.parent ?? Z_FRAME },
    child: { componentId: child, frame: frames.child ?? Z_FRAME },
    values,
    limits: ASSEMBLY_JOINT_DOFS[kind].map(() => null)
  };
}

function scissors(angle = 0): AssemblySet {
  return {
    components: [component('blade_a', true), component('blade_b')],
    joints: [joint('pivot', 'revolute', 'blade_a', 'blade_b', [angle])],
    positions: [],
    studies: []
  };
}

describe('assembly kinematics (AS02)', () => {
  it('leaves an as-built revolute pair where it was modelled at 0°', () => {
    const solution = solveAssembly(scissors(0));
    const pose = solution.poses.get('blade_b') as RigidTransform;
    expectPoint(transformPoint(pose, v(120, 7, 3)), v(120, 7, 3));
    expect(solution.roles.get('blade_a')).toBe('grounded');
    expect(solution.roles.get('blade_b')).toBe('driven');
    expect(solution.dof).toBe(1);
    expect(solution.unsolved.size).toBe(0);
  });

  it('turns the child about the joint axis by its value', () => {
    const pose = solveAssembly(scissors(90)).poses.get(
      'blade_b'
    ) as RigidTransform;
    expectPoint(transformPoint(pose, v(10, 0, 0)), v(0, 10, 0));
    const at35 = solveAssembly(scissors(35)).poses.get(
      'blade_b'
    ) as RigidTransform;
    const r = 35 * (Math.PI / 180);
    expectPoint(
      transformPoint(at35, v(100, 0, 2)),
      v(100 * Math.cos(r), 100 * Math.sin(r), 2)
    );
  });

  it('turns about an off-origin, tilted axis through the frame origin', () => {
    const frame = frameFromAxis(v(5, -3, 2), v(1, 1, 0)) as AssemblyFrame;
    const set = scissors(180);
    (set.joints[0] as AssemblyJoint).parent.frame = frame;
    (set.joints[0] as AssemblyJoint).child.frame = frame;
    const pose = solveAssembly(set).poses.get('blade_b') as RigidTransform;
    // A half turn about a line maps a point to its mirror through the line.
    const p = v(6, -2, 2); // on the axis
    expectPoint(transformPoint(pose, p), p);
    const q = v(6, -4, 2); // off the axis, perpendicular offset (1,-1,0)
    expectPoint(transformPoint(pose, q), v(4, -2, 2));
  });

  it('solves a joint reached from its child side with the inverse motion', () => {
    const set: AssemblySet = {
      components: [component('blade_a'), component('blade_b', true)],
      joints: [joint('pivot', 'revolute', 'blade_a', 'blade_b', [90])],
      positions: [],
      studies: []
    };
    const solution = solveAssembly(set);
    const pose = solution.poses.get('blade_a') as RigidTransform;
    expectPoint(transformPoint(pose, v(10, 0, 0)), v(0, -10, 0));
    expect(solution.links.get('blade_a')).toEqual({
      jointId: 'pivot',
      forward: false
    });
  });

  it('slides along the frame axis in millimetres', () => {
    const frame = frameFromAxis(v(0, 0, 0), v(1, 0, 0)) as AssemblyFrame;
    const set: AssemblySet = {
      components: [component('rail', true), component('carriage')],
      joints: [
        joint('slide', 'slider', 'rail', 'carriage', [12.5], {
          parent: frame,
          child: frame
        })
      ],
      positions: [],
      studies: []
    };
    const pose = solveAssembly(set).poses.get('carriage') as RigidTransform;
    expectPoint(transformPoint(pose, v(1, 2, 3)), v(13.5, 2, 3));
  });

  it('keeps every component in place when a joint is added as-built', () => {
    const parentPose: RigidTransform = {
      t: v(10, -4, 7),
      q: axisAngleQuaternion(v(1, 2, 3), 0.7)
    };
    const childPose: RigidTransform = {
      t: v(-3, 8, 1),
      q: axisAngleQuaternion(v(-2, 1, 0.5), -1.1)
    };
    const parentFrame = frameFromAxis(v(1, 2, 3), v(0, 1, 1)) as AssemblyFrame;
    for (const kind of [
      'rigid',
      'revolute',
      'cylindrical',
      'ball',
      'planar'
    ] as const) {
      const values = ASSEMBLY_JOINT_DOFS[kind].map((_, i) => 10 + i * 7);
      const childFrame = asBuiltChildFrame(
        parentPose,
        parentFrame,
        childPose,
        kind,
        values
      );
      const set: AssemblySet = {
        components: [
          {
            ...component('p', true),
            placement: transformToPlacement(parentPose)
          },
          component('c')
        ],
        joints: [
          joint('j', kind, 'p', 'c', values, {
            parent: parentFrame,
            child: childFrame
          })
        ],
        positions: [],
        studies: []
      };
      const solved = solveAssembly(set).poses.get('c') as RigidTransform;
      for (const point of [v(0, 0, 0), v(50, -20, 9), v(-7, 3, 100)]) {
        expectPoint(
          transformPoint(solved, point),
          transformPoint(childPose, point),
          1e-9
        );
      }
    }
  });

  it('reports loops and grounded pairs instead of dropping them', () => {
    const loop: AssemblySet = {
      components: [component('a', true), component('b'), component('c')],
      joints: [
        joint('ab', 'revolute', 'a', 'b'),
        joint('bc', 'revolute', 'b', 'c'),
        joint('ca', 'revolute', 'c', 'a')
      ],
      positions: [],
      studies: []
    };
    const solution = solveAssembly(loop);
    expect([...solution.unsolved]).toEqual([['ca', 'loop']]);
    expect(solution.dof).toBe(2);

    const grounded: AssemblySet = {
      components: [component('a', true), component('b', true)],
      joints: [joint('ab', 'revolute', 'a', 'b')],
      positions: [],
      studies: []
    };
    expect([...solveAssembly(grounded).unsolved]).toEqual([
      ['ab', 'grounded-both']
    ]);
  });

  it('counts six free motions for an unconnected, ungrounded component', () => {
    const set = scissors(0);
    set.components.push(component('washer'));
    const solution = solveAssembly(set);
    expect(solution.roles.get('washer')).toBe('free');
    expect(solution.dof).toBe(7);
  });

  it('clamps values and overrides into the joint limits', () => {
    const set = scissors(0);
    (set.joints[0] as AssemblyJoint).limits = [{ min: 0, max: 35 }];
    const solution = solveAssembly(set, new Map([['pivot', [50]]]));
    expect(solution.values.get('pivot')).toEqual([35]);
    const below = solveAssembly(set, new Map([['pivot', [-5]]]));
    expect(below.values.get('pivot')).toEqual([0]);
  });

  it('maps a drag to the nearest movable joint toward the ground', () => {
    const set: AssemblySet = {
      components: [
        component('base', true),
        component('arm'),
        component('tool')
      ],
      joints: [
        joint('shoulder', 'revolute', 'base', 'arm', [20]),
        joint('mount', 'rigid', 'arm', 'tool')
      ],
      positions: [],
      studies: []
    };
    const solution = solveAssembly(set);
    const spec = dragSpecFor(set, solution, 'tool');
    expect(spec?.jointId).toBe('shoulder');
    expect(spec?.unit).toBe('deg');
    expect(spec?.direction).toBe(1);
    expect(spec?.startValue).toBe(20);
    expectPoint(spec?.axis as Vector3, v(0, 0, 1));
    expect(dragSpecFor(set, solution, 'base')).toBeNull();

    const reversed: AssemblySet = {
      components: [component('a'), component('b', true)],
      joints: [joint('pivot', 'revolute', 'a', 'b', [0])],
      positions: [],
      studies: []
    };
    expect(dragSpecFor(reversed, solveAssembly(reversed), 'a')?.direction).toBe(
      -1
    );
  });

  it('builds deterministic orthonormal frames and flips them', () => {
    const frame = frameFromAxis(v(1, 1, 1), v(0, 0, 2)) as AssemblyFrame;
    expect(frame).toEqual({
      origin: v(1, 1, 1),
      zAxis: v(0, 0, 1),
      xAxis: v(1, 0, 0)
    });
    expect(frameFromAxis(v(0, 0, 0), v(0, 0, 0))).toBeNull();
    const tilted = frameFromAxis(
      v(0, 0, 0),
      v(1, 2, 2),
      v(0, 0, 1)
    ) as AssemblyFrame;
    const dot =
      tilted.zAxis.x * tilted.xAxis.x +
      tilted.zAxis.y * tilted.xAxis.y +
      tilted.zAxis.z * tilted.xAxis.z;
    expect(Math.abs(dot)).toBeLessThanOrEqual(TOL);
    expect(flipFrame(frame).zAxis).toEqual(v(-0, -0, -1));
    const world = frameInWorld(placementToTransform(IDENTITY_PLACEMENT), frame);
    expectPoint(world.origin, frame.origin);
  });

  it('writes column-major matrices that match the transform', () => {
    const transform: RigidTransform = {
      t: v(4, 5, 6),
      q: axisAngleQuaternion(v(1, 1, 0), 0.9)
    };
    const m = transformToMatrix4(transform);
    const p = v(1.5, -2, 3);
    const viaMatrix = v(
      (m[0] as number) * p.x +
        (m[4] as number) * p.y +
        (m[8] as number) * p.z +
        (m[12] as number),
      (m[1] as number) * p.x +
        (m[5] as number) * p.y +
        (m[9] as number) * p.z +
        (m[13] as number),
      (m[2] as number) * p.x +
        (m[6] as number) * p.y +
        (m[10] as number) * p.z +
        (m[14] as number)
    );
    expectPoint(viaMatrix, transformPoint(transform, p));
    const composed = composeTransforms(transform, transform);
    expectPoint(
      transformPoint(composed, p),
      transformPoint(transform, transformPoint(transform, p))
    );
    expectPoint(rotateVector(transform.q, v(0, 0, 0)), v(0, 0, 0));
  });

  it('refuses a second joint between the same two components', () => {
    expect(jointAddError(scissors(), 'blade_b', 'blade_a')).toMatch(
      /already joined/
    );
    expect(jointAddError(scissors(), 'blade_a', 'blade_a')).toMatch(
      /two different/
    );
    expect(jointAddError(scissors(), 'blade_a', 'ghost')).toMatch(
      /components of this assembly/
    );
  });
});

describe('assembly motion (AS06/AS07)', () => {
  it('maps elapsed time onto once, loop and ping-pong playback', () => {
    expect(playbackTime('once', 3, 2)).toEqual({ t: 2, done: true });
    expect(playbackTime('once', 1, 2)).toEqual({ t: 1, done: false });
    expect(playbackTime('loop', 5, 2)).toEqual({ t: 1, done: false });
    expect(playbackTime('ping-pong', 3, 2)).toEqual({ t: 1, done: false });
    expect(playbackTime('ping-pong', 4, 2)).toEqual({ t: 0, done: false });
  });

  it('sweeps a joint between its limits, or a full turn without them', () => {
    const limited = {
      kind: 'revolute' as const,
      limits: [{ min: 0, max: 35 }]
    };
    expect(jointSweepRange(limited, 0)).toEqual({ min: 0, max: 35 });
    expect(jointSweepRange({ kind: 'revolute', limits: [null] }, 0)).toEqual({
      min: 0,
      max: 360
    });
    expect(jointSweepRange({ kind: 'slider', limits: [null] }, 0)).toBeNull();
    const range = { min: 0, max: 35 };
    expect(jointSweepValue(range, 'ping-pong', 0.75, 0.75).value).toBeCloseTo(
      35,
      12
    );
    expect(jointSweepValue(range, 'ping-pong', 0.75, 1.5).value).toBeCloseTo(
      0,
      12
    );
    expect(jointSweepValue(range, 'ping-pong', 0.75, 0.375).value).toBeCloseTo(
      17.5,
      12
    );
  });

  it('interpolates keys with linear and eased segments and holds outside them', () => {
    const track = {
      jointId: 'pivot',
      dof: 0,
      keys: [
        { t: 0, value: 0, easing: 'linear' as const },
        { t: 0.8, value: 35, easing: 'linear' as const },
        { t: 1.2, value: 35, easing: 'ease' as const },
        { t: 2, value: 0, easing: 'ease' as const }
      ]
    };
    expect(evaluateTrack(track, -1)).toBe(0);
    expect(evaluateTrack(track, 0.4)).toBeCloseTo(17.5, 12);
    expect(evaluateTrack(track, 1)).toBe(35);
    expect(evaluateTrack(track, 1.6)).toBeCloseTo(17.5, 12);
    expect(evaluateTrack(track, 1.3)).toBeGreaterThan(35 - 35 * 0.125);
    expect(evaluateTrack(track, 9)).toBe(0);
    const set = scissors(12);
    const values = motionStudyValues(
      set,
      {
        id: 's',
        name: 'Open–close',
        durationS: 2,
        playback: 'loop',
        tracks: [track]
      },
      0.4
    );
    expect(values.get('pivot')?.[0]).toBeCloseTo(17.5, 12);
  });
});

describe('assembly section validation (schema v54)', () => {
  it('accepts a valid scissors assembly and refuses malformed content', () => {
    expect(assemblySetError(scissors(10))).toBeNull();
    const badFrame = scissors();
    (badFrame.joints[0] as AssemblyJoint).parent.frame = {
      origin: v(0, 0, 0),
      zAxis: v(0, 0, 1),
      xAxis: v(0, 0.6, 0.8)
    };
    expect(assemblySetError(badFrame)).toMatch(/not perpendicular/);
    const outside = scissors(50);
    (outside.joints[0] as AssemblyJoint).limits = [{ min: 0, max: 35 }];
    expect(assemblySetError(outside)).toMatch(/outside its limits/);
    const twice = scissors();
    twice.joints.push(joint('again', 'rigid', 'blade_b', 'blade_a'));
    expect(assemblySetError(twice)).toMatch(/already joined/);
    const wrongCount = scissors();
    (wrongCount.joints[0] as AssemblyJoint).values = [1, 2];
    expect(assemblySetError(wrongCount)).toMatch(/needs 1 value/);
    const unordered = scissors();
    unordered.studies.push({
      id: 's',
      name: 'S',
      durationS: 2,
      playback: 'loop',
      tracks: [
        {
          jointId: 'pivot',
          dof: 0,
          keys: [
            { t: 1, value: 0, easing: 'linear' },
            { t: 1, value: 2, easing: 'linear' }
          ]
        }
      ]
    });
    expect(assemblySetError(unordered)).toMatch(/out of order/);
  });
});
