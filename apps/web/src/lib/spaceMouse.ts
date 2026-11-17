import {
  DEFAULT_SPACE_MOUSE_SETTINGS,
  type SpaceMouseAxisName,
  type SpaceMouseRotateAbout,
  type SpaceMouseSettings
} from '@openzcad/shared';
import {
  MULTI_AXIS_USAGE,
  MULTI_AXIS_USAGE_PAGE,
  SIX_DOF_IDLE,
  SPACE_MOUSE_BUTTON,
  SPACE_MOUSE_HID_FILTERS,
  SPACE_MOUSE_IDLE,
  decodeSpaceMouseReport,
  pressedButtons,
  sixDofFromRawWithPreferences,
  type HidDeviceFilter,
  type SixDofAxes,
  type SixDofAxisKey,
  type SixDofPreferences,
  type SpaceMouseRawState
} from '@openzcad/viewport/space-mouse';

/**
 * The browser's connection to a 3Dconnexion SpaceMouse over WebHID
 * (Chromium only). It decodes the device's reports with the viewport's pure
 * decoder and fans the result out: shaped axes to the viewer's camera,
 * button presses to the workspace, and connection status to Settings.
 *
 * Permission is per browser profile. The first connection needs a click
 * (`connect`, which shows the browser's device chooser); after that the
 * device reopens on load and on replug with no prompt (`restore` and the
 * HID `connect` event). Nothing here persists anything itself.
 */

/** The parts of WebHID this uses; TypeScript's DOM library has none of it. */
export interface HidCollectionLike {
  usagePage?: number;
  usage?: number;
}

export interface HidDeviceLike extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly HidCollectionLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
}

export interface HidLike extends EventTarget {
  getDevices(): Promise<HidDeviceLike[]>;
  requestDevice(options: {
    filters: readonly HidDeviceFilter[];
  }): Promise<HidDeviceLike[]>;
}

interface HidInputReportLike extends Event {
  readonly device: HidDeviceLike;
  readonly reportId: number;
  readonly data: DataView;
}

interface HidConnectionLike extends Event {
  readonly device: HidDeviceLike;
}

export type SpaceMouseStatus =
  /** This browser has no WebHID (Safari, Firefox, the desktop app). */
  | { state: 'unsupported' }
  /** WebHID exists but this page may not use it. */
  | { state: 'blocked' }
  | { state: 'disconnected' }
  | { state: 'connecting' }
  | {
      state: 'connected';
      name: string;
      /** The Lock key holds the view's orientation: only pan and zoom act. */
      rotationLocked: boolean;
    }
  | { state: 'error'; message: string };

type Listener<T> = (value: T) => void;

/** One of the device's keys going down or up. */
export interface SpaceMouseButtonEvent {
  /** Bit index; see `SPACE_MOUSE_BUTTON`. */
  button: number;
  pressed: boolean;
  /** The device's own Shift, Ctrl and Alt keys, held at the time. */
  shift: boolean;
  control: boolean;
  alt: boolean;
}

const held = (buttons: number, bit: number) => (buttons & (1 << bit)) !== 0;

const AXIS_KEYS: Record<SpaceMouseAxisName, SixDofAxisKey> = {
  'pan-x': 'tx',
  'pan-y': 'ty',
  zoom: 'tz',
  tilt: 'rx',
  spin: 'ry',
  roll: 'rz'
};

/** The stored settings as the decoder reads them. */
export function sixDofPreferencesFor(
  settings: SpaceMouseSettings
): SixDofPreferences {
  return {
    translationScale: settings.panZoomSpeed / 100,
    rotationScale: settings.rotationSpeed / 100,
    deadZone: settings.deadZone / 100,
    dominantAxis: settings.dominantAxis,
    roll: settings.roll,
    reversed: settings.reversed.map((axis) => AXIS_KEYS[axis])
  };
}

/** The page-lifecycle events that must stop a held motion. */
interface FocusSource {
  addEventListener(type: 'blur' | 'focus', listener: () => void): void;
  removeEventListener(type: 'blur' | 'focus', listener: () => void): void;
}

