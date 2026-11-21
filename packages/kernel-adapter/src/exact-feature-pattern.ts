/**
 * M02 feature patterns (schema v62): a pattern that repeats holes and
 * add/cut extrudes on its target body rather than copying the whole body.
 *
 * The target already holds each repeated feature once, where it was made, so
 * only the copies are built here: each feature's own tool (the hole's bore
 * and counterbore, the extrude's swept profile) is made once at the original
 * position, repeated by the same K05 pattern arm the whole-body pattern uses
 * (the kernel's journaled pattern entry points, or rigid copies where the
 * copies may overlap), and cut into or fused onto the target. Every copy is
 * proven: a cut must remove material, a hole's bores must come back as
 * analytic cylinders on the copy's axis, and the result must be one valid
 * solid. A copy that misses the body refuses by its label, so it can be
 * skipped, never silently dropped.
 */
import {
  isFeatureSuppressed,
  patternSourceProblem,
  type BodyId,
  type EdgeWitnessV1,
  type FaceWitnessV1,
  type FeatureData,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument,
  type QuantizedTopologyPoint
} from '@openzcad/shared';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
import {
  extrudeParamResolver,
  listFeaturesInOrder,
  validateExtrudeExtent
} from '@openzcad/document-core';
import type { FeatureBuildContext, FeatureDataOf } from './exact-build-loop';
import type { ExactShape } from './exact-types';
import { AdapterRefusal } from './adapter-refusal';
import {
  collapseShape,
  faceComponentsOf,
  fuseUniformSolidChecked,
  unifyBooleanFaces,
  verdictRefusesUnion
} from './exact-boolean-helpers';
import { exactCutWithCancellation } from './exact-cancellation';
import {
  holeToolSolids,
  measureCylinderFaces,
  missingHoleBore,
  type HoleToolSpec
} from './exact-cylinder-ops';
import {
  assignCarrierFace,
  carryAnalyticFaces
} from './exact-operation-lineage';
import {
  cylinderCarrier,
  planeCarrier,
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  createRemusSemanticLineage,
  type RemusLineageState
} from './remus-lineage';
import { buildSweep } from './exact-profile-builders';
import { buildWrapSolids } from './exact-wrap';
import { buildRibSolid } from './exact-rib';
import { raiseFeatureWarning } from './exact-feature-warnings';
import { bodyName, inheritMeshOrigin } from './exact-shape-utils';
import { requireValidSolid } from './kernel-validation';
import type { RemusLineageDiagnostic } from './remus-lineage';
import { throughAllSpan, unionBounds } from './through-all';

type Vec3 = { x: number; y: number; z: number };

/** Whether a copy's placement is a reflection (a negative determinant). */
export function copyReflects(matrix: Float64Array): boolean {
  const det =
    matrix[0]! * (matrix[5]! * matrix[10]! - matrix[6]! * matrix[9]!) -
    matrix[1]! * (matrix[4]! * matrix[10]! - matrix[6]! * matrix[8]!) +
    matrix[2]! * (matrix[4]! * matrix[9]! - matrix[5]! * matrix[8]!);
  return det < 0;
}

/** The hand a thread's mirror image winds: right becomes left. */
export function mirroredHand(
  hand: 'right' | 'left' | undefined
): 'right' | 'left' {
  return hand === 'left' ? 'right' : 'left';
}

/** One copy the pattern keeps, beside the original. */
export interface FeaturePatternCopy {
  /** Its instance label: `"3"`, or `"1-2"` in a grid. */
  label: string;
  /** Its rigid placement, row-major 4 × 4, as the body pattern's. */
  matrix: Float64Array;
}

/**
 * Repeats a feature's tool solids to every kept copy, through the pattern's
 * arm: one list of solids per copy, in `copies` order, and the kernel's
 * refusal when the copies had to be made without its pattern entry point.
 */
export type RepeatTools = (seed: readonly number[]) => {
  solids: number[][];
  declined: RemusLineageDiagnostic | null;
};

/** Below this a cut removed nothing, relative to the target's volume. */
const REMOVED_VOLUME_FRACTION = 1e-9;
/** Bounding boxes closer than this still touch. */
const TOUCH_TOLERANCE = 1e-6;
const MEASUREMENT_DEFLECTION = 0.08;

function applyPoint(matrix: Float64Array, point: Vec3): Vec3 {
  const row = (axis: number) =>
    matrix[axis * 4]! * point.x +
    matrix[axis * 4 + 1]! * point.y +
    matrix[axis * 4 + 2]! * point.z +
    matrix[axis * 4 + 3]!;
  return { x: row(0), y: row(1), z: row(2) };
}

