import type { ProjectDocument } from '@openzcad/shared';
import type { InteractionState } from './machine';

export function blendPreviewSelectionKey(
  state: InteractionState
): string | null {
  if (state.mode === 'edges') {
    return JSON.stringify([state.mode, state.op, state.edges]);
  }
  if (state.mode === 'face' && state.op === 'edit-fillet') {
    return JSON.stringify([state.mode, state.op, state.target]);
  }
  return null;
}

export interface BlendPreviewIdentity {
  baseProjectId: ProjectDocument['projectId'];
  baseVersion: number;
  selectionKey: string;
  size: number;
}

export function canReuseBlendPreview(
  candidate: BlendPreviewIdentity,
  document: ProjectDocument | undefined,
  selection: InteractionState,
  size: number
): boolean {
  return (
    document !== undefined &&
    candidate.baseProjectId === document.projectId &&
    candidate.baseVersion === document.version &&
    candidate.selectionKey === blendPreviewSelectionKey(selection) &&
    candidate.size === size
  );
}
