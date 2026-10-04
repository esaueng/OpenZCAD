import type { SketchEditSession } from './editing';

/**
 * Which entity an edit writes, and which selection the race guard holds it
 * to. An editor edit is about the selection: if the selection moves while it
 * validates, it is refused (`raceObjectId`). A viewport drag captured its
 * object at release, so its commit names that object and is not refused when
 * the user selects something else before the edit answers; the document,
 * project and sketch guards still apply. Null when there is nothing to edit.
 */
export function sketchEntityEditTarget(
  current: SketchEditSession,
  capturedObjectId?: string
): { sketchId: string; objectId: string; raceObjectId?: string } | null {
  const sketchId = current.session?.sketchId;
  if (current.mode !== 'sketch' || !sketchId) return null;
  if (capturedObjectId !== undefined) {
    return { sketchId, objectId: capturedObjectId };
  }
  const selected = current.session?.selectedObjectId;
  return selected
    ? { sketchId, objectId: selected, raceObjectId: selected }
    : null;
}