function matchesFilter(device: HidDeviceLike, filter: HidDeviceFilter) {
  if (filter.vendorId !== undefined && device.vendorId !== filter.vendorId) {
    return false;
  }
  if (filter.productId !== undefined && device.productId !== filter.productId) {
    return false;
  }
  if (filter.usagePage === undefined && filter.usage === undefined) {
    return true;
  }
  return device.collections.some(
    (collection) =>
      (filter.usagePage === undefined ||
        collection.usagePage === filter.usagePage) &&
      (filter.usage === undefined || collection.usage === filter.usage)
  );
}

/** Whether `device` is the multi-axis controller of a supported 3D mouse. */
export function isSpaceMouse(device: HidDeviceLike): boolean {
  return SPACE_MOUSE_HID_FILTERS.some((filter) =>
    matchesFilter(device, filter)
  );
}

/**
 * One physical device can surface as several HID devices, one per
 * interface. Prefer the one carrying the multi-axis collection.
 */
function pickSpaceMouse(
  devices: readonly HidDeviceLike[]
): HidDeviceLike | null {
  return (
    devices.find(
      (device) =>
        isSpaceMouse(device) &&
        device.collections.some(
          (collection) =>
            collection.usagePage === MULTI_AXIS_USAGE_PAGE &&
            collection.usage === MULTI_AXIS_USAGE
        )
    ) ?? null
  );
}

function sameAxes(a: SixDofAxes, b: SixDofAxes) {
  return (
    a.tx === b.tx &&
    a.ty === b.ty &&
    a.tz === b.tz &&
    a.rx === b.rx &&
    a.ry === b.ry &&
    a.rz === b.rz
  );
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The 3D mouse could not be opened.';
}

export class SpaceMouseHub {
  private readonly hid: HidLike | null;
  private readonly focus: FocusSource | null;
  private status: SpaceMouseStatus;
  private device: HidDeviceLike | null = null;
  private raw: SpaceMouseRawState = SPACE_MOUSE_IDLE;
  private axes: SixDofAxes = SIX_DOF_IDLE;
  private readonly statusListeners = new Set<Listener<SpaceMouseStatus>>();
  private readonly motionListeners = new Set<Listener<SixDofAxes>>();
  private readonly buttonListeners = new Set<Listener<SpaceMouseButtonEvent>>();
  private rotationLocked = false;
  private preferences = sixDofPreferencesFor(DEFAULT_SPACE_MOUSE_SETTINGS);
  private rotateAboutChoice: SpaceMouseRotateAbout =
    DEFAULT_SPACE_MOUSE_SETTINGS.rotateAbout;
  /** A connect or restore in flight, so two cannot race to open. */
  private opening: Promise<void> | null = null;
  private watching = false;

  /**
   * Whether this window has focus. The device keeps reporting to a page in
   * the background; those reports are tracked but never acted on, so another
   * app's use of the cap cannot move this view or run its commands.
   */
  private focused: boolean;

  constructor(
    hid: HidLike | null,
    focus: FocusSource | null = null,
    initiallyFocused = true
  ) {
    this.hid = hid;
    this.focus = focus;
    this.focused = initiallyFocused;
    this.status = hid ? { state: 'disconnected' } : { state: 'unsupported' };
  }

  getStatus = (): SpaceMouseStatus => this.status;

  subscribeStatus = (listener: Listener<SpaceMouseStatus>) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  /** Shaped camera-frame axes, sent whenever they change. */
  subscribeMotion(listener: Listener<SixDofAxes>) {
    this.motionListeners.add(listener);
    return () => {
      this.motionListeners.delete(listener);
    };
  }

  /** Every key press and release, with the device's modifiers. */
  subscribeButtons(listener: Listener<SpaceMouseButtonEvent>) {
    this.buttonListeners.add(listener);
    return () => {
      this.buttonListeners.delete(listener);
    };
  }

