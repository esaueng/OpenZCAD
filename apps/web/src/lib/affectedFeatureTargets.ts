import { findSketch, listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureId,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';

export interface AffectedFeatureTarget {
  featureName: string;
  resultBodyId: BodyId;
}

/**
 * Result features whose exact geometry depends on one edited source feature.
 *
 * Body dependencies are walked forward through history, including in-place
 * transforms/direct edits and sketches attached to an affected face. This is
 * intentionally document/history logic: the kernel still rebuilds the whole
 * candidate, while the UI uses this set to reject warnings only from the
 * branch the edit can actually change.
 */
export function affectedFeatureTargets(
  document: ProjectDocument,
  sourceFeatureId: FeatureId
): AffectedFeatureTarget[] {
  const features = listFeaturesInOrder(document);
  const sourceIndex = features.findIndex(
    (feature) => feature.featureId === sourceFeatureId
  );
  const source = features[sourceIndex];
  if (sourceIndex < 0 || !source?.bodyId || isFeatureSuppressed(source)) {
    return [];
  }

  const affectedBodies = new Set<BodyId>([source.bodyId]);
  const affectedSketches = new Set<SketchId>();
  const targets: AffectedFeatureTarget[] = [
    { featureName: source.name, resultBodyId: source.bodyId }
  ];

  for (const feature of features.slice(sourceIndex + 1)) {
    if (isFeatureSuppressed(feature)) {
      continue;
    }
    const data = feature.data;
    let affected = false;

    switch (data.featureKind) {
      case 'sketch': {
        const sketch = findSketch(document, data.sketchId);
        if (
          sketch?.planeRef.type === 'face' &&
          affectedBodies.has(sketch.planeRef.bodyId)
        ) {
          affectedSketches.add(data.sketchId);
        }
        continue;
      }
      case 'extrude':
        affected =
          affectedSketches.has(data.sketchId) ||
          (data.targetBodyId !== undefined &&
            affectedBodies.has(data.targetBodyId));
        break;
      case 'revolve':
        affected = affectedSketches.has(data.sketchId);
        break;
      case 'loft':
        affected = data.sections.some((section) =>
          affectedSketches.has(section.sketchId)
        );
        break;
      case 'sweep':
        affected =
          affectedSketches.has(data.profile.sketchId) ||
          affectedSketches.has(data.path.sketchId);
        break;
      case 'helical-sweep':
        affected = affectedSketches.has(data.profile.sketchId);
        break;
      case 'boolean':
        affected = data.targetBodyIds.some((bodyId) =>
          affectedBodies.has(bodyId)
        );
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
        affected = affectedBodies.has(data.targetBodyId);
        break;
      case 'primitive':
      case 'imported-mesh':
      case 'imported-step':
        break;
    }

    if (!affected) {
      continue;
    }
    const resultBodyId =
      feature.bodyId ??
      (data.featureKind === 'transform' || data.featureKind === 'direct-edit'
        ? data.targetBodyId
        : undefined);
    if (!resultBodyId) {
      continue;
    }
    affectedBodies.add(resultBodyId);
    targets.push({ featureName: feature.name, resultBodyId });
    // A split's second half is a result body too; downstream features
    // targeting it are just as affected as those on the primary half.
    if (data.featureKind === 'split') {
      affectedBodies.add(data.secondBodyId);
      targets.push({
        featureName: feature.name,
        resultBodyId: data.secondBodyId
      });
    }
  }

  return targets;
}
