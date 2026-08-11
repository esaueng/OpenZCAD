import type { ProjectDocument } from '@openzcad/shared';

export const LOCAL_AUTOSAVE_FAILED_STATUS =
  'Local autosave failed. Export your model before closing.';

export interface LocalAutosaveFailure {
  /** The document the failed write was given. */
  pending: ProjectDocument;
  /**
   * What is queued for the next write right now. Non-null means a later edit
   * landed while this one was in flight.
   */
  queued: ProjectDocument | null;
}

/**
 * The document an autosave that could not write must put back in its queue, or
 * null to leave the queue as it is.
 *
 * Two rules, and they pull in opposite directions. The document must not be
 * lost — the autosave takes it OUT of the queue before the write, so a write
 * that did not land leaves the failing call holding the only copy of those
 * edits, and simply returning drops them on the floor. And it must not overwrite
 * a NEWER document that landed while the write was in flight — a later edit is a
 * superset of this one, so re-parking on top of it would undo whatever the user
 * did in between.
 */
export function reparkFailedAutosave(
  failure: LocalAutosaveFailure
): ProjectDocument | null {
  return failure.queued === null ? failure.pending : null;
}
