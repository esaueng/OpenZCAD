import {
  assertStorableDocument,
  createAdvancingSavePoint,
  withEchoedSavePoints
} from '@openzcad/document-core';
import {
  copiedImportArchives,
  reconcileCopiedImportSources
} from '@openzcad/persistence';
import type { ProjectDocument, ProjectEditLease } from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';
import {
  abortableCheckpoint,
  normalizeCheckpointReason,
  parseServerMessage
} from './collaborationProtocol';
import {
  preserveFailedCheckpoint,
  type CheckpointOptions
} from './collaborationCheckpointFallback';
import {
  projectsHaveSameCanonicalContent,
  saveLocalSaveStates,
  withMatchingLocalDerived
} from './localProjectStore';

export type { CheckpointOptions } from './collaborationCheckpointFallback';

export interface CheckpointControls {
  controller: AbortController;
  /** The same room identity; recording a committed echo needs no write lease. */
  isCurrent(): boolean;
  drain(signal: AbortSignal): Promise<ProjectDocument | null>;
  lease(): ProjectEditLease | null;
  baseVersion(): number | null;
  clientId: string;
  observeEcho(listener: (document: ProjectDocument) => void): void;
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

/** Loaded only for an explicit member Save, never for ordinary room edits. */
export async function saveCollaborationCheckpoint(
  snapshot: ProjectDocument,
  reason: string,
  options: CheckpointOptions,
  controls: CheckpointControls
): Promise<ProjectDocument> {
  const label = normalizeCheckpointReason(reason);
  let authoritative: ProjectDocument | null = null;
  let confirmed = false;
  const confirm = (
    saved: ProjectDocument,
    current = mergeCheckpointEcho(options.readDocument(), snapshot, saved)
  ) => {
    options.applyDocument(current);
    controls.confirm(saved, current);
    confirmed = true;
  };
  const checkCurrent = () => {
    controls.controller.signal.throwIfAborted();
    if (!controls.isCurrent() || !options.isCurrent())
      throw new Error('The room changed before the named save completed.');
  };
  try {
    checkCurrent();
    const acknowledged = await controls.drain(controls.controller.signal);
    checkCurrent();
    if (
      acknowledged?.projectId === snapshot.projectId &&
      acknowledged.ownerUserId === snapshot.ownerUserId
    ) {
      // Only the already accepted room ACK supplies trusted source aliases.
      // A new save response cannot authorize substituting arbitrary artifacts.
      const canonical = reconcileCopiedImportSources(
        snapshot,
        copiedImportArchives(acknowledged)
      );
      if (canonical !== snapshot) {
        snapshot = projectsHaveSameCanonicalContent(canonical, acknowledged)
          ? {
              ...canonical,
              version: Math.max(canonical.version, acknowledged.version)
            }
          : canonical;
      }
    }
    const lease = controls.lease();
    if (
      !lease ||
      lease.projectId !== snapshot.projectId ||
      lease.expiresAt <= Date.now()
    )
      throw new Error('A named save requires the active project edit lease.');
    // A committed checkpoint can arrive over the room before its HTTP reply.
    // Keep that exact body even when the user buffers later edits or names.
    controls.observeEcho((echo) => {
      if (
        controls.isCurrent() &&
        options.isCurrent() &&
        controls.lease()?.leaseId === lease.leaseId &&
        confirmsCheckpoint(snapshot, echo, label)
      )
        authoritative = echo;
    });
    // The save point is minted here and the room only checks it (ADR-024
    // Phase 1). Any fresh save point naming the clicked model is accepted,
    // so a room still minting its own — an older Worker — confirms too.
    const submit = async (
      base: ProjectDocument,
      baseVersion: number | null
    ) => {
      const minted = createAdvancingSavePoint(base, label);
      // The room stores it unread (ADR-024 Phase 1): refuse a version other
      // members could not open; the save is then kept on this device.
      assertStorableDocument(minted);
      const savedRevisionId = minted.revisions.at(-1)!.revisionId;
      const response = await abortableCheckpoint(
        desktopFetch(
          `/api/projects/${encodeURIComponent(snapshot.projectId)}/collaboration`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controls.controller.signal,
            body: JSON.stringify({
              clientId: controls.clientId,
              leaseId: lease.leaseId,
              baseVersion,
              document: minted,
              checkpointReason: label,
              savedRevisionId
            })
          }
        ),
        controls.controller.signal
      );
      const message = parseServerMessage(
        await abortableCheckpoint(response.text(), controls.controller.signal),
        snapshot.projectId
      );
      return { response, message };
    };
    let { response, message } = await submit(snapshot, controls.baseVersion());
    if (
      message?.type === 'conflict' &&
      message.document.ownerUserId === snapshot.ownerUserId &&
      sameCheckpointSnapshot(snapshot, message.document)
    ) {
      // The room moved on without changing the clicked model — another
      // member's save point, say. Mint again on its lineage, once.
      checkCurrent();
      ({ response, message } = await submit(
        message.document,
        message.document.version
      ));
    }
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
    confirm(authoritative);
    // The server's version and lineage are known even if this device runs out
    // of storage. Record them before yielding, so buffered edits use that base.
    // Persist only the captured save state, never an older project head.
    await saveLocalSaveStates([authoritative]);
    return authoritative;
  } catch (error) {
    if (
      authoritative &&
      !confirmed &&
      controls.isCurrent() &&
      options.isCurrent()
    ) {
      try {
        // The broadcast proves the room committed this exact named state.
        // Merge its lineage into live edits and fence their next publication.
        const live = options.readDocument();
        const current = mergeCheckpointEcho(live, snapshot, authoritative);
        confirm(
          authoritative,
          live.version > authoritative.version
            ? { ...current, version: live.version }
            : current
        );
      } catch {
        // Keep the primary failure and let local preservation report durability.
      }
    }
    return preserveFailedCheckpoint(
      error,
      snapshot,
      label,
      options,
      controls.isCurrent,
      authoritative,
      confirmed
    );
  }
}
