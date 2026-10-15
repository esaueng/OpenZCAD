import {
  createSavedRevision,
  withEchoedSavePoints
} from '@openzcad/document-core';
import {
  MAX_CHECKPOINT_REASON_LENGTH,
  type ProjectDocument,
  type ProjectEditLease
} from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';
import { parseServerMessage } from './collaborationProtocol';
import {
  projectsHaveSameCanonicalContent,
  saveLocalSaveStates,
  withMatchingLocalDerived
} from './localProjectStore';

export interface CheckpointOptions {
  isCurrent(): boolean;
  readDocument(): ProjectDocument;
  applyDocument(document: ProjectDocument): void;
}

export interface CheckpointControls {
  controller: AbortController;
  isCurrent(): boolean;
  drain(signal: AbortSignal): Promise<void>;
  lease(): ProjectEditLease | null;
  baseVersion(): number | null;
  clientId: string;
  confirm(saved: ProjectDocument, current: ProjectDocument): void;
}

/** A checkpoint names the clicked model, including its undo/redo history. */
export function sameCheckpointSnapshot(
  left: ProjectDocument,
  right: ProjectDocument
): boolean {
  return (
    left.ownerUserId === right.ownerUserId &&
    projectsHaveSameCanonicalContent(
      { ...left, revisions: [], checkpoints: [] },
      { ...right, revisions: [], checkpoints: [] }
    )
  );
}

export function mergeCheckpointEcho(
  live: ProjectDocument,
  snapshot: ProjectDocument,
  saved: ProjectDocument
): ProjectDocument {
  // A room broadcast may adopt the saved checkpoint before its HTTP ACK.
  // Reuse that complete echo; matching geometry alone can hide newer history.
  if (
    live.version === saved.version &&
    live.ownerUserId === saved.ownerUserId &&
    projectsHaveSameCanonicalContent(live, saved)
  ) {
    return withMatchingLocalDerived(saved, live);
  }
  if (
    live.version === snapshot.version &&
    sameCheckpointSnapshot(live, snapshot)
  ) {
    return withMatchingLocalDerived(saved, live);
  }
  // The server minted a new room version. Buffered edits need a newer one,
  // even when their old local version happens to equal that acknowledgement.
  return {
    ...withEchoedSavePoints(live, saved),
    version: Math.max(live.version, saved.version) + 1
  };
}

function confirmsCheckpoint(
  snapshot: ProjectDocument,
  saved: ProjectDocument,
  reason: string
): boolean {
  const checkpoint = saved.checkpoints?.at(-1);
  const revision = saved.revisions?.at(-1);
  return Boolean(
    sameCheckpointSnapshot(snapshot, saved) &&
    saved.version > snapshot.version &&
    checkpoint &&
    revision &&
    checkpoint.reason === reason &&
    revision.reason === reason &&
    checkpoint.documentVersion === saved.version &&
    checkpoint.revisionId === revision.revisionId &&
    !snapshot.checkpoints.some(
      (previous) => previous.checkpointId === checkpoint.checkpointId
    ) &&
    !snapshot.revisions.some(
      (previous) => previous.revisionId === revision.revisionId
    )
  );
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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

/** Loaded only for an explicit member Save, never for ordinary room edits. */
export async function saveCollaborationCheckpoint(
  snapshot: ProjectDocument,
  reason: string,
  options: CheckpointOptions,
  controls: CheckpointControls
): Promise<ProjectDocument> {
  const normalized = reason.trim() || 'Saved';
  const label =
    normalized.length > MAX_CHECKPOINT_REASON_LENGTH
      ? `${normalized.slice(0, MAX_CHECKPOINT_REASON_LENGTH - 1)}…`
      : normalized;
  let authoritative: ProjectDocument | null = null;
  let confirmed = false;
  const timer = window.setTimeout(
    () =>
      controls.controller.abort(
        new Error('The room did not confirm the named save. Please retry.')
      ),
    15_000
  );
  const checkCurrent = () => {
    controls.controller.signal.throwIfAborted();
    if (!controls.isCurrent() || !options.isCurrent())
      throw new Error('The room changed before the named save completed.');
  };
  try {
    checkCurrent();
    await controls.drain(controls.controller.signal);
    checkCurrent();
    const lease = controls.lease();
    if (
      !lease ||
      lease.projectId !== snapshot.projectId ||
      lease.expiresAt <= Date.now()
    )
      throw new Error('A named save requires the active project edit lease.');
    const response = await abortable(
      desktopFetch(
        `/api/projects/${encodeURIComponent(snapshot.projectId)}/collaboration`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controls.controller.signal,
          body: JSON.stringify({
            clientId: controls.clientId,
            leaseId: lease.leaseId,
            baseVersion: controls.baseVersion(),
            document: snapshot,
            checkpointReason: label
          })
        }
      ),
      controls.controller.signal
    );
    const message = parseServerMessage(
      await abortable(response.text(), controls.controller.signal),
      snapshot.projectId
    );
    if (
      !response.ok ||
      message?.type !== 'ack' ||
      !message.document ||
      message.version !== message.document.version ||
      !confirmsCheckpoint(snapshot, message.document, label)
    ) {
      throw new Error(
        message?.type === 'error'
          ? message.message
          : 'The room did not confirm a durable named revision. Please retry.'
      );
    }
    authoritative = message.document;
    checkCurrent();
    if (controls.lease()?.leaseId !== lease.leaseId)
      throw new Error(
        'The edit lease changed before the named save completed.'
      );
    const current = mergeCheckpointEcho(
      options.readDocument(),
      snapshot,
      authoritative
    );
    options.applyDocument(current);
    controls.confirm(authoritative, current);
    confirmed = true;
    // The server's version and lineage are known even if this device runs out
    // of storage. Record them before yielding, so buffered edits use that base.
    // Persist only the captured save state, never an older project head.
    await saveLocalSaveStates([authoritative]);
    return authoritative;
  } catch (error) {
    const local = authoritative ?? createSavedRevision(snapshot, label);
    let localSaved = false;
    try {
      await saveLocalSaveStates([local]);
      localSaved = true;
      if (!confirmed && controls.isCurrent() && options.isCurrent()) {
        const current = options.readDocument();
        options.applyDocument(withEchoedSavePoints(current, local));
      }
    } catch {
      // Keep the original server/cancellation diagnostic; add the durability
      // failure instead of replacing the primary error.
    }
    const primary =
      error instanceof Error ? error.message : 'The named save failed.';
    throw new Error(
      `${primary} ${confirmed ? 'The revision is stored in the room. ' : ''}${localSaved ? 'The named save is stored on this device.' : 'The named save could not be stored on this device.'}`,
      { cause: error }
    );
  } finally {
    window.clearTimeout(timer);
  }
}
