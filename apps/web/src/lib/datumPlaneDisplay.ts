import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type DatumFrame,
  type FeatureId,
  type FeatureNode,
  type FeatureWarning,
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

/**
 * The drag handle a selected offset datum offers: at its resolved origin,
 * along its resolved normal. `sense` turns travel along that normal into the
 * stored offset (a reversed datum's normal points against its source's).
 */
export interface DatumOffsetHandle {
  featureId: FeatureId;
  point: DatumFrame['origin'];
  normal: DatumFrame['normal'];
  /** The stored offset when it is a plain number; null for an expression. */
  offset: number | null;
  sense: 1 | -1;
}

/**
 * A handle for the selected, built offset datum, or null (a midplane has no
 * distance to drag). Whether a drag may land is the open card's call, made
 * from its live draft: an Offset typed as a plain number can be dragged even
 * when the committed one is an expression, and the reverse.
 */
export function datumOffsetHandle(
  document: ProjectDocument,
  selectedFeatureId: FeatureId | null,
  hidden: ReadonlySet<string>
): DatumOffsetHandle | null {
  if (!selectedFeatureId || hidden.has(selectedFeatureId)) return null;
  const frame = document.derived.datumFrames?.[selectedFeatureId];
  const feature = frame
    ? listFeaturesInOrder(document).find(
        (candidate) => candidate.featureId === selectedFeatureId
      )
    : undefined;
  if (
    !frame ||
    !feature ||
    isFeatureSuppressed(feature) ||
    feature.data.featureKind !== 'datum-plane' ||
    feature.data.definition.kind !== 'offset'
  ) {
    return null;
  }
  return {
    featureId: selectedFeatureId,
    point: frame.origin,
    normal: frame.normal,
    offset:
      typeof feature.data.definition.offset === 'number'
        ? feature.data.definition.offset
        : null,
    sense: feature.data.definition.reverseNormal ? -1 : 1
  };
}

/**
 * True when the build reports that this datum's source face could not be
 * attached: the one failure a re-picked face can repair. A datum still
 * rebuilding, or failing for another reason (a bad offset expression), is
 * not.
 */
export function datumFaceAttachFailed(
  feature: FeatureNode,
  warnings: readonly FeatureWarning[]
): boolean {
  // By id, not by the display text: two datums may share a name.
  return warnings.some(
    (warning) =>
      warning.featureId === feature.featureId &&
      warning.message.includes(`Datum plane "${feature.name}" cannot attach`)
  );
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
