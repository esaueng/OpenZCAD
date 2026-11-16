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
  type FeatureData,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { listFeaturesInOrder } from '@openzcad/document-core';
import type { FeatureBuildContext, FeatureDataOf } from './exact-build-loop';
import type { ExactShape } from './exact-types';
import { AdapterRefusal } from './adapter-refusal';
import {
  collapseShape,
  fuseUniformSolidChecked,
  unifyBooleanFaces,
  verdictRefusesUnion
} from './exact-boolean-helpers';
import { exactCutWithCancellation } from './exact-cancellation';
import {
  holeToolSolids,
  missingHoleBore,
  type HoleToolSpec
} from './exact-cylinder-ops';
import {
  assignCarrierFace,
  carryAnalyticFaces
} from './exact-operation-lineage';
import { cylinderCarrier } from './exact-lineage-builders';
import { buildSweep } from './exact-profile-builders';
import { raiseFeatureWarning } from './exact-feature-warnings';
import { bodyName, inheritMeshOrigin } from './exact-shape-utils';
import { requireValidSolid } from './kernel-validation';
import type { RemusLineageDiagnostic } from './remus-lineage';
import { throughAllSpan, unionBounds } from './through-all';

type Vec3 = { x: number; y: number; z: number };

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
  let declined: RemusLineageDiagnostic | null = null;
  let solid = original;
  for (const source of sources) {
    const sourceData = source.data;
    let seed: number[];
    let operation: 'add' | 'cut';
    let bores: { spec: HoleToolSpec; pointId: string | null }[] = [];
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
      operation = sourceData.operation === 'add' ? 'add' : 'cut';
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
    } else {
      throw new Error(
        `${source.name} is not a hole, boss or cut, so a feature pattern cannot repeat it.`
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
        for (const { label, spec } of copied) {
          const missing = missingHoleBore(kernel, solid, spec);
          if (missing !== null) {
            throw new Error(
              `Copy ${label}'s ${missing * 2} bore did not come back as an analytic cylinder.`
            );
          }
        }
        solid = tapHole(sourceData, solid, copied);
        for (const hole of copied) hole.tapped = true;
      }
    } else {
      const tools = repeated.solids.flat();
      const union = fuseUniformSolidChecked(
        kernel,
        [solid, ...tools],
        [
          targetName,
          ...copies.flatMap((copy, index) =>
            (repeated.solids[index] ?? []).map(
              () => `${source.name} copy ${copy.label}`
            )
          )
        ]
      );
      if (verdictRefusesUnion(union.verdict)) {
        throw new AdapterRefusal(
          'union_not_solid',
          'Union produced an open, non-manifold, or inconsistently ' +
            'oriented result. Adjust the overlap or placement and try again.'
        );
      }
      solid = union.solid;
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
  for (const { label, spec } of holes.filter((hole) => !hole.tapped)) {
    const missing = missingHoleBore(kernel, solid, spec);
    if (missing !== null) {
      throw new Error(
        `Copy ${label}'s ${missing * 2} bore did not come back as an analytic cylinder.`
      );
    }
  }
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
  if (declined) lineage.diagnostics.push(declined);
  result.consumed.add(data.targetBodyId);
  result.shapes.set(feature.bodyId, { solids: [solid], lineage });
  inheritMeshOrigin(result, data.targetBodyId, feature.bodyId);
}
