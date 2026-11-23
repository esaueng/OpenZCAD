import type { ProjectDocument, UnitSystem, UserId } from '@openzcad/shared';
import type { UnitsConversionPreparation } from '@openzcad/kernel-adapter/exact';

import { observeWorker } from './diagnosticSignal';
import { describeWorkerFailure } from './workerFailure';
import { isChunkLoadError } from './staleChunk';
import type {
  UnitsConversionWorkerRequest,
  UnitsConversionWorkerResult
} from '../worker/unitsConversionWorker';

function abortError(): Error {
  const error = new Error('The stored-unit conversion check was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * I03 phase 5: checks converting `document` to `to` in a disposable worker
 * and returns the preview (counts, rewritten expressions, warnings, the
 * undo estimate and the payload to submit) or every refusal. Nothing
 * changes until the caller passes a successful result to
 * `commitUnitsConversion`. Aborting terminates the worker.
 */
export function prepareUnitsConversionInWorker(
  document: ProjectDocument,
  to: UnitSystem,
  /** `actorUserId`: the actor of the manager the conversion commits through. */
  options: { actorUserId: UserId; signal?: AbortSignal }
): Promise<UnitsConversionPreparation> {
  const { signal, actorUserId } = options;
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  const worker = observeWorker(
    new Worker(new URL('../worker/unitsConversionWorker.ts', import.meta.url), {
      type: 'module'
    })
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
      finish(() => {
        void describeWorkerFailure(
          'The stored-unit conversion worker crashed.'
        ).then(({ message }) => reject(new Error(message)));
      });
    };
    worker.onmessageerror = () => {
      finish(() =>
        reject(
          new Error(
            'The stored-unit conversion check returned unreadable data.'
          )
        )
      );
    };
    worker.onmessage = (event: MessageEvent<UnitsConversionWorkerResult>) => {
      const result = event.data;
      if (result.requestId !== requestId) {
        return;
      }
      if (result.ok) {
        finish(() => resolve(result.preparation));
      } else if (isChunkLoadError(result.error)) {
        finish(() => {
          void describeWorkerFailure(result.error).then(({ message }) =>
            reject(new Error(message))
          );
        });
      } else {
        finish(() => reject(new Error(result.error)));
      }
    };
    const request: UnitsConversionWorkerRequest = {
      type: 'prepare',
      requestId,
      document,
      to,
      actorUserId
    };
    worker.postMessage(request);
  });
}
