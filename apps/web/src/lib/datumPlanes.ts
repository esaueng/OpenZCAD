import {
  coerceParamValue,
  datumPlaneDependents,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  GEOMETRY_LINEAR_TOLERANCE,
  newCanonicalPlaneRef
} from '@openzcad/geometry';
import {
  datumPlaneSources,
  datumSourceBodyIds,
  isFeatureSuppressed,
  type BodyId,
  type DatumPlaneDefinition,
  type DatumPlaneSource,
  type DatumPointSource,
  type EdgeVertexPointSource,
  type FacePlaneSource,
  type FeatureId,
  type FeatureNode,
  type PlaneId,
  type ProjectDocument,
  type TopologySelection,
  type UnitSystem
} from '@openzcad/shared';
import {
  PLANE_LABELS,
  evalParamValue,
  formatNumber,
  previewExpression
} from './model';
import { affectedFeatureTargets } from './affectedFeatureTargets';
import { earlierDatumPlanes } from './datumPlaneDisplay';
import { faceSketchAttachment } from './faceSketchAttachment';

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

/**
 * A point slot as the card holds it: a picked vertex, or a position typed
 * as three expressions (lengths in document units).
 */
export type DatumPointDraft =
  | { type: 'vertex'; source: EdgeVertexPointSource }
  | { type: 'typed'; x: string; y: string; z: string };

export type DatumPointDrafts = [
  DatumPointDraft | null,
  DatumPointDraft | null,
  DatumPointDraft | null
];

export interface DatumPlaneFormState {
  name: string;
  mode: DatumPlaneMode;
  /**
   * Source A: the offset source, a midplane's first plane, or the plane a
   * parallel plane copies.
   */
  sourceA: DatumPlaneSource | null;
  /** A midplane's second plane; ignored by the other modes. */
  sourceB: DatumPlaneSource | null;
  /** The signed offset as typed: a number, a parameter or an expression. */
  offset: string;
  /**
   * The three points of a three-point plane; a parallel plane reads the
   * first as the point it passes through.
   */
  points: DatumPointDrafts;
  reverseNormal: boolean;
}

/** A vertex the card can offer for a point slot. */
export interface DatumPointOption {
  key: string;
  label: string;
  source: EdgeVertexPointSource;
}

const NO_POINTS: DatumPointDrafts = [null, null, null];

/** A stable identity for a vertex source, so a select can hold it. */
export function datumVertexKey(source: EdgeVertexPointSource): string {
  const { producingFeatureId, lineageName } = source.edgeReference;
  return `vertex:${source.bodyId}:${producingFeatureId}:${lineageName}:${source.end}`;
}

/**
 * Both ends of an open edge, in the order an edge-vertex source's `end`
 * names them: the end whose quantized coordinates sort first by x, then y,
 * then z is end 0 (the exact build reads the same integers). Positions are
 * the stored quantized witness, good to the 1e-6 quantum, for labels and
 * nearest-end picks only.
 */
export function edgeEnds(
  witness: EdgeVertexPointSource['edgeReference']['witness']
):
  | [{ x: number; y: number; z: number }, { x: number; y: number; z: number }]
  | null {
  if (witness.closed) return null;
  const [a, b] = witness.endpoints;
  let order = 0;
  for (let index = 0; index < 3 && order === 0; index += 1)
    order = Math.sign(a[index]! - b[index]!);
  const point = ([x, y, z]: [number, number, number]) => ({
    x: x * GEOMETRY_LINEAR_TOLERANCE,
    y: y * GEOMETRY_LINEAR_TOLERANCE,
    z: z * GEOMETRY_LINEAR_TOLERANCE
  });
  return order <= 0 ? [point(a), point(b)] : [point(b), point(a)];
}

function formatPoint(point: { x: number; y: number; z: number }): string {
  return `(${formatNumber(point.x)}, ${formatNumber(point.y)}, ${formatNumber(point.z)})`;
}

/**
 * The vertex source a picked edge gives a point slot: the end nearer the
 * click (end 0 without one), or a refusal in words for the card. The edge
 * must be open and carry an identity a rebuild can find again.
 */
