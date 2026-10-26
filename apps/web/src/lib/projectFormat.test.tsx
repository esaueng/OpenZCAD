import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { setMigratingProjects } from './migrationStatus';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  SUPPORTED_PROJECT_FORMATS,
  toArtifactId,
  toProjectId,
  type ProjectSummary
} from '@openzcad/shared';
import { StartScreen } from '../components/StartScreen';
import {
  mergeProjectSummaries,
  PROJECT_UPDATE_REQUIRED_LABEL,
  projectNeedsUpdate,
  resolveShelfThumbnail
} from './projectShelf';

const encrypted: ProjectSummary = {
  projectId: toProjectId('proj_encrypted'),
  name: 'Encrypted project',
  revisionCount: 2,
  updatedAt: '2026-10-24T12:00:00.000Z',
  storageFormat: 2,
  thumbnailArtifactId: toArtifactId('artifact_thumb')
};
/** A format a later build may add: this one must lock it. */
const future: ProjectSummary = {
  ...encrypted,
  projectId: toProjectId('proj_future'),
  name: 'Future project',
  storageFormat: 3
};
const plaintext: ProjectSummary = {
  projectId: toProjectId('proj_plain'),
  name: 'Plain bracket',
  revisionCount: 1,
  updatedAt: '2026-10-24T11:00:00.000Z'
};

function props(
  overrides: Partial<ComponentProps<typeof StartScreen>> = {}
): ComponentProps<typeof StartScreen> {
  return {
    projects: [future, encrypted, plaintext],
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
    cloudProjectIds: new Set([
      future.projectId,
      encrypted.projectId,
      plaintext.projectId
    ]),
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

/**
 * ADR-024 Phase 4: this build opens storage formats 1 and 2 (slice 4-5). A
 * project in a format it does not know is locked and says to update; a
 * format-2 (end-to-end encrypted) project opens, marked encrypted, and is
 * duplicated like any other (slice 4-8).
 */
describe('storage formats on the shelf', () => {
  it('this build opens plaintext and encrypted projects', () => {
    expect(SUPPORTED_PROJECT_FORMATS).toEqual([1, 2]);
    expect(projectNeedsUpdate(encrypted)).toBe(false);
    expect(projectNeedsUpdate(plaintext)).toBe(false);
    expect(projectNeedsUpdate(future)).toBe(true);
    expect(projectNeedsUpdate({ storageFormat: 1 })).toBe(false);
    // A build without format 2 locks it.
    expect(projectNeedsUpdate(encrypted, [1])).toBe(true);
  });

  it('opens an encrypted card, marked encrypted and with copies (4-8)', () => {
    const shelf = props();
    render(<StartScreen {...shelf} />);
    const card = screen
      .getByText('Encrypted project')
      .closest('.start-tile-project') as HTMLElement;
    expect(
      within(card).getByRole('img', { name: 'End-to-end encrypted' })
    ).toBeTruthy();
    fireEvent.click(within(card).getByText('Encrypted project'));
    expect(shelf.onOpen).toHaveBeenCalledWith(encrypted.projectId);
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Actions for Encrypted project'
      })
    );
    const menu = screen.getByRole('menu', {
      name: 'Actions for Encrypted project'
    });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }));
    expect(shelf.onDuplicate).toHaveBeenCalledWith(encrypted);
  });

  it('shows a locked card that says to update and opens nothing', () => {
    const shelf = props();
    render(<StartScreen {...shelf} />);
    const card = screen
      .getByText(PROJECT_UPDATE_REQUIRED_LABEL)
      .closest('.start-tile-project') as HTMLElement;
    expect(card).toBeTruthy();
    expect(
      within(card).getByRole('img', { name: 'End-to-end encrypted' })
    ).toBeTruthy();
    // No preview is fetched for it.
    expect(shelf.loadThumbnail).not.toHaveBeenCalledWith(future);
    expect(card.querySelector('button.start-tile-open')).toBeNull();
    fireEvent.click(within(card).getByText('Future project'));
    expect(shelf.onOpen).not.toHaveBeenCalled();
    // Only shelf actions are offered: no properties, copy or account save.
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Actions for Future project'
      })
    );
    const menu = screen.getByRole('menu', {
      name: 'Actions for Future project'
    });
    expect(
      within(menu).queryByRole('menuitem', { name: 'Properties' })
    ).toBeNull();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Duplicate' })
    ).toBeNull();
    expect(
      within(menu).getByRole('menuitem', { name: 'Archive' })
    ).toBeTruthy();
    expect(
      within(menu).getByRole('menuitem', { name: 'Move to trash' })
    ).toBeTruthy();
  });

  it('still opens a plaintext card', () => {
    const shelf = props();
    render(<StartScreen {...shelf} />);
    fireEvent.click(screen.getByText('Plain bracket'));
    expect(shelf.onOpen).toHaveBeenCalledWith(plaintext.projectId);
  });

  it('never resolves a preview for a locked project', async () => {
    const host = {
      loadCached: vi.fn().mockResolvedValue({
        projectId: encrypted.projectId,
        source: 'data:image/png;base64,AA',
        version: 1,
        updatedAt: encrypted.updatedAt
      }),
      download: vi.fn().mockResolvedValue('blob:x')
    };
    await expect(resolveShelfThumbnail(future, host)).resolves.toBe(undefined);
    expect(host.loadCached).not.toHaveBeenCalled();
    expect(host.download).not.toHaveBeenCalled();
  });

  it('keeps the account’s format over an older device record', () => {
    const device: ProjectSummary = {
      ...encrypted,
      name: 'Bracket',
      storageFormat: undefined,
      updatedAt: '2026-10-25T00:00:00.000Z'
    };
    const [merged] = mergeProjectSummaries([device], [encrypted]);
    expect(merged).toMatchObject({ name: 'Bracket', storageFormat: 2 });
  });
});

/**
 * ADR-024 Phase 7, slice 7-2: a plaintext project this tab is encrypting
 * carries a lock badge until the engine is done with it.
 */
describe('a project being encrypted', () => {
  it('shows a lock badge while it migrates, and none once it stopped', () => {
    setMigratingProjects([plaintext.projectId]);
    const { unmount } = render(<StartScreen {...props()} />);
    const card = screen
      .getByText(plaintext.name)
      .closest('.start-tile-project') as HTMLElement;
    expect(within(card).getByRole('img', { name: 'Encrypting' })).toBeTruthy();
    // The encrypted card is not marked as migrating.
    const other = screen
      .getByText('Encrypted project')
      .closest('.start-tile-project') as HTMLElement;
    expect(within(other).queryByRole('img', { name: 'Encrypting' })).toBeNull();
    act(() => setMigratingProjects([]));
    expect(within(card).queryByRole('img', { name: 'Encrypting' })).toBeNull();
    unmount();
  });

  it('keeps the badge while a paused or stopped staging locks it', () => {
    // Not in progress, but its plaintext stays locked: it opens read-only.
    setMigratingProjects([], [plaintext.projectId]);
    const { unmount } = render(<StartScreen {...props()} />);
    const card = screen
      .getByText(plaintext.name)
      .closest('.start-tile-project') as HTMLElement;
    expect(within(card).getByRole('img', { name: 'Encrypting' })).toBeTruthy();
    act(() => setMigratingProjects([]));
    expect(within(card).queryByRole('img', { name: 'Encrypting' })).toBeNull();
    unmount();
  });
});
