import { fetchBuildCommit } from './buildVersionWatch';
import { trackOutOfMemory } from './diagnosticSignal';
import {
  isChunkLoadError,
  reportStaleChunk,
  STALE_CHUNK_MESSAGE
} from './staleChunk';

/** Worker script load errors arrive as generic error events, without a usable
 * exception. Verify a deployment change before blaming a newer build; an
 * offline tab or an actual kernel crash must retain its original diagnosis.
 */
export async function describeWorkerFailure(
  message: string
): Promise<{ message: string; reloadRequired: boolean }> {
  // Only the classification is counted; the message stays in this page.
  trackOutOfMemory(message);
  const runningCommit = import.meta.env.OZ_BUILD_COMMIT;
  const chunkFailed = isChunkLoadError(message);
  const deployedCommit =
    !chunkFailed && runningCommit ? await fetchBuildCommit() : null;
  if (
    chunkFailed ||
    (deployedCommit !== null && deployedCommit !== runningCommit)
  ) {
    reportStaleChunk();
    return { message: STALE_CHUNK_MESSAGE, reloadRequired: true };
  }
  return { message, reloadRequired: false };
}
