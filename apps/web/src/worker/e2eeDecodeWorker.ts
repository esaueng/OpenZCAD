/**
 * ADR-024 decode worker: decrypts, inflates and parses end-to-end encrypted
 * project data off the main thread, under the limits in
 * `../lib/e2ee/decodeJobs.ts`. It holds no state between jobs; the client
 * (`../lib/e2ee/decodeWorker.ts`) runs one job at a time and terminates this
 * worker when a job overruns its budget.
 */
import {
  handleDecodeRequest,
  type DecodeWorkerRequest,
  type DecodeWorkerResponse
} from '../lib/e2ee/decodeJobs';

self.onmessage = async (event: MessageEvent<DecodeWorkerRequest>) => {
  const { response, transfer } = await handleDecodeRequest(event.data);
  try {
    self.postMessage(response, { transfer });
  } catch {
    // A result that cannot be cloned still answers the job, so the client
    // is never left waiting out its budget for a reply that will not come.
    self.postMessage({
      id: response.id,
      ok: false,
      error: { code: null, message: 'The decoded result could not be sent' }
    } satisfies DecodeWorkerResponse);
  }
};
