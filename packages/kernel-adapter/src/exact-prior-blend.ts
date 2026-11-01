import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import type { RemusLineageState } from './remus-lineage';

/**
 * Whether a face that looks like a blend band on an edge modifier's target
 * was actually made by an earlier fillet or chamfer.
 *
 * `isBlendFace` is a shape test: any B-spline or torus face, and any cylinder
 * tangent to a neighbouring plane, passes it, so an extruded line-and-arc
 * profile or a cylinder unioned into a corner reads as a blend. The failure
 * message that tells the user to "edit that earlier feature" is only true
 * when such a feature exists, so the face's lineage names its producer when
 * it can. Without a lineage record, the claim stands only if some earlier,
 * active fillet or chamfer exists at all.
 */
export function priorBlendFaceTest(
  document: ProjectDocument,
  featureId: FeatureId,
  lineage: RemusLineageState | undefined
): (face: number) => boolean {
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (feature) => feature.featureId === featureId
  );
  const blendFeatures = new Set(
    (index < 0 ? features : features.slice(0, index))
      .filter(
        (feature) =>
          !isFeatureSuppressed(feature) &&
          (feature.data.featureKind === 'fillet' ||
            feature.data.featureKind === 'chamfer')
      )
      .map((feature) => feature.featureId)
  );
  return (face) => {
    const reference = lineage?.faceReferences.get(face);
    return reference
      ? blendFeatures.has(reference.producingFeatureId)
      : blendFeatures.size > 0;
  };
}
