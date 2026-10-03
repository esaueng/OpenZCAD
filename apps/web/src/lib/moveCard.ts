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
