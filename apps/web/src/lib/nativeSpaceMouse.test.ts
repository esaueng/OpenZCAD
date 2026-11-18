import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeSpaceMouseHid } from './nativeSpaceMouse';
import { SpaceMouseHub } from './spaceMouse';

type Bridge = NonNullable<Parameters<typeof nativeSpaceMouseHid>[0]>;

function fixture() {
  let receive: Parameters<Bridge['listen']>[0] | undefined;
  const stop = vi.fn();
  const enable = vi.fn<Bridge['enable']>(async () => {});
  const hid = nativeSpaceMouseHid({
    async listen(listener) {
      receive = listener;
      return stop;
    },
    enable
  });
  const hub = new SpaceMouseHub(hid);
  return {
    hub,
    enable,
    stop,
    emit: (report: Parameters<NonNullable<typeof receive>>[0]) =>
      receive?.(report)
  };
}

afterEach(() => vi.useRealTimers());

describe('native SpaceMouse adapter', () => {
  it('starts capture only on Connect, routes hardware reports, and gives it up on Disconnect', async () => {
    vi.useFakeTimers();
    const { hub, enable, stop, emit } = fixture();
    const motion = vi.fn<Parameters<SpaceMouseHub['subscribeMotion']>[0]>();
    const buttons = vi.fn();
    hub.subscribeMotion(motion);
    hub.subscribeButtons(buttons);
    await hub.restore();
    expect(enable).not.toHaveBeenCalled();
    await hub.connect();
    expect(enable).toHaveBeenCalledExactlyOnceWith(true);
    expect(hub.getStatus()).toMatchObject({ state: 'connected' });

    // The native reader sends the same translation and Fit reports as WebHID.
    emit({ kind: 'input', value: [1, 100, 0, 0, 0, 0, 0] });
    expect(motion.mock.lastCall?.[0].tx).not.toBe(0);
    emit({ kind: 'input', value: [3, 2, 0, 0, 0] });
    expect(buttons.mock.lastCall?.[0]).toMatchObject({
      button: 1,
      pressed: true
    });
    emit({ kind: 'reset' });
    expect(motion.mock.lastCall?.[0].tx).toBe(0);
    expect(buttons.mock.lastCall?.[0]).toMatchObject({
      button: 1,
      pressed: false
    });

    await hub.disconnect();
    expect(enable).toHaveBeenLastCalledWith(false);
    expect(stop).toHaveBeenCalledOnce();
    hub.dispose();
  });

  it('stops a held axis when its heartbeat disappears', async () => {
    vi.useFakeTimers();
    const { hub, emit } = fixture();
    const motion = vi.fn<Parameters<SpaceMouseHub['subscribeMotion']>[0]>();
    hub.subscribeMotion(motion);
    await hub.connect();
    emit({ kind: 'input', value: [1, 100, 0, 0, 0, 0, 0] });
    await vi.advanceTimersByTimeAsync(100);
    emit({ kind: 'input', value: [1, 100, 0, 0, 0, 0, 0] });
    await vi.advanceTimersByTimeAsync(100);
    expect(motion.mock.lastCall?.[0].tx).not.toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(motion.mock.lastCall?.[0].tx).toBe(0);
    await hub.disconnect();
    hub.dispose();
  });

  it('releases its listener when native capture fails and lets the user retry', async () => {
    const { hub, enable, stop } = fixture();
    enable.mockRejectedValueOnce(new Error('Device is busy'));
    await hub.connect();
    expect(hub.getStatus()).toEqual({
      state: 'error',
      message: 'Device is busy'
    });
    expect(stop).toHaveBeenCalledOnce();
    await hub.connect();
    expect(hub.getStatus()).toMatchObject({ state: 'connected' });
    await hub.disconnect();
    hub.dispose();
  });
  it('shows a failed recapture and lets the user reconnect', async () => {
    const { hub, emit, enable, stop } = fixture();
    await hub.connect();
    emit({ kind: 'error', value: 'Wired SpaceMouse Pro is busy' });
    expect(stop).toHaveBeenCalledOnce();
    expect(hub.getStatus()).toEqual({
      state: 'error',
      message: 'Wired SpaceMouse Pro is busy'
    });
    await hub.connect();
    expect(enable).toHaveBeenCalledTimes(2);
    expect(hub.getStatus()).toMatchObject({ state: 'connected' });
    await hub.disconnect();
  });
});
