import { findBodyNode, listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  ownEntry,
  transformStampBodyIds
} from '@openzcad/shared';
import type {
  BodyId,
  FeatureId,
  FeatureWarning,
  ProjectDocument,
  SketchId
} from '@openzcad/shared';
import { affectedFeatureTargets } from './affectedFeatureTargets';
import { inputBodyIds } from './failedHistoryExport';
import { sketchesWithBrokenProjections } from './sketch/projection';

/** A saved body a failed feature left without geometry (#2254). */
export interface OmittedExportBody {
  bodyId: BodyId;
  /** The body record's own name: no representation is on screen to name it. */
  bodyName: string;
  /** The first failed feature, in history order, on this body's branch. */
  featureId: FeatureId;
  featureName: string;
}

/**
 * Saved bodies an export leaves out because a feature on their branch failed
 * to rebuild and built nothing in their place (#2254).
 *
 * `failedHistoryExportBodies` withholds the bodies a failure leaves standing
 * in for the design. A failed feature that creates a new body (an Extrude
 * whose profile broke) leaves nothing on screen at all: the project still
 * records the body, but no representation exists, so nothing was withheld
 * and the export wrote the rest of the model with a plain success. This
 * names those bodies so the export can say which output is missing and why.
 *
 * A body a later active feature consumes is not named: its consumer's result
 * is the output, and is withheld or named in its place. Suppressed features
 * withhold nothing and are never named, as a failure on another body's
 * branch never is. Attribution reads the typed feature-warning record, as
 * `failedHistoryExportBodies` does; without one, nothing is named.
 */
export function omittedFailedHistoryBodies(
  document: ProjectDocument,
  featureWarnings: readonly FeatureWarning[] | undefined = document.derived
    .featureWarnings
): OmittedExportBody[] {
  const failed = new Set(
    (featureWarnings ?? [])
      .filter(
        (warning) =>
          warning.kind === 'build-failed' || warning.kind === 'refusal'
      )
      .map((warning) => warning.featureId)
  );
  if (failed.size === 0) return [];
  const features = listFeaturesInOrder(document);
  const consumed = new Set<BodyId>();
  for (const feature of features) {
    if (isFeatureSuppressed(feature)) continue;
    for (const bodyId of inputBodyIds(feature)) consumed.add(bodyId);
  }
  const omitted = new Map<BodyId, OmittedExportBody>();
  for (const feature of features) {
    if (!failed.has(feature.featureId)) continue;
    const bodies = [
      ...(feature.bodyId ? [feature.bodyId] : []),
      ...(feature.data.featureKind === 'split'
        ? [feature.data.secondBodyId]
        : []),
      ...transformStampBodyIds(feature.data),
      ...affectedFeatureTargets(document, feature.featureId).map(
        (target) => target.resultBodyId
      )
    ];
    for (const bodyId of bodies) {
      if (omitted.has(bodyId) || consumed.has(bodyId)) continue;
      // A body on screen is the failed-history guard's to withhold.
      if (ownEntry(document.derived.bodyRepresentations, bodyId)) continue;
      const record = findBodyNode(document, bodyId);
      if (!record) continue;
      omitted.set(bodyId, {
        bodyId,
        bodyName: record.name,
        featureId: feature.featureId,
        featureName: feature.name
      });
    }
  }
  return [...omitted.values()];
}

/** A body built from a sketch whose linked projection is broken (#2255). */
export interface StaleProjectionExportBody {
  bodyId: BodyId;
  sketchId: SketchId;
  /** The sketch's History name. */
  sketchName: string;
}

/**
 * Bodies the exact build made from a sketch with a broken linked projection
 * (#2255). A broken projection keeps building from its stored, last valid
 * geometry, so the dependent feature reports no failure and its body looks
 * sound, but it no longer follows the edge it was projected from. The
 * export still writes it (that geometry is what the model shows), and says
 * which bodies are written from it.
 *
 * Every body on screen downstream of the sketch is named, through the same
 * walk an edit of the sketch would take. Consumed bodies and suppressed
 * sketches are not.
 */
export function staleProjectionExportBodies(
  document: ProjectDocument
): StaleProjectionExportBody[] {
  const broken = sketchesWithBrokenProjections(document);
  if (broken.size === 0) return [];
  const stale = new Map<BodyId, StaleProjectionExportBody>();
  for (const feature of listFeaturesInOrder(document)) {
    if (
      feature.data.featureKind !== 'sketch' ||
      !broken.has(feature.data.sketchId) ||
      isFeatureSuppressed(feature)
    )
      continue;
    const sketchId = feature.data.sketchId;
    for (const target of affectedFeatureTargets(document, feature.featureId)) {
      const body = ownEntry(
        document.derived.bodyRepresentations,
        target.resultBodyId
      );
      if (!body || body.consumed || stale.has(body.bodyId)) continue;
      stale.set(body.bodyId, {
        bodyId: body.bodyId,
        sketchId,
        sketchName: feature.name
      });
    }
  }
  return [...stale.values()];
}

const quoted = (names: readonly string[]) =>
  names.map((name) => `“${name}”`).join(', ');

function subjectOf(names: readonly string[]): string {
  return names.length === 1
    ? names[0]!
    : `${names.length} bodies (${names.join(', ')})`;
}

/** One sentence naming the bodies a failure left without geometry. */
export function omittedExportMessage(
  omitted: readonly OmittedExportBody[]
): string | null {
  if (omitted.length === 0) return null;
  const names = omitted.map((entry) => entry.bodyName);
  const features = [...new Set(omitted.map((entry) => entry.featureName))];
  const one = names.length === 1;
  const cause =
    features.length === 1
      ? `“${features[0]}” failed to rebuild`
      : `${features.length} features failed to rebuild (${quoted(features)})`;
  return `${subjectOf(names)} not exported: ${cause}, so ${one ? 'it has' : 'they have'} no geometry to write. Fix or suppress the failed feature in History to export ${one ? 'it' : 'them'}.`;
}

/** One sentence naming the bodies written from last-valid sketch geometry. */
export function staleProjectionExportMessage(
  stale: readonly StaleProjectionExportBody[],
  bodyName: (bodyId: BodyId) => string
): string | null {
  if (stale.length === 0) return null;
  const names = stale.map((entry) => bodyName(entry.bodyId));
  const sketches = [...new Set(stale.map((entry) => entry.sketchName))];
  const one = names.length === 1;
  const source =
    sketches.length === 1
      ? `“${sketches[0]}”`
      : `${sketches.length} sketches (${quoted(sketches)})`;
  return `${subjectOf(names)} ${one ? 'is' : 'are'} exported from the last valid geometry of ${source}, whose linked ${sketches.length === 1 ? 'projection is' : 'projections are'} broken, so ${one ? 'it does' : 'they do'} not follow the edited model. Re-pick or unlink the broken projection to update ${one ? 'it' : 'them'}.`;
}