function applyDirection(matrix: Float64Array, direction: Vec3): Vec3 {
  const row = (axis: number) =>
    matrix[axis * 4]! * direction.x +
    matrix[axis * 4 + 1]! * direction.y +
    matrix[axis * 4 + 2]! * direction.z;
  return { x: row(0), y: row(1), z: row(2) };
}

/** A rigid placement undone: Rᵀ (p − t). */
function unapplyPoint(matrix: Float64Array, point: Vec3): Vec3 {
  const d = {
    x: point.x - matrix[3]!,
    y: point.y - matrix[7]!,
    z: point.z - matrix[11]!
  };
  return {
    x: matrix[0]! * d.x + matrix[4]! * d.y + matrix[8]! * d.z,
    y: matrix[1]! * d.x + matrix[5]! * d.y + matrix[9]! * d.z,
    z: matrix[2]! * d.x + matrix[6]! * d.y + matrix[10]! * d.z
  };
}

function corners(bounds: ArrayLike<number>): Vec3[] {
  return [0, 1].flatMap((cx) =>
    [0, 1].flatMap((cy) =>
      [0, 1].map((cz) => ({
        x: bounds[cx * 3]!,
        y: bounds[cy * 3 + 1]!,
        z: bounds[cz * 3 + 2]!
      }))
    )
  );
}

function boxesTouch(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  return [0, 1, 2].every(
    (axis) =>
      Math.min(a[axis + 3]!, b[axis + 3]!) - Math.max(a[axis]!, b[axis]!) >=
      -TOUCH_TOLERANCE
  );
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * The bodies `bodyId` was made from, walking each feature's consumed inputs
 * back through history, each with the feature that made it from them.
 */
function bodyAncestry(
  document: ProjectDocument,
  bodyId: BodyId
): Map<BodyId, FeatureNode> {
  const producers = new Map<BodyId, FeatureNode>();
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.bodyId) producers.set(feature.bodyId, feature);
  }
  const chain = new Map<BodyId, FeatureNode>();
  const pending = [bodyId];
  while (pending.length > 0) {
    const next = pending.pop()!;
    const producer = producers.get(next);
    if (!producer || chain.has(next)) continue;
    chain.set(next, producer);
    const data = producer.data as FeatureData & {
      targetBodyId?: BodyId;
      targetBodyIds?: BodyId[];
    };
    if (typeof data.targetBodyId === 'string') pending.push(data.targetBodyId);
    if (Array.isArray(data.targetBodyIds)) pending.push(...data.targetBodyIds);
  }
  return chain;
}

/** The features a pattern repeats, in history order, each checked. */
function patternSources(
  document: ProjectDocument,
  pattern: FeatureNode,
  data: FeatureDataOf<'pattern'>
): FeatureNode[] {
  const ordered = listFeaturesInOrder(document);
  const position = new Map(
    ordered.map((feature, index) => [feature.featureId, index])
  );
  const own = position.get(pattern.featureId) ?? ordered.length;
  const chain = bodyAncestry(document, data.targetBodyId);
  const targetName = bodyName(document, data.targetBodyId);
  const sources = (data.sourceFeatureIds ?? []).map((featureId) => {
    const source = ordered.find((feature) => feature.featureId === featureId);
    if (!source) {
      throw new Error(
        'A feature this pattern repeats is no longer in History.'
      );
    }
    const problem = patternSourceProblem(source.data, source.name);
    if (problem) throw new Error(problem);
    if ((position.get(featureId) ?? Infinity) >= own) {
      throw new Error(
        `${source.name} comes later in History; a pattern can only repeat an earlier feature.`
      );
    }
    if (isFeatureSuppressed(source)) {
      throw new Error(
        `${source.name} is suppressed, so this pattern has nothing of it to repeat.`
      );
    }
    if (!source.bodyId || !chain.has(source.bodyId)) {
      throw new Error(
        `${source.name} was not made on ${targetName}, so this pattern cannot repeat it there.`
      );
    }
    return source;
  });
  // A body moved or mirrored after a feature no longer holds it where its
  // tool stands, so its copies would land beside the copies the user sees.
  // A Move in place keeps the body's id, so it is found by its target too.
  for (const producer of ordered) {
    const kind = producer.data.featureKind;
    if (kind !== 'transform' && kind !== 'mirror') continue;
    // A Move in place rewrites its target and has no body of its own.
    const inPlaceTarget =
      producer.data.featureKind === 'transform' && !producer.data.copy
        ? producer.data.targetBodyId
        : undefined;
    const onChain =
      (producer.bodyId !== undefined &&
        chain.get(producer.bodyId) === producer) ||
      (inPlaceTarget !== undefined && chain.has(inPlaceTarget));
    if (!onChain || isFeatureSuppressed(producer)) continue;
    const at = position.get(producer.featureId) ?? -1;
    if (at >= own) continue;
    const moved = sources.find(
      (source) => (position.get(source.featureId) ?? Infinity) < at
    );
    if (moved) {
      throw new Error(
        `${producer.name} moves ${targetName} after ${moved.name}; pattern ${moved.name} before it.`
      );
    }
  }
  return sources.sort(
    (left, right) =>
      position.get(left.featureId)! - position.get(right.featureId)!
  );
}

