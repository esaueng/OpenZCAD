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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toProjectId, type ProjectSummary } from '@openzcad/shared';
import { formatLastEdited, recoveryCopyOf, StartScreen } from './StartScreen';

const localProject: ProjectSummary = {
  projectId: toProjectId('project_local'),
  name: 'Local bracket',
  revisionCount: 1,
  updatedAt: '2026-08-04T12:00:00.000Z'
};

function startScreenProps(
  overrides: Partial<ComponentProps<typeof StartScreen>> = {}
): ComponentProps<typeof StartScreen> {
  return {
    projects: [localProject],
    status: '',
    busy: false,
    demos: [],
    defaultUnits: 'mm',
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onOpenDemo: vi.fn(),
    onOpenSettings: vi.fn(),
    onDuplicate: vi.fn(),
    loadProperties: vi.fn().mockResolvedValue(null),
    cloudProjectIds: new Set(),
    accountProjectListReached: true,
    conflictedProjectIds: new Set(),
    signedIn: true,
    onSaveToAccount: vi.fn(),
    onSaveAllToAccount: vi.fn(),
    syncRun: null,
    onRetrySync: vi.fn(),
    onDismissSyncRun: vi.fn(),
    onMoveToShelf: vi.fn(),
    onTogglePin: vi.fn(),
    onReorder: vi.fn(),
    onDeleteForever: vi.fn(),
    onEmptyTrash: vi.fn(),
    loadThumbnail: vi.fn().mockResolvedValue(undefined),
    publishThumbnail: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function renderStartScreen(
  overrides: Partial<ComponentProps<typeof StartScreen>> = {}
) {
  return render(<StartScreen {...startScreenProps(overrides)} />);
}

// The library keeps its view and scroll per tab; each test starts afresh.
afterEach(() => {
  sessionStorage.removeItem('openzcad.start.view');
  sessionStorage.removeItem('openzcad.start.scroll');
});

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
  it('suggests a generated name without focusing the field', () => {
    renderStartScreen();

    const input = screen.getByLabelText<HTMLInputElement>('Project name');
    // Opening or reloading the library must not drop the caret into the
    // name field: typing should not land there until the user picks it.
    expect(input).not.toHaveFocus();
    expect(input).not.toHaveValue('New Part');
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

describe('StartScreen launch form', () => {
  it('does not create the part from the Enter that commits an IME composition', () => {
    // CJK input commits a composition with Enter; creating on that keystroke
    // left the start screen with a half-typed name.
    const onCreate = vi.fn();
    renderStartScreen({ onCreate });
    const input = screen.getByLabelText('Project name');

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    // Safari sends the committing Enter after compositionend, marked by 229.
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('names the units select by its visible label', () => {
    renderStartScreen();

    expect(screen.getByRole('combobox', { name: 'Units' })).toHaveValue('mm');
  });
});

describe('StartScreen keyboard', () => {
  const parts = ['Alpha', 'Bravo', 'Charlie'].map(
    (name, index): ProjectSummary => ({
      ...localProject,
      projectId: toProjectId(`project_${name.toLowerCase()}`),
      name,
      organization: { status: 'active', pinned: false, sortOrder: index }
    })
  );

  function archived(project: ProjectSummary): ProjectSummary {
    return {
      ...project,
      organization: { status: 'archived', pinned: false, sortOrder: 0 }
    };
  }

  it('moves focus into the tile menu, around it with the arrow keys, and back to its button on Escape', () => {
    renderStartScreen();
    const opener = screen.getByRole('button', {
      name: `Actions for ${localProject.name}`
    });

    fireEvent.click(opener);
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    const first = items[0]!;
    const last = items.at(-1)!;
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Home' });
    expect(first).toHaveFocus();

    // The focused item unmounts with the menu; focus used to fall to <body>.
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('opens the tile menu from its button with the arrow keys and leaves it with Tab', () => {
    renderStartScreen();
    const opener = screen.getByRole('button', {
      name: `Actions for ${localProject.name}`
    });

    fireEvent.keyDown(opener, { key: 'ArrowUp' });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.at(-1)).toHaveFocus();
    // Not tab stops: Tab leaves the menu instead of walking its items.
    for (const item of items) {
      expect(item).toHaveAttribute('tabindex', '-1');
    }

    fireEvent.keyDown(items.at(-1)!, { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(opener).toHaveFocus();

    fireEvent.keyDown(opener, { key: 'ArrowDown' });
    expect(
      within(screen.getByRole('menu')).getAllByRole('menuitem')[0]
    ).toHaveFocus();
  });

  it('hands focus to the next part, then the previous, then the heading as parts leave the shelf', () => {
    const onMoveToShelf = vi.fn();
    const [alpha, bravo, charlie] = parts as [
      ProjectSummary,
      ProjectSummary,
      ProjectSummary
    ];
    // Signed out, so no device-only badge leads the tiles' names.
    const props = { onMoveToShelf, signedIn: false };
    const { rerender } = renderStartScreen({ ...props, projects: parts });
    // App persists the move, then hands the shelf its new listing.
    const show = (projects: ProjectSummary[]) =>
      rerender(<StartScreen {...startScreenProps({ ...props, projects })} />);
    const archive = (project: ProjectSummary) => {
      fireEvent.click(
        screen.getByRole('button', { name: `Actions for ${project.name}` })
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
      expect(onMoveToShelf).toHaveBeenLastCalledWith(project, 'archived');
    };

    archive(bravo);
    show([alpha, archived(bravo), charlie]);
    expect(screen.getByRole('button', { name: /^Charlie/ })).toHaveFocus();

    archive(charlie);
    show([alpha, archived(bravo), archived(charlie)]);
    expect(screen.getByRole('button', { name: /^Alpha/ })).toHaveFocus();

    archive(alpha);
    show(parts.map(archived));
    expect(
      screen.getByRole('heading', { level: 2, name: 'Parts' })
    ).toHaveFocus();
  });

  it('leaves focus alone when a move did not take the part off the shelf', () => {
    renderStartScreen();
    const opener = screen.getByRole('button', {
      name: `Actions for ${localProject.name}`
    });

    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    // A failed move keeps the tile; focus waits on its menu button.
    expect(opener).toHaveFocus();
  });

  it('makes the shelf tabs one tab stop that the arrow keys move along', () => {
    renderStartScreen();
    const tabs = screen.getAllByRole('tab');
    const panel = screen.getByRole('tabpanel');

    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAccessibleName('Parts 1');

    fireEvent.keyDown(tabs[0]!, { key: 'ArrowDown' });
    const archive = screen.getByRole('tab', { name: 'Archive 0' });
    expect(archive).toHaveFocus();
    expect(archive).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Archive 0');

    fireEvent.keyDown(archive, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Trash 0' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Trash 0' }), {
      key: 'ArrowRight'
    });
    expect(screen.getByRole('tab', { name: 'Parts 1' })).toHaveFocus();
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([
      0, -1, -1
    ]);
  });
});

describe('StartScreen shelf wording', () => {
  it('says where the parts went when the Parts shelf is empty but the library is not', () => {
    renderStartScreen({
      projects: [
        {
          ...localProject,
          organization: { status: 'archived', pinned: false, sortOrder: 0 }
        }
      ]
    });

    expect(screen.queryByText('No parts yet')).toBeNull();
    expect(screen.queryByText('nothing saved yet')).toBeNull();
    expect(screen.getByText('none on this shelf')).toBeInTheDocument();
    expect(
      screen.getByText('All your parts are in Archive.')
    ).toBeInTheDocument();
  });

  it('calls an empty trash the trash, like every other trash control', () => {
    renderStartScreen();

    fireEvent.click(screen.getByRole('tab', { name: /^Trash/ }));
    expect(screen.getByText('the trash is empty')).toBeInTheDocument();
    expect(screen.getByText('Nothing in the trash.')).toBeInTheDocument();
    expect(screen.queryByText(/recycle bin/)).toBeNull();
  });

  it('names the trash footer actions after their part', () => {
    const onDeleteForever = vi.fn();
    renderStartScreen({
      onDeleteForever,
      projects: [
        {
          ...localProject,
          organization: {
            status: 'deleted',
            pinned: false,
            sortOrder: 0,
            deletedAt: new Date().toISOString()
          }
        }
      ]
    });

    fireEvent.click(screen.getByRole('tab', { name: /^Trash/ }));
    expect(
      screen.getByRole('button', { name: `Restore ${localProject.name}` })
    ).toHaveTextContent('Restore');
    fireEvent.click(
      screen.getByRole('button', {
        name: `Delete ${localProject.name} forever`
      })
    );
    expect(onDeleteForever).toHaveBeenCalledOnce();
  });
});

describe('StartScreen library discovery', () => {
  it.each(['grid', 'list'])(
    'keeps a known-empty %s shelf empty while discovery is pending',
    (layout) => {
      sessionStorage.clear();
      localStorage.setItem('openzcad.start.layout', layout);
      const { unmount } = renderStartScreen({ projects: [] });
      unmount();
      const { container } = renderStartScreen({
        projects: [],
        loading: true,
        busy: true
      });
      expect(
        screen.getByRole('status', { name: 'Loading library' })
      ).toBeVisible();
      expect(
        container.querySelectorAll('.start-tile-placeholder')
      ).toHaveLength(0);
      expect(screen.queryByText('No parts yet')).not.toBeInTheDocument();
      localStorage.removeItem('openzcad.start.layout');
      sessionStorage.clear();
    }
  );
  it.each(['grid', 'list'])(
    'reserves pinned groups, recovery footers and toolbar in %s layout',
    (layout) => {
      sessionStorage.clear();
      localStorage.setItem('openzcad.start.layout', layout);
      const pinned = {
        ...localProject,
        name: 'Pinned part',
        organization: { status: 'active' as const, pinned: true, sortOrder: 0 }
      };
      const projects = [
        pinned,
        {
          ...localProject,
          projectId: toProjectId('regular'),
          name: 'Regular part'
        },
        {
          ...localProject,
          projectId: toProjectId('recovery'),
          name: 'Pinned part (Recovery)'
        }
      ];
      const { unmount } = renderStartScreen({ projects });
      unmount();
      const { container } = renderStartScreen({
        projects: [],
        loading: true,
        busy: true
      });
      expect(
        [...container.querySelectorAll('.start-shelf-group')].map(
          (heading) => heading.textContent
        )
      ).toEqual(['Pinned…', 'Parts…']);
      expect(
        container.querySelectorAll('.start-tile-placeholder')
      ).toHaveLength(3);
      // Only a list row grows by a copies line; a card keeps a corner count.
      expect(
        container.querySelectorAll('.start-tile-placeholder .start-tile-copies')
      ).toHaveLength(layout === 'list' ? 1 : 0);
      expect(screen.getByRole('group', { name: 'Show parts' })).toBeVisible();
      expect(screen.getByLabelText('Sort parts')).toBeDisabled();
      expect(
        container.querySelectorAll('.start-tile-grid.is-list')
      ).toHaveLength(layout === 'list' ? 2 : 0);
      localStorage.removeItem('openzcad.start.layout');
      sessionStorage.clear();
    }
  );
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
    expect(screen.queryByText('On this device only')).not.toBeInTheDocument();
    expect(screen.getByText('Checking account…')).toBeVisible();
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
    expect(screen.getByText('On this device only')).toBeVisible();
    expect(
      screen.queryByRole('status', { name: 'Loading library' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create project' })
    ).toBeEnabled();
  });
});

describe('StartScreen project timestamps', () => {
  const shortDate = (date: Date) =>
    date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

  it('shows the date on the tile and the exact time in its tooltip', () => {
    renderStartScreen();

    const date = new Date(localProject.updatedAt);
    const timestamp = screen.getByText(shortDate(date));

    expect(timestamp).toHaveAttribute('datetime', localProject.updatedAt);
    expect(timestamp).toHaveAttribute(
      'title',
      `Last edited ${date.toLocaleDateString()} ${date.toLocaleTimeString(
        undefined,
        { hour: 'numeric', minute: '2-digit' }
      )} · ${localProject.revisionCount} ${
        localProject.revisionCount === 1 ? 'save' : 'saves'
      }`
    );
  });

  it('writes recent and old edits in one shape, so a row never mixes two', () => {
    // The shelf used to say "Today 4:05 PM" and "Tue 4:05 PM" within the week
    // and a numeric date beyond it, so neighbouring tiles read differently.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const lastMonth = new Date(2026, 7, 4, 9, 0);

    for (const date of [today, yesterday, lastMonth]) {
      expect(formatLastEdited(date.toISOString())).toBe(shortDate(date));
    }
    expect(formatLastEdited(today.toISOString())).not.toMatch(/^Today/);
  });
});

describe('StartScreen cloud project status', () => {
  it('shows recovery time, and the save count only in the list, without presenting it as a model version', () => {
    const project = {
      ...localProject,
      name: 'Bracket (Recovery)',
      revisionCount: 1,
      updatedAt: '2026-10-05T05:00:00Z'
    };
    const { unmount } = renderStartScreen({ projects: [project] });
    expect(
      screen.getByText(project.name).closest('button')
    ).not.toHaveTextContent('save');
    unmount();
    localStorage.setItem('openzcad.start.layout', 'list');
    renderStartScreen({ projects: [project] });
    localStorage.removeItem('openzcad.start.layout');
    const tile = screen.getByText(project.name).closest('button')!;
    expect(tile).toHaveTextContent('1 save');
    expect(tile).toHaveTextContent(
      new Date(project.updatedAt).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      })
    );
  });
  it('offers a confirmed device-only project for account sync', () => {
    renderStartScreen();

    expect(screen.getByLabelText('On this device only')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save it to my account' })
    ).toBeInTheDocument();
  });

  it('does not relabel projects when the account listing failed', () => {
    renderStartScreen({ accountProjectListReached: false });

    expect(screen.getByText('Account status unavailable')).toHaveAttribute(
      'title',
      'Cloud project status is temporarily unavailable. Your projects remain saved on this device.'
    );
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

  it('says the account balance and its offer as one sentence', () => {
    const { container } = renderStartScreen({
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

    // One sentence carries both the count and the offer; the card used to
    // say "1 / 2 saved" and "1 project is on this device only" one above
    // the other.
    const card = screen.getByRole('complementary', { name: 'Cloud sync' });
    expect(within(card).getByText('1 part not saved')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /to my account/ })
    ).toHaveLength(1);
    expect(
      within(card).getByRole('button', { name: 'Save it to my account' })
    ).toHaveTextContent('Save');
    expect(container.querySelector('footer')).toBeNull();
  });

  it('counts every part once they are all in the account', () => {
    renderStartScreen({
      cloudProjectIds: new Set([localProject.projectId])
    });

    expect(screen.getByText('1 part saved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /to my account/ })).toBeNull();
  });

  it('offers sign-in in one line when signed out', () => {
    // Settings' footer explains signing in; the card used to repeat it as a
    // paragraph, a third copy of the same nag. The sentence names the state
    // and the tooltip carries the why.
    const onSignIn = vi.fn();
    const { container } = renderStartScreen({ signedIn: false, onSignIn });
    const card = container.querySelector('.start-account');
    if (!card) throw new Error('No account readout');

    expect(card.children).toHaveLength(1);
    expect(screen.queryByText(/saved$/)).toBeNull();
    expect(
      within(card as HTMLElement).getByText('On this device only')
    ).toHaveAttribute('title', expect.stringContaining('Sign in'));
    fireEvent.click(
      within(card as HTMLElement).getByRole('button', { name: 'Sign in' })
    );
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it('keeps mode texts off the status line but shows real news', () => {
    const { rerender } = renderStartScreen({ status: 'Cloud profile ready' });
    expect(document.querySelector('.start-status')).toBeNull();

    rerender(
      <StartScreen
        {...startScreenProps()}
        status='"name" must be at most 200 characters.'
      />
    );
    expect(document.querySelector('.start-status')).toHaveTextContent(
      'at most 200 characters'
    );
  });

  it('turns the sentence over to a save run and its failures', () => {
    const onRetrySync = vi.fn();
    const onDismissSyncRun = vi.fn();
    renderStartScreen({
      status: 'Saved 1 part · 1 could not be saved.',
      onRetrySync,
      onDismissSyncRun,
      syncRun: [
        { projectId: 'project_ok', name: 'Saved part', state: 'synced' },
        {
          projectId: localProject.projectId,
          name: localProject.name,
          state: 'failed',
          detail: 'Storage is down.'
        }
      ]
    });

    expect(screen.getByText('1 not saved')).toBeInTheDocument();
    // The run's own outcome is the sentence; the status echo is not repeated.
    expect(document.querySelector('.start-status')).toBeNull();
    const retry = screen.getByRole('button', {
      name: `Retry ${localProject.name}`
    });
    expect(retry).toHaveAttribute('title', 'Storage is down.');
    fireEvent.click(retry);
    expect(onRetrySync).toHaveBeenCalledWith(localProject.projectId);
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss sync results' })
    );
    expect(onDismissSyncRun).toHaveBeenCalledOnce();
  });
});

describe('StartScreen scrolling project grid', () => {
  const projects = Array.from({ length: 96 }, (_, index) => ({
    projectId: toProjectId(`scroll_project_${index + 1}`),
    name: `Part ${index + 1}`,
    revisionCount: index + 1,
    updatedAt: '2026-08-04T12:00:00.000Z'
  }));

  it('shows every project without an expand control and opens the last one', () => {
    const onOpen = vi.fn();
    renderStartScreen({ projects, signedIn: false, onOpen });

    expect(screen.getByText('Part 11')).toBeInTheDocument();
    expect(screen.getByText('Part 96')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show .*parts/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Part 96/ }));
    expect(onOpen).toHaveBeenCalledWith(toProjectId('scroll_project_96'));
  });

  it('searches the full list and restores every project after clearing', () => {
    renderStartScreen({ projects, signedIn: false });

    fireEvent.change(screen.getByLabelText('Search parts'), {
      target: { value: 'Part 96' }
    });
    expect(screen.getByText('Part 96')).toBeInTheDocument();
    expect(screen.queryByText('Part 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Part 1')).toBeInTheDocument();
    expect(screen.getByText('Part 96')).toBeInTheDocument();
  });
});

describe('StartScreen update notice', () => {
  it('offers a persistent download-recovery action without claiming an update', () => {
    const onReload = vi.fn();
    renderStartScreen({ onReloadForLoadFailure: onReload });
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('Check your connection');
    expect(notice).not.toHaveTextContent(/new version/i);
    fireEvent.click(within(notice).getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('offers a reload once a newer build is out, and not before', () => {
    const { rerender } = renderStartScreen();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const onReload = vi.fn();
    rerender(
      <StartScreen
        projects={[localProject]}
        status="OpenZCAD was updated while this tab was open. Reload to load the new version."
        onReloadForUpdate={onReload}
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
      />
    );
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('New version ready');
    fireEvent.click(within(notice).getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledOnce();
  });
});

describe('StartScreen shelf filters, order and layout', () => {
  const part = (
    id: string,
    name: string,
    updatedAt: string,
    pinned = false
  ): ProjectSummary => ({
    projectId: toProjectId(id),
    name,
    revisionCount: 1,
    updatedAt,
    ...(pinned && {
      organization: {
        status: 'active',
        pinned: true,
        sortOrder: 0
      }
    })
  });
  const projects = [
    part('project_b', 'Bracket', '2026-08-01T00:00:00.000Z'),
    part('project_a', 'Axle', '2026-08-03T00:00:00.000Z'),
    part('project_r', 'Bracket (Recovery)', '2026-08-02T00:00:00.000Z'),
    part('project_c', 'Clamp', '2026-08-04T00:00:00.000Z')
  ];
  const tileNames = () =>
    Array.from(document.querySelectorAll('.start-tile-name')).map(
      (element) => element.textContent
    );
  const openButton = (id: string) =>
    document.querySelector<HTMLElement>(
      `[data-tile-id="${id}"] .start-tile-open`
    )!;
  // A card that can be moved is dragged by itself and offers Alt+arrow keys.
  const reorderableCards = () =>
    document.querySelectorAll('.start-tile-open[aria-keyshortcuts]').length;

  it('moves a card with Alt and the arrow keys, and leaves plain arrows alone', () => {
    const onReorder = vi.fn();
    renderStartScreen({ projects, onReorder });
    expect(document.querySelector('.start-tile-grip')).toBeNull();
    fireEvent.keyDown(openButton('project_b'), { key: 'ArrowRight' });
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.keyDown(openButton('project_b'), {
      key: 'ArrowRight',
      altKey: true
    });
    expect(onReorder).toHaveBeenCalledWith([
      'project_a',
      'project_b',
      'project_r',
      'project_c'
    ]);
  });

  it('comes back to the same shelf, sort and search in this tab', () => {
    const { unmount } = renderStartScreen({ projects });
    fireEvent.click(screen.getByRole('tab', { name: /^Archive/ }));
    fireEvent.click(screen.getByRole('tab', { name: /^Parts/ }));
    fireEvent.change(screen.getByLabelText('Sort parts'), {
      target: { value: 'name' }
    });
    fireEvent.change(screen.getByLabelText('Search parts'), {
      target: { value: 'Bra' }
    });
    unmount();
    renderStartScreen({ projects });
    expect(screen.getByLabelText('Sort parts')).toHaveValue('name');
    expect(screen.getByLabelText('Search parts')).toHaveValue('Bra');
    expect(tileNames()).toEqual(['Bracket', 'Bracket (Recovery)']);
  });

  it('lets the keyboard move a card this build cannot open', () => {
    const onReorder = vi.fn();
    renderStartScreen({
      projects: [{ ...projects[0]!, storageFormat: 99 }, ...projects.slice(1)],
      onReorder
    });
    const locked = screen.getByRole('group', { name: 'Bracket' });
    expect(locked).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(locked, { key: 'ArrowRight', altKey: true });
    expect(onReorder).toHaveBeenCalledWith([
      'project_a',
      'project_b',
      'project_r',
      'project_c'
    ]);
  });

  it('marks a recovery copy on its date line instead of with a badge', () => {
    renderStartScreen({ projects });
    expect(screen.getAllByRole('img', { name: 'Recovery copy' })).toHaveLength(
      1
    );
    expect(screen.queryByText('Recovery copy')).toBeNull();
    // The card keeps the count; the list row keeps the words.
    expect(
      screen.getByRole('button', {
        name: 'Show Bracket with its 1 recovery copy'
      })
    ).toHaveTextContent('1 recovery copy');
    expect(document.querySelector('.start-tile-rev')).toBeNull();
  });

  it('names the part a recovery copy came from', () => {
    expect(recoveryCopyOf('Bracket (Recovery)')).toBe('Bracket');
    expect(recoveryCopyOf('Merry Llama (Recovery) (copy)')).toBe('Merry Llama');
    expect(recoveryCopyOf('Plate (Local copy) (copy 2)')).toBe('Plate');
    expect(recoveryCopyOf('Recovery tool')).toBeNull();
  });

  it('gathers recovery copies and conflicts under Needs attention', () => {
    renderStartScreen({
      projects,
      cloudProjectIds: new Set(projects.map((entry) => entry.projectId)),
      conflictedProjectIds: new Set([toProjectId('project_c')])
    });
    const filters = screen.getByRole('group', { name: 'Show parts' });
    fireEvent.click(
      within(filters).getByRole('button', { name: /Needs attention/ })
    );
    expect(tileNames().sort()).toEqual(['Bracket (Recovery)', 'Clamp']);
    expect(screen.getByLabelText('Changed in two places')).toBeVisible();
    // Nothing is only on this device, so that filter is not offered.
    expect(
      within(filters).queryByRole('button', { name: /This device only/ })
    ).toBeNull();
  });

  it('drops the device-only filter when there is no account to compare against', () => {
    const props = startScreenProps({ projects, cloudProjectIds: new Set() });
    const { rerender } = render(<StartScreen {...props} />);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Show parts' })).getByRole(
        'button',
        { name: /This device only/ }
      )
    );
    expect(tileNames()).toHaveLength(projects.length);
    rerender(<StartScreen {...props} signedIn={false} />);
    expect(tileNames()).toHaveLength(projects.length);
    expect(
      within(screen.getByRole('group', { name: 'Show parts' })).getByRole(
        'button',
        { name: /^All/ }
      )
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows an original with its recovery copies from the tile', () => {
    renderStartScreen({ projects });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Show Bracket with its 1 recovery copy'
      })
    );
    expect(screen.getByLabelText('Search parts')).toHaveValue('Bracket');
    expect(tileNames().sort()).toEqual(['Bracket', 'Bracket (Recovery)']);
  });

  it('orders by name or last edit with pinned parts first, and stops reordering', () => {
    renderStartScreen({
      projects: [
        ...projects,
        part('project_p', 'Pinned plate', '2026-07-01T00:00:00.000Z', true)
      ]
    });
    expect(reorderableCards()).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Sort parts'), {
      target: { value: 'name' }
    });
    expect(tileNames()).toEqual([
      'Pinned plate',
      'Axle',
      'Bracket',
      'Bracket (Recovery)',
      'Clamp'
    ]);
    fireEvent.change(screen.getByLabelText('Sort parts'), {
      target: { value: 'edited' }
    });
    expect(tileNames()).toEqual([
      'Pinned plate',
      'Clamp',
      'Axle',
      'Bracket (Recovery)',
      'Bracket'
    ]);
    expect(reorderableCards()).toBe(0);
    expect(screen.getByRole('heading', { name: /Pinned/ })).toBeVisible();
  });

  it('groups pinned parts by their flag, not their place in the listing', () => {
    // A part created this session is prepended ahead of pinned ones.
    renderStartScreen({
      projects: [
        part('project_new', 'New part', '2026-08-05T00:00:00.000Z'),
        part('project_p', 'Pinned plate', '2026-07-01T00:00:00.000Z', true),
        ...projects
      ]
    });
    const pinned = screen.getByRole('heading', { name: /Pinned/ })
      .nextElementSibling as HTMLElement;
    expect(
      Array.from(pinned.querySelectorAll('.start-tile-name')).map(
        (element) => element.textContent
      )
    ).toEqual(['Pinned plate']);
  });

  it('switches to the list layout and remembers it on this device', () => {
    localStorage.removeItem('openzcad.start.layout');
    const { unmount } = renderStartScreen({ projects });
    const layout = screen.getByRole('group', { name: 'Layout' });
    fireEvent.click(within(layout).getByRole('button', { name: 'List' }));
    expect(document.querySelector('.start-tile-grid.is-list')).not.toBeNull();
    expect(
      within(layout).getByRole('button', { name: 'List' })
    ).toHaveAttribute('aria-pressed', 'true');
    unmount();
    renderStartScreen({ projects });
    expect(document.querySelector('.start-tile-grid.is-list')).not.toBeNull();
    localStorage.removeItem('openzcad.start.layout');
  });
});

describe('StartScreen folders and selection', () => {
  const parts: ProjectSummary[] = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map(
    (name, index) => ({
      projectId: toProjectId(`project_${name.toLowerCase()}`),
      name: `${name} plate`,
      revisionCount: 1,
      updatedAt: `2026-10-0${index + 1}T12:00:00.000Z`,
      organization: { status: 'active', pinned: false, sortOrder: index }
    })
  );

  afterEach(() => localStorage.clear());

  function seedFolder(projectIds: string[], extra: object = {}) {
    localStorage.setItem(
      'openzcad.library.folders.v1:device',
      JSON.stringify({
        folders: [
          {
            id: 'folder-1',
            name: 'Fixtures',
            projectIds,
            pinned: false,
            createdAt: '2026-10-29T00:00:00.000Z',
            ...extra
          }
        ]
      })
    );
  }

  const names = () =>
    Array.from(document.querySelectorAll('.start-tile-name')).map(
      (element) => element.textContent
    );

  it('shows filed parts inside their folder, not loose on the shelf', () => {
    seedFolder([parts[1]!.projectId, parts[2]!.projectId]);
    renderStartScreen({ projects: parts });
    expect(names()).toEqual(['Fixtures', 'Alpha plate', 'Delta plate']);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open folder Fixtures, 2 parts' })
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'Fixtures' })
    ).toBeInTheDocument();
    expect(names()).toEqual(['Bravo plate', 'Charlie plate']);
    // The crumb goes back out.
    fireEvent.click(screen.getByRole('button', { name: 'Parts' }));
    expect(names()).toEqual(['Fixtures', 'Alpha plate', 'Delta plate']);
  });

  it('looks through folders while searching', () => {
    seedFolder([parts[1]!.projectId]);
    renderStartScreen({ projects: parts });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search parts' }), {
      target: { value: 'bravo' }
    });
    expect(names()).toEqual(['Bravo plate']);
  });

  it('pins a folder ahead of the parts', () => {
    seedFolder([parts[0]!.projectId]);
    renderStartScreen({ projects: parts });
    fireEvent.click(
      screen.getByRole('button', { name: 'Pin folder Fixtures' })
    );
    const pinned = document.querySelector('[data-tile-group="pinned"]');
    expect(
      within(pinned as HTMLElement).getByText('Fixtures')
    ).toBeInTheDocument();
  });

  it('selects a range and trashes it in one action', () => {
    const onMoveManyToShelf = vi.fn();
    const onOpen = vi.fn();
    renderStartScreen({ projects: parts, onMoveManyToShelf, onOpen });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Alpha plate' })
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Charlie plate' }),
      { shiftKey: true }
    );
    const bar = screen.getByRole('toolbar', { name: '3 parts selected' });
    // While anything is picked, a click on a card picks it too.
    fireEvent.click(screen.getByText('Delta plate'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(within(bar).getByText('4 selected')).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Move to trash' }));
    expect(onMoveManyToShelf).toHaveBeenCalledWith(parts, 'deleted');
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('files the selection in a new folder and names it', () => {
    renderStartScreen({ projects: parts });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Alpha plate' })
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Delta plate' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move to' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }));
    const field = screen.getByRole('textbox', { name: 'Folder name' });
    fireEvent.change(field, { target: { value: 'Holders' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(names()).toEqual(['Holders', 'Bravo plate', 'Charlie plate']);
    expect(
      screen.getByRole('button', { name: 'Open folder Holders, 2 parts' })
    ).toBeInTheDocument();
  });

  it.each(['Archive', 'Trash'])(
    'reveals a new folder created from %s',
    (shelf) => {
      renderStartScreen({ projects: parts });
      fireEvent.click(
        screen.getByRole('tab', { name: new RegExp(`^${shelf}`) })
      );
      fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
      expect(screen.getByRole('tab', { name: /^Parts/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(
        screen.getByRole('textbox', { name: 'Folder name' })
      ).toHaveFocus();
    }
  );

  it.each(['search', 'filter'])(
    'reveals a folder created from a selection with an active %s',
    (view) => {
      const pinnedParts = parts.map((part) => ({
        ...part,
        organization: {
          ...part.organization!,
          pinned: true
        }
      }));
      renderStartScreen({ projects: pinnedParts });
      if (view === 'search') {
        fireEvent.change(
          screen.getByRole('textbox', { name: 'Search parts' }),
          {
            target: { value: 'Alpha' }
          }
        );
      } else {
        fireEvent.click(
          within(screen.getByRole('group', { name: 'Show parts' })).getByRole(
            'button',
            { name: /^Pinned/ }
          )
        );
      }
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Select Alpha plate' })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Move to' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }));
      expect(
        screen.getByRole('textbox', { name: 'Folder name' })
      ).toHaveFocus();
      expect(screen.getByRole('textbox', { name: 'Search parts' })).toHaveValue(
        ''
      );
      expect(
        within(screen.getByRole('group', { name: 'Show parts' })).getByRole(
          'button',
          { name: /^All/ }
        )
      ).toHaveAttribute('aria-pressed', 'true');
    }
  );

  it('skips disabled cover selection when navigating an empty folder menu', () => {
    seedFolder([]);
    renderStartScreen({ projects: parts });
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for folder Fixtures' })
    );
    expect(
      screen.getByRole('menuitem', { name: 'Choose cover…' })
    ).toBeDisabled();
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    const ungroup = screen.getByRole('menuitem', { name: 'Ungroup' });
    rename.focus();
    fireEvent.keyDown(rename, { key: 'ArrowDown' });
    expect(ungroup).toHaveFocus();
    fireEvent.keyDown(ungroup, { key: 'ArrowUp' });
    expect(rename).toHaveFocus();
  });

  it.each(['Archive', 'Trash'])(
    'keeps folder navigation counts tied to Parts on %s',
    (shelf) => {
      seedFolder(parts.map((part) => part.projectId));
      renderStartScreen({
        projects: parts.map((part, index) => ({
          ...part,
          organization: {
            ...part.organization!,
            status: index < 2 ? 'active' : index === 3 ? 'deleted' : 'archived'
          }
        }))
      });
      fireEvent.click(
        screen.getByRole('tab', { name: new RegExp(`^${shelf}`) })
      );
      expect(
        document.querySelector('.start-folder-link .start-shelf-count')
      ).toHaveTextContent('2');
      fireEvent.click(
        document.querySelector<HTMLButtonElement>('.start-folder-link')!
      );
      expect(names()).toEqual(['Alpha plate', 'Bravo plate']);
    }
  );

  it('clears the selection with Escape', () => {
    renderStartScreen({ projects: parts });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Alpha plate' })
    );
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('offers a reset and a copy for a sample opened before', () => {
    const demo = {
      key: 'bracket',
      projectId: toProjectId('proj_demo_mounting_bracket'),
      name: 'Demo · Mounting Bracket',
      tagline: 'L-bracket with boss and mounting holes',
      revisions: ['A — one', 'B — two', 'C — three'] as [string, string, string]
    };
    const edited: ProjectSummary = {
      projectId: demo.projectId,
      name: demo.name,
      revisionCount: 7,
      updatedAt: '2026-10-29T12:00:00.000Z'
    };
    const onResetDemo = vi.fn();
    const onDuplicate = vi.fn();
    const { rerender } = renderStartScreen({
      demos: [demo],
      projects: [localProject]
    });
    expect(
      screen.queryByRole('button', { name: /Reset Mounting Bracket/ })
    ).toBeNull();
    rerender(
      <StartScreen
        {...startScreenProps({
          demos: [demo],
          projects: [localProject, edited],
          onResetDemo,
          onDuplicate
        })}
      />
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Reset Mounting Bracket to the original'
      })
    );
    expect(onResetDemo).toHaveBeenCalledWith(demo, edited);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Save a copy of Mounting Bracket to your parts'
      })
    );
    expect(onDuplicate).toHaveBeenCalledWith(edited);
  });
});

