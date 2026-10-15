import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  type AuthSession,
  type CollaborationMember,
  type CollaborationServerMessage,
  type ProjectAccessRole,
  type ProjectDocument,
  type ProjectEditLease
} from '@openzcad/shared';
import {
  clearUnresolvedConflict,
  conflictFromDocuments,
  readUnresolvedConflict,
  type ProjectConflict
} from './conflictRecovery';
import {
  desktopCollaborationUrl,
  desktopFetch,
  isDesktopApp
} from './desktopBridge';
import { cloudFunctionsAreEnabled } from './cloudMode';
import {
  chooseProjectDocument,
  projectPreservesLocalWork,
  projectsHaveSameCanonicalContent
} from './localProjectStore';
import {
  preserveFailedCheckpoint,
  type CheckpointOptions
} from './collaborationCheckpointFallback';
import {
  abortableCheckpoint,
  startCheckpointDeadline,
  collaborationDocument,
  parseServerMessage,
  rejectionStatus
} from './collaborationProtocol';
export { parseServerMessage } from './collaborationProtocol';

export type CollaborationStatus =
  | 'connecting'
  | 'live'
  | 'offline'
  | 'conflict'
  | 'oversize'
  /** The room refused this document outright; local edits are unaffected. */
  | 'rejected'
  | 'read-only'
  | 'lease-denied'
  | 'update-required';

interface CollaborationOptions {
  enabled: boolean;
  document: ProjectDocument | null;
  session: AuthSession | null;
  /**
   * `adopted` marks an explicit user decision ("Use room version") rather than
   * an unsolicited broadcast — the handler must apply it even when the room
   * document's version is not ahead of the local one.
   */
  onRemoteDocument(
    document: ProjectDocument,
    context?: { adopted?: boolean }
  ): void;
  onConflict(document: ProjectDocument): void;
}

export interface CollaborationClientState {
  status: CollaborationStatus;
  members: CollaborationMember[];
  role: ProjectAccessRole | null;
  /** The lease held by this browser client, never another member's lease. */
  lease: ProjectEditLease | null;
  roomVersion: number | null;
  conflict: ProjectConflict | null;
  useRemoteVersion(expectedRemoteVersion: number): boolean;
  keepLocalVersion(expectedRemoteVersion: number): Promise<void>;
  saveCheckpoint(
    snapshot: ProjectDocument,
    reason: string,
    options: CheckpointOptions
  ): Promise<ProjectDocument>;
}

