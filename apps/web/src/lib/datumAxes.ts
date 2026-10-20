import {
  datumAxisDependents,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  isFeatureSuppressed,
  type BodyId,
  type DatumAxisDefinition,
  type DatumAxisEdgeSource,
  type DatumAxisFaceSource,
  type DatumPlaneSource,
  type DatumPointSource,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument,
  type TopologySelection,
  type UnitSystem
} from '@openzcad/shared';
import { formatNumber } from './model';
import {
  datumPointDraftKey,
  datumPointDraftOf,
  datumPointLabel,
  datumPointSourceOf,
  datumPointValidation,
  datumSourceKey,
  datumSourceLabel,
  edgeEnds,
  requireResolvedDatums,
  type DatumPointDraft
} from './datumPlanes';

/**
 * R01 datum axes, browser side: the Axis card's state, the sources a pick
 * offers it, the words Items, History and the axis pickers use, and the
 * source repair. The line itself is the exact build's; nothing here
 * re-derives one.
 */

export type DatumAxisMode = DatumAxisDefinition['kind'];

export interface DatumAxisFormState {
  name: string;
  mode: DatumAxisMode;
  /** The two points of an axis through two points (from the first). */
  points: [DatumPointDraft | null, DatumPointDraft | null];
  /** The straight edge an axis runs along. */
  edge: DatumAxisEdgeSource | null;
  /** The cylindrical or conical face whose axis it follows. */
  face: DatumAxisFaceSource | null;
  /** Planes A and B of an axis where two planes meet. */
  sourceA: DatumPlaneSource | null;
  sourceB: DatumPlaneSource | null;
  reverseDirection: boolean;
}

export const DATUM_AXIS_MODE_LABELS: Record<DatumAxisMode, string> = {
  'two-point': 'Two points',
  edge: 'Along edge',
  cylinder: 'Cylinder axis',
  'plane-intersection': 'Two planes'
};

export function newDatumAxisFormState(name: string): DatumAxisFormState {
  return {
    name,
    mode: 'two-point',
    points: [null, null],
    edge: null,
    face: null,
    sourceA: null,
    sourceB: null,
    reverseDirection: false
  };
}

/** Reopens an axis's definition in the card it was made with. */
export function datumAxisFormStateFromFeature(
  feature: FeatureNode
): DatumAxisFormState {
  if (feature.data.featureKind !== 'datum-axis') {
    throw new Error(`${feature.name} is not a datum axis.`);
  }
  const { definition } = feature.data;
  const base: DatumAxisFormState = {
    ...newDatumAxisFormState(feature.name),
    mode: definition.kind,
    reverseDirection: definition.reverseDirection === true
  };
  switch (definition.kind) {
    case 'two-point':
      return {
        ...base,
        points: [
          datumPointDraftOf(definition.points[0]),
          datumPointDraftOf(definition.points[1])
        ]
      };
    case 'edge':
      return { ...base, edge: definition.source };
    case 'cylinder':
      return { ...base, face: definition.source };
    case 'plane-intersection':
      return {
        ...base,
        sourceA: definition.sources[0],
        sourceB: definition.sources[1]
      };
  }
}

/**
 * Why the card cannot be checked yet, or null. "missing" is a step still to
 * take (said quietly); "invalid" is a value that will not work.
 */
export function datumAxisFormValidation(
  state: DatumAxisFormState,
  scope: Record<string, number>,
  units?: UnitSystem
): { kind: 'missing' | 'invalid'; reason: string } | null {
  if (!state.name.trim()) return { kind: 'invalid', reason: 'Name the axis.' };
  switch (state.mode) {
    case 'two-point': {
      for (const [index, name] of [
        [0, 'first'],
        [1, 'second']
      ] as const) {
        const problem = datumPointValidation(
          state.points[index],
          name,
          scope,
          units
        );
        if (problem) return problem;
      }
      if (
        datumPointDraftKey(state.points[0]) ===
        datumPointDraftKey(state.points[1])
      ) {
        return {
          kind: 'invalid',
          reason: 'An axis through two points needs two different points.'
        };
      }
      return null;
    }
    case 'edge':
      return state.edge
        ? null
        : {
            kind: 'missing',
            reason: 'Pick a straight edge in the viewport.'
          };
    case 'cylinder':
      return state.face
        ? null
        : {
            kind: 'missing',
            reason: 'Pick a cylindrical or conical face in the viewport.'
          };
    case 'plane-intersection':
      if (!state.sourceA) return { kind: 'missing', reason: 'Choose plane A.' };
      if (!state.sourceB) return { kind: 'missing', reason: 'Choose plane B.' };
      if (datumSourceKey(state.sourceA) === datumSourceKey(state.sourceB)) {
        return {
          kind: 'invalid',
          reason: 'An axis where two planes meet needs two different planes.'
        };
      }
      return null;
  }
}

