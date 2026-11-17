import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EncryptionState } from '../lib/e2ee/accountKeys';
import type * as KeysModule from '../lib/e2ee/accountKeys';
import { subscribeEncryptionState } from '../lib/e2ee/encryptionStateEvents';

const load = vi.hoisted(() => vi.fn());
vi.mock('../lib/e2ee/accountKeys', async (original) => ({
  ...(await original<typeof KeysModule>()),
  loadEncryption: load
}));
const { EncryptionSettings } = await import('./EncryptionSettings');

afterEach(() => {
  vi.clearAllMocks();
});

const fork = (message: string): EncryptionState => ({ kind: 'fork', message });

describe('Settings › Encryption reloads', () => {
  // Regression: opening Settings › Encryption and pressing Refresh each
  // announced an encryption-state change even when nothing changed. That
  // retired the page's encrypted-project clients and their verified caches,
  // so the shelf's next listing re-read every project's authority and
  // device lists, spending the account's shared read budget.
  it('announces a reload only when it found the account changed', async () => {
    const userId = 'user_reload';
    const announced = vi.fn();
    const stop = subscribeEncryptionState(userId, announced);
    load.mockResolvedValue(fork('The device list is older than pinned.'));

    render(<EncryptionSettings userId={userId} />);
    await screen.findByText(/The device list is older than pinned\./);
    // The first state this page has seen is announced.
    expect(announced).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(announced).toHaveBeenCalledTimes(1);

    load.mockResolvedValue(fork('The device list forked.'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    });
    await screen.findByText(/The device list forked\./);
    expect(announced).toHaveBeenCalledTimes(2);
    stop();
  });
});
