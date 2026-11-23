import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  createSavedRevision,
  duplicateProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { withCopyBranchPoint } from './copyBranchPoint';

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
    expect(branched.branchedFrom).toEqual({
      projectId: head.projectId,
      revisionId: head.revisions.at(-1)!.revisionId,
      projectName: 'Bracket',
      checkpointReason: 'Copied to convert to inches',
      branchedAt: expect.any(String)
    });
    expect(branched.projectId).toBe(copy.projectId);
    expect(branched.revisions).toBe(copy.revisions);
    expect(copy.branchedFrom).toBeUndefined();
  });
});
