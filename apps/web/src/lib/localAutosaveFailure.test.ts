import { describe, expect, it } from 'vitest';

import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

import { reparkFailedAutosave } from './localAutosaveFailure';

function documentAt(version: number): ProjectDocument {
  const document = createProjectDocument('Bracket', toUserId('user_autosave'));
  return { ...document, version };
}

describe('an autosave that could not write', () => {
  it('puts the document back rather than dropping it', () => {
    // The regression this exists for. The autosave clears its queue BEFORE the
    // write, so a failed write leaves the only copy of those edits in the
    // failing call — and it used to end there. Nothing else on the device or in
    // the account has them, and the user is told the save failed while the work
    // is already gone.
    const pending = documentAt(4);

    expect(reparkFailedAutosave({ pending, queued: null })).toBe(pending);
  });

  it('never puts a stale document on top of a newer one', () => {
    // A later edit landed while this write was in flight. That document is a
    // superset of this one, so re-parking this one would undo whatever the user
    // did in between — losing edits in the other direction.
    const pending = documentAt(4);
    const newer = documentAt(5);

    expect(reparkFailedAutosave({ pending, queued: newer })).toBeNull();
  });
});
