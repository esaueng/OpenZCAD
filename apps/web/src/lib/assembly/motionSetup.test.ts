import { describe, expect, it } from 'vitest';
import {
  IDENTITY_PLACEMENT,
  axisAngleQuaternion,
  solveAssembly,
  transformPoint,
  type AssemblyComponent,
  type AssemblySet,
  type BodyId
} from '@openzcad/shared';
import { motionSetupPreviewValues } from './assemblyPlayback';
import {
  defaultMotionRange,
  defaultMotionSetup,
  defaultSlideTravel,
  meshBoundsLookup,
  motionSetupJoint,
  type MotionSetupBox,
  type MotionSetupContext,
  type MotionSetupDraft
} from './motionSetup';

/**
 * A tool resting in a wall holder, as in the supplied reference: the holder
 * is fixed, the tool is a free part, and the motion lifts the tool straight
 * up out of the holder and drops it back in. Boxes stand in for the meshes.
 */
const HOLDER_BOX: MotionSetupBox = {
  min: { x: -30, y: 0, z: 0 },
  max: { x: 30, y: 50, z: 48 }
};
const TOOL_BOX: MotionSetupBox = {
  min: { x: -40, y: 10, z: -260 },
  max: { x: 60, y: 40, z: 40 }
};

function component(
  id: string,
  grounded: boolean,
  extra: Partial<AssemblyComponent> = {}
): AssemblyComponent {
  return {
    id,
    name: id === 'holder' ? 'Holder' : id === 'tool' ? 'Tool' : id,
    bodyId: `body_${id}` as BodyId,
    grounded,
    placement: IDENTITY_PLACEMENT,
    ...extra
  };
}

function holderSet(options: { holderGrounded?: boolean } = {}): AssemblySet {
  return {
    components: [
      component('tool', false),
      component('holder', options.holderGrounded ?? true)
    ],
    joints: [],
    positions: [],
    studies: []
  };
}

function contextFor(set: AssemblySet): MotionSetupContext {
  const boxes: Record<string, MotionSetupBox> = {
    body_holder: HOLDER_BOX,
    body_tool: TOOL_BOX
  };
  return {
    set,
    solution: solveAssembly(set),
    bodyOf: (componentId) =>
      set.components.find((c) => c.id === componentId)?.bodyId ?? null,
    bounds: (bodyId) => boxes[bodyId] ?? null
  };
}

function toolPoint(set: AssemblySet, jointId: string, value: number) {
  const solution = solveAssembly(set, new Map([[jointId, [value]]]));
  const pose = solution.poses.get('tool');
  if (!pose) throw new Error('tool is not placed');
  return transformPoint(pose, { x: 10, y: 20, z: 30 });
}

describe('Set up motion defaults', () => {
  it('lifts the free part up Z, clear of the fixed base, back and forth', () => {
    const draft = defaultMotionSetup(contextFor(holderSet()));
    expect(draft).toEqual({
      baseId: 'holder',
      movingId: 'tool',
      move: 'slide',
      axis: 'z',
      reverse: false,
      // The holder is 48 mm tall along Z: rounded up to 50 mm.
      range: { min: 0, max: 50 },
      mode: 'ping-pong',
      sweepS: 1.5
    });
  });

  it('sizes the slide along the chosen axis, and falls back to 50 mm', () => {
    const context = contextFor(holderSet());
    expect(
      defaultMotionRange(context, {
        baseId: 'holder',
        move: 'slide',
        axis: 'x'
      })
    ).toEqual({ min: 0, max: 60 });
    expect(
      defaultMotionRange(context, { baseId: 'holder', move: 'turn', axis: 'z' })
    ).toEqual({ min: 0, max: 90 });
    expect(defaultSlideTravel(undefined, null, 'z')).toBe(50);
  });

  it('measures the base where it is placed, not where it was modelled', () => {
    const turned = {
      t: { x: 0, y: 0, z: 0 },
      q: axisAngleQuaternion({ x: 1, y: 0, z: 0 }, Math.PI / 2)
    };
    // Turned a quarter about X, the holder's 50 mm Y depth stands along Z.
    expect(defaultSlideTravel(turned, HOLDER_BOX, 'z')).toBe(50);
  });
});

