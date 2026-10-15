import { act } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  loadLocalSaveState,
  listLocalSaveStateIds,
  listLocalSaveStateCheckpoints
} from './localProjectStore';
import { setup, box, rejectedSave } from './collaborationCheckpointTestHarness';

// Each held-module scenario owns one permanent mock. Replacing a successful
// module factory in the rejection suite can make Vitest reuse real exports.
const held = vi.hoisted(() => {
  const action = vi.fn<() => Promise<ProjectDocument>>();
  let resolve!: (module: {
    saveCollaborationCheckpoint: typeof action;
  }) => void;
  const pending = new Promise<{ saveCollaborationCheckpoint: typeof action }>(
    (done) => {
      resolve = done;
    }
  );
  return { action, resolve, loading: vi.fn(() => pending) };
});
vi.mock('./collaborationCheckpoint', () => held.loading());

it('uses the named-save deadline for a held import and never starts its late action', async () => {
  const clicked = createProjectDocument('Held action', toUserId('owner'));
  const later = box(clicked, 'Buffered box');
  const { action, resolve, loading } = held;
  action.mockResolvedValue(clicked);
  const hook = setup(clicked);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let outcome = 'pending';
  const saving = hook.result.current.saveCheckpoint(
    clicked,
    'Deadline milestone',
    hook.options
  );
  const settled = saving.then(
    () => {
      outcome = 'resolved';
    },
    () => {
      outcome = 'rejected';
    }
  );
  hook.edit(later);
  try {
    await vi.waitFor(() => expect(loading).toHaveBeenCalledOnce());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(outcome).toBe('pending');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      // IndexedDB completes its real task queue after the deadline fires.
      await vi.waitFor(() => expect(outcome).toBe('rejected'));
    });
    expect(outcome).toBe('rejected');
    const error = await rejectedSave(saving);
    expect(error.message).toContain(
      'The room did not confirm the named save. Please retry.'
    );
    expect(error.message).toContain('The named save is stored on this device.');
    const local = (await listLocalSaveStateCheckpoints(clicked.projectId)).find(
      (point) => point.reason === 'Deadline milestone'
    )!;
    expect(hook.apply).not.toHaveBeenCalled();
    expect(local.reason).toBe('Deadline milestone');
    expect(
      (await loadLocalSaveState(clicked.projectId, local.checkpointId))?.nodes
    ).toEqual(clicked.nodes);
    expect(hook.read().nodes).toEqual(later.nodes);
    expect(
      hook.socket.sent.filter((frame) => frame.type === 'document').at(-1)
        ?.document?.nodes
    ).toEqual(later.nodes);
  } finally {
    resolve({ saveCollaborationCheckpoint: action });
    await act(async () => {
      await vi.dynamicImportSettled();
      await settled;
    });
    hook.unmount();
  }
  expect(action).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(await listLocalSaveStateIds(clicked.projectId)).toHaveProperty(
    'size',
    1
  );
});
