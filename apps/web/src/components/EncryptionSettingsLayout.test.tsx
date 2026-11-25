import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRecoveryKey } from '@openzcad/crypto';
import type { AccountView, EncryptionState } from '../lib/e2ee/accountKeys';
import type * as KeysModule from '../lib/e2ee/accountKeys';

/**
 * Settings › Encryption after the L11 plan of 2026-11-25 (§6): a status
 * line without Refresh, action cards only when something needs doing, one
 * Unlock group, devices with a one-rotation clean-up, People, and Refresh
 * folded under Advanced. The panels with their own tests are stubs here.
 */

const load = vi.hoisted(() => vi.fn());
const removeDevices = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>()
);
vi.mock('../lib/e2ee/accountKeys', async (original) => ({
  ...(await original<typeof KeysModule>()),
  loadEncryption: load,
  removeDevices
}));
vi.mock('../lib/e2ee/projectRemovalStep', () => ({
  projectRemovalStep: () => ({ prepare: async () => undefined })
}));
vi.mock('./ProjectEncryptionPreference', () => ({
  ProjectEncryptionPreference: () => <div>Encrypt new projects stub</div>
}));
vi.mock('./ExistingProjectEncryption', () => ({
  ExistingProjectEncryption: () => null
}));
vi.mock('./EncryptedInvitations', () => ({
  EncryptedInvitations: () => null
}));
vi.mock('./EncryptedPinReset', () => ({ EncryptedPinRecovery: () => null }));
vi.mock('./AssistantAccessSettings', () => ({
  AssistantAccessSettings: () => <div>Assistant access stub</div>
}));
vi.mock('./StopProjectEncryption', () => ({
  StopProjectEncryption: () => null
}));
vi.mock('./EncryptedProjectRecovery', () => ({
  EncryptedProjectRecovery: () => null
}));
vi.mock('./EncryptionContacts', () => ({
  EncryptionContacts: () => <div>People stub</div>,
  OwnContactCode: () => <div>Your contact code stub</div>
}));
vi.mock('./encryption/ApprovalRequests', () => ({
  ApprovalRequests: ({ whenEmpty }: { whenEmpty?: unknown }) =>
    (whenEmpty as never) ?? null,
  PendingLinkNotice: () => null
}));

const { EncryptionSettings } = await import('./EncryptionSettings');

afterEach(() => {
  vi.clearAllMocks();
});

const DAY = 86_400_000;
const day = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

function readyAccount(): EncryptionState {
  const device = (deviceId: string, label: string, addedDaysAgo: number) => ({
    deviceId,
    label,
    addedAt: Date.now() - addedDaysAgo * DAY
  });
  const account = {
    userId: 'user_layout',
    generation: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    fingerprint: '1234',
    device: { deviceId: 'dev_self', label: 'Firefox on macOS' },
    deviceStatus: 'certified',
    unlocked: true,
    unlockError: null,
    approvedDevices: [],
    previous: [],
    wraps: [],
    list: {
      headHash: new Uint8Array(32),
      unlockTargets: [{ kind: 'recovery-key', targetId: 'rk_1', addedAt: 1 }],
      devices: [
        device('dev_self', 'Firefox on macOS', 100),
        device('dev_phone', 'Safari on iOS', 100),
        device('dev_old1', 'Old Chrome', 200),
        device('dev_old2', 'Old Edge', 200)
      ]
    },
    lastUsed: {
      since: day(120),
      devices: [
        { deviceId: 'dev_self', day: day(0) },
        { deviceId: 'dev_phone', day: day(2) },
        { deviceId: 'dev_old1', day: day(45) },
        { deviceId: 'dev_old2', day: day(90) }
      ]
    }
  } as unknown as AccountView;
  return { kind: 'ready', account };
}

describe('Settings › Encryption layout', () => {
  it('keeps the page quiet: status without Refresh, Refresh under Advanced', async () => {
    load.mockResolvedValue(readyAccount());
    render(<EncryptionSettings userId="user_layout" />);
    expect(await screen.findByText('Encryption is on')).toBeTruthy();
    expect(screen.getByText('Unlocked')).toBeTruthy();
    const advanced = screen
      .getByText('Advanced encryption settings')
      .closest('details')!;
    const refresh = screen.getByRole('button', {
      name: 'Refresh',
      hidden: true
    });
    // The only Refresh is the folded one.
    expect(advanced.contains(refresh)).toBe(true);
    expect(advanced.open).toBe(false);
    expect(within(advanced).getByText('Assistant access stub')).toBeTruthy();
    expect(within(advanced).getByText('Your contact code stub')).toBeTruthy();
    // One Unlock group: passkeys and the recovery key.
    expect(screen.getByRole('heading', { name: 'Unlock' })).toBeTruthy();
    expect(screen.getByText('Recovery key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add passkey' })).toBeTruthy();
    expect(screen.getByText('People stub')).toBeTruthy();
    // No permanent "Add a device" paragraph: a button opens the steps.
    expect(screen.queryByText(/choose Ask for approval/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a device' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a device' });
    expect(within(dialog).getByText(/Ask for approval/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await act(async () => {
      fireEvent.click(refresh);
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('removes every unused device with one authorization', async () => {
    const state = readyAccount();
    load.mockResolvedValue(state);
    removeDevices.mockResolvedValue(state);
    render(<EncryptionSettings userId="user_layout" />);
    const notice = (
      await screen.findByText('2 devices haven’t been used in 30 days.')
    ).parentElement!;
    fireEvent.click(
      within(notice).getByRole('button', { name: 'Remove them' })
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Remove 2 unused devices'
    });
    expect(within(dialog).getByText(/Old Chrome, Old Edge\./)).toBeTruthy();
    const recovery = await generateRecoveryKey();
    fireEvent.change(within(dialog).getByLabelText('Recovery key'), {
      target: { value: recovery.formatted }
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Remove devices' })
    );
    await waitFor(() => expect(removeDevices).toHaveBeenCalledOnce());
    const [, account, ids, authorization] = removeDevices.mock
      .calls[0] as unknown[];
    expect((account as AccountView).userId).toBe('user_layout');
    expect(ids).toEqual(['dev_old1', 'dev_old2']);
    expect(authorization).toBeInstanceOf(Uint8Array);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
