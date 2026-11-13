import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Analytics from './analytics';
import type * as Diagnostics from './runtimeDiagnostics';

// Same harness as analytics.test.ts: a fresh module graph per test, with the
// browser storage, privacy signals and network replaced by fakes.
let analytics: typeof Analytics;
let diagnostics: typeof Diagnostics;
let store: Map<string, string>;
let send: ReturnType<typeof vi.fn<typeof fetch>>;
let uninstall: (() => void) | undefined;
beforeEach(async () => {
  vi.resetModules();
  store = new Map();
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        }
      }
    })
  );
  vi.stubGlobal('navigator', { doNotTrack: '0' });
  vi.stubGlobal('localStorage', window.localStorage);
  send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', send);
  analytics = await import('./analytics');
  diagnostics = await import('./runtimeDiagnostics');
  uninstall = undefined;
});
afterEach(() => {
  uninstall?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SECRET = 'C:/Users/someone/private-model.step';
function sent(): { event: string; bucket: string }[] {
  return send.mock.calls
    .filter(([url]) => url === '/api/glimpse/usage')
    .map(([, init]) => JSON.parse(init?.body as string) as never);
}
function events(): string[] {
  return sent().map((body) => body.event);
}

/** A controllable stand-in for the page's clock, timers and visibility. */
function fakeHost(longTasks = false) {
  let now = 0;
  let hidden = false;
  let tick: (() => void) | null = null;
  let longTask: ((duration: number) => void) | null = null;
  const visibility = new Set<() => void>();
  const host: Diagnostics.WatchdogHost = {
    now: () => now,
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: vi.fn(() => {
      tick = null;
    }),
    hidden: () => hidden,
    onVisibilityChange: (callback) => {
      visibility.add(callback);
      return () => visibility.delete(callback);
    },
    observeLongTasks: (callback) => {
      if (!longTasks) return null;
      longTask = callback;
      return () => {
        longTask = null;
      };
    }
  };
  return {
    host,
    /** Advances the clock and fires the heartbeat once, as a late timer. */
    beat(elapsedMs: number) {
      now += elapsedMs;
      tick?.();
    },
    longTask(duration: number) {
      longTask?.(duration);
    },
    setHidden(value: boolean) {
      hidden = value;
      for (const callback of visibility) callback();
    },
    get running() {
      return tick !== null || longTask !== null;
    }
  };
}

describe('error_unresponsive watchdog', () => {
  it('counts a heartbeat that arrives at least 5 s late, once per block', () => {
    const page = fakeHost();
    const report = vi.fn();
    diagnostics.startUnresponsiveWatchdog(report, page.host);
    page.beat(diagnostics.HEARTBEAT_MS);
    page.beat(diagnostics.HEARTBEAT_MS + diagnostics.UNRESPONSIVE_MS - 1);
    expect(report).not.toHaveBeenCalled();
    page.beat(diagnostics.HEARTBEAT_MS + diagnostics.UNRESPONSIVE_MS);
    expect(report).toHaveBeenCalledOnce();
    page.beat(diagnostics.HEARTBEAT_MS);
    expect(report).toHaveBeenCalledOnce();
  });

  it('ignores gaps that span hidden time or look like a suspended page', () => {
    const page = fakeHost();
    const report = vi.fn();
    diagnostics.startUnresponsiveWatchdog(report, page.host);
    page.setHidden(true);
    page.beat(20000);
    page.setHidden(false);
    page.beat(20000);
    // Hidden and back between two ticks: still not a hang the person saw.
    page.setHidden(true);
    page.setHidden(false);
    page.beat(20000);
    page.beat(diagnostics.SUSPENDED_MS);
    expect(report).not.toHaveBeenCalled();
    page.beat(diagnostics.SUSPENDED_MS - 1);
    expect(report).toHaveBeenCalledOnce();
  });

  it('prefers long-task entries where the browser reports them', () => {
    const page = fakeHost(true);
    const report = vi.fn();
    const stop = diagnostics.startUnresponsiveWatchdog(report, page.host);
    page.longTask(diagnostics.UNRESPONSIVE_MS - 1);
    expect(report).not.toHaveBeenCalled();
    page.longTask(diagnostics.UNRESPONSIVE_MS);
    expect(report).toHaveBeenCalledOnce();
    page.setHidden(true);
    page.longTask(30000);
    expect(report).toHaveBeenCalledOnce();
    stop();
    expect(page.running).toBe(false);
  });

  it('runs only while this browser holds a grant and sends only the code', () => {
    const page = fakeHost();
    uninstall = diagnostics.installRuntimeDiagnostics(page.host);
    expect(page.running).toBe(false);
    analytics.setAnalyticsEnabled(true);
    expect(page.running).toBe(true);
    page.beat(diagnostics.HEARTBEAT_MS + 7321);
    expect(sent()).toEqual([{ event: 'error_unresponsive', bucket: 'none' }]);
    expect(JSON.stringify(sent())).not.toContain('7321');
    analytics.setAnalyticsEnabled(false);
    expect(page.running).toBe(false);
    expect(page.host.clearInterval).toHaveBeenCalledOnce();
  });
});

describe('opt-in gating of the new diagnostic codes', () => {
  function fireAll() {
    diagnostics.trackGpuLost(false);
    diagnostics.trackWorkerFailure();
    diagnostics.trackOutOfMemory(
      new RangeError('Array buffer allocation failed')
    );
  }

  it('sends nothing without consent, under DNT/GPC, or after withdrawal', () => {
    fireAll();
    expect(send).not.toHaveBeenCalled();
    analytics.setAnalyticsEnabled(true);
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    fireAll();
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    fireAll();
    expect(send).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { doNotTrack: '0' });
    analytics.setAnalyticsEnabled(false);
    fireAll();
    expect(send).not.toHaveBeenCalled();
    expect(analytics.diagnosticReport().rows).toEqual([]);
  });

  it('sends each as a fixed code with the bucket none, counted in the report', () => {
    analytics.setAnalyticsEnabled(true);
    fireAll();
    expect(sent()).toEqual([
      { event: 'error_gpu_lost', bucket: 'none' },
      { event: 'error_worker', bucket: 'none' },
      { event: 'error_out_of_memory', bucket: 'none' }
    ]);
    expect(
      analytics
        .diagnosticReport()
        .rows.map((row) => row.event)
        .sort()
    ).toEqual(['error_gpu_lost', 'error_out_of_memory', 'error_worker']);
  });

  it('withdrawal aborts a pending send of a new code', () => {
    send.mockImplementation(() => new Promise<Response>(() => undefined));
    analytics.setAnalyticsEnabled(true);
    diagnostics.trackWorkerFailure();
    const signal = send.mock.calls[0]![1]!.signal!;
    analytics.setAnalyticsEnabled(false);
    expect(signal.aborted).toBe(true);
  });

  it('skips a GPU loss in a hidden page, where browsers reclaim memory by design', () => {
    analytics.setAnalyticsEnabled(true);
    diagnostics.trackGpuLost(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('a rejected send (an older Glimpse) is dropped, never retried or thrown', async () => {
    send.mockResolvedValue(new Response(null, { status: 400 }));
    analytics.setAnalyticsEnabled(true);
    expect(() => diagnostics.trackGpuLost(false)).not.toThrow();
    send.mockRejectedValueOnce(new TypeError('network'));
    expect(() => diagnostics.trackWorkerFailure()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('error_worker and error_out_of_memory triggers', () => {
  it('counts a worker error beside its own handler, without the message', () => {
    analytics.setAnalyticsEnabled(true);
    const worker = new EventTarget() as Worker;
    const own = vi.fn();
    worker.onerror = own;
    expect(diagnostics.observeWorker(worker)).toBe(worker);
    worker.dispatchEvent(
      Object.assign(new Event('error'), { message: `Crashed in ${SECRET}` })
    );
    worker.dispatchEvent(
      Object.assign(new Event('error'), {
        message: `Uncaught RangeError: Array buffer allocation failed at ${SECRET}`
      })
    );
    expect(events()).toEqual([
      'error_worker',
      'error_worker',
      'error_out_of_memory'
    ]);
    expect(JSON.stringify(sent())).not.toContain('private');
  });

  it('tolerates a worker stand-in without event listeners', () => {
    const stub = {} as Worker;
    expect(diagnostics.observeWorker(stub)).toBe(stub);
  });

  it('classifies allocation failures, not other errors', () => {
    for (const signal of [
      new RangeError('Array buffer allocation failed'),
      new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded'),
      new RangeError(
        'Out of memory: Cannot allocate Wasm memory for new instance'
      ),
      'InternalError: out of memory',
      'memory allocation of 1073741824 bytes failed',
      'Cannot enlarge memory arrays to size 4294967296 bytes',
      'abort(OOM). Build with -sASSERTIONS for more info.',
      Object.assign(new Error('x'), { name: 'out of memory' })
    ])
      expect(diagnostics.isOutOfMemory(signal), String(signal)).toBe(true);
    for (const other of [
      new RangeError('Invalid array length'),
      new RangeError('Maximum call stack size exceeded'),
      'RuntimeError: memory access out of bounds',
      'Geometry worker crashed.',
      null,
      undefined,
      42,
      {}
    ])
      expect(diagnostics.isOutOfMemory(other), JSON.stringify(other)).toBe(
        false
      );
  });

  it('counts uncaught out-of-memory errors and rejections on the page', () => {
    uninstall = diagnostics.installRuntimeDiagnostics(fakeHost().host);
    analytics.setAnalyticsEnabled(true);
    window.dispatchEvent(
      Object.assign(new Event('error'), {
        error: new RangeError('Array buffer allocation failed'),
        message: SECRET
      })
    );
    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), {
        reason: new Error(`out of memory in ${SECRET}`)
      })
    );
    window.dispatchEvent(
      Object.assign(new Event('error'), { error: new TypeError(SECRET) })
    );
    // analytics.ts adds error_runtime for each; the new code is extra.
    expect(events().filter((event) => event !== 'error_runtime')).toEqual([
      'error_out_of_memory',
      'error_out_of_memory'
    ]);
    expect(JSON.stringify(sent())).not.toContain('private');
  });

  it('counts out-of-memory text a worker reports through describeWorkerFailure', async () => {
    analytics.setAnalyticsEnabled(true);
    send.mockImplementation(async () => new Response(null, { status: 204 }));
    const { describeWorkerFailure } = await import('./workerFailure');
    await describeWorkerFailure('Mesh import worker crashed.');
    expect(events()).not.toContain('error_out_of_memory');
    await describeWorkerFailure(
      `RangeError: Array buffer allocation failed (${SECRET})`
    );
    expect(events()).toContain('error_out_of_memory');
    expect(JSON.stringify(sent())).not.toContain('private');
  });
});
