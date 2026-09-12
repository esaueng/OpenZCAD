import { createFeatureOnlyIds, listFeaturesInOrder } from '@openzcad/document-core';
import type {
  BodyId,
  DirectEditOperation,
  FeatureNode,
  ProjectDocument,
  Vector3
} from '@openzcad/shared';
import type {
  CadPatchProposal,
  GrowingHolderHoleReference
} from '@openzcad/ai-contracts';
import {
  growingHolderHistories,
  type GrowingHolderHistory,
  type OpeningAxis
} from './growing-holder';
import { commandFactories, composeCommands, type AnyCommand } from './index';

export const GROWING_HOLDER_HOLE_PARAMETER = 'hole_diameter';

/** One through bore of a growing holder, measured on the end that carries it. */
export type GrowingHolderHole = GrowingHolderHoleReference & { bodyId: BodyId };

/** The two bores that mirror each other across the holder's center. */
export interface GrowingHolderHolePair {
  history: GrowingHolderHistory;
  negative: GrowingHolderHole;
  positive: GrowingHolderHole;
  diameter: number;
}

export type GrowingHolderHoleMatch =
  | { status: 'matched'; pair: GrowingHolderHolePair }
  | { status: 'ambiguous'; reason: string; pairs: GrowingHolderHolePair[] }
  | { status: 'unsupported'; reason: string };

const AXES = ['x', 'y', 'z'] as const;
const TOLERANCE = 1e-6;
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

function endHoles(
  document: ProjectDocument,
  bodyId: BodyId,
  axis: OpeningAxis
): GrowingHolderHole[] {
  const faces = document.derived.bodyRepresentations[bodyId]?.topology?.faces ?? [];
  return faces.flatMap((face) => {
    const geometry = face.geometry;
    if (
      geometry?.featureType !== 'through-hole' ||
      geometry.diameter === undefined ||
      !geometry.axisStart ||
      !geometry.axisEnd ||
      !face.reference ||
      face.reference.currentHash !== face.hash
    )
      return [];
    const direction = {
      x: geometry.axisEnd.x - geometry.axisStart.x,
      y: geometry.axisEnd.y - geometry.axisStart.y,
      z: geometry.axisEnd.z - geometry.axisStart.z
    };
    const length = Math.hypot(direction.x, direction.y, direction.z);
    // A bore that runs along the opening axis would cross the moving cut;
    // the mounting bores are perpendicular to it.
    if (length <= TOLERANCE || Math.abs(direction[axis]) / length > TOLERANCE)
      return [];
    return [
      {
        bodyId,
        faceHash: face.hash,
        faceReference: face.reference,
        sourceDiameter: geometry.diameter,
        sourceAxisStart: geometry.axisStart,
        sourceAxisEnd: geometry.axisEnd
      }
    ];
  });
}

/** Endpoints sorted so a reversed axis still compares equal. */
const orderedEnds = (hole: GrowingHolderHole): [Vector3, Vector3] =>
  [hole.sourceAxisStart, hole.sourceAxisEnd].sort(
    (a, b) => a.x - b.x || a.y - b.y || a.z - b.z
  ) as [Vector3, Vector3];

function mirrored(
  negative: GrowingHolderHole,
  positive: GrowingHolderHole,
  axis: OpeningAxis,
  center: number
): boolean {
  if (!near(negative.sourceDiameter, positive.sourceDiameter)) return false;
  const [n0, n1] = orderedEnds(negative);
  const [p0, p1] = orderedEnds(positive);
  const others = AXES.filter((other) => other !== axis);
  const sameAcross = (a: Vector3, b: Vector3) =>
    near(a[axis] + b[axis], 2 * center) && others.every((o) => near(a[o], b[o]));
  return (sameAcross(n0, p0) && sameAcross(n1, p1)) || (sameAcross(n0, p1) && sameAcross(n1, p0));
}

/**
 * Find the pair of mirror-image through bores on a growing holder's two ends.
 * Measured from the derived topology of the carved end bodies, which keep
 * their geometry at every opening; nothing here is authored.
 */
export function matchGrowingHolderHoles(
  document: ProjectDocument,
  history: GrowingHolderHistory
): GrowingHolderHoleMatch {
  const { axis, center } = history.recipe;
  const negatives = endHoles(document, history.negativeEndBodyId, axis);
  const positives = endHoles(document, history.positiveEndBodyId, axis);
  if (!negatives.length || !positives.length)
    return {
      status: 'unsupported',
      reason: 'No through bore perpendicular to the opening was measured on both ends.'
    };
  const pairs: GrowingHolderHolePair[] = [];
  for (const negative of negatives)
    for (const positive of positives)
      if (mirrored(negative, positive, axis, center))
        pairs.push({ history, negative, positive, diameter: negative.sourceDiameter });
  if (!pairs.length)
    return {
      status: 'unsupported',
      reason: 'The through bores on the two ends are not mirror images of each other.'
    };
  if (pairs.length > 1)
    return {
      status: 'ambiguous',
      reason: 'More than one mirrored pair of bores was found; select the intended pair.',
      pairs
    };
  return { status: 'matched', pair: pairs[0]! };
}

/** The resize edits an existing hole control placed on a holder's ends. */
export function growingHolderHoleControls(
  document: ProjectDocument,
  history: GrowingHolderHistory
): FeatureNode[] {
  const ends = new Set([history.negativeEndBodyId, history.positiveEndBodyId]);
  return listFeaturesInOrder(document).filter(
    (feature) =>
      feature.data.featureKind === 'direct-edit' &&
      ends.has(feature.data.targetBodyId) &&
      feature.data.operation.kind === 'resize-through-hole'
  );
}