export function datumVertexFromEdgePick(
  document: ProjectDocument,
  selection: { kind: string; bodyId: BodyId; hash?: number },
  clickPoint: { x: number; y: number; z: number } | null
): EdgeVertexPointSource | { reason: string } {
  const edge = document.derived.bodyRepresentations[
    selection.bodyId
  ]?.topology?.edges.find((candidate) => candidate.hash === selection.hash);
  const reference = edge?.reference;
  if (!reference) {
    return {
      reason:
        'This edge has no identity a rebuild can find again, so a plane cannot pass through its ends.'
    };
  }
  const ends = edgeEnds(reference.witness);
  if (!ends) {
    return {
      reason: 'A closed edge has no end vertex; pick a straight or open edge.'
    };
  }
  const distance = (point: { x: number; y: number; z: number }) =>
    clickPoint
      ? Math.hypot(
          point.x - clickPoint.x,
          point.y - clickPoint.y,
          point.z - clickPoint.z
        )
      : 0;
  return {
    type: 'edge-vertex',
    bodyId: selection.bodyId,
    edgeReference: reference,
    end: distance(ends[1]) < distance(ends[0]) ? 1 : 0
  };
}

/** The option for a vertex source, labelled with where it is. */
export function datumVertexOption(
  document: ProjectDocument,
  source: EdgeVertexPointSource,
  label = 'Vertex'
): DatumPointOption {
  const end = edgeEnds(source.edgeReference.witness)?.[source.end];
  const body = document.derived.bodyRepresentations[source.bodyId]?.name;
  return {
    key: datumVertexKey(source),
    label: `${label}${end ? ` ${formatPoint(end)}` : ''}${body ? ` of ${body}` : ''}`,
    source
  };
}

/** The draft a stored point source reopens as. */
function pointDraft(source: DatumPointSource): DatumPointDraft {
  return source.type === 'edge-vertex'
    ? { type: 'vertex', source }
    : {
        type: 'typed',
        x: String(source.point.x),
        y: String(source.point.y),
        z: String(source.point.z)
      };
}

/** The point source a draft authors. Validate first. */
function pointSource(draft: DatumPointDraft): DatumPointSource {
  return draft.type === 'vertex'
    ? draft.source
    : {
        type: 'point',
        point: {
          x: coerceParamValue(draft.x.trim()),
          y: coerceParamValue(draft.y.trim()),
          z: coerceParamValue(draft.z.trim())
        }
      };
}

/** What a point is called wherever a datum's definition is described. */
export function datumPointLabel(
  document: ProjectDocument,
  source: DatumPointSource,
  scope: Record<string, number> = {},
  units: UnitSystem = document.units
): string {
  if (source.type === 'edge-vertex') {
    const body = document.derived.bodyRepresentations[source.bodyId];
    return `a vertex of ${body?.name ?? 'a missing body'}`;
  }
  const axis = (value: string | number) => {
    const resolved = evalParamValue(value, scope, {
      documentUnits: units,
      dimension: 'length'
    });
    return resolved === null ? String(value) : formatNumber(resolved);
  };
  return `(${axis(source.point.x)}, ${axis(source.point.y)}, ${axis(source.point.z)})`;
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
    points: NO_POINTS,
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
  const base: DatumPlaneFormState = {
    name: feature.name,
    mode: definition.kind,
    sourceA: null,
    sourceB: null,
    offset: '10',
    points: NO_POINTS,
    reverseNormal: definition.reverseNormal === true
  };
  switch (definition.kind) {
    case 'offset':
      return {
        ...base,
        sourceA: definition.source,
        offset: String(definition.offset)
      };
    case 'midplane':
      return {
        ...base,
        sourceA: definition.sources[0],
        sourceB: definition.sources[1]
      };
    case 'three-point':
      return {
        ...base,
        points: definition.points.map(pointDraft) as DatumPointDrafts
      };
    case 'parallel-point':
      return {
        ...base,
        sourceA: definition.source,
        points: [pointDraft(definition.point), null, null]
      };
  }
}

const POINT_ORDINALS = ['first', 'second', 'third'] as const;

