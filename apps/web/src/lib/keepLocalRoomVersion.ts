import {
  assertStorableDocument,
  createSavedRevision
} from '@openzcad/document-core';
import {
  KEPT_LOCAL_VERSION_REASON,
  type ProjectAccessRole,
  type ProjectDocument,
  type ProjectEditLease
} from '@openzcad/shared';
import {
  clearUnresolvedConflict,
  conflictFromDocuments,
  type ProjectConflict
} from './conflictRecovery';
import { desktopFetch } from './desktopBridge';
import { projectPreservesLocalWork } from './localProjectStore';
import {
  collaborationDocument,
  parseServerMessage,
  rejectionStatus
} from './collaborationProtocol';
import type { CollaborationStatus } from './useCollaboration';

type Ref<T> = { current: T };
interface KeepLocalControls {
  projectId: string | null;
  snapshot: {
    pending: ProjectConflict | null;
    activeLease: ProjectEditLease | null;
    socket: WebSocket | null;
    current: ProjectDocument | null;
    roomEpoch: number;
  };
  roomEpochRef: Ref<number>;
  socketRef: Ref<WebSocket | null>;
  documentRef: Ref<ProjectDocument | null>;
  roleRef: Ref<ProjectAccessRole | null>;
  leaseIdRef: Ref<string | null>;
  serverVersionRef: Ref<number | null>;
  baseVersionRef: Ref<number | null>;
  lastSentVersionRef: Ref<number | null>;
  keepMinePendingRef: Ref<boolean>;
  keepMineAckRef: Ref<{
    document: ProjectDocument;
    timer: number;
    resolve(): void;
    reject(error: Error): void;
  } | null>;
  conflictRef: Ref<ProjectConflict | null>;
  conflictHandlerRef: Ref<(document: ProjectDocument) => void>;
  remoteHandlerRef: Ref<
    (document: ProjectDocument, context?: { adopted?: boolean }) => void
  >;
  setConflict(conflict: ProjectConflict | null): void;
  setRoomVersion(version: number): void;
  setStatus(status: CollaborationStatus): void;
  settleKeepMine(error?: Error): void;
  reconcileMatchingRoomDocument(document: ProjectDocument): boolean;
  clientId(): string;
  /**
   * An encrypted room (ADR-024 slice 4-9): the kept document sealed on the
   * room version it replaces, as the frame to send.
   */
  sealKept?(
    kept: ProjectDocument,
    baseVersion: number,
    leaseId: string
  ): Promise<string>;
}

const MAX_MESSAGE_BYTES = 900_000;
const KEEP_MINE_ACK_TIMEOUT_MS = 15_000;
const ROOM_CHANGED_MESSAGE = 'The room changed.';