const MAX_MESSAGE_BYTES = 900_000;
const ROOM_CHANGED_MESSAGE = 'The room changed.';
function clientId(): string {
  const key = 'openzcad-collaboration-client';
  const existing = sessionStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

export function useCollaboration({
  enabled,
  document,
  session,
  onRemoteDocument,
  onConflict
}: CollaborationOptions): CollaborationClientState {
  // The status is stamped with the project it describes. The connect effect
  // runs after the workspace has painted, so a bare status would show the
  // previous project's (or the launcher's) "Offline" for the opening frame
  // and flip to "Connecting" one commit later; deriving the first frame here
  // keeps the chip from announcing a state the room was never in.
  const [statusEntry, setStatusEntry] = useState<{
    projectId: string | null;
    wanted: boolean;
    status: CollaborationStatus;
  }>({ projectId: null, wanted: false, status: 'offline' });
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [role, setRole] = useState<ProjectAccessRole | null>(null);
  const [lease, setLease] = useState<ProjectEditLease | null>(null);
  const [roomVersion, setRoomVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<ProjectConflict | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const documentRef = useRef(document);
  const remoteHandlerRef = useRef(onRemoteDocument);
  const conflictHandlerRef = useRef(onConflict);
  const lastSentVersionRef = useRef<number | null>(null);
  const serverVersionRef = useRef<number | null>(null);
  /**
   * The room version this client's document actually descends from — the merge
   * base, which is not the same thing as the newest room version this client
   * has *seen*. An editor that is shown a broadcast it refuses to adopt (its
   * own unsent work would be lost) still learns that version exists; submitting
   * against it claims an ancestry the document does not have, and the room then
   * accepts it on version ordering alone and drops whatever was committed in
   * between. Advanced only where the local document genuinely becomes, or is
   * confirmed as, that version.
   */
  const baseVersionRef = useRef<number | null>(null);
  const roleRef = useRef<ProjectAccessRole | null>(null);
  const leaseIdRef = useRef<string | null>(null);
  const leaseRef = useRef<ProjectEditLease | null>(null);
  const conflictRef = useRef<ProjectConflict | null>(null);
  const keepMinePendingRef = useRef(false);
  // A project can be left and reopened, or rejoined by another account. Its
  // ID alone cannot identify the room that owns an asynchronous confirmation.
  const roomEpochRef = useRef(0);
  const keepMineAckRef = useRef<{
    document: ProjectDocument;
    timer: number;
    resolve(): void;
    reject(error: Error): void;
  } | null>(null);
  const sendCurrentDocumentRef = useRef<(() => void) | null>(null);
  const checkpointRef = useRef<AbortController | null>(null);
  const checkpointEchoRef = useRef<
    ((document: ProjectDocument) => void) | null
  >(null);
  const checkpointAckRef = useRef<((document: ProjectDocument) => void) | null>(
    null
  );
  const checkpointDrainRef = useRef<{
    resolve(): void;
    reject(error: Error): void;
  } | null>(null);
  const drainDocumentRef = useRef<
    ((signal: AbortSignal) => Promise<ProjectDocument | null>) | null
  >(null);
  documentRef.current = document;
  remoteHandlerRef.current = onRemoteDocument;
  conflictHandlerRef.current = onConflict;

  const projectId = document?.projectId ?? null;
  const userId = session?.userId ?? null;
  const displayName = session?.displayName ?? null;
  // Invalidate the committed room identity before passive socket cleanup.
  // A pending HTTP continuation must not act for the previous account or
  // enabled state while the old socket is still referenced.
  useLayoutEffect(() => {
    roomEpochRef.current += 1;
    checkpointRef.current?.abort(new Error(ROOM_CHANGED_MESSAGE));
    return () => {
      roomEpochRef.current += 1;
      checkpointRef.current?.abort(new Error(ROOM_CHANGED_MESSAGE));
    };
  }, [displayName, enabled, projectId, userId]);
  const roomWanted = Boolean(enabled && projectId && userId && displayName);
  const stampRef = useRef({ projectId, wanted: roomWanted });
  stampRef.current = { projectId, wanted: roomWanted };
  const setStatus = useCallback((next: CollaborationStatus) => {
    setStatusEntry({ ...stampRef.current, status: next });
  }, []);
  const status: CollaborationStatus =
    roomWanted && (statusEntry.projectId !== projectId || !statusEntry.wanted)
      ? 'connecting'
      : statusEntry.status;

  const settleKeepMine = useCallback((error?: Error) => {
    const pending = keepMineAckRef.current;
    keepMineAckRef.current = null;
    keepMinePendingRef.current = false;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }, []);

  const settleCheckpointDrain = useCallback((error?: Error) => {
    const pending = checkpointDrainRef.current;
    checkpointDrainRef.current = null;
    if (error) pending?.reject(error);
    else pending?.resolve();
  }, []);

  const reconcileMatchingRoomDocument = useCallback(
    (remote: ProjectDocument): boolean => {
      const local = documentRef.current;
      if (
        !local ||
        local.projectId !== remote.projectId ||
        remote.schemaVersion > PROJECT_DOCUMENT_SCHEMA_VERSION ||
        !projectPreservesLocalWork(local, remote)
      ) {
        return false;
      }
      // Matching geometry alone is insufficient: distinct checkpoints/history
      // are user work too. The remote must retain every local history entry.
      clearUnresolvedConflict(local.projectId, 'room');
      conflictRef.current = null;
      setConflict(null);
      settleKeepMine();
      lastSentVersionRef.current = remote.version;
      baseVersionRef.current = remote.version;
      serverVersionRef.current = remote.version;
      setRoomVersion(remote.version);
      documentRef.current = remote;
      remoteHandlerRef.current(remote, { adopted: true });
      setStatus(
        roleRef.current === 'viewer'
          ? 'read-only'
          : leaseRef.current
            ? 'live'
            : 'lease-denied'
      );
      return true;
    },
    [setStatus, settleKeepMine]
  );

  useEffect(() => {
    roomEpochRef.current += 1;
    if (!enabled || !projectId || !userId || !displayName) {
      setStatus('offline');
      setMembers([]);
      setRole(null);
      setLease(null);
      setRoomVersion(null);
      conflictRef.current = null;
      setConflict(null);
      return;
    }
    conflictRef.current = null;
    setConflict(null);
    roleRef.current = null;
    setRole(null);
    leaseIdRef.current = null;
    leaseRef.current = null;
    setLease(null);
    serverVersionRef.current = null;
    baseVersionRef.current = null;
    setRoomVersion(null);
    keepMinePendingRef.current = false;
    let disposed = false;
    const roomEpoch = roomEpochRef.current;
    const isCurrentRoom = () => !disposed && roomEpochRef.current === roomEpoch;
    let reconnectTimer: number | undefined;
    let leaseRetryTimer: number | undefined;
    let reconnectAttempt = 0;
    let pendingDocument: ProjectDocument | null = null;
    let acknowledgedDocument: ProjectDocument | null = null;
    drainDocumentRef.current = (signal) => {
      signal.throwIfAborted();
      if (!pendingDocument) return Promise.resolve(acknowledgedDocument);
      return new Promise<void>((resolve, reject) => {
        const pending = { resolve, reject };
        checkpointDrainRef.current = pending;
        signal.addEventListener(
          'abort',
          () => {
            if (checkpointDrainRef.current === pending)
              settleCheckpointDrain(
                new Error('The room did not confirm the pending edit.')
              );
          },
          { once: true }
        );
      }).then(() => acknowledgedDocument);
    };
    const id = clientId();

    const retainConflict = (
      roomDocument: ProjectDocument,
      force = false
    ): boolean => {
      const localDocument = documentRef.current;
      const marker = readUnresolvedConflict(projectId, 'room');
      if (!localDocument || (!force && !marker && !conflictRef.current)) {
        return false;
      }
      if (reconcileMatchingRoomDocument(roomDocument)) {
        return true;
      }
      let pending: ProjectConflict;
      try {
        pending = conflictFromDocuments(localDocument, roomDocument);
      } catch {
        // The local document changed projects before this frame arrived.
        return false;
      }
      conflictRef.current = pending;
      setConflict(pending);
      setStatus('conflict');
      conflictHandlerRef.current(roomDocument);
      return true;
    };

    // A collaborator on a newer app version may share a document whose schema
    // this client cannot faithfully edit. Refuse it rather than silently
    // stripping fields the normalizer does not know about.
    const rejectsNewerSchema = (incoming: ProjectDocument): boolean => {
      if ((incoming.schemaVersion ?? 0) <= PROJECT_DOCUMENT_SCHEMA_VERSION) {
        return false;
      }
      setStatus('update-required');
      return true;
    };

    const acknowledge = (
      message: Extract<CollaborationServerMessage, { type: 'ack' }>
    ) => {
      const submitted = keepMineAckRef.current?.document ?? pendingDocument;
      pendingDocument = null;
      const local = documentRef.current;
      serverVersionRef.current = message.version;
      setRoomVersion(message.version);
      // A merge acknowledges the submitted snapshot, not edits made while it
      // was in flight. Preserve those newer edits for explicit reconciliation.
      if (
        message.document &&
        local &&
        !projectPreservesLocalWork(local, submitted ?? message.document)
      ) {
        retainConflict(message.document, true);
        settleKeepMine(
          new Error(
            'Newer local edits still need reconciliation. Please retry.'
          )
        );
        settleCheckpointDrain(
          new Error('Newer local edits need reconciliation.')
        );
        return;
      }
      lastSentVersionRef.current = message.version;
      baseVersionRef.current = message.version;
      if (message.document) acknowledgedDocument = message.document;
      settleCheckpointDrain();
      if (keepMinePendingRef.current) {
        settleKeepMine();
        clearUnresolvedConflict(projectId, 'room');
        conflictRef.current = null;
        setConflict(null);
      }
      if (conflictRef.current) return;
      setStatus('live');
      if (message.document) {
        documentRef.current = message.document;
        if (checkpointAckRef.current)
          checkpointAckRef.current(message.document);
        else remoteHandlerRef.current(message.document, { adopted: true });
      }
      sendCurrentDocumentRef.current?.();
    };

    const sendDocument = (
      socket: WebSocket,
      type: 'hello' | 'document'
    ): boolean => {
      const current = documentRef.current;
      if (!isCurrentRoom() || !current || current.projectId !== projectId) {
        return false;
      }
      const payload = JSON.stringify({
        type,
        clientId: id,
        displayName,
        baseVersion: baseVersionRef.current,
        document: type === 'hello' ? null : collaborationDocument(current),
        ...(leaseIdRef.current ? { leaseId: leaseIdRef.current } : {})
      });
      if (type === 'hello') {
        socket.send(payload);
        return true;
      }
      if (
        checkpointRef.current ||
        conflictRef.current ||
        readUnresolvedConflict(projectId, 'room') ||
        roleRef.current === 'viewer' ||
        !leaseIdRef.current ||
        pendingDocument ||
        (lastSentVersionRef.current === current.version &&
          baseVersionRef.current === current.version)
      ) {
        return false;
      }
      pendingDocument = current;
      lastSentVersionRef.current = current.version;
      if (new TextEncoder().encode(payload).byteLength > MAX_MESSAGE_BYTES) {
        setStatus('oversize');
        void desktopFetch(
          `/api/projects/${encodeURIComponent(projectId)}/collaboration`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              clientId: id,
              baseVersion: baseVersionRef.current,
              document: collaborationDocument(current),
              leaseId: leaseIdRef.current
            })
          }
        )
          .then(async (response) => {
            if (!isCurrentRoom() || socketRef.current !== socket) return;
            const message = parseServerMessage(
              await response.text(),
              projectId
            );
            if (!isCurrentRoom() || socketRef.current !== socket) return;
            if (!message) {
              pendingDocument = null;
              settleCheckpointDrain(
                new Error(
                  'The room returned an unreadable response for the pending edit.'
                )
              );
              console.error('Collaboration returned an unreadable response.');
              return;
            }
            if (message.type === 'ack' && response.ok) {
              acknowledge(message);
              return;
            }
            pendingDocument = null;
            settleCheckpointDrain(
              new Error(
                message.type === 'error'
                  ? message.message
                  : message.type === 'conflict'
                    ? 'The pending edit conflicts with a newer room document.'
                    : 'The room did not confirm the pending edit.'
              )
            );
            const rejected = rejectionStatus(message);
            if (rejected) {
              setStatus(rejected);
              return;
            }
            if (message.type === 'conflict') {
              serverVersionRef.current = message.document.version;
              setRoomVersion(message.document.version);
              retainConflict(message.document, true);
            }
          })
          .catch((error: unknown) => {
            if (!isCurrentRoom() || socketRef.current !== socket) return;
            pendingDocument = null;
            settleCheckpointDrain(
              error instanceof Error
                ? error
                : new Error('The room could not confirm the pending edit.')
            );
            setStatus('offline');
          });
        return false;
      }
      socket.send(payload);
      lastSentVersionRef.current = current.version;
      return true;
    };

    sendCurrentDocumentRef.current = () => {
      const socket = socketRef.current;
      if (isCurrentRoom() && socket?.readyState === WebSocket.OPEN) {
        sendDocument(socket, 'document');
      }
    };

    const scheduleReconnect = () => {
      if (!isCurrentRoom()) {
        return;
      }
      setStatus('offline');
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(
        connect,
        Math.min(10_000, 750 * 2 ** reconnectAttempt)
      );
    };

    const connectToUrl = (url: string | URL) => {
      if (!isCurrentRoom()) {
        return;
      }
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        if (!isCurrentRoom() || socketRef.current !== socket) return;
        reconnectAttempt = 0;
        pendingDocument = null;
        lastSentVersionRef.current = null;
        leaseIdRef.current = null;
        leaseRef.current = null;
        setLease(null);
        roleRef.current = null;
        setRole(null);
        sendDocument(socket, 'hello');
      });
      socket.addEventListener('message', (event) => {
        if (
          !isCurrentRoom() ||
          socketRef.current !== socket ||
          typeof event.data !== 'string'
        ) {
          return;
        }
        const message = parseServerMessage(event.data, projectId);
        if (!message) {
          return;
        }
        if (message.type === 'presence') {
          setMembers(message.members);
          return;
        }
        if (message.type === 'state') {
          setMembers(message.members);
          roleRef.current = message.role;
          setRole(message.role);
          if (message.role === 'viewer') {
            leaseIdRef.current = null;
            leaseRef.current = null;
            setLease(null);
            if (!readUnresolvedConflict(projectId, 'room')) {
              setStatus('read-only');
            }
          }
          if (message.document) {
            if (rejectsNewerSchema(message.document)) {
              return;
            }
            serverVersionRef.current = message.document.version;
            setRoomVersion(message.document.version);
            // Establish the merge base before requesting a lease. Otherwise an
            // unchanged observer looks like unsent work on every broadcast.
            // Content/lineage proves adoption safe; a genuinely divergent
            // offline edit still waits for the room's fenced submission.
            const retained = retainConflict(message.document);
            const local = documentRef.current;
            const canAdopt =
              message.role === 'viewer' ||
              chooseProjectDocument(local, message.document).choice ===
                'remote';
            if (canAdopt && !retained) {
              lastSentVersionRef.current = message.document.version;
              baseVersionRef.current = message.document.version;
              documentRef.current = message.document;
              if (
                message.role === 'viewer' ||
                !local ||
                local.version !== message.document.version ||
                !projectsHaveSameCanonicalContent(local, message.document)
              ) {
                if (message.role === 'viewer') {
                  remoteHandlerRef.current(message.document);
                } else {
                  remoteHandlerRef.current(message.document, { adopted: true });
                }
              }
            }
          }
          if (
            message.role !== 'viewer' &&
            socket.readyState === WebSocket.OPEN
          ) {
            socket.send(
              JSON.stringify({ type: 'lease-acquire', clientId: id })
            );
          }
          return;
        }
        if (message.type === 'lease-granted') {
          if (leaseRetryTimer !== undefined) {
            window.clearTimeout(leaseRetryTimer);
            leaseRetryTimer = undefined;
          }
          leaseIdRef.current = message.lease.leaseId;
          leaseRef.current = message.lease;
          setLease(message.lease);
          if (
            conflictRef.current ||
            readUnresolvedConflict(projectId, 'room')
          ) {
            setStatus('conflict');
          } else {
            setStatus('live');
            sendDocument(socket, 'document');
          }
          return;
        }
        if (message.type === 'lease-denied') {
          leaseIdRef.current = null;
          leaseRef.current = null;
          setLease(null);
          setStatus(
            conflictRef.current || readUnresolvedConflict(projectId, 'room')
              ? 'conflict'
              : message.reason === 'read-only'
                ? 'read-only'
                : 'lease-denied'
          );
          if (message.reason === 'held' && message.expiresAt) {
            if (leaseRetryTimer !== undefined) {
              window.clearTimeout(leaseRetryTimer);
            }
            leaseRetryTimer = window.setTimeout(
              () => {
                if (isCurrentRoom() && socket.readyState === WebSocket.OPEN) {
                  socket.send(
                    JSON.stringify({ type: 'lease-acquire', clientId: id })
                  );
                }
              },
              Math.max(250, message.expiresAt - Date.now() + 50)
            );
          }
          return;
        }
        if (message.type === 'lease-lost') {
          settleCheckpointDrain(new Error('The edit lease was lost.'));
          checkpointRef.current?.abort(new Error('The edit lease was lost.'));
          settleKeepMine(
            new Error(
              'The edit lease was lost. Please retry after it is renewed.'
            )
          );
          leaseIdRef.current = null;
          leaseRef.current = null;
          setLease(null);
          if (message.reason === 'role-changed') {
            roleRef.current = 'viewer';
            setRole('viewer');
            setStatus(
              conflictRef.current || readUnresolvedConflict(projectId, 'room')
                ? 'conflict'
                : 'read-only'
            );
          } else if (
            roleRef.current !== 'viewer' &&
            socket.readyState === WebSocket.OPEN
          ) {
            setStatus('connecting');
            socket.send(
              JSON.stringify({ type: 'lease-acquire', clientId: id })
            );
          }
          return;
        }
        if (message.type === 'document') {
          if (rejectsNewerSchema(message.document)) {
            return;
          }
          const local = documentRef.current;
          serverVersionRef.current = message.document.version;
          setRoomVersion(message.document.version);
          // Even equal version numbers can be independent edits. Keep the
          // original merge base until the room acknowledges our submission.
          const hasLocalEdits =
            local &&
            local.projectId === projectId &&
            local.version !== baseVersionRef.current &&
            !projectPreservesLocalWork(local, message.document);
          if (hasLocalEdits) {
            if (
              leaseRef.current &&
              leaseRef.current.expiresAt > Date.now() &&
              baseVersionRef.current !== null &&
              !conflictRef.current &&
              roleRef.current !== 'viewer'
            ) {
              sendDocument(socket, 'document');
            } else {
              retainConflict(message.document, true);
            }
            return;
          }
          lastSentVersionRef.current = message.document.version;
          if (!retainConflict(message.document)) {
            // Keeps a second broadcast arriving before the adoption has been
            // rendered from reading this client as divergent.
            documentRef.current = message.document;
            baseVersionRef.current = message.document.version;
            if (message.clientId === id)
              checkpointEchoRef.current?.(message.document);
            remoteHandlerRef.current(message.document);
          }
          return;
        }
        if (message.type === 'ack') {
          acknowledge(message);
          return;
        }
        if (message.type === 'conflict') {
          settleCheckpointDrain(
            new Error('The room changed before the named save.')
          );
          pendingDocument = null;
          if (rejectsNewerSchema(message.document)) {
            settleKeepMine(
              new Error('Update the app before resolving this room version.')
            );
            return;
          }
          serverVersionRef.current = message.document.version;
          setRoomVersion(message.document.version);
          setStatus('conflict');
          retainConflict(message.document, true);
          if (conflictRef.current) {
            settleKeepMine(
              new Error(
                'The room changed before Keep my version completed. Please retry.'
              )
            );
          }
          return;
        }
        const rejected = rejectionStatus(message);
        if (rejected) {
          settleCheckpointDrain(
            new Error(
              message.type === 'error'
                ? message.message
                : 'The room rejected the edit.'
            )
          );
          settleKeepMine(
            new Error(
              message.type === 'error'
                ? message.message
                : 'The room rejected Keep my version.'
            )
          );
          pendingDocument = null;
          setStatus(rejected);
        }
      });
      socket.addEventListener('close', () => {
        if (!isCurrentRoom()) return;
        if (socketRef.current === socket) {
          settleCheckpointDrain(
            new Error('The room disconnected before confirmation.')
          );
          checkpointRef.current?.abort(
            new Error('The room disconnected before confirmation.')
          );
          settleKeepMine(
            new Error(
              'The collaboration room disconnected before confirmation. Please retry.'
            )
          );
          socketRef.current = null;
        }
        scheduleReconnect();
      });
      socket.addEventListener('error', () => socket.close());
    };

    function connect() {
      if (!isCurrentRoom()) {
        return;
      }
      setStatus('connecting');
      if (isDesktopApp()) {
        void desktopCollaborationUrl(projectId!)
          .then(connectToUrl)
          .catch(scheduleReconnect);
        return;
      }
      const url = new URL(
        `/api/projects/${encodeURIComponent(projectId!)}/collaboration`,
        window.location.href
      );
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      connectToUrl(url);
    }

    connect();
    const leaseRenewTimer = window.setInterval(() => {
      const socket = socketRef.current;
      const leaseId = leaseIdRef.current;
      if (isCurrentRoom() && socket?.readyState === WebSocket.OPEN && leaseId) {
        socket.send(
          JSON.stringify({
            type: 'lease-renew',
            clientId: id,
            leaseId
          })
        );
      }
    }, 10_000);
    return () => {
      disposed = true;
      roomEpochRef.current += 1;
      settleKeepMine(new Error(ROOM_CHANGED_MESSAGE));
      settleCheckpointDrain(new Error(ROOM_CHANGED_MESSAGE));
      drainDocumentRef.current = null;
      sendCurrentDocumentRef.current = null;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      if (leaseRetryTimer !== undefined) {
        window.clearTimeout(leaseRetryTimer);
      }
      window.clearInterval(leaseRenewTimer);
      if (
        cloudFunctionsAreEnabled() &&
        socketRef.current?.readyState === WebSocket.OPEN &&
        leaseIdRef.current
      ) {
        socketRef.current.send(
          JSON.stringify({
            type: 'lease-release',
            clientId: id,
            leaseId: leaseIdRef.current
          })
        );
      }
      socketRef.current?.close(1000, 'Project changed.');
      socketRef.current = null;
      leaseIdRef.current = null;
      leaseRef.current = null;
      roleRef.current = null;
      setLease(null);
      setRole(null);
      setMembers([]);
    };
  }, [
    displayName,
    enabled,
    projectId,
    userId,
    reconcileMatchingRoomDocument,
    settleCheckpointDrain,
    setStatus,
    settleKeepMine
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !document ||
      conflictRef.current ||
      readUnresolvedConflict(document.projectId, 'room') ||
      lastSentVersionRef.current === document.version
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      sendCurrentDocumentRef.current?.();
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [
    document?.projectId,
    document?.version,
    enabled,
    reconcileMatchingRoomDocument
  ]);

  const useRemoteVersion = useCallback(
    (expectedRemoteVersion: number): boolean => {
      const pending = conflictRef.current;
      if (
        !pending ||
        pending.projectId !== projectId ||
        pending.expectedRemoteVersion !== expectedRemoteVersion ||
        serverVersionRef.current !== expectedRemoteVersion
      ) {
        return false;
      }
      const roomDocument = structuredClone(pending.remoteDocument);
      clearUnresolvedConflict(pending.projectId, 'room');
      conflictRef.current = null;
      setConflict(null);
      keepMinePendingRef.current = false;
      lastSentVersionRef.current = roomDocument.version;
      baseVersionRef.current = roomDocument.version;
      documentRef.current = roomDocument;
      remoteHandlerRef.current(roomDocument, { adopted: true });
      setStatus(roleRef.current === 'viewer' ? 'read-only' : 'live');
      return true;
    },
    [projectId, setStatus]
  );

  const keepLocalVersion = useCallback(
    (expectedRemoteVersion: number): Promise<void> => {
      const snapshot = {
        pending: conflictRef.current,
        activeLease: leaseRef.current,
        socket: socketRef.current,
        current: documentRef.current,
        roomEpoch: roomEpochRef.current
      };
      return import('./keepLocalRoomVersion').then(({ keepLocalRoomVersion }) =>
        keepLocalRoomVersion(expectedRemoteVersion, {
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
        })
      );
    },
    [projectId, reconcileMatchingRoomDocument, setStatus, settleKeepMine]
  );

  const saveCheckpoint = useCallback(
    (
      snapshot: ProjectDocument,
      reason: string,
      options: CheckpointOptions
    ): Promise<ProjectDocument> => {
      if (checkpointRef.current || keepMinePendingRef.current)
        return Promise.reject(new Error('Another room save is still pending.'));
      if (roleRef.current === 'viewer' || conflictRef.current)
        return Promise.reject(
          new Error('This project cannot save a room revision.')
        );
      const controller = new AbortController();
      const epoch = roomEpochRef.current;
      const socket = socketRef.current;
      // Reserve the outgoing barrier before the dynamic import or ACK drain.
      checkpointRef.current = controller;
      checkpointEchoRef.current = null;
      const isCurrent = () =>
        roomEpochRef.current === epoch &&
        socketRef.current === socket &&
        documentRef.current?.projectId === snapshot.projectId &&
        roleRef.current !== 'viewer';
      // Keep this accepted drain ACK in the manager that owns the named save.
      // The ordinary remote-adoption path can replace it for source aliases.
      checkpointAckRef.current = (acknowledged) => {
        if (isCurrent() && options.isCurrent())
          options.applyDocument(acknowledged);
      };
      const captured = collaborationDocument(snapshot);
      // Loading the optional room action shares the save's deadline and room
      // cancellation. Its late resolution must not publish after local fallback.
      const timer = startCheckpointDeadline(controller);
      return abortableCheckpoint(
        import('./collaborationCheckpoint'),
        controller.signal
      )
        .then(
          ({ saveCollaborationCheckpoint }) =>
            saveCollaborationCheckpoint(captured, reason, options, {
              controller,
              isCurrent,
              drain: (signal) =>
                drainDocumentRef.current?.(signal) ??
                Promise.reject(new Error('The room is offline.')),
              lease: () =>
                roleRef.current === 'viewer' ? null : leaseRef.current,
              baseVersion: () => baseVersionRef.current,
              clientId: clientId(),
              observeEcho: (listener) => {
                if (checkpointRef.current === controller)
                  checkpointEchoRef.current = listener;
              },
              confirm: (saved, current) => {
                documentRef.current = current;
                lastSentVersionRef.current = saved.version;
                baseVersionRef.current = saved.version;
                serverVersionRef.current = saved.version;
                setRoomVersion(saved.version);
                setStatus('live');
              }
            }),
          (error: unknown) =>
            preserveFailedCheckpoint(
              error,
              captured,
              reason,
              options,
              isCurrent
            )
        )
        .finally(() => {
          window.clearTimeout(timer);
          if (checkpointRef.current !== controller) return;
          checkpointRef.current = null;
          checkpointEchoRef.current = null;
          checkpointAckRef.current = null;
          if (isCurrent() && options.isCurrent())
            sendCurrentDocumentRef.current?.();
        });
    },
    [setStatus]
  );

  return {
    status,
    members,
    role,
    lease,
    roomVersion,
    conflict,
    useRemoteVersion,
    keepLocalVersion,
    saveCheckpoint
  };
}
