import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  SpaceMouseHub,
  type HidDeviceLike,
  type HidLike
} from '../lib/spaceMouse';
import { DEFAULT_SPACE_MOUSE_SETTINGS } from '@openzcad/shared';
import {
  SpaceMousePreferenceRows,
  SpaceMouseSettings
} from './SpaceMouseSettings';

function fakeDevice(): HidDeviceLike {
  const device = Object.assign(new EventTarget(), {
    opened: false,
    vendorId: 0x046d,
    productId: 0xc62b,
    productName: 'SpaceMouse Pro',
    collections: [{ usagePage: 0x01, usage: 0x08 }],
    open: vi.fn(async () => {
      device.opened = true;
    }),
    close: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined)
  });
  return device;
}

function fakeHid(device: HidDeviceLike): HidLike {
  return Object.assign(new EventTarget(), {
    getDevices: vi.fn(async () => []),
    requestDevice: vi.fn(async () => [device])
  });
}

describe('SpaceMouseSettings', () => {
  it('explains where WebHID is missing and offers no connection', () => {
    render(<SpaceMouseSettings hub={new SpaceMouseHub(null)} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Needs Chrome or Edge on a computer.'
    );
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('connects from the button, then offers to disconnect', async () => {
    const device = fakeDevice();
    const hub = new SpaceMouseHub(fakeHid(device));
    render(<SpaceMouseSettings hub={hub} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Connect a 3Dconnexion SpaceMouse.'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'SpaceMouse Pro moves the view, and every key works.'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    hub.dispose();
  });

  it('changes each preference and reverses a direction', async () => {
    const onChange = vi.fn();
    render(
      <SpaceMousePreferenceRows
        value={DEFAULT_SPACE_MOUSE_SETTINGS}
        onChange={onChange}
      />
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'One motion at a time' })
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SPACE_MOUSE_SETTINGS,
      dominantAxis: true
    });
    await userEvent.click(screen.getByRole('button', { name: 'Reverse zoom' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SPACE_MOUSE_SETTINGS,
      reversed: ['zoom']
    });
    await userEvent.click(
      screen.getByRole('radio', { name: 'The orbit point' })
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SPACE_MOUSE_SETTINGS,
      rotateAbout: 'orbit-point'
    });
    expect(
      screen.getByRole('spinbutton', { name: 'Rotation speed' })
    ).toHaveValue(100);
  });

  it('shows which directions are reversed', () => {
    render(
      <SpaceMousePreferenceRows
        value={{ ...DEFAULT_SPACE_MOUSE_SETTINGS, reversed: ['tilt'] }}
        onChange={vi.fn()}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Reverse tilt' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'Reverse spin' })
    ).toHaveAttribute('aria-pressed', 'false');
  });
});
