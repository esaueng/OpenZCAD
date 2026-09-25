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
