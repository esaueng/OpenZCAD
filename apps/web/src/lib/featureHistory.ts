import { findSketch, listFeaturesInOrder } from '@openzcad/document-core';
import type {
  BodyId,
  FeatureId,
  FeatureNode,
  ProjectDocument,
  SketchId
} from '@openzcad/shared';

/** All result bodies, including in-place edits and the second half of a split. */
export function featureResultBodyIds(feature: FeatureNode): BodyId[] {
  const data = feature.data;
  const primary =
    feature.bodyId ??
    (data.featureKind === 'transform' || data.featureKind === 'direct-edit'
      ? data.targetBodyId
      : undefined);
  return [
    ...new Set([
      ...(primary ? [primary] : []),
      ...(data.featureKind === 'split' ? [data.secondBodyId] : [])
    ])
  ];
}

/** Stored geometric dependencies, including suppressed features and in-place edits. */
export function featureHistory(document: ProjectDocument) {
  const features = listFeaturesInOrder(document);
  const parents = new Map<FeatureId, Set<FeatureId>>();
  const missing = new Map<FeatureId, Set<'body' | 'sketch'>>();
  const bodyOwners = new Map<BodyId, FeatureId>();
  const sketchOwners = new Map<SketchId, FeatureId>();
  for (const feature of features) {
    const inputs = new Set<FeatureId>();
    const missingInputs = new Set<'body' | 'sketch'>();
    const body = (id: BodyId | undefined) => {
      const owner = id && bodyOwners.get(id);
      if (owner) inputs.add(owner);
      else if (id) missingInputs.add('body');
    };
    const sketch = (id: SketchId) => {
      const owner = sketchOwners.get(id);
      if (owner) inputs.add(owner);
      else missingInputs.add('sketch');
    };
    const data = feature.data;
    switch (data.featureKind) {
      case 'sketch': {
        const plane = findSketch(document, data.sketchId)?.planeRef;
        if (plane?.type === 'face') body(plane.bodyId);
        sketchOwners.set(data.sketchId, feature.featureId);
        break;
      }
      case 'extrude':
        sketch(data.sketchId);
        body(data.targetBodyId);
        break;
      case 'revolve':
        sketch(data.sketchId);
        break;
      case 'loft':
        data.sections.forEach((section) => sketch(section.sketchId));
        break;
      case 'sweep':
        sketch(data.profile.sketchId);
        sketch(data.path.sketchId);
        break;
      case 'helical-sweep':
        sketch(data.profile.sketchId);
        break;
      case 'boolean':
        data.targetBodyIds.forEach(body);
        break;
      case 'split':
      case 'transform':
      case 'mirror':
      case 'shell':
      case 'solid-offset':
      case 'draft':
      case 'thicken':
      case 'fillet':
      case 'chamfer':
      case 'pattern':
      case 'direct-edit':
        body(data.targetBodyId);
        break;
      case 'primitive':
      case 'imported-mesh':
      case 'imported-step':
        break;
    }
    parents.set(feature.featureId, inputs);
    missing.set(feature.featureId, missingInputs);
    if (feature.bodyId) bodyOwners.set(feature.bodyId, feature.featureId);
    if (data.featureKind === 'transform' || data.featureKind === 'direct-edit')
      bodyOwners.set(data.targetBodyId, feature.featureId);
    if (data.featureKind === 'split')
      bodyOwners.set(data.secondBodyId, feature.featureId);
  }
  const downstream = (id: FeatureId): FeatureNode[] => {
    const affected = new Set([id]);
    return features.filter((feature) => {
      if (
        feature.featureId === id ||
        ![...(parents.get(feature.featureId) ?? [])].some((parent) =>
          affected.has(parent)
        )
      )
        return false;
      affected.add(feature.featureId);
      return true;
    });
  };
  return { features, parents, downstream, missing };
}
