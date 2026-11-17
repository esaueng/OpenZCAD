import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

import { documentRevision } from './documentRevision';

const user = toUserId('user_revision');

describe('documentRevision', () => {
  it('is stable for one document object', () => {
    const document = createProjectDocument('Sheet', user);
    expect(documentRevision(document)).toBe(documentRevision(document));
  });

  it('changes when a document is replaced at the same version', () => {
    // A reload, restore or collaborator's replacement can bring different
    // content under the same project id and version (PR #1560 re-check).
    const before = createProjectDocument('Sheet', user);
    const replaced = { ...before, name: 'Sheet (30° bend)' };
    expect(replaced.projectId).toBe(before.projectId);
    expect(replaced.version).toBe(before.version);
    expect(documentRevision(replaced)).not.toBe(documentRevision(before));
  });

  it('changes with the version', () => {
    const before = createProjectDocument('Sheet', user);
    const next = { ...before, version: before.version + 1 };
    expect(documentRevision(next)).not.toBe(documentRevision(before));
  });
});
