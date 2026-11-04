import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import {
  AddStudyButton,
  AssemblyStudiesSection
} from './AssemblyStudiesSection';
import { pivotProject } from './motionTestFixture';

function mount(manager: CommandManager) {
  const executed: AnyCommand[] = [];
  let n = 1;
  const execute = (command: AnyCommand) => {
    executed.push(command);
    manager.execute(command);
    view.rerender(element());
    return true;
  };
  const element = () => (
    <>
      <AddStudyButton
        assembly={manager.document.assembly}
        newStudyId={() => `study_new_${n++}`}
        execute={execute}
      />
      <AssemblyStudiesSection
        assembly={manager.document.assembly}
        execute={execute}
      />
    </>
  );
  const view = render(element());
  return { executed, manager, view };
}

beforeEach(() => {
  assemblyRuntime.reset();
});

afterEach(() => {
  assemblyRuntime.stop();
  assemblyRuntime.reset();
});

describe('AssemblyStudiesSection', () => {
  it('adds a default study and opens it with the playhead at its end', () => {
    const { manager, executed, view } = mount(pivotProject({ study: false }));
    expect(screen.queryByRole('list', { name: 'Motion studies' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add motion study' }));
    expect(executed.map((c) => c.kind)).toEqual(['assembly.study.set']);
    expect(manager.document.assembly?.studies).toEqual([
      {
        id: 'study_new_1',
        name: 'Motion 1',
        durationS: 2,
        playback: 'loop',
        tracks: [
          {
            jointId: 'j_pivot',
            dof: 0,
            keys: [{ t: 0, value: 0, easing: 'linear' }]
          }
        ]
      }
    ]);
    expect(getAssemblyRuntime().selectedStudyId).toBe('study_new_1');
    // The next part moved keys the end, so the study moves at once.
    expect(getAssemblyRuntime().studyTimeS).toBe(2);
    expect(
      screen
        .getByRole('button', { name: /^Motion 1/ })
        .getAttribute('aria-pressed')
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Add motion study' }));
    expect(manager.document.assembly?.studies.map((s) => s.name)).toEqual([
      'Motion 1',
      'Motion 2'
    ]);
    view.unmount();
  });

  it('offers no Add while nothing can move', () => {
    const manager = pivotProject({ study: false });
    const set = manager.document.assembly!;
    const { container } = render(
      <AddStudyButton
        assembly={{
          ...set,
          joints: set.joints.map((j) => ({ ...j, kind: 'rigid', values: [] }))
        }}
        execute={() => true}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('lists studies with durations, toggles, renames and deletes', () => {
    const { manager, executed } = mount(pivotProject());
    expect(screen.getByText('2.00 s')).toBeTruthy();
    const row = () => screen.getByRole('button', { name: /^Motion 1|^Open/ });
    fireEvent.click(row());
    expect(getAssemblyRuntime().selectedStudyId).toBe('study_1');
    // Clicking the open study again closes it.
    fireEvent.click(row());
    expect(getAssemblyRuntime().selectedStudyId).toBeNull();

    fireEvent.doubleClick(row());
    const field = screen.getByRole('textbox', { name: 'Rename Motion 1' });
    fireEvent.change(field, { target: { value: '  Open and close ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(manager.document.assembly?.studies[0]?.name).toBe('Open and close');

    // Escape leaves the name alone.
    fireEvent.doubleClick(row());
    const again = screen.getByRole('textbox', {
      name: 'Rename Open and close'
    });
    fireEvent.change(again, { target: { value: 'Other' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(executed).toHaveLength(1);

    assemblyRuntime.startStudy('study_1');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete Open and close' })
    );
    expect(executed.at(-1)?.kind).toBe('assembly.study.delete');
    expect(manager.document.assembly?.studies).toEqual([]);
    expect(getAssemblyRuntime().selectedStudyId).toBeNull();
    expect(getAssemblyRuntime().playback).toBeNull();
  });

  it('offers no edits read-only', () => {
    render(
      <AssemblyStudiesSection
        assembly={pivotProject().document.assembly}
        execute={() => true}
        readOnly
      />
    );
    fireEvent.doubleClick(screen.getByRole('button', { name: /^Motion 1/ }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });
});
