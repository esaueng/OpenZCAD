import { findBodyNode, findSketch } from '@openzcad/document-core';
import type {
  BodyId,
  ProjectDocument,
  SketchId,
  TopologySelection
} from '@openzcad/shared';
import type { MovePreview, RegionPickData } from '@openzcad/viewport';
import type { PickDetail } from '@openzcad/viewport/types';
import { movingSketchId, sketchViewShown } from './moveCard';

type MoveSelectionOwner = { readonly document: ProjectDocument };

export type MoveSelectionPick =
  | {
      kind: 'viewport';
      selection: TopologySelection;
      additive: boolean;
      detail?: PickDetail;
      contextMenu?: { x: number; y: number };
    }
  | { kind: 'box'; bodyIds: BodyId[] }
  | { kind: 'body-tree'; bodyId: BodyId; additive: boolean }
  | { kind: 'edge-chain'; selections: TopologySelection[] }
  | {
      kind: 'region';
      region: RegionPickData;
      modifiers: { additive: boolean; toggle: boolean };
    }
  | { kind: 'sketch-profile'; sketchId: SketchId };

export type MoveSelectionRequest = MoveSelectionPick & {
  manager: MoveSelectionOwner;
  projectId: ProjectDocument['projectId'];
  version: number;
};

/** A Move can temporarily show only the hidden sketch it owns. */
export function moveSketchPickVisibility(
  pick: MoveSelectionPick,
  preview: Pick<MovePreview, 'bodyId' | 'target'> | null,
  hiddenSketchIds: ReadonlySet<string>
): 'visible' | 'temporary' | 'hidden' | null {
  const id =
    pick.kind === 'region'
      ? pick.region.sketchId
      : pick.kind === 'sketch-profile'
        ? pick.sketchId
        : null;
  if (id === null) return null;
  if (!sketchViewShown(id, hiddenSketchIds, movingSketchId(preview))) {
    return 'hidden';
  }
  return hiddenSketchIds.has(id) ? 'temporary' : 'visible';
}

/** A moved pick's old coordinates cannot arm a handle at its new pose. */
export function movePickNeedsFreshTopology(
  preview: Pick<MovePreview, 'bodyId' | 'target'> | null,
  pick: MoveSelectionPick,
  document?: ProjectDocument
): boolean {
  if (preview && pick.kind === 'sketch-profile') {
    return preview.target === 'sketch';
  }
  if (preview && pick.kind === 'region') {
    const sketch =
      document && findSketch(document, pick.region.sketchId as SketchId);
    // Face-attached descendants can follow the moved body transitively, and
    // its new exact plane has not published yet. Canonical/fixed frames stay.
    return (
      preview.target === 'sketch' || !sketch || sketch.planeRef.type === 'face'
    );
  }
  return (
    preview !== null &&
    pick.kind !== 'box' &&
    pick.kind !== 'body-tree' &&
    pick.kind !== 'region' &&
    pick.kind !== 'sketch-profile' &&
    // Moving a sketch can rebuild several downstream bodies; its ID is not
    // a BodyId, so equality with the picked body cannot establish safety.
    (pick.kind === 'edge-chain' ? pick.selections : [pick.selection]).some(
      (selection) =>
        selection.kind !== 'body' &&
        (preview.target === 'sketch' || selection.bodyId === preview.bodyId)
    )
  );
}

/** A delayed pick must still belong to the document it was made against. */
export function currentMoveSelectionDocument(
  manager: MoveSelectionOwner | null | undefined,
  request: MoveSelectionRequest
): ProjectDocument | null {
  const document = manager?.document;
  if (
    !document ||
    manager !== request.manager ||
    document.projectId !== request.projectId ||
    document.version !== request.version
  ) {
    return null;
  }
  if (request.kind === 'region' || request.kind === 'sketch-profile') {
    const sketchId =
      request.kind === 'region' ? request.region.sketchId : request.sketchId;
    return findSketch(document, sketchId as SketchId) ? document : null;
  }
  if (
    request.kind === 'edge-chain' &&
    request.selections.some((selection) => selection.kind !== 'edge')
  ) {
    return null;
  }
  const bodyIds =
    request.kind === 'box'
      ? request.bodyIds
      : request.kind === 'edge-chain'
        ? request.selections.map((selection) => selection.bodyId)
        : request.kind === 'body-tree'
          ? [request.bodyId]
          : [request.selection.bodyId];
  return bodyIds.length > 0 &&
    bodyIds.every((id) => findBodyNode(document, id) !== undefined)
    ? document
    : null;
}

/** Resolve the held identity against freshly computed live regions. */
export function resolveMoveSketchRegion(
  pick: Extract<MoveSelectionPick, { kind: 'region' }>,
  regions: readonly RegionPickData[]
): RegionPickData | null {
  const sketchId = pick.region.sketchId;
  const current = regions.filter((region) => region.sketchId === sketchId);
  const sourceIds = pick.region.sourceEntityIds.slice().sort();
  const matches = current.filter(
    (region) =>
      region.profileId === pick.region.profileId &&
      region.regionFingerprint === pick.region.regionFingerprint &&
      region.sourceEntityIds.length === sourceIds.length &&
      region.sourceEntityIds
        .slice()
        .sort()
        .every((id, index) => id === sourceIds[index])
  );
  return matches.length === 1 ? matches[0]! : null;
}
