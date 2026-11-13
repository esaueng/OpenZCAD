import { listFeaturesInOrder } from '@openzcad/document-core';
import type {
  DerivedState,
  FeatureData,
  FeatureId,
  ProjectDocument
} from '@openzcad/shared';
import { topologyReferenceRepairCommand } from './topologyReferenceRepairs';

/**
 * Stored face and edge picks that carry only an ADR-011 hash.
 *
 * A hash embeds the picked entity's dimensions, so any upstream edit that
 * resizes it orphans the pick; only a schema-v5 lineage reference survives
 * that (ADR-013). A pick is stored hash-only when the entity had no lineage
 * name at the time. These helpers say which steps hold such picks so the
 * app can tell the user, never to change them: the rebuild upgrades a pick
 * itself once its entity is named (`topologyReferenceRepairCommand`).
 */

/** The stored hashes of `data` that no v5 reference anchors, deduplicated. */
export function hashOnlySelections(data: FeatureData): number[] {
  const uncovered = (
    hashes: readonly number[],
    references: readonly { currentHash: number }[] | undefined
  ) => {
    const named = new Set(references?.map((r) => r.currentHash) ?? []);
    return [...new Set(hashes)].filter((hash) => !named.has(hash));
  };
  switch (data.featureKind) {
    case 'fillet':
    case 'chamfer':
      return uncovered(data.edgeHashes, data.edgeReferences);
    case 'shell':
      return uncovered(data.openingFaceHashes, data.openingFaceReferences);
    case 'draft':
      return uncovered(data.faceHashes, data.faceReferences);
    case 'hole':
    case 'thicken':
    case 'thread':
      return data.faceReference ? [] : [data.faceHash];
    case 'gear':
      return data.targetBodyId &&
        typeof data.faceHash === 'number' &&
        !data.faceReference
        ? [data.faceHash]
        : [];
    case 'direct-edit': {
      const operation = data.operation;
      return [
        ...(operation.faceReference ? [] : [operation.faceHash]),
        ...(operation.kind === 'set-face-distance' &&
        !operation.oppositeFaceReference
          ? [operation.oppositeFaceHash]
          : [])
      ];
    }
    default:
      return [];
  }
}

export interface FragileSelectionStep {
  featureId: FeatureId;
  featureName: string;
  /** How many of the step's stored picks are hash-only. */
  count: number;
}

/** Every step in history order that stores at least one hash-only pick. */
export function fragileSelectionSteps(
  document: ProjectDocument
): FragileSelectionStep[] {
  return listFeaturesInOrder(document).flatMap((feature) => {
    const count = hashOnlySelections(feature.data).length;
    return count > 0
      ? [{ featureId: feature.featureId, featureName: feature.name, count }]
      : [];
  });
}

/** The Diagnostics line for {@link fragileSelectionSteps}, or null. */
export function fragileSelectionSummary(
  steps: readonly FragileSelectionStep[]
): string | null {
  if (steps.length === 0) return null;
  return steps.length === 1
    ? '1 step uses a fragile selection.'
    : `${steps.length} steps use fragile selections.`;
}

/**
 * The advisory a commit earns when it stores a new hash-only pick, or null.
 *
 * Read from what the commit stores, not from what was hovered, so it is said
 * once per commit. A step counts when it is new or its hash-only picks
 * changed; an edit that leaves a step's picks alone (its radius, say) says
 * nothing about picks the user did not just make. `carried` names steps the
 * commit rewrote on the user's behalf (`withCarriedSelections`), which are not
 * picks either. When the commit's own rebuild proves a name for the pick, the
 * after-build repair stores it, so `derived` is applied first and such a pick
 * is not reported.
 */
export function fragileSelectionAdvisory(
  before: ProjectDocument,
  after: ProjectDocument,
  options: {
    derived?: DerivedState;
    carried?: ReadonlySet<FeatureId>;
  } = {}
): string | null {
  let stored = after;
  const repair = options.derived
    ? topologyReferenceRepairCommand(after, options.derived)
    : null;
  if (repair) {
    try {
      stored = repair.apply(after);
    } catch {
      // The repair is refused on its own path too; report what is stored.
    }
  }
  const key = (data: FeatureData) =>
    hashOnlySelections(data)
      .sort((a, b) => a - b)
      .join(',');
  const previous = new Map(
    listFeaturesInOrder(before).map((feature) => [
      feature.featureId,
      key(feature.data)
    ])
  );
  const names = listFeaturesInOrder(stored)
    .filter((feature) => {
      const now = key(feature.data);
      return (
        now !== '' &&
        !options.carried?.has(feature.featureId) &&
        previous.get(feature.featureId) !== now
      );
    })
    .map((feature) => feature.name);
  if (names.length === 0) return null;
  return names.length === 1
    ? `“${names[0]}”: this selection has no stable name, so it may need re-picking if earlier steps change.`
    : `${names.length} steps store selections with no stable name, so they may need re-picking if earlier steps change.`;
}
