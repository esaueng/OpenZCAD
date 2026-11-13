/**
 * Dependency-free half of the runtime diagnostics. Failure sites anywhere in
 * the app (worker clients, the viewport) raise a fixed code here; the
 * listener `installRuntimeDiagnostics` adds at startup forwards it to the
 * opt-in analytics path. Keeping this module free of imports lets lazy chunks
 * report without pulling the analytics client into them, which would
 * re-partition the shared chunks into the entry bundle.
 */
export type RuntimeDiagnostic =
  | 'error_unresponsive'
  | 'error_gpu_lost'
  | 'error_out_of_memory'
  | 'error_worker';

export const DIAGNOSTIC_SIGNAL = 'openzcad-runtime-diagnostic';

/** Raises one fixed code. Only the code travels; nothing else is attached. */
export function signalDiagnostic(code: RuntimeDiagnostic): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(DIAGNOSTIC_SIGNAL, { detail: code }));
  } catch {
    // Diagnostics never interrupt the failure path that raised them.
  }
}

// Engine wording for a failed allocation: V8 ("Array buffer allocation
// failed", "Out of memory: Cannot allocate Wasm memory", "WebAssembly.Memory
// .grow(): Maximum memory size exceeded"), SpiderMonkey and JavaScriptCore
// ("out of memory"), Rust ("memory allocation of N bytes failed") and
// Emscripten ("Cannot enlarge memory arrays", "abort(OOM)"). Not "memory
// access out of bounds", which is a kernel crash rather than an allocation.
const OUT_OF_MEMORY =
  /out of memory|\bOOM\b|allocation failed|allocation of \d+ bytes failed|(?:could ?not|cannot|failed to) allocate|maximum memory size exceeded|cannot enlarge memory/i;

/** Whether a thrown value or failure text is an out-of-memory signal. */
export function isOutOfMemory(error: unknown): boolean {
  if (typeof error === 'string') return OUT_OF_MEMORY.test(error);
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return (
    (typeof message === 'string' && OUT_OF_MEMORY.test(message)) ||
    (typeof name === 'string' && OUT_OF_MEMORY.test(name))
  );
}

/** Counts `error_out_of_memory` when `error` is one; the text is not kept. */
export function trackOutOfMemory(error: unknown): boolean {
  if (!isOutOfMemory(error)) return false;
  signalDiagnostic('error_out_of_memory');
  return true;
}

/**
 * Counts a lost WebGL context or WebGPU device. A hidden page is skipped:
 * browsers reclaim a background tab's GPU memory by design (iPadOS does it
 * routinely), which is not a failure the person saw.
 */
export function trackGpuLost(
  hidden = typeof document !== 'undefined' &&
    document.visibilityState === 'hidden'
): void {
  if (!hidden) signalDiagnostic('error_gpu_lost');
}

/** A worker that stopped unexpectedly (crash, wedge, failed start). */
export function trackWorkerFailure(): void {
  signalDiagnostic('error_worker');
}

/**
 * Counts every uncaught error a worker raises as `error_worker`, plus
 * `error_out_of_memory` when its message says so. Listens beside the caller's
 * own `onerror`, which keeps handling the failure. Returns the worker.
 */
export function observeWorker<T extends Worker>(worker: T): T {
  if (typeof worker?.addEventListener === 'function')
    worker.addEventListener('error', (event: Event) => {
      trackWorkerFailure();
      const failure = event as Partial<ErrorEvent>;
      trackOutOfMemory(failure.error ?? failure.message);
    });
  return worker;
}
