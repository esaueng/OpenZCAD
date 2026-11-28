import type { UnitSystem } from '@openzcad/shared';
import type { SectionViewSettings } from '@openzcad/viewport';
import { scaledSectionView, storedUnitFactor } from './storedUnitView';

/**
 * L03 save-state preview: while a saved version is on screen in place of the
 * project, the workspace is a reading view of that version. Editing is
 * refused (App's `projectEditDisabledReason`), and so is everything that
 * would read the project instead of the version on screen without saying
 * so: model exports (#2366) and Measure (#2364). What the viewport draws is
 * sized by the version's own stored units, and nothing pinned to the
 * project's geometry is drawn over it (#2365).
 */

/**
 * Why a model export is refused while a saved version is previewed. The
 * exports read the project, so a file written now would silently hold a
 * model other than the one on screen. Branch makes the version a project of
 * its own, which exports it.
 */
export const SAVE_PREVIEW_EXPORT_REASON =
  'A saved version is open for preview. Close it to export the project, or branch it to export that version.';

/**
 * Why Measure does not open while a saved version is previewed. Its picks,
 * readings and kept results belong to the project, so it would measure the
 * model the preview hides; opening it used to close the preview silently.
 */
export const SAVE_PREVIEW_MEASURE_REASON =
  'A saved version is open for preview. Close it to measure the project, or branch it to measure that version.';

/**
 * Why a link without history is not made or updated while a saved version
 * is previewed. It freezes the project's model, not the version on screen.
 */
export const SAVE_PREVIEW_SHARE_REASON =
  'A saved version is open for preview. Close it to share the project, or branch it to share that version.';

/**
 * The stored unit the viewport draws in: the previewed version's, whose
 * coordinates are what is on screen, else the project's. A version saved
 * before a unit conversion holds its lengths in the old unit.
 */
export function viewportStoredUnits(
  liveUnits: UnitSystem,
  preview: { document: { units: UnitSystem } } | null
): UnitSystem {
  return preview ? preview.document.units : liveUnits;
}

/**
 * The measurement pins drawn over the viewport: none over a previewed
 * version. Every kept result was taken on the project's geometry, so over a
 * version's geometry its targets and positions are unresolved.
 */
export function viewportMeasurementAnnotations<T>(
  annotations: T[],
  previewing: boolean
): T[] {
  return previewing ? NO_ANNOTATIONS : annotations;
}

// One empty list, so the viewer's memo of the pins holds across renders.
const NO_ANNOTATIONS: never[] = [];

/**
 * A section cut as the viewport draws it: the project keeps its cut in its
 * own stored unit, and a previewed version saved in another unit is cut at
 * the same physical place (#2365).
 */
export function viewportSectionView(
  section: SectionViewSettings,
  projectUnits: UnitSystem,
  viewportUnits: UnitSystem
): SectionViewSettings {
  return projectUnits === viewportUnits
    ? section
    : scaledSectionView(section, storedUnitFactor(projectUnits, viewportUnits));
}

/**
 * A section cut set over the viewport, as the project keeps it: moved over
 * a previewed version, the cut stays at that physical place once the
 * preview closes rather than keeping the version's number in the project's
 * unit.
 */
export function projectSectionView(
  section: SectionViewSettings,
  projectUnits: UnitSystem,
  viewportUnits: UnitSystem
): SectionViewSettings {
  return projectUnits === viewportUnits
    ? section
    : scaledSectionView(section, storedUnitFactor(viewportUnits, projectUnits));
}
