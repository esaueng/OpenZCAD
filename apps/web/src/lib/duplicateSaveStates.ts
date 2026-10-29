import { duplicateSaveStateDocument } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import {
  listLocalSaveStateIds,
  loadLocalSaveState,
  saveLocalSaveStates
} from './localProjectStore';

/**
 * F018: a duplicate lists every save of the project it was made from (its
 * shelf card counts them), but only the copy's own "Duplicated from" save
 * had a document behind it, so every inherited row read "not stored".
 *
 * Stores, under the copy, each inherited save state this device holds for
 * the source, re-homed by `duplicateSaveStateDocument`, so those rows open
 * and restore in the copy as they do in the source. `prepare` brings a save
 * state's imported sources onto this device first (the copy refers to them
 * by device-local id); a save state it cannot prepare, or one this device
 * never held, stays a record, exactly as it reads in the source.
 *
 * Device-only and best effort: the copy is already saved, and a save state
 * missing here is reported by the Revisions panel, not by the duplicate.
 * Returns how many save states were stored.
 */
export async function copyLocalSaveStates(
  sourceProjectId: string,
  copy: ProjectDocument,
  prepare: (snapshot: ProjectDocument) => Promise<void> = async () => {}
): Promise<number> {
  const own = copy.checkpoints.at(-1)?.checkpointId;
  const held = await listLocalSaveStateIds(sourceProjectId).catch(
    () => new Set<string>()
  );
  let stored = 0;
  // Oldest first, one at a time: each is a whole document, and retention
  // then trims the oldest, never the copy's own newest save.
  for (const checkpoint of copy.checkpoints) {
    if (checkpoint.checkpointId === own || !held.has(checkpoint.checkpointId)) {
      continue;
    }
    const snapshot = await loadLocalSaveState(
      sourceProjectId,
      checkpoint.checkpointId
    ).catch(() => null);
    if (!snapshot) continue;
    try {
      await prepare(snapshot);
      await saveLocalSaveStates([duplicateSaveStateDocument(snapshot, copy)]);
      stored += 1;
    } catch {
      // Left as a record of the save, like any save state not stored here.
    }
  }
  return stored;
}
