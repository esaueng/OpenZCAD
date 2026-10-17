import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type DatumFrame,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

/*
 * The two datum helpers the workspace shell itself calls. Kept apart from
 * datumPlanes.ts on purpose: whatever App.tsx imports lands in the entry
 * chunk whole, and the card's words and commands belong in its lazy chunk.
 */

/**
 * The datum planes a feature at `beforeFeatureId` may reference: every datum
 * earlier in history (all of them for a feature appended at the end), in
 * history order. A suppressed datum resolves to nothing, so it is not offered.
 */
export function earlierDatumPlanes(
  document: ProjectDocument,
  beforeFeatureId: FeatureId | null
): FeatureNode[] {
  const datums: FeatureNode[] = [];
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.featureId === beforeFeatureId) break;
    if (
      feature.data.featureKind === 'datum-plane' &&
      !isFeatureSuppressed(feature)
    ) {
      datums.push(feature);
    }
  }
  return datums;
}

/** A datum plane as the viewport draws it: presentation only. */
export interface DatumPlaneDisplay {
  featureId: FeatureId;
  name: string;
  frame: DatumFrame;
  selected: boolean;
}

/**
 * The resolved, shown datum planes. A datum with no frame (failed, suppressed
 * or still building) draws nothing rather than a guess.
 */
export function datumPlaneDisplays(
  document: ProjectDocument,
  hidden: ReadonlySet<string>,
  selectedFeatureId: FeatureId | null
): DatumPlaneDisplay[] {
  const frames = document.derived.datumFrames ?? {};
  return listFeaturesInOrder(document).flatMap((feature) => {
    const frame = frames[feature.featureId];
    return feature.data.featureKind === 'datum-plane' &&
      frame &&
      !isFeatureSuppressed(feature) &&
      !hidden.has(feature.featureId)
      ? [
          {
            featureId: feature.featureId,
            name: feature.name,
            frame,
            selected: feature.featureId === selectedFeatureId
          }
        ]
      : [];
  });
}
