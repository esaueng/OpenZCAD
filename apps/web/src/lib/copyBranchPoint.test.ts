import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  createSavedRevision,
  duplicateProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { copyLineageNote, withCopyBranchPoint } from './copyBranchPoint';

const owner = toUserId('user_copy_branch');

describe('withCopyBranchPoint', () => {
  it('records the source at its newest revision, keeping the duplicate’s own save point', () => {
    const head = createSavedRevision(
      createProjectDocument('Bracket', owner),
      'Before drilling'
    );
    const copy = duplicateProjectDocument(head, 'Bracket (copy)', owner);
    const branched = withCopyBranchPoint(
      copy,
      { projectId: head.projectId, name: head.name },
      head,
      'Copied to convert to inches'
    );
    expect(branched.branchedFrom).toMatchObject({
      projectId: head.projectId,
      revisionId: head.revisions.at(-1)!.revisionId,
      projectName: 'Bracket',
      checkpointReason: 'Copied to convert to inches'
    });
    expect(typeof branched.branchedFrom?.branchedAt).toBe('string');
    expect(branched.projectId).toBe(copy.projectId);
    expect(branched.revisions).toBe(copy.revisions);
    expect(copy.branchedFrom).toBeUndefined();
  });

  it('leaves a copy of a revisionless source without lineage, and says so', () => {
    // A valid backup can be imported with empty history: there is no save
    // state for `branchedFrom.revisionId` to name.
    const head = {
      ...createProjectDocument('Bracket', owner),
      revisions: [],
      checkpoints: []
    };
    const copy = duplicateProjectDocument(head, 'Bracket (copy)', owner);
    const branched = withCopyBranchPoint(
      copy,
      { projectId: head.projectId, name: head.name },
      head,
      'Copied to convert to inches'
    );
    expect(branched).toBe(copy);
    expect(branched.branchedFrom).toBeUndefined();
    expect(copyLineageNote(branched, 'Bracket')).toBe(
      ' The copy does not record that it came from Bracket: Bracket has no save point yet to name.'
    );
  });

  it('adds nothing to the message when the copy records its source', () => {
    const head = createSavedRevision(
      createProjectDocument('Bracket', owner),
      'Before drilling'
    );
    const branched = withCopyBranchPoint(
      duplicateProjectDocument(head, 'Bracket (copy)', owner),
      { projectId: head.projectId, name: head.name },
      head,
      'Copied to convert to inches'
    );
    expect(copyLineageNote(branched, 'Bracket')).toBe('');
  });
});