describe('Set up motion joint', () => {
  const draft = (
    partial: Partial<MotionSetupDraft> = {}
  ): MotionSetupDraft => ({
    ...defaultMotionSetup(contextFor(holderSet())),
    ...partial
  });

  it('is an as-built slider: nothing moves at 0, and 50 lifts exactly 50 mm', () => {
    const set = holderSet();
    const made = motionSetupJoint(contextFor(set), draft(), 'j_lift');
    if ('error' in made) throw new Error(made.error);
    expect(made.groundBase).toBe(false);
    expect(made.joint).toMatchObject({
      kind: 'slider',
      name: 'Tool slide',
      parent: { componentId: 'holder', source: { kind: 'body' } },
      child: { componentId: 'tool' },
      values: [0],
      limits: [{ min: 0, max: 50 }]
    });
    const withJoint = { ...set, joints: [made.joint] };
    const rest = toolPoint(withJoint, 'j_lift', 0);
    expect(rest.x).toBeCloseTo(10, 9);
    expect(rest.y).toBeCloseTo(20, 9);
    expect(rest.z).toBeCloseTo(30, 9);
    const lifted = toolPoint(withJoint, 'j_lift', 50);
    expect(lifted.x).toBeCloseTo(10, 9);
    expect(lifted.y).toBeCloseTo(20, 9);
    expect(lifted.z).toBeCloseTo(80, 9);
    expect(solveAssembly(withJoint).unsolved.size).toBe(0);
  });

  it('reverses the slide direction', () => {
    const set = holderSet();
    const made = motionSetupJoint(
      contextFor(set),
      draft({ reverse: true }),
      'j_drop'
    );
    if ('error' in made) throw new Error(made.error);
    const point = toolPoint({ ...set, joints: [made.joint] }, 'j_drop', 20);
    expect(point.z).toBeCloseTo(10, 9);
  });

  it('turns about the axis through the moving part’s centre', () => {
    const set = holderSet();
    const made = motionSetupJoint(
      contextFor(set),
      draft({ move: 'turn', range: { min: 0, max: 90 } }),
      'j_turn'
    );
    if ('error' in made) throw new Error(made.error);
    expect(made.joint.kind).toBe('revolute');
    const solution = solveAssembly(
      { ...set, joints: [made.joint] },
      new Map([['j_turn', [90]]])
    );
    const pose = solution.poses.get('tool');
    if (!pose) throw new Error('tool is not placed');
    // The box centre (10, 25, -110) is on the pivot: it stays put.
    const centre = transformPoint(pose, { x: 10, y: 25, z: -110 });
    expect(centre.x).toBeCloseTo(10, 9);
    expect(centre.y).toBeCloseTo(25, 9);
    expect(centre.z).toBeCloseTo(-110, 9);
    // A point 10 mm along +X from the centre swings to +Y.
    const swung = transformPoint(pose, { x: 20, y: 25, z: -110 });
    expect(swung.x).toBeCloseTo(10, 9);
    expect(swung.y).toBeCloseTo(35, 9);
  });

  it('fixes a floating base on Create', () => {
    const set = holderSet({ holderGrounded: false });
    const made = motionSetupJoint(
      contextFor(set),
      draft({ baseId: 'holder', movingId: 'tool' }),
      'j'
    );
    expect(made).toMatchObject({ groundBase: true });
  });

  it('starts inside a range that does not include the current pose', () => {
    const made = motionSetupJoint(
      contextFor(holderSet()),
      draft({ range: { min: 10, max: 40 } }),
      'j'
    );
    expect(made).toMatchObject({ joint: { values: [10] } });
  });

  it.each([
    [{ movingId: 'holder' }, 'different part'],
    [{ range: { min: 5, max: 5 } }, 'Give the motion a range'],
    [{ movingId: null }, 'Choose the part that moves']
  ] as const)('refuses %o', (partial, message) => {
    const made = motionSetupJoint(contextFor(holderSet()), draft(partial), 'j');
    expect('error' in made ? made.error : '').toContain(message);
  });

  it('refuses to move a fixed part', () => {
    const set: AssemblySet = {
      ...holderSet(),
      components: [component('tool', true), component('holder', true)]
    };
    const made = motionSetupJoint(contextFor(set), draft(), 'j');
    expect('error' in made ? made.error : '').toContain('Tool is fixed');
  });

  it('refuses a second motion on a part that already moves (no hidden loop)', () => {
    const set = holderSet();
    const first = motionSetupJoint(contextFor(set), draft(), 'j_lift');
    if ('error' in first) throw new Error(first.error);
    const withThird: AssemblySet = {
      ...set,
      components: [...set.components, component('hook', true)],
      joints: [first.joint]
    };
    const made = motionSetupJoint(
      contextFor(withThird),
      draft({ baseId: 'hook', movingId: 'tool' }),
      'j_again'
    );
    expect(made).toEqual({
      error:
        'Tool already moves on Tool slide. Open that joint to change its motion.'
    });
  });
});

describe('Set up motion preview and bounds', () => {
  it('previews the exact sweep Create plays; once repeats while previewing', () => {
    const made = motionSetupJoint(
      contextFor(holderSet()),
      defaultMotionSetup(contextFor(holderSet())),
      'preview'
    );
    if ('error' in made) throw new Error(made.error);
    const setup = {
      draft: { ...defaultMotionSetup(contextFor(holderSet())), sweepS: 2 },
      preview: made.joint,
      previewing: true
    };
    expect(motionSetupPreviewValues(setup, 0)).toEqual([0]);
    expect(motionSetupPreviewValues(setup, 2)?.[0]).toBeCloseTo(50, 9);
    // Back and forth: halfway back down at 3 s.
    expect(motionSetupPreviewValues(setup, 3)?.[0]).toBeCloseTo(25, 9);
    const once = { ...setup, draft: { ...setup.draft, mode: 'once' as const } };
    expect(motionSetupPreviewValues(once, 2.5)?.[0]).toBeLessThan(50);
    expect(
      motionSetupPreviewValues({ ...setup, previewing: false }, 1)
    ).toBeNull();
  });

  it('reads body boxes from display meshes once per body', () => {
    const bounds = meshBoundsLookup({
      body_a: { mesh: { vertices: [0, 0, 0, 2, -1, 5, 1, 3, -4] } },
      body_empty: { mesh: { vertices: [] } }
    });
    expect(bounds('body_a' as BodyId)).toEqual({
      min: { x: 0, y: -1, z: -4 },
      max: { x: 2, y: 3, z: 5 }
    });
    expect(bounds('body_a' as BodyId)).toBe(bounds('body_a' as BodyId));
    expect(bounds('body_empty' as BodyId)).toBeNull();
    expect(bounds('body_missing' as BodyId)).toBeNull();
  });
});
