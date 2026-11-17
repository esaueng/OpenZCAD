import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  act,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectDocument,
  createSavedRevision
} from '@openzcad/document-core';
import { toUserId, type ProjectCheckpoint } from '@openzcad/shared';
import { saveLocalSaveStates } from '../../lib/localProjectStore';
import {
  RevisionsPanel,
  revisionCount,
  useRevisionCheckpoints,
  type RevisionCheckpoints
} from './RevisionsPanel';

function checkpoint(id: string, documentVersion: number): ProjectCheckpoint {
  return {
    checkpointId: id,
    revisionId: `rev-${id}`,
    documentVersion,
    createdAt: new Date(2025, 0, documentVersion).toISOString(),
    reason: `Save ${id}`
  } as ProjectCheckpoint;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RevisionsPanel', () => {
  it('has nothing to show without a save point', () => {
    const { result } = renderHook(() =>
      useRevisionCheckpoints({
        checkpoints: [],
        restorableCheckpointIds: new Set()
      })
    );
    expect(result.current.visible).toEqual([]);
    expect(revisionCount(result.current)).toBe(0);
    // Opened from the rail anyway, the panel says why it is empty.
    const { container } = render(
      <RevisionsPanel
        documentVersion={1}
        restorableCheckpointIds={new Set()}
        onRestoreCheckpoint={vi.fn()}
        onBranchCheckpoint={vi.fn()}
        revisions={result.current}
      />
    );
    expect(container.querySelector('.revision-row')).toBeNull();
    expect(container).toHaveTextContent('No save points yet.');
  });

  it('lists the newest first and offers only what is stored and not current', async () => {
    const user = userEvent.setup();
    const older = checkpoint('a', 1);
    const current = checkpoint('b', 2);
    const unstored = checkpoint('c', 3);
    const revisions: RevisionCheckpoints = {
      visible: [older, current, unstored],
      canonicalIds: new Set(['a', 'b', 'c']),
      local: []
    };
    const onRestoreCheckpoint = vi.fn();
    const { container } = render(
      <RevisionsPanel
        documentVersion={2}
        restorableCheckpointIds={new Set(['a', 'b'])}
        onRestoreCheckpoint={onRestoreCheckpoint}
        onBranchCheckpoint={vi.fn()}
        revisions={revisions}
      />
    );
    expect(revisionCount(revisions)).toBe(3);
    const reasons = [...container.querySelectorAll('.revision-reason')].map(
      (reason) => reason.textContent
    );
    expect(reasons).toEqual(['Save c', 'Save b', 'Save a']);
    expect(container.querySelector('.revision-row')).toHaveClass('latest');
    expect(screen.getByText('history only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore Save b' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Branch Save b into a new project' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore Save a' }));
    expect(onRestoreCheckpoint).toHaveBeenCalledExactlyOnceWith(older);
  });

  // Design review I82/I87: a press on a row did nothing, Restore and Branch
  // were hover-only icons, and "not stored" was explained only in a title.
  it('opens a row to show its details and labelled actions without hover', async () => {
    const user = userEvent.setup();
    const older = checkpoint('a', 1);
    const unstored = checkpoint('c', 3);
    const onBranchCheckpoint = vi.fn();
    const { container } = render(
      <RevisionsPanel
        documentVersion={9}
        restorableCheckpointIds={new Set(['a'])}
        onRestoreCheckpoint={vi.fn()}
        onBranchCheckpoint={onBranchCheckpoint}
        revisions={{
          visible: [older, unstored],
          canonicalIds: new Set(['a', 'c']),
          local: []
        }}
      />
    );
    expect(container.querySelector('[title]')).toBeNull();
    const row = screen.getByRole('button', { name: 'Save a' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.revision-row.is-open')).toHaveTextContent(
      'Restore brings the project back to it'
    );
    expect(
      screen.getByRole('button', { name: 'Restore Save a' })
    ).toHaveTextContent('Restore');
    const branch = screen.getByRole('button', {
      name: 'Branch Save a into a new project'
    });
    expect(branch).toHaveTextContent('Branch');
    // Its actions act; they do not close the row.
    await user.click(branch);
    expect(onBranchCheckpoint).toHaveBeenCalledExactlyOnceWith(older);
    expect(row).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('button', { name: 'Save c' }));
    expect(
      screen.getByText(/Listed in the project’s history only/)
    ).toBeVisible();
  });

  it('merges the save states stored on this device', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const document = createProjectDocument('Local', toUserId('owner'));
    const { result } = renderHook(() =>
      useRevisionCheckpoints({
        projectId: document.projectId,
        checkpoints: [],
        restorableCheckpointIds: new Set()
      })
    );
    expect(revisionCount(result.current)).toBe(0);
    const saved = createSavedRevision(document, 'Device milestone');
    await act(async () => {
      await saveLocalSaveStates([saved]);
    });
    await waitFor(() => expect(revisionCount(result.current)).toBe(1));
    expect(result.current.visible[0]?.reason).toBe('Device milestone');
    expect(result.current.canonicalIds.size).toBe(0);
    expect(result.current.local).toEqual(result.current.visible);
  });
  it('shows the L03 columns: a renamed save, its editor, device and storage', async () => {
    const user = userEvent.setup();
    const mine = {
      ...checkpoint('a', 1),
      name: 'Release candidate',
      author: { userId: 'user_me', name: 'Ada', device: 'Chrome on macOS' }
    };
    const theirs = {
      ...checkpoint('b', 2),
      author: { userId: 'user_other', name: 'Grace', device: 'Safari on iOS' }
    };
    const older = checkpoint('c', 3);
    const onRenameCheckpoint = vi.fn();
    const { container } = render(
      <RevisionsPanel
        documentVersion={9}
        restorableCheckpointIds={new Set(['a', 'b'])}
        accountCheckpointIds={new Set(['a', 'b'])}
        currentUserId="user_me"
        onRestoreCheckpoint={vi.fn()}
        onBranchCheckpoint={vi.fn()}
        onRenameCheckpoint={onRenameCheckpoint}
        revisions={{
          visible: [mine, theirs, older],
          canonicalIds: new Set(['a', 'b', 'c']),
          local: [mine]
        }}
      />
    );
    const rows = [...container.querySelectorAll('.revision-row')];
    // Newest first: older (c), theirs (b), mine (a).
    expect(rows[2]?.querySelector('.revision-reason')).toHaveTextContent(
      'Release candidate'
    );
    expect(rows[2]?.querySelector('.revision-meta')).toHaveTextContent(
      'You · Chrome on macOS · Device and account'
    );
    expect(rows[1]?.querySelector('.revision-meta')).toHaveTextContent(
      'Grace · Safari on iOS · Account'
    );
    // A save from before authors were recorded shows only its storage.
    expect(rows[0]?.querySelector('.revision-editor')).toBeNull();
    expect(rows[0]?.querySelector('.revision-sync')).toHaveTextContent(
      'Not stored'
    );
    // The original name stays in the details.
    await user.click(screen.getByRole('button', { name: 'Release candidate' }));
    expect(rows[2]?.querySelector('.revision-details')).toHaveTextContent(
      'Saved as “Save a”'
    );
    // Rename in place: Escape keeps the name, Save renames.
    await user.click(
      screen.getByRole('button', { name: 'Rename Release candidate' })
    );
    const input = screen.getByRole('textbox', {
      name: 'Name for Release candidate'
    });
    await user.keyboard('{Escape}');
    expect(onRenameCheckpoint).not.toHaveBeenCalled();
    expect(input).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Rename Release candidate' })
    );
    const field = screen.getByRole('textbox', {
      name: 'Name for Release candidate'
    });
    await user.clear(field);
    await user.type(field, 'Shipped{Enter}');
    expect(onRenameCheckpoint).toHaveBeenCalledWith(mine, 'Shipped');
  });

  it('offers no rename where the project cannot be edited, or for a device-only save', async () => {
    const user = userEvent.setup();
    const deviceOnly = checkpoint('d', 1);
    const { rerender } = render(
      <RevisionsPanel
        documentVersion={9}
        restorableCheckpointIds={new Set()}
        onRestoreCheckpoint={vi.fn()}
        onBranchCheckpoint={vi.fn()}
        onRenameCheckpoint={vi.fn()}
        revisions={{
          visible: [deviceOnly],
          canonicalIds: new Set(),
          local: [deviceOnly]
        }}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Save d' }));
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull();
    rerender(
      <RevisionsPanel
        documentVersion={9}
        restorableCheckpointIds={new Set()}
        onRestoreCheckpoint={vi.fn()}
        onBranchCheckpoint={vi.fn()}
        revisions={{
          visible: [deviceOnly],
          canonicalIds: new Set(['d']),
          local: [deviceOnly]
        }}
      />
    );
    expect(screen.queryByRole('button', { name: /^Rename/ })).toBeNull();
  });
  it('previews a stored save that is not the current one, and marks it', async () => {
    const user = userEvent.setup();
    const older = checkpoint('a', 1);
    const current = checkpoint('b', 2);
    const unstored = checkpoint('c', 3);
    const onPreviewCheckpoint = vi.fn();
    const revisions = {
      visible: [older, current, unstored],
      canonicalIds: new Set(['a', 'b', 'c']),
      local: []
    };
    const { container, rerender } = render(
      <RevisionsPanel
        documentVersion={2}
        restorableCheckpointIds={new Set(['a', 'b'])}
        onRestoreCheckpoint={vi.fn()}
        onBranchCheckpoint={vi.fn()}
        onPreviewCheckpoint={onPreviewCheckpoint}
        revisions={revisions}
      />
    );
    // Only the stored save that is not what the project already shows.
    expect(screen.getAllByRole('button', { name: /^Preview/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Preview Save a' }));
    expect(onPreviewCheckpoint).toHaveBeenCalledWith(older);
    rerender(
      <RevisionsPanel
        documentVersion={2}
        restorableCheckpointIds={new Set(['a', 'b'])}
        onRestoreCheckpoint={vi.fn()}
        onBranchCheckpoint={vi.fn()}
        onPreviewCheckpoint={onPreviewCheckpoint}
        previewingCheckpointId="a"
        revisions={revisions}
      />
    );
    expect(
      container.querySelector('.revision-row.is-previewing')
    ).toHaveTextContent('Save a');
    expect(screen.queryByRole('button', { name: 'Preview Save a' })).toBeNull();
  });
  it('shows this device’s card for a save point in its details', async () => {
    const user = userEvent.setup();
    const saved = checkpoint('a', 1);
    const plain = checkpoint('b', 2);
    render(
      <RevisionsPanel
        documentVersion={9}
        restorableCheckpointIds={new Set(['a', 'b'])}
        onRestoreCheckpoint={vi.fn()}
        onBranchCheckpoint={vi.fn()}
        revisions={{
          visible: [saved, plain],
          canonicalIds: new Set(['a', 'b']),
          local: [],
          thumbnails: new Map([['a', 'data:image/webp;base64,AAAA']])
        }}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Save a' }));
    expect(
      screen.getByRole('img', { name: 'The model at Save a' })
    ).toHaveAttribute('src', 'data:image/webp;base64,AAAA');
    await user.click(screen.getByRole('button', { name: 'Save b' }));
    expect(
      screen.queryByRole('img', { name: 'The model at Save b' })
    ).toBeNull();
  });
});
