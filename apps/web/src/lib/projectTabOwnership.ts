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
  /** Gives the project up, promoting whichever tab is waiting for it. */
  release(): void;
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
    return Promise.resolve({ owned: true, release: () => undefined });
  }

  const name = `${LOCK_PREFIX}${projectId}`;
  let releaseHeld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let released = false;
  const release = () => {
    released = true;
    releaseHeld();
  };

  return new Promise<ProjectOwnershipClaim>((resolveClaim) => {
    void locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (lock) {
          resolveClaim({ owned: true, release });
          await held;
          return;
        }
        // Held elsewhere. Report that first so the workspace can open
        // read-only, then queue: this request is granted when the owning tab
        // goes away, which is exactly when taking over is safe.
        resolveClaim({ owned: false, release });
        await locks.request(name, async (queued) => {
          if (released || !queued) {
            return;
          }
          onPromoted();
          await held;
        });
      })
      .catch(() => {
        // A refused lock request is not a reason to make the project
        // unopenable; fall back to the behaviour of a browser without locks.
        resolveClaim({ owned: true, release });
      });
  });
}