/**
 * The through-all span a repeated extrude sweeps: the copy at `matrix` must
 * cross the target wherever it lands, which is the original crossing the
 * target carried back by that copy's placement.
 */
function throughAllToolFeature(
  ctx: FeatureBuildContext,
  source: FeatureNode,
  data: FeatureDataOf<'extrude'>,
  targetBounds: ArrayLike<number>,
  copies: readonly FeaturePatternCopy[]
): FeatureNode {
  const basis = ctx.result.sketchBases.get(data.sketchId);
  if (!basis) {
    throw new Error(`${source.name}'s sketch plane did not resolve.`);
  }
  const box = corners(targetBounds);
  const carried = copies.flatMap((copy) =>
    box.map((corner) => unapplyPoint(copy.matrix, corner))
  );
  const bounds = unionBounds([
    targetBounds,
    ...carried.map((point) => [
      point.x,
      point.y,
      point.z,
      point.x,
      point.y,
      point.z
    ])
  ]);
  const { forward, backward } = throughAllSpan(
    bounds,
    basis.origin,
    basis.normal,
    data.throughAllSide!
  );
  const extent =
    forward > 0 && backward > 0
      ? { distance: forward, backDistance: backward }
      : forward > 0
        ? { distance: forward }
        : { distance: -backward };
  const {
    symmetric: _symmetric,
    backDistance: _backDistance,
    endCondition: _endCondition,
    throughAllSide: _throughAllSide,
    ...rest
  } = data;
  return { ...source, data: { ...rest, ...extent } };
}

interface RepeatedHole {
  label: string;
  /** The hole feature it copies: two repeated holes share every label. */
  source: FeatureNode['featureId'];
  /** M01: the sketch point of the hole's bore it copies, or null. */
  pointId: string | null;
  spec: HoleToolSpec;
  /** M01: threaded, so no plain bore is left to prove or name. */
  tapped: boolean;
}

function requirePatternBores(
  kernel: FeatureBuildContext['kernel'],
  solid: number,
  holes: readonly RepeatedHole[]
): void {
  if (holes.length === 0) return;
  // The solid stays fixed throughout this check. A later cut or thread
  // operation gets a fresh set of face measurements.
  const cylinders = measureCylinderFaces(kernel, solid);
  for (const { label, spec } of holes) {
    const missing = missingHoleBore(cylinders, spec);
    if (missing !== null) {
      throw new Error(
        `Copy ${label}'s ${missing * 2} bore did not come back as an analytic cylinder.`
      );
    }
  }
}

/**
 * Builds a feature pattern's body: the target with every kept copy of each
 * repeated feature cut into it or fused onto it, in history order.
 */
