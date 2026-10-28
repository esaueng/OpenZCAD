import { afterEach, describe, expect, it, vi } from 'vitest';
import { eraseAccountWithKeyCleanup } from './accountErasure';
import { memoryDeviceStore } from './deviceStore';
import { SHELF_NAMES_PREFIX } from '../projectShelfNames';

const cleanup = vi.hoisted(() => ({
  removeMls: vi.fn(async () => {}),
  removeSharing: vi.fn(async () => {}),
  removeAuthority: vi.fn(async () => {})
}));
vi.mock('./mls/sessionStore', () => ({
  indexedDbMlsSessionStore: () => ({ deleteAccount: cleanup.removeMls })
}));
vi.mock('./shareWorkStore', () => ({
  shareWorkStore: () => ({ deleteAccount: cleanup.removeSharing })
}));
vi.mock('./projectAuthorityStore', () => ({
  projectAuthorityStore: () => ({ deleteAccount: cleanup.removeAuthority })
}));
const userId = 'user_erasure_names';
const cacheKey = SHELF_NAMES_PREFIX + userId;
const names = JSON.stringify([['proj_title', 'Verified title', '2026-10-28']]);
afterEach(() => {
  localStorage.removeItem(cacheKey);
  vi.clearAllMocks();
});

describe('erased account title cleanup', () => {
  it.each(['profile', 'all'])(
    'clears title hints synchronously for successful %s erasure',
    async (scope) => {
      localStorage.setItem(cacheKey, names);
      await eraseAccountWithKeyCleanup({
        userId,
        isCurrentSession: () => true,
        store: memoryDeviceStore(),
        erase: async () => ({ signedOut: true, scope }),
        onSignedOut: () => expect(localStorage.getItem(cacheKey)).toBeNull()
      });
      expect(localStorage.getItem(cacheKey)).toBeNull();
    }
  );

  it('still clears names when an independent key-store cleanup fails', async () => {
    localStorage.setItem(cacheKey, names);
    cleanup.removeMls.mockRejectedValueOnce(new Error('MLS cleanup failed'));
    await expect(
      eraseAccountWithKeyCleanup({
        userId,
        isCurrentSession: () => true,
        store: memoryDeviceStore(),
        erase: async () => ({ signedOut: true }),
        onSignedOut: () => {}
      })
    ).rejects.toThrow('MLS cleanup failed');
    expect(localStorage.getItem(cacheKey)).toBeNull();
    expect(cleanup.removeSharing).toHaveBeenCalledWith(userId);
  });

  it('retains names when the server erasure fails so the user can retry', async () => {
    localStorage.setItem(cacheKey, names);
    await expect(
      eraseAccountWithKeyCleanup({
        userId,
        isCurrentSession: () => true,
        store: memoryDeviceStore(),
        erase: async () => {
          throw new Error('erase unavailable');
        },
        onSignedOut: () => {}
      })
    ).rejects.toThrow('erase unavailable');
    expect(localStorage.getItem(cacheKey)).toBe(names);
    expect(cleanup.removeMls).not.toHaveBeenCalled();
  });
});
