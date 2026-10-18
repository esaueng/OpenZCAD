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

/**
 * The drag handle a selected offset datum offers: at its resolved origin,
 * along its resolved normal. `sense` turns travel along that normal into the
 * stored offset (a reversed datum's normal points against its source's).
 */
export interface DatumOffsetHandle {
  featureId: FeatureId;
  point: DatumFrame['origin'];
  normal: DatumFrame['normal'];
  offset: number;
  sense: 1 | -1;
}

/**
 * A handle for the selected datum, or null. Only an offset datum whose
 * offset is a plain number qualifies: a midplane has no distance to drag,
 * and an expression-driven offset is edited where the expression lives
 * rather than overwritten by a drag.
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
    feature.data.definition.kind !== 'offset' ||
    typeof feature.data.definition.offset !== 'number'
  ) {
    return null;
  }
  return {
    featureId: selectedFeatureId,
    point: frame.origin,
    normal: frame.normal,
    offset: feature.data.definition.offset,
    sense: feature.data.definition.reverseNormal ? -1 : 1
  };
}

/** A frame moved `distance` along its own normal: a plane drawn ahead of its edit. */
export function shiftedDatumFrame(
  frame: DatumFrame,
  distance: number
): DatumFrame {
  if (distance === 0) return frame;
  const { origin, normal } = frame;
  return {
    ...frame,
    origin: {
      x: origin.x + normal.x * distance,
      y: origin.y + normal.y * distance,
      z: origin.z + normal.z * distance
    }
  };
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
