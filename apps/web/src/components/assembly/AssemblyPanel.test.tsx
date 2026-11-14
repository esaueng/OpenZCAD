import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import { recordingExecute, scissorsManager } from '../../test/assemblyFixture';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  registerAssemblyCommitHandlers
} from '../../lib/assembly/assemblyRuntime';
import { setAnimatePrefs } from '../../lib/assembly/assemblyUi';
import { createDefaultStudy } from '../../lib/assembly/motionStudy';
import { AssemblyPanel } from './AssemblyPanel';

afterEach(() => {
  act(() => {
    assemblyRuntime.reset();
    assemblyRuntime.setActive(false);
  });
  registerAssemblyCommitHandlers(null);
  setAnimatePrefs({ mode: 'ping-pong', sweepS: 1.5 });
});

function renderPanel(
  manager: ReturnType<typeof scissorsManager>,
  extra: {
    saveBomCsv?: (fileName: string, csv: string) => void;
    onAnnounce?: (message: string, options?: { undo?: boolean }) => void;
  } = {}
) {
  const recorder = recordingExecute(manager.manager);
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
  const onStatus = vi.fn();
  const element = () => (
    <AssemblyPanel
      document={manager.live()}
      execute={recorder.execute}
      onStatus={onStatus}
      {...extra}
    />
  );
  const view = render(element());
  const rerender = () => view.rerender(element());
  return { ...recorder, rerender, onStatus };
}

const select = (fn: () => void) => act(fn);

