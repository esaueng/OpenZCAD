import type { BodyId, TopologySelection } from '@openzcad/shared';

/**
 * The body a held face set is on: the body Shift adds faces of. Null when no
 * face is held or the faces span bodies (a box sweep across two parts).
 */
export function heldFaceSetBody(
  held: readonly TopologySelection[] | null
): BodyId | null {
  const bodyId = held?.[0]?.bodyId;
  return bodyId &&
    held.every((face) => face.kind === 'face' && face.bodyId === bodyId)
    ? bodyId
    : null;
}

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