/** The definition the card's state authors. Validate first. */
export function buildDatumAxisDefinition(
  state: DatumAxisFormState
): DatumAxisDefinition {
  const reverse = state.reverseDirection ? { reverseDirection: true } : {};
  switch (state.mode) {
    case 'two-point':
      if (!state.points[0] || !state.points[1])
        throw new Error('An axis through two points needs two points.');
      return {
        kind: 'two-point',
        points: [
          datumPointSourceOf(state.points[0]),
          datumPointSourceOf(state.points[1])
        ],
        ...reverse
      };
    case 'edge':
      if (!state.edge) throw new Error('An axis along an edge needs an edge.');
      return { kind: 'edge', source: state.edge, ...reverse };
    case 'cylinder':
      if (!state.face) throw new Error('A cylinder axis needs a face.');
      return { kind: 'cylinder', source: state.face, ...reverse };
    case 'plane-intersection':
      if (!state.sourceA || !state.sourceB)
        throw new Error('An axis where two planes meet needs two planes.');
      return {
        kind: 'plane-intersection',
        sources: [state.sourceA, state.sourceB],
        ...reverse
      };
  }
}

/**
 * The straight edge a viewport edge pick gives the Axis card, or why it
 * cannot be one: it must be open, straight and carry an identity a rebuild
 * can find again.
 */
export function datumAxisEdgeFromPick(
  document: ProjectDocument,
  selection: { kind: string; bodyId: BodyId; hash?: number }
): DatumAxisEdgeSource | { reason: string } {
  const edge = document.derived.bodyRepresentations[
    selection.bodyId
  ]?.topology?.edges.find((candidate) => candidate.hash === selection.hash);
  const reference = edge?.reference;
  if (!reference) {
    return {
      reason:
        'This edge has no identity a rebuild can find again, so an axis cannot follow it.'
    };
  }
  if (
    reference.witness.closed ||
    !/^line$/i.test(reference.witness.curveType)
  ) {
    return {
      reason: 'An axis runs along a straight edge; this edge is curved.'
    };
  }
  return { type: 'edge', bodyId: selection.bodyId, edgeReference: reference };
}

/**
 * The cylindrical or conical face a viewport face pick gives the Axis card,
 * or why it cannot be one.
 */
export function datumAxisFaceFromPick(
  document: ProjectDocument,
  selection: { kind: string; bodyId: BodyId; hash?: number }
): DatumAxisFaceSource | { reason: string } {
  const face = document.derived.bodyRepresentations[
    selection.bodyId
  ]?.topology?.faces.find((candidate) => candidate.hash === selection.hash);
  const type = face?.geometry?.surfaceType.toLowerCase();
  if (type !== 'cylinder' && type !== 'cone') {
    return {
      reason: 'An axis follows a cylindrical or conical face; this face is not.'
    };
  }
  if (!face?.reference) {
    return {
      reason:
        'This face has no identity a rebuild can find again, so an axis cannot follow it.'
    };
  }
  return {
    type: 'face',
    bodyId: selection.bodyId,
    faceReference: face.reference
  };
}

function bodyName(document: ProjectDocument, bodyId: BodyId): string {
  return document.derived.bodyRepresentations[bodyId]?.name ?? 'a missing body';
}

/** What an edge source is called: its ends when known, and its body. */
export function datumAxisEdgeLabel(
  document: ProjectDocument,
  source: DatumAxisEdgeSource
): string {
  const ends = edgeEnds(source.edgeReference.witness);
  const at = ends
    ? ` (${ends
        .map(
          (end) =>
            `${formatNumber(end.x)}, ${formatNumber(end.y)}, ${formatNumber(end.z)}`
        )
        .join(') → (')})`
    : '';
  return `an edge${at} of ${bodyName(document, source.bodyId)}`;
}

export function datumAxisFaceLabel(
  document: ProjectDocument,
  source: DatumAxisFaceSource
): string {
  return `a ${source.faceReference.witness.surfaceType.toLowerCase()} of ${bodyName(document, source.bodyId)}`;
}