describe('AssemblyPanel (one left sidebar)', () => {
  it('lists parts, joints and motion in plain words', () => {
    const fixture = scissorsManager({ joint: true });
    renderPanel(fixture);
    expect(screen.getByRole('status')).toHaveTextContent('Ready');
    const parts = screen.getByRole('region', { name: 'Parts' });
    expect(
      within(parts).getByRole('button', { name: 'Blade A is fixed' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(within(parts).getByText('Pivot')).toBeInTheDocument();
    const joints = screen.getByRole('region', { name: 'Joints' });
    expect(within(joints).getByText('Pivot')).toBeInTheDocument();
    expect(within(joints).getByText('12.0°')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Motion' })).toBeInTheDocument();
  });

  it('lists the bill of materials and downloads it as CSV (AS03)', () => {
    const fixture = scissorsManager({ joint: true, screw: true });
    const saveBomCsv = vi.fn();
    const { onStatus } = renderPanel(fixture, { saveBomCsv });
    const section = screen.getByRole('region', { name: 'Bill of materials' });
    expect(within(section).getByText('2')).toHaveClass('assembly-count');
    const rows = within(
      within(section).getByRole('list', { name: 'Bill of materials' })
    ).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Blade A Body×1',
      'Blade B Body×1'
    ]);
    // A body outside the assembly is not a part of it.
    expect(within(section).queryByText(/Pivot screw/)).toBeNull();
    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Download bill of materials as CSV'
      })
    );
    expect(saveBomCsv).toHaveBeenCalledWith(
      'Scissors.bom.csv',
      [
        'item,quantity,part,instances,source_body,status',
        `1,1,Blade A Body,Blade A,${fixture.a},ready`,
        `2,1,Blade B Body,Blade B,${fixture.b},ready`,
        ''
      ].join('\n')
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Exported the bill of materials (2 parts) to Scissors.bom.csv.'
    );
  });

  it('keeps a missing part in the BOM and warns that the exported CSV includes it', () => {
    const fixture = scissorsManager({ components: true });
    const document = fixture.live();
    document.bodyOrder = document.bodyOrder.filter((id) => id !== fixture.b);
    delete document.derived.bodyRepresentations[fixture.b];
    const saveBomCsv = vi.fn();
    const onStatus = vi.fn();
    render(
      <AssemblyPanel
        document={document}
        execute={vi.fn()}
        onStatus={onStatus}
        saveBomCsv={saveBomCsv}
      />
    );
    const section = screen.getByRole('region', { name: 'Bill of materials' });
    expect(within(section).getByText('Missing')).toBeInTheDocument();
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('Blade B BodyMissing×1');
    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Download bill of materials as CSV'
      })
    );
    expect(saveBomCsv).toHaveBeenCalledWith(
      'Scissors.bom.csv',
      expect.stringContaining(`2,1,Blade B Body,Blade B,${fixture.b},missing`)
    );
    expect(onStatus).toHaveBeenCalledWith(
      'Exported the bill of materials (2 parts) to Scissors.bom.csv. Includes 1 missing part.'
    );
  });

  it('adds a body that is not in the assembly yet (regression: no way to add one)', () => {
    const fixture = scissorsManager({ joint: true, screw: true });
    const { commands, rerender, onStatus } = renderPanel(fixture);
    const addable = screen.getByRole('group', { name: 'Not in the assembly' });
    expect(within(addable).getByText('Pivot screw')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Pivot screw' }));
    expect(commands.at(-1)).toMatchObject({
      kind: 'assembly.components.add',
      payload: {
        components: [
          { name: 'Pivot screw', bodyId: fixture.screw, grounded: false }
        ]
      }
    });
    expect(fixture.manager.document.assembly?.components).toHaveLength(3);
    expect(onStatus).toHaveBeenCalledWith(
      'Added Pivot screw. Press J to join it.'
    );
    rerender();
    expect(
      screen.queryByRole('group', { name: 'Not in the assembly' })
    ).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Parts' })).getByText(
        'Not joined'
      )
    ).toBeInTheDocument();
  });

  it('opens a selected joint’s controls under its row and commits a drag once', () => {
    const fixture = scissorsManager({ joint: true });
    const { commands, rerender } = renderPanel(fixture);
    fireEvent.click(screen.getByRole('button', { name: /^Pivot/ }));
    expect(getAssemblyRuntime().selectedJointId).toBe('joint_pin');
    rerender();
    const details = screen.getByLabelText('Pivot details');
    expect(details).toHaveTextContent('Revolute · turns about an axis');
    const slider = within(details).getByRole('slider', {
      name: 'Angle slider'
    });
    fireEvent.change(slider, { target: { value: '30' } });
    expect(getAssemblyRuntime().overrides.get('joint_pin')).toEqual([30]);
    expect(commands).toEqual([]);
    fireEvent.pointerUp(slider);
    expect(commands).toEqual([
      { kind: 'assembly.pose.set', payload: { values: { joint_pin: [30] } } }
    ]);
    expect(fixture.manager.document.assembly?.joints[0]?.values).toEqual([30]);
  });

  it('limits a joint and plays it with the chosen mode and sweep', () => {
    const fixture = scissorsManager({ joint: true });
    select(() => assemblyRuntime.selectJoint('joint_pin'));
    const { commands, rerender } = renderPanel(fixture);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Limit' }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.joint.update',
      payload: { jointId: 'joint_pin', limits: [{ min: -90, max: 90 }] }
    });
    rerender();
    const max = screen.getByRole('textbox', { name: 'Angle maximum' });
    fireEvent.change(max, { target: { value: '45' } });
    fireEvent.keyDown(max, { key: 'Enter' });
    expect(fixture.manager.document.assembly?.joints[0]?.limits).toEqual([
      { min: -90, max: 45 }
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Playback' }), {
      target: { value: 'loop' }
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Speed' }), {
      target: { value: '0.4' }
    });
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

  it('saves a position from its own section, applies, renames and deletes it (I58)', () => {
    const fixture = scissorsManager({ joint: true });
    const { commands, rerender } = renderPanel(fixture);
    // Positions save every joint, so they live beside the joints, not
    // inside one joint's details: no joint needs to be open.
    expect(screen.queryByLabelText('Pivot details')).toBeNull();
    const positions = () => screen.getByRole('region', { name: 'Positions' });
    fireEvent.click(
      within(positions()).getByRole('button', { name: 'Save position' })
    );
    const field = screen.getByRole('textbox', { name: 'Position name' });
    fireEvent.change(field, { target: { value: 'Open' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(commands.at(-1)).toMatchObject({
      kind: 'assembly.position.save',
      payload: { name: 'Open', values: { joint_pin: [12] } }
    });
    rerender();
    fireEvent.click(within(positions()).getByRole('button', { name: 'Open' }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.pose.set',
      payload: { values: { joint_pin: [12] } }
    });

    fireEvent.doubleClick(
      within(positions()).getByRole('button', { name: 'Open' })
    );
    const rename = screen.getByRole('textbox', { name: 'Rename Open' });
    fireEvent.change(rename, { target: { value: 'Wide open' } });
    fireEvent.keyDown(rename, { key: 'Enter' });
    const saved = fixture.manager.document.assembly?.positions ?? [];
    expect(saved.map((p) => [p.name, p.values])).toEqual([
      ['Wide open', { joint_pin: [12] }]
    ]);
    rerender();
    fireEvent.click(
      within(positions()).getByRole('button', { name: 'Delete Wide open' })
    );
    expect(commands.at(-1)?.kind).toBe('assembly.position.delete');
  });

  it('says a joint value is keyed into the open study, not saved as the rest pose (I59)', () => {
    const fixture = scissorsManager({ joint: true });
    fixture.manager.execute(
      commandFactories.setAssemblyStudy({
        study: createDefaultStudy(fixture.manager.document.assembly, 'study_1')
      })
    );
    const { rerender } = renderPanel(fixture);
    fireEvent.click(screen.getByRole('button', { name: /^Pivot/ }));
    rerender();
    expect(screen.getByLabelText('Pivot details')).not.toHaveTextContent(
      'Recording into'
    );
    select(() => {
      assemblyRuntime.selectStudy('study_1');
      assemblyRuntime.setStudyTime(2);
    });
    rerender();
    expect(screen.getByRole('note')).toHaveTextContent(
      'Recording into Motion 1: a value set here is keyed at 2.00 s.'
    );
  });

  it('opens a part under its row: how it moves, fix in place, remove', () => {
    const fixture = scissorsManager({ joint: true });
    select(() => assemblyRuntime.selectComponent('comp_b'));
    const { commands } = renderPanel(fixture);
    const details = screen.getByLabelText('Blade B details');
    expect(details).toHaveTextContent('Moves with Pivot');
    fireEvent.click(
      within(details).getByRole('button', { name: 'Fix in place' })
    );
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.component.update',
      payload: { componentId: 'comp_b', grounded: true }
    });
    fireEvent.click(
      within(details).getByRole('button', { name: 'Remove from assembly' })
    );
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.component.delete',
      payload: { componentId: 'comp_b' }
    });
  });

  it('warns when nothing is fixed and fixes the first part', () => {
    const fixture = scissorsManager({ components: true });
    fixture.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_a',
        grounded: false
      })
    );
    const { commands } = renderPanel(fixture);
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing is fixed');
    expect(screen.getByRole('status')).toHaveTextContent('Nothing fixed');
    fireEvent.click(screen.getByRole('button', { name: 'Fix Blade A' }));
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.component.update',
      payload: { componentId: 'comp_a', grounded: true }
    });
  });

  it('flags a joint between two fixed parts as unable to move', () => {
    const fixture = scissorsManager({ joint: true });
    fixture.manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_b',
        grounded: true
      })
    );
    renderPanel(fixture);
    const joints = screen.getByRole('region', { name: 'Joints' });
    expect(within(joints).getByText('Can’t move')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play Pivot' })).toBeDisabled();
  });

  it('renames on double-click without closing the row the first click opened', () => {
    const fixture = scissorsManager({ joint: true });
    const { rerender } = renderPanel(fixture);
    const row = screen.getByRole('button', { name: /^Blade B/ });
    fireEvent.click(row, { detail: 1 });
    expect(getAssemblyRuntime().selectedComponentId).toBe('comp_b');
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row);
    expect(getAssemblyRuntime().selectedComponentId).toBe('comp_b');
    rerender();
    expect(
      screen.getByRole('textbox', { name: 'Rename Blade B' })
    ).toBeInTheDocument();
  });

  it('renames and removes from the row menu', () => {
    const fixture = scissorsManager({ components: true });
    const { commands, rerender } = renderPanel(fixture);
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Blade B/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByRole('textbox', { name: 'Rename Blade B' });
    fireEvent.change(field, { target: { value: 'Lower blade' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(fixture.manager.document.assembly?.components[1]?.name).toBe(
      'Lower blade'
    );
    rerender();
    fireEvent.contextMenu(screen.getByRole('button', { name: /^Lower blade/ }));
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Remove from assembly' })
    );
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.component.delete',
      payload: { componentId: 'comp_b' }
    });
  });

  it('says why Motion has nothing to set up when every part is fixed or joined (I55)', () => {
    const fixture = scissorsManager({ joint: true });
    const { onStatus } = renderPanel(fixture);
    const reason =
      'Every part is fixed or already moves on a joint. Open a joint to change its motion.';
    const motion = screen.getByRole('button', { name: 'Motion' });
    expect(motion).toHaveAttribute('aria-disabled', 'true');
    expect(motion).toHaveAttribute('title', reason);
    fireEvent.click(motion);
    expect(onStatus).toHaveBeenCalledWith(reason);
    // It never opens a card that starts in an error.
    expect(getAssemblyRuntime().motionSetup).toBeNull();
  });

  it('deletes a joint from its details or the Delete key, with Undo (I2)', () => {
    const fixture = scissorsManager({ joint: true });
    const onAnnounce = vi.fn();
    const { commands, rerender } = renderPanel(fixture, { onAnnounce });
    fireEvent.click(screen.getByRole('button', { name: /^Pivot/ }));
    rerender();
    const details = screen.getByLabelText('Pivot details');
    fireEvent.click(
      within(details).getByRole('button', { name: 'Delete joint' })
    );
    expect(commands.at(-1)).toEqual({
      kind: 'assembly.joint.delete',
      payload: { jointId: 'joint_pin' }
    });
    expect(getAssemblyRuntime().selectedJointId).toBeNull();
    expect(onAnnounce).toHaveBeenCalledWith('Deleted Pivot.', { undo: true });

    fixture.manager.undo();
    rerender();
    fireEvent.keyDown(screen.getByRole('button', { name: /^Pivot/ }), {
      key: 'Delete'
    });
    expect(fixture.manager.document.assembly?.joints).toEqual([]);
    expect(onAnnounce).toHaveBeenCalledTimes(2);
  });

  it('opens the joint tool in the sidebar, and starts empty assemblies from the first run', () => {
    const fixture = scissorsManager({ components: true });
    const { rerender } = renderPanel(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Joint' }));
    expect(getAssemblyRuntime().jointTool?.step).toBe('child');
    rerender();
    expect(
      screen.getByRole('region', { name: 'Add joint' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Parts' })).toBeNull();

    const empty = scissorsManager();
    act(() => assemblyRuntime.closeJointTool());
    render(
      <AssemblyPanel
        document={empty.live()}
        execute={vi.fn()}
        onStatus={vi.fn()}
      />
    );
    expect(
      screen.getByRole('heading', { name: 'Start an assembly' })
    ).toBeInTheDocument();
  });
});
