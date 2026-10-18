import { findSketch, listFeaturesInOrder } from '@openzcad/document-core';
import { isDatumPlaneRef, isInPlaceTransform } from '@openzcad/shared';
import type {
  BodyId,
  DatumPlaneSource,
  FeatureId,
  FeatureNode,
  ProjectDocument,
  SketchId,
  SketchPlaneRef
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
  const missing = new Map<FeatureId, Set<'body' | 'sketch' | 'datum'>>();
  const bodyOwners = new Map<BodyId, FeatureId>();
  const sketchOwners = new Map<SketchId, FeatureId>();
  const datumOwners = new Set<FeatureId>();
  for (const feature of features) {
    const inputs = new Set<FeatureId>();
    const missingInputs = new Set<'body' | 'sketch' | 'datum'>();
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
    // A datum is a feature: depending on one is depending on its feature.
    const datum = (id: FeatureId) => {
      if (datumOwners.has(id)) inputs.add(id);
      else missingInputs.add('datum');
    };
    const planeSource = (source: DatumPlaneSource | SketchPlaneRef) => {
      if (source.type === 'datum') datum(source.datumFeatureId);
      else if (source.type === 'face') body(source.bodyId);
    };
    const data = feature.data;
    switch (data.featureKind) {
      case 'sketch': {
        const plane = findSketch(document, data.sketchId)?.planeRef;
        if (plane) planeSource(plane);
        sketchOwners.set(data.sketchId, feature.featureId);
        break;
      }
      case 'datum-plane':
        (data.definition.kind === 'offset'
          ? [data.definition.source]
          : data.definition.sources
        ).forEach(planeSource);
        datumOwners.add(feature.featureId);
        break;
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
        if (data.guide) sketch(data.guide.sketchId);
        break;
      case 'helical-sweep':
        sketch(data.profile.sketchId);
        break;
      case 'boolean':
        data.targetBodyIds.forEach(body);
        break;
      case 'split':
      case 'mirror':
        body(data.targetBodyId);
        if (isDatumPlaneRef(data.plane)) datum(data.plane.datumFeatureId);
        break;
      case 'hole':
      case 'transform':
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
      default:
        // A new feature kind must declare its inputs here; one that falls
        // through silently reads as "nothing depends on it" everywhere the
        // graph is consulted, including the dependent-delete confirmation.
        data satisfies never;
    }
    parents.set(feature.featureId, inputs);
    missing.set(feature.featureId, missingInputs);
    if (feature.bodyId) bodyOwners.set(feature.bodyId, feature.featureId);
    // An in-place edit republishes its target; a copy (M10) owns only its
    // own body, recorded above, and leaves the source with its producer.
    if (isInPlaceTransform(data) || data.featureKind === 'direct-edit')
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

/**
 * The history steps related to a selection: the selected feature (or every
 * feature that produced or edited a selected body), everything those steps
 * were built from, and everything built on them. Order and suppression are
 * untouched; this only says which rows a "related to selection" view keeps.
 */
export function relatedFeatureIds(
  document: ProjectDocument,
  selection: { featureId?: FeatureId | null; bodyIds?: readonly string[] }
): Set<FeatureId> {
  const { features, parents, downstream } = featureHistory(document);
  const bodies = new Set(selection.bodyIds ?? []);
  const seeds = features.filter(
    (feature) =>
      feature.featureId === selection.featureId ||
      featureResultBodyIds(feature).some((id) => bodies.has(id))
  );
  const related = new Set<FeatureId>();
  const ancestors = (id: FeatureId) => {
    if (related.has(id)) return;
    related.add(id);
    for (const parent of parents.get(id) ?? []) ancestors(parent);
  };
  for (const seed of seeds) {
    ancestors(seed.featureId);
    for (const dependent of downstream(seed.featureId))
      related.add(dependent.featureId);
  }
  return related;
}
