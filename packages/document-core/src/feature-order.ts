import type { ProjectDocument, FeatureNode, FeatureId } from '@openzcad/shared';

export function listFeaturesInOrder(document: ProjectDocument): FeatureNode[] {
  const features = Object.values(document.nodes).filter(
    (node): node is FeatureNode => node.kind === 'feature'
  );
  const byId = new Map(features.map((feature) => [feature.featureId, feature]));
  const ordered: FeatureNode[] = [];
  const seen = new Set<FeatureId>();
  for (const featureId of document.featureOrder) {
    const feature = byId.get(featureId);
    if (feature && !seen.has(featureId)) {
      ordered.push(feature);
      seen.add(featureId);
    }
  }
  for (const feature of features) {
    if (!seen.has(feature.featureId)) {
      ordered.push(feature);
    }
  }
  return ordered;
}