describe('StartScreen selection edge cases', () => {
  const parts: ProjectSummary[] = ['Echo', 'Foxtrot'].map((name, index) => ({
    projectId: toProjectId(`project_${name.toLowerCase()}`),
    name: `${name} block`,
    revisionCount: 1,
    updatedAt: `2026-10-0${index + 1}T12:00:00.000Z`
  }));

  it('closes the Move menu on Escape before dropping the selection', () => {
    renderStartScreen({ projects: parts });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Echo block' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Move to' }));
    const item = screen.getByRole('menuitem', { name: 'New folder' });
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Move to folder' })).toBeNull();
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('hides the bar when a search hides every selected part', () => {
    renderStartScreen({ projects: parts });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Echo block' })
    );
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search parts' }), {
      target: { value: 'foxtrot' }
    });
    expect(screen.queryByRole('toolbar')).toBeNull();
    // The hidden pick does not carry onto the part still shown.
    expect(
      screen.getByRole('checkbox', { name: 'Select Foxtrot block' })
    ).toHaveAttribute('aria-checked', 'false');
  });
});

describe('StartScreen selection and dialogs', () => {
  afterEach(() => localStorage.clear());

  it('lets an open dialog take Escape without dropping the selection', async () => {
    const loadProperties = vi.fn().mockResolvedValue(null);
    renderStartScreen({ loadProperties });
    fireEvent.click(
      screen.getByRole('checkbox', { name: `Select ${localProject.name}` })
    );
    fireEvent.click(
      screen.getByRole('button', { name: `Actions for ${localProject.name}` })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Properties' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Project properties'
    });
    fireEvent.keyDown(
      within(dialog).getByRole('button', { name: 'Close project properties' }),
      { key: 'Escape' }
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
  });

  it('offers each folder part as a cover button, the current one pressed', async () => {
    const parts: ProjectSummary[] = ['Juliet', 'Kilo'].map((name) => ({
      projectId: toProjectId(`project_${name.toLowerCase()}`),
      name: `${name} plate`,
      revisionCount: 1,
      updatedAt: '2026-10-01T12:00:00.000Z'
    }));
    localStorage.setItem(
      'openzcad.library.folders.v1:device',
      JSON.stringify({
        folders: [
          {
            id: 'f1',
            name: 'Plates',
            projectIds: parts.map((part) => part.projectId),
            pinned: false,
            createdAt: ''
          }
        ]
      })
    );
    renderStartScreen({ projects: parts });
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for folder Plates' })
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Choose cover…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Cover for Plates'
    });
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(
      within(dialog).getByRole('button', {
        name: 'Use Juliet plate as the cover'
      })
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Use Kilo plate as the cover'
      })
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
