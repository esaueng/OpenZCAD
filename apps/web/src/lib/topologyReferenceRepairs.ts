import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  listFeaturesInOrder,
  type FeatureUpdateInput
} from '@openzcad/document-core';
import type {
  DerivedState,
  FaceReferenceRepair,
  FaceTopologyReferenceV5,
  FeatureId,
  FeatureNode,
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
 *
 * Advice is taken only from features before the first step that failed, was
 * refused or is suppressed: everything after it was built on a body that step
 * passed through, so a name proven there need not be the name the complete
 * model publishes (ADR-017, November 2026). The kernel withholds that advice
 * itself; this is the same line drawn again on the derived state.
 */
export function topologyReferenceRepairCommand(
  document: ProjectDocument,
  derived: DerivedState
): AnyCommand | null {
  if (!derived.featureWarnings && derived.warnings.length) return null;
  const features = listFeaturesInOrder(document);
  const interrupted = new Set(
    (derived.featureWarnings ?? [])
      .filter((warning) => warning.kind !== 'advisory')
      .map((warning) => warning.featureId)
  );
  const firstInterrupted = features.findIndex((feature) =>
    interrupted.has(feature.featureId)
  );
  const repairable = (featureId: FeatureId) => {
    const index = features.findIndex((f) => f.featureId === featureId);
    return index >= 0 && (firstInterrupted < 0 || index < firstInterrupted);
  };
  const commands: AnyCommand[] = [];
  for (const repair of derived.referenceRepairs ?? []) {
    if (!repairable(repair.featureId)) continue;
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
  const faceRepairs = new Map<FeatureId, FaceReferenceRepair[]>();
  for (const repair of derived.faceReferenceRepairs ?? []) {
    if (!repairable(repair.featureId)) continue;
    const list = faceRepairs.get(repair.featureId) ?? [];
    list.push(repair);
    faceRepairs.set(repair.featureId, list);
  }
  for (const [featureId, repairs] of faceRepairs) {
    const feature = features.find((f) => f.featureId === featureId);
    const data = feature && faceRepairData(feature.data, repairs);
    if (!data) continue;
    commands.push(
      commandFactories.updateFeature(
        { featureId, data },
        'Repair face reference'
      )
    );
  }
  return commands.length
    ? composeCommands('Repair topology references', commands)
    : null;
}

/** The one reference proven for the stored `faceHash` in `role`, if any. */
function singleFaceRepair(
  repairs: readonly FaceReferenceRepair[],
  faceHash: number,
  role: FaceReferenceRepair['role']
): FaceTopologyReferenceV5 | undefined {
  const matching = repairs.filter((repair) => repair.role === role);
  const [repair] = matching;
  return matching.length === 1 &&
    repair!.faceHash === faceHash &&
    repair!.faceReference.currentHash === faceHash
    ? repair!.faceReference
    : undefined;
}

/**
 * A stored face set's references, all or nothing: exactly one proven
 * reference for every distinct stored hash, each keeping that hash.
 */
function faceSetRepair(
  repairs: readonly FaceReferenceRepair[],
  faceHashes: readonly number[]
): FaceTopologyReferenceV5[] | undefined {
  const members = repairs.filter((repair) => repair.role === 'set');
  const hashes = new Set(faceHashes);
  if (
    members.length !== hashes.size ||
    members.some(
      (repair) =>
        repair.faceReference.currentHash !== repair.faceHash ||
        !hashes.has(repair.faceHash)
    ) ||
    new Set(members.map((repair) => repair.faceHash)).size !== hashes.size
  )
    return undefined;
  return [...hashes].map(
    (hash) => members.find((repair) => repair.faceHash === hash)!.faceReference
  );
}

/**
 * The data patch that adds proven references to a feature's hash-only face
 * picks, or null. A pick that already has a reference, or whose stored hash
 * is not the one the proof started from, is left exactly as it is.
 */
function faceRepairData(
  data: FeatureNode['data'],
  repairs: readonly FaceReferenceRepair[]
): FeatureUpdateInput['data'] | null {
  switch (data.featureKind) {
    case 'direct-edit': {
      const operation = data.operation;
      const faceReference = operation.faceReference
        ? undefined
        : singleFaceRepair(repairs, operation.faceHash, undefined);
      const oppositeFaceReference =
        operation.kind === 'set-face-distance' &&
        !operation.oppositeFaceReference
          ? singleFaceRepair(repairs, operation.oppositeFaceHash, 'opposite')
          : undefined;
      if (!faceReference && !oppositeFaceReference) return null;
      return {
        operation: {
          ...operation,
          ...(faceReference ? { faceReference } : {}),
          ...(oppositeFaceReference ? { oppositeFaceReference } : {})
        }
      };
    }
    case 'hole':
    case 'thicken':
    case 'thread':
    case 'gear': {
      if (data.faceReference || typeof data.faceHash !== 'number') return null;
      const faceReference = singleFaceRepair(repairs, data.faceHash, undefined);
      return faceReference ? { faceReference } : null;
    }
    case 'shell': {
      if (data.openingFaceReferences) return null;
      const openingFaceReferences = faceSetRepair(
        repairs,
        data.openingFaceHashes
      );
      return openingFaceReferences ? { openingFaceReferences } : null;
    }
    case 'draft': {
      if (data.faceReferences) return null;
      const faceReferences = faceSetRepair(repairs, data.faceHashes);
      return faceReferences ? { faceReferences } : null;
    }
    default:
      return null;
  }
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
