import {
  createSavedRevision,
  withEchoedSavePoints
} from '@openzcad/document-core';
import {
  MAX_CHECKPOINT_REASON_LENGTH,
  type ProjectDocument
} from '@openzcad/shared';
import { saveLocalSaveStates } from './localProjectStore';

export interface CheckpointOptions {
  isCurrent(): boolean;
  readDocument(): ProjectDocument;
  applyDocument(document: ProjectDocument): void;
}

export function normalizeCheckpointReason(reason: string): string {
  const normalized = reason.trim() || 'Saved';
  return normalized.length > MAX_CHECKPOINT_REASON_LENGTH
    ? `${normalized.slice(0, MAX_CHECKPOINT_REASON_LENGTH - 1)}…`
    : normalized;
}

export function abortableCheckpoint<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abortReason = () => {
      const reason: unknown = signal.reason;
      return reason instanceof Error
        ? reason
        : new Error('The named save was cancelled.', { cause: reason });
    };
    const aborted = () => reject(abortReason());
    if (signal.aborted) {
      reject(abortReason());
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(
          error instanceof Error
            ? error
            : new Error('The named save failed.', { cause: error })
        );
      }
    );
  });
}

/** Keep the clicked named state even when the room action cannot load. */
export async function preserveFailedCheckpoint(
  error: unknown,
  snapshot: ProjectDocument,
  reason: string,
  options: CheckpointOptions,
  isCurrent: () => boolean,
  authoritative: ProjectDocument | null = null,
  confirmed = false
): Promise<never> {
  const local =
    authoritative ??
    createSavedRevision(snapshot, normalizeCheckpointReason(reason));
  let localSaved = false;
  try {
    // Save only the captured state, never an older project head.
    await saveLocalSaveStates([local]);
    localSaved = true;
    if (!confirmed && isCurrent() && options.isCurrent()) {
      const current = options.readDocument();
      options.applyDocument(withEchoedSavePoints(current, local));
    }
  } catch {
    // Preserve the primary failure while reporting device durability honestly.
  }
  const primary =
    error instanceof Error ? error.message : 'The named save failed.';
  throw new Error(
    `${primary} ${confirmed ? 'The revision is stored in the room. ' : ''}${localSaved ? 'The named save is stored on this device.' : 'The named save could not be stored on this device.'}`,
    { cause: error }
  );
}
