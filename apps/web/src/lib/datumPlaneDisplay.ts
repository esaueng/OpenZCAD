import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  deepClone,
  isFeatureSuppressed,
  type DatumFrame,
  type EdgeVertexPointSource,
  type FeatureId,
  type FeatureNode,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';

/*
 * Lightweight datum helpers the workspace shell itself calls. Kept apart from
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

/**
 * True when the build reports that this datum axis's edge or face source
 * could not be found: the one failure a re-picked edge or face can repair.
 */
export function datumAxisSourceFailed(
  feature: FeatureNode,
  warnings: readonly FeatureWarning[]
): boolean {
  const prefix = `Datum axis "${feature.name}" cannot `;
  return warnings.some(
    (warning) =>
      warning.featureId === feature.featureId &&
      [
        'run along an edge',
        'follow a face',
        'use an edge of body',
        'use a face of body'
      ].some((failure) => warning.message.includes(prefix + failure))
  );
}

/** An authored point role whose source can be explicitly picked again. */
export interface DatumVertexRepairSlot {
  index: 0 | 1 | 2;
  label: string;
  source: EdgeVertexPointSource;
}

export function datumVertexRepairSlots(
  feature: FeatureNode
): DatumVertexRepairSlot[] {
  const data = feature.data;
  const points =
    data.featureKind === 'datum-plane'
      ? data.definition.kind === 'three-point'
        ? data.definition.points
        : data.definition.kind === 'parallel-point'
          ? [data.definition.point]
          : []
      : data.featureKind === 'datum-axis' &&
          data.definition.kind === 'two-point'
        ? data.definition.points
        : [];
  return points.flatMap((source, index) =>
    source.type === 'edge-vertex'
      ? [{ index: index as 0 | 1 | 2, label: `Point ${index + 1}`, source }]
      : []
  );
}

/** Only a failure of this datum's vertex source offers the repair action. */
export function datumVertexSourceFailed(
  feature: FeatureNode,
  warnings: readonly FeatureWarning[]
): boolean {
  if (
    isFeatureSuppressed(feature) ||
    datumVertexRepairSlots(feature).length === 0
  )
    return false;
  const owner =
    feature.data.featureKind === 'datum-axis' ? 'Datum axis' : 'Datum plane';
  const prefix = `${owner} "`;
  return warnings.some(
    (warning) =>
      warning.featureId === feature.featureId &&
      (warning.kind === 'build-failed' || warning.kind === 'refusal') &&
      warning.message.includes(prefix) &&
      /" cannot use a vertex of (?:body \S+ because it is unavailable at the datum's history position\.|source feature "[\s\S]*?": )/.test(
        warning.message
      )
  );
}

export interface DatumVertexRepairSession {
  readonly projectId: ProjectDocument['projectId'];
  readonly documentVersion: number;
  readonly featureId: FeatureId;
  readonly featureName: string;
  readonly sourceData: FeatureNode['data'];
  readonly slots: readonly DatumVertexRepairSlot[];
  readonly replacements: readonly {
    index: DatumVertexRepairSlot['index'];
    source: EdgeVertexPointSource;
  }[];
  readonly pendingSlot: DatumVertexRepairSlot | null;
}

/** Nothing is published until every explicitly requested point role is staged. */
export function beginDatumVertexRepair(
  document: ProjectDocument,
  featureId: FeatureId,
  slotIndices: readonly number[],
  warnings: readonly FeatureWarning[] = document.derived.featureWarnings ?? []
): DatumVertexRepairSession {
  const feature = listFeaturesInOrder(document).find(
    (item) => item.featureId === featureId
  );
  if (!feature) throw new Error('The datum being repaired no longer exists.');
  const available = datumVertexRepairSlots(feature);
  if (!datumVertexSourceFailed(feature, warnings))
    throw new Error('This datum has no failed vertex source to repair.');
  if (
    slotIndices.length === 0 ||
    new Set(slotIndices).size !== slotIndices.length ||
    Array.from(slotIndices).some(
      (index) =>
        !Number.isInteger(index) ||
        !available.some((slot) => slot.index === index)
    )
  )
    throw new Error(
      'Choose each vertex point role once; typed points cannot be re-picked.'
    );
  const slots = deepClone(
    available.filter((slot) => slotIndices.includes(slot.index))
  );
  return {
    projectId: document.projectId,
    documentVersion: document.version,
    featureId,
    featureName: feature.name,
    sourceData: deepClone(feature.data),
    slots,
    replacements: [],
    pendingSlot: deepClone(slots[0]!)
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
