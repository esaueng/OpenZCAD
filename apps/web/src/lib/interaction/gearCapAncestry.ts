import {
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  isInPlaceTransform,
  type BodyId,
  type FaceTopologyReferenceV5,
  type FeatureNode,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';

/** A cylindrical gear's own cap drives its authored face width. */
export function gearCapAncestor(
  document: ProjectDocument,
  bodyId: BodyId,
  reference: FaceTopologyReferenceV5 | undefined,
  hash: number
): {
  feature: FeatureNode;
  width: number;
  scale: number;
  side: 'start' | 'end';
  axis: Vector3;
} | null {
  if (!reference || reference.currentHash !== hash) return null;
  const role = /^gear\.face\.cap\.(start|end)$/.exec(reference.lineageName);
  if (!role) return null;
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (feature) => feature.featureId === reference.producingFeatureId
  );
  const feature = features[index];
  if (
    !feature ||
    feature.bodyId !== bodyId ||
    isFeatureSuppressed(feature) ||
    feature.data.featureKind !== 'gear'
  )
    return null;
  const data = feature.data;
  // Bevel/worm widths have different geometric meanings. Teeth on a blank
  // belong to that blank's ancestry, not to a standalone gear dimension.
  if (
    (data.gearType !== 'external' && data.gearType !== 'internal') ||
    data.targetBodyId ||
    data.faceWidth === undefined ||
    !data.origin ||
    !data.axis
  )
    return null;
  const { scope } = getParameterScope(document);
  const value = (
    parameter: Parameters<typeof resolveParamValue>[0],
    label: string
  ) => resolveParamValue(parameter, scope, label, document.units);
  try {
    let scale = 1;
    for (const next of features.slice(index + 1)) {
      if (isFeatureSuppressed(next)) continue;
      if (
        next.data.featureKind === 'direct-edit' &&
        next.data.targetBodyId === bodyId
      )
        return null;
      if (isInPlaceTransform(next.data) && next.data.targetBodyId === bodyId)
        scale *= value(next.data.transform.scale ?? 1, 'scale');
    }
    const width = value(data.faceWidth, 'face width');
    const raw = {
      x: value(data.axis.x, 'axis x'),
      y: value(data.axis.y, 'axis y'),
      z: value(data.axis.z, 'axis z')
    };
    const length = Math.hypot(raw.x, raw.y, raw.z);
    if (
      ![width, scale, length].every(
        (number) => Number.isFinite(number) && number > 0
      )
    )
      return null;
    return {
      feature,
      width,
      scale,
      side: role[1] as 'start' | 'end',
      axis: { x: raw.x / length, y: raw.y / length, z: raw.z / length }
    };
  } catch {
    return null;
  }
}
