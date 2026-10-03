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
    }
  | { kind: 'box'; bodyIds: BodyId[] };

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
    pick.kind === 'viewport' &&
    pick.selection.kind !== 'body' &&
    // Moving a sketch can rebuild several downstream bodies; its ID is not
    // a BodyId, so equality with the picked body cannot establish safety.
    (preview.target === 'sketch' || pick.selection.bodyId === preview.bodyId)
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
  const bodyIds =
    request.kind === 'box' ? request.bodyIds : [request.selection.bodyId];
  return bodyIds.length > 0 &&
    bodyIds.every((id) => findBodyNode(document, id) !== undefined)
    ? document
    : null;
}
