/**
 * The page's one MLS client. `@openzcad/mls` is imported dynamically, and
 * its module Worker (with the ~1 MB WASM) starts only on the first call, so
 * none of it is in the entry chunk or loads for anyone who never opens an
 * encrypted project (ADR-024: "It loads lazily, outside the entry chunk").
 */
import type { Mls } from '@openzcad/mls';

export interface MlsLoader {
  /** The running client, started on first use. */
  get(): Promise<Mls>;
  /** Terminate the Worker (and every session in it); the next `get` restarts it. */
  close(): void;
}

/** One client at a time from `start`; a failed start is retried next time. */
export function createMlsLoader(start: () => Promise<Mls>): MlsLoader {
  let current: Promise<Mls> | null = null;
  return {
    get() {
      if (current) return current;
      const starting = start();
      current = starting;
      starting.catch(() => {
        if (current === starting) current = null;
      });
      return starting;
    },
    close() {
      const closing = current;
      current = null;
      void closing?.then(
        (mls) => mls.close(),
        () => undefined
      );
    }
  };
}

let pageLoader: MlsLoader | null = null;

/** The page-wide loader over the real Worker client. */
export function mlsLoader(): MlsLoader {
  pageLoader ??= createMlsLoader(async () => {
    const { loadMls } = await import('@openzcad/mls');
    return loadMls();
  });
  return pageLoader;
}
