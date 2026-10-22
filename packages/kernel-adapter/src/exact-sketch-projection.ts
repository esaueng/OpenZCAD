import { RemusKernel } from './remus-runtime';
import {
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import {
  solveDocumentSketchWithGcs,
  sketchDataFromSolvedObject
} from './gcs-sketch-document';
import {
  orientLikeStored,
  projectEdgeToSketch,
  sameProjectedGeometry,
  type PlaneBasis,
  type ProjectableEdgeCurve,
  type Vec3
} from '@openzcad/geometry';
import type {
  FeatureNode,
  ProjectDocument,
  SketchNode,
  SketchObjectData,
  SketchProjectionState,
  SketchProjectionSource
} from '@openzcad/shared';
import type { ExactBuildResult, ExactShape } from './exact-types';
import { brepEdgeCircle } from './exact-brep';
import { edgeWitnessOf, MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { isClosedEdge } from './topology-fingerprint';
import {
  resolveTopologyReference,
  topologyHashOfWitness,
  type EdgeTopologyResolutionCandidate
} from './topology-lineage';
import { raiseFeatureWarning } from './exact-feature-warnings';

/**
 * I01 (schema v33): re-project every linked projection of `sketch` at the
 * sketch's history position.
 *
 * Each source edge is re-found solely through verified schema-v5 lineage on
 * the body as it stands at this point of the build; a hash match is not
 * accepted, and no edge is chosen by proximity. A resolved edge that now
 * projects elsewhere overrides the stored geometry for every later feature
 * of this build (`result.sketchObjectOverrides`) and is reported `moved`, so
 * the app can write it back. An edge that cannot be re-found, or that no
 * longer projects to the same kind of curve, is reported `broken`: the
 * stored geometry — the last valid projection — keeps building, and the
 * sketch carries an advisory naming the object until the user re-picks or
 * unlinks it.
 */
export function resolveSketchProjectionsAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  sketch: SketchNode,
  feature: Pick<FeatureNode, 'featureId' | 'name'>,
  basis: PlaneBasis,
  result: ExactBuildResult
): void {
  const candidatesByBody = new Map<string, EdgeTopologyResolutionCandidate[]>();
  const states = new Map<string, SketchProjectionState>();
  const overrides = new Map<string, SketchObjectData>();
  const linked = new Set<string>();
  try {
    for (const objectId of sketch.objectIds) {
      const node = document.nodes[objectId];
      if (node?.kind !== 'sketch-object') continue;
      const projection = node.data.projection;
      if (projection?.mode !== 'linked') continue;
      linked.add(objectId);
      const state = resolveOne(
        kernel,
        document,
        node.data,
        projection.source,
        basis,
        result,
        candidatesByBody
      );
      states.set(objectId, state);
      if (state.status === 'moved') {
        overrides.set(objectId, state.data);
      }
    }
    // Write-back normalizes only linked entities. Their ordinary constrained
    // neighbours must therefore be solved on cold/current builds as well.
    if (linked.size > 0 && (sketch.constraints?.length ?? 0) > 0) {
      const nodes = { ...document.nodes };
      for (const [objectId, data] of overrides) {
        const node = nodes[objectId];
        if (node?.kind === 'sketch-object') nodes[objectId] = { ...node, data };
      }
      const projected = { ...document, nodes };
      // GCS sketches live until their kernel is freed; keep scratch out of the
      // retained history kernel and its checkpoints.
      const solver = new RemusKernel();
      try {
        const solved = solveDocumentSketchWithGcs(solver, projected, sketch);
        if (
          !solved.converged ||
          solved.rolledBack ||
          solved.classification === 'unsatisfied'
        )
          throw new Error(
            'Persistent sketch relations cannot follow the linked projections. No projected geometry was applied.'
          );
        const { scope } = getParameterScope(projected);
        for (const object of solved.objects) {
          if (linked.has(object.objectId)) continue;
          const node = nodes[object.objectId];
          if (node?.kind !== 'sketch-object') continue;
          const data = sketchDataFromSolvedObject(
            node.data,
            object,
            (value, label) =>
              resolveParamValue(value, scope, label, document.units)
          );
          if (data !== node.data) overrides.set(object.objectId, data);
        }
      } finally {
        solver.free();
      }
    }
  } catch (error) {
    for (const objectId of sketch.objectIds) {
      result.sketchObjectOverrides?.delete(objectId);
      result.sketchProjections?.delete(objectId);
    }
    (result.sketchProjectionFailures ??= new Map()).set(
      sketch.sketchId,
      error instanceof Error
        ? error.message
        : 'Linked sketch projections could not be solved.'
    );
    throw error;
  }
  result.sketchProjectionFailures?.delete(sketch.sketchId);
  for (const objectId of sketch.objectIds) {
    const data = overrides.get(objectId);
    if (data) (result.sketchObjectOverrides ??= new Map()).set(objectId, data);
    else result.sketchObjectOverrides?.delete(objectId);
    const state = states.get(objectId);
    if (!state) continue;
    (result.sketchProjections ??= new Map()).set(objectId, state);
    if (state.status === 'broken') {
      const node = document.nodes[objectId];
      raiseFeatureWarning(
        result,
        feature,
        `Projected ${node?.kind === 'sketch-object' ? node.data.objectKind : 'entity'} ${objectId} is broken: ${state.reason} The sketch keeps its last projected position until the edge is re-picked or the projection is unlinked.`,
        'advisory'
      );
    }
  }
}

function resolveOne(
  kernel: RemusKernel,
  document: ProjectDocument,
  stored: SketchObjectData,
  source: SketchProjectionSource,
  basis: PlaneBasis,
  result: ExactBuildResult,
  candidatesByBody: Map<string, EdgeTopologyResolutionCandidate[]>
): SketchProjectionState {
  const sourceFeatureName =
    listFeaturesInOrder(document).find(
      (candidate) =>
        candidate.featureId === source.edgeReference.producingFeatureId
    )?.name ?? String(source.edgeReference.producingFeatureId);
  const broken = (reason: string): SketchProjectionState => ({
    status: 'broken',
    reason
  });
  // A body a Boolean, transform or other feature has consumed is still in
  // `shapes`, but it is no longer part of the model at this point: its
  // edges are not projected.
  if (result.consumed.has(source.bodyId)) {
    return broken(
      `its source body was consumed by a feature before the sketch (source feature "${sourceFeatureName}"); re-pick the edge on the body that replaced it.`
    );
  }
  const shape = result.shapes.get(source.bodyId);
  if (!shape) {
    return broken(
      `its source body is unavailable at the sketch's place in the history (source feature "${sourceFeatureName}").`
    );
  }
  let candidates = candidatesByBody.get(source.bodyId);
  if (!candidates) {
    candidates = edgeCandidatesForShape(kernel, shape);
    candidatesByBody.set(source.bodyId, candidates);
  }
  const resolution = resolveTopologyReference(source.edgeReference, candidates);
  if (resolution.status === 'failed') {
    return broken(
      resolution.reason === 'lineage-not-found' ||
        resolution.reason === 'hash-not-found'
        ? `its source edge from "${sourceFeatureName}" was deleted or no longer exists.`
        : `its source edge from "${sourceFeatureName}" cannot be re-found: ${resolution.message}`
    );
  }
  if (resolution.via !== 'lineage') {
    return broken(
      `its source edge from "${sourceFeatureName}" matched only by fingerprint; a linked projection follows verified lineage alone.`
    );
  }
  const edge = resolution.candidate.value as number;
  const outcome = projectEdgeToSketch(
    projectableEdgeCurve(kernel, edge),
    basis
  );
  if (outcome.status === 'refused') {
    return broken(
      `its source edge from "${sourceFeatureName}": ${outcome.reason}`
    );
  }
  if (outcome.data.objectKind !== stored.objectKind) {
    return broken(
      `its source edge from "${sourceFeatureName}" now projects to ${article(outcome.data.objectKind)}, not ${article(stored.objectKind)}.`
    );
  }
  const fresh = orientLikeStored(stored, outcome.data);
  if (sameProjectedGeometry(stored, fresh)) {
    return { status: 'current' };
  }
  return {
    status: 'moved',
    data: {
      ...fresh,
      ...(stored.construction ? { construction: true } : {}),
      ...(stored.projection ? { projection: stored.projection } : {})
    }
  };
}

function article(kind: string): string {
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

function edgeCandidatesForShape(
  kernel: RemusKernel,
  shape: ExactShape
): EdgeTopologyResolutionCandidate[] {
  return shape.solids.flatMap((solid) =>
    Array.from(kernel.getSolidEdges(solid), (handle) => {
      const witness = edgeWitnessOf(kernel, handle);
      const reference = shape.lineage?.edgeReferences.get(handle);
      return {
        kind: 'edge' as const,
        currentHash: topologyHashOfWitness('edge', witness),
        witnessVersion: 1 as const,
        witness,
        value: handle,
        ...(reference
          ? {
              lineage: {
                source: 'derived' as const,
                identity: {
                  producingFeatureId: reference.producingFeatureId,
                  lineageName: reference.lineageName
                }
              }
            }
          : {})
      };
    })
  );
}

function vec3(flat: ArrayLike<number>, index: number): Vec3 {
  return {
    x: flat[index * 3] ?? Number.NaN,
    y: flat[index * 3 + 1] ?? Number.NaN,
    z: flat[index * 3 + 2] ?? Number.NaN
  };
}

/**
 * One kernel edge's exact curve: its two vertices for a line; for a circle
 * the proven centre, axis and radius (checked against the edge's own
 * samples, as the published topology is), with the arc's ends and its span
 * midpoint. Other curve kinds are named, not approximated.
 */
export function projectableEdgeCurve(
  kernel: RemusKernel,
  edge: number
): ProjectableEdgeCurve {
  const curveType = kernel.getEdgeCurveType(edge);
  const vertices = kernel.getEdgeVertices(edge);
  const start = vec3(vertices, 0);
  const end = vec3(vertices, 1);
  if (curveType === 'LINE') {
    return { kind: 'line', start, end };
  }
  if (curveType !== 'CIRCLE') {
    return { kind: 'unsupported', curveType };
  }
  const points = Array.from(kernel.sampleEdge(edge, MEASUREMENT_DEFLECTION));
  const circle = brepEdgeCircle(kernel, edge, points);
  if (!circle) {
    return { kind: 'unsupported', curveType: 'unproven circle' };
  }
  if (isClosedEdge(start, end)) {
    return { kind: 'circle', ...circle };
  }
  const span = Array.from(kernel.getEdgeParamSpan(edge));
  const middle = ((span[0] ?? 0) + (span[1] ?? 0)) / 2;
  const inside = vec3(kernel.evaluateEdgeCurve(edge, middle), 0);
  return { kind: 'circle', ...circle, arc: { start, end, inside } };
}
