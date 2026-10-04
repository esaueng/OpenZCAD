import {
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  type BodyId,
  type FeatureData,
  type FeatureNode
} from '@openzcad/shared';
import type { ExactBuildResult } from './exact-types';
import { inheritMeshOrigin } from './exact-shape-utils';

/**
 * The body a suppressed feature hands through to its dependents, or null.
 *
 * A feature that REPLACES one input body — consumes it and leaves its own
 * result in its place — has an obvious answer to "what is there without it":
 * the input, as it stood before the feature. Every other kind keeps the old
 * behaviour, where a suppressed feature leaves nothing under its result id:
 *
 * - Hole, shell, solid offset, draft, fillet, chamfer and pattern consume
 *   `targetBodyId` and replace it, so they pass it through. A suppressed
 *   pattern leaves its seed.
 * - An add or cut extrude consumes `targetBodyId`; its tool comes from a
 *   sketch, so no other body is involved. A new-body extrude has no input.
 * - A boolean passes its first operand through — the target of a subtract,
 *   the first body of a union or intersect — and leaves the tool operands
 *   unconsumed, so they are back on screen as they were before it ran. This
 *   is deliberately not `activeWhen = 0`, which consumes the tools too: that
 *   switch is a modelled configuration whose tools are construction, while
 *   suppressing a step should show the model as if the step were not there.
 * - Transform and direct edit rewrite their target in place under the same
 *   id, so a skipped one already leaves the input where dependents look.
 * - Mirror and thicken create an additional body and leave their input live;
 *   standing the input in for the copy would show the same material twice.
 * - Split consumes its input but yields two halves, and neither is the
 *   input; handing the whole body to both would double it.
 * - Primitives, sketches, revolves, lofts, sweeps and imports make a body
 *   from nothing, so there is nothing to pass on.
 *
 * Pass-through supplies a BODY only. Dependents still resolve their face and
 * edge references against that body's verified lineage (ADR-011), so a
 * reference to topology the suppressed feature itself made — its blend, its
 * bore — finds nothing and refuses exactly as a missing face always has.
 */
export function suppressedFeaturePassThroughSource(
  data: FeatureData
): BodyId | null {
  switch (data.featureKind) {
    case 'hole':
    case 'shell':
    case 'solid-offset':
    case 'draft':
    case 'fillet':
    case 'chamfer':
    case 'pattern':
      return data.targetBodyId;
    case 'extrude':
      return (data.operation ?? 'new-body') === 'new-body'
        ? null
        : (data.targetBodyId ?? null);
    case 'boolean':
      return data.targetBodyIds[0] ?? null;
    case 'transform':
    case 'direct-edit':
    case 'mirror':
    case 'thicken':
    case 'split':
    case 'primitive':
    case 'sketch':
    case 'revolve':
    case 'loft':
    case 'sweep':
    case 'helical-sweep':
    case 'imported-mesh':
    case 'imported-step':
      return null;
    default: {
      const unhandled: never = data;
      void unhandled;
      return null;
    }
  }
}

/**
 * The body this feature, as the document stands, would pass through to its
 * dependents: only while it is manually suppressed and not paused by a
 * rollback (see {@link passSuppressedFeatureThrough}), and only for a kind
 * whose result replaces a separate input body. Null otherwise.
 */
export function suppressedPassThroughBody(feature: FeatureNode): BodyId | null {
  if (
    !isFeatureManuallySuppressed(feature) ||
    isFeatureRollbackSuppressed(feature) ||
    !feature.bodyId
  ) {
    return null;
  }
  const source = suppressedFeaturePassThroughSource(feature.data);
  return source === feature.bodyId ? null : source;
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
  if (source === null || !feature.bodyId) return;
  const input = result.shapes.get(source);
  if (!input || result.consumed.has(source)) return;
  // Fresh containers, shared handles and references: the same structural
  // copy the history cache takes, so a later in-place lineage edit on either
  // id cannot reach the other.
  result.shapes.set(feature.bodyId, {
    solids: [...input.solids],
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
 * that into the document. Downstream of a suppressed step that reference is
 * named after the PASSED-THROUGH body — the input the suppressed feature
 * would have changed — so persisting it rebinds the selection to names that
 * stop resolving the moment the step is resumed. The legacy selection stays
 * as it was and is repaired on the first build with nothing suppressed.
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
  if (result.faceReferenceRepairs?.some(own)) {
    result.faceReferenceRepairs = result.faceReferenceRepairs.filter(
      (repair) => !own(repair)
    );
  }
}
