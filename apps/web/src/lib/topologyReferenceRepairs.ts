import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import { listFeaturesInOrder } from '@openzcad/document-core';
import type { DerivedState, ProjectDocument } from '@openzcad/shared';

/** Build one atomic normalization from advice for this exact document version. */
export function topologyReferenceRepairCommand(
  document: ProjectDocument,
  derived: DerivedState
): AnyCommand | null {
  // Never normalize a partially replayed model.
  if (
    derived.featureWarnings?.some(
      (w) => w.kind === 'build-failed' || w.kind === 'refusal'
    )
  )
    return null;
  if (!derived.featureWarnings && derived.warnings.length) return null;
  const features = listFeaturesInOrder(document);
  const commands: AnyCommand[] = [];
  for (const repair of derived.referenceRepairs ?? []) {
    const feature = features.find((f) => f.featureId === repair.featureId);
    if (
      !feature ||
      (feature.data.featureKind !== 'fillet' &&
        feature.data.featureKind !== 'chamfer') ||
      feature.data.edgeReferences
    )
      continue;
    const hashes = new Set(feature.data.edgeHashes);
    if (
      repair.edgeReferences.length !== hashes.size ||
      new Set(repair.edgeReferences.map((r) => r.currentHash)).size !==
        hashes.size ||
      repair.edgeReferences.some((r) => !hashes.has(r.currentHash))
    )
      continue;
    commands.push(
      commandFactories.updateFeature(
        {
          featureId: repair.featureId,
          data: { edgeReferences: repair.edgeReferences }
        },
        'Repair edge references'
      )
    );
  }
  // A hash-only selection the rebuild carried across an upstream edit: the
  // stored hashes name the edges where they were, the rebuild knows where
  // they are now. Persisting that keeps the selection resolving directly,
  // including after a reload, when no record of the old build exists.
  for (const repair of derived.edgeHashRepairs ?? []) {
    const feature = features.find((f) => f.featureId === repair.featureId);
    if (
      !feature ||
      (feature.data.featureKind !== 'fillet' &&
        feature.data.featureKind !== 'chamfer') ||
      feature.data.edgeReferences ||
      repair.from.length !== repair.to.length ||
      new Set(repair.to).size !== repair.to.length
    )
      continue;
    const stored = [...new Set(feature.data.edgeHashes)];
    if (
      stored.length !== repair.from.length ||
      stored.some((hash, index) => hash !== repair.from[index])
    )
      continue;
    commands.push(
      commandFactories.updateFeature(
        {
          featureId: repair.featureId,
          data: { edgeHashes: [...repair.to] }
        },
        'Carry edge selection'
      )
    );
  }
  for (const repair of derived.faceReferenceRepairs ?? []) {
    const feature = features.find((f) => f.featureId === repair.featureId);
    if (!feature || feature.data.featureKind !== 'direct-edit') continue;
    const operation = feature.data.operation;
    if (
      operation.faceReference ||
      operation.faceHash !== repair.faceHash ||
      repair.faceReference.currentHash !== repair.faceHash
    )
      continue;
    commands.push(
      commandFactories.updateFeature(
        {
          featureId: repair.featureId,
          data: {
            operation: { ...operation, faceReference: repair.faceReference }
          }
        },
        'Repair face reference'
      )
    );
  }
  return commands.length
    ? composeCommands('Repair topology references', commands)
    : null;
}
