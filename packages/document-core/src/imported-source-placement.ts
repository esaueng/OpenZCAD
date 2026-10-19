import { isTransformCopy } from '@openzcad/shared';
import type {
  BodyId,
  FeatureNode,
  ParametricTransform3D,
  ParamValue,
  ProjectDocument,
  Transform3D,
  UnitSystem
} from '@openzcad/shared';
import { listFeaturesInOrder, resolveParamValue } from './index';

/** A measured construction can replay fixed rigid placement, but its world
 * coordinate cuts cannot follow a placement driven by an editable parameter.
 * Values resolve as the exact build resolves them, in `documentUnits`, so a
 * suffixed constant (`10 mm`) is fixed while a parameter read is not. */
export function constantRigidTransform(
  transform: ParametricTransform3D,
  documentUnits?: UnitSystem
): Transform3D | null {
  const value = (input: ParamValue) =>
    resolveParamValue(input, {}, undefined, documentUnits);
  try {
    if (transform.scale !== undefined && value(transform.scale) !== 1)
      return null;
    const vector = (input: ParametricTransform3D['translation']) => ({
      x: value(input.x),
      y: value(input.y),
      z: value(input.z)
    });
    const rotationDeg = vector(transform.rotationDeg);
    const translation = vector(transform.translation);
    // M10: a pivot is folded into the equivalent origin-based translation,
    // t + p − R·p, exactly as the exact build does, so a copy placed from
    // this transform lands where the measured body is. A pivot that is not a
    // constant (a parameter) is not a fixed placement and throws below.
    if (transform.pivot) {
      const pivot = vector(transform.pivot);
      const toRadians = Math.PI / 180;
      const [ca, sa] = [
        Math.cos(rotationDeg.x * toRadians),
        Math.sin(rotationDeg.x * toRadians)
      ];
      const [cb, sb] = [
        Math.cos(rotationDeg.y * toRadians),
        Math.sin(rotationDeg.y * toRadians)
      ];
      const [cc, sc] = [
        Math.cos(rotationDeg.z * toRadians),
        Math.sin(rotationDeg.z * toRadians)
      ];
      const rotated = {
        x:
          cc * cb * pivot.x +
          (cc * sb * sa - sc * ca) * pivot.y +
          (cc * sb * ca + sc * sa) * pivot.z,
        y:
          sc * cb * pivot.x +
          (sc * sb * sa + cc * ca) * pivot.y +
          (sc * sb * ca - cc * sa) * pivot.z,
        z: -sb * pivot.x + cb * sa * pivot.y + cb * ca * pivot.z
      };
      translation.x += pivot.x - rotated.x;
      translation.y += pivot.y - rotated.y;
      translation.z += pivot.z - rotated.z;
    }
    const result = { translation, rotationDeg };
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
    // A copy (M10) reads the source without moving it.
    if (isTransformCopy(data)) continue;
    if (!(
      ('targetBodyId' in data && data.targetBodyId === bodyId) ||
      ('targetBodyIds' in data &&
        Array.isArray(data.targetBodyIds) &&
        data.targetBodyIds.includes(bodyId))
    ))
      continue;
    if (
      data.featureKind !== 'transform' ||
      feature.metadata?.suppressed ||
      feature.metadata?.rollbackSuppressed
    )
      return null;
    const transform = constantRigidTransform(data.transform, document.units);
    if (!transform) return null;
    placement.push(transform);
  }
  return { source, placement };
}
