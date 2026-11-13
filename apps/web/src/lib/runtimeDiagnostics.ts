import { hasAnalyticsConsent, trackDetail } from './analytics';
import {
  DIAGNOSTIC_SIGNAL,
  trackOutOfMemory,
  type RuntimeDiagnostic
} from './diagnosticSignal';

/**
 * Runtime diagnostic codes from the Glimpse privacy review approved on
 * 13 November 2026. Each is a fixed code the app decides on locally and sends
 * through the same opt-in path as every other diagnostic (`trackDetail`), so
 * consent, DNT/GPC, the cloud switch and withdrawal are rechecked per send.
 * The message, stack, URL, GPU or driver name, memory size, worker script and
 * every duration or timestamp stay in this page. Failure sites raise codes
 * through the import-free `diagnosticSignal.ts`; this module forwards them.
 */
export {
  isOutOfMemory,
  observeWorker,
  trackGpuLost,
  trackOutOfMemory,
  trackWorkerFailure,
  type RuntimeDiagnostic
} from './diagnosticSignal';

const CODES: readonly RuntimeDiagnostic[] = [
  'error_unresponsive',
  'error_gpu_lost',
  'error_out_of_memory',
  'error_worker'
];
if (typeof window !== 'undefined')
  window.addEventListener(DIAGNOSTIC_SIGNAL, (event: Event) => {
    const code = (event as CustomEvent<unknown>).detail;
    if ((CODES as readonly unknown[]).includes(code))
      trackDetail(code as RuntimeDiagnostic);
  });

/** Main-thread block that counts as unresponsive. */
export const UNRESPONSIVE_MS = 5000;
/** Heartbeat period of the fallback watchdog. */
export const HEARTBEAT_MS = 1000;
/**
 * A heartbeat gap this long is treated as a suspended page (system sleep, a
 * frozen background tab), not a hang. Browsers offer to kill a page blocked
 * this long, so a real hang rarely reaches it.
 */
export const SUSPENDED_MS = 60000;

/** What the unresponsive watchdog needs from the page, replaceable in tests. */
export interface WatchdogHost {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  hidden(): boolean;
  /** Subscribes to visibility changes; returns the unsubscribe. */
  onVisibilityChange(callback: () => void): () => void;
  /**
   * Subscribes to long-task durations where the browser reports them;
   * returns the unsubscribe, or null when unsupported.
   */
  observeLongTasks(callback: (durationMs: number) => void): (() => void) | null;
}

function browserHost(): WatchdogHost {
  return {
    now: () => performance.now(),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    hidden: () => document.visibilityState === 'hidden',
    onVisibilityChange: (callback) => {
      document.addEventListener('visibilitychange', callback);
      return () => document.removeEventListener('visibilitychange', callback);
    },
    observeLongTasks: (callback) => {
      if (
        typeof PerformanceObserver === 'undefined' ||
        !PerformanceObserver.supportedEntryTypes?.includes('longtask')
      )
        return null;
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) callback(entry.duration);
        });
        observer.observe({ type: 'longtask' });
        return () => observer.disconnect();
      } catch {
        return null;
      }
    }
  };
}

/**
 * Calls `report` once for each main-thread block of {@link UNRESPONSIVE_MS} or
 * more while the page is visible. Uses long-task entries where supported
 * (Chromium), which measure the block itself. Elsewhere a heartbeat counts a
 * tick that arrives at least 5 s later than due: conservative, since the
 * block lasted at least the delay. A gap spanning hidden time, or of
 * {@link SUSPENDED_MS} or more, is skipped as background throttling or sleep.
 * Returns the stop function.
 */
export function startUnresponsiveWatchdog(
  report: () => void,
  host: WatchdogHost = browserHost()
): () => void {
  const stopLongTasks = host.observeLongTasks((duration) => {
    if (duration >= UNRESPONSIVE_MS && !host.hidden()) report();
  });
  if (stopLongTasks) return stopLongTasks;
  let last = host.now();
  let interrupted = host.hidden();
  const stopVisibility = host.onVisibilityChange(() => {
    interrupted = true;
  });
  const handle = host.setInterval(() => {
    const now = host.now();
    const late = now - last - HEARTBEAT_MS;
    last = now;
    const skip = interrupted || host.hidden();
    interrupted = host.hidden();
    if (!skip && late >= UNRESPONSIVE_MS && late + HEARTBEAT_MS < SUSPENDED_MS)
      report();
  }, HEARTBEAT_MS);
  return () => {
    host.clearInterval(handle);
    stopVisibility();
  };
}

let installed = false;

/**
 * Starts page-wide runtime diagnostics once. The watchdog runs only while
 * this browser holds an analytics grant, so a page without one runs no timer;
 * every send is still gated again by `trackDetail`.
 */
export function installRuntimeDiagnostics(
  host?: WatchdogHost
): (() => void) | undefined {
  if (installed || typeof window === 'undefined') return undefined;
  installed = true;
  let stopWatchdog: (() => void) | null = null;
  const sync = () => {
    if (hasAnalyticsConsent())
      stopWatchdog ??= startUnresponsiveWatchdog(
        () => trackDetail('error_unresponsive'),
        host
      );
    else {
      stopWatchdog?.();
      stopWatchdog = null;
    }
  };
  // `error_runtime` is counted for these by analytics.ts; an out-of-memory
  // failure additionally gets its own code.
  const onError = (event: Event) => {
    const failure = event as Partial<ErrorEvent>;
    trackOutOfMemory(failure.error ?? failure.message);
  };
  const onRejection = (event: Event) => {
    trackOutOfMemory((event as Partial<PromiseRejectionEvent>).reason);
  };
  window.addEventListener('glimpse-consent-changed', sync);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  sync();
  return () => {
    window.removeEventListener('glimpse-consent-changed', sync);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    stopWatchdog?.();
    stopWatchdog = null;
    installed = false;
  };
}
