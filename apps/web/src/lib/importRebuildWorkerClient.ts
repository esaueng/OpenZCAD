import type { ProjectDocument } from '@openzcad/shared';

import type {
  ImportRebuildWorkerRequest,
  ImportRebuildWorkerResult
} from '../worker/importRebuildWorker';

function abortError(): Error {
  const error = new Error('Exact import rebuild was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Runs one exact candidate rebuild in a disposable browser worker.
 *
 * Termination is the cancellation primitive: it can preempt synchronous wasm,
 * and the next attempt creates a clean worker and kernel rather than reusing
 * state from the abandoned rebuild.
 */
export function rebuildImportInDisposableWorker(
  document: ProjectDocument,
  signal?: AbortSignal
): Promise<ProjectDocument['derived']> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  const worker = new Worker(
    new URL('../worker/importRebuildWorker.ts', import.meta.url),
    { type: 'module' }
  );
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = () => {
      finish(() => reject(new Error('Exact import rebuild worker crashed.')));
    };
    worker.onmessageerror = () => {
      finish(() =>
        reject(new Error('Exact import rebuild returned unreadable data.'))
      );
    };
    worker.onmessage = (event: MessageEvent<ImportRebuildWorkerResult>) => {
      const result = event.data;
      if (result.requestId !== requestId) {
        return;
      }
      if (result.ok) {
        finish(() => resolve(result.derived));
      } else {
        finish(() => reject(new Error(result.error)));
      }
    };
    const request: ImportRebuildWorkerRequest = {
      type: 'rebuild',
      requestId,
      document
    };
    worker.postMessage(request);
  });
}
