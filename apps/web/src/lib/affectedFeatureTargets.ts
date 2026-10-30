import { findSketch, listFeaturesInOrder } from '@openzcad/document-core';
import {
  datumAxisPlaneSources,
  datumAxisPointSources,
  datumPlaneSources,
  datumPointSources,
  featureDatumAxisRefs,
  isDatumPlaneRef,
  isFeatureSuppressed,
  type DatumPlaneSource,
  type BodyId,
  type FeatureId,
  type FeatureKind,
  type FeatureWarning,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';
import {
  FeatureBuildError,
  refusingWarningDetail,
  validatedFeatureRejection
} from './featureValidation';

// Every FeatureKind must be handled in the downstream walk below. The check is
// structural (not behavioral): hole was once missing here, so downstream hole
// failures never gated sketch/extrude/direct-edit commits and edits silently
// dropped holes.
const HANDLED_FEATURE_KINDS: ReadonlySet<FeatureKind> = new Set<FeatureKind>([
  'primitive',
  'sketch',
  'extrude',
  'revolve',
  'loft',
  'sweep',
  'helical-sweep',
  'boolean',
  'split',
  'hole',
  'gear',
  'transform',
  'mirror',
  'shell',
  'solid-offset',
  'draft',
  'thicken',
  'fillet',
  'chamfer',
  'pattern',
  'direct-edit',
  'imported-step',
  'imported-mesh',
  'datum-plane',
  'datum-axis'
]);

function assertAllFeatureKindsHandled(kind: FeatureKind): void {
  if (!HANDLED_FEATURE_KINDS.has(kind)) {
    throw new Error(
      `affectedFeatureTargets: unhandled feature kind "${kind}".`
    );
  }
}

export interface AffectedFeatureTarget {
  featureName: string;
  /** Identifies the feature so a refusal naming it can offer to open it. */
  featureId: FeatureId;
  resultBodyId: BodyId;
}

/**
 * Result features whose exact geometry depends on one edited source feature.
 *
 * Body dependencies are walked forward through history, including in-place
 * transforms/direct edits and sketches attached to an affected face. This is
 * intentionally document/history logic: the kernel still rebuilds the whole
 * candidate, while the UI uses this set to reject warnings only from the
 * branch the edit can actually change.
 */
export function affectedFeatureTargets(
  document: ProjectDocument,
  sourceFeatureId: FeatureId,
  options: {
    /**
     * Also walk the branches of a Boolean's or Split's inputs. An edit needs
     * this (it can change which inputs are kept, M11); a failure of the
     * feature as stored does not, since its kept inputs stand on their own.
     */
    inputBranches?: boolean;
  } = {}
): AffectedFeatureTarget[] {
  const features = listFeaturesInOrder(document);
  const sourceIndex = features.findIndex(
    (feature) => feature.featureId === sourceFeatureId
  );
  const source = features[sourceIndex];
  // In-place edits carry no result body on the node; their "result" is the
  // body they rewrite, exactly as the downstream walk below already treats
  // them when they are the dependents rather than the source.
  const sourceBodyId =
    source?.bodyId ??
    (source?.data.featureKind === 'transform' ||
    source?.data.featureKind === 'direct-edit'
      ? source.data.targetBodyId
      : undefined);
  const sourceSketchId =
    source?.data.featureKind === 'sketch' ? source.data.sketchId : undefined;
  // A datum plane builds no body, but every sketch, Split and Mirror on it
  // (and every datum built from it) moves when it does; likewise every
  // revolve, pattern and Move turning about a datum axis.
  const sourceDatumId =
    source?.data.featureKind === 'datum-plane' ||
    source?.data.featureKind === 'datum-axis'
      ? source.featureId
      : undefined;
  if (
    sourceIndex < 0 ||
    !source ||
    (!sourceBodyId && !sourceSketchId && !sourceDatumId) ||
    isFeatureSuppressed(source)
  ) {
    return [];
  }

  const affectedBodies = new Set<BodyId>(sourceBodyId ? [sourceBodyId] : []);
  // M11: editing a Boolean or Split can change which of its inputs it keeps,
  // and a later feature on an input that stops being kept loses its body.
  // So an edit walks the inputs' own downstream branches too; the inputs are
  // not targets themselves, since consuming them is the edit's intent.
  if (options.inputBranches && source.data.featureKind === 'boolean') {
    source.data.targetBodyIds.forEach((bodyId) => affectedBodies.add(bodyId));
  } else if (options.inputBranches && source.data.featureKind === 'split') {
    affectedBodies.add(source.data.targetBodyId);
  }
  const affectedSketches = new Set<SketchId>(
    sourceSketchId ? [sourceSketchId] : []
  );
  const affectedDatums = new Set<FeatureId>(
    sourceDatumId ? [sourceDatumId] : []
  );
  const planeAffected = (plane: DatumPlaneSource) =>
    plane.type === 'datum'
      ? affectedDatums.has(plane.datumFeatureId)
      : plane.type === 'face' && affectedBodies.has(plane.bodyId);
  const targets: AffectedFeatureTarget[] = sourceBodyId
    ? [
        {
          featureName: source.name,
          featureId: source.featureId,
          resultBodyId: sourceBodyId
        }
      ]
    : [];

  for (const feature of features.slice(sourceIndex + 1)) {
    if (isFeatureSuppressed(feature)) {
      continue;
    }
    const data = feature.data;
    let affected = false;

    assertAllFeatureKindsHandled(data.featureKind);
    switch (data.featureKind) {
      case 'sketch': {
        const planeRef = findSketch(document, data.sketchId)?.planeRef;
        if (
          (planeRef?.type === 'face' || planeRef?.type === 'datum') &&
          planeAffected(planeRef as DatumPlaneSource)
        ) {
          affectedSketches.add(data.sketchId);
        }
        continue;
      }
      case 'datum-plane': {
        const { definition } = data;
        if (
          datumPlaneSources(definition).some(planeAffected) ||
          datumPointSources(definition).some(
            (point) =>
              point.type === 'edge-vertex' && affectedBodies.has(point.bodyId)
          )
        )
          affectedDatums.add(feature.featureId);
        continue;
      }
      case 'datum-axis': {
        const { definition } = data;
        if (
          datumAxisPlaneSources(definition).some(planeAffected) ||
          datumAxisPointSources(definition).some(
            (point) =>
              point.type === 'edge-vertex' && affectedBodies.has(point.bodyId)
          ) ||
          ((definition.kind === 'edge' || definition.kind === 'cylinder') &&
            affectedBodies.has(definition.source.bodyId))
        )
          affectedDatums.add(feature.featureId);
        continue;
      }
      case 'extrude':
        affected =
          affectedSketches.has(data.sketchId) ||
          (data.targetBodyId !== undefined &&
            affectedBodies.has(data.targetBodyId)) ||
          // F01 (v29): a to-face extent reads its face's body here.
          (data.toFace !== undefined && planeAffected(data.toFace));
        break;
      case 'revolve':
        affected =
          affectedSketches.has(data.sketchId) ||
          (data.axisRef !== undefined &&
            affectedDatums.has(data.axisRef.datumFeatureId));
        break;
      case 'loft':
        affected = data.sections.some((section) =>
          affectedSketches.has(section.sketchId)
        );
        break;
      case 'sweep':
        affected =
          affectedSketches.has(data.profile.sketchId) ||
          affectedSketches.has(data.path.sketchId) ||
          (data.guide !== undefined &&
            affectedSketches.has(data.guide.sketchId));
        break;
      case 'helical-sweep':
        affected = affectedSketches.has(data.profile.sketchId);
        break;
      case 'boolean':
        affected = data.targetBodyIds.some((bodyId) =>
          affectedBodies.has(bodyId)
        );
        break;
      case 'split':
      case 'mirror':
        affected =
          affectedBodies.has(data.targetBodyId) ||
          (isDatumPlaneRef(data.plane) &&
            affectedDatums.has(data.plane.datumFeatureId));
        break;
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
        affected =
          affectedBodies.has(data.targetBodyId) ||
          featureDatumAxisRefs(data).some((ref) =>
            affectedDatums.has(ref.datumFeatureId)
          );
        break;
      case 'gear':
        affected =
          data.targetBodyId !== undefined &&
          affectedBodies.has(data.targetBodyId);
        break;
      case 'primitive':
      case 'imported-mesh':
      case 'imported-step':
        break;
    }

    if (!affected) {
      continue;
    }
    const resultBodyId =
      feature.bodyId ??
      (data.featureKind === 'transform' || data.featureKind === 'direct-edit'
        ? data.targetBodyId
        : undefined);
    if (!resultBodyId) {
      continue;
    }
    affectedBodies.add(resultBodyId);
    targets.push({
      featureName: feature.name,
      featureId: feature.featureId,
      resultBodyId
    });
    // A split's second half is a result body too; downstream features
    // targeting it are just as affected as those on the primary half.
    if (data.featureKind === 'split') {
      affectedBodies.add(data.secondBodyId);
      targets.push({
        featureName: feature.name,
        featureId: feature.featureId,
        resultBodyId: data.secondBodyId
      });
    }
  }

  return targets;
}

/**
 * Result features a history reorder can change, earliest in the new order
 * first, so a refusal names the first feature the move breaks.
 *
 * Everything before min(from, to) replays exactly as it did; every feature in
 * the moved span runs against a different input, and so does whatever builds
 * on one of them. Empty when the move is a no-op or touches nothing that
 * builds a body (a lone sketch moved past an unrelated feature).
 */
export function reorderFeatureTargets(
  document: ProjectDocument,
  featureId: FeatureId,
  toIndex: number
): AffectedFeatureTarget[] {
  const features = listFeaturesInOrder(document);
  const from = features.findIndex((feature) => feature.featureId === featureId);
  if (from < 0 || toIndex === from || toIndex < 0 || toIndex >= features.length)
    return [];
  const reordered = [...features];
  reordered.splice(toIndex, 0, ...reordered.splice(from, 1));
  const position = new Map(
    reordered.map((feature, index) => [feature.featureId, index])
  );
  const seen = new Set<string>();
  return features
    .slice(Math.min(from, toIndex), Math.max(from, toIndex) + 1)
    .flatMap((feature) => affectedFeatureTargets(document, feature.featureId))
    .filter(({ featureId: id, resultBodyId }) => {
      const key = `${id}\u0000${resultBodyId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => position.get(a.featureId)! - position.get(b.featureId)!);
}

/** How a History reorder proceeds; see {@link planReorder}. */
export type ReorderPlan =
  /** Nothing to rebuild, or refused by the order gate: commit as a command. */
  | { kind: 'direct' }
  /** The edit guard refused it; nothing rebuilds and nothing runs. */
  | { kind: 'blocked' }
  /** The current version's exact rebuild has not landed yet. */
  | { kind: 'pending' }
  | { kind: 'validate'; targets: AffectedFeatureTarget[] };

/**
 * Routes a History reorder before anything is rebuilt. A reorder that needs
 * the exact preflight must pass the edit guard first — otherwise a read-only
 * session waits out a rebuild only to be refused at commit — and must wait
 * for the current version's own projection, because the comparison in
 * {@link reorderRefusal} against a stale one blames the move for failures it
 * did not cause.
 */
export function planReorder(
  document: ProjectDocument | null,
  featureId: FeatureId,
  toIndex: number,
  gates: {
    /** The command's own order gate; throws for an illegal order. */
    orderGate(document: ProjectDocument): void;
    canEdit(): boolean;
    geometryReady(document: ProjectDocument): boolean;
  }
): ReorderPlan {
  const targets = document
    ? reorderFeatureTargets(document, featureId, toIndex)
    : [];
  if (!document || targets.length === 0) return { kind: 'direct' };
  try {
    gates.orderGate(document);
  } catch {
    return { kind: 'direct' }; // Reported by the command, as before.
  }
  if (!gates.canEdit()) return { kind: 'blocked' };
  if (!gates.geometryReady(document)) return { kind: 'pending' };
  return { kind: 'validate', targets };
}

/**
 * The first feature from the moved span onward that the reordered rebuild
 * refuses and the current model does not, as a refusal naming it.
 *
 * Every feature is compared with the current model, so a failure the design
 * already has does not block an otherwise valid reorder. Features with no
 * result body — a face-attached sketch nothing builds on yet — are checked
 * by their own warnings; the rest also need every result body to exist.
 */
export function reorderRefusal(
  document: ProjectDocument,
  derived: ProjectDocument['derived'],
  featureId: FeatureId,
  toIndex: number,
  /**
   * Attribution for `document.derived`, which the saved document does not
   * carry. Without it only the candidate's exact failure warning, on a feature
   * no other shares its name with, counts as a prior failure.
   */
  beforeWarnings?: readonly FeatureWarning[]
): FeatureBuildError | null {
  const features = listFeaturesInOrder(document);
  const from = features.findIndex((feature) => feature.featureId === featureId);
  if (from < 0) return null;
  const reordered = [...features];
  reordered.splice(toIndex, 0, ...reordered.splice(from, 1));
  const bodies = new Map<FeatureId, BodyId[]>();
  for (const target of reorderFeatureTargets(document, featureId, toIndex)) {
    bodies.set(target.featureId, [
      ...(bodies.get(target.featureId) ?? []),
      target.resultBodyId
    ]);
  }
  const before = document.derived;
  const named = new Map<string, number>();
  for (const feature of features)
    named.set(feature.name, (named.get(feature.name) ?? 0) + 1);
  // Without typed attribution a saved warning cannot say whether it was a
  // failure or an advisory, so only the exact failure the candidate reports,
  // on a uniquely named feature, counts as one the model already had.
  const candidateFailures = (feature: (typeof features)[number]): string[] =>
    derived.featureWarnings
      ? derived.featureWarnings
          .filter(
            (entry) =>
              entry.featureId === feature.featureId &&
              (entry.kind === 'build-failed' || entry.kind === 'refusal')
          )
          .map((entry) => entry.message)
      : derived.warnings.filter((warning) =>
          warning.startsWith(`Feature "${feature.name}":`)
        );
  const failedBefore = (feature: (typeof features)[number]): boolean =>
    beforeWarnings
      ? Boolean(
          refusingWarningDetail(
            feature.name,
            before?.warnings ?? [],
            beforeWarnings,
            feature.featureId
          )
        )
      : named.get(feature.name) === 1 &&
        candidateFailures(feature).some((message) =>
          (before?.warnings ?? []).includes(message)
        );
  for (const feature of reordered.slice(Math.min(from, toIndex))) {
    if (isFeatureSuppressed(feature)) continue;
    const rejection = validatedFeatureRejection({
      featureName: feature.name,
      featureId: feature.featureId,
      warnings: derived.warnings,
      ...(derived.featureWarnings
        ? { featureWarnings: derived.featureWarnings }
        : {}),
      bodyPresent: (bodies.get(feature.featureId) ?? []).every((bodyId) =>
        Boolean(derived.bodyRepresentations[bodyId])
      ),
      documentMoved: false
    });
    if (rejection && !failedBefore(feature)) {
      return new FeatureBuildError(
        rejection.message,
        feature.featureId,
        feature.name
      );
    }
  }
  return null;
}

/**
 * The targets an edit of `featureId` must validate: those of the feature as
 * stored in `base`, then any more that the feature as `proposed` adds. An
 * edit that points a Boolean or Split at a different input (or stops keeping
 * one, M11) puts that input's later features at stake, and only the proposed
 * document names the new input. The stored source stays first.
 */
export function editAffectedFeatureTargets(
  base: ProjectDocument,
  proposed: ProjectDocument | null,
  featureId: FeatureId
): AffectedFeatureTarget[] {
  const targets = affectedFeatureTargets(base, featureId, {
    inputBranches: true
  });
  if (!proposed) return targets;
  const key = (target: AffectedFeatureTarget) =>
    `${target.featureId}:${target.resultBodyId}`;
  const seen = new Set(targets.map(key));
  for (const target of affectedFeatureTargets(proposed, featureId, {
    inputBranches: true
  })) {
    if (!seen.has(key(target))) {
      seen.add(key(target));
      targets.push(target);
    }
  }
  return targets;
}