/** Why a point slot cannot be used yet, or null. */
function pointValidation(
  draft: DatumPointDraft | null,
  name: string,
  scope: Record<string, number>,
  units?: UnitSystem
): { kind: 'missing' | 'invalid'; reason: string } | null {
  if (!draft) {
    return {
      kind: 'missing',
      reason: `Pick an edge end for the ${name} point, or type its position.`
    };
  }
  if (draft.type === 'vertex') return null;
  for (const axis of ['x', 'y', 'z'] as const) {
    const preview = previewExpression(
      draft[axis],
      scope,
      units ? { documentUnits: units, dimension: 'length' } : undefined
    );
    if (!preview.ok || preview.value === undefined) {
      return {
        kind: 'invalid',
        reason: `The ${name} point's ${axis.toUpperCase()}: ${preview.text === 'required' ? 'enter a position' : preview.text}`
      };
    }
  }
  return null;
}

function pointDraftKey(draft: DatumPointDraft | null): string | null {
  return draft?.type === 'vertex'
    ? datumVertexKey(draft.source)
    : draft
      ? `typed:${draft.x.trim()}:${draft.y.trim()}:${draft.z.trim()}`
      : null;
}

/**
 * Why the card cannot be checked yet, or null. "missing" is a step still to
 * take (said quietly); "invalid" is a value that will not work.
 */
export function datumFormValidation(
  state: DatumPlaneFormState,
  scope: Record<string, number>,
  /** The document's units: an offset is a length and may carry a suffix. */
  units?: UnitSystem
): { kind: 'missing' | 'invalid'; reason: string } | null {
  if (!state.name.trim()) {
    return { kind: 'invalid', reason: 'Name the plane.' };
  }
  if (state.mode === 'three-point') {
    for (let index = 0; index < 3; index += 1) {
      const problem = pointValidation(
        state.points[index]!,
        POINT_ORDINALS[index]!,
        scope,
        units
      );
      if (problem) return problem;
    }
    const keys = state.points.map(pointDraftKey);
    if (new Set(keys).size < 3) {
      return {
        kind: 'invalid',
        reason: 'A three-point plane needs three different points.'
      };
    }
    return null;
  }
  if (!state.sourceA) {
    return {
      kind: 'missing',
      reason:
        state.mode === 'offset'
          ? 'Choose the plane or face to offset from.'
          : state.mode === 'parallel-point'
            ? 'Choose the plane or face to run parallel to.'
            : 'Choose plane A.'
    };
  }
  if (state.mode === 'parallel-point') {
    return pointValidation(state.points[0], 'through', scope, units);
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
  const preview = previewExpression(
    state.offset,
    scope,
    units ? { documentUnits: units, dimension: 'length' } : undefined
  );
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
  const reverse = state.reverseNormal ? { reverseNormal: true } : {};
  if (state.mode === 'three-point') {
    if (state.points.some((point) => !point))
      throw new Error('A three-point plane needs three points.');
    return {
      kind: 'three-point',
      points: state.points.map((point) => pointSource(point!)) as [
        DatumPointSource,
        DatumPointSource,
        DatumPointSource
      ],
      ...reverse
    };
  }
  if (!state.sourceA) throw new Error('A datum plane needs a source.');
  if (state.mode === 'parallel-point') {
    if (!state.points[0]) throw new Error('A parallel plane needs a point.');
    return {
      kind: 'parallel-point',
      source: state.sourceA,
      point: pointSource(state.points[0]),
      ...reverse
    };
  }
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
  if (definition.kind === 'three-point') {
    const [a, b, c] = definition.points.map((point) =>
      datumPointLabel(document, point, scope, units)
    );
    return `Through ${a}, ${b} and ${c}${flipped}`;
  }
  if (definition.kind === 'parallel-point') {
    return `Parallel to ${datumSourceLabel(document, definition.source)} through ${datumPointLabel(document, definition.point, scope, units)}${flipped}`;
  }
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

/**
 * The datums an edit of datum `featureId` can move, in history order: those
 * built on it through other datums, and those on a face of a body that a
 * Split, Mirror or other feature driven by it produces. A datum owns no
 * body, so a body-target walk never reports one; an edit has to check their
 * frames itself or a later plane could fail behind a "validated" commit.
 */
export function downstreamDatumIds(
  document: ProjectDocument,
  featureId: FeatureId
): FeatureId[] {
  const affected = new Set<string>([
    featureId,
    ...affectedFeatureTargets(document, featureId).map(
      (target) => target.resultBodyId
    )
  ]);
  const downstream: FeatureId[] = [];
  let after = false;
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.featureId === featureId) {
      after = true;
      continue;
    }
    if (!after || feature.data.featureKind !== 'datum-plane') continue;
    const { definition } = feature.data;
    if (
      datumPlaneSources(definition).some(
        (source) =>
          source.type === 'datum' && affected.has(source.datumFeatureId)
      ) ||
      datumSourceBodyIds(definition).some((bodyId) => affected.has(bodyId))
    ) {
      affected.add(feature.featureId);
      downstream.push(feature.featureId);
    }
  }
  return downstream;
}

