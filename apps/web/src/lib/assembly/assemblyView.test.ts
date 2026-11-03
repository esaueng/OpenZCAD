import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type AssemblyFrame, type BodyId } from '@openzcad/shared';
import {
  buildAssemblyView,
  jointFromTool,
  nextJointName
} from './assemblyView';
import { playbackFrame } from './assemblyPlayback';
import type { AssemblyJointToolState } from './assemblyRuntime';

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
