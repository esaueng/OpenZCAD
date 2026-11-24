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
 * the waiting tab is promoted then. It can also be handed over on request
 * (`projectTabHandoff.ts`): the owner yields, and the tab that asked — the
 * one holding the handoff ticket — is the one promoted.
 */

const LOCK_PREFIX = 'openzcad-project:';
const HANDOFF_TICKET_PREFIX = 'openzcad-project-handoff:';

/**
 * The lock a tab holds while it asks the owner to hand a project over. The
 * owner's release grants the project lock to whichever tab queued first,
 * which need not be the one that asked; a waiting tab granted the project
 * while another holds this ticket gives it straight back and queues again,
 * so the asking tab is the one that ends up with it.
 */
export function projectHandoffTicketName(projectId: string): string {
  return `${HANDOFF_TICKET_PREFIX}${projectId}`;
}

export interface ProjectOwnershipOptions {
  /** Whether this tab holds the project's handoff ticket right now. */
  ticketHeldHere?: () => boolean;
}

/** Whether another tab holds the handoff ticket for `projectId`. */
async function handoffPendingElsewhere(
  locks: LockManager,
  projectId: string,
  options: ProjectOwnershipOptions
): Promise<boolean> {
  if (options.ticketHeldHere?.()) return false;
  try {
    return await locks.request(
      projectHandoffTicketName(projectId),
      { ifAvailable: true },
      async (ticket) => ticket === null
    );
  } catch {
    return false;
  }
}

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
  /**
   * Settles once this claim no longer holds or waits for the lock: after
   * {@link release}, when the next tab can be granted it.
   */
  readonly freed: Promise<void>;
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
  onPromoted: () => void,
  options: ProjectOwnershipOptions = {}
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
        () => undefined,
        Promise.resolve()
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
  let resolveFreed: () => void = () => undefined;
  const freed = new Promise<void>((resolve) => {
    resolveFreed = resolve;
  });
  const claim = (owned: boolean) =>
    heldClaim(owned, abandon, releaseHeld, freed);
  // Granted when the owning tab goes away or yields. A grant made while
  // another tab holds the handoff ticket belongs to that tab: give it
  // straight back and queue again behind it.
  const queueForPromotion = async (): Promise<void> => {
    for (;;) {
      let requeue = false;
      await locks.request(name, { signal: waiting.signal }, async (queued) => {
        if (released || !queued) return;
        if (await handoffPendingElsewhere(locks, projectId, options)) {
          requeue = true;
          return;
        }
        if (released) return;
        onPromoted();
        await held;
      });
      if (!requeue || released) return;
    }
  };

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
        await queueForPromotion();
      })
      .catch(() => {
        // A refused lock request is not a reason to make the project
        // unopenable; fall back to the behaviour of a browser without locks.
        resolveClaim(claim(true));
      })
      .finally(resolveFreed);
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
  letGo: () => void,
  freed: Promise<void>
): ProjectOwnershipClaim {
  let released = false;
  let writes = 0;
  const settle = () => {
    if (released && writes === 0) letGo();
  };
  return {
    owned,
    freed,
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

/**
 * This tab's claim on a project's device storage, as the workspace tracks
 * it over {@link claimProjectOwnership}: exactly one tab writes a project
 * there.
 */
export interface ProjectStorageOwnership {
  projectId: string;
  /** Settles once the claim has been answered. */
  settled: Promise<unknown>;
  /**
   * True once this tab holds the project; false while waiting, refused, or
   * once the workspace has let the claim go.
   */
  owned: boolean;
  /**
   * Keeps the claim's lock held through one write (see
   * {@link ProjectOwnershipClaim.retain}): the returned function lets go.
   * Null when there is no held claim to keep.
   */
  retain(): (() => void) | null;
}

/**
 * Write access to a project's device storage, confirmed for one write. The
 * claim's lock stays held until {@link release}, so another tab cannot take
 * the project while the write is in flight; {@link held} says,
 * synchronously, whether the claim confirmed is still this tab's.
 */
export interface ProjectStorageWriteAccess {
  /** Still the same claim, for the same project, still owned. */
  held(): boolean;
  /** Lets go of the lock hold; safe to call more than once. */
  release(): void;
}

/**
 * Waits for this tab's storage claim on `projectId` and grants write access
 * only once it is confirmed held: a write must not land on a copy another
 * tab owns (and may have saved newer work to). A claim for another project,
 * or none at all, refuses (null) rather than waits. The access holds the
 * claim's lock until released, so a navigation that gives the project up
 * mid-write hands it on only once the write has landed.
 *
 * The local store has no version stamp to guard a write with, so this hold
 * is what keeps a late write from landing on top of the next owner's save.
 */
export async function projectStorageWriteAccess(
  read: () => ProjectStorageOwnership | null | undefined,
  projectId: string
): Promise<ProjectStorageWriteAccess | null> {
  const claim = read();
  if (!claim || claim.projectId !== projectId) return null;
  await claim.settled;
  const held = () => {
    const current = read();
    return (
      current === claim && current.projectId === projectId && current.owned
    );
  };
  if (!held()) return null;
  const letGo = claim.retain();
  if (!letGo) return null;
  return { held, release: letGo };
}

/**
 * Runs `write` under {@link projectStorageWriteAccess}: true once it has
 * landed with the claim held throughout its start, false (nothing written)
 * when this tab does not hold `projectId`. The lock is kept until the write
 * settles, failed writes included; a failure is rethrown.
 */
export async function writeOwnedProjectStorage(
  read: () => ProjectStorageOwnership | null | undefined,
  projectId: string,
  write: () => Promise<void>
): Promise<boolean> {
  const access = await projectStorageWriteAccess(read, projectId);
  if (!access) return false;
  // The grant reached this continuation a microtask after it was checked;
  // the workspace may have let the claim go in between. Checked again with
  // nothing awaited before the write starts.
  if (!access.held()) {
    access.release();
    return false;
  }
  try {
    await write();
  } finally {
    access.release();
  }
  return true;
}

/**
 * {@link writeOwnedProjectStorage} for autosave, saying why nothing was
 * written: `false` only for the `untouched` document as the workspace
 * opened it, while another tab holds the project (what is stored is that
 * tab's copy, and this read-only tab has nothing of its own to save).
 * Anything else not written is `'refused'`: an edit made before the claim
 * was answered, or a write after this tab let the claim go, is work that
 * is not on this device.
 */
export async function writeLocalProjectUnderClaim(
  read: () => ProjectStorageOwnership | null | undefined,
  projectId: string,
  write: () => Promise<void>,
  untouched: boolean
): Promise<boolean | 'refused'> {
  if (await writeOwnedProjectStorage(read, projectId, write)) return true;
  const claim = read();
  return untouched && claim?.projectId === projectId && !claim.owned
    ? false
    : 'refused';
}

/** A project's storage claim as the workspace holds it while it is open. */
export interface ProjectStorageTracker {
  readonly ownership: ProjectStorageOwnership;
  /**
   * Lets the claim go as the workspace leaves the project. A write still in
   * flight keeps the lock until it lands ({@link ProjectStorageOwnership.retain}).
   */
  giveUp(): void;
  /**
   * Hands the project to the next tab while staying on it: stops owning at
   * once (so no new write starts), lets the lock go once every retained
   * write has landed, then queues again to be promoted later. False, and
   * nothing changed, when this tab does not own the project.
   */
  yieldOwnership(): Promise<boolean>;
}

/**
 * Claims `projectId` ({@link claimProjectOwnership}) and tracks the answer
 * as a {@link ProjectStorageOwnership}: `onAnswered` runs once the first
 * claim resolves, `onPromoted` each time this tab takes the project over
 * later (after another tab let it go, or after this one yielded it and got
 * it back). Neither runs after {@link ProjectStorageTracker.giveUp}.
 */
export function trackProjectStorage(
  projectId: string,
  handlers: {
    onAnswered(owned: boolean): void;
    onPromoted(): void;
  },
  options: ProjectOwnershipOptions = {}
): ProjectStorageTracker {
  let given = false;
  let yielding = false;
  let generation = 0;
  let claim: ProjectOwnershipClaim | null = null;
  const ownership: ProjectStorageOwnership = {
    projectId,
    owned: false,
    settled: Promise.resolve(),
    retain: () => (ownership.owned && claim ? claim.retain() : null)
  };
  const startClaim = (first: boolean): Promise<void> => {
    const current = ++generation;
    const live = () => !given && current === generation;
    return claimProjectOwnership(
      projectId,
      () => {
        if (!live()) return;
        ownership.owned = true;
        handlers.onPromoted();
      },
      options
    ).then((result) => {
      if (!live()) {
        result.release();
        return;
      }
      claim = result;
      ownership.owned = result.owned;
      if (first) handlers.onAnswered(result.owned);
      else if (result.owned) handlers.onPromoted();
    });
  };
  ownership.settled = startClaim(true);
  return {
    ownership,
    giveUp() {
      if (given) return;
      given = true;
      ownership.owned = false;
      claim?.release();
    },
    async yieldOwnership() {
      if (given || yielding || !ownership.owned || !claim) return false;
      yielding = true;
      try {
        ownership.owned = false;
        const previous = claim;
        claim = null;
        previous.release();
        await previous.freed;
        if (given) return true;
        ownership.settled = startClaim(false);
        await ownership.settled;
        return true;
      } finally {
        yielding = false;
      }
    }
  };
}
