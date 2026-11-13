import { useEffect, useRef } from 'react';
import type { LibraryFolders } from './libraryFolders';
import { watchLibraryFreshness } from './libraryRefresh';

/** Lets a burst of shelf edits (a drag, a rename) go up as one write. */
const PUSH_DELAY_MS = 2_000;
/** Accounts that stopped syncing folders during this visit. */
const stoppedAccounts = new Set<string>();

/**
 * Syncs the signed-in account's folders while the library is shown: on
 * arrival, shortly after each shelf edit, and whenever the library refreshes
 * from the account. Signed out, it does nothing.
 */
export function useLibraryFolderCloudSync(
  accountId: string | null | undefined,
  folders: LibraryFolders
) {
  const request = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!accountId || stoppedAccounts.has(accountId)) return;
    let cancelled = false;
    let running: Promise<void> | null = null;
    let again = false;
    const stop = () => {
      stoppedAccounts.add(accountId);
      cancelled = true;
    };
    const run = async (): Promise<void> => {
      if (cancelled) return;
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        try {
          // The sync itself loads with its first round: signed out, or
          // before the shelf is shown, nothing here needs it.
          const { syncAccountLibraryFolders } =
            await import('./libraryFolderCloudSync');
          if (await syncAccountLibraryFolders(accountId, () => cancelled))
            stop();
        } catch {
          // Its chunk did not load (offline): the next try loads it again.
        }
      })();
      try {
        await running;
      } finally {
        running = null;
        if (again && !cancelled) {
          again = false;
          void run();
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    request.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), PUSH_DELAY_MS);
    };
    void run();
    const stopWatching = watchLibraryFreshness(run);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      request.current = null;
      stopWatching();
    };
  }, [accountId]);

  // A shelf edit (or another tab's) goes up shortly after it lands. The
  // sync's own write also arrives here and costs one cheap no-op round.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    request.current?.();
  }, [folders]);
}
