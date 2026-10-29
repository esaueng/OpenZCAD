/**
 * Lets a press on the viewport take focus away from the control that held it.
 *
 * The viewport cancels many of its pointerdowns (sketch placement, handle and
 * gizmo drags) so the browser starts no text selection or native drag. A
 * cancelled pointerdown also suppresses the mousedown whose default moves
 * focus, so focus stayed on the toolbar tile last pressed or tabbed to, and
 * the next Enter or Space meant for the drawing pressed that tile instead:
 * finishing a line switched the sketch to Arc (production QA F004).
 *
 * Only focus outside `viewport` is released. Fields the viewport draws itself,
 * such as a dimension being typed, keep focus as they did before.
 */
export function releaseFocusOutside(viewport: Element): void {
  const active = viewport.ownerDocument.activeElement;
  if (
    !(active instanceof HTMLElement) ||
    active === viewport.ownerDocument.body ||
    viewport.contains(active)
  ) {
    return;
  }
  active.blur();
}
