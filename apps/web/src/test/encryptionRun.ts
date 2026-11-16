import { vi } from 'vitest';
import type { EncryptionState } from '../lib/e2ee/accountKeys';
import { messageFor, type RunOptions } from '../components/encryption/flow';

/** The page's `run` without its lifetime: work, then any failure said. */
export function testRun(onPageError: (message: string) => void = () => {}) {
  return vi.fn(
    async (
      work: () => Promise<EncryptionState | void>,
      options: RunOptions = {}
    ) => {
      try {
        await work();
        return true;
      } catch (caught) {
        (options.onError ?? onPageError)(messageFor(caught));
        return false;
      }
    }
  );
}
