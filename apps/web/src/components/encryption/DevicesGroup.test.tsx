import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AccountView, E2eeContext } from '../../lib/e2ee/accountKeys';
import { AddDeviceDialog, DevicesGroup } from './DevicesGroup';
import {
  daysSince,
  orderDevices,
  staleDeviceIds,
  usedText
} from './deviceActivity';

/**
 * Settings › Encryption › Devices after the L11 plan of 2026-11-25 (§6):
 * last used, this device first, three at a time, and one clean-up of every
 * device nobody used for 30 days.
 */

const NOW = Date.parse('2026-11-25T12:00:00Z');
const DAY = 86_400_000;

function account(
  devices: { id: string; label: string; addedDaysAgo: number }[],
  lastUsed: Record<string, string> | null,
  since: string | null = '2026-09-01'
): AccountView {
  return {
    userId: 'user_alice',
    device: { deviceId: 'dev_self' },
    deviceStatus: 'certified',
    unlocked: true,
    approvedDevices: [],
    list: {
      devices: devices.map((device) => ({
        deviceId: device.id,
        label: device.label,
        addedAt: NOW - device.addedDaysAgo * DAY
      })),
      unlockTargets: []
    },
    lastUsed: lastUsed
      ? {
          since,
          devices: Object.entries(lastUsed).map(([deviceId, day]) => ({
            deviceId,
            day
          }))
        }
      : null
  } as unknown as AccountView;
}

const ELEVEN = account(
  [
    { id: 'dev_a', label: 'Old Chrome', addedDaysAgo: 300 },
    { id: 'dev_b', label: 'Safari on iOS', addedDaysAgo: 200 },
    { id: 'dev_self', label: 'Firefox on macOS', addedDaysAgo: 100 },
    { id: 'dev_c', label: 'Chrome on macOS', addedDaysAgo: 90 },
    { id: 'dev_d', label: 'Edge', addedDaysAgo: 80 },
    { id: 'dev_e', label: 'Never seen, new', addedDaysAgo: 3 }
  ],
  {
    dev_self: '2026-11-25',
    dev_b: '2026-11-23',
    dev_c: '2026-11-20',
    dev_a: '2026-08-01',
    dev_d: '2026-10-25'
  }
);

describe('device activity', () => {
  it('counts whole UTC days', () => {
    expect(daysSince('2026-11-25', NOW)).toBe(0);
    expect(daysSince('2026-11-24', NOW)).toBe(1);
    expect(daysSince('2026-10-26', NOW)).toBe(30);
    expect(usedText('2026-11-25', NOW)).toBe('Used today');
    expect(usedText('2026-11-24', NOW)).toBe('Used yesterday');
    expect(usedText('2026-11-20', NOW)).toBe('Used 5 days ago');
    expect(usedText(undefined, NOW)).toBeNull();
  });

  it('orders this device first, then the most recently used', () => {
    expect(orderDevices(ELEVEN).map((d) => d.deviceId)).toEqual([
      'dev_self',
      'dev_b',
      'dev_c',
      'dev_d',
      'dev_a',
      'dev_e'
    ]);
  });

  it('offers devices unused for 30 days, never this device', () => {
    // dev_d is exactly 31 days ago; dev_e has no day but is new.
    expect(staleDeviceIds(ELEVEN, NOW)).toEqual(['dev_a', 'dev_d']);
    const self = account([{ id: 'dev_self', label: 'Me', addedDaysAgo: 400 }], {
      dev_self: '2026-01-01'
    });
    expect(staleDeviceIds(self, NOW)).toEqual([]);
  });

  it('counts a device with no day only once days were recorded for 30 days', () => {
    const devices = [
      { id: 'dev_self', label: 'Me', addedDaysAgo: 400 },
      { id: 'dev_old', label: 'Old', addedDaysAgo: 400 },
      { id: 'dev_new', label: 'New', addedDaysAgo: 10 }
    ];
    expect(
      staleDeviceIds(account(devices, { dev_self: '2026-11-25' }), NOW)
    ).toEqual(['dev_old']);
    // Recording began a week ago: the old device may simply not have
    // opened the app since, so it is not called unused.
    expect(
      staleDeviceIds(
        account(devices, { dev_self: '2026-11-25' }, '2026-11-18'),
        NOW
      )
    ).toEqual([]);
    // An older Worker reports no days at all.
    expect(staleDeviceIds(account(devices, null), NOW)).toEqual([]);
  });
});

