import {
  compileScript,
  customFeatureScriptError,
  runCustomFeature,
  type CustomFeatureStepData,
  type TopologyView
} from '@openzcad/scripting';
import type { BodyId, FeatureNode } from '@openzcad/shared';
import { targetBodyUnavailable } from './adapter-refusal';
import type { FeatureBuildContext, FeatureDataOf } from './exact-build-loop';
import {
  edgeWitnessOf,
  faceFingerprint,
  faceWitnessOf,
  registerSolidWitnesses
} from './exact-witnesses';
import type { ExactShape } from './exact-types';
import type { RemusKernel } from './remus-runtime';
import { topologyHashOfWitness } from './topology-lineage';

/**
 * Every face and edge of `shape` with its exact witness, under the hash
 * scheme the step builders resolve a hash-only pick by: a face by its
 * fingerprint, an edge by its witness hash.
 */
function topologyOf(kernel: RemusKernel, shape: ExactShape): TopologyView {
  const faces: TopologyView['faces'][number][] = [];
  const edges: TopologyView['edges'][number][] = [];
  for (const solid of shape.solids) {
    registerSolidWitnesses(kernel, solid);
    for (const face of kernel.getSolidFaces(solid)) {
      faces.push({
        hash: faceFingerprint(kernel, face),
        witness: faceWitnessOf(kernel, face)
      });
    }
    for (const edge of kernel.getSolidEdges(solid)) {
      const witness = edgeWitnessOf(kernel, edge);
      edges.push({ hash: topologyHashOfWitness('edge', witness), witness });
    }
  }
  return { faces, edges };
}

/**
 * L15: runs a custom feature's script in the exact build. Each step is an
 * ordinary fillet, chamfer or shell built by the existing builder on the body
 * the previous step left, under the instance's own feature id (so warnings,
 * refusals and lineage name the instance), with its picks resolved from the
 * script's queries on that body just before it runs. The last step writes the
 * instance's body; intermediate bodies are dropped, and a refusal anywhere
 * fails the whole instance with nothing published.
 *
 * `buildStep` is `buildFeature`, passed in so this module and the builders do
 * not import each other.
 */
export function buildCustomFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'custom-feature'>,
  buildStep: (ctx: FeatureBuildContext, feature: FeatureNode) => void
): void {
  if (!feature.bodyId) throw new Error('Custom feature has no result body.');
  const pinned = customFeatureScriptError(data.script);
  if (pinned) throw new Error(pinned);
  const script = compileScript(data.script.source).script!;
  const { result, kernel } = ctx;
  if (!result.shapes.get(data.targetBodyId)) {
    throw targetBodyUnavailable('Custom feature target is unavailable.');
  }
  // A step never offers a reference repair or carries a hash selection: its
  // picks are re-derived from the script on every build, and a repair would
  // be written into the instance, whose data has no such field.
  const stepCtx: FeatureBuildContext = {
    ...ctx,
    edgeSelections: undefined,
    proposeCarry: false,
    onUnresolvedEdgeHash: undefined
  };
  const repairs = {
    edge: result.referenceRepairs.length,
    face: result.faceReferenceRepairs?.length ?? 0,
    hash: result.edgeHashRepairs?.length ?? 0
  };
  const intermediates: BodyId[] = [];
  let current = data.targetBodyId;
  try {
    runCustomFeature(script, data.inputs, ctx.scope, ctx.document.units, {
      topology: () => topologyOf(kernel, result.shapes.get(current)!),
      run: (step: CustomFeatureStepData, index: number) => {
        const last = index === script.steps.length - 1;
        const bodyId = last
          ? feature.bodyId!
          : (`${feature.bodyId!}~step${index + 1}` as BodyId);
        try {
          buildStep(stepCtx, {
            ...feature,
            featureKind: step.featureKind,
            bodyId,
            data: { ...step, targetBodyId: current }
          });
        } catch (error) {
          throw new Error(
            `${feature.name}, step ${index + 1} (${step.featureKind}): ${error instanceof Error ? error.message : 'failed.'}`,
            { cause: error }
          );
        }
        if (!last) intermediates.push(bodyId);
        current = bodyId;
      }
    });
  } catch (error) {
    // Nothing of a failed run survives: not its half-built result.
    result.shapes.delete(feature.bodyId);
    throw error;
  } finally {
    for (const bodyId of intermediates) {
      result.shapes.delete(bodyId);
      result.consumed.delete(bodyId);
      result.meshBodies.delete(bodyId);
      result.partialRevolveBodies.delete(bodyId);
    }
    result.referenceRepairs.length = repairs.edge;
    if (result.faceReferenceRepairs)
      result.faceReferenceRepairs.length = repairs.face;
    if (result.edgeHashRepairs) result.edgeHashRepairs.length = repairs.hash;
  }
  result.consumed.add(data.targetBodyId);
}
