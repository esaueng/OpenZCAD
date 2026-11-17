import { LOCAL_PROJECT_CHECKPOINT_THUMBNAIL_STORE as STORE } from './localProjectSchema';
import {
  CHECKPOINT_THUMBNAIL_AGE_INDEX,
  scopedTransaction
} from './localProjectStore';

/**
 * L03 per-checkpoint thumbnails: one card image per save point, drawn from
 * meshes this browser already holds (at save time, or when a preview builds
 * the save) and kept on this device only. Nothing is uploaded, so an
 * encrypted project's save points gain no server-side record (ADR-024); a
 * device that never drew a save point's card shows a placeholder until it
 * previews that save.
 */

/** Cards kept across every project; the oldest go first. */
export const MAX_CHECKPOINT_THUMBNAILS = 600;

export interface CheckpointThumbnailRecord {
  checkpointId: string;
  /** The project it was drawn for, so deleting the project removes it. */
  projectId: string;
  /** A data URL, as the project cards store them. */
  source: string;
  capturedAt: string;
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Local storage failed.'));
  });
}

const listeners = new Set<(checkpointId: string) => void>();

/** Notified after a card is stored, so an open versions list can show it. */
export function onCheckpointThumbnailsChanged(
  listener: (checkpointId: string) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stores a save point's card, replacing any earlier one, within the cap. */
export async function saveCheckpointThumbnail(
  record: CheckpointThumbnailRecord
): Promise<void> {
  await scopedTransaction('readwrite', [STORE], async (store) => {
    const thumbnails = store(STORE);
    thumbnails.put(record);
    const count = await settled(thumbnails.count());
    let excess = count - MAX_CHECKPOINT_THUMBNAILS;
    if (excess <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const cursor = thumbnails
        .index(CHECKPOINT_THUMBNAIL_AGE_INDEX)
        .openCursor();
      cursor.onerror = () =>
        reject(cursor.error ?? new Error('Local storage failed.'));
      cursor.onsuccess = () => {
        const next = cursor.result;
        if (!next || excess <= 0) return resolve();
        // Never the card just written, even if the clock went backwards.
        if (next.primaryKey !== record.checkpointId) {
          next.delete();
          excess -= 1;
        }
        next.continue();
      };
    });
  });
  for (const listener of listeners) {
    try {
      listener(record.checkpointId);
    } catch {
      /* A listener cannot fail a stored card. */
    }
  }
}

/** The cards this device holds for these save points, by checkpoint id. */
export function loadCheckpointThumbnails(
  checkpointIds: readonly string[]
): Promise<Map<string, string>> {
  if (checkpointIds.length === 0) return Promise.resolve(new Map<string, string>());
  return scopedTransaction('readonly', [STORE], async (store) => {
    const thumbnails = store(STORE);
    const records = await Promise.all(
      checkpointIds.map(
        (checkpointId) =>
          settled(thumbnails.get(checkpointId)) as Promise<
            CheckpointThumbnailRecord | undefined
          >
      )
    );
    return new Map(
      records
        .filter((record): record is CheckpointThumbnailRecord =>
          Boolean(record?.source)
        )
        .map((record) => [record.checkpointId, record.source])
    );
  });
}

/** Whether this device already holds a card for this save point. */
export function hasCheckpointThumbnail(checkpointId: string): Promise<boolean> {
  return scopedTransaction('readonly', [STORE], async (store) =>
    settled(store(STORE).count(checkpointId)).then((count) => count > 0)
  );
}