describe('DevicesGroup', () => {
  it('lists three devices with last used, and Show all for the rest', () => {
    render(
      <DevicesGroup
        account={ELEVEN}
        certified
        busy={false}
        now={NOW}
        onAddDevice={vi.fn()}
        onRemove={vi.fn()}
        onRemoveStale={vi.fn()}
      />
    );
    expect(screen.getByText('6 devices')).toBeTruthy();
    const titles = () =>
      [...document.querySelectorAll('.setting-title')].map(
        (node) => node.textContent
      );
    expect(titles()).toEqual([
      'Firefox on macOS',
      'Safari on iOS',
      'Chrome on macOS'
    ]);
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.getByText(/^Used 2 days ago · added/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 6' }));
    expect(titles()).toHaveLength(6);
    expect(screen.getByText(/^Added /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(titles()).toHaveLength(3);
  });

  it('removes every unused device in one go', () => {
    const onRemoveStale = vi.fn();
    render(
      <DevicesGroup
        account={ELEVEN}
        certified
        busy={false}
        now={NOW}
        onAddDevice={vi.fn()}
        onRemove={vi.fn()}
        onRemoveStale={onRemoveStale}
      />
    );
    const notice = screen.getByText(
      '2 devices haven’t been used in 30 days.'
    ).parentElement!;
    fireEvent.click(
      within(notice).getByRole('button', { name: 'Remove them' })
    );
    expect(onRemoveStale).toHaveBeenCalledOnce();
    const [removed] = onRemoveStale.mock.calls[0] as [{ deviceId: string }[]];
    expect(removed.map((device) => device.deviceId)).toEqual([
      'dev_a',
      'dev_d'
    ]);
  });

  it('shows no clean-up while nothing is unused', () => {
    render(
      <DevicesGroup
        account={account(
          [
            { id: 'dev_self', label: 'Me', addedDaysAgo: 100 },
            { id: 'dev_b', label: 'Phone', addedDaysAgo: 100 }
          ],
          { dev_self: '2026-11-25', dev_b: '2026-11-01' }
        )}
        certified
        busy={false}
        now={NOW}
        onAddDevice={vi.fn()}
        onRemove={vi.fn()}
        onRemoveStale={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Remove them' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('offers no adding or removing on a locked device', () => {
    render(
      <DevicesGroup
        account={ELEVEN}
        certified={false}
        busy={false}
        now={NOW}
        onAddDevice={vi.fn()}
        onRemove={vi.fn()}
        onRemoveStale={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Add a device' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('opens Add a device from the header', () => {
    const onAddDevice = vi.fn();
    render(
      <DevicesGroup
        account={ELEVEN}
        certified
        busy={false}
        now={NOW}
        onAddDevice={onAddDevice}
        onRemove={vi.fn()}
        onRemoveStale={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(onAddDevice).toHaveBeenCalledOnce();
  });
});

describe('AddDeviceDialog', () => {
  it('shows the steps and waits for the new device to ask', async () => {
    const ctx = {
      userId: 'user_alice',
      api: { listApprovals: vi.fn(async () => ({ approvals: [] })) }
    } as unknown as E2eeContext;
    const onClose = vi.fn();
    render(
      <AddDeviceDialog
        ctx={ctx}
        busy={false}
        run={vi.fn(async () => true)}
        account={ELEVEN}
        passkey={false}
        onAuthorize={vi.fn()}
        onClose={onClose}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Add a device' });
    expect(within(dialog).getByText(/Ask for approval/)).toBeTruthy();
    expect(
      within(dialog).getByText('Waiting for the new device to ask…')
    ).toBeTruthy();
    expect(ctx.api.listApprovals).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
