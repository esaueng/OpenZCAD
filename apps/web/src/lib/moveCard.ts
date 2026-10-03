import type { MovePreview } from '@openzcad/viewport';

/**
 * True when the open Move card holds values nobody applied: any translation
 * or rotation away from zero. Opening a different tool over it asks first
 * (F15); a Move still at zero closes without a question.
 */
export function moveHasUnappliedChange(
  preview: Pick<MovePreview, 'translation' | 'rotationDeg'> | null
): boolean {
  if (!preview) return false;
  return (['x', 'y', 'z'] as const).some(
    (axis) => preview.translation[axis] !== 0 || preview.rotationDeg[axis] !== 0
  );
}

/**
 * The sketch an open Move carries, if any. That sketch shows in the viewport
 * for the length of the Move even when an extrude consumed — and so hid — it:
 * the gizmo and the preview need its view, and Apply resolves the sketch's
 * plane from it. Without that, a Move of a hidden sketch had nothing to apply
 * to and was dropped silently.
 */
export function movingSketchId(
  preview: Pick<MovePreview, 'bodyId' | 'target'> | null
): string | null {
  return preview?.target === 'sketch' ? preview.bodyId : null;
}

/** Whether a sketch's view belongs in the viewport (see `movingSketchId`). */
export function sketchViewShown(
  sketchId: string,
  hiddenSketchIds: ReadonlySet<string>,
  movingSketch: string | null
): boolean {
  return sketchId === movingSketch || !hiddenSketchIds.has(sketchId);
}
