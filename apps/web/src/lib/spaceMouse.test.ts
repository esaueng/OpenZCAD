import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPACE_MOUSE_SETTINGS } from '@openzcad/shared';
import {
  SPACE_MOUSE_BUTTON,
  SPACE_MOUSE_HID_FILTERS,
  type SixDofAxes
} from '@openzcad/viewport/space-mouse';
import {
  SpaceMouseHub,
  isSpaceMouse,
  type HidDeviceLike,
  type HidLike,
  type SpaceMouseButtonEvent,
  type SpaceMouseStatus
} from './spaceMouse';

class FakeDevice extends EventTarget implements HidDeviceLike {
  opened = false;
  readonly open = vi.fn(async () => {
    if (this.failOpen) throw new Error('Failed to open the device.');
    this.opened = true;
  });
  readonly close = vi.fn(async () => {
    this.opened = false;
  });
  readonly forget = vi.fn(async () => {
    this.opened = false;
  });
  failOpen = false;

  constructor(
    readonly vendorId = 0x046d,
    readonly productId = 0xc62b,
    readonly productName = 'SpaceMouse Pro',
    readonly collections = [{ usagePage: 0x01, usage: 0x08 }]
  ) {
    super();
  }

  /** Sends one input report of little-endian int16 values. */
  sendAxes(reportId: number, ...values: number[]) {
    const data = new DataView(new ArrayBuffer(values.length * 2));
    values.forEach((value, index) => data.setInt16(index * 2, value, true));
    this.send(reportId, data);
  }

  sendButtons(mask: number) {
    const data = new DataView(new ArrayBuffer(4));
    data.setUint32(0, mask >>> 0, true);
    this.send(3, data);
  }

  private send(reportId: number, data: DataView) {
    this.dispatchEvent(
      Object.assign(new Event('inputreport'), { device: this, reportId, data })
    );
  }
}

class FakeHid extends EventTarget implements HidLike {
  granted: HidDeviceLike[] = [];
  chooser: () => Promise<HidDeviceLike[]> = async () => [];
  readonly getDevices = vi.fn(async () => this.granted);
  readonly requestDevice = vi.fn(() => this.chooser());

  plug(device: HidDeviceLike, type: 'connect' | 'disconnect') {
    this.dispatchEvent(Object.assign(new Event(type), { device }));
  }
}

function setup() {
  const hid = new FakeHid();
  const focus = new EventTarget();
  const hub = new SpaceMouseHub(hid, focus);
  const statuses: SpaceMouseStatus[] = [];
  const motion: SixDofAxes[] = [];
  const buttons: SpaceMouseButtonEvent[] = [];
  hub.subscribeStatus((status) => statuses.push(status));
  hub.subscribeMotion((axes) => motion.push(axes));
  hub.subscribeButtons((event) => buttons.push(event));
  return { hid, focus, hub, statuses, motion, buttons };
}

let active: SpaceMouseHub | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
});