  /**
   * Shows the browser's device chooser. Must run inside a user gesture (a
   * click); the browser refuses the chooser otherwise.
   */
  async connect(): Promise<void> {
    const hid = this.hid;
    if (!hid) {
      return;
    }
    this.watch();
    let chosen: HidDeviceLike[];
    try {
      chosen = await hid.requestDevice({ filters: SPACE_MOUSE_HID_FILTERS });
    } catch (error) {
      this.setStatus(
        error instanceof DOMException && error.name === 'SecurityError'
          ? { state: 'blocked' }
          : { state: 'error', message: describeError(error) }
      );
      return;
    }
    const device = pickSpaceMouse(chosen);
    if (!device) {
      // The chooser was dismissed, or offered nothing usable.
      if (!this.device) {
        this.setStatus({ state: 'disconnected' });
      }
      return;
    }
    await this.open(device);
  }

  /**
   * Reopens a device this browser was already allowed to use, without a
   * prompt. Safe to call on every load; it does nothing without a device.
   */
  async restore(): Promise<void> {
    const hid = this.hid;
    if (!hid || this.device) {
      return;
    }
    this.watch();
    let devices: HidDeviceLike[];
    try {
      devices = await hid.getDevices();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'SecurityError') {
        this.setStatus({ state: 'blocked' });
      }
      return;
    }
    const device = pickSpaceMouse(devices);
    if (device) {
      await this.open(device);
    }
  }

  /**
   * Closes the device and gives up this browser's permission for it, so it
   * stays off until someone connects it again.
   */
  async disconnect(): Promise<void> {
    const device = this.device;
    if (!device) {
      return;
    }
    this.release();
    this.setStatus({ state: 'disconnected' });
    try {
      if (device.forget) {
        await device.forget();
      } else if (device.opened) {
        await device.close();
      }
    } catch {
      // Already gone (unplugged); there is nothing left to release.
    }
  }

  private async open(device: HidDeviceLike): Promise<void> {
    if (this.device === device) {
      return;
    }
    if (this.opening) {
      await this.opening;
      if (this.device) {
        return;
      }
    }
    this.setStatus({ state: 'connecting' });
    const opening = (async () => {
      try {
        if (!device.opened) {
          await device.open();
        }
      } catch (error) {
        this.setStatus({ state: 'error', message: describeError(error) });
        return;
      }
      this.device = device;
      this.raw = SPACE_MOUSE_IDLE;
      device.addEventListener('inputreport', this.handleInputReport);
      this.setStatus({
        state: 'connected',
        name: device.productName || '3D mouse',
        rotationLocked: this.rotationLocked
      });
    })();
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) {
        this.opening = null;
      }
    }
  }

  /** Drops the current device and stops any motion it was holding. */
  private release() {
    this.device?.removeEventListener('inputreport', this.handleInputReport);
    this.device = null;
    this.releaseHeldButtons();
    this.raw = SPACE_MOUSE_IDLE;
    this.emitAxes(SIX_DOF_IDLE);
  }

  /**
   * Lets go of every key the device holds, so nothing it pressed (a Shift)
   * stays down once its reports can no longer be trusted to release it.
   */
  private releaseHeldButtons() {
    const heldButtons = pressedButtons(0, this.raw.buttons);
    this.raw = { ...this.raw, buttons: 0 };
    for (const button of heldButtons) {
      const event: SpaceMouseButtonEvent = {
        button,
        pressed: false,
        shift: false,
        control: false,
        alt: false
      };
      for (const listener of this.buttonListeners) {
        listener(event);
      }
    }
  }

  private watch() {
    if (this.watching || !this.hid) {
      return;
    }
    this.watching = true;
    this.hid.addEventListener('connect', this.handleConnect);
    this.hid.addEventListener('disconnect', this.handleDisconnect);
    this.focus?.addEventListener('blur', this.handleBlur);
    this.focus?.addEventListener('focus', this.handleFocus);
  }

  /** Stops listening entirely; for tests and teardown. */
  dispose() {
    this.release();
    if (this.watching && this.hid) {
      this.hid.removeEventListener('connect', this.handleConnect);
      this.hid.removeEventListener('disconnect', this.handleDisconnect);
      this.focus?.removeEventListener('blur', this.handleBlur);
      this.focus?.removeEventListener('focus', this.handleFocus);
    }
    this.watching = false;
    this.statusListeners.clear();
    this.motionListeners.clear();
    this.buttonListeners.clear();
  }

  private handleInputReport = (event: Event) => {
    const report = event as HidInputReportLike;
    if (report.device !== this.device || !(report.data instanceof DataView)) {
      return;
    }
    const next = decodeSpaceMouseReport(report.reportId, report.data, this.raw);
    if (!next) {
      return;
    }
    const previousButtons = this.raw.buttons;
    this.raw = next;
    if (!this.focused) {
      // Tracked, so the right state is waiting when focus returns.
      return;
    }
    const pressed = pressedButtons(previousButtons, next.buttons);
    if (pressed.includes(SPACE_MOUSE_BUTTON.rotationLock)) {
      this.toggleRotationLock();
    }
    this.emitShapedAxes();
    const released = pressedButtons(next.buttons, previousButtons);
    const modifiers = {
      shift: held(next.buttons, SPACE_MOUSE_BUTTON.shift),
      control: held(next.buttons, SPACE_MOUSE_BUTTON.control),
      alt: held(next.buttons, SPACE_MOUSE_BUTTON.alt)
    };
    const changes = [
      ...released.map((button) => ({ button, pressed: false })),
      ...pressed.map((button) => ({ button, pressed: true }))
    ];
    for (const change of changes) {
      const event: SpaceMouseButtonEvent = { ...change, ...modifiers };
      for (const listener of this.buttonListeners) {
        listener(event);
      }
    }
  };

  /** Whether the Lock key is holding the view's orientation. */
  get isRotationLocked(): boolean {
    return this.rotationLocked;
  }

  /** The Lock key: rotation stops acting until it is pressed again. */
  toggleRotationLock() {
    this.rotationLocked = !this.rotationLocked;
    this.emitShapedAxes();
    if (this.status.state === 'connected') {
      this.setStatus({ ...this.status, rotationLocked: this.rotationLocked });
    }
  }

  /** Applies the user's settings, at once, to a cap that is held. */
  setPreferences(settings: SpaceMouseSettings) {
    this.preferences = sixDofPreferencesFor(settings);
    this.rotateAboutChoice = settings.rotateAbout;
    this.emitShapedAxes();
  }

  /** What the view turns about; the viewer resolves it to a point. */
  get rotateAbout(): SpaceMouseRotateAbout {
    return this.rotateAboutChoice;
  }

  private emitShapedAxes() {
    if (!this.focused) {
      this.emitAxes(SIX_DOF_IDLE);
      return;
    }
    this.emitAxes(
      sixDofFromRawWithPreferences(this.raw, {
        ...this.preferences,
        rotationLocked: this.rotationLocked
      })
    );
  }

  /** A replugged device the browser already allows reopens by itself. */
  private handleConnect = (event: Event) => {
    const { device } = event as HidConnectionLike;
    if (!this.device && device && isSpaceMouse(device)) {
      void this.open(device);
    }
  };

  private handleDisconnect = (event: Event) => {
    const { device } = event as HidConnectionLike;
    if (device && device === this.device) {
      this.release();
      this.setStatus({ state: 'disconnected' });
    }
  };

  /**
   * Another window took focus: the view stops, held keys are let go, and
   * reports are only tracked until focus comes back.
   */
  private handleBlur = () => {
    this.focused = false;
    this.releaseHeldButtons();
    this.emitAxes(SIX_DOF_IDLE);
  };

  /** Back in focus: a cap still held moves the view again. */
  private handleFocus = () => {
    this.focused = true;
    this.emitShapedAxes();
  };

  private emitAxes(axes: SixDofAxes) {
    if (sameAxes(axes, this.axes)) {
      return;
    }
    this.axes = axes;
    for (const listener of this.motionListeners) {
      listener(axes);
    }
  }

  private setStatus(status: SpaceMouseStatus) {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

function browserHid(): HidLike | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const hid = (navigator as Navigator & { hid?: HidLike }).hid;
  return hid ?? null;
}

/** The page's one connection; every consumer subscribes to this. */
export const spaceMouse = new SpaceMouseHub(
  browserHid(),
  typeof window === 'undefined' ? null : window,
  typeof document === 'undefined' ? true : document.hasFocus()
);
