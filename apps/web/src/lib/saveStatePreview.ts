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
 *
 * #2422 makes that one gate rather than a check per path:
 * - every output of the project is refused by `previewLiveOutputRefusal`;
 * - the project's view is held, not written (`useProjectView`'s `suspend`);
 * - a readout takes the stored unit of the document its geometry is from
 *   (`viewportStoredUnits`, and the Inspector's own documents);
 * - the viewport's overlays come from `viewportOverlayDocument`;
 * - a preview still building ends when `savePreviewContextKey` changes.
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
 * Why the project is not saved to the account while a saved version is
 * previewed: the upload is the project's copy, not the version on screen.
 */
export const SAVE_PREVIEW_ACCOUNT_REASON =
  'A saved version is open for preview. Close it to save the project to your account, or branch it to save that version.';

/**
 * Why a named view is not saved, renamed or deleted while a saved version
 * is previewed: the list is the project's, and the camera on screen frames
 * the version, in its stored unit.
 */
export const SAVE_PREVIEW_VIEW_REASON =
  'A saved version is open for preview. Close it to change the project’s saved views.';

/**
 * The central preview gate (#2422). Every action that hands the project's
 * model, or a view of it, to somewhere that outlives the preview is named
 * here with the refusal it gets while a saved version is on screen. Each
 * is refused through `previewLiveOutputRefusal`, never by a check of its
 * own, so a new output is covered by adding its name (and the coverage
 * test fails until the name is routed).
 *
 * Not listed, because they read the version on screen or do not read the
 * model at all: the PNG of the view and the section DXF (drawn from the
 * viewport, which shows the version), and the complete `.openzcad` backup
 * (labeled as the whole project with every save point).
 */
export const PREVIEW_LIVE_OUTPUTS = {
  'export-step': SAVE_PREVIEW_EXPORT_REASON,
  'export-iges': SAVE_PREVIEW_EXPORT_REASON,
  'export-mesh': SAVE_PREVIEW_EXPORT_REASON,
  'open-in-slicer': SAVE_PREVIEW_EXPORT_REASON,
  'export-cnc-layout': SAVE_PREVIEW_EXPORT_REASON,
  'export-face-dxf': SAVE_PREVIEW_EXPORT_REASON,
  'export-sketch': SAVE_PREVIEW_EXPORT_REASON,
  'export-flat-pattern': SAVE_PREVIEW_EXPORT_REASON,
  'check-printability': SAVE_PREVIEW_EXPORT_REASON,
  'share-link': SAVE_PREVIEW_SHARE_REASON,
  'share-frozen-model': SAVE_PREVIEW_SHARE_REASON,
  'share-invite': SAVE_PREVIEW_SHARE_REASON,
  'save-to-account': SAVE_PREVIEW_ACCOUNT_REASON,
  'saved-views': SAVE_PREVIEW_VIEW_REASON
} as const;

export type PreviewLiveOutput = keyof typeof PREVIEW_LIVE_OUTPUTS;

/**
 * The one predicate of the gate: why `output` is refused now, or null when
 * no saved version is previewed.
 */
export function previewLiveOutputRefusal(
  previewing: boolean,
  output: PreviewLiveOutput
): string | null {
  return previewing ? PREVIEW_LIVE_OUTPUTS[output] : null;
}

/**
 * What a preview still building was asked over. Anything that leaves that
 * place (another workspace, a tool, a sketch, an edit or Measure opened,
 * the Revisions panel closed or moved, another project) ends the request.
 * It is compared when the build lands, so no path has to remember to
 * cancel a pending preview.
 */
export function savePreviewContextKey(context: {
  projectId: string | null;
  workspaceMode: string | null;
  /** Where the Revisions panel is shown, however the layout says it. */
  revisions: unknown;
  tool: string | null;
  sketching: boolean;
  editing: boolean;
  measuring: boolean;
}): string {
  return JSON.stringify([
    context.projectId,
    context.workspaceMode,
    context.revisions,
    context.tool,
    context.sketching,
    context.editing,
    context.measuring
  ]);
}

/**
 * The document the viewport's overlays are read from: the previewed
 * version's own sketches (with what consumes them), reference images and
 * datums, else the project's. The project's later ones are not drawn over
 * a version that does not have them.
 */
export function viewportOverlayDocument<T>(
  live: T,
  preview: { document: T } | null
): T {
  return preview ? preview.document : live;
}

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
