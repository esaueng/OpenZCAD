import type { BodyId } from '@openzcad/shared';

/** A body a sheet draws that stands in for a failed feature (#2382). */
export interface SheetFailedBody {
  bodyId: BodyId;
  bodyName: string;
  featureName: string;
  /**
   * The configuration row whose build the feature failed in, for a view
   * pinned to a row other than the active one. Absent: the active build.
   */
  rowName?: string;
}

/**
 * The bodies of `bodyIds` that stand in for a feature that failed to
 * rebuild, in `bodyIds` order, each once.
 */
export function sheetFailedBodies(
  bodyIds: readonly BodyId[],
  failed: ReadonlyMap<BodyId, { featureName: string }> | undefined,
  bodyName: (bodyId: BodyId) => string
): SheetFailedBody[] {
  if (!failed || failed.size === 0) return [];
  const out: SheetFailedBody[] = [];
  const seen = new Set<BodyId>();
  for (const bodyId of bodyIds) {
    const entry = failed.get(bodyId);
    if (!entry || seen.has(bodyId)) continue;
    seen.add(bodyId);
    out.push({
      bodyId,
      bodyName: bodyName(bodyId),
      featureName: entry.featureName
    });
  }
  return out;
}

/**
 * What a failure holds back: the export of a current sheet (false), the
 * Update of one that is out of date (true), or moving a view to the
 * configuration row (`'pinning'`).
 */
export type SheetHeldStep = boolean | 'pinning';

function heldStep(step: SheetHeldStep): string {
  return step === 'pinning'
    ? 'draw the view from it'
    : step
      ? 'Update the sheet to export it'
      : 'export';
}

/** A configuration row a sheet draws that could not be built at all. */
export interface SheetRowError {
  rowName: string;
  /** Why, as the build or the configuration table said it. */
  message: string;
}

/**
 * Why a sheet that draws a configuration row the model cannot build (a
 * value naming a parameter since deleted, a build that threw) is neither
 * current nor exported, nor fenced to that row: there is no geometry of the
 * row to draw, so the sheet names it instead of being called up to date
 * while its export is refused.
 */
export function sheetRowErrorMessage(
  errors: readonly SheetRowError[],
  step: SheetHeldStep
): string | null {
  if (errors.length === 0) return null;
  const byRow = new Map(errors.map((entry) => [entry.rowName, entry.message]));
  const names = [...byRow.keys()].map((name) => `“${name}”`);
  const reasons = [...byRow.values()].map((message) =>
    message.trim().replace(/[.\s]+$/, '')
  );
  const one = names.length === 1;
  const list = one
    ? names[0]!
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
  return `The configuration${one ? '' : 's'} ${list} cannot be built, so this sheet would not show ${one ? 'it' : 'them'}: ${reasons.join('; ')}. Change ${one ? 'that configuration’s' : 'those configurations’'} values, then ${heldStep(step)}.`;
}

/**
 * #2382: why a sheet whose model failed to rebuild is neither current nor
 * exported. The geometry it would draw is the failed feature's input — a
 * plate without the bore that failed — so the sheet names the feature and
 * the bodies instead of passing that off as the design. `updating`: what is
 * held back (`SheetHeldStep`). A failure in another configuration row's
 * build names that row: History shows the active row, where the same
 * feature may well build.
 */
export function sheetSourceFailureMessage(
  failed: readonly SheetFailedBody[],
  updating: SheetHeldStep
): string | null {
  if (failed.length === 0) return null;
  const list = (items: readonly string[]) =>
    items.length === 1
      ? items[0]!
      : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
  const rows = new Set(
    failed.flatMap((entry) =>
      entry.rowName === undefined ? [] : [entry.rowName]
    )
  );
  const where = (rowName: string | undefined) =>
    rowName === undefined ? '' : ` in the configuration “${rowName}”`;
  const causes = [
    ...new Set(
      failed.map((entry) => `“${entry.featureName}”${where(entry.rowName)}`)
    )
  ];
  // A body the active row and a pinned one both draw is named once.
  const names = [
    ...new Map(failed.map((entry) => [entry.bodyId, entry.bodyName])).values()
  ];
  const cause =
    causes.length === 1
      ? `“${failed[0]!.featureName}” failed to rebuild${where(failed[0]!.rowName)}`
      : rows.size === 0
        ? `${causes.length} features failed to rebuild (${causes.join(', ')})`
        : `Features failed to rebuild (${causes.join(', ')})`;
  const fix =
    rows.size === 0
      ? 'Fix or suppress the failed feature in History'
      : `Fix or suppress the failed feature, or change ${rows.size === 1 ? 'that configuration’s' : 'those configurations’'} values`;
  return `${cause}, so ${list(names)} ${names.length === 1 ? 'is' : 'are'} not the design${rows.size === 0 ? '' : ' there'} and this sheet would not show it. ${fix}, then ${heldStep(updating)}.`;
}
