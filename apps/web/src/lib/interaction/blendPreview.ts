import type { BodyId, FeatureId, ProjectDocument } from '@openzcad/shared';
import type { AffectedFeatureTarget } from '../affectedFeatureTargets';
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

/**
 * The selection a disposable geometry preview (no volume, no distance
 * proofs) is shown for. Blend drags are keyed by their edges or blend face;
 * face drags by the dragged face. A preview published under one key never
 * shows while the interaction reads as another.
 */
export function geometryPreviewSelectionKey(
  state: InteractionState
): string | null {
  const blend = blendPreviewSelectionKey(state);
  if (blend !== null) return blend;
  if (state.mode !== 'face') return null;
  return `${state.op}:${state.target.bodyId}:${state.target.topologyId}:${Boolean(state.target.localFaceOffset)}`;
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

/**
 * The feature a new fillet or chamfer creates, as the kernel names it. The
 * command's label is the generic "Fillet edges"; the kernel attributes a
 * refusal to the new feature's own name ("Fillet edges 4"), so the preview
 * and the commit both judge against that. Null for a command that reserves
 * no new blend feature.
 */
export function newBlendValidationTarget(command: {
  label: string;
  payload: unknown;
}): AffectedFeatureTarget | null {
  // Fillet and chamfer payloads both reserve their result ids up front; the
  // structural read keeps this independent of which one.
  const payload = command.payload as {
    ids?: { bodyId?: BodyId; featureId?: FeatureId };
    name?: string;
    edgeHashes?: readonly number[];
  };
  if (!payload.edgeHashes || !payload.ids?.bodyId || !payload.ids.featureId) {
    return null;
  }
  return {
    featureId: payload.ids.featureId,
    featureName: payload.name ?? command.label,
    resultBodyId: payload.ids.bodyId
  };
}
