import { observeWorker } from './diagnosticSignal';
import type { StepStructure } from '@openzcad/kernel-adapter/exact';
import type { StepImportInspectionResult } from '../worker/stepImportWorker';
import { describeWorkerFailure } from './workerFailure';

/** What an inspection found: the accepted solids and, if read, the structure. */
export interface StepInspection {
  solidIndices: number[];
  structure?: StepStructure;
  structureRefusal?: string;
}

/** The accepted solids, by the flat reader every guided import uses. */
export async function inspectStepSolidsInWorker(
  file: File,
  signal?: AbortSignal
): Promise<number[]> {
  return (await inspectStepInWorker(file, { structure: false }, signal))
    .solidIndices;
}

/** A disposable worker makes even a synchronous WASM parse cancellable. */
export function inspectStepInWorker(
  file: File,
  options: { structure: boolean },
  signal?: AbortSignal
): Promise<StepInspection> {
  const cancelled = () =>
    new DOMException('STEP inspection was cancelled.', 'AbortError');
  if (signal?.aborted) return Promise.reject(cancelled());
  const worker = observeWorker(
    new Worker(new URL('../worker/stepImportWorker.ts', import.meta.url), {
      type: 'module'
    })
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
    const deadline = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error('STEP inspection exceeded the 120 second time limit.')
          )
        ),
      120_000
    );
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
        if (result.ok)
          resolve({
            solidIndices: result.solidIndices,
            ...(result.structure ? { structure: result.structure } : {}),
            ...(result.structureRefusal !== undefined
              ? { structureRefusal: result.structureRefusal }
              : {})
          });
        else
          void describeWorkerFailure(result.error).then(({ message }) =>
            reject(new Error(message))
          );
      });
    };
    try {
      worker.postMessage({ file, structure: options.structure });
    } catch (error) {
      finish(() =>
        reject(error instanceof Error ? error : new Error(String(error)))
      );
    }
  });
}
