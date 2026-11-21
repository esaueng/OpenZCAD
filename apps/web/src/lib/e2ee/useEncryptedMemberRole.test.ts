import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  REFRESH_MS,
  refreshEncryptedMemberRole,
  useEncryptedMemberRole
} from './useEncryptedMemberRole';

const encryptedMemberRole = vi.hoisted(() => vi.fn());
vi.mock('./memberships', () => ({ encryptedMemberRole }));

// Testing Library's waitFor polls with setInterval, which these tests fake;
// vi.waitFor keeps real timers.
let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  encryptedMemberRole.mockResolvedValue('editor');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

async function mounted() {
  const hook = renderHook(() => useEncryptedMemberRole('project_role', true));
  await vi.waitFor(() => expect(hook.result.current).toBe('editor'));
  expect(encryptedMemberRole).toHaveBeenCalledTimes(1);
  return hook;
}

it('reads the role on the timer while the tab is visible', async () => {
  await mounted();
  act(() => {
    vi.advanceTimersByTime(REFRESH_MS);
  });
  await vi.waitFor(() => expect(encryptedMemberRole).toHaveBeenCalledTimes(2));
});

// Cost regression: a hidden tab read the role every 20 s (three account
// requests a minute per open tab) although nobody could edit there.
it('skips the timer while the tab is hidden', async () => {
  await mounted();
  act(() => setVisibility('hidden'));
  act(() => {
    vi.advanceTimersByTime(REFRESH_MS * 9);
  });
  await settle();
  expect(encryptedMemberRole).toHaveBeenCalledTimes(1);
});

it('reads a demotion once as soon as the tab is shown again', async () => {
  const hook = await mounted();
  act(() => setVisibility('hidden'));
  act(() => {
    vi.advanceTimersByTime(REFRESH_MS * 3);
  });
  encryptedMemberRole.mockResolvedValue('viewer');
  act(() => setVisibility('visible'));
  await vi.waitFor(() => expect(hook.result.current).toBe('viewer'));
  expect(encryptedMemberRole).toHaveBeenCalledTimes(2);
});

it('still reads on focus and on a refused write', async () => {
  await mounted();
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await vi.waitFor(() => expect(encryptedMemberRole).toHaveBeenCalledTimes(2));
  act(() => setVisibility('hidden'));
  act(() => refreshEncryptedMemberRole('project_role'));
  await vi.waitFor(() => expect(encryptedMemberRole).toHaveBeenCalledTimes(3));
});
