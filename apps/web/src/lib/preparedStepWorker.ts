import type { ProjectDocument } from '@openzcad/shared';
import type {
  GeometryWorkerRequest,
  GeometryWorkerResult
} from '../worker/geometryWorker';
import { documentForRebuild } from './meshTransport';
import { isChunkLoadError } from './staleChunk';
import { describeWorkerFailure } from './workerFailure';

/** A cancellable, independent import rebuild. Its worker may become the live
 * worker only when the commit consumes this exact result. */
export function prepareStepWorker(
  worker: Worker,
  document: ProjectDocument,
  signal: AbortSignal
) {
  const requestId = crypto.randomUUID();
  let owned: Worker | null = worker;
  let result: ProjectDocument['derived'] | undefined;
  let rejectPending: (error: Error) => void;
  const detach = () => {
    signal.removeEventListener('abort', cancel);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
  };
  const retire = () => {
    if (!owned) return false;
    detach();
    owned.terminate();
    owned = null;
    return true;
  };
  const close = (error: Error) => {
    if (retire()) rejectPending(error);
  };
  const reportFailure = (message: string) => {
    // Archive completion can consume the result while failure diagnosis awaits
    // the deployment check. The crashed worker is already ineligible.
    if (!retire()) return;
    void describeWorkerFailure(message).then(
      (failure) => rejectPending(new Error(failure.message)),
      () => rejectPending(new Error(message))
    );
  };
  const cancel = () =>
    close(
      new DOMException('Exact import rebuild was cancelled.', 'AbortError')
    );
  const promise = new Promise<ProjectDocument['derived']>((resolve, reject) => {
    rejectPending = reject;
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }: MessageEvent<GeometryWorkerResult>) => {
      if (data.type !== 'sync' || data.requestId !== requestId) return;
      if (!data.ok) {
        if (isChunkLoadError(data.error)) {
          reportFailure(data.error);
        } else {
          close(new Error(data.error));
        }
        return;
      }
      if (!data.transient) result = data.derived;
      resolve(data.derived);
    };
    worker.onerror = () =>
      reportFailure('Exact import rebuild worker crashed.');
    worker.onmessageerror = () =>
      close(new Error('Exact import rebuild returned unreadable data.'));
    try {
      worker.postMessage({
        type: 'sync',
        requestId,
        document: documentForRebuild(document)
      } satisfies GeometryWorkerRequest);
    } catch (error) {
      close(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return {
    promise,
    signal,
    cancel,
    take(committed: ProjectDocument, derived: ProjectDocument['derived']) {
      if (
        !owned ||
        committed.projectId !== document.projectId ||
        derived !== result
      )
        return null;
      detach();
      owned = null;
      return worker;
    }
  };
}
