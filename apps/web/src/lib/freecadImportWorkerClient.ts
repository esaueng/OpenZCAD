import type { UnitSystem } from '@openzcad/shared';
import type {
  FreecadImportWorkerRequest,
  FreecadImportWorkerResult
} from '../worker/freecadImportWorker';

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 120_000;
function abortError(): DOMException {
  return new DOMException('FreeCAD import was cancelled.', 'AbortError');
}

/** A fresh worker bounds synchronous ZIP/BREP/WASM work, even on cancellation. */
export function convertFreecadFile(
  file: File,
  options: {
    units?: UnitSystem;
    signal?: AbortSignal;
    onProgress?(message: string): void;
  } = {}
): Promise<{ stepFile: File; solidCount: number }> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  if (file.size > MAX_ARCHIVE_BYTES)
    return Promise.reject(new Error('FreeCAD import is limited to 32 MB.'));
  const worker = new Worker(
    new URL('../worker/freecadImportWorker.ts', import.meta.url),
    { type: 'module' }
  );
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              'FreeCAD conversion timed out. Export the model as STEP in FreeCAD.'
            )
          )
        ),
      CONVERSION_TIMEOUT_MS
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = () =>
      finish(() => reject(new Error('FreeCAD converter worker crashed.')));
    worker.onmessageerror = () =>
      finish(() =>
        reject(new Error('FreeCAD converter returned unreadable data.'))
      );
    worker.onmessage = (event: MessageEvent<FreecadImportWorkerResult>) => {
      const result = event.data;
      if (result.requestId !== requestId) return;
      if (result.type === 'progress') {
        options.onProgress?.(result.message);
      } else if (!result.ok) {
        finish(() => reject(new Error(result.error)));
      } else {
        finish(() =>
          resolve({
            solidCount: result.solidCount,
            stepFile: new File([result.stepBytes], `${file.name}.step`, {
              type: 'model/step'
            })
          })
        );
      }
    };
    try {
      worker.postMessage({
        requestId,
        file,
        units: options.units ?? 'mm'
      } satisfies FreecadImportWorkerRequest);
    } catch (error) {
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error('FreeCAD conversion could not start.')
        )
      );
    }
  });
}
