/**
 * I06: IGES import. The qualified subset (manifold solid B-rep objects,
 * type 186) is restated as exact STEP by the Remus translator and then
 * imported exactly as a STEP file is: the stored, archived and replayed
 * source is that STEP text, under the IGES file's name. Surface models and
 * entities outside the subset are refused by name before anything is stored.
 */
import { observeWorker } from './diagnosticSignal';
import type { IgesConversionResult } from '../worker/igesImportWorker';

export function isIgesFileName(name: string): boolean {
  return /\.(?:igs|iges)$/i.test(name);
}

/** The IGES file as the STEP file the import reads, keeping its name. */
export function igesAsStepFile(
  file: File,
  signal?: AbortSignal
): Promise<File> {
  const cancelled = () =>
    new DOMException('IGES conversion was cancelled.', 'AbortError');
  if (signal?.aborted) return Promise.reject(cancelled());
  const worker = observeWorker(
    new Worker(new URL('../worker/igesImportWorker.ts', import.meta.url), {
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
            new Error('IGES conversion exceeded the 120 second time limit.')
          )
        ),
      120_000
    );
    const onAbort = () => finish(() => reject(cancelled()));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = () =>
      finish(() => reject(new Error('IGES conversion worker crashed.')));
    worker.onmessage = (event: MessageEvent<IgesConversionResult>) => {
      const result = event.data;
      finish(() => {
        if (result.ok)
          resolve(
            new File([Uint8Array.from(result.step)], file.name, {
              type: 'model/step',
              lastModified: file.lastModified
            })
          );
        else
          reject(new Error(`${file.name} was not imported: ${result.error}`));
      });
    };
    worker.postMessage(file);
  });
}