describe('SpaceMouseHub', () => {
  it('reports no WebHID as unsupported and does nothing', async () => {
    const hub = new SpaceMouseHub(null);
    expect(hub.getStatus()).toEqual({ state: 'unsupported' });
    await hub.connect();
    await hub.restore();
    expect(hub.getStatus()).toEqual({ state: 'unsupported' });
  });

  it('connects the chosen SpaceMouse Pro and streams shaped motion', async () => {
    const { hid, hub, statuses, motion } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.chooser = async () => [device];

    await hub.connect();
    expect(hid.requestDevice).toHaveBeenCalledWith({
      filters: SPACE_MOUSE_HID_FILTERS
    });
    expect(device.open).toHaveBeenCalledTimes(1);
    expect(statuses.map((status) => status.state)).toEqual([
      'connecting',
      'connected'
    ]);
    expect(hub.getStatus()).toEqual({
      state: 'connected',
      name: 'SpaceMouse Pro',
      rotationLocked: false
    });

    // Push right at full deflection, then let go.
    device.sendAxes(1, 350, 0, 0);
    expect(motion.at(-1)).toMatchObject({ tx: 1, ty: 0, tz: 0 });
    device.sendAxes(1, 0, 0, 0);
    expect(motion.at(-1)).toMatchObject({ tx: 0 });
    // A repeated reading sends nothing new.
    const count = motion.length;
    device.sendAxes(1, 0, 0, 0);
    expect(motion).toHaveLength(count);
  });

  it('sends each key press and release once, with the device modifiers', async () => {
    const { hid, hub, buttons } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.chooser = async () => [device];
    await hub.connect();

    const fit = 1 << SPACE_MOUSE_BUTTON.fit;
    const shift = 1 << SPACE_MOUSE_BUTTON.shift;
    const top = 1 << SPACE_MOUSE_BUTTON.top;
    device.sendButtons(fit);
    device.sendButtons(fit | shift);
    device.sendButtons(shift | top);
    device.sendButtons(0);
    const plain = { shift: false, control: false, alt: false };
    const shifted = { shift: true, control: false, alt: false };
    expect(buttons).toEqual([
      { button: SPACE_MOUSE_BUTTON.fit, pressed: true, ...plain },
      { button: SPACE_MOUSE_BUTTON.shift, pressed: true, ...shifted },
      { button: SPACE_MOUSE_BUTTON.fit, pressed: false, ...shifted },
      { button: SPACE_MOUSE_BUTTON.top, pressed: true, ...shifted },
      { button: SPACE_MOUSE_BUTTON.top, pressed: false, ...plain },
      { button: SPACE_MOUSE_BUTTON.shift, pressed: false, ...plain }
    ]);
  });

  it('lets go of held keys when the device goes away', async () => {
    const { hid, hub, buttons } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.chooser = async () => [device];
    await hub.connect();
    device.sendButtons(1 << SPACE_MOUSE_BUTTON.shift);
    hid.plug(device, 'disconnect');
    expect(buttons.at(-1)).toEqual({
      button: SPACE_MOUSE_BUTTON.shift,
      pressed: false,
      shift: false,
      control: false,
      alt: false
    });
  });

  it('locks rotation on the Lock key, leaving pan and zoom', async () => {
    const { hid, hub, motion } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.chooser = async () => [device];
    await hub.connect();
    device.sendAxes(1, 350, 0, 350, 350, 0, 0);
    expect(motion.at(-1)).toMatchObject({ tx: 1, rx: 1 });

    device.sendButtons(1 << SPACE_MOUSE_BUTTON.rotationLock);
    device.sendButtons(0);
    expect(hub.isRotationLocked).toBe(true);
    expect(hub.getStatus()).toMatchObject({ rotationLocked: true });
    // The held tilt stops at once; the push carries on.
    expect(motion.at(-1)).toMatchObject({ tx: 1, rx: 0 });
    device.sendAxes(1, 0, 0, 0, 0, 0, 350);
    expect(motion.at(-1)).toMatchObject({ tx: 0, ry: 0 });

    device.sendButtons(1 << SPACE_MOUSE_BUTTON.rotationLock);
    expect(hub.isRotationLocked).toBe(false);
    expect(motion.at(-1)?.ry).toBe(-1);
  });

  it('picks the multi-axis interface and ignores other devices', async () => {
    const { hid, hub } = setup();
    active = hub;
    const keyboard = new FakeDevice(0x046d, 0xb35b, 'MX Keys', [
      { usagePage: 0x01, usage: 0x06 }
    ]);
    const vendorInterface = new FakeDevice(0x256f, 0xc635, 'SpaceMouse', [
      { usagePage: 0xff00, usage: 0x01 }
    ]);
    const axes = new FakeDevice(0x256f, 0xc635, 'SpaceMouse', [
      { usagePage: 0x01, usage: 0x08 }
    ]);
    expect(isSpaceMouse(keyboard)).toBe(false);
    hid.chooser = async () => [keyboard, vendorInterface, axes];
    await hub.connect();
    expect(axes.open).toHaveBeenCalled();
    expect(keyboard.open).not.toHaveBeenCalled();
    expect(vendorInterface.open).not.toHaveBeenCalled();
  });

  it('stays disconnected when the chooser is dismissed', async () => {
    const { hub, statuses } = setup();
    active = hub;
    await hub.connect();
    expect(hub.getStatus()).toEqual({ state: 'disconnected' });
    expect(statuses).toEqual([{ state: 'disconnected' }]);
  });

  it('reports a policy refusal as blocked and an open failure as an error', async () => {
    const { hid, hub } = setup();
    active = hub;
    hid.chooser = () =>
      Promise.reject(new DOMException('Blocked', 'SecurityError'));
    await hub.connect();
    expect(hub.getStatus()).toEqual({ state: 'blocked' });

    const busy = new FakeDevice();
    busy.failOpen = true;
    hid.chooser = async () => [busy];
    await hub.connect();
    expect(hub.getStatus()).toEqual({
      state: 'error',
      message: 'Failed to open the device.'
    });
  });

  it('reopens an allowed device on load and on replug, with no chooser', async () => {
    const { hid, hub, motion } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.granted = [device];
    await hub.restore();
    expect(hid.requestDevice).not.toHaveBeenCalled();
    expect(hub.getStatus().state).toBe('connected');

    device.sendAxes(2, 0, 0, 350);
    expect(motion.at(-1)?.ry).toBe(-1);
    // Unplugged while held: the motion stops.
    hid.plug(device, 'disconnect');
    expect(hub.getStatus()).toEqual({ state: 'disconnected' });
    expect(motion.at(-1)?.ry).toBe(0);

    const replugged = new FakeDevice();
    hid.plug(replugged, 'connect');
    await vi.waitFor(() =>
      expect(hub.getStatus()).toEqual({
        state: 'connected',
        name: 'SpaceMouse Pro',
        rotationLocked: false
      })
    );
  });

  it('ignores the device while the window is in the background', async () => {
    const { hid, focus, hub, motion, buttons } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.chooser = async () => [device];
    await hub.connect();
    device.sendAxes(1, 0, 350, 0);
    expect(motion.at(-1)?.tz).toBe(1);
    focus.dispatchEvent(new Event('blur'));
    expect(motion.at(-1)?.tz).toBe(0);
    // Reports and keys from another app's use of the cap act on nothing.
    const seen = motion.length;
    device.sendAxes(1, 350, 350, 0);
    device.sendButtons(1 << SPACE_MOUSE_BUTTON.fit);
    hub.setPreferences({ ...DEFAULT_SPACE_MOUSE_SETTINGS, panZoomSpeed: 200 });
    expect(motion).toHaveLength(seen);
    expect(buttons).toEqual([]);
    // Back in focus, the cap still held moves the view again.
    focus.dispatchEvent(new Event('focus'));
    expect(motion.at(-1)).toMatchObject({ tx: 2, tz: 2 });
  });

  it('lets go of held keys when the window loses focus', async () => {
    const { hid, focus, hub, buttons } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.chooser = async () => [device];
    await hub.connect();
    device.sendButtons(1 << SPACE_MOUSE_BUTTON.control);
    focus.dispatchEvent(new Event('blur'));
    expect(buttons.at(-1)).toEqual({
      button: SPACE_MOUSE_BUTTON.control,
      pressed: false,
      shift: false,
      control: false,
      alt: false
    });
  });

  it('starts out of focus when the page loads in the background', async () => {
    const hid = new FakeHid();
    const focus = new EventTarget();
    const hub = new SpaceMouseHub(hid, focus, false);
    active = hub;
    const motion: SixDofAxes[] = [];
    hub.subscribeMotion((axes) => motion.push(axes));
    const device = new FakeDevice();
    hid.granted = [device];
    await hub.restore();
    device.sendAxes(1, 350, 0, 0);
    expect(motion).toEqual([]);
    focus.dispatchEvent(new Event('focus'));
    expect(motion.at(-1)?.tx).toBe(1);
  });

  it('applies saved preferences at once, to a held cap too', async () => {
    const { hid, hub, motion } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.chooser = async () => [device];
    await hub.connect();
    // A push right with a slight tilt, held.
    device.sendAxes(1, 350, 0, 0, 30, 0, 0);
    expect(motion.at(-1)?.rx).toBeGreaterThan(0);

    hub.setPreferences({
      ...DEFAULT_SPACE_MOUSE_SETTINGS,
      dominantAxis: true,
      panZoomSpeed: 50,
      reversed: ['pan-x'],
      rotateAbout: 'orbit-point'
    });
    expect(motion.at(-1)).toMatchObject({ tx: -0.5, rx: 0 });
    expect(hub.rotateAbout).toBe('orbit-point');
  });

  it('forgets the device on disconnect so it stays off', async () => {
    const { hid, hub, motion } = setup();
    active = hub;
    const device = new FakeDevice();
    hid.chooser = async () => [device];
    await hub.connect();
    device.sendAxes(1, 350, 0, 0);
    await hub.disconnect();
    expect(device.forget).toHaveBeenCalledTimes(1);
    expect(hub.getStatus()).toEqual({ state: 'disconnected' });
    expect(motion.at(-1)?.tx).toBe(0);
    // Reports from the forgotten device are ignored.
    device.sendAxes(1, 350, 0, 0);
    expect(motion.at(-1)?.tx).toBe(0);
  });
});
