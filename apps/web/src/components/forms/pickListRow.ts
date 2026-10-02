/**
 * Whether a key event landed on a pick-list row.
 *
 * Rows are toggle buttons, and a row clicked a moment ago keeps focus, so
 * the browser's own Enter-activates-the-button un-picked the body or face
 * the user had just chosen while the lane said "Enter creates". Forms that
 * hold a pick list submit on Enter from a row instead; Space still toggles.
 */
export function isPickListRow(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('.pick-row') !== null;
}