/**
 * Throws unless an edit of datum `featureId` leaves it and every downstream
 * datum that resolved before the edit still resolved. A datum that was
 * already broken is not the edit's fault and does not refuse it.
 */
export function requireResolvedDatums(
  before: ProjectDocument,
  derived: ProjectDocument['derived'],
  featureId: FeatureId,
  name: string
): void {
  requireResolvedDatum(derived, featureId, name);
  for (const id of downstreamDatumIds(before, featureId)) {
    if (!before.derived.datumFrames?.[id]) continue;
    const datum = listFeaturesInOrder(before).find(
      (feature) => feature.featureId === id
    );
    requireResolvedDatum(derived, id, datum?.name ?? 'A later plane');
  }
}

/**
 * R01: the edit that re-attaches a datum whose source face no longer
 * resolves to the face picked now: an offset plane's source, or the chosen
 * face (`slot` 0 for A, 1 for B) of a midplane. Only that source changes:
 * distance, mode, the other source and direction are kept. Throws, in words
 * for the status bar, when the pick cannot carry a datum (not a planar face
 * with a rebuildable identity).
 */
/**
 * The face source a pick gives a datum, or a refusal in words for the status
 * bar: the pick must be a planar face with a rebuildable identity.
 */
export function datumFaceSourceFromPick(
  document: ProjectDocument,
  datumName: string,
  selection: TopologySelection
): FacePlaneSource {
  if (selection.kind !== 'face') {
    throw new Error(`Click a planar face for "${datumName}".`);
  }
  const attachment = faceSketchAttachment({
    bodyId: selection.bodyId,
    pickedHash: selection.hash,
    face: document.derived.bodyRepresentations[
      selection.bodyId
    ]?.topology?.faces.find((face) => face.hash === selection.hash)
  });
  if (!attachment.ok) throw new Error(attachment.reason);
  const ref = attachment.planeRef;
  if (ref.type !== 'face' || !ref.faceReference || !ref.sourceCentroid) {
    throw new Error(
      'This face has no identity a rebuild can find again, so a plane cannot follow it.'
    );
  }
  return ref as FacePlaneSource;
}

export function datumFaceRepairEdit(
  document: ProjectDocument,
  featureId: FeatureId,
  selection: TopologySelection,
  slot: 0 | 1 = 0,
  /**
   * A midplane whose two faces were both lost: the face picked for the
   * other slot, so one validated edit replaces both (either alone would
   * still leave the datum unresolved and roll back).
   */
  otherSelection?: TopologySelection
): {
  command: AnyCommand;
  label: string;
  validateDerived(derived: ProjectDocument['derived']): void;
} {
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.featureId === featureId
  );
  if (
    feature?.data.featureKind !== 'datum-plane' ||
    feature.data.definition.kind === 'three-point' ||
    (feature.data.definition.kind !== 'midplane' &&
      (slot !== 0 || otherSelection !== undefined))
  ) {
    throw new Error('Only a datum plane source can be re-picked here.');
  }
  const source = datumFaceSourceFromPick(document, feature.name, selection);
  const other = otherSelection
    ? datumFaceSourceFromPick(document, feature.name, otherSelection)
    : undefined;
  const label = `Re-pick face for ${feature.name}`;
  const { definition } = feature.data;
  const repaired: DatumPlaneDefinition =
    definition.kind !== 'midplane'
      ? { ...definition, source }
      : {
          ...definition,
          sources:
            slot === 0
              ? [source, other ?? definition.sources[1]]
              : [other ?? definition.sources[0], source]
        };
  return {
    label,
    command: commandFactories.updateFeature(
      {
        featureId,
        data: { featureKind: 'datum-plane', definition: repaired }
      },
      label
    ),
    validateDerived: (derived) =>
      requireResolvedDatums(document, derived, featureId, feature.name)
  };
}
