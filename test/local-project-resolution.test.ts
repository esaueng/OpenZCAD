import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { selectProjectDocument } from '../apps/web/src/lib/localProjectStore';

describe('local-first project resolution', () => {
  it('keeps newer local edits when the cloud copy is stale', () => {
    const remote = createProjectDocument('Bracket', toUserId('user_test'));
    const local = {
      ...structuredClone(remote),
      version: remote.version + 2,
      derived: { ...remote.derived, updatedAt: '2026-07-12T20:00:00.000Z' }
    };
    expect(selectProjectDocument(local, remote)).toBe(local);
  });

  it('uses the newer remote copy and supports one-sided availability', () => {
    const local = createProjectDocument('Bracket', toUserId('user_test'));
    const remote = { ...structuredClone(local), version: local.version + 1 };
    expect(selectProjectDocument(local, remote)).toBe(remote);
    expect(selectProjectDocument(local, null)).toBe(local);
    expect(selectProjectDocument(null, remote)).toBe(remote);
  });
});
