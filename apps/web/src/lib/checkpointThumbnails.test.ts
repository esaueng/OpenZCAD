import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  MAX_CHECKPOINT_THUMBNAILS,
  hasCheckpointThumbnail,
  loadCheckpointThumbnails,
  onCheckpointThumbnailsChanged,
  saveCheckpointThumbnail
} from './checkpointThumbnails';
import { deleteLocalProject, saveLocalProject } from './localProjectStore';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function card(checkpointId: string, projectId: string, minute = 0) {
  return {
    checkpointId,
    projectId,
    source: `data:image/webp;base64,${checkpointId}`,
    capturedAt: new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString()
  };
}

describe('checkpoint thumbnails (L03, device only)', () => {
  it('keeps one card per save point and tells the versions list', async () => {
    const listener = vi.fn();
    const stop = onCheckpointThumbnailsChanged(listener);
    await saveCheckpointThumbnail(card('checkpoint_a', 'proj_1'));
    await saveCheckpointThumbnail({
      ...card('checkpoint_a', 'proj_1', 1),
      source: 'data:image/webp;base64,newer'
    });
    stop();
    expect(listener).toHaveBeenCalledWith('checkpoint_a');
    expect(await hasCheckpointThumbnail('checkpoint_a')).toBe(true);
    expect(await hasCheckpointThumbnail('checkpoint_b')).toBe(false);
    const loaded = await loadCheckpointThumbnails([
      'checkpoint_a',
      'checkpoint_b'
    ]);
    expect([...loaded]).toEqual([
      ['checkpoint_a', 'data:image/webp;base64,newer']
    ]);
    expect(await loadCheckpointThumbnails([])).toEqual(new Map());
  });

  it('drops the oldest cards past the cap, never the one just drawn', async () => {
    for (let index = 0; index < MAX_CHECKPOINT_THUMBNAILS; index += 1)
      await saveCheckpointThumbnail(
        card(`checkpoint_${index}`, 'proj_1', 10 + (index % 40))
      );
    // Stamped earliest of all, as a clock gone backwards would.
    await saveCheckpointThumbnail(card('checkpoint_new', 'proj_1', 0));
    expect(await hasCheckpointThumbnail('checkpoint_new')).toBe(true);
    const ids = Array.from(
      { length: MAX_CHECKPOINT_THUMBNAILS },
      (_, index) => `checkpoint_${index}`
    );
    const kept = await loadCheckpointThumbnails([...ids, 'checkpoint_new']);
    expect(kept.size).toBe(MAX_CHECKPOINT_THUMBNAILS);
    // One of the oldest stamps (minute 10) went.
    expect(kept.has('checkpoint_0')).toBe(false);
  });

  it('goes with the project it was drawn for', async () => {
    const document = createProjectDocument('Bracket', toUserId('user_1'));
    await saveLocalProject(document);
    await saveCheckpointThumbnail(card('checkpoint_mine', document.projectId));
    await saveCheckpointThumbnail(card('checkpoint_other', 'proj_other'));
    await deleteLocalProject(document.projectId);
    expect(await hasCheckpointThumbnail('checkpoint_mine')).toBe(false);
    expect(await hasCheckpointThumbnail('checkpoint_other')).toBe(true);
  });
});