export function buildFeaturePattern(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'pattern'>,
  target: ExactShape,
  copies: readonly FeaturePatternCopy[],
  repeat: RepeatTools,
  holeSpec: (data: FeatureDataOf<'hole'>) => {
    bores: readonly { spec: HoleToolSpec; pointId: string | null }[];
  },
  /**
   * M01 (schema v66): threads `bores` of a tapped hole into `solid`, as the
   * hole's own build does, and returns the result.
   */
  tapHole?: (
    data: FeatureDataOf<'hole'>,
    solid: number,
    bores: readonly { spec: HoleToolSpec; pointId: string | null }[]
  ) => number,
  /**
   * M02: rounds or bevels `edges` of `solid` as a repeated fillet or
   * chamfer does its own, and returns the result; throws its refusal.
   */
  blendEdges?: (
    data: FeatureDataOf<'fillet' | 'chamfer'>,
    solid: number,
    edges: number[]
  ) => number
): void {
  const { kernel, document, result } = ctx;
  if (!feature.bodyId) throw new Error('Pattern has no result body.');
  const sources = patternSources(document, feature, data);
  const targetName = bodyName(document, data.targetBodyId);
  const original = collapseShape(kernel, target);
  const targetBounds = Array.from<number>(kernel.boundingBox(original));
  const targetVolume = kernel.volume(original, MEASUREMENT_DEFLECTION);
  const holes: RepeatedHole[] = [];
  // M02: the bosses and cuts repeated, whose copies' faces are named below.
  const shapedSources: FeatureId[] = [];
  let declined: RemusLineageDiagnostic | null = null;
  let solid = original;
  for (const source of sources) {
    const sourceData = source.data;
    let seed: number[];
    let operation: 'add' | 'cut';
    let bores: { spec: HoleToolSpec; pointId: string | null }[] = [];
    // M02: a fillet or chamfer is applied again where each copy holds the
    // edges it rounded, found by its stored edges moved with the copy.
    if (
      sourceData.featureKind === 'fillet' ||
      sourceData.featureKind === 'chamfer'
    ) {
      if (!blendEdges) {
        throw new Error(
          `${source.name} rounds edges, and this pattern cannot repeat it.`
        );
      }
      // Where its build found its edges, so an upstream edit that moved
      // them moves the copies too (review). A source that did not build
      // recorded none, and its copies are not rounded either (re-check).
      const witnesses = result.blendEdgeWitnesses?.get(source.featureId);
      if (!witnesses || witnesses.length === 0) {
        throw new Error(
          `${source.name} did not build, so a pattern cannot find its edges on a copy; fix ${source.name} first.`
        );
      }
      for (const copy of copies) {
        const edges = copiedEdges(kernel, solid, witnesses, copy.matrix);
        if (typeof edges === 'number') {
          throw new Error(
            `Copy ${copy.label} of ${source.name} finds no edge where ${source.name}'s edge ${edges + 1} would be; skip it, or repeat the feature it rounds first.`
          );
        }
        try {
          solid = blendEdges(sourceData, solid, edges);
        } catch (error) {
          throw new Error(
            `Copy ${copy.label} of ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      }
      continue;
    }
    if (sourceData.featureKind === 'hole') {
      // A through hole drills clear of the body from its own entry point; a
      // copy needs the same from where it lands, so the one tool all copies
      // share reaches the furthest of those. A hole on sketch points (M01)
      // brings one tool per bore, all repeated together.
      bores = holeSpec(sourceData).bores.map(({ spec, pointId }) => {
        let depth = spec.depth;
        if (sourceData.depthMode === 'through') {
          for (const copy of copies) {
            const point = applyPoint(copy.matrix, spec.surfacePoint);
            const axis = applyDirection(copy.matrix, spec.axis);
            for (const corner of corners(targetBounds)) {
              depth = Math.max(
                depth,
                dot(
                  {
                    x: corner.x - point.x,
                    y: corner.y - point.y,
                    z: corner.z - point.z
                  },
                  axis
                )
              );
            }
          }
        }
        return { spec: { ...spec, depth }, pointId };
      });
      seed = bores.flatMap(({ spec }) => holeToolSolids(kernel, spec));
      operation = 'cut';
    } else if (sourceData.featureKind === 'extrude') {
      // The source's own stored extent, checked as its rebuild checks it: a
      // copy never builds an extent the source refuses (a start offset a
      // parameter moved off zero beside through all, say).
      validateExtrudeExtent(
        sourceData,
        extrudeParamResolver(document, ctx.scope)
      );
      operation = sourceData.operation === 'add' ? 'add' : 'cut';
      shapedSources.push(source.featureId);
      const sweepFeature =
        sourceData.endCondition === 'through-all'
          ? throughAllToolFeature(ctx, source, sourceData, targetBounds, copies)
          : source;
      seed = buildSweep(
        kernel,
        document,
        sweepFeature,
        ctx.scope,
        result.sketchBases,
        (message) => raiseFeatureWarning(result, feature, message, 'advisory')
      ).solids;
    } else if (sourceData.featureKind === 'wrap') {
      // M02: the wrap's material made again from the cylinder or cone its
      // build resolved, and repeated as a boss (emboss) or a cut (engrave).
      operation = sourceData.mode === 'emboss' ? 'add' : 'cut';
      shapedSources.push(source.featureId);
      const frame = result.wrapFrames?.get(source.featureId);
      const basis = result.sketchBases.get(sourceData.sketchId);
      if (!frame || !basis) {
        throw new Error(
          `${source.name} did not build, so a pattern cannot repeat it; fix ${source.name} first.`
        );
      }
      seed = buildWrapSolids(
        kernel,
        document,
        sourceData,
        frame,
        basis,
        ctx.scope,
        (message) => raiseFeatureWarning(result, feature, message, 'advisory'),
        source.name
      );
    } else if (sourceData.featureKind === 'rib') {
      // M02: the rib's material made again against the body it was made on,
      // as its build makes it, and repeated as a boss.
      operation = 'add';
      shapedSources.push(source.featureId);
      const before = result.shapes.get(sourceData.targetBodyId);
      const basis = result.sketchBases.get(sourceData.profile.sketchId);
      if (
        !result.builtRibs?.has(source.featureId) ||
        before?.solids.length !== 1 ||
        !basis
      ) {
        throw new Error(
          `${source.name} did not build, so a pattern cannot repeat it; fix ${source.name} first.`
        );
      }
      seed = [
        buildRibSolid(
          kernel,
          document,
          sourceData,
          before.solids[0]!,
          basis,
          ctx.scope,
          (message) => raiseFeatureWarning(result, feature, message, 'advisory')
        )
      ];
    } else {
      throw new Error(
        `${source.name} is not a hole, boss, cut, fillet, chamfer, wrap or rib, so a feature pattern cannot repeat it.`
      );
    }
    const repeated = repeat(seed);
    declined ??= repeated.declined;
    const currentBounds = Array.from<number>(kernel.boundingBox(solid));
    copies.forEach((copy, index) => {
      const tools = repeated.solids[index] ?? [];
      const toolBounds = unionBounds(
        tools.map((tool) => Array.from<number>(kernel.boundingBox(tool)))
      );
      if (!boxesTouch(toolBounds, currentBounds)) {
        throw new Error(
          `Copy ${copy.label} of ${source.name} misses ${targetName}; skip it or change the pattern.`
        );
      }
    });
    if (operation === 'cut') {
      copies.forEach((copy, index) => {
        const before = kernel.volume(solid, MEASUREMENT_DEFLECTION);
        // One tool at a time, as a single hole is cut: the kernel's compound
        // pass declines tool pairs that each cut exactly on their own.
        for (const tool of repeated.solids[index] ?? []) {
          solid = exactCutWithCancellation(
            kernel,
            solid,
            tool,
            ctx.cancellation,
            [targetName, `${source.name} copy ${copy.label}`]
          );
        }
        const after = kernel.volume(solid, MEASUREMENT_DEFLECTION);
        if (!(after < before - targetVolume * REMOVED_VOLUME_FRACTION)) {
          throw new Error(
            `Copy ${copy.label} of ${source.name} removes nothing from ${targetName}; skip it or change the pattern.`
          );
        }
        for (const { spec, pointId } of bores) {
          holes.push({
            label: copy.label,
            source: source.featureId,
            pointId,
            spec: {
              ...spec,
              surfacePoint: applyPoint(copy.matrix, spec.surfacePoint),
              axis: applyDirection(copy.matrix, spec.axis)
            },
            tapped: false
          });
        }
      });
      solid = unifyBooleanFaces(kernel, solid);
      // M01 (schema v66): the copies of a tapped hole are tapped as it is,
      // each bore checked to be one plain cylinder before it is threaded.
      // A cosmetic thread (schema v67) is described, not cut.
      if (
        sourceData.featureKind === 'hole' &&
        sourceData.tapped &&
        !sourceData.tapped.cosmetic
      ) {
        if (!tapHole) {
          throw new Error(
            `${source.name} is tapped, and this pattern cannot tap its copies.`
          );
        }
        const copied = holes.filter((hole) => hole.source === source.featureId);
        // Proven plain first, as an untapped copy is below.
        requirePatternBores(kernel, solid, copied);
        // M02 (schema v119): a reflected copy's thread winds the other way,
        // as a mirror image of the original's would (review).
        const reflected = copies.some((copy) => copyReflects(copy.matrix));
        solid = tapHole(
          reflected
            ? {
                ...sourceData,
                tapped: {
                  ...sourceData.tapped,
                  hand: mirroredHand(sourceData.tapped.hand)
                }
              }
            : sourceData,
          solid,
          copied
        );
        for (const hole of copied) hole.tapped = true;
      }
    } else {
      // A wrap's or a rib's copies are fused one at a time, as a wrap's own
      // build fuses its pieces: the kernel declines several wrapped copies
      // in one pass, though each fuses exactly on its own.
      const batches =
        sourceData.featureKind === 'wrap' || sourceData.featureKind === 'rib'
          ? copies.map((copy, index) => ({
              copy: copy.label,
              tools: repeated.solids[index] ?? [],
              labels: (repeated.solids[index] ?? []).map(
                () => `${source.name} copy ${copy.label}`
              )
            }))
          : [
              {
                copy: null as string | null,
                tools: repeated.solids.flat(),
                labels: copies.flatMap((copy, index) =>
                  (repeated.solids[index] ?? []).map(
                    () => `${source.name} copy ${copy.label}`
                  )
                )
              }
            ];
      for (const { copy, tools, labels } of batches) {
        if (tools.length === 0) continue;
        // A copy fused on its own must join the body: one that lands clear
        // of it near enough for its box to touch would fuse as a separate
        // piece (review), which the union's own checks accept.
        const piecesBefore =
          copy === null ? null : faceComponentsOf(kernel, solid)?.length;
        const union = fuseUniformSolidChecked(
          kernel,
          [solid, ...tools],
          [targetName, ...labels]
        );
        if (verdictRefusesUnion(union.verdict)) {
          throw new AdapterRefusal(
            'union_not_solid',
            'Union produced an open, non-manifold, or inconsistently ' +
              'oriented result. Adjust the overlap or placement and try again.'
          );
        }
        if (copy !== null) {
          const piecesAfter = faceComponentsOf(kernel, union.solid)?.length;
          if (
            piecesBefore === undefined ||
            piecesAfter === undefined ||
            piecesAfter > piecesBefore!
          ) {
            throw new Error(
              `Copy ${copy} of ${source.name} does not join ${targetName}; skip it or change the pattern.`
            );
          }
        }
        solid = union.solid;
      }
    }
  }
  requireValidSolid(
    kernel,
    solid,
    'The feature pattern did not produce a valid solid.'
  );
  if (!(kernel.volume(solid, MEASUREMENT_DEFLECTION) > 0)) {
    throw new Error(`The feature pattern removed all of ${targetName}.`);
  }
  requirePatternBores(
    kernel,
    solid,
    holes.filter((hole) => !hole.tapped)
  );
  // Faces the copies left alone keep their names; each copy's bore is named
  // by its own axis, the way a hole names its one.
  const lineage = carryAnalyticFaces(kernel, original, solid, target.lineage);
  for (const { label, source, pointId, spec } of holes) {
    // Named by copy and by the hole it copies, so a pattern repeating two
    // holes gives each copy's bore a name of its own; a hole's bores on
    // sketch points (M01) by their point too.
    const name = `pattern.face.instance.${label}.source.${source}.hole.face${
      pointId === null ? '' : `.at.${pointId}`
    }`;
    assignCarrierFace(
      kernel,
      solid,
      lineage,
      feature.featureId,
      `${name}.bore`,
      cylinderCarrier(spec.surfacePoint, spec.axis, spec.radius)
    );
    // A counterbore's shoulder is left unnamed: every copy's shoulder lies
    // on one plane, so a plane carrier cannot tell them apart.
    if (spec.style === 'counterbore' && spec.counterboreRadius !== undefined) {
      assignCarrierFace(
        kernel,
        solid,
        lineage,
        feature.featureId,
        `${name}.counterbore`,
        cylinderCarrier(spec.surfacePoint, spec.axis, spec.counterboreRadius)
      );
    }
  }
  // M02: each boss and cut copy's faces, named after the faces of the
  // feature it copies where they come back congruent to them.
  for (const source of shapedSources) {
    nameCopiedFaces(
      kernel,
      original,
      solid,
      target.lineage,
      lineage,
      feature.featureId,
      source,
      copies
    );
  }
  if (declined) lineage.diagnostics.push(declined);
  result.consumed.add(data.targetBodyId);
  result.shapes.set(feature.bodyId, { solids: [solid], lineage });
  inheritMeshOrigin(result, data.targetBodyId, feature.bodyId);
}

/**
 * Quanta a transformed witness may differ from the copy's own by: the
 * placement is applied to a quantized witness, so its last place can round
 * the other way, and a kernel-measured centroid or perimeter carries the
 * kernel's own rounding.
 */
const NAME_SLACK = 64;

function closeQuanta(left: number, right: number, slack = NAME_SLACK): boolean {
  return Math.abs(left - right) <= slack;
}

function closePoints(
  left: QuantizedTopologyPoint,
  right: QuantizedTopologyPoint
): boolean {
  return left.every((value, index) => closeQuanta(value, right[index]!));
}

function dequantized(point: QuantizedTopologyPoint, scale = 1): Vec3 {
  return {
    x: (point[0] * GEOMETRY_LINEAR_TOLERANCE) / scale,
    y: (point[1] * GEOMETRY_LINEAR_TOLERANCE) / scale,
    z: (point[2] * GEOMETRY_LINEAR_TOLERANCE) / scale
  };
}

function quantized(point: Vec3): QuantizedTopologyPoint {
  return [
    Math.round(point.x / GEOMETRY_LINEAR_TOLERANCE),
    Math.round(point.y / GEOMETRY_LINEAR_TOLERANCE),
    Math.round(point.z / GEOMETRY_LINEAR_TOLERANCE)
  ];
}

/** A face's carrier moved by `matrix`, or null for one without a carrier. */
/** @internal exported for its regression test. */
export function placedCarrier(
  carrier: FaceWitnessV1['analytic'],
  matrix: Float64Array
): FaceWitnessV1['analytic'] | null {
  if (carrier.kind === 'plane') {
    // Directions are quantized a thousand times finer (`quantizedDirectionOf`).
    const normal = dequantized(carrier.normal, 1000);
    const offset = carrier.offset * GEOMETRY_LINEAR_TOLERANCE;
    const on = {
      x: normal.x * offset,
      y: normal.y * offset,
      z: normal.z * offset
    };
    return planeCarrier(applyDirection(matrix, normal), applyPoint(matrix, on));
  }
  if (carrier.kind === 'cylinder') {
    return cylinderCarrier(
      applyPoint(matrix, dequantized(carrier.axisFoot)),
      applyDirection(matrix, dequantized(carrier.axis, 1000)),
      carrier.radius * GEOMETRY_LINEAR_TOLERANCE
    );
  }
  return null;
}

/** Below this two unit directions are one line (|cos| from 1). */
const SAME_LINE = 1e-7;

function unitOf(point: QuantizedTopologyPoint): Vec3 {
  const v = dequantized(point, 1000);
  const size = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / size, y: v.y / size, z: v.z / size };
}

/**
 * Whether two carriers are one surface. Directions are compared as lines,
 * not as quantized canonical vectors: a direction close to an axis can
 * round to the other canonical sign once it is moved (review), and a
 * plane's offset turns sign with its normal.
 */
/** @internal exported for its regression test. */
export function closeCarriers(
  left: FaceWitnessV1['analytic'],
  right: FaceWitnessV1['analytic']
): boolean {
  if (left.kind === 'plane' && right.kind === 'plane') {
    const cos = dot(unitOf(left.normal), unitOf(right.normal));
    if (Math.abs(Math.abs(cos) - 1) > SAME_LINE) return false;
    return closeQuanta(cos < 0 ? -left.offset : left.offset, right.offset);
  }
  if (left.kind === 'cylinder' && right.kind === 'cylinder') {
    const cos = dot(unitOf(left.axis), unitOf(right.axis));
    return (
      Math.abs(Math.abs(cos) - 1) <= SAME_LINE &&
      closePoints(left.axisFoot, right.axisFoot) &&
      closeQuanta(left.radius, right.radius)
    );
  }
  return false;
}

/**
 * M02: names each copy's faces of a repeated boss or cut after the faces of
 * the feature it copies, `pattern.face.instance.<label>.source.<feature>.<its
 * name>`. A copy's face takes the name only where exactly one face of the
 * result is the original's moved by the copy's placement: the same kind of
 * surface on the moved carrier, with the moved centroid and the same
 * perimeter. A face the body truncates differently there (a cut running off
 * an edge, a boss merging into another) is not congruent and stays unnamed,
 * as a face two copies share would be.
 */
function nameCopiedFaces(
  kernel: Parameters<typeof topologyCandidatesForSolid>[0],
  original: number,
  solid: number,
  before: RemusLineageState | undefined,
  lineage: RemusLineageState,
  producer: FeatureId,
  source: FeatureId,
  copies: readonly FeaturePatternCopy[]
): void {
  if (!before) return;
  const sourceFaces = topologyCandidatesForSolid(kernel, original).flatMap(
    (candidate) => {
      if (candidate.kind !== 'face') return [];
      const reference = before.faceReferences.get(candidate.handle);
      if (reference?.producingFeatureId !== source) return [];
      return [
        {
          name: reference.lineageName,
          witness: candidate.witness as FaceWitnessV1,
          area: kernel.faceArea(candidate.handle, MEASUREMENT_DEFLECTION)
        }
      ];
    }
  );
  if (sourceFaces.length === 0) return;
  // A face clipped by other cuts can keep its perimeter and centroid (two
  // opposite corner notches) but never its area (review).
  const areas = new Map<number, number>();
  const areaOf = (handle: number) => {
    if (!areas.has(handle)) {
      areas.set(handle, kernel.faceArea(handle, MEASUREMENT_DEFLECTION));
    }
    return areas.get(handle)!;
  };
  const resultFaces = topologyCandidatesForSolid(kernel, solid).filter(
    (candidate) => candidate.kind === 'face'
  );
  const assignments: { handle: number; name: string }[] = [];
  for (const copy of copies) {
    for (const { name, witness, area } of sourceFaces) {
      const carrier = placedCarrier(witness.analytic, copy.matrix);
      if (!carrier || !witness.centroid) continue;
      const centroid = quantized(
        applyPoint(copy.matrix, dequantized(witness.centroid))
      );
      const matches = resultFaces.filter((candidate) => {
        const other = candidate.witness as FaceWitnessV1;
        return (
          other.surfaceType === witness.surfaceType &&
          other.centroid !== null &&
          closePoints(other.centroid, centroid) &&
          closeQuanta(other.perimeter, witness.perimeter) &&
          closeCarriers(other.analytic, carrier) &&
          Math.abs(areaOf(candidate.handle) - area) <= 1e-6 * Math.max(1, area)
        );
      });
      if (matches.length !== 1) continue;
      const handle = matches[0]!.handle;
      if (lineage.faceReferences.has(handle)) continue;
      assignments.push({
        handle,
        name: `pattern.face.instance.${copy.label}.source.${source}.${name}`
      });
    }
  }
  // A face two copies both claimed is no one copy's.
  const claims = new Map<number, number>();
  for (const { handle } of assignments) {
    claims.set(handle, (claims.get(handle) ?? 0) + 1);
  }
  const unique = assignments.filter(({ handle }) => claims.get(handle) === 1);
  if (unique.length === 0) return;
  const proven = createRemusSemanticLineage(
    producer,
    'boolean',
    unique.map(({ handle, name }) => ({
      ...resultFaces.find((candidate) => candidate.handle === handle)!,
      lineageName: name
    }))
  );
  for (const [handle, reference] of proven.faceReferences) {
    lineage.faceReferences.set(handle, reference);
  }
}

/**
 * M02: the edges of `solid` where `references`' edges stand moved by
 * `matrix`, one each: the same kind of curve and length, with the moved
 * ends and middle (an open edge, either way round) or the moved centre and
 * axis (a closed one). The index of the first that finds no one edge, when
 * one does not. A copy is an exact transform, so it matches within a few
 * quanta (1e-6 mm each, the linear tolerance), not the slack face naming
 * allows: an edge a few hundredths of a micron from where a copy's would
 * stand is another edge (review).
 */
/** Quanta a copied blend edge may stand from where the copy puts it. */
const BLEND_SLACK = 4;

function copiedEdges(
  kernel: Parameters<typeof topologyCandidatesForSolid>[0],
  solid: number,
  witnesses: readonly EdgeWitnessV1[],
  matrix: Float64Array
): number[] | number {
  const candidates = topologyCandidatesForSolid(kernel, solid).filter(
    (candidate) => candidate.kind === 'edge'
  );
  const moved = (point: QuantizedTopologyPoint) =>
    quantized(applyPoint(matrix, dequantized(point)));
  const edges: number[] = [];
  const near = (left: number, right: number) =>
    closeQuanta(left, right, BLEND_SLACK);
  const nearPoints = (
    left: QuantizedTopologyPoint,
    right: QuantizedTopologyPoint
  ) => left.every((value, index) => near(value, right[index]!));
  for (const [index, witness] of witnesses.entries()) {
    const matches = candidates.filter((candidate) => {
      const other = candidate.witness as EdgeWitnessV1;
      if (
        other.curveType !== witness.curveType ||
        other.closed !== witness.closed ||
        !near(other.length, witness.length)
      )
        return false;
      if (!witness.closed && !other.closed) {
        const [a, b] = witness.endpoints.map(moved) as [
          QuantizedTopologyPoint,
          QuantizedTopologyPoint
        ];
        const [c, d] = other.endpoints;
        return (
          nearPoints(other.midpoint, moved(witness.midpoint)) &&
          ((nearPoints(a, c) && nearPoints(b, d)) ||
            (nearPoints(a, d) && nearPoints(b, c)))
        );
      }
      if (witness.closed && other.closed) {
        if (!nearPoints(other.center, moved(witness.center))) return false;
        if (!witness.axis || !other.axis) return !witness.axis && !other.axis;
        const axis = applyDirection(matrix, dequantized(witness.axis, 1000));
        const theirs = dequantized(other.axis, 1000);
        const cos =
          Math.abs(dot(axis, theirs)) /
          (Math.hypot(axis.x, axis.y, axis.z) *
            Math.hypot(theirs.x, theirs.y, theirs.z));
        return Math.abs(cos - 1) <= 1e-9;
      }
      return false;
    });
    if (matches.length !== 1) return index;
    edges.push(matches[0]!.handle);
  }
  return edges;
}
