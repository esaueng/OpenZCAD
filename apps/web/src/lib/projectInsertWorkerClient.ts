import type { UserId } from '@openzcad/shared';

import { observeWorker } from './diagnosticSignal';
import { MAX_PROJECT_BACKUP_BYTES } from './projectBackup';
import { describeWorkerFailure } from './workerFailure';
import type {
  PreparedProjectInsert,
  ProjectInsertWorkerRequest,
  ProjectInsertWorkerResult
} from '../worker/projectInsertWorker';

function abortError(): Error {
  const error = new Error('Inserting the project was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Reads a project backup and writes its bodies as one STEP, in a disposable
 * worker with its own kernel. Aborting terminates the worker, which stops
 * even a synchronous rebuild and leaves nothing behind.
 */
export function prepareProjectInsertInWorker(
  file: File,
  ownerUserId: UserId,
  signal?: AbortSignal
): Promise<PreparedProjectInsert> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (file.size > MAX_PROJECT_BACKUP_BYTES)
    return Promise.reject(
      new Error('Project backup exceeds the 256 MB limit.')
    );
  const worker = observeWorker(
    new Worker(new URL('../worker/projectInsertWorker.ts', import.meta.url), {
      type: 'module'
    })
  );
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = () =>
      finish(() => {
        void describeWorkerFailure(
          'The project could not be rebuilt for inserting.'
        ).then(({ message }) => reject(new Error(message)));
      });
    worker.onmessageerror = () =>
      finish(() =>
        reject(new Error('Reading the project returned unreadable data.'))
      );
    worker.onmessage = (event: MessageEvent<ProjectInsertWorkerResult>) => {
      const result = event.data;
      if (result.requestId !== requestId) return;
      finish(() => {
        if (!result.ok) reject(new Error(result.error));
        else if (typeof result.prepared?.sourceProjectId !== 'string')
          reject(new Error('Reading the project returned unreadable data.'));
        else resolve(result.prepared);
      });
    };
    const request: ProjectInsertWorkerRequest = {
      type: 'insert',
      requestId,
      file,
      ownerUserId
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error('Reading the project could not start.')
        )
      );
    }
  });
}
