import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commandFactories,
  type AnyCommand,
  type CommandManager
} from '@openzcad/command-system';
import type { AssemblyStudySetInput } from '@openzcad/document-core';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  registerAssemblyCommitHandlers
} from '../../lib/assembly/assemblyRuntime';
import { MotionStudyTimeline } from './MotionStudyTimeline';
import { coupledPairProject, pivotProject } from './motionTestFixture';

function lane(element: HTMLElement, width = 200) {
  element.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: width,
    bottom: 36,
    width,
    height: 36,
    x: 0,
    y: 0,
    toJSON: () => ({})
  });
  return element;
}

function mount(manager: CommandManager = pivotProject()) {
  const executed: AnyCommand[] = [];
  const onClose = vi.fn();
  const view = render(
    <MotionStudyTimeline
      assembly={manager.document.assembly}
      execute={(command) => {
        executed.push(command);
        manager.execute(command);
        rerender();
        return true;
      }}
      onClose={onClose}
    />
  );
  function rerender() {
    view.rerender(
      <MotionStudyTimeline
        assembly={manager.document.assembly}
        execute={(command) => {
          executed.push(command);
          manager.execute(command);
          rerender();
          return true;
        }}
        onClose={onClose}
      />
    );
  }
  return { ...view, manager, executed, onClose };
}

function lastStudy(executed: AnyCommand[]) {
  const command = executed.at(-1);
  expect(command?.kind).toBe('assembly.study.set');
  return (command?.payload as AssemblyStudySetInput).study;
}

beforeEach(() => {
  assemblyRuntime.stop();
  assemblyRuntime.reset();
  assemblyRuntime.setActive(true);
  assemblyRuntime.selectStudy('study_1');
});

afterEach(() => {
  vi.restoreAllMocks();
  assemblyRuntime.setActive(false);
  assemblyRuntime.reset();
});

