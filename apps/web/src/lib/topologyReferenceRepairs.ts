import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import { listFeaturesInOrder } from '@openzcad/document-core';
import type {
  DerivedState,
  FeatureId,
  ProjectDocument
} from '@openzcad/shared';

/**
 * The stored-hash rewrites for every hash-only fillet/chamfer selection the
 * rebuild carried across an upstream edit, against `document` — the document
 * that rebuild was made from.
 *
 * The rebuild already used the carried edges, so the saved document is only
 * consistent with that geometry once the new hashes are stored with it: a
 * reload, or a collaborator's session, has no memory of the old build to
 * carry from. A validated commit therefore writes these in the same revision
 * as the edit, and refuses the commit when any carried feature is listed in
 * `unpersisted`, rather than save hashes that no longer resolve.
 *
 * Independent of unrelated failures elsewhere in the model: each carry is
 * reported only by a feature that built, and is written only while the
 * feature still stores exactly the hashes the carry started from.
 */
export function carriedSelectionCommands(
  document: ProjectDocument,
  derived: DerivedState
): { commands: AnyCommand[]; unpersisted: FeatureId[] } {
  const features = listFeaturesInOrder(document);
  const commands: AnyCommand[] = [];
  const unpersisted: FeatureId[] = [];
  for (const repair of derived.edgeHashRepairs ?? []) {
    const feature = features.find((f) => f.featureId === repair.featureId);
    const stored =
      feature &&
      (feature.data.featureKind === 'fillet' ||
        feature.data.featureKind === 'chamfer') &&
      !feature.data.edgeReferences
        ? [...new Set(feature.data.edgeHashes)]
        : null;
    if (
      !stored ||
      repair.from.length !== repair.to.length ||
      new Set(repair.to).size !== repair.to.length ||
      stored.length !== repair.from.length ||
      stored.some((hash, index) => hash !== repair.from[index])
    ) {
      unpersisted.push(repair.featureId);
      continue;
    }
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
  return { commands, unpersisted };
}

/**
 * Build one atomic normalization from advice for this exact document version.
 *
 * Carried hash-only selections are not normalized here. A carry is only ever
 * proposed by an edit's own validation build, and `withCarriedSelections`
 * writes it in that edit's revision; a plain rebuild never carries, so a path
 * that commits without a validated build (resume, AI patch, an unvalidated
 * sketch edit) leaves a stranded pick refused, never silently moved.
 */
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

/**
 * A validated commit's commands with the carried-selection rewrites its
 * rebuild reported appended, so the edit and the hashes its geometry was
 * built from land in one revision (and one undo step). `refusal` names the
 * feature when a carried selection cannot be written; the commit must then
 * not land, since its saved hashes would not rebuild what was shown.
 */
export function withCarriedSelections(
  document: ProjectDocument,
  commands: readonly AnyCommand[],
  derived: DerivedState
): { commands: AnyCommand[] } | { refusal: string } {
  if (!derived.edgeHashRepairs?.length) return { commands: [...commands] };
  let candidate = document;
  try {
    for (const command of commands) candidate = command.apply(candidate);
  } catch {
    // The manager validates and reports the edit's own error.
    return { commands: [...commands] };
  }
  const carried = carriedSelectionCommands(candidate, derived);
  if (carried.unpersisted.length) {
    const names = carried.unpersisted.map(
      (featureId) =>
        listFeaturesInOrder(candidate).find((f) => f.featureId === featureId)
          ?.name ?? 'A later feature'
    );
    return {
      refusal: `“${names[0]}” can’t keep its edges through this change. Edit “${names[0]}” and pick its edges again.`
    };
  }
  return { commands: [...commands, ...carried.commands] };
}
