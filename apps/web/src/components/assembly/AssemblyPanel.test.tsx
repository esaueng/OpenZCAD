import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { AssemblyPanel } from './AssemblyPanel';

afterEach(() => {
  act(() => {
    assemblyRuntime.reset();
    assemblyRuntime.setActive(false);
  });
});

function renderPanel(manager: ReturnType<typeof scissorsManager>) {
  const recorder = recordingExecute(manager.manager);
  const view = render(
    <AssemblyPanel
      document={manager.live()}
      execute={recorder.execute}
      onStatus={vi.fn()}
    />
  );
  const rerender = () =>
    view.rerender(
      <AssemblyPanel
        document={manager.live()}
        execute={recorder.execute}
        onStatus={vi.fn()}
      />
    );
  return { ...recorder, rerender };
}

describe('AssemblyPanel', () => {
  it('shows the DOF chip, components, joints and their current values', () => {
    const fixture = scissorsManager({ joint: true });
    renderPanel(fixture);
    expect(screen.getByRole('status')).toHaveTextContent('1 DOF · solved');
    const components = screen.getByRole('region', { name: 'Components' });
    expect(within(components).getByLabelText('Grounded')).toBeInTheDocument();
    const joints = screen.getByRole('region', { name: 'Joints' });
    expect(within(joints).getByText('Pivot')).toBeInTheDocument();
    expect(within(joints).getByText('12.0°')).toBeInTheDocument();
  });

  it('selects rows into the runtime and plays a joint from its row', () => {
    const fixture = scissorsManager({ joint: true });
    renderPanel(fixture);
    fireEvent.click(screen.getByRole('button', { name: /Blade B/ }));
    expect(getAssemblyRuntime().selectedComponentId).toBe('comp_b');
    fireEvent.click(screen.getByRole('button', { name: /^Pivot/ }));
    expect(getAssemblyRuntime().selectedJointId).toBe('joint_pin');
    expect(getAssemblyRuntime().selectedComponentId).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play Pivot' }));
    expect(getAssemblyRuntime().playback).toMatchObject({
      kind: 'joint',
      jointId: 'joint_pin'
    });
    expect(screen.getByRole('button', { name: 'Pause Pivot' })).toBeEnabled();
  });

  it('warns when nothing is grounded and grounds the first component', () => {
    const fixture = scissorsManager({ components: true });
    fixture.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_a',
        grounded: false
      })
    );
    const { commands } = renderPanel(fixture);
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing is grounded');
    fireEvent.click(screen.getByRole('button', { name: 'Ground Blade A' }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.component.update',
      payload: { componentId: 'comp_a', grounded: true }
    });
  });

  it('flags a joint between two grounded components as not solved', () => {
    const fixture = scissorsManager({ joint: true });
    fixture.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_b',
        grounded: true
      })
    );
    renderPanel(fixture);
    const joints = screen.getByRole('region', { name: 'Joints' });
    expect(
      within(joints).getByText('Not solved · both grounded')
    ).toHaveAttribute('title', 'Both ends are grounded, so it cannot move');
    expect(screen.getByRole('button', { name: 'Play Pivot' })).toBeDisabled();
  });

  it('grounds, renames and removes from the row menu', () => {
    const fixture = scissorsManager({ components: true });
    const { commands, rerender } = renderPanel(fixture);
    const row = screen.getByRole('button', { name: /Blade B/ });
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: /Ground/ }));
    expect(commands.at(-1)?.kind).toBe('assembly.component.update');
    rerender();

    fireEvent.contextMenu(screen.getByRole('button', { name: /Blade B/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByRole('textbox', { name: 'Rename Blade B' });
    fireEvent.change(field, { target: { value: 'Lower blade' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(fixture.manager.document.assembly?.components[1]?.name).toBe(
      'Lower blade'
    );
    rerender();

    fireEvent.contextMenu(screen.getByRole('button', { name: /Lower blade/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.component.delete',
      payload: { componentId: 'comp_b' }
    });
  });

  it('opens the joint tool from the header', () => {
    const fixture = scissorsManager({ components: true });
    renderPanel(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Joint' }));
    expect(getAssemblyRuntime().jointTool?.step).toBe('child');
  });

  it('applies and deletes a named position', () => {
    const fixture = scissorsManager({ joint: true });
    fixture.manager.execute(
      commandFactories.saveAssemblyPosition({
        positionId: 'pos_open',
        name: 'Open',
        values: { joint_pin: [45] }
      })
    );
    const { commands } = renderPanel(fixture);
    fireEvent.click(screen.getByRole('button', { name: /^Open$/ }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.pose.set',
      payload: { values: { joint_pin: [45] } }
    });
    expect(fixture.manager.document.assembly?.joints[0]?.values).toEqual([45]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Open' }));
    expect(commands.at(-1)?.kind).toBe('assembly.position.delete');
  });
});
