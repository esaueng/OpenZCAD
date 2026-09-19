import type { StepImportInspectionResult } from '../worker/stepImportWorker';
import { describeWorkerFailure } from './workerFailure';

/** A disposable worker makes even a synchronous WASM parse cancellable. */
export function inspectStepSolidsInWorker(
  file: File,
  signal?: AbortSignal
): Promise<number[]> {
  const cancelled = () =>
    new DOMException('STEP inspection was cancelled.', 'AbortError');
  if (signal?.aborted) return Promise.reject(cancelled());
  const worker = new Worker(
    new URL('../worker/stepImportWorker.ts', import.meta.url),
    { type: 'module' }
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(cancelled()));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = () =>
      finish(() => {
        void describeWorkerFailure('STEP inspection worker crashed.').then(
          ({ message }) => reject(new Error(message))
        );
      });
    worker.onmessageerror = () =>
      finish(() =>
        reject(new Error('STEP inspection returned unreadable data.'))
      );
    worker.onmessage = (event: MessageEvent<StepImportInspectionResult>) => {
      const result = event.data;
      finish(() => {
        if (result.ok) resolve(result.solidIndices);
        else
          void describeWorkerFailure(result.error).then(({ message }) =>
            reject(new Error(message))
          );
      });
    };
    try {
      worker.postMessage(file);
    } catch (error) {
      finish(() =>
        reject(error instanceof Error ? error : new Error(String(error)))
      );
    }
  });
}
