import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { commandFactories } from '@openzcad/command-system';
import type { BodyId } from '@openzcad/shared';
import {
  PIVOT,
  recordingExecute,
  scissorsManager
} from '../../test/assemblyFixture';
import {
  assembleKeyFor,
  createJointFromTool,
  jointFromToolState,
  runAssembleKey,
  useAssembleWorkspace,
  type AssembleWorkspaceApp
} from './assembleWorkspace';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  type AssemblyJointToolState
} from './assemblyRuntime';

function tool(a: BodyId, b: BodyId): AssemblyJointToolState {
  return {
    step: 'review',
    child: {
      componentId: 'comp_b',
      bodyId: b,
      frame: PIVOT,
      source: { kind: 'circle', label: 'Pivot hole' }
    },
    parent: {
      componentId: 'comp_a',
      bodyId: a,
      frame: PIVOT,
      source: { kind: 'circle', label: 'Pivot hole' }
    },
    kind: 'revolute',
    flip: false,
    quarterTurns: 0,
    preview: false,
    limits: [{ min: -10, max: 80 }]
  };
}

afterEach(() => {
  assemblyRuntime.reset();
  assemblyRuntime.setActive(false);
});

describe('Assemble workspace launch selection', () => {
  it('selects the requested joint on open without changing the saved document', () => {
    const { manager } = scissorsManager({ joint: true });
    const { commands, execute } = recordingExecute(manager);
    const document = manager.document;
    renderHook(() =>
      useAssembleWorkspace(true, {
        document,
        initialJointId: 'joint_pin',
        execute,
        onStatus: vi.fn()
      })
    );
    expect(getAssemblyRuntime().selectedJointId).toBe('joint_pin');
    expect(commands).toEqual([]);
    expect(manager.document).toBe(document);
  });

  it('keeps a later user selection through edits and workspace switches', () => {
    const { manager } = scissorsManager({ joint: true });
    const { execute } = recordingExecute(manager);
    const app = (): AssembleWorkspaceApp => ({
      document: manager.document,
      initialJointId: 'joint_pin',
      execute,
      onStatus: vi.fn()
    });
    const { rerender } = renderHook(
      ({ active, app }) => useAssembleWorkspace(active, app),
      { initialProps: { active: true, app: app() } }
    );
    act(() => {
      assemblyRuntime.selectComponent('comp_b');
      execute(
        commandFactories.setAssemblyPose({ values: { joint_pin: [30] } })
      );
    });
    rerender({ active: false, app: app() });
    rerender({ active: true, app: app() });
    expect(getAssemblyRuntime().selectedJointId).toBeNull();
    expect(getAssemblyRuntime().selectedComponentId).toBe('comp_b');
  });

  it('clears the sample selection when another project opens', () => {
    const first = scissorsManager({ joint: true });
    const second = scissorsManager({ joint: true });
    const app = (
      document: AssembleWorkspaceApp['document'],
      initialJointId?: string
    ) => ({
      document,
      initialJointId,
      execute: vi.fn(() => true),
      onStatus: vi.fn()
    });
    const { rerender } = renderHook(
      (app: AssembleWorkspaceApp) => useAssembleWorkspace(true, app),
      { initialProps: app(first.manager.document, 'joint_pin') }
    );
    expect(getAssemblyRuntime().selectedJointId).toBe('joint_pin');
    rerender(app(second.manager.document));
    expect(getAssemblyRuntime().selectedJointId).toBeNull();
  });

  it('leaves an ordinary project or a missing initial joint unselected', () => {
    const { manager } = scissorsManager({ joint: true });
    renderHook(() =>
      useAssembleWorkspace(true, {
        document: manager.document,
        initialJointId: 'joint_deleted',
        execute: vi.fn(() => true),
        onStatus: vi.fn()
      })
    );
    expect(getAssemblyRuntime().selectedJointId).toBeNull();
  });
});

describe('Assemble workspace actions', () => {
  it('creates the tool joint with its limits and selects it', () => {
    const { manager, a, b } = scissorsManager({ components: true });
    const { commands, execute } = recordingExecute(manager);
    const app = { document: manager.document, execute, onStatus: vi.fn() };
    expect(createJointFromTool(app, tool(a, b))).toBe(true);
    expect(commands.map((c) => c.kind)).toEqual(['assembly.joint.add']);
    const joint = manager.document.assembly?.joints[0];
    expect(joint?.name).toBe('Revolute 1');
    expect(joint?.limits).toEqual([{ min: -10, max: 80 }]);
    expect(getAssemblyRuntime().selectedJointId).toBe(joint?.id);
  });

  it('refuses a pair that is already joined, naming the joint', () => {
    const { manager, a, b } = scissorsManager({ joint: true });
    expect(
      jointFromToolState(manager.document.assembly, tool(a, b), 'j')
    ).toEqual({ error: 'These components are already joined by Pivot.' });
  });

  it('maps keys and runs them: J opens the tool, G grounds, Esc steps back', () => {
    const { manager } = scissorsManager({ joint: true });
    const { commands, execute } = recordingExecute(manager);
    const onStatus = vi.fn();
    const app = () => ({ document: manager.document, execute, onStatus });
    expect(assembleKeyFor('assembly-joint', 'j')).toBe('joint-tool');
    expect(assembleKeyFor(undefined, 'Escape')).toBe('escape');
    expect(assembleKeyFor('view-fit', 'f')).toBeNull();

    expect(runAssembleKey(app(), 'joint-tool')).toBe(true);
    expect(getAssemblyRuntime().jointTool?.step).toBe('child');
    expect(runAssembleKey(app(), 'escape')).toBe(true);
    expect(getAssemblyRuntime().jointTool).toBeNull();

    // G with nothing selected explains itself rather than toggling the grid.
    expect(runAssembleKey(app(), 'ground')).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith(
      'Select a component to ground it.'
    );
    assemblyRuntime.selectComponent('comp_b');
    expect(runAssembleKey(app(), 'ground')).toBe(true);
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.component.update',
      payload: { componentId: 'comp_b', grounded: true }
    });

    // Space plays the selected joint and pauses it again.
    expect(runAssembleKey(app(), 'play')).toBe(false);
    assemblyRuntime.selectJoint('joint_pin');
    expect(runAssembleKey(app(), 'play')).toBe(true);
    expect(getAssemblyRuntime().playback).toMatchObject({
      kind: 'joint',
      jointId: 'joint_pin',
      mode: 'ping-pong'
    });
    expect(runAssembleKey(app(), 'escape')).toBe(true);
    expect(getAssemblyRuntime().playback).toBeNull();
  });
});
