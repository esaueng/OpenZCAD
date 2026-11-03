import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  registerAssemblyCommitHandlers
} from '../../lib/assembly/assemblyRuntime';
import { setAnimatePrefs } from '../../lib/assembly/assemblyUi';
import { commandFactories } from '@openzcad/command-system';
import { AssemblyInspector } from './AssemblyInspector';

afterEach(() => {
  act(() => {
    assemblyRuntime.reset();
    assemblyRuntime.setActive(false);
  });
  registerAssemblyCommitHandlers(null);
  setAnimatePrefs({ mode: 'ping-pong', sweepS: 1.5 });
});

function setup(options: { select: 'joint' | 'component' }) {
  const fixture = scissorsManager({ joint: true });
  const recorder = recordingExecute(fixture.manager);
  // The app's commit handler: a drag's values become one pose command.
  registerAssemblyCommitHandlers({
    commitPose: (values, placements) =>
      recorder.execute(
        commandFactories.setAssemblyPose({
          values,
          ...(placements ? { placements } : {})
        })
      ),
    createJoint: vi.fn()
  });
  act(() => {
    if (options.select === 'joint') assemblyRuntime.selectJoint('joint_pin');
    else assemblyRuntime.selectComponent('comp_b');
  });
  const props = () => ({
    document: fixture.live(),
    execute: recorder.execute,
    onStatus: vi.fn()
  });
  const view = render(<AssemblyInspector {...props()} />);
  return {
    ...fixture,
    ...recorder,
    rerender: () => view.rerender(<AssemblyInspector {...props()} />)
  };
}

describe('AssemblyInspector', () => {
  it('drags a value as a transient override and commits it on release', () => {
    const { commands, manager } = setup({ select: 'joint' });
    expect(
      screen.getByRole('complementary', { name: 'Joint Pivot' })
    ).toBeInTheDocument();
    expect(screen.getByText('Revolute')).toBeInTheDocument();
    expect(screen.getByText('1 DOF')).toBeInTheDocument();
    const slider = screen.getByRole('slider', { name: 'Angle slider' });
    fireEvent.change(slider, { target: { value: '30' } });
    expect(getAssemblyRuntime().overrides.get('joint_pin')).toEqual([30]);
    expect(commands).toEqual([]);
    fireEvent.pointerUp(slider);
    expect(commands).toEqual([
      { kind: 'assembly.pose.set', payload: { values: { joint_pin: [30] } } }
    ]);
    expect(getAssemblyRuntime().overrides.size).toBe(0);
    expect(manager.document.assembly?.joints[0]?.values).toEqual([30]);
    expect(
      screen.getByText('Dragging and playback never add history steps.')
    ).toBeInTheDocument();
  });

  it('sets a limit with units and plays the joint with the chosen animate mode', () => {
    const { commands, manager, rerender } = setup({ select: 'joint' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Limit angle' }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.joint.update',
      payload: { jointId: 'joint_pin', limits: [{ min: -90, max: 90 }] }
    });
    rerender();
    const max = screen.getByRole('textbox', { name: 'Angle maximum' });
    fireEvent.change(max, { target: { value: '45' } });
    fireEvent.keyDown(max, { key: 'Enter' });
    expect(manager.document.assembly?.joints[0]?.limits).toEqual([
      { min: -90, max: 45 }
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Loop' }));
    fireEvent.click(screen.getByRole('button', { name: '0.4 s' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(getAssemblyRuntime().playback).toMatchObject({
      kind: 'joint',
      jointId: 'joint_pin',
      mode: 'loop',
      sweepS: 0.4
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(getAssemblyRuntime().playback).toBeNull();
  });

  it('saves the current position under a name and applies it later', () => {
    const { commands, manager, rerender } = setup({ select: 'joint' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Save current position…' })
    );
    const field = screen.getByRole('textbox', { name: 'Position name' });
    fireEvent.change(field, { target: { value: 'Open' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(commands.at(-1)).toMatchObject({
      kind: 'assembly.position.save',
      payload: { name: 'Open', values: { joint_pin: [12] } }
    });
    rerender();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.pose.set',
      payload: { values: { joint_pin: [12] } }
    });
    expect(manager.document.assembly?.positions).toHaveLength(1);
  });

  it('shows a component’s role and toggles its grounding', () => {
    const { commands } = setup({ select: 'component' });
    expect(
      screen.getByRole('complementary', { name: 'Component Blade B' })
    ).toBeInTheDocument();
    expect(screen.getByText('Driven by Pivot')).toBeInTheDocument();
    expect(screen.getByText('Blade B', { selector: 'dd' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Grounded' }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.component.update',
      payload: { componentId: 'comp_b', grounded: true }
    });
  });

  it('renders nothing with nothing selected', () => {
    const fixture = scissorsManager({ joint: true });
    const { container } = render(
      <AssemblyInspector
        document={fixture.live()}
        execute={vi.fn()}
        onStatus={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
