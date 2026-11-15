import type { PickCandidate } from '@openzcad/viewport';

/**
 * A Shift pick while faces of one body are held adds a face, so on that body
 * the face under the pointer goes ahead of the edge the pick service would
 * otherwise promote. A thin wall seen at an angle is a few pixels wide and
 * every pixel of it is within an edge's pick band; without this, Shift there
 * picks an edge and the held faces give way to an edge selection.
 *
 * Only that one face moves, and only past an edge on the same body: the rest
 * of the stack keeps its order, so a second click on the same spot still
 * steps to the edge, and other bodies, regions and sketches are untouched.
 */
export function facesAheadOfEdges(
  stack: PickCandidate[],
  bodyId: string | null
): PickCandidate[] {
  const lead = stack[0]?.selection;
  if (!bodyId || lead?.kind !== 'edge' || lead.bodyId !== bodyId) {
    return stack;
  }
  const index = stack.findIndex(
    (candidate) =>
      candidate.selection?.kind === 'face' &&
      candidate.selection.bodyId === bodyId
  );
  if (index < 0) return stack;
  return [stack[index]!, ...stack.slice(0, index), ...stack.slice(index + 1)];
}
