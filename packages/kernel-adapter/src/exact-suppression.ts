import { featureReplacedInputBody } from '@openzcad/document-core';
import {
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  type BodyId,
  type FeatureNode
} from '@openzcad/shared';
import type { ExactBuildResult, ExactShape } from './exact-types';
import { inheritMeshOrigin } from './exact-shape-utils';

/**
 * The body this feature, as the document stands, would pass through to its
 * dependents: only while it is manually suppressed and not paused by a
 * rollback (see {@link passSuppressedFeatureThrough}), and only for a kind
 * whose result replaces a separate input body. Null otherwise.
 */
export function suppressedPassThroughBody(feature: FeatureNode): BodyId | null {
  if (
    !isFeatureManuallySuppressed(feature) ||
    isFeatureRollbackSuppressed(feature)
  ) {
    return null;
  }
  return passThroughSource(feature);
}

/**
 * The separate input body this feature replaces, whatever its state: the
 * body a skipped or failed run of it hands through. Null for a kind with no
 * such input. The per-kind rule lives in document-core
 * (`replacedInputBodyId`), where the history fork check reads the same table.
 */
function passThroughSource(feature: FeatureNode): BodyId | null {
  return featureReplacedInputBody(feature);
}

/**
 * Records a manually suppressed feature as the identity on its input body:
 * the input's solids appear under the feature's result id and the input is
 * consumed, exactly as if the feature had run and changed nothing. Called by
 * the build loop — the one place suppression is applied — so the history
 * cache's snapshots, the measurement pass and the display all see the same
 * bodies.
 *
 * A rollback pause is not passed through. Rolling back pauses everything
 * after the marker, every dependent included, so the only effect would be to
 * relabel the on-screen body with an id produced after the marker.
 *
 * Fails closed to the old behaviour (no body under the result id) whenever
 * the feature itself could not have run: no input body yet, or one an
 * earlier feature already consumed.
 */
export function passSuppressedFeatureThrough(
  result: ExactBuildResult,
  feature: FeatureNode
): void {
  const source = suppressedPassThroughBody(feature);
  if (source !== null) passBodyThrough(result, feature, source);
}

/**
 * The body state a builder can change, captured before a feature that could
 * pass its input through runs (see {@link passFailedFeatureThrough}). Null
 * for every other feature, which costs nothing.
 */
export interface FeatureEntryState {
  shapes: Map<BodyId, ExactShape>;
  consumed: Set<BodyId>;
  meshBodies: Set<BodyId>;
  partialRevolveBodies: Set<BodyId>;
}

export function captureFeatureEntryState(
  result: ExactBuildResult,
  feature: FeatureNode
): FeatureEntryState | null {
  if (passThroughSource(feature) === null) return null;
  // Containers only: builders replace a shape under its id rather than
  // editing one in place, so the entries themselves need no copy.
  return {
    shapes: new Map(result.shapes),
    consumed: new Set(result.consumed),
    meshBodies: new Set(result.meshBodies),
    partialRevolveBodies: new Set(result.partialRevolveBodies)
  };
}

/**
 * November 2026 amendment to ADR-017: a feature that FAILED hands its input
 * through exactly as a manually suppressed one does — same kinds, same
 * fail-closed rules — so its dependents build on the body as it stood before
 * it instead of all reporting "target is unavailable", and its input does not
 * stay on screen beside the chain as a body new work can be attached to.
 *
 * Whatever the builder wrote before it threw is rolled back first, so the
 * pass-through starts from "the feature never ran". The failure itself is
 * reported unchanged by the caller. Returns whether a body was passed.
 */
export function passFailedFeatureThrough(
  result: ExactBuildResult,
  feature: FeatureNode,
  entry: FeatureEntryState | null
): boolean {
  const source = passThroughSource(feature);
  if (source === null || entry === null) return false;
  // In place: the build context holds these very containers.
  result.shapes.clear();
  entry.shapes.forEach((shape, id) => result.shapes.set(id, shape));
  refill(result.consumed, entry.consumed);
  refill(result.meshBodies, entry.meshBodies);
  refill(result.partialRevolveBodies, entry.partialRevolveBodies);
  return passBodyThrough(result, feature, source);
}

function refill<T>(target: Set<T>, from: ReadonlySet<T>): void {
  target.clear();
  from.forEach((value) => target.add(value));
}

function passBodyThrough(
  result: ExactBuildResult,
  feature: FeatureNode,
  source: BodyId
): boolean {
  if (!feature.bodyId) return false;
  const input = result.shapes.get(source);
  if (!input || result.consumed.has(source)) return false;
  // Fresh containers, shared handles and references: the same structural
  // copy the history cache takes, so a later in-place lineage edit on either
  // id cannot reach the other.
  result.shapes.set(feature.bodyId, {
    solids: [...input.solids],
    // A mesh reference has no solids: its mesh is the body.
    ...(input.referenceMesh ? { referenceMesh: input.referenceMesh } : {}),
    ...(input.sweepSource ? { sweepSource: input.sweepSource } : {}),
    ...(input.lineage
      ? {
          lineage: {
            faceReferences: new Map(input.lineage.faceReferences),
            edgeReferences: new Map(input.lineage.edgeReferences),
            diagnostics: [...input.lineage.diagnostics]
          }
        }
      : {})
  });
  result.consumed.add(source);
  inheritMeshOrigin(result, source, feature.bodyId);
  return true;
}

/**
 * The history index of the first manually suppressed feature, or -1. Every
 * feature after it is built against a model with a step left out. Such a
 * build is real — it is what the user asked to see — but it is not the model
 * the document describes once every step runs, so nothing learned from it may
 * be written back into the document.
 */
export function firstManualSuppressionIndex(
  features: readonly FeatureNode[]
): number {
  return features.findIndex(
    (feature) =>
      isFeatureManuallySuppressed(feature) &&
      !isFeatureRollbackSuppressed(feature)
  );
}

/**
 * Drops the reference repairs one feature raised in this build.
 *
 * A repair is advice to persist: a legacy hash-only selection resolved, so
 * the build offers the lineage reference it resolved to, and the app writes
 * that into the document. Downstream of a suppressed or failed step that
 * reference is named after the PASSED-THROUGH body — the input that step
 * would have changed — so persisting it rebinds the selection to names that
 * stop resolving the moment the step is resumed or repaired. The legacy
 * selection stays as it was and is repaired on the first build with nothing
 * suppressed or failed before it.
 */
export function withholdReferenceRepairs(
  result: ExactBuildResult,
  feature: FeatureNode
): void {
  const own = (repair: { featureId: string }) =>
    repair.featureId === feature.featureId;
  if (result.referenceRepairs.some(own)) {
    result.referenceRepairs = result.referenceRepairs.filter(
      (repair) => !own(repair)
    );
  }
  if (result.edgeHashRepairs?.some(own)) {
    result.edgeHashRepairs = result.edgeHashRepairs.filter(
      (repair) => !own(repair)
    );
  }
  if (result.faceReferenceRepairs?.some(own)) {
    result.faceReferenceRepairs = result.faceReferenceRepairs.filter(
      (repair) => !own(repair)
    );
  }
}
