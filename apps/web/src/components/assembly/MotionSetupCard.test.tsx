import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BodyId } from '@openzcad/shared';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import {
  getAnimatePrefs,
  setAnimatePrefs
} from '../../lib/assembly/assemblyUi';
import type { MotionSetupBox } from '../../lib/assembly/motionSetup';
import { AssemblyPanel } from './AssemblyPanel';

afterEach(() => {
  act(() => {
    assemblyRuntime.reset();
    assemblyRuntime.setActive(false);
  });
  setAnimatePrefs({ mode: 'ping-pong', sweepS: 1.5 });
});

/** Two parts, the first fixed, no joints: where Set up motion starts. */
function renderSetup(options: { reducedMotion?: boolean } = {}) {
  const fixture = scissorsManager({ components: true });
  const recorder = recordingExecute(fixture.manager);
  // Blade A (the base) reaches 40 mm along Z.
  const boxes: Record<string, MotionSetupBox> = {
    [fixture.a]: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 100, z: 40 } },
    [fixture.b]: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 100, z: 2 } }
  };
  const status: string[] = [];
  const element = () => (
    <AssemblyPanel
      document={fixture.live()}
      execute={recorder.execute}
      onStatus={(message) => status.push(message)}
      bodyBounds={(bodyId: BodyId) => boxes[bodyId] ?? null}
      reducedMotion={options.reducedMotion ?? false}
    />
  );
  const view = render(element());
  return {
    ...recorder,
    fixture,
    status,
    rerender: () => view.rerender(element())
  };
}

const card = () => screen.getByRole('region', { name: 'Set up motion' });

describe('Set up motion card', () => {
  it('offers Set up motion while no part moves yet', () => {
    renderSetup();
    const joints = screen.getByRole('region', { name: 'Joints' });
    expect(
      within(joints).getByRole('button', { name: 'Set up motion' })
    ).toBeInTheDocument();
    // The header's Motion button joins once a part moves.
    expect(screen.queryByRole('button', { name: 'Motion' })).toBeNull();
  });

  it('defaults to lifting the free part clear of the fixed one, then creates and plays it', () => {
    const { commands, rerender, status } = renderSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Set up motion' }));
    const form = card();
    expect(
      within(form).getByRole('combobox', { name: 'Part that stays put' })
    ).toHaveValue('comp_a');
    expect(
      within(form).getByRole('combobox', { name: 'Part that moves' })
    ).toHaveValue('comp_b');
    expect(within(form).getByRole('button', { name: /Slide/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(
      within(form).getByRole('button', { name: 'Z axis' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(form).getByRole('textbox', { name: 'Slide from' })
    ).toHaveValue('0');
    expect(within(form).getByRole('textbox', { name: 'Slide to' })).toHaveValue(
      '40'
    );
    expect(within(form).getByRole('combobox', { name: 'Cycle' })).toHaveValue(
      'ping-pong'
    );
    // The viewport previews the joint Create makes, sweeping.
    expect(getAssemblyRuntime().motionSetup).toMatchObject({
      previewing: true,
      preview: { kind: 'slider', limits: [{ min: 0, max: 40 }] }
    });

    fireEvent.click(
      within(form).getByRole('button', { name: 'Create and play' })
    );
    rerender();
    expect(commands.map((c) => c.kind)).toEqual(['assembly.joint.add']);
    expect(commands[0]?.payload).toMatchObject({
      joint: {
        kind: 'slider',
        name: 'Blade B slide',
        parent: { componentId: 'comp_a' },
        child: { componentId: 'comp_b' },
        values: [0],
        limits: [{ min: 0, max: 40 }]
      }
    });
    const runtime = getAssemblyRuntime();
    expect(runtime.motionSetup).toBeNull();
    expect(runtime.playback).toMatchObject({
      kind: 'joint',
      dof: 0,
      mode: 'ping-pong',
      sweepS: 1.5
    });
    expect(runtime.selectedJointId).toBe(
      (commands[0]?.payload as { joint: { id: string } }).joint.id
    );
    expect(screen.queryByRole('region', { name: 'Set up motion' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Motion' })).toBeEnabled();
    expect(status.at(-1)).toBe(
      'Blade B slide is ready. Space plays it; Esc stops.'
    );
  });

  it('turns about a chosen axis with its own range, cycle and speed', () => {
    const { commands } = renderSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Set up motion' }));
    const form = card();
    fireEvent.click(within(form).getByRole('button', { name: /Turn/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'X axis' }));
    expect(within(form).getByText('°')).toBeInTheDocument();
    expect(within(form).getByRole('textbox', { name: 'Turn to' })).toHaveValue(
      '90'
    );
    const to = within(form).getByRole('textbox', { name: 'Turn to' });
    fireEvent.change(to, { target: { value: '45' } });
    fireEvent.blur(to);
    fireEvent.change(within(form).getByRole('combobox', { name: 'Cycle' }), {
      target: { value: 'loop' }
    });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Speed' }), {
      target: { value: '3' }
    });
    fireEvent.click(
      within(form).getByRole('button', { name: 'Create and play' })
    );
    expect(commands.at(-1)?.payload).toMatchObject({
      joint: {
        kind: 'revolute',
        limits: [{ min: 0, max: 45 }],
        parent: { frame: { zAxis: { x: 1, y: 0, z: 0 } } }
      }
    });
    expect(getAssemblyRuntime().playback).toMatchObject({
      mode: 'loop',
      sweepS: 3
    });
    expect(getAnimatePrefs()).toEqual({ mode: 'loop', sweepS: 3 });
  });

  it('refuses to move a fixed part, with the reason', () => {
    renderSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Set up motion' }));
    const form = card();
    fireEvent.change(
      within(form).getByRole('combobox', { name: 'Part that stays put' }),
      { target: { value: 'comp_b' } }
    );
    expect(
      within(form).getByRole('combobox', { name: 'Part that moves' })
    ).toHaveValue('comp_a');
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Blade A is fixed in place.'
    );
    expect(
      within(form).getByRole('button', { name: 'Create and play' })
    ).toBeDisabled();
    expect(getAssemblyRuntime().motionSetup?.preview).toBeNull();
  });

  it('keeps the preview paused under Reduce motion, and Cancel saves nothing', () => {
    const { commands } = renderSetup({ reducedMotion: true });
    fireEvent.click(screen.getByRole('button', { name: 'Set up motion' }));
    const form = card();
    expect(
      within(form).getByRole('checkbox', { name: 'Preview motion' })
    ).not.toBeChecked();
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(getAssemblyRuntime().motionSetup).toBeNull();
    expect(commands).toEqual([]);
    expect(screen.getByRole('region', { name: 'Joints' })).toBeInTheDocument();
  });

  it('hands over to the Joint tool for picked geometry', () => {
    renderSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Set up motion' }));
    fireEvent.click(
      within(card()).getByRole('button', { name: 'Pick on the model' })
    );
    const runtime = getAssemblyRuntime();
    expect(runtime.motionSetup).toBeNull();
    expect(runtime.jointTool).not.toBeNull();
    expect(
      screen.getByRole('region', { name: 'Add joint' })
    ).toBeInTheDocument();
  });
});
