import { findBodyNode } from '@openzcad/document-core';
import type {
  BodyId,
  ProjectDocument,
  TopologySelection
} from '@openzcad/shared';
import type { MovePreview } from '@openzcad/viewport';
import type { PickDetail } from '@openzcad/viewport/types';

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
  | { kind: 'edge-chain'; selections: TopologySelection[] };

export type MoveSelectionRequest = MoveSelectionPick & {
  manager: MoveSelectionOwner;
  projectId: ProjectDocument['projectId'];
  version: number;
};

/** A moved face's old point/normal cannot arm a handle at its new pose. */
export function movePickNeedsFreshTopology(
  preview: Pick<MovePreview, 'bodyId' | 'target'> | null,
  pick: MoveSelectionPick
): boolean {
  return (
    preview !== null &&
    pick.kind !== 'box' &&
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
        : [request.selection.bodyId];
  return bodyIds.length > 0 &&
    bodyIds.every((id) => findBodyNode(document, id) !== undefined)
    ? document
    : null;
}
