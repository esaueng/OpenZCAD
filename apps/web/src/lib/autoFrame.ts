import type { BodyId, BodyRepresentation } from '@openzcad/shared';

/**
 * One committed change to frame for: the body projections from before the
 * command and the exact ones its rebuild published. Built by the workspace on
 * a local commit, never for a preview, an undo, or someone else's edit.
 */
export interface AutoFrameRequest {
  before: Readonly<Record<string, BodyRepresentation>>;
  after: Readonly<Record<string, BodyRepresentation>>;
}

/**
 * Only independently added bodies may request framing. Editing an existing
 * body preserves the user's camera, even when it grows or moves out of view.
 *
 * Result features can replace a body with a new BodyId. Consuming a previously
 * visible body identifies that replacement as an edit, rather than treating
 * its result as a newly created part and unexpectedly reframing it.
 */
export function createdBodiesToFrame(
  before: Readonly<Record<string, BodyRepresentation>>,
  after: Readonly<Record<string, BodyRepresentation>>
): BodyId[] {
  if (
    Object.values(before).some((body) => {
      const result = after[body.bodyId];
      return !body.consumed && (!result || result.consumed);
    })
  ) {
    return [];
  }
  return Object.values(after)
    .filter((body) => !body.consumed && !before[body.bodyId])
    .map((body) => body.bodyId);
}
