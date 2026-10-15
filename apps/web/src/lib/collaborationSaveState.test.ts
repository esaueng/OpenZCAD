import { describe, expect, it } from 'vitest';
import { collaborationSaveState } from './collaborationSaveState';
import type { WorkspaceSaveState } from './cloudProjectAutosave';
import type { CollaborationStatus } from './useCollaboration';

const cases: Array<
  [CollaborationStatus, WorkspaceSaveState, WorkspaceSaveState]
> = [
  ['connecting', 'syncing', 'synced'],
  ['live', 'syncing', 'synced'],
  ['offline', 'offline', 'offline'],
  ['conflict', 'conflict', 'conflict'],
  ['oversize', 'local', 'local'],
  ['rejected', 'local', 'local'],
  ['update-required', 'local', 'local'],
  ['read-only', 'local', 'synced'],
  ['lease-denied', 'local', 'synced']
];

describe('collaboration save feedback', () => {
  it.each(cases)(
    '%s distinguishes pending edits from acknowledged documents',
    (status, pending, acknowledged) => {
      expect(collaborationSaveState(status, false, 3, 4)).toBe(pending);
      expect(collaborationSaveState(status, false, 4, 4)).toBe(acknowledged);
    }
  );
  it.each(cases)('%s preserves an unresolved conflict', (status) => {
    expect(collaborationSaveState(status, true, 4, 4)).toBe('conflict');
  });
  it('does not claim a missing room baseline was acknowledged', () => {
    expect(collaborationSaveState('live', false, null, undefined)).toBe(
      'syncing'
    );
    expect(collaborationSaveState('read-only', false, null, 4)).toBe('local');
  });
});
