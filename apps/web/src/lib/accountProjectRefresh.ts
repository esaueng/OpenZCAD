import type { ProjectDocument } from '@openzcad/shared';
import { isProjectDocumentUnavailableError } from './api';

/**
 * What a freshness poll fetched for the open project: the newer account
 * document, a verdict that the account copy needs repair, or nothing to act
 * on (an outage or a missing copy, which the next poll or write rediscovers).
 * A version this browser cannot open is reported as an unreadable account
 * copy (ADR-024 Phase 1), and the poll must stop sync the way opening does.
 */
export async function loadAccountRefresh(
  load: () => Promise<ProjectDocument | null>
): Promise<
  | { kind: 'document'; document: ProjectDocument }
  | { kind: 'repair'; error: Error }
  | { kind: 'skip' }
> {
  try {
    const document = await load();
    return document ? { kind: 'document', document } : { kind: 'skip' };
  } catch (error) {
    return isProjectDocumentUnavailableError(error)
      ? { kind: 'repair', error }
      : { kind: 'skip' };
  }
}

/** Commit a pulled account document only while its local baseline is unchanged. */
export async function applyAccountProjectRefresh(options: {
  before: ProjectDocument;
  remote: ProjectDocument;
  current: () => ProjectDocument | null;
  isActive: () => boolean;
  hasPendingChanges: () => boolean;
  saveLocal: (document: ProjectDocument) => Promise<void>;
  apply: (document: ProjectDocument) => void;
  saveBaseline: (document: ProjectDocument) => Promise<void>;
  onDiverged: (document: ProjectDocument) => void;
}): Promise<'applied' | 'stale' | 'diverged'> {
  const { before, remote, current } = options;
  const unchanged = (document: ProjectDocument | null) =>
    document?.projectId === before.projectId &&
    document.version === before.version &&
    !options.hasPendingChanges();
  if (!options.isActive() || !unchanged(current())) return 'stale';

  await options.saveLocal(remote);
  let live = current();
  if (!options.isActive() || live?.projectId !== before.projectId)
    return 'stale';
  if (!unchanged(live)) {
    // The pulled copy is not a baseline for edits made against the old one.
    // Stop account writes before restoring the device copy; never acknowledge
    // the unseen remote version, which would let a retry overwrite its work.
    options.onDiverged(live);
    do {
      const restoring = live;
      await options.saveLocal(restoring);
      live = current();
      if (
        live?.projectId !== before.projectId ||
        live.version === restoring.version
      )
        break;
    } while (live);
    return 'diverged';
  }

  // No await between the final check, swapping the model, and acknowledging it.
  // Any edits during baseline persistence now descend from this account copy.
  options.apply(remote);
  await options.saveBaseline(remote);
  return 'applied';
}
