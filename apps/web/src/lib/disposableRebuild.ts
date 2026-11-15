import type { ProjectDocument } from '@openzcad/shared';
import {
  isChunkLoadError,
  isOffline,
  OFFLINE_CHUNK_MESSAGE,
  reportStaleChunk,
  STALE_CHUNK_MESSAGE
} from './staleChunk';
import type * as RebuildClientModule from './importRebuildWorkerClient';

type RebuildClient = typeof RebuildClientModule;

/**
 * An exact candidate rebuild in a disposable worker, with the worker's client
 * loaded on the first import or pattern Done that needs one (it is off the
 * entry chunk).
 *
 * A client that cannot load (offline, or an older deployment's chunk gone)
 * rejects with the app's own sentence for that rather than the browser's
 * module error, so the validated run reports it as it would any refusal: the
 * card stays open with the reason and nothing is committed.
 */
export async function rebuildInDisposableWorker(
  document: ProjectDocument,
  signal: AbortSignal,
  load: () => Promise<RebuildClient> = () =>
    import('./importRebuildWorkerClient')
): Promise<ProjectDocument['derived']> {
  let client: RebuildClient;
  try {
    client = await load();
  } catch (error) {
    if (!isChunkLoadError(error)) throw error;
    if (isOffline()) throw new Error(OFFLINE_CHUNK_MESSAGE, { cause: error });
    reportStaleChunk(error);
    throw new Error(STALE_CHUNK_MESSAGE, { cause: error });
  }
  return client.rebuildImportInDisposableWorker(document, signal);
}
