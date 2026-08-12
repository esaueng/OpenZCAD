/**
 * Who has moved since this device and the account last agreed.
 *
 * `unknown-baseline` is its own answer rather than a guess. It means the device
 * cannot tell what it last agreed with — browser storage was cleared, or the
 * project was opened on a device that never synced it — and the honest response
 * is the conservative one, not an assumption in either direction.
 */
export type ProjectSyncAction =
  'in-sync' | 'push' | 'pull' | 'conflict' | 'unknown-baseline';

export interface ProjectSyncInputs {
  /** The version of the document this device is holding. */
  localVersion: number;
  /** The version the account reports. */
  accountVersion: number;
  /**
   * The last version this device and the account are known to have agreed on.
   * Null when the device has no record — see `unknown-baseline`.
   */
  lastSyncedVersion: number | null;
  /**
   * Edits this device has made but not yet written to the account. A device can
   * be ahead of its baseline without them (a write landed but the baseline was
   * not updated), and behind with them, so this is not derivable from versions.
   */
  hasUnsentChanges: boolean;
}

/**
 * Decides what to do about a project whose account copy may have moved.
 *
 * This exists because comparing versions and then timestamps — which is what
 * open-time reconciliation used to do — cannot tell a device that is merely
 * behind from two devices that both moved. It resolves the second case by
 * dropping one side on the authority of a device clock. With a recorded
 * baseline the ambiguous case becomes detectable, and detectable means
 * recoverable.
 */
export function decideProjectSync({
  localVersion,
  accountVersion,
  lastSyncedVersion,
  hasUnsentChanges
}: ProjectSyncInputs): ProjectSyncAction {
  if (lastSyncedVersion === null) {
    // Without a baseline, version equality proves nothing: two devices can
    // reach the same version through different edits. The open-time
    // reconciler compares canonical document content and records a baseline;
    // this version-only decision must refuse to guess until that happens.
    return 'unknown-baseline';
  }

  const localMoved = hasUnsentChanges || localVersion !== lastSyncedVersion;
  const accountMoved = accountVersion !== lastSyncedVersion;

  if (localMoved && accountMoved) {
    return 'conflict';
  }
  if (localMoved) {
    return 'push';
  }
  if (accountMoved) {
    return 'pull';
  }
  return 'in-sync';
}

/**
 * Whether a freshness check is worth making right now. Polling exists to narrow
 * the window in which two devices can diverge unnoticed; it should not run when
 * there is no window — no project, no account, or nothing to compare against.
 */
export function shouldPollForFreshness(input: {
  projectId: string | null;
  signedIn: boolean;
  accountHoldsProject: boolean;
  /** A halted controller is already waiting on a decision; polling adds noise. */
  awaitingResolution: boolean;
}): boolean {
  return (
    input.projectId !== null &&
    input.signedIn &&
    input.accountHoldsProject &&
    !input.awaitingResolution
  );
}
