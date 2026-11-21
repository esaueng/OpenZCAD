import {
  MULTI_AXIS_USAGE,
  MULTI_AXIS_USAGE_PAGE,
  SPACE_MOUSE_LEGACY_VENDOR_ID
} from '@openzcad/viewport/space-mouse';
import type { HidDeviceLike, HidLike } from './spaceMouse';

type NativeReport =
  | { kind: 'input'; value: number[] }
  | { kind: 'reset' }
  | { kind: 'error'; value: string };

interface NativeSpaceMouseBridge {
  listen(receive: (report: NativeReport) => void): Promise<() => void>;
  enable(enabled: boolean): Promise<void>;
}

const bridge: NativeSpaceMouseBridge = {
  async listen(receive) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<NativeReport>(
      'openzcad://spacemouse',
      (event) => receive(event.payload),
      { target: 'main' }
    );
  },
  async enable(enabled) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_wired_space_mouse', { enabled });
  }
};

// The native reader sends a heartbeat every 40 ms while either axis report is held.
const REPORT_TIMEOUT_MS = 150;

class NativeSpaceMouseDevice extends EventTarget implements HidDeviceLike {
  readonly vendorId = SPACE_MOUSE_LEGACY_VENDOR_ID;
  readonly productId = 0xc62b;
  readonly productName = 'Wired SpaceMouse Pro';
  readonly collections = [
    { usagePage: MULTI_AXIS_USAGE_PAGE, usage: MULTI_AXIS_USAGE }
  ];
  private unsubscribe: (() => void) | undefined;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  private captureError: string | undefined;

  constructor(
    private readonly transport: NativeSpaceMouseBridge,
    private readonly reportError: (message: string) => void
  ) {
    super();
  }

  get opened() {
    return this.unsubscribe !== undefined;
  }

  async open() {
    if (this.opened) return;
    this.captureError = undefined;
    const unsubscribe = await this.transport.listen(this.receive);
    this.unsubscribe = unsubscribe;
    try {
      await this.transport.enable(true);
      if (this.captureError) throw new Error(this.captureError);
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  async close() {
    this.detach();
    await this.transport.enable(false);
  }

  private detach() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private report(reportId: number, bytes: Uint8Array<ArrayBuffer>) {
    this.dispatchEvent(
      Object.assign(new Event('inputreport'), {
        device: this,
        reportId,
        data: new DataView(bytes.buffer)
      })
    );
  }

  private receive = (message: NativeReport) => {
    if (!this.opened) return;
    if (message.kind === 'error') {
      this.captureError = message.value;
      this.detach();
      this.reportError(message.value);
      return;
    }
    if (message.kind === 'reset') {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      for (const id of [1, 2, 3]) this.report(id, new Uint8Array(6));
      return;
    }
    const [id, ...data] = message.value;
    if (id !== 1 && id !== 2 && id !== 3) return;
    if (id === 3 ? data.length < 1 || data.length > 6 : data.length !== 6)
      return;
    if (id !== 3) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      if (data.some(Boolean)) {
        this.timers.set(
          id,
          setTimeout(() => {
            this.timers.delete(id);
            this.report(id, new Uint8Array(6));
          }, REPORT_TIMEOUT_MS)
        );
      }
    }
    this.report(id, Uint8Array.from(data));
  };
}

/** Native capture starts only from the existing Connect control. */
export function nativeSpaceMouseHid(transport = bridge): HidLike {
  const hid = new EventTarget();
  const device = new NativeSpaceMouseDevice(transport, (error) => {
    hid.dispatchEvent(
      Object.assign(new Event('disconnect'), { device, error })
    );
  });
  return Object.assign(hid, {
    getDevices: async () => (device.opened ? [device] : []),
    requestDevice: async () => [device]
  });
}
