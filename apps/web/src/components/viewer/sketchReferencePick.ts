import type { TopologySelection } from '@openzcad/shared';

/**
 * I01: what a sketch step that takes a model reference can take. The Project
 * tool projects a model edge, or a face's whole boundary; anything else under
 * the pointer — the sketch's own curves, a region, a whole-body pick, empty
 * space — is not a reference and is passed over.
 *
 * The click and the hover both read the stack through `sketchReferencePick`,
 * so the hover lights exactly what the click would take and nothing the
 * click would refuse.
 */

/** Sketch tools whose pointer step picks a model reference. */
export function sketchToolTakesReference(tool: string | null | undefined) {
  return tool === 'project';
}

/** Whether one picked target is a valid reference for the step. */
export function isSketchReferenceSelection(
  selection: Pick<TopologySelection, 'kind'> | null | undefined
): boolean {
  return selection?.kind === 'edge' || selection?.kind === 'face';
}

/**
 * The nearest candidate in a pick stack the reference step would take, or
 * null when nothing under the pointer is one.
 */
export function sketchReferencePick<
  T extends { selection: Pick<TopologySelection, 'kind'> | null }
>(stack: readonly T[]): T | null {
  return (
    stack.find((candidate) =>
      isSketchReferenceSelection(candidate.selection)
    ) ?? null
  );
}

/**
 * What the reference step's hover lights: the candidate the click would
 * take, and only when the step would accept it (`accepts`, e.g. a re-pick
 * that needs exactly one source edge). A refused pick lights nothing — the
 * hover never skips past it to something behind that the click would not
 * reach.
 */
export function sketchReferenceHover<
  T extends { selection: TopologySelection | null }
>(
  stack: readonly T[],
  accepts?: (selection: TopologySelection) => boolean
): T | null {
  const candidate = sketchReferencePick(stack);
  if (!candidate?.selection) return null;
  return !accepts || accepts(candidate.selection) ? candidate : null;
}

/**
 * Whether a pointer may preview the reference under it. Touch has no hover:
 * a finger's move is a press, and nothing is lit ahead of it.
 */
export function sketchReferenceHoverApplies(
  tool: string | null | undefined,
  pointerType: string | undefined
): boolean {
  return sketchToolTakesReference(tool) && pointerType !== 'touch';
}
