/** One candidate under a press, as the viewer's picker reports it. */
export interface CommentPlacementCandidate<Selection> {
  selection?: Selection | null;
  region?: unknown;
  sketchId?: string | null;
}

/**
 * L08: where a press places a comment, among the candidates under it,
 * nearest first: the first body surface. A sketch profile or a region in
 * front of it is passed over (it is drawn over the model, not part of it),
 * and a press on nothing but those places nothing.
 */
export function commentPlacementTarget<
  Selection,
  Candidate extends CommentPlacementCandidate<Selection>
>(stack: readonly Candidate[]): (Candidate & { selection: Selection }) | null {
  const surface = stack.find(
    (candidate) =>
      candidate.selection != null && !candidate.region && !candidate.sketchId
  );
  return (
    (surface as (Candidate & { selection: Selection }) | undefined) ?? null
  );
}