describe('MotionStudyTimeline', () => {
  it('shows the selected study with its transport, ruler and tracks', () => {
    mount();
    const timeline = screen.getByRole('region', {
      name: 'Motion study Motion 1'
    });
    expect(timeline).toBeTruthy();
    expect(screen.getByLabelText('Playhead').textContent).toBe('0.00');
    expect(
      screen.getByLabelText<HTMLInputElement>('Duration in seconds').value
    ).toBe('2');
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Playback' })
        .value
    ).toBe('loop');
    expect(screen.getByRole('group', { name: 'Track Pivot' })).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: /^Key at [0-9]/ })
    ).toHaveLength(2);
    // No placeholder controls for features that do not exist yet.
    expect(screen.queryByRole('button', { name: 'Export video' })).toBeNull();
    // Paused, the parts show the study at the playhead.
    expect(getAssemblyRuntime().overrides.get('j_pivot')).toEqual([0]);
  });

  it('scrubs: a press on a row moves the playhead and the parts', () => {
    mount();
    const row = lane(screen.getByTestId('motion-lane-0'));
    fireEvent.pointerDown(row, { clientX: 100, pointerId: 1, button: 0 });
    expect(getAssemblyRuntime().studyTimeS).toBe(1);
    expect(getAssemblyRuntime().overrides.get('j_pivot')).toEqual([45]);
    fireEvent.pointerMove(row, { clientX: 150, pointerId: 1 });
    expect(getAssemblyRuntime().studyTimeS).toBe(1.5);
    fireEvent.pointerUp(row, { pointerId: 1 });
    fireEvent.pointerMove(row, { clientX: 20, pointerId: 1 });
    expect(getAssemblyRuntime().studyTimeS).toBe(1.5);
    expect(screen.getByLabelText('Playhead').textContent).toBe('1.50');
    expect(screen.getByText('67.5°')).toBeTruthy();
  });

  it('keys every track at the playhead as one study command', () => {
    const { executed, manager } = mount();
    const ruler = lane(screen.getByTestId('motion-ruler'));
    fireEvent.pointerDown(ruler, { clientX: 50, pointerId: 1, button: 0 });
    fireEvent.pointerUp(ruler, { pointerId: 1 });
    // A pose dragged in the viewport is what gets keyed.
    act(() => assemblyRuntime.setOverride('j_pivot', [30]));
    fireEvent.click(screen.getByRole('button', { name: 'Key at playhead' }));
    expect(executed).toHaveLength(1);
    expect(lastStudy(executed).tracks[0]?.keys).toEqual([
      { t: 0, value: 0, easing: 'linear' },
      { t: 0.5, value: 30, easing: 'linear' },
      { t: 2, value: 90, easing: 'linear' }
    ]);
    expect(manager.document.assembly?.studies[0]?.tracks[0]?.keys).toHaveLength(
      3
    );
    // K again at the same time replaces that key instead of adding one.
    act(() => assemblyRuntime.setOverride('j_pivot', [35]));
    fireEvent.keyDown(screen.getByRole('region'), { key: 'k' });
    expect(executed).toHaveLength(2);
    expect(lastStudy(executed).tracks[0]?.keys.map((k) => k.value)).toEqual([
      0, 35, 90
    ]);
  });

  it('plays with startStudy and pauses keeping the playhead', () => {
    const start = vi.spyOn(assemblyRuntime, 'startStudy');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(start).toHaveBeenCalledWith('study_1', 1, 0);
    expect(getAssemblyRuntime().playback?.kind).toBe('study');
    // The driver advances the playhead; pause keeps it and the pose.
    act(() => {
      assemblyRuntime.setStudyTime(0.84);
    });
    expect(screen.getByLabelText('Playhead').textContent).toBe('0.84');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(getAssemblyRuntime().playback).toBeNull();
    expect(getAssemblyRuntime().studyTimeS).toBe(0.84);
    expect(getAssemblyRuntime().overrides.get('j_pivot')?.[0]).toBeCloseTo(
      37.8
    );
    // Space toggles while the timeline has focus; 2× restarts at that speed.
    fireEvent.click(screen.getByRole('button', { name: 'Speed 1×' }));
    expect(screen.getByRole('button', { name: 'Speed 2×' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('region'), { key: ' ' });
    expect(start).toHaveBeenLastCalledWith('study_1', 2, 0.84);
  });

  it('retimes a dragged key between its neighbours and deletes a key', () => {
    const { executed } = mount();
    const row = lane(screen.getByTestId('motion-lane-0'));
    const last = screen.getByRole('button', { name: 'Key at 2.00 s, 90°' });
    fireEvent.pointerDown(last, { clientX: 200, pointerId: 2, button: 0 });
    fireEvent.pointerMove(last, { clientX: 150, pointerId: 2 });
    fireEvent.pointerMove(last, { clientX: -40, pointerId: 2 });
    fireEvent.pointerUp(last, { pointerId: 2 });
    expect(row).toBeTruthy();
    // Clamped 1 ms after the first key.
    expect(lastStudy(executed).tracks[0]?.keys.map((k) => k.t)).toEqual([
      0, 0.001
    ]);
    // The moved key stays selected: Delete removes it; the last key stays.
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Delete' });
    expect(lastStudy(executed).tracks[0]?.keys).toEqual([
      { t: 0, value: 0, easing: 'linear' }
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Key at 0.00 s, 0°' }));
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Delete' });
    expect(executed).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toMatch(/at least one key/);
  });

  it('edits the selected key and steps the playhead between keys', () => {
    const { executed } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Key at 2.00 s, 90°' }));
    const editor = screen.getByRole('group', { name: 'Selected key' });
    expect(editor).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ease' }));
    expect(lastStudy(executed).tracks[0]?.keys[1]?.easing).toBe('ease');
    expect(
      screen.getByRole('button', { name: 'Ease' }).getAttribute('aria-pressed')
    ).toBe('true');
    const value = screen.getByLabelText('Key value');
    fireEvent.change(value, { target: { value: '120' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    expect(lastStudy(executed).tracks[0]?.keys[1]?.value).toBe(120);
    fireEvent.keyDown(screen.getByRole('region'), { key: ']' });
    expect(getAssemblyRuntime().studyTimeS).toBe(2);
    fireEvent.keyDown(screen.getByRole('region'), { key: '[' });
    expect(getAssemblyRuntime().studyTimeS).toBe(0);
  });

  it('changes duration and playback mode as single commands', () => {
    const { executed } = mount();
    const duration = screen.getByLabelText('Duration in seconds');
    fireEvent.change(duration, { target: { value: '1' } });
    fireEvent.blur(duration);
    expect(lastStudy(executed).durationS).toBe(1);
    expect(lastStudy(executed).tracks[0]?.keys.map((k) => k.t)).toEqual([0, 1]);
    // The same Playback select a joint and Set up motion use (I57).
    const playback = screen.getByRole('combobox', { name: 'Playback' });
    fireEvent.change(playback, { target: { value: 'ping-pong' } });
    expect(lastStudy(executed).playback).toBe('ping-pong');
    fireEvent.change(playback, { target: { value: 'once' } });
    expect(lastStudy(executed).playback).toBe('once');
    expect(executed).toHaveLength(3);
  });

  it('adds a track for an untracked joint motion from the menu', () => {
    const manager = pivotProject();
    const study = manager.document.assembly!.studies[0]!;
    manager.execute(
      commandFactories.setAssemblyStudy({ study: { ...study, tracks: [] } })
    );
    const { executed } = mount(manager);
    expect(screen.getByText('Add a joint to animate')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Key at playhead' })
        .hasAttribute('disabled')
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add track' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Pivot/ }));
    expect(lastStudy(executed).tracks).toEqual([
      {
        jointId: 'j_pivot',
        dof: 0,
        keys: [{ t: 0, value: 0, easing: 'linear' }]
      }
    ]);
    // Every motion now has a track: nothing left to add.
    expect(screen.queryByRole('button', { name: 'Add track' })).toBeNull();
  });

  it('keys a coupled move from the part that was moved, and refuses one that names none', () => {
    const commitPose = vi.fn();
    registerAssemblyCommitHandlers({ commitPose, createJoint: vi.fn() });
    const manager = coupledPairProject({ limited: false });
    manager.execute(
      commandFactories.setAssemblyStudy({
        study: {
          id: 'study_1',
          name: 'Motion 1',
          durationS: 2,
          playback: 'loop',
          tracks: [
            {
              jointId: 'turn_a',
              dof: 0,
              keys: [
                { t: 0, value: 0, easing: 'linear' },
                { t: 2, value: 80, easing: 'linear' }
              ]
            }
          ]
        }
      })
    );
    const { executed } = mount(manager);
    // A coupled value written without saying which part was moved (no
    // real path does this) is not guessed at: no key, a note, and the
    // parts go back to what the study shows.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => {
      assemblyRuntime.setOverride('turn_b', [-30]);
      assemblyRuntime.commitOverrides();
    });
    expect(executed).toHaveLength(0);
    expect(commitPose).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        'That move was not keyed: it did not say which part was moved.'
      )
    ).toBeTruthy();
    expect(getAssemblyRuntime().overrides.get('turn_b')).toEqual([0]);
    // The same move as the slider and the drag make it, naming the motion:
    // the study's own gear is keyed with the value that pose gives it.
    act(() => {
      assemblyRuntime.setOverride('turn_b', [-30], 0);
      assemblyRuntime.commitOverrides();
    });
    expect(executed).toHaveLength(1);
    expect(lastStudy(executed).tracks.map((t) => t.jointId)).toEqual([
      'turn_a'
    ]);
    expect(lastStudy(executed).tracks[0]?.keys[0]).toEqual({
      t: 0,
      value: 60,
      easing: 'linear'
    });
    registerAssemblyCommitHandlers(null);
  });

  it('keys a moved part at the playhead instead of saving the rest pose', () => {
    const commitPose = vi.fn();
    registerAssemblyCommitHandlers({ commitPose, createJoint: vi.fn() });
    const { executed } = mount();
    const ruler = lane(screen.getByTestId('motion-ruler'));
    fireEvent.pointerDown(ruler, { clientX: 100, pointerId: 1, button: 0 });
    fireEvent.pointerUp(ruler, { pointerId: 1 });
    // A drag (or the joint's value) ends with commitOverrides.
    act(() => {
      assemblyRuntime.setOverride('j_pivot', [10]);
      assemblyRuntime.commitOverrides();
    });
    expect(commitPose).not.toHaveBeenCalled();
    expect(executed).toHaveLength(1);
    expect(lastStudy(executed).tracks[0]?.keys).toEqual([
      { t: 0, value: 0, easing: 'linear' },
      { t: 1, value: 10, easing: 'linear' },
      { t: 2, value: 90, easing: 'linear' }
    ]);
    expect(getAssemblyRuntime().overrides.get('j_pivot')).toEqual([10]);
    // A pose the study already shows adds nothing and saves nothing.
    act(() => assemblyRuntime.commitOverrides());
    expect(executed).toHaveLength(1);
    expect(commitPose).not.toHaveBeenCalled();
    registerAssemblyCommitHandlers(null);
  });

  it('leaves pose commits alone read-only or once closed', () => {
    const commitPose = vi.fn();
    registerAssemblyCommitHandlers({ commitPose, createJoint: vi.fn() });
    const manager = pivotProject();
    const view = render(
      <MotionStudyTimeline
        assembly={manager.document.assembly}
        execute={() => true}
        readOnly
      />
    );
    act(() => {
      assemblyRuntime.setOverride('j_pivot', [10]);
      assemblyRuntime.commitOverrides();
    });
    expect(commitPose).toHaveBeenCalledTimes(1);
    view.unmount();
    const { executed } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Close motion study' }));
    act(() => {
      assemblyRuntime.setOverride('j_pivot', [20]);
      assemblyRuntime.commitOverrides();
    });
    expect(executed).toHaveLength(0);
    expect(commitPose).toHaveBeenCalledTimes(2);
    registerAssemblyCommitHandlers(null);
  });

  it('says it is recording keys, hints until the study moves, and plays from the start at the end', () => {
    const start = vi.spyOn(assemblyRuntime, 'startStudy');
    const manager = pivotProject();
    const study = manager.document.assembly!.studies[0]!;
    manager.execute(
      commandFactories.setAssemblyStudy({
        study: {
          ...study,
          tracks: [{ ...study.tracks[0]!, keys: [study.tracks[0]!.keys[0]!] }]
        }
      })
    );
    act(() => assemblyRuntime.setStudyTime(2));
    mount(manager);
    // Recording is never silent (review I59): before the first move it also
    // says what to do; after it, it still says where keys land.
    const recording = () =>
      document.querySelector('.motion-timeline-recording')?.textContent;
    expect(recording()).toBe(
      'Recording keys at 2.00 s · move a part to set it, then Play'
    );
    act(() => {
      assemblyRuntime.setOverride('j_pivot', [40]);
      assemblyRuntime.commitOverrides();
    });
    expect(recording()).toBe('Recording keys at 2.00 s');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(start).toHaveBeenCalledWith('study_1', 1, 0);
  });

  it('closes: stops playback, deselects the study and reports it', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close motion study' }));
    expect(getAssemblyRuntime().playback).toBeNull();
    expect(getAssemblyRuntime().selectedStudyId).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });
});
