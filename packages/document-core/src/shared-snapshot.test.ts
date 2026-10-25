import { describe, expect, it } from 'vitest';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { createProjectDocument, sharedProjectSnapshotDocument } from './index';

describe('sharedProjectSnapshotDocument', () => {
  it('keeps the current model and drops its history, owner and private sheets', () => {
    const base = createProjectDocument('Bracket', toUserId('user_owner'));
    const document = {
      ...base,
      editHistory: { undo: [], redo: [] },
      branchedFrom: { projectId: 'proj_other', revisionId: 'rev_1' },
      drawings: { sheets: [] },
      referenceImages: { images: [] },
      revisions: [{ revisionId: 'rev_1' }],
      checkpoints: [{ checkpointId: 'cp_1' }],
      commandLog: [{ type: 'noop' }]
    } as unknown as ProjectDocument;
    const before = structuredClone(document);
    const shared = sharedProjectSnapshotDocument(document);
    expect(shared.ownerUserId).toBe('user_shared');
    expect(shared.revisions).toEqual([]);
    expect(shared.checkpoints).toEqual([]);
    expect(shared.commandLog).toEqual([]);
    for (const field of [
      'editHistory',
      'branchedFrom',
      'drawings',
      'referenceImages'
    ]) {
      expect(field in shared).toBe(false);
    }
    expect(shared.derived.bodyRepresentations).toEqual({});
    expect(shared.nodes).toEqual(document.nodes);
    expect(shared.name).toBe('Bracket');
    // The source document is not touched.
    expect(document).toEqual(before);
  });
});
