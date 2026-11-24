import type { ProjectDocument, UnitSystem } from '@openzcad/shared';
import { stampProjectViewUnits } from './workspaceSession';

/**
 * I03: view state this device kept outside the document before view state
 * recorded its unit (the remembered camera and section, saved views) is in
 * the unit the device copy is stored in. Records that unit on it, durably,
 * before anything replaces the device copy: once an account copy converted
 * elsewhere has overwritten it, nothing else on this device remembers the
 * unit those views were written in. Already-stamped views are left alone,
 * so running it again (a retried open, a reload) changes nothing. False when
 * the browser refused a write.
 */
export async function stampLegacyViewUnits(
  projectId: string,
  units: UnitSystem
): Promise<boolean> {
  const viewStamped = stampProjectViewUnits(projectId, units);
  const { stampSavedViewUnits } = await import('./savedViews');
  return stampSavedViewUnits(projectId, units) && viewStamped;
}

export interface AdoptAccountCopySteps {
  stampViewUnits(projectId: string, units: UnitSystem): Promise<boolean>;
  saveLocalProject(document: ProjectDocument): Promise<unknown>;
  saveLastSyncedVersion(projectId: string, version: number): Promise<unknown>;
  /** Checked between writes; a stale load stops before the next one. */
  isCurrent?(): boolean;
  /**
   * The browser refused to record the replaced copy's unit on the legacy
   * view state (private mode, a full quota). The account copy is adopted
   * anyway; the caller opens it with that view state's unit unknown.
   */
  viewUnitsUnknown?(projectId: string): void;
}

/**
 * Replaces the device copy with the account copy being opened (startup and
 * project open share this). The device's legacy view state is stamped with
 * the replaced copy's unit first, so a crash or reload at any point between
 * the steps leaves either the old copy beside unstamped views (stamped again
 * on the retry) or stamped views beside the new copy — never unstamped views
 * beside a copy in another unit. False when `isCurrent` stopped it.
 *
 * A refused stamp never blocks the open: the account copy is still adopted
 * and `viewUnitsUnknown` is told, so the legacy view state is treated as in
 * an unknown unit (dropped, or shown unscaled) rather than read in the new
 * one.
 */
export async function adoptAccountCopyLocally(
  adopted: ProjectDocument,
  replaced: ProjectDocument | null,
  steps: AdoptAccountCopySteps
): Promise<boolean> {
  const isCurrent = steps.isCurrent ?? (() => true);
  if (
    replaced &&
    replaced.projectId === adopted.projectId &&
    replaced.units !== adopted.units
  ) {
    const stamped = await steps.stampViewUnits(
      replaced.projectId,
      replaced.units
    );
    if (!isCurrent()) return false;
    if (!stamped) steps.viewUnitsUnknown?.(replaced.projectId);
  }
  const written = await steps.saveLocalProject(adopted);
  if (!isCurrent()) return false;
  // Not written (another tab owns this project's device copy and keeps it
  // current): the device did not come to agree with the account, so the
  // baseline must not say it did.
  if (written === false) return true;
  await steps.saveLastSyncedVersion(adopted.projectId, adopted.version);
  return isCurrent();
}
