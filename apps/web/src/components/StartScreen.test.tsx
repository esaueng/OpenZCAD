import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { describeProject } from '../lib/projectProperties';
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
      loadProperties={vi.fn().mockResolvedValue(null)}
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
      publishThumbnail={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />
  );
}

describe('StartScreen properties', () => {
  it('loads details only on demand and returns focus to the card action button', async () => {
    const onOpen = vi.fn();
    const doc = createProjectDocument(localProject.name, toUserId('user_test'));
    const loadProperties = vi
      .fn()
      .mockResolvedValue(describeProject(doc, 'device'));
    renderStartScreen({ loadProperties, onOpen });
    const actions = screen.getByRole('button', {
      name: `Actions for ${localProject.name}`
    });
    fireEvent.click(actions);
    expect(loadProperties).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Project properties'
    });
    await waitFor(() =>
      expect(within(dialog).getByText('Document size')).toBeInTheDocument()
    );
    expect(loadProperties).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(dialog).getByText(localProject.name)).toBeInTheDocument();
    expect(within(dialog).getByText('This device only')).toBeInTheDocument();
    expect(within(dialog).getByText('Millimeters (mm)')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(actions).toHaveFocus();
  });

  it('keeps summary details and a retry action available after a failed load', async () => {
    const loadProperties = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(
        describeProject(
          createProjectDocument(localProject.name, toUserId('user_test')),
          'device'
        )
      );
    renderStartScreen({ loadProperties, accountProjectListReached: false });
    fireEvent.click(
      screen.getByRole('button', { name: `Actions for ${localProject.name}` })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    await screen.findByRole('alert');
    expect(
      screen.getByText('Unknown — account listing unavailable')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Document size');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['archived', 'deleted'] as const)(
    'offers properties on the %s shelf',
    async (status) => {
      renderStartScreen({
        projects: [
          {
            ...localProject,
            organization: { status, pinned: false, sortOrder: 0 }
          }
        ]
      });
      fireEvent.click(
        screen.getByRole('tab', {
          name: status === 'archived' ? /Archive/ : /Trash/
        })
      );
      fireEvent.click(
        screen.getByRole('button', { name: `Actions for ${localProject.name}` })
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
      expect(
        await screen.findByRole('dialog', { name: 'Project properties' })
      ).toBeInTheDocument();
      await screen.findByRole('alert');
    }
  );

  it('ignores a late response after closing and opening another project', async () => {
    let finishFirst!: (value: ReturnType<typeof describeProject>) => void;
    const second = {
      ...localProject,
      projectId: toProjectId('second'),
      name: 'Second part'
    };
    const loadProperties = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          })
      )
      .mockResolvedValueOnce(
        describeProject(
          createProjectDocument(second.name, toUserId('user_test'), 'inch'),
          'account'
        )
      );
    renderStartScreen({ projects: [localProject, second], loadProperties });
    fireEvent.click(
      screen.getByRole('button', { name: `Actions for ${localProject.name}` })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close project properties' })
    );
    fireEvent.click(
      screen.getByRole('button', { name: `Actions for ${second.name}` })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    await screen.findByText('Inches (in)');
    await act(async () =>
      finishFirst(
        describeProject(
          createProjectDocument(localProject.name, toUserId('user_test')),
          'device'
        )
      )
    );
    expect(screen.getByText('Inches (in)')).toBeInTheDocument();
    expect(screen.queryByText('Millimeters (mm)')).toBeNull();
  });
});

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

describe('StartScreen library discovery', () => {
  it('keeps unknown parts and account state out of the first-run layout', () => {
    const { container } = renderStartScreen({
      projects: [],
      signedIn: false,
      accountProjectListReached: false,
      loading: true,
      busy: true
    });

    expect(
      screen.getByRole('status', { name: 'Loading library' })
    ).toBeVisible();
    expect(container.querySelector('.start-screen')).not.toHaveClass(
      'is-fresh'
    );
    expect(screen.queryByText('No parts yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Signed out')).not.toBeInTheDocument();
    expect(screen.getByText('Checking…')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Parts …' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Create project' })
    ).toBeDisabled();
    expect(screen.getByLabelText('Search parts')).toBeVisible();
  });

  it('shows first-run guidance only once discovery confirms an empty library', () => {
    const { container } = renderStartScreen({
      projects: [],
      signedIn: false
    });

    expect(container.querySelector('.start-screen')).toHaveClass('is-fresh');
    expect(screen.getByText('No parts yet')).toBeVisible();
    expect(screen.getByText('Signed out')).toBeVisible();
    expect(
      screen.queryByRole('status', { name: 'Loading library' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create project' })
    ).toBeEnabled();
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
      date.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      });

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

describe('StartScreen library shell', () => {
  it('takes the first-run layout until a part exists', () => {
    const { container, rerender, unmount } = renderStartScreen({
      projects: []
    });

    expect(container.querySelector('.start-screen.is-fresh')).not.toBeNull();
    expect(screen.getByText('No parts yet')).toBeInTheDocument();
    unmount();

    renderStartScreen();
    expect(
      document.querySelector('.start-screen:not(.is-fresh)')
    ).not.toBeNull();
    void rerender;
  });

  it('names each shelf with its count in the column', () => {
    renderStartScreen();

    expect(screen.getByRole('tab', { name: 'Parts 1' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: 'Archive 0' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Trash 0' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Parts' })
    ).toBeInTheDocument();
  });

  it('reads the account balance in the column without repeating the offer', () => {
    renderStartScreen({
      projects: [
        localProject,
        {
          projectId: toProjectId('project_cloud'),
          name: 'Cloud flange',
          revisionCount: 3,
          updatedAt: '2026-08-05T12:00:00.000Z'
        }
      ],
      cloudProjectIds: new Set([toProjectId('project_cloud')])
    });

    expect(screen.getByText('1 / 2 saved')).toBeInTheDocument();
    // One offer, with the parts it is about; the readout is not a second one.
    expect(
      screen.getAllByRole('button', { name: /to my account/ })
    ).toHaveLength(1);
  });

  it('says so when signed out instead of counting', () => {
    renderStartScreen({ signedIn: false });

    expect(screen.getByText('Signed out')).toBeInTheDocument();
    expect(screen.queryByText(/saved$/)).toBeNull();
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
    const publishThumbnail = vi
      .fn<(project: ProjectSummary) => Promise<string | null | undefined>>()
      .mockResolvedValue(undefined);

    renderStartScreen({
      projects,
      signedIn: false,
      publishThumbnail
    });

    await waitFor(() => expect(publishThumbnail).toHaveBeenCalledTimes(10));
    expect(
      publishThumbnail.mock.calls.map(([project]) => project.name)
    ).toEqual(projects.slice(0, 10).map((project) => project.name));

    fireEvent.click(screen.getByRole('button', { name: 'Show 16 more parts' }));

    await waitFor(() => expect(publishThumbnail).toHaveBeenCalledTimes(26));
  });
});
