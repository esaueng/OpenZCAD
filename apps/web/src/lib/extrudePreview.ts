import type { ExtrudeInput } from '@openzcad/document-core';
import type { BodyId } from '@openzcad/shared';
import { withOperation } from './extrudeInference';

/** The part of a sketch's plane reference a preview needs. */
export type ExtrudePreviewPlaneRef =
  | { type: 'face'; bodyId: BodyId }
  | { type: string; bodyId?: BodyId };

/**
 * Decides what a region drag previews before the exact classification has
 * run. The drag direction carries the intent the reference CAD acts on: into
 * the face's body cuts, away from it adds, and a sketch on a free plane grows
 * a new body. The commit still runs `resolveExtrudeOperation`, whose exact
 * overlap measurement has the final say — this only picks the shape shown
 * while the hand is moving.
 */
export function previewExtrudeOperation(
  planeRef: ExtrudePreviewPlaneRef | undefined,
  distance: number
): { operation: 'new-body' | 'add' | 'cut'; targetBodyId?: BodyId } {
  if (
    planeRef?.type === 'face' &&
    planeRef.bodyId !== undefined &&
    Number.isFinite(distance) &&
    distance !== 0
  ) {
    return distance < 0
      ? { operation: 'cut', targetBodyId: planeRef.bodyId }
      : { operation: 'add', targetBodyId: planeRef.bodyId };
  }
  return { operation: 'new-body' };
}

/** The extrude input a region-drag preview should build with. */
export function previewExtrudeInput(
  input: ExtrudeInput,
  planeRef: ExtrudePreviewPlaneRef | undefined,
  distance: number
): ExtrudeInput {
  const choice = previewExtrudeOperation(planeRef, distance);
  return withOperation(input, choice.operation, choice.targetBodyId);
}
