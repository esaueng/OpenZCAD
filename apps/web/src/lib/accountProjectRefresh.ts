import type { ProjectDocument } from '@openzcad/shared';

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
