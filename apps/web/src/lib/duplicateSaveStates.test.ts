import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  duplicateProjectDocument,
  restoreFromSaveState
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { copyLocalSaveStates } from './duplicateSaveStates';
import {
  listLocalSaveStateIds,
  loadLocalSaveState,
  saveLocalProject
} from './localProjectStore';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function withBox(document: ProjectDocument, name: string): ProjectDocument {
  return appendRevision(
    addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, depth: 10, height: 10 }
    }),
    `Added ${name}`
  );
}

/** A project saved twice on this device, each save's document stored. */
async function savedTwice(): Promise<ProjectDocument> {
  const first = createCheckpoint(
    createProjectDocument('Bracket', toUserId('user-1')),
    'First save'
  );
  await saveLocalProject(first);
  const second = createCheckpoint(withBox(first, 'Box'), 'Second save');
  await saveLocalProject(second);
  return second;
}

// F018: a duplicate counted every save it inherited, but only its own
// "Duplicated from" save had a document, so the rest read "not stored".
describe('a duplicate keeps the saves it lists', () => {
  it('stores every inherited save state this device holds, under the copy', async () => {
    const source = await savedTwice();
    const copy = duplicateProjectDocument(
      source,
      'Bracket (copy)',
      toUserId('user-1')
    );
    await saveLocalProject(copy);
    const before = await listLocalSaveStateIds(copy.projectId);
    expect(before.size).toBeLessThan(copy.checkpoints.length);

    const sourceHeld = await listLocalSaveStateIds(source.projectId);
    expect(sourceHeld.size).toBe(2);

    expect(await copyLocalSaveStates(source.projectId, copy)).toBe(2);

    // Every save that opens in the source opens in the copy, beside the
    // copy's own "Duplicated from" save.
    const own = copy.checkpoints.at(-1)!.checkpointId;
    expect(await listLocalSaveStateIds(copy.projectId)).toEqual(
      new Set([...sourceHeld, own])
    );
    // The source keeps its own, untouched.
    expect(await listLocalSaveStateIds(source.projectId)).toEqual(sourceHeld);
  });

  it('restores an inherited save in the copy as the copy, not the source', async () => {
    const source = await savedTwice();
    const copy = duplicateProjectDocument(
      source,
      'Bracket (copy)',
      toUserId('user-2')
    );
    await saveLocalProject(copy);
    await copyLocalSaveStates(source.projectId, copy);

    const firstSave = copy.checkpoints.find(
      (point) => point.reason === 'First save'
    )!;
    const snapshot = await loadLocalSaveState(
      copy.projectId,
      firstSave.checkpointId
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot!.projectId).toBe(copy.projectId);
    expect(snapshot!.ownerUserId).toBe(copy.ownerUserId);
    expect(snapshot!.name).toBe('Bracket (copy)');
    expect(snapshot!.featureOrder).toEqual([]);

    const restored = restoreFromSaveState(copy, snapshot!, 'Restore');
    expect(restored.projectId).toBe(copy.projectId);
    expect(restored.name).toBe('Bracket (copy)');
    expect(restored.featureOrder).toEqual([]);
    const root = restored.nodes[restored.rootNodeId];
    expect(root?.kind === 'project' ? root.projectId : null).toBe(
      copy.projectId
    );
  });

  it('leaves a save state it cannot prepare as a record, and stores the rest', async () => {
    const source = await savedTwice();
    const copy = duplicateProjectDocument(
      source,
      'Bracket (copy)',
      toUserId('user-1')
    );
    await saveLocalProject(copy);
    const stored = await copyLocalSaveStates(
      source.projectId,
      copy,
      async (snapshot) => {
        if (snapshot.featureOrder.length > 0) {
          throw new Error('Its imported source is not on this device.');
        }
      }
    );
    expect(stored).toBe(1);
    const held = await listLocalSaveStateIds(copy.projectId);
    const second = copy.checkpoints.find(
      (point) => point.reason === 'Second save'
    )!;
    expect(held.has(second.checkpointId)).toBe(false);
  });
});