/** The explicit recovery transaction is loaded only when the user chooses it. */
export async function keepLocalRoomVersion(
  expectedRemoteVersion: number,
  controls: KeepLocalControls
): Promise<void> {
  const {
    projectId,
    snapshot,
    roomEpochRef,
    socketRef,
    documentRef,
    roleRef,
    leaseIdRef,
    serverVersionRef,
    baseVersionRef,
    lastSentVersionRef,
    keepMinePendingRef,
    keepMineAckRef,
    conflictRef,
    conflictHandlerRef,
    remoteHandlerRef,
    setConflict,
    setRoomVersion,
    setStatus,
    settleKeepMine,
    reconcileMatchingRoomDocument,
    clientId
  } = controls;

  if (keepMinePendingRef.current) {
    throw new Error('Keep my version is already waiting for confirmation.');
  }
  const { pending, activeLease, socket, current, roomEpoch } = snapshot;
  const isCurrentRoom = () =>
    roomEpochRef.current === roomEpoch &&
    socketRef.current === socket &&
    documentRef.current?.projectId === projectId;
  if (!isCurrentRoom()) throw new Error('The room changed.');
  if (
    !pending ||
    !current ||
    pending.projectId !== projectId ||
    pending.expectedRemoteVersion !== expectedRemoteVersion ||
    serverVersionRef.current !== expectedRemoteVersion
  ) {
    throw new Error(
      'The room version changed before Keep my version was submitted.'
    );
  }
  if (roleRef.current === 'viewer') {
    throw new Error('Viewers cannot keep a local version.');
  }
  if (
    !activeLease ||
    activeLease.projectId !== projectId ||
    activeLease.leaseId !== leaseIdRef.current ||
    activeLease.expiresAt <= Date.now()
  ) {
    throw new Error('Keep my version requires an active project edit lease.');
  }
  // The kept copy is a new committed choice, so it gets its own save revision
  // and a version past the room's. The browser mints both and the room only
  // checks them (ADR-024 Phase 1).
  const minted = createSavedRevision(
    {
      ...collaborationDocument(current),
      version: Math.max(expectedRemoteVersion, current.version) + 1
    },
    KEPT_LOCAL_VERSION_REASON
  );
  // The room stores it unread (ADR-024 Phase 1): never publish a version
  // other members could not open, and send it as the checks normalized it.
  // A refusal leaves the conflict for the user.
  const kept = assertStorableDocument(minted);
  const body = {
    type: 'document' as const,
    clientId: clientId(),
    baseVersion: expectedRemoteVersion,
    document: kept,
    leaseId: activeLease.leaseId,
    conflictResolution: 'keep-local' as const,
    savedRevisionId: kept.revisions.at(-1)!.revisionId
  };
  const payload = controls.sealKept
    ? await controls.sealKept(kept, expectedRemoteVersion, activeLease.leaseId)
    : JSON.stringify(body);
  if (!isCurrentRoom()) throw new Error(ROOM_CHANGED_MESSAGE);
  if (
    controls.sealKept &&
    new TextEncoder().encode(payload).byteLength > MAX_MESSAGE_BYTES
  ) {
    throw new Error(
      'This version is too large for the encrypted room. Save it to your account instead.'
    );
  }
  keepMinePendingRef.current = true;
  lastSentVersionRef.current = current.version;
  setStatus('connecting');

  if (new TextEncoder().encode(payload).byteLength <= MAX_MESSAGE_BYTES) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      keepMinePendingRef.current = false;
      setStatus('conflict');
      throw new Error('The collaboration room is offline.');
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          settleKeepMine(
            new Error('The room did not confirm Keep my version. Please retry.')
          );
          // Reconnect before retrying, so a late ack cannot acknowledge
          // a different submission on the same socket.
          socket.close();
        }, KEEP_MINE_ACK_TIMEOUT_MS);
        keepMineAckRef.current = {
          document: current,
          timer,
          resolve,
          reject
        };
        socket.send(payload);
      });
    } catch (error) {
      if (isCurrentRoom()) {
        settleKeepMine(
          error instanceof Error
            ? error
            : new Error('Could not submit Keep my version.')
        );
        setStatus('conflict');
      }
      throw error;
    }
    return;
  }

  try {
    const response = await desktopFetch(
      `/api/projects/${encodeURIComponent(projectId)}/collaboration`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId: body.clientId,
          baseVersion: body.baseVersion,
          document: body.document,
          leaseId: body.leaseId,
          conflictResolution: body.conflictResolution,
          savedRevisionId: body.savedRevisionId
        })
      }
    );
    const message = parseServerMessage(await response.text(), projectId);
    // The room can change while either the request or its body is read.
    if (!isCurrentRoom() || !documentRef.current) {
      throw new Error(ROOM_CHANGED_MESSAGE);
    }
    if (!message) {
      throw new Error('The room returned an unreadable response.');
    }
    if (message.type === 'conflict') {
      if (reconcileMatchingRoomDocument(message.document)) return;
      serverVersionRef.current = message.document.version;
      setRoomVersion(message.document.version);
      let next: ProjectConflict;
      try {
        next = conflictFromDocuments(current, message.document);
      } catch {
        throw new Error('The room answered for a different project.');
      }
      conflictRef.current = next;
      setConflict(next);
      conflictHandlerRef.current(message.document);
      throw new Error('The room changed before Keep my version completed.');
    }
    const rejected = rejectionStatus(message);
    if (!response.ok || rejected || message.type !== 'ack') {
      throw new Error(
        rejected
          ? message.type === 'error'
            ? message.message
            : 'The room rejected Keep my version.'
          : 'The room did not acknowledge Keep my version.'
      );
    }
    const latest = documentRef.current;
    serverVersionRef.current = message.version;
    setRoomVersion(message.version);
    if (message.document && !projectPreservesLocalWork(latest, current)) {
      const next = conflictFromDocuments(latest, message.document);
      conflictRef.current = next;
      setConflict(next);
      conflictHandlerRef.current(message.document);
      throw new Error(
        'Newer local edits still need reconciliation. Please retry.'
      );
    }
    baseVersionRef.current = message.version;
    clearUnresolvedConflict(projectId, 'room');
    conflictRef.current = null;
    setConflict(null);
    setStatus('live');
    if (message.document) {
      documentRef.current = message.document;
      remoteHandlerRef.current(message.document, { adopted: true });
    }
  } catch (error) {
    if (isCurrentRoom()) setStatus('conflict');
    throw error;
  } finally {
    if (isCurrentRoom()) keepMinePendingRef.current = false;
  }
}
