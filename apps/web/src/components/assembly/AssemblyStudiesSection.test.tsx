import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnyCommand, CommandManager } from '@openzcad/command-system';
import {
  assemblyRuntime,
  getAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import { AssemblyStudiesSection } from './AssemblyStudiesSection';
import { pivotProject } from './motionTestFixture';

function mount(manager: CommandManager) {
  const executed: AnyCommand[] = [];
  let n = 1;
  const element = () => (
    <AssemblyStudiesSection
      assembly={manager.document.assembly}
      newStudyId={() => `study_new_${n++}`}
      execute={(command) => {
        executed.push(command);
        manager.execute(command);
        view.rerender(element());
        return true;
      }}
    />
  );
  const view = render(element());
  return { executed, manager };
}

beforeEach(() => {
  assemblyRuntime.reset();
});

afterEach(() => {
  assemblyRuntime.stop();
  assemblyRuntime.reset();
});

describe('AssemblyStudiesSection', () => {
  it('creates a default study keyed where the joints stand and opens it', () => {
    const { manager, executed } = mount(pivotProject({ study: false }));
    expect(screen.getByText(/No motion studies yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New study' }));
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
    expect(
      screen
        .getByRole('button', { name: /^Motion 1/ })
        .getAttribute('aria-pressed')
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'New study' }));
    expect(manager.document.assembly?.studies.map((s) => s.name)).toEqual([
      'Motion 1',
      'Motion 2'
    ]);
  });

  it('lists studies with durations, selects, renames and deletes', () => {
    const { manager, executed } = mount(pivotProject());
    expect(screen.getByText('2.00 s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Motion 1/ }));
    expect(getAssemblyRuntime().selectedStudyId).toBe('study_1');

    fireEvent.click(screen.getByRole('button', { name: 'Rename Motion 1' }));
    const field = screen.getByRole('textbox', { name: 'Rename Motion 1' });
    fireEvent.change(field, { target: { value: '  Open and close ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(manager.document.assembly?.studies[0]?.name).toBe('Open and close');

    // Escape leaves the name alone.
    fireEvent.click(
      screen.getByRole('button', { name: 'Rename Open and close' })
    );
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
    expect(screen.queryByRole('button', { name: 'New study' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });
});
