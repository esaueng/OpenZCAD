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
    expect(screen.getByText('not stored')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore Save b' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Branch Save b into a new project' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore Save a' }));
    expect(onRestoreCheckpoint).toHaveBeenCalledExactlyOnceWith(older);
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
});
