import type { TopologySelection } from '@openzcad/shared';

/** Whether two face picks name the same face of the same body. */
export function sameFacePick(
  left: TopologySelection,
  right: TopologySelection
): boolean {
  if (left.bodyId !== right.bodyId || left.kind !== right.kind) return false;
  if (left.topologyId !== undefined && right.topologyId !== undefined) {
    return left.topologyId === right.topologyId;
  }
  return left.hash !== undefined && left.hash === right.hash;
}

/**
 * A Shift-click on a face of a held face set: a new face joins the end of
 * the set, a held face leaves it. Pure; the picks are copied, never shared.
 */
export function toggleFaceInSet(
  held: readonly TopologySelection[],
  pick: TopologySelection
): TopologySelection[] {
  return held.some((face) => sameFacePick(face, pick))
    ? held.filter((face) => !sameFacePick(face, pick))
    : [...held, { ...pick }];
}
