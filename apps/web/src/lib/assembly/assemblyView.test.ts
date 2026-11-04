import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  rotateVector,
  solveAssembly,
  toUserId,
  transformPoint,
  type AssemblyFrame,
  type BodyId
} from '@openzcad/shared';
import {
  buildAssemblyView,
  MOTION_SETUP_PREVIEW_JOINT_ID,
  jointFromTool,
  nextJointName
} from './assemblyView';
import { playbackFrame } from './assemblyPlayback';
import type { AssemblyJointToolState } from './assemblyRuntime';
import { defaultMotionSetup, motionSetupJoint } from './motionSetup';

const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function scissors() {
  const manager = new CommandManager(
    createProjectDocument('Scissors', toUserId('user_view'))
  );
  for (const name of ['Blade A', 'Blade B'])
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 2, depth: 100 }
      })
    );
  const [a, b] = manager.document.bodyOrder as [BodyId, BodyId];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: [
        { componentId: 'comp_a', name: 'Blade A', bodyId: a, grounded: true },
        { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false }
      ]
    })
  );
  return { manager, a, b };
}

const runtime = {
  overrides: new Map<string, number[]>(),
  placementOverrides: new Map(),
  selectedJointId: null,
  jointTool: null
};

describe('assembly view model', () => {
  it('previews a floating base exactly like Create, regardless of part order', () => {
    const { manager } = scissors();
    manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_a',
        grounded: false
      })
    );
    const document = manager.document;
    const set = document.assembly!;
    const context = {
      set,
      solution: solveAssembly(set),
      bodyOf: () => null
    };
    const draft = {
      ...defaultMotionSetup(context),
      baseId: 'comp_b',
      movingId: 'comp_a'
    };
    const result = motionSetupJoint(
      context,
      draft,
      MOTION_SETUP_PREVIEW_JOINT_ID
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.groundBase).toBe(true);
    const savedBefore = JSON.stringify(document.assembly);
    const preview = buildAssemblyView(document, {
      ...runtime,
      overrides: new Map([[MOTION_SETUP_PREVIEW_JOINT_ID, [25]]]),
      motionSetup: { draft, preview: result.joint, previewing: true }
    })!;
    // The later-listed base stays still; the earlier-listed part lifts.
    expect(preview.solution.poses.get('comp_b')!.t.z).toBeCloseTo(0, 9);
    expect(preview.solution.poses.get('comp_a')!.t.z).toBeCloseTo(25, 9);
    expect(JSON.stringify(document.assembly)).toBe(savedBefore);
    manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_b',
        grounded: true
      })
    );
    manager.execute(commandFactories.addAssemblyJoint({ joint: result.joint }));
    const committed = buildAssemblyView(manager.document, {
      ...runtime,
      overrides: new Map([[MOTION_SETUP_PREVIEW_JOINT_ID, [25]]])
    })!;
    expect([...preview.solution.poses]).toEqual([...committed.solution.poses]);
    // Cancel drops the preview and restores the saved floating poses.
    const cancelled = buildAssemblyView(document, runtime)!;
    expect(cancelled.solution.poses.get('comp_a')!.t.z).toBeCloseTo(0, 9);
    expect(cancelled.set.components.every((c) => !c.grounded)).toBe(true);
  });

  it('creates an as-built joint from two coincident picks and previews it', () => {
    const { manager, a, b } = scissors();
    const tool: AssemblyJointToolState = {
      step: 'review',
      child: {
        componentId: 'comp_b',
        bodyId: b,
        frame: PIVOT,
        source: { kind: 'circle', label: 'Hole' }
      },
      parent: {
        componentId: 'comp_a',
        bodyId: a,
        frame: PIVOT,
        source: { kind: 'circle', label: 'Hole' }
      },
      kind: 'revolute',
      flip: false,
      quarterTurns: 0,
      preview: true
    };
    const view = buildAssemblyView(manager.document, {
      ...runtime,
      jointTool: tool
    });
    expect(view?.glyphs.map((g) => g.selected)).toEqual([true]);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(
      view?.matrices.get(b)?.map((x) => Math.round(x * 1e9) / 1e9)
    ).toEqual(identity);
    const made = jointFromTool(
      view!.solution,
      tool,
      'joint_1',
      nextJointName(manager.document.assembly, 'revolute')
    );
    expect(made?.asBuilt).toBe(true);
    expect(made?.joint.name).toBe('Revolute 1');
  });

  it('snaps a picked face against the target face, not into it', () => {
    const { manager, a, b } = scissors();
    const lidTop: AssemblyFrame = {
      origin: { x: 0, y: 0, z: 12 },
      zAxis: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 }
    };
    const baseFront: AssemblyFrame = {
      origin: { x: 30, y: -20, z: 2 },
      zAxis: { x: 0, y: -1, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }
    };
    const tool: AssemblyJointToolState = {
      step: 'review',
      child: {
        componentId: 'comp_b',
        bodyId: b,
        frame: lidTop,
        source: { kind: 'plane', label: 'Face' }
      },
      parent: {
        componentId: 'comp_a',
        bodyId: a,
        frame: baseFront,
        source: { kind: 'plane', label: 'Face' }
      },
      kind: 'rigid',
      flip: false,
      quarterTurns: 0,
      preview: false
    };
    const view = buildAssemblyView(manager.document, {
      ...runtime,
      jointTool: tool
    })!;
    const pose = view.solution.poses.get('comp_b')!;
    // The lid's top face normal now points into the base (+y): faces touch,
    // and the lid's body (below its top, −z) sits outside the base (−y side).
    const normal = rotateVector(pose.q, lidTop.zAxis);
    expect(normal.y).toBeCloseTo(1, 12);
    const body = transformPoint(pose, { x: 0, y: 0, z: 0 });
    expect(body.y).toBeCloseTo(-32, 9);
    const flipped = buildAssemblyView(manager.document, {
      ...runtime,
      jointTool: { ...tool, flip: true }
    })!;
    const inside = transformPoint(flipped.solution.poses.get('comp_b')!, {
      x: 0,
      y: 0,
      z: 0
    });
    expect(inside.y).toBeCloseTo(-8, 9);
  });

  it('plays a joint sweep from elapsed time alone', () => {
    const { manager } = scissors();
    manager.execute(
      commandFactories.addAssemblyJoint({
        joint: {
          id: 'joint_pivot',
          name: 'Pivot',
          kind: 'revolute',
          parent: { componentId: 'comp_a', frame: PIVOT },
          child: { componentId: 'comp_b', frame: PIVOT },
          values: [0],
          limits: [{ min: 0, max: 35 }]
        }
      })
    );
    const set = manager.document.assembly!;
    const frame = playbackFrame(
      set,
      {
        kind: 'joint',
        jointId: 'joint_pivot',
        dof: 0,
        mode: 'ping-pong',
        sweepS: 1,
        startedAtMs: 1000
      },
      2000
    );
    expect(frame?.overrides.get('joint_pivot')?.[0]).toBeCloseTo(35, 9);
    const back = playbackFrame(
      set,
      {
        kind: 'joint',
        jointId: 'joint_pivot',
        dof: 0,
        mode: 'ping-pong',
        sweepS: 1,
        startedAtMs: 1000
      },
      3000
    );
    expect(back?.overrides.get('joint_pivot')?.[0]).toBeCloseTo(0, 9);
  });
});
