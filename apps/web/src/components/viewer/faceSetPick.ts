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

/**
 * A command that takes faces and no edges (Hole, Shell) has no use for an
 * edge. A finger's edge band is some 15 px either side of the line, which
 * covers the whole of a small face drawn at Fit View: a tap on its middle
 * picked the edge, and the command ignored it. So on a touch, a stack led by
 * an edge goes to the first surface under the finger, when that surface is
 * a face of the edge's own body: the face the edge bounds there.
 *
 * Nothing further back is ever taken. When the first surface under the
 * finger is another body's (an insert beside a bracket's lip, or the stage
 * past a body's outline), the stack stays as it was and the tap does what it
 * did before: the band says the finger is on that edge's body's boundary,
 * so another body's face is not plainly what it meant. A mouse or a pen has
 * half a finger's band and picks as it always has.
 */
export function faceAheadOfLeadEdge(
  stack: PickCandidate[],
  pointerType: string | undefined
): PickCandidate[] {
  const lead = stack[0]?.selection;
  if (pointerType !== 'touch' || lead?.kind !== 'edge') return stack;
  const index = stack.findIndex(
    (candidate) => candidate.selection?.kind !== 'edge'
  );
  const surface = index < 0 ? null : stack[index]!.selection;
  if (surface?.kind !== 'face' || surface.bodyId !== lead.bodyId) return stack;
  return [stack[index]!, ...stack.slice(0, index), ...stack.slice(index + 1)];
}
