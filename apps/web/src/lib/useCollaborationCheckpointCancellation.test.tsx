import { act, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { listLocalSaveStateIds } from './localProjectStore';
import { setup, rejectedSave } from './collaborationCheckpointTestHarness';

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

it('cancels a held import promptly on a room change and never starts its late action', async () => {
  const clicked = createProjectDocument(
    'Departing held action',
    toUserId('owner')
  );
  const { action, resolve, loading } = held;
  action.mockResolvedValue(clicked);
  const hook = setup(clicked);
  let outcome = 'pending';
  const saving = hook.result.current.saveCheckpoint(
    clicked,
    'Cancelled milestone',
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
  await waitFor(() => expect(loading).toHaveBeenCalledOnce());
  hook.depart('project');
  const next = hook.read();
  try {
    await waitFor(() => expect(outcome).toBe('rejected'), { timeout: 1_000 });
    const error = await rejectedSave(saving);
    expect(error.message).toContain('The named save is stored on this device.');
    expect(hook.apply).not.toHaveBeenCalled();
    expect(hook.read()).toBe(next);
    expect(await listLocalSaveStateIds(clicked.projectId)).toHaveProperty(
      'size',
      1
    );
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
});