export interface GrowingHolderHoleCompilation {
  command: AnyCommand;
  parameter: string;
}

/**
 * Drive both mirrored bores by one parameter. Each end receives a
 * through-hole resize bound to the parameter, placed in history right after
 * the end is carved and before it moves, so the edit resolves against
 * geometry that never changes with the opening. The larger countersink stays
 * as it is: widening the bore shortens it, and shrinking the bore leaves it.
 */
export function growingHolderHoleCommand(
  document: ProjectDocument,
  pair: GrowingHolderHolePair,
  options: { name?: string; parameter?: string } = {}
): GrowingHolderHoleCompilation {
  const parameter = options.parameter ?? GROWING_HOLDER_HOLE_PARAMETER;
  const name = options.name ?? `${pair.history.recipe.name}: mounting holes`;
  if (growingHolderHoleControls(document, pair.history).length)
    throw new Error('This holder already has a hole control.');
  const commands: AnyCommand[] = [];
  const hasParameter = Object.values(document.nodes).some(
    (node) => node.kind === 'parameter' && node.name === parameter
  );
  if (!hasParameter)
    commands.push(
      commandFactories.setParameter({
        name: parameter,
        expression: String(pair.diameter)
      })
    );
  const ordered = listFeaturesInOrder(document);
  const indexOf = (feature: FeatureNode) =>
    ordered.findIndex((f) => f.featureId === feature.featureId);
  const carveIndex = {
    negative: indexOf(pair.history.negativeEnd),
    positive: indexOf(pair.history.positiveEnd)
  };
  if (carveIndex.negative < 0 || carveIndex.positive < 0)
    throw new Error('The holder history no longer carves its ends.');
  const edits = (['negative', 'positive'] as const).map((side) => {
    const hole = pair[side];
    const ids = createFeatureOnlyIds();
    const operation: DirectEditOperation = {
      kind: 'resize-through-hole',
      faceHash: hole.faceHash,
      faceReference: hole.faceReference,
      sourceDiameter: hole.sourceDiameter,
      sourceAxisStart: hole.sourceAxisStart,
      sourceAxisEnd: hole.sourceAxisEnd,
      diameter: parameter,
      parameterBinding: true
    };
    commands.push(
      commandFactories.directEditBody({
        name: `${name} (${side} end)`,
        targetBodyId: hole.bodyId,
        operation,
        ids
      })
    );
    return { side, ids };
  });
  // Both edits append at the end; move each to just after its carve. The
  // negative move shifts the positive carve by one.
  const negativeEdit = edits[0]!;
  const positiveEdit = edits[1]!;
  commands.push(
    commandFactories.moveFeature({
      featureId: negativeEdit.ids.featureId,
      toIndex: carveIndex.negative + 1
    })
  );
  commands.push(
    commandFactories.moveFeature({
      featureId: positiveEdit.ids.featureId,
      toIndex:
        carveIndex.positive + (carveIndex.positive > carveIndex.negative ? 2 : 1)
    })
  );
  return { command: composeCommands(name, commands), parameter };
}

const millimetres = (value: number, units: ProjectDocument['units']) =>
  `${Math.round(value * 100) / 100} ${units}`;

/**
 * A verified proposal driving a holder's mirrored bores by one parameter.
 * The operation carries the measured bores verbatim; compilation refuses any
 * value that does not match what the document measures.
 */
export function createGrowingHolderHoleProposal(
  document: ProjectDocument,
  selection: { bodyIds: readonly string[] }
): CadPatchProposal | null {
  const histories = growingHolderHistories(document).filter(
    (history) =>
      !document.derived.bodyRepresentations[history.resultBodyId]?.consumed &&
      growingHolderHoleControls(document, history).length === 0
  );
  const history =
    selection.bodyIds.length === 1
      ? histories.find((h) => h.resultBodyId === selection.bodyIds[0])
      : selection.bodyIds.length === 0 && histories.length === 1
        ? histories[0]
        : undefined;
  if (!history) return null;
  const match = matchGrowingHolderHoles(document, history);
  if (match.status !== 'matched') return null;
  const { pair } = match;
  const units = document.units;
  const holderName =
    document.derived.bodyRepresentations[history.resultBodyId]?.name ??
    history.recipe.name;
  return {
    proposalId: `verified_growing_holder_holes_${history.resultBodyId}`,
    summary: `The two ${millimetres(pair.diameter, units)} mounting bores of ${holderName} will become the editable parameter ${GROWING_HOLDER_HOLE_PARAMETER}. Each bore is resized on its own end before the ends move, so both stay aligned with their arms at every opening; the larger countersink keeps its diameter.`,
    assumptions: [
      `The two bores are mirror images about ${history.recipe.axis} = ${millimetres(history.recipe.center, units)} and run perpendicular to the opening.`,
      'The countersink diameter is held; widening the bore shortens the countersink and shrinking it does not restore material outside the bore.',
      `The opening's minimum stays ${millimetres(history.recipe.minimumOpening, units)}: the ends meet at their cut faces before the bores can touch.`
    ],
    operations: [
      {
        kind: 'add_growing_holder_hole_control',
        name: `${holderName} mounting holes`,
        targetBodyId: history.resultBodyId,
        parameter: GROWING_HOLDER_HOLE_PARAMETER,
        holes: [pair.negative, pair.positive]
      }
    ]
  };
}
