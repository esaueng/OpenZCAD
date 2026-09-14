import type {
  BodyId,
  FeatureNode,
  ParametricTransform3D,
  ParamValue,
  ProjectDocument,
  Transform3D
} from '@openzcad/shared';
import { evaluateExpression, listFeaturesInOrder } from './index';

/** A measured construction can replay fixed rigid placement, but its world
 * coordinate cuts cannot follow a placement driven by an editable parameter. */
export function constantRigidTransform(
  transform: ParametricTransform3D
): Transform3D | null {
  const value = (input: ParamValue) =>
    typeof input === 'number' ? input : evaluateExpression(input, {});
  try {
    if (transform.scale !== undefined && value(transform.scale) !== 1)
      return null;
    const vector = (input: ParametricTransform3D['translation']) => ({
      x: value(input.x),
      y: value(input.y),
      z: value(input.z)
    });
    const result = {
      translation: vector(transform.translation),
      rotationDeg: vector(transform.rotationDeg)
    };
    return [
      ...Object.values(result.translation),
      ...Object.values(result.rotationDeg)
    ].every(Number.isFinite)
      ? result
      : null;
  } catch {
    return null;
  }
}

/** Eligibility shared by the assistant and compiler. No geometric modification
 * or suppressed history may masquerade as a fresh, rigidly positioned import. */
export function rigidImportedSource(
  document: ProjectDocument,
  bodyId: BodyId
): { source: FeatureNode; placement: Transform3D[] } | null {
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (feature) =>
      feature.bodyId === bodyId && feature.data.featureKind === 'imported-step'
  );
  const source = features[index];
  if (
    !source ||
    source.metadata?.suppressed ||
    source.metadata?.rollbackSuppressed
  )
    return null;
  const placement: Transform3D[] = [];
  for (const feature of features.slice(index + 1)) {
    const data = feature.data;
    if (!(
      ('targetBodyId' in data && data.targetBodyId === bodyId) ||
      ('targetBodyIds' in data && data.targetBodyIds.includes(bodyId))
    ))
      continue;
    if (
      data.featureKind !== 'transform' ||
      feature.metadata?.suppressed ||
      feature.metadata?.rollbackSuppressed
    )
      return null;
    const transform = constantRigidTransform(data.transform);
    if (!transform) return null;
    placement.push(transform);
  }
  return { source, placement };
}
