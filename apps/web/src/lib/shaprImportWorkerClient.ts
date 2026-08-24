import type { ShaprImportIR } from '@openzcad/io-shapr';

import type {
  ShaprImportWorkerRequest,
  ShaprImportWorkerResult
} from '../worker/shaprImportWorker';

export interface ShaprPairInspection {
  ir: ShaprImportIR;
  stepChecksumSha256: string;
  sanitizedStepFile: File;
}

function abortError(): Error {
  const error = new Error('Shapr3D import preview was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** One parser worker per preview, terminated on success, failure, or cancel. */
export function inspectShaprPair(
  shaprFile: File,
  stepFile: File,
  options: {
    signal?: AbortSignal;
    onProgress?(message: string): void;
  } = {}
): Promise<ShaprPairInspection> {
  if (options.signal?.aborted) {
    return Promise.reject(abortError());
  }
  const worker = new Worker(
    new URL('../worker/shaprImportWorker.ts', import.meta.url),
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
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = () => {
      finish(() => reject(new Error('Shapr3D parser worker crashed.')));
    };
    worker.onmessageerror = () => {
      finish(() =>
        reject(new Error('Shapr3D parser returned unreadable data.'))
      );
    };
    worker.onmessage = (event: MessageEvent<ShaprImportWorkerResult>) => {
      const result = event.data;
      if (result.requestId !== requestId) {
        return;
      }
      if (result.type === 'progress') {
        options.onProgress?.(result.message);
        return;
      }
      if (result.ok) {
        finish(() =>
          resolve({
            ir: result.ir,
            stepChecksumSha256: result.stepChecksumSha256,
            sanitizedStepFile: new File(
              [result.sanitizedStepBytes],
              stepFile.name,
              {
                type: stepFile.type || 'application/step',
                lastModified: stepFile.lastModified
              }
            )
          })
        );
      } else {
        finish(() => reject(new Error(result.error)));
      }
    };
    const request: ShaprImportWorkerRequest = {
      type: 'parse',
      requestId,
      shaprFile,
      stepFile
    };
    worker.postMessage(request);
  });
}
