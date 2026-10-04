/**
 * Turning the text card's draft into a sketch object.
 *
 * Kept apart from the session math so it loads with the viewport and the card
 * rather than with the app shell: nothing on first paint places text.
 */
import { textSketchBudgetError, type SketchObjectData } from '@openzcad/shared';
import type { SketchTextDraft } from '../interaction/machine';
import type { SketchPoint } from './session';

/**
 * Text is placed with a single click rather than a drag: its extent comes from
 * the string and the em size, not from how far the pointer travelled, so there
 * is nothing for a drag to mean. The click sets the baseline origin; the
 * draft the card composed supplies everything else. The live outline that
 * follows the pointer is built by this same call, so the preview and the
 * placed object cannot disagree.
 */
export function textObjectFromPoint(
  point: SketchPoint,
  draft: SketchTextDraft
): SketchObjectData {
  return {
    objectKind: 'text',
    text: draft.text,
    fontFamily: draft.fontFamily,
    fontStyle: draft.fontStyle,
    size: draft.size,
    x: point.x,
    y: point.y,
    // Left is the schema default; leaving it out keeps the stored object
    // what it was before alignment existed.
    ...(draft.align === 'left' ? {} : { align: draft.align })
  };
}

/**
 * Why a text object with this string cannot join the sketch, if it cannot:
 * the outline budgets, counted with the sketch's committed text the way the
 * display counts them once the object is placed. Placing over budget would
 * drop every text outline in the sketch from the display.
 */
export function textDraftBudgetError(
  objects: readonly { data: SketchObjectData }[],
  text: string,
  documentBudgetError: string | null = null
): string | null {
  return (
    documentBudgetError ??
    textSketchBudgetError([
      ...objects.flatMap(({ data }) =>
        data.objectKind === 'text' ? [data.text] : []
      ),
      text
    ])
  );
}
