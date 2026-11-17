import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { encryptionStateChanged } from './e2ee/encryptionStateEvents';
import { useLibraryFolderCloudSync } from './useLibraryFolderCloudSync';
import {
  allowKeySession,
  blockKeySession,
  getKeySessionRevision
} from './e2ee/keySession';

const sync = vi.hoisted(() => vi.fn());
vi.mock('./libraryFolderCloudSync', () => ({
  syncAccountLibraryFolders: sync
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  allowKeySession(getKeySessionRevision());
});

it('retries when a verified session becomes ready after the first library round', async () => {
  sync.mockResolvedValue(false);
  blockKeySession();
  const folders = { folders: [] };
  renderHook(() => useLibraryFolderCloudSync('session-ready-account', folders));
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

  act(() => {
    allowKeySession(getKeySessionRevision());
  });
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
});

it('shows the sealed shelf as soon as this account unlocks, without waiting for a poll or folder edit', async () => {
  let unlocked = false;
  let applied = false;
  sync.mockImplementation(async () => {
    if (unlocked) applied = true;
    return false;
  });
  const folders = { folders: [] };
  const { unmount } = renderHook(() =>
    useLibraryFolderCloudSync('unlocking-account', folders)
  );
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  expect(applied).toBe(false);

  act(() => {
    unlocked = true;
    encryptionStateChanged('another-account');
  });
  expect(applied).toBe(false);
  act(() => encryptionStateChanged('unlocking-account'));
  await waitFor(() => expect(applied).toBe(true));

  unmount();
  sync.mockClear();
  act(() => encryptionStateChanged('unlocking-account'));
  expect(sync).not.toHaveBeenCalled();
});
