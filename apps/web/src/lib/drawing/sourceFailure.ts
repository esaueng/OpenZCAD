import type { BodyId } from '@openzcad/shared';

/** A body a sheet draws that stands in for a failed feature (#2382). */
export interface SheetFailedBody {
  bodyId: BodyId;
  bodyName: string;
  featureName: string;
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
 * #2382: why a sheet whose model failed to rebuild is neither current nor
 * exported. The geometry it would draw is the failed feature's input — a
 * plate without the bore that failed — so the sheet names the feature and
 * the bodies instead of passing that off as the design. `updating`: the
 * sheet is out of date, and its Update is what is held back.
 */
export function sheetSourceFailureMessage(
  failed: readonly SheetFailedBody[],
  updating: boolean
): string | null {
  if (failed.length === 0) return null;
  const features = [...new Set(failed.map((entry) => entry.featureName))];
  const names = failed.map((entry) => entry.bodyName);
  const cause =
    features.length === 1
      ? `“${features[0]}” failed to rebuild`
      : `${features.length} features failed to rebuild (${features.map((name) => `“${name}”`).join(', ')})`;
  const subject =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
  return `${cause}, so ${subject} ${names.length === 1 ? 'is' : 'are'} not the design and this sheet would not show it. Fix or suppress the failed feature in History, then ${updating ? 'Update the sheet to export it' : 'export'}.`;
}
