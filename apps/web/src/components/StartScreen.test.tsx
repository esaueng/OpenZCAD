import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { toProjectId, type ProjectSummary } from '@openzcad/shared';
import { formatLastEdited, StartScreen } from './StartScreen';

const localProject: ProjectSummary = {
  projectId: toProjectId('project_local'),
  name: 'Local bracket',
  revisionCount: 1,
  updatedAt: '2026-08-04T12:00:00.000Z'
};

function renderStartScreen(
  overrides: Partial<ComponentProps<typeof StartScreen>> = {}
) {
  return render(
    <StartScreen
      projects={[localProject]}
      status=""
      busy={false}
      demos={[]}
      defaultUnits="mm"
      onCreate={vi.fn()}
      onOpen={vi.fn()}
      onOpenDemo={vi.fn()}
      onOpenSettings={vi.fn()}
      onDuplicate={vi.fn()}
      cloudProjectIds={new Set()}
      accountProjectListReached={true}
      conflictedProjectIds={new Set()}
      signedIn={true}
      onSaveToAccount={vi.fn()}
      onSaveAllToAccount={vi.fn()}
      syncRun={null}
      onRetrySync={vi.fn()}
      onDismissSyncRun={vi.fn()}
      onMoveToShelf={vi.fn()}
      onTogglePin={vi.fn()}
      onReorder={vi.fn()}
      onDeleteForever={vi.fn()}
      onEmptyTrash={vi.fn()}
      loadThumbnail={vi.fn().mockResolvedValue(undefined)}
      backfillThumbnail={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />
  );
}

describe('StartScreen new part suggestion', () => {
  it('focuses the generated name without selecting its text', () => {
    renderStartScreen();

    const input = screen.getByLabelText<HTMLInputElement>('Project name');
    expect(input).toHaveFocus();
    expect(input).not.toHaveValue('New Part');
    expect(input.selectionStart).toBe(input.selectionEnd);
  });

  it('generates a new suggestion for each fresh mount', () => {
    let sample = 0;
    const getRandomValues = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) {
          array[0] = sample;
          sample += 1;
        }
        return array;
      });

    const first = renderStartScreen();
    const firstName =
      screen.getByLabelText<HTMLInputElement>('Project name').value;
    first.unmount();
    renderStartScreen();

    expect(screen.getByLabelText('Project name')).not.toHaveValue(firstName);
    getRandomValues.mockRestore();
  });
});

describe('StartScreen project timestamps', () => {
  it('shows the local date for a project edited more than a week ago', () => {
    renderStartScreen();

    const date = new Date(localProject.updatedAt);
    const timestamp = screen.getByText(date.toLocaleDateString());

    expect(timestamp).toHaveAttribute('datetime', localProject.updatedAt);
    expect(timestamp).toHaveAttribute(
      'title',
      `Last edited ${date.toLocaleDateString()} ${date.toLocaleTimeString(
        undefined,
        { hour: 'numeric', minute: '2-digit' }
      )}`
    );
  });

  it('shortens recent edits to the time, the day or the date', () => {
    const now = new Date(2026, 8, 4, 15, 30);
    const time = (date: Date) =>
      date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const today = new Date(2026, 8, 4, 12, 21);
    expect(formatLastEdited(today.toISOString(), now)).toBe(
      `Today ${time(today)}`
    );

    const yesterday = new Date(2026, 8, 3, 23, 5);
    expect(formatLastEdited(yesterday.toISOString(), now)).toBe(
      `Yesterday ${time(yesterday)}`
    );

    const thisWeek = new Date(2026, 8, 1, 9, 0);
    expect(formatLastEdited(thisWeek.toISOString(), now)).toBe(
      `${thisWeek.toLocaleDateString(undefined, { weekday: 'short' })} ${time(thisWeek)}`
    );

    const lastMonth = new Date(2026, 7, 4, 9, 0);
    expect(formatLastEdited(lastMonth.toISOString(), now)).toBe(
      lastMonth.toLocaleDateString()
    );
  });
});

describe('StartScreen cloud project status', () => {
  it('offers a confirmed device-only project for account sync', () => {
    renderStartScreen();

    expect(screen.getByLabelText('On this device only')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save it to my account' })
    ).toBeInTheDocument();
  });

  it('does not relabel projects when the account listing failed', () => {
    renderStartScreen({ accountProjectListReached: false });

    expect(
      screen.getByText(
        'Cloud project status is temporarily unavailable. Your projects remain saved on this device.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('On this device only')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Save it to my account' })
    ).toBeNull();
  });

  it('does not expose the retired invitation token paste flow', () => {
    renderStartScreen();

    expect(screen.queryByLabelText('Invitation token')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join project' })).toBeNull();
  });
});

describe('StartScreen collapsed project grid', () => {
  it('shows ten saved projects before moving the rest behind the expand control', () => {
    const projects = Array.from({ length: 26 }, (_, index) => ({
      projectId: toProjectId(`project_${index + 1}`),
      name: `Part ${index + 1}`,
      revisionCount: index + 1,
      updatedAt: '2026-08-04T12:00:00.000Z'
    }));

    renderStartScreen({ projects, signedIn: false });

    expect(screen.getByText('Part 10')).toBeInTheDocument();
    expect(screen.queryByText('Part 11')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show 16 more parts' }));

    expect(screen.getByText('Part 26')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show fewer parts' })
    ).toBeInTheDocument();
  });

  it('bounds cold-cache thumbnail backfill to the visible ten tiles', async () => {
    const projects = Array.from({ length: 26 }, (_, index) => ({
      projectId: toProjectId(`bounded_project_${index + 1}`),
      name: `Part ${index + 1}`,
      revisionCount: index + 1,
      updatedAt: '2026-08-04T12:00:00.000Z'
    }));
    const backfillThumbnail = vi
      .fn<(project: ProjectSummary) => Promise<string | null | undefined>>()
      .mockResolvedValue(undefined);

    renderStartScreen({
      projects,
      signedIn: false,
      backfillThumbnail
    });

    await waitFor(() => expect(backfillThumbnail).toHaveBeenCalledTimes(10));
    expect(
      backfillThumbnail.mock.calls.map(([project]) => project.name)
    ).toEqual(projects.slice(0, 10).map((project) => project.name));

    fireEvent.click(screen.getByRole('button', { name: 'Show 16 more parts' }));

    await waitFor(() => expect(backfillThumbnail).toHaveBeenCalledTimes(26));
  });
});
