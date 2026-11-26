import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { toProjectId, type ProjectSummary } from '@openzcad/shared';
import type { ComponentProps } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LibrarySelectionBar, StartScreen } from './StartScreen';

beforeAll(() => LibrarySelectionBar.preload());

vi.mock('./assistant/AssistantConsentSummary', () => ({
  AssistantConsentSummary: () => 'Checked elsewhere'
}));

function project(
  id: string,
  name: string,
  extra: Partial<ProjectSummary> = {}
) {
  return {
    projectId: toProjectId(id),
    name,
    revisionCount: 1,
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...extra
  } satisfies ProjectSummary;
}

const bracket = project('project_bracket', 'Bracket');
const gear = project('project_gear', 'Gear', {
  sharing: { role: 'owner', memberCount: 2 }
});
const old = project('project_old', 'Old plate', {
  organization: { status: 'archived', pinned: false, sortOrder: 0 }
});

function props(
  overrides: Partial<ComponentProps<typeof StartScreen>> = {}
): ComponentProps<typeof StartScreen> {
  return {
    compact: true,
    projects: [bracket, gear, old],
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
    signedIn: false,
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

afterEach(() => {
  sessionStorage.removeItem('openzcad.start.view');
  sessionStorage.removeItem('openzcad.start.scroll');
  sessionStorage.removeItem('openzcad.start.draft');
  vi.useRealTimers();
});

async function renderCompact(
  overrides: Partial<ComponentProps<typeof StartScreen>> = {}
) {
  const all = props(overrides);
  const view = render(<StartScreen {...all} />);
  await screen.findByRole('group', { name: 'Shelves' });
  return { ...view, props: all };
}

const tileOf = (name: string) =>
  document.querySelector<HTMLElement>(
    `.start-tile-project[data-tile-id="${
      [bracket, gear, old].find((entry) => entry.name === name)!.projectId
    }"]`
  )!;

/** A finger dragged across the row by `dx` pixels. */
function swipe(target: HTMLElement, dx: number, pointerType = 'touch') {
  const at = { clientX: 300, clientY: 200, pointerId: 7, isPrimary: true };
  fireEvent.pointerDown(target, { ...at, pointerType, button: 0 });
  for (const step of [0.25, 0.5, 0.75, 1]) {
    fireEvent.pointerMove(window, {
      ...at,
      pointerType,
      clientX: at.clientX + dx * step
    });
  }
  fireEvent.pointerUp(window, {
    ...at,
    pointerType,
    clientX: at.clientX + dx
  });
  // The click a released press makes.
  fireEvent.click(target);
}

describe('the compact library', () => {
  it('marks itself and the document compact, and only while it is', async () => {
    const { container, rerender } = await renderCompact();
    expect(container.querySelector('.start-screen')).toHaveAttribute(
      'data-shell',
      'compact'
    );
    expect(document.documentElement).toHaveAttribute('data-shell', 'compact');
    rerender(<StartScreen {...props({ compact: false })} />);
    expect(container.querySelector('.start-screen')).not.toHaveAttribute(
      'data-shell'
    );
    expect(document.documentElement).not.toHaveAttribute('data-shell');
    expect(screen.queryByRole('group', { name: 'Shelves' })).toBeNull();
  });

  it('switches shelves from the segmented control, Shared among them', async () => {
    await renderCompact();
    const shelves = within(screen.getByRole('group', { name: 'Shelves' }));
    expect(shelves.getByRole('button', { name: 'Projects' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(tileOf('Bracket')).not.toBeNull();

    fireEvent.click(shelves.getByRole('button', { name: 'Archive' }));
    expect(shelves.getByRole('button', { name: 'Archive' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /^Old plate/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Bracket/ })).toBeNull();

    fireEvent.click(shelves.getByRole('button', { name: 'Shared' }));
    expect(screen.getByRole('button', { name: /^Gear/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Bracket,/ })).toBeNull();

    // Left by way of another shelf, Shared does not come back with Projects.
    fireEvent.click(shelves.getByRole('button', { name: 'Trash' }));
    fireEvent.click(shelves.getByRole('button', { name: 'Projects' }));
    expect(shelves.getByRole('button', { name: 'Projects' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /^Bracket,/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /^Gear,/ })).toBeVisible();
  });

  it('searches from the field on top', async () => {
    await renderCompact();
    const search = screen.getByRole('searchbox', { name: 'Search projects' });
    fireEvent.change(search, { target: { value: 'gea' } });
    expect(screen.getByRole('button', { name: /^Gear,/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Bracket,/ })).toBeNull();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Clear search' })[0]!
    );
    expect(screen.getByRole('button', { name: /^Bracket,/ })).toBeVisible();
  });

  it('archives a row swiped left, as its action sheet does', async () => {
    const { props: shown } = await renderCompact();
    const row = tileOf('Bracket');
    swipe(row.querySelector('.start-tile-open')!, -200);
    expect(shown.onOpen).not.toHaveBeenCalled();
    const actions = within(
      await within(row).findByRole('group', { name: 'Row actions' })
    );
    expect(
      actions.getByRole('button', { name: 'Move Bracket to trash' })
    ).toBeVisible();
    fireEvent.click(actions.getByRole('button', { name: 'Archive Bracket' }));
    expect(shown.onMoveToShelf).toHaveBeenCalledWith(bracket, 'archived');

    // The tile's action sheet offers the same two.
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Gear' }));
    const menu = within(screen.getByRole('menu', { name: 'Actions for Gear' }));
    expect(menu.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
    expect(menu.getByRole('menuitem', { name: 'Move to trash' })).toBeVisible();
  });

  it('puts a swiped row back on a tap elsewhere, and opens nothing', async () => {
    const { props: shown } = await renderCompact();
    const row = tileOf('Bracket');
    swipe(row.querySelector('.start-tile-open')!, -200);
    await within(row).findByRole('group', { name: 'Row actions' });
    const elsewhere = tileOf('Gear').querySelector('.start-tile-open')!;
    fireEvent.pointerDown(elsewhere, {
      pointerType: 'touch',
      isPrimary: true,
      pointerId: 8
    });
    fireEvent.pointerUp(window, { pointerType: 'touch', pointerId: 8 });
    await waitFor(() =>
      expect(
        within(row).queryByRole('group', { name: 'Row actions' })
      ).toBeNull()
    );
    expect(shown.onMoveToShelf).not.toHaveBeenCalled();
  });

  it('leaves a short or mouse drag alone', async () => {
    const { props: shown } = await renderCompact();
    const row = tileOf('Bracket');
    swipe(row.querySelector('.start-tile-open')!, -20);
    expect(
      within(row).queryByRole('group', { name: 'Row actions' })
    ).toBeNull();
    swipe(row.querySelector('.start-tile-open')!, -200, 'mouse');
    expect(
      within(row).queryByRole('group', { name: 'Row actions' })
    ).toBeNull();
    expect(shown.onMoveToShelf).not.toHaveBeenCalled();
  });

  it('offers Restore and Delete forever on a trashed row', async () => {
    const trashed = project('project_trashed', 'Scrap', {
      organization: {
        status: 'deleted',
        pinned: false,
        sortOrder: 0,
        deletedAt: new Date().toISOString()
      }
    });
    const { props: shown } = await renderCompact({ projects: [trashed] });
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Shelves' })).getByRole(
        'button',
        { name: 'Trash' }
      )
    );
    const row = document.querySelector<HTMLElement>(
      '.start-tile-project[data-tile-id="project_trashed"]'
    )!;
    swipe(row.querySelector('.start-tile-open')!, -200);
    const actions = within(
      await within(row).findByRole('group', { name: 'Row actions' })
    );
    fireEvent.click(
      actions.getByRole('button', { name: 'Delete Scrap forever' })
    );
    expect(shown.onDeleteForever).toHaveBeenCalledWith(trashed);
  });

  it('picks a row held still, and shows the selection bar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { props: shown } = await renderCompact();
    const open = tileOf('Bracket').querySelector('.start-tile-open')!;
    fireEvent.pointerDown(open, {
      pointerType: 'touch',
      isPrimary: true,
      pointerId: 9,
      clientX: 100,
      clientY: 100
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerUp(window, { pointerType: 'touch', pointerId: 9 });
    fireEvent.click(open);
    expect(shown.onOpen).not.toHaveBeenCalled();
    expect(
      screen.getByRole('checkbox', { name: 'Select Bracket' })
    ).toHaveAttribute('aria-checked', 'true');
  });
});
