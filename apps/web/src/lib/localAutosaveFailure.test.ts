import { describe, expect, it } from 'vitest';

import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

import {
  LOCAL_AUTOSAVE_FAILED_STATUS,
  LOCAL_AUTOSAVE_QUOTA_STATUS,
  localAutosaveFailedStatus,
  reparkFailedAutosave
} from './localAutosaveFailure';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from './workspaceSaveStatePresentation';

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

describe('what the user is told when the device write rejected', () => {
  it('does not reuse the offline copy, which promises the work is saved here', () => {
    // `offline` was the state this used to set, and its own tooltip reads
    // "Saved on this device · your account is unreachable right now." A failed
    // device write is the one case where that sentence is false: the account
    // copy is never queued either, so the document exists only in this tab.
    expect(WORKSPACE_SAVE_STATE_PRESENTATION['device-failed'].title).not.toMatch(
      /saved on this device/i
    );
    expect(WORKSPACE_SAVE_STATE_PRESENTATION['device-failed'].topBarLabel).toBe(
      'Not saved'
    );
  });

  it('names storage exhaustion, the one cause the user can clear', () => {
    const quota = new DOMException('exceeded', 'QuotaExceededError');
    expect(localAutosaveFailedStatus(quota)).toBe(LOCAL_AUTOSAVE_QUOTA_STATUS);
    expect(localAutosaveFailedStatus(quota)).toMatch(/out of storage/i);
  });

  it('falls back to the generic message for any other failure', () => {
    expect(localAutosaveFailedStatus(new Error('boom'))).toBe(
      LOCAL_AUTOSAVE_FAILED_STATUS
    );
    expect(localAutosaveFailedStatus(undefined)).toBe(
      LOCAL_AUTOSAVE_FAILED_STATUS
    );
  });
});
