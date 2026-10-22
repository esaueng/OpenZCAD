/**
 * ADR-024's MLS group-key layer (roadmap L11): mls-rs 0.56 with the
 * RustCrypto provider, cipher suite 0x0002, compiled to WASM and run in a
 * lazily started module Worker. Nothing in the application imports this
 * package yet; Phases 3 and 5 wire it in.
 *
 * The test hook `insecureSkipSendChecksForTests` and the in-process engine
 * are deliberately not exported here.
 */
import { Mls } from './client';
import { connectEngine } from './protocol';

export { Mls, MlsSession } from './client';
export { DEFAULT_REJOIN_WINDOW } from './constants';
export {
  MlsError,
  isMlsError,
  type MlsErrorKind,
  type PolicyReason,
  type PolicyReasonCode
} from './errors';
export { assertStateKey, generateStateKey } from './sealed';
export type * from './types';

/**
 * Start the MLS Worker. The WASM (about 1 MB) is fetched and compiled only
 * now, outside the entry chunk.
 */
export function loadMls(): Mls {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'openzcad-mls'
  });
  const connection = connectEngine(worker);
  worker.addEventListener('error', (event) =>
    connection.fail(`the MLS Worker failed: ${event.message || 'error'}`)
  );
  worker.addEventListener('messageerror', () =>
    connection.fail('the MLS Worker sent a message that could not be read')
  );
  return new Mls(connection.api, () => {
    connection.fail('the MLS Worker was closed');
    worker.terminate();
  });
}
