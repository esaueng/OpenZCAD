import {
  coerceParamValue,
  datumPlaneDependents,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { newCanonicalPlaneRef } from '@openzcad/geometry';
import {
  isFeatureSuppressed,
  type DatumPlaneDefinition,
  type DatumPlaneSource,
  type FacePlaneSource,
  type FeatureId,
  type FeatureNode,
  type PlaneId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import {
  PLANE_LABELS,
  evalParamValue,
  formatNumber,
  previewExpression
} from './model';
import { earlierDatumPlanes } from './datumPlaneDisplay';

export {
  datumPlaneDisplays,
  earlierDatumPlanes,
  type DatumPlaneDisplay
} from './datumPlaneDisplay';

/**
 * R01 datum planes, browser side: the Plane card's state, the source choices
 * it offers, and the words Items, History and the pickers use for a datum.
 * The geometry itself is the exact build's; nothing here re-derives a frame.
 */

export type DatumPlaneMode = DatumPlaneDefinition['kind'];

export interface DatumPlaneFormState {
  name: string;
  mode: DatumPlaneMode;
  /** Source A: the offset source, or a midplane's first plane. */
  sourceA: DatumPlaneSource | null;
  /** A midplane's second plane; ignored by an offset plane. */
  sourceB: DatumPlaneSource | null;
  /** The signed offset as typed: a number, a parameter or an expression. */
  offset: string;
  reverseNormal: boolean;
}

export interface DatumSourceOption {
  key: string;
  label: string;
  source: DatumPlaneSource;
}

const CANONICAL_ORDER: readonly PlaneId[] = ['XY', 'XZ', 'YZ'];

/** A stable identity for a source, so a select can hold it. */
export function datumSourceKey(source: DatumPlaneSource): string {
  switch (source.type) {
    case 'canonical':
      return `canonical:${source.plane}`;
    case 'datum':
      return `datum:${source.datumFeatureId}`;
    case 'face':
      return `face:${source.bodyId}:${source.faceHash}`;
  }
}

function datumFeature(
  document: ProjectDocument,
  featureId: FeatureId
): FeatureNode | undefined {
  return listFeaturesInOrder(document).find(
    (feature) =>
      feature.featureId === featureId &&
      feature.data.featureKind === 'datum-plane'
  );
}

/** What a source is called wherever a datum's definition is described. */
export function datumSourceLabel(
  document: ProjectDocument,
  source: DatumPlaneSource
): string {
  switch (source.type) {
    case 'canonical':
      return PLANE_LABELS[source.plane];
    case 'datum':
      return (
        datumFeature(document, source.datumFeatureId)?.name ?? 'a missing datum'
      );
    case 'face': {
      const body = document.derived.bodyRepresentations[source.bodyId];
      return `a face of ${body?.name ?? 'a missing body'}`;
    }
  }
}

/**
 * Sources the Plane card offers: the three principal planes, then earlier
 * datums, then any face sources the caller has (the selected face, the face
 * an edited datum already uses). Duplicates by key keep their first label.
 */
export function datumSourceOptions(
  document: ProjectDocument,
  beforeFeatureId: FeatureId | null,
  extra: readonly DatumSourceOption[] = []
): DatumSourceOption[] {
  const options: DatumSourceOption[] = CANONICAL_ORDER.map((plane) => {
    const source = newCanonicalPlaneRef(plane, 0);
    return { key: datumSourceKey(source), label: PLANE_LABELS[plane], source };
  });
  for (const datum of earlierDatumPlanes(document, beforeFeatureId)) {
    const source: DatumPlaneSource = {
      type: 'datum',
      datumFeatureId: datum.featureId
    };
    options.push({ key: datumSourceKey(source), label: datum.name, source });
  }
  const seen = new Set(options.map((option) => option.key));
  for (const option of extra) {
    if (seen.has(option.key)) continue;
    seen.add(option.key);
    options.push(option);
  }
  return options;
}

/** The option for a face source the caller already holds. */
export function faceSourceOption(
  document: ProjectDocument,
  source: FacePlaneSource,
  label?: string
): DatumSourceOption {
  return {
    key: datumSourceKey(source),
    label: label ?? datumSourceLabel(document, source),
    source
  };
}

export function newDatumPlaneFormState(
  name: string,
  sourceA: DatumPlaneSource | null
): DatumPlaneFormState {
  return {
    name,
    mode: 'offset',
    sourceA,
    sourceB: null,
    offset: '10',
    reverseNormal: false
  };
}

/** Reopens a datum's definition in the card it was made with. */
export function datumFormStateFromFeature(
  feature: FeatureNode
): DatumPlaneFormState {
  if (feature.data.featureKind !== 'datum-plane') {
    throw new Error(`${feature.name} is not a datum plane.`);
  }
  const { definition } = feature.data;
  return definition.kind === 'offset'
    ? {
        name: feature.name,
        mode: 'offset',
        sourceA: definition.source,
        sourceB: null,
        offset: String(definition.offset),
        reverseNormal: definition.reverseNormal === true
      }
    : {
        name: feature.name,
        mode: 'midplane',
        sourceA: definition.sources[0],
        sourceB: definition.sources[1],
        offset: '10',
        reverseNormal: definition.reverseNormal === true
      };
}

/**
 * Why the card cannot be checked yet, or null. "missing" is a step still to
 * take (said quietly); "invalid" is a value that will not work.
 */
export function datumFormValidation(
  state: DatumPlaneFormState,
  scope: Record<string, number>
): { kind: 'missing' | 'invalid'; reason: string } | null {
  if (!state.name.trim()) {
    return { kind: 'invalid', reason: 'Name the plane.' };
  }
  if (!state.sourceA) {
    return {
      kind: 'missing',
      reason:
        state.mode === 'offset'
          ? 'Choose the plane or face to offset from.'
          : 'Choose plane A.'
    };
  }
  if (state.mode === 'midplane') {
    if (!state.sourceB) return { kind: 'missing', reason: 'Choose plane B.' };
    if (datumSourceKey(state.sourceA) === datumSourceKey(state.sourceB)) {
      return {
        kind: 'invalid',
        reason: 'A midplane needs two different planes.'
      };
    }
    return null;
  }
  const preview = previewExpression(state.offset, scope);
  if (!preview.ok || preview.value === undefined) {
    return {
      kind: 'invalid',
      reason:
        preview.text === 'required'
          ? 'Enter an offset distance.'
          : `Offset: ${preview.text}`
    };
  }
  return null;
}

/** The definition the card's state authors. Validate first. */
export function buildDatumPlaneDefinition(
  state: DatumPlaneFormState
): DatumPlaneDefinition {
  if (!state.sourceA) throw new Error('A datum plane needs a source.');
  const reverse = state.reverseNormal ? { reverseNormal: true } : {};
  if (state.mode === 'offset') {
    return {
      kind: 'offset',
      source: state.sourceA,
      offset: coerceParamValue(state.offset.trim()),
      ...reverse
    };
  }
  if (!state.sourceB) throw new Error('A midplane needs two planes.');
  return {
    kind: 'midplane',
    sources: [state.sourceA, state.sourceB],
    ...reverse
  };
}

/**
 * One line for what a datum is built from: "10 mm from Top (XY)" or
 * "Midway between Top (XY) and Plane 1", with ", flipped" when reversed.
 */
export function datumPlaneDescription(
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  units: UnitSystem
): string | null {
  if (feature.data.featureKind !== 'datum-plane') return null;
  const { definition } = feature.data;
  const flipped = definition.reverseNormal ? ', flipped' : '';
  if (definition.kind === 'midplane') {
    const [a, b] = definition.sources;
    return `Midway between ${datumSourceLabel(document, a)} and ${datumSourceLabel(document, b)}${flipped}`;
  }
  const value = evalParamValue(definition.offset, scope, {
    documentUnits: units,
    dimension: 'length'
  });
  const distance =
    value === null
      ? String(definition.offset)
      : `${formatNumber(value)} ${units === 'inch' ? 'in' : units}`;
  return `${distance} from ${datumSourceLabel(document, definition.source)}${flipped}`;
}

export interface DatumPlaneRow {
  featureId: FeatureId;
  nodeId: string;
  name: string;
  description: string | null;
  /** The names of the sketches, Splits, Mirrors and datums built on it. */
  dependents: string[];
  suppressed: boolean;
  /** The exact build published a frame for it at this version. */
  resolved: boolean;
}

/** Every datum plane, in history order, as Items lists it. */
export function datumPlaneRows(
  document: ProjectDocument,
  scope: Record<string, number>
): DatumPlaneRow[] {
  return listFeaturesInOrder(document).flatMap((feature) =>
    feature.data.featureKind === 'datum-plane'
      ? [
          {
            featureId: feature.featureId,
            nodeId: feature.id,
            name: feature.name,
            description: datumPlaneDescription(
              document,
              feature,
              scope,
              document.units
            ),
            dependents: datumPlaneDependents(document, feature.featureId),
            suppressed: isFeatureSuppressed(feature),
            resolved: Boolean(document.derived.datumFrames?.[feature.featureId])
          }
        ]
      : []
  );
}

/** The next free "Plane N" name. */
export function nextDatumPlaneName(document: ProjectDocument): string {
  const names = new Set(
    listFeaturesInOrder(document).map((feature) => feature.name)
  );
  for (let index = 1; ; index += 1) {
    const name = `Plane ${index}`;
    if (!names.has(name)) return name;
  }
}

/** What the Plane card hands back: a name and the definition to build. */
export interface DatumPlaneSubmission {
  name: string;
  definition: DatumPlaneDefinition;
}

/**
 * The one command a Plane card's Done commits: a new datum (its id assigned
 * now, so the preflight and the commit name the same feature), or an edit of
 * the datum the card reopened.
 */
export function datumPlaneCommand(
  submission: DatumPlaneSubmission,
  editing: FeatureNode | null
): { command: AnyCommand; featureId: FeatureId } {
  if (editing) {
    return {
      featureId: editing.featureId,
      command: commandFactories.updateFeature(
        {
          featureId: editing.featureId,
          name: submission.name,
          data: {
            featureKind: 'datum-plane',
            definition: submission.definition
          }
        },
        `Edit ${submission.name}`
      )
    };
  }
  const command = commandFactories.addDatumPlane(submission);
  return { command, featureId: command.payload.ids!.featureId };
}

/**
 * Throws unless the rebuilt candidate resolved datum `featureId`: a datum has
 * no body to prove it built, so its published frame is the proof. A failure
 * the build attributed to it is reported in the build's own words.
 */
export function requireResolvedDatum(
  derived: ProjectDocument['derived'],
  featureId: FeatureId,
  name: string
): void {
  const failure = derived.featureWarnings?.find(
    (warning) =>
      warning.featureId === featureId &&
      (warning.kind === 'build-failed' || warning.kind === 'refusal')
  );
  if (failure) throw new Error(failure.message);
  if (!derived.datumFrames?.[featureId]) {
    throw new Error(`${name} did not resolve to a plane.`);
  }
}