/** One line for what an axis is built from, with ", reversed" when flipped. */
export function datumAxisDescription(
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  units: UnitSystem
): string | null {
  if (feature.data.featureKind !== 'datum-axis') return null;
  const { definition } = feature.data;
  const reversed = definition.reverseDirection ? ', reversed' : '';
  switch (definition.kind) {
    case 'two-point': {
      const [a, b] = definition.points.map((point: DatumPointSource) =>
        datumPointLabel(document, point, scope, units)
      );
      return `Through ${a} and ${b}${reversed}`;
    }
    case 'edge':
      return `Along ${datumAxisEdgeLabel(document, definition.source)}${reversed}`;
    case 'cylinder':
      return `Axis of ${datumAxisFaceLabel(document, definition.source)}${reversed}`;
    case 'plane-intersection': {
      const [a, b] = definition.sources;
      return `Where ${datumSourceLabel(document, a)} meets ${datumSourceLabel(document, b)}${reversed}`;
    }
  }
}

/** The next free "Axis N" name. */
export function nextDatumAxisName(document: ProjectDocument): string {
  const names = new Set(
    listFeaturesInOrder(document).map((feature) => feature.name)
  );
  for (let index = 1; ; index += 1) {
    const name = `Axis ${index}`;
    if (!names.has(name)) return name;
  }
}

export interface DatumAxisSubmission {
  name: string;
  definition: DatumAxisDefinition;
}

/**
 * The one command an Axis card's Done commits: a new axis (its id assigned
 * now, so the preflight and the commit name the same feature), or an edit
 * of the axis the card reopened.
 */
export function datumAxisCommand(
  submission: DatumAxisSubmission,
  editing: FeatureNode | null
): { command: AnyCommand; featureId: FeatureId } {
  if (editing) {
    return {
      featureId: editing.featureId,
      command: commandFactories.updateFeature(
        {
          featureId: editing.featureId,
          name: submission.name,
          data: { featureKind: 'datum-axis', definition: submission.definition }
        },
        `Edit ${submission.name}`
      )
    };
  }
  const command = commandFactories.addDatumAxis(submission);
  return { command, featureId: command.payload.ids!.featureId };
}

export interface DatumAxisRow {
  featureId: FeatureId;
  nodeId: string;
  name: string;
  description: string | null;
  /** The revolves, patterns and Moves that turn about it. */
  dependents: string[];
  suppressed: boolean;
  /** The exact build published a line for it at this version. */
  resolved: boolean;
}

/** Every datum axis, in history order, as Items lists it. */
export function datumAxisRows(
  document: ProjectDocument,
  scope: Record<string, number>
): DatumAxisRow[] {
  return listFeaturesInOrder(document).flatMap((feature) =>
    feature.data.featureKind === 'datum-axis'
      ? [
          {
            featureId: feature.featureId,
            nodeId: feature.id,
            name: feature.name,
            description: datumAxisDescription(
              document,
              feature,
              scope,
              document.units
            ),
            dependents: datumAxisDependents(document, feature.featureId),
            suppressed: isFeatureSuppressed(feature),
            resolved: Boolean(document.derived.datumAxes?.[feature.featureId])
          }
        ]
      : []
  );
}

/**
 * The edit that re-attaches an axis whose edge or face source no longer
 * resolves to the one picked now: an edge for an axis along an edge, a
 * cylinder or cone for a cylinder axis. Only the source changes; the
 * direction setting is kept. Throws, in words for the status bar, when the
 * pick cannot carry the axis.
 */
export function datumAxisSourceRepairEdit(
  document: ProjectDocument,
  featureId: FeatureId,
  selection: TopologySelection
): {
  command: AnyCommand;
  label: string;
  validateDerived(derived: ProjectDocument['derived']): void;
} {
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.featureId === featureId
  );
  if (
    feature?.data.featureKind !== 'datum-axis' ||
    (feature.data.definition.kind !== 'edge' &&
      feature.data.definition.kind !== 'cylinder')
  ) {
    throw new Error('Only an axis along an edge or a face can be re-picked.');
  }
  const { definition } = feature.data;
  let repaired: DatumAxisDefinition;
  if (definition.kind === 'edge') {
    if (selection.kind !== 'edge') {
      throw new Error(`Click a straight edge for "${feature.name}".`);
    }
    const source = datumAxisEdgeFromPick(document, selection);
    if ('reason' in source) throw new Error(source.reason);
    repaired = { ...definition, source };
  } else {
    if (selection.kind !== 'face') {
      throw new Error(
        `Click a cylindrical or conical face for "${feature.name}".`
      );
    }
    const source = datumAxisFaceFromPick(document, selection);
    if ('reason' in source) throw new Error(source.reason);
    repaired = { ...definition, source };
  }
  const label = `Re-pick source for ${feature.name}`;
  return {
    label,
    command: commandFactories.updateFeature(
      {
        featureId,
        data: { featureKind: 'datum-axis', definition: repaired }
      },
      label
    ),
    validateDerived: (derived) =>
      requireResolvedDatums(
        document,
        derived,
        featureId,
        feature.name,
        'datum-axis'
      )
  };
}
