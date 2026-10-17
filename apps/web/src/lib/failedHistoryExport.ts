import { listFeaturesInOrder } from '@openzcad/document-core';
import type {
  BodyId,
  FeatureId,
  FeatureNode,
  FeatureWarning,
  ProjectDocument
} from '@openzcad/shared';
import { affectedFeatureTargets } from './affectedFeatureTargets';

/** Why one body is held out of an export. */
export interface WithheldExportBody {
  bodyId: BodyId;
  /** The first failed feature, in history order, on this body's branch. */
  featureId: FeatureId;
  featureName: string;
}

/**
 * Bodies the history replaced, so a failed replacement passes them through.
 * A failed shell, cut or blend leaves its target in place unchanged; that
 * body is the feature's unfinished input, not part of the design.
 */
function inputBodyIds(feature: FeatureNode): BodyId[] {
  const data = feature.data;
  switch (data.featureKind) {
    case 'extrude':
      return data.targetBodyId ? [data.targetBodyId] : [];
    case 'boolean':
      return [...data.targetBodyIds];
    case 'split':
    case 'hole':
    case 'transform':
    case 'shell':
    case 'solid-offset':
    case 'draft':
    case 'thicken':
    case 'fillet':
    case 'chamfer':
    case 'pattern':
    case 'direct-edit':
      return [data.targetBodyId];
    case 'mirror':
    case 'primitive':
    case 'sketch':
    case 'revolve':
    case 'loft':
    case 'sweep':
    case 'helical-sweep':
    case 'imported-step':
    case 'imported-mesh':
    case 'datum-plane':
      return [];
  }
}

/**
 * Bodies an export must not write, because a feature on their branch failed
 * to rebuild (`build-failed`) or was refused (`refusal`).
 *
 * When a feature fails, the replay keeps going with whatever it had: the
 * failed feature's input is still unconsumed, so it is drawn and offered for
 * export exactly as if it were the result. A loft whose shell lost an opening
 * face exported as the solid loft, and the STEP file carried no sign that the
 * hollow duct was missing. The failure is already reported in Diagnostics;
 * this keeps the file from contradicting it.
 *
 * Scoped to the failing branch: the feature's own results, the inputs it
 * passes through, and every result downstream of it. Advisory warnings,
 * suppressed features, and failures on another body's branch withhold
 * nothing, so an unrelated problem never blocks a sound body's export.
 *
 * Attribution comes from the typed feature-warning record, never from warning
 * prose. The saved document does not carry that record (it is session advice
 * that `attachDerivedState` strips), so the app passes the record that came
 * with the derived state on screen; without one, nothing is withheld.
 */
export function failedHistoryExportBodies(
  document: ProjectDocument,
  featureWarnings: readonly FeatureWarning[] | undefined = document.derived
    .featureWarnings
): Map<BodyId, WithheldExportBody> {
  const withheld = new Map<BodyId, WithheldExportBody>();
  const failed = new Set(
    (featureWarnings ?? [])
      .filter(
        (warning) =>
          warning.kind === 'build-failed' || warning.kind === 'refusal'
      )
      .map((warning) => warning.featureId)
  );
  if (failed.size === 0) return withheld;
  for (const feature of listFeaturesInOrder(document)) {
    if (!failed.has(feature.featureId)) continue;
    const reason = {
      featureId: feature.featureId,
      featureName: feature.name
    };
    const bodies = [
      ...inputBodyIds(feature),
      ...(feature.bodyId ? [feature.bodyId] : []),
      ...(feature.data.featureKind === 'split'
        ? [feature.data.secondBodyId]
        : []),
      ...affectedFeatureTargets(document, feature.featureId).map(
        (target) => target.resultBodyId
      )
    ];
    for (const bodyId of bodies) {
      // A failed feature's own result is usually absent; only a body that
      // was actually built can be offered for export and so be withheld.
      if (
        !withheld.has(bodyId) &&
        document.derived.bodyRepresentations[bodyId]
      ) {
        withheld.set(bodyId, { bodyId, ...reason });
      }
    }
  }
  return withheld;
}

/** One sentence naming what was held back and why, for a status or tooltip. */
export function withheldExportMessage(
  withheld: readonly WithheldExportBody[],
  bodyName: (bodyId: BodyId) => string
): string | null {
  const first = withheld[0];
  if (!first) return null;
  const features = [...new Set(withheld.map((entry) => entry.featureName))];
  const names = withheld.map((entry) => bodyName(entry.bodyId));
  const subject =
    names.length === 1
      ? names[0]!
      : `${names.length} bodies (${names.join(', ')})`;
  const cause =
    features.length === 1
      ? `“${features[0]}” failed to rebuild`
      : `${features.length} features failed to rebuild (${features.map((name) => `“${name}”`).join(', ')})`;
  return `${subject} not exported: ${cause}, so ${names.length === 1 ? 'it does' : 'they do'} not match the design. Fix or suppress the failed feature in History to export ${names.length === 1 ? 'it' : 'them'}.`;
}
