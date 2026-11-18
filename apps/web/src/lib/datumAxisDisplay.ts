import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type DatumAxisLine,
  type DatumCsysFrame,
  type Vector3,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/** A datum axis as the viewport draws it: presentation only. */
export interface DatumAxisDisplay {
  featureId: FeatureId;
  name: string;
  axis: DatumAxisLine;
  selected: boolean;
}

/**
 * The resolved, shown datum axes. An axis with no line (failed, suppressed
 * or still building) draws nothing rather than a guess.
 */
export function datumAxisDisplays(
  document: ProjectDocument,
  hidden: ReadonlySet<string>,
  selectedFeatureId: FeatureId | null
): DatumAxisDisplay[] {
  const lines = document.derived.datumAxes ?? {};
  return listFeaturesInOrder(document).flatMap((feature) => {
    const axis = lines[feature.featureId];
    return feature.data.featureKind === 'datum-axis' &&
      axis &&
      !isFeatureSuppressed(feature) &&
      !hidden.has(feature.featureId)
      ? [
          {
            featureId: feature.featureId,
            name: feature.name,
            axis,
            selected: feature.featureId === selectedFeatureId
          }
        ]
      : [];
  });
}

/** R01 (schema v99): a datum point as the viewport draws it. */
export interface DatumPointDisplay {
  featureId: FeatureId;
  name: string;
  point: Vector3;
  selected: boolean;
}

/** R01 (schema v99): a coordinate system as the viewport draws it. */
export interface DatumCsysDisplay {
  featureId: FeatureId;
  name: string;
  frame: DatumCsysFrame;
  selected: boolean;
}

/**
 * The resolved, shown datum points and coordinate systems. One that did not
 * resolve (failed, suppressed or still building) draws nothing.
 */
export function datumMarkerDisplays(
  document: ProjectDocument,
  hidden: ReadonlySet<string>,
  selectedFeatureId: FeatureId | null
): { points: DatumPointDisplay[]; systems: DatumCsysDisplay[] } {
  const positions = document.derived.datumPoints ?? {};
  const frames = document.derived.datumCsys ?? {};
  const points: DatumPointDisplay[] = [];
  const systems: DatumCsysDisplay[] = [];
  for (const feature of listFeaturesInOrder(document)) {
    if (isFeatureSuppressed(feature) || hidden.has(feature.featureId)) continue;
    const selected = feature.featureId === selectedFeatureId;
    const point = positions[feature.featureId];
    const frame = frames[feature.featureId];
    if (feature.data.featureKind === 'datum-point' && point)
      points.push({ featureId: feature.featureId, name: feature.name, point, selected });
    if (feature.data.featureKind === 'datum-csys' && frame)
      systems.push({ featureId: feature.featureId, name: feature.name, frame, selected });
  }
  return { points, systems };
}
