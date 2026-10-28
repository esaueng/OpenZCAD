import { Mls } from '../src/client';
import { connectEngine } from '../src/protocol';

/** Real module Worker with an opt-in test protocol; never used by the app. */
export function loadTestMls(): Mls {
  const worker = new Worker(new URL('./test-worker.ts', import.meta.url), {
    type: 'module'
  });
  const connection = connectEngine(worker, { insecureTestMethods: true });
  worker.addEventListener('error', (event) =>
    connection.fail(event.message || 'test Worker failed')
  );
  worker.addEventListener('messageerror', () =>
    connection.fail('test Worker message failed')
  );
  return new Mls(connection.api, () => {
    connection.fail('closed');
    worker.terminate();
  });
}
