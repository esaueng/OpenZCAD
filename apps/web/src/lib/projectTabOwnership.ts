/**
 * Which tab owns a project's local storage.
 *
 * Two tabs holding the same project both autosave the whole document to the
 * same IndexedDB key, so the slower one's write simply lands last and the other
 * tab's edits stop existing. Nothing in the document model can detect that
 * afterwards: both writes are well-formed, and the version fence only guards
 * the account copy.
 *
 * A Web Lock settles it before it happens. The first tab to claim a project
 * keeps writing; a second tab is told it does not own the project so it can
 * open read-only instead of competing. Ownership is not permanent — the lock is
 * released when the owning tab closes, navigates, or closes the project, and
 * the waiting tab is promoted then.
 */

const LOCK_PREFIX = 'openzcad-project:';

export interface ProjectOwnershipClaim {
  /** Whether this tab held the project at the moment the claim resolved. */
  readonly owned: boolean;
  /**
   * Gives the project up, promoting whichever tab is waiting for it. While a
   * write holds the claim ({@link retain}) the lock is kept until that write
   * lets go, so the next owner never starts on storage this tab is still
   * writing.
   */
  release(): void;
  /**
   * Keeps the lock through one write: call it before the write starts and
   * the returned function once the write has settled. A release that comes
   * in between takes effect when the last such write lets go. Null once the
   * claim has been released, when there is nothing left to hold.
   */
  retain(): (() => void) | null;
}

/**
 * Claims `projectId` for this tab.
 *
 * Resolves as soon as the answer is known rather than waiting for the lock, so
 * a second tab can render its read-only state immediately. When the claim was
 * refused it keeps waiting in the background, and `onPromoted` runs if this tab
 * later becomes the owner. Releasing before that cancels the wait.
 */
export function claimProjectOwnership(
  projectId: string,
  onPromoted: () => void
): Promise<ProjectOwnershipClaim> {
  const locks = globalThis.navigator?.locks as LockManager | undefined;
  if (!locks) {
    // Without the API there is no way to tell an unattended project from one
    // another tab is editing. Locking the user out of their own work on that
    // suspicion would be worse than the race it avoids.
    return Promise.resolve(
      heldClaim(
        true,
        () => undefined,
        () => undefined
      )
    );
  }

  const name = `${LOCK_PREFIX}${projectId}`;
  let releaseHeld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let released = false;
  const waiting = new AbortController();
  // Remove an abandoned request immediately. Otherwise it can acquire the
  // lock during another tab's reload and hold it until this background tab
  // gets CPU time to run its no-longer-needed callback.
  const abandon = () => {
    released = true;
    waiting.abort();
  };
  const claim = (owned: boolean) => heldClaim(owned, abandon, releaseHeld);

  return new Promise<ProjectOwnershipClaim>((resolveClaim) => {
    void locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (lock) {
          resolveClaim(claim(true));
          await held;
          return;
        }
        // Held elsewhere. Report that first so the workspace can open
        // read-only, then queue: this request is granted when the owning tab
        // goes away, which is exactly when taking over is safe.
        resolveClaim(claim(false));
        await locks.request(
          name,
          { signal: waiting.signal },
          async (queued) => {
            if (released || !queued) {
              return;
            }
            onPromoted();
            await held;
          }
        );
      })
      .catch(() => {
        // A refused lock request is not a reason to make the project
        // unopenable; fall back to the behaviour of a browser without locks.
        resolveClaim(claim(true));
      });
  });
}

/**
 * A claim whose `release` runs `abandon` at once (no longer waiting, no
 * longer promotable) but lets go of the lock (`letGo`) only once no write
 * retains it.
 */
function heldClaim(
  owned: boolean,
  abandon: () => void,
  letGo: () => void
): ProjectOwnershipClaim {
  let released = false;
  let writes = 0;
  const settle = () => {
    if (released && writes === 0) letGo();
  };
  return {
    owned,
    release() {
      released = true;
      abandon();
      settle();
    },
    retain() {
      if (released) return null;
      writes += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        writes -= 1;
        settle();
      };
    }
  };
}
