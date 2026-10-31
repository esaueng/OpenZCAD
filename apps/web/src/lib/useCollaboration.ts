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
  assertStorableDocument,
  mergeCollaborationDocuments
} from '@openzcad/document-core';
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
import { listLocalOnlyImportSources } from './importArchival';
import { noteProjectMigrating } from './migrationStatus';
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
  collaborationClientId as clientId,
  collaborationDocument,
  reconcileCheckpointFlush,
  parseServerMessage,
  rejectionStatus
} from './collaborationProtocol';
export { parseServerMessage } from './collaborationProtocol';
import type { EncryptedRoomCodec } from './e2ee/encryptedRoomCodec';
import { subscribeEncryptionState } from './e2ee/encryptionStateEvents';

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
   *
   * `accountVersion` is set when the document is not yet the account's: a
   * local three-way merge the room has not acknowledged. It names the head
   * the account holds (the room's latest), which an encrypted room's account
   * baseline stays on until `onAccountVersion` reports the merge accepted.
   */
  onRemoteDocument(
    document: ProjectDocument,
    context?: { adopted?: boolean; accountVersion?: number }
  ): void;
  onConflict(document: ProjectDocument): void;
  /**
   * The project is end-to-end encrypted (ADR-024 slice 4-9): the room
   * relays envelopes, sealed and opened by `e2ee/encryptedRoomCodec.ts`,
   * and every version it accepts is the account's version too.
   */
  encrypted?: boolean;
  /** An encrypted room stored this browser's version in the account. */
  onAccountVersion?(projectId: string, version: number): void;
}

export interface CollaborationClientState {
  status: CollaborationStatus;
  failureReason?: string | null;
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
/**
 * Browser merges in a row without an acknowledgement. Each conflict means the
 * room really moved, but a peer that keeps winning the race leaves this client
 * on the manual reconciliation it had before the room stopped merging.
 */
const MAX_CONFLICT_MERGES = 3;
/** Resubmissions after the group moved to a newer key epoch, per edit. */
const MAX_EPOCH_RETRIES = 2;
/**
 * Lost-blob repairs before an encrypted edit is acknowledged (slice 5-6),
 * as an account save repairs once.
 */
const MAX_BLOB_RESTORES = 1;
const ROOM_CHANGED_MESSAGE = 'The room changed.';
/**
 * The room's close code when a plaintext project begins moving to
 * encrypted storage (`acceptInternalMigration`, cloudflare-adapters).
 */
export const ROOM_MIGRATING_CLOSE_CODE = 4003;

export function useCollaboration({
  enabled,
  document,
  session,
  onRemoteDocument,
  onConflict,
  encrypted = false,
  onAccountVersion
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
    reason?: string | null;
  }>({ projectId: null, wanted: false, status: 'offline' });
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [role, setRole] = useState<ProjectAccessRole | null>(null);
  const [lease, setLease] = useState<ProjectEditLease | null>(null);
  const [roomVersion, setRoomVersion] = useState<number | null>(null);
  const [conflict, setConflict] = useState<ProjectConflict | null>(null);
  const [encryptionView, setEncryptionView] = useState(0);
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
  const sendCurrentDocumentRef = useRef<
    ((document?: ProjectDocument) => void) | null
  >(null);
  const checkpointRef = useRef<AbortController | null>(null);
  const checkpointEchoRef = useRef<
    ((document: ProjectDocument) => void) | null
  >(null);
  const checkpointAckRef = useRef<{
    submitted: ProjectDocument;
    accept(document: ProjectDocument, version?: number): ProjectDocument | null;
  } | null>(null);
  const checkpointDrainRef = useRef<{
    resolve(): void;
    reject(error: Error): void;
  } | null>(null);
  const drainDocumentRef = useRef<
    ((signal: AbortSignal) => Promise<ProjectDocument | null>) | null
  >(null);
  const accountVersionRef = useRef(onAccountVersion);
  /** The encrypted room's codec while one is connected (slice 4-9). */
  const codecRef = useRef<Promise<EncryptedRoomCodec> | null>(null);
  documentRef.current = document;
  remoteHandlerRef.current = onRemoteDocument;
  conflictHandlerRef.current = onConflict;
  accountVersionRef.current = onAccountVersion;

  const projectId = document?.projectId ?? null;
  const userId = session?.userId ?? null;
  const displayName = session?.displayName ?? null;
  useEffect(() => {
    if (!enabled || !encrypted || !userId) return;
    // A connected codec captures the page's key view too. Reconnect with
    // fresh clients after settings rechecks/rotation, keeping documentRef.
    return subscribeEncryptionState(userId, () =>
      setEncryptionView((version) => version + 1)
    );
  }, [enabled, encrypted, userId]);
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
  }, [displayName, enabled, encrypted, encryptionView, projectId, userId]);
  const roomWanted = Boolean(enabled && projectId && userId && displayName);
  const stampRef = useRef({ projectId, wanted: roomWanted });
  stampRef.current = { projectId, wanted: roomWanted };
  const setStatus = useCallback(
    (next: CollaborationStatus, reason: string | null = null) => {
      setStatusEntry({ ...stampRef.current, status: next, reason });
    },
    []
  );
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
    let conflictMerges = 0;
    let epochRetries = 0;
    let blobRestores = 0;
    // An encrypted project's room speaks envelopes: frames go through the
    // codec, in order, and nothing is decrypted on the main thread.
    const codecLoad: Promise<EncryptedRoomCodec> | null = encrypted
      ? import('./e2ee/encryptedRoomCodec').then(({ loadEncryptedRoomCodec }) =>
          loadEncryptedRoomCodec(projectId)
        )
      : null;
    codecLoad?.catch((error: unknown) => {
      // Locked keys or a device that only reads: the room stays unused and
      // the account's own paths report why.
      console.error(
        `Encrypted collaboration unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
      if (isCurrentRoom()) setStatus('offline');
    });
    codecRef.current = codecLoad;
    let inbound: Promise<void> = Promise.resolve();
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
      conflictMerges = 0;
      const local = documentRef.current;
      serverVersionRef.current = message.version;
      setRoomVersion(message.version);
      const checkpoint = checkpointAckRef.current;
      // A debounce or lease grant may have published the clicked model before
      // saveCheckpoint cloned it. Match that exact persisted write, including
      // owner and version, rather than depending on the clone's object identity.
      const ownsFlush = Boolean(
        checkpoint &&
        submitted &&
        checkpoint.submitted.ownerUserId === submitted.ownerUserId &&
        checkpoint.submitted.version === submitted.version &&
        projectsHaveSameCanonicalContent(checkpoint.submitted, submitted)
      );
      const checkpointCurrent =
        checkpoint && ownsFlush && message.document
          ? checkpoint.accept(message.document, message.version)
          : null;
      if (ownsFlush && message.document && !checkpointCurrent) {
        retainConflict(message.document, true);
        settleCheckpointDrain(
          new Error('The room did not confirm the clicked edit.')
        );
        return;
      }
      // A merge acknowledges the submitted snapshot, not edits made while it
      // was in flight. Preserve those newer edits for explicit reconciliation.
      if (
        message.document &&
        local &&
        !checkpointCurrent &&
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
      epochRetries = 0;
      blobRestores = 0;
      // An encrypted room wrote this version to the account before it
      // acknowledged it (ADR-024 slice 4-9).
      if (codecLoad) accountVersionRef.current?.(projectId, message.version);
      settleCheckpointDrain();
      if (keepMinePendingRef.current) {
        settleKeepMine();
        clearUnresolvedConflict(projectId, 'room');
        conflictRef.current = null;
        setConflict(null);
      }
      if (conflictRef.current) return;
      if (checkpointCurrent && roleRef.current === 'viewer')
        setStatus('read-only');
      else if (
        !checkpointCurrent ||
        (leaseRef.current?.expiresAt ?? 0) > Date.now()
      )
        setStatus('live');
      if (message.document) {
        documentRef.current = checkpointCurrent ?? message.document;
        if (!checkpointCurrent) {
          if (checkpoint) checkpoint.accept(message.document);
          else remoteHandlerRef.current(message.document, { adopted: true });
        }
      }
      sendCurrentDocumentRef.current?.();
    };

    const sendDocument = (
      socket: WebSocket,
      type: 'hello' | 'document',
      current = documentRef.current,
      resubmit = false
    ): boolean => {
      if (!isCurrentRoom() || !current || current.projectId !== projectId) {
        return false;
      }
      const frame = (document: ProjectDocument | null) =>
        JSON.stringify({
          type,
          clientId: id,
          displayName,
          baseVersion: baseVersionRef.current,
          document: document && collaborationDocument(document),
          ...(leaseIdRef.current ? { leaseId: leaseIdRef.current } : {})
        });
      if (type === 'hello') {
        socket.send(frame(null));
        return true;
      }
      if (
        // A merged resubmission completes the edit a named save is draining.
        (checkpointRef.current && !(resubmit && checkpointDrainRef.current)) ||
        conflictRef.current ||
        readUnresolvedConflict(projectId, 'room') ||
        roleRef.current === 'viewer' ||
        !leaseIdRef.current ||
        (leaseRef.current?.expiresAt ?? 0) <= Date.now() ||
        pendingDocument ||
        (lastSentVersionRef.current === current.version &&
          baseVersionRef.current === current.version)
      ) {
        return false;
      }
      // The room stores submissions without reading them (ADR-024 Phase 1),
      // so this browser refuses to publish a document other members could
      // not open. Local edits stay as they are. What goes out is the document
      // as the checks normalized it, the same form an account save uploads.
      let normalized: ProjectDocument;
      try {
        normalized = assertStorableDocument(current);
      } catch (error) {
        console.error(
          `Collaboration edit not sent: ${error instanceof Error ? error.message : String(error)}`
        );
        settleCheckpointDrain(
          new Error('This version cannot be shared with the room.')
        );
        setStatus('rejected');
        return false;
      }
      if (codecLoad) {
        pendingDocument = current;
        lastSentVersionRef.current = current.version;
        void sendEncrypted(socket, normalized, current, baseVersionRef.current);
        return true;
      }
      const payload = frame(normalized);
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
              document: collaborationDocument(normalized),
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
            settleHttpReply(socket, message, response.ok);
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

    /** The room's answer to a submission sent over HTTP. */
    const settleHttpReply = (
      socket: WebSocket,
      message: CollaborationServerMessage | null,
      ok: boolean
    ) => {
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
      if (message.type === 'ack' && ok) {
        acknowledge(message);
        return;
      }
      if (
        message.type === 'conflict' &&
        (message.document.schemaVersion ?? 0) <=
          PROJECT_DOCUMENT_SCHEMA_VERSION &&
        mergeRoomConflict(socket, message)
      ) {
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
        setStatus(rejected, message.type === 'error' ? message.message : null);
        return;
      }
      if (message.type === 'conflict') {
        serverVersionRef.current = message.document.version;
        setRoomVersion(message.document.version);
        retainConflict(message.document, true);
      }
    };

    /**
     * Seals and sends `normalized` to an encrypted room (ADR-024 slice 4-9),
     * on the room version `baseVersion` it descends from. The hook's own
     * bookkeeping (`pendingDocument`) was set before sealing began.
     */
    const sendEncrypted = async (
      socket: WebSocket,
      normalized: ProjectDocument,
      submitted: ProjectDocument,
      baseVersion: number | null
    ) => {
      const leaseId = leaseIdRef.current;
      const stillPending = () =>
        isCurrentRoom() &&
        socketRef.current === socket &&
        pendingDocument === submitted;
      try {
        const codec = await codecLoad!;
        const encoded = await codec.encode(normalized, baseVersion);
        if (!stillPending()) return;
        if (encoded.kind === 'same') {
          acknowledge({ type: 'ack', version: encoded.version });
          return;
        }
        const body = {
          clientId: id,
          version: encoded.submission,
          ...(leaseId ? { leaseId } : {})
        };
        const payload = JSON.stringify({ type: 'e2ee-document', ...body });
        if (new TextEncoder().encode(payload).byteLength <= MAX_MESSAGE_BYTES) {
          if (socket.readyState === WebSocket.OPEN) socket.send(payload);
          return;
        }
        // Too large for a frame: the same submission over HTTP. A refusal
        // there (too large for the room too) reports `oversize`, and the
        // account's autosave takes the version instead.
        const response = await desktopFetch(
          `/api/projects/${encodeURIComponent(projectId)}/collaboration`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          }
        );
        const decoded = await codec.decode(await response.text());
        if (!stillPending()) return;
        settleHttpReply(socket, decoded.message, response.ok);
      } catch (error) {
        if (!stillPending()) return;
        console.error(
          `Encrypted collaboration edit not sent: ${error instanceof Error ? error.message : String(error)}`
        );
        pendingDocument = null;
        lastSentVersionRef.current = null;
        settleCheckpointDrain(
          new Error('This version cannot be shared with the room.')
        );
        if ((error as { readOnly?: unknown } | null)?.readOnly === true) {
          // This account's own MLS role no longer lets it write (slice
          // 5-6): read-only, as when the room says the role changed.
          leaseIdRef.current = null;
          leaseRef.current = null;
          setLease(null);
          roleRef.current = 'viewer';
          setRole('viewer');
          setStatus('read-only');
          return;
        }
        setStatus('rejected');
      }
    };

    /**
     * The room orders versions but never merges them (ADR-024 Phase 1). A
     * stale submission comes back as a conflict carrying its base, and this
     * browser merges the room's latest document with its current one — edits
     * made while the submission was in flight included — then resubmits the
     * result on the latest version. False leaves the conflict to the caller.
     */
    function mergeRoomConflict(
      socket: WebSocket,
      message: Extract<CollaborationServerMessage, { type: 'conflict' }>
    ): boolean {
      const { base, document: latest } = message;
      const local = documentRef.current;
      if (
        !base ||
        !local ||
        local.projectId !== projectId ||
        base.version !== baseVersionRef.current ||
        conflictMerges >= MAX_CONFLICT_MERGES ||
        keepMinePendingRef.current ||
        conflictRef.current ||
        readUnresolvedConflict(projectId, 'room') ||
        roleRef.current === 'viewer' ||
        (checkpointRef.current && !checkpointDrainRef.current)
      ) {
        return false;
      }
      const merged = mergeCollaborationDocuments(base, latest, local);
      if (!merged) return false;
      conflictMerges += 1;
      pendingDocument = null;
      serverVersionRef.current = latest.version;
      setRoomVersion(latest.version);
      baseVersionRef.current = latest.version;
      documentRef.current = merged;
      // In an encrypted room this is not the account's until the room
      // acknowledges it: the account still holds `latest`.
      remoteHandlerRef.current(merged, {
        adopted: true,
        ...(codecLoad ? { accountVersion: latest.version } : {})
      });
      sendDocument(socket, 'document', merged, true);
      // Refused (say the lease lapsed): the merged document stays local on the
      // latest base and goes out with the next ordinary publication.
      if ((pendingDocument as ProjectDocument | null) !== merged) {
        settleCheckpointDrain(
          new Error('The room did not confirm the pending edit.')
        );
      }
      return true;
    }

    sendCurrentDocumentRef.current = (current) => {
      const socket = socketRef.current;
      if (isCurrentRoom() && socket?.readyState === WebSocket.OPEN) {
        sendDocument(socket, 'document', current);
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
        conflictMerges = 0;
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
        if (codecLoad) {
          const raw = event.data;
          // Opening a version takes a moment; frames still apply in order.
          inbound = inbound
            .then(async () => {
              if (!isCurrentRoom() || socketRef.current !== socket) return;
              const codec = await codecLoad;
              if (!isCurrentRoom() || socketRef.current !== socket) return;
              const { message } = await codec.decode(raw);
              if (isCurrentRoom() && socketRef.current === socket && message)
                handleMessage(message);
            })
            .catch((error: unknown) => {
              console.error(
                `Encrypted collaboration frame not handled: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          return;
        }
        const message = parseServerMessage(event.data, projectId);
        if (!message) {
          return;
        }
        handleMessage(message);
      });
      const handleMessage = (message: CollaborationServerMessage) => {
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
          // A validated own checkpoint echo confirms the clicked snapshot even
          // when newer local work prevents adopting that snapshot as the head.
          if (message.clientId === id)
            checkpointEchoRef.current?.(message.document);
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
            remoteHandlerRef.current(message.document);
          }
          return;
        }
        if (message.type === 'ack') {
          acknowledge(message);
          return;
        }
        if (message.type === 'conflict') {
          if (
            (message.document.schemaVersion ?? 0) <=
              PROJECT_DOCUMENT_SCHEMA_VERSION &&
            mergeRoomConflict(socket, message)
          ) {
            return;
          }
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
        if (
          codecLoad &&
          message.type === 'error' &&
          message.code === 'epoch-stale' &&
          !keepMinePendingRef.current &&
          epochRetries < MAX_EPOCH_RETRIES
        ) {
          // The group moved to a newer key epoch while this edit was sealed:
          // catch up, then seal it again under the new epoch.
          epochRetries += 1;
          pendingDocument = null;
          lastSentVersionRef.current = null;
          void codecLoad
            .then((codec) => codec.catchUp())
            .catch(() => undefined)
            .then(() => {
              if (isCurrentRoom() && socketRef.current === socket)
                sendDocument(socket, 'document', undefined, true);
            });
          return;
        }
        if (
          codecLoad &&
          message.type === 'error' &&
          message.code === 'blob-unknown' &&
          !keepMinePendingRef.current &&
          blobRestores < MAX_BLOB_RESTORES
        ) {
          // The account lost a blob this version names (slice 5-6): store
          // it again from this device's copy, then seal and send again.
          blobRestores += 1;
          pendingDocument = null;
          lastSentVersionRef.current = null;
          const blobIds = Array.isArray(message.blobIds)
            ? message.blobIds.filter(
                (blobId): blobId is string => typeof blobId === 'string'
              )
            : [];
          void codecLoad
            .then((codec) => codec.restoreBlobs(blobIds))
            .then(
              () => {
                if (isCurrentRoom() && socketRef.current === socket)
                  sendDocument(socket, 'document', undefined, true);
              },
              (error: unknown) => {
                console.error(
                  `Encrypted collaboration files not restored: ${error instanceof Error ? error.message : String(error)}`
                );
                if (isCurrentRoom() && socketRef.current === socket) {
                  settleCheckpointDrain(new Error(message.message));
                  setStatus('rejected');
                }
              }
            );
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
          setStatus(
            rejected,
            message.type === 'error' ? message.message : null
          );
        }
      };
      socket.addEventListener('close', (event: { code?: number }) => {
        if (!isCurrentRoom()) return;
        // The project began moving to encrypted storage (ADR-024 Phase 7):
        // the room closed every plaintext connection and refuses new ones
        // while it is staged. The workspace locks editing at once, before
        // any save is refused (`projectMigrationWatch.ts`).
        if (event.code === ROOM_MIGRATING_CLOSE_CODE && !encrypted) {
          noteProjectMigrating(projectId);
        }
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
      if (codecRef.current === codecLoad) codecRef.current = null;
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
    encrypted,
    encryptionView,
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
          clientId,
          ...(codecRef.current
            ? { sealKept: sealKeptFrame(codecRef.current, clientId) }
            : {})
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
      // An encrypted project is its owner's; named saves go to the account
      // (`encryptedProjectStore.saveRevision`), which the room then follows.
      if (codecRef.current)
        return Promise.reject(
          new Error('Encrypted projects save named versions to the account.')
        );
      if (roleRef.current === 'viewer' || conflictRef.current)
        return Promise.reject(
          new Error('This project cannot save a room revision.')
        );
      const controller = new AbortController();
      const epoch = roomEpochRef.current;
      const socket = socketRef.current;
      const captured = collaborationDocument(snapshot);
      // Copied sources need an ordinary ACK's trusted aliases before naming.
      // Plain models retain their direct HTTP save and buffered-edit merge.
      if (
        options.isCurrent() &&
        listLocalOnlyImportSources(captured).length > 0
      )
        sendCurrentDocumentRef.current?.(captured);
      // Reserve the outgoing barrier before the dynamic import or ACK drain.
      checkpointRef.current = controller;
      checkpointEchoRef.current = null;
      const isCurrent = () =>
        roomEpochRef.current === epoch &&
        socketRef.current === socket &&
        documentRef.current?.projectId === snapshot.projectId;
      // Keep this accepted drain ACK in the manager that owns the named save.
      // The ordinary remote-adoption path can replace it for source aliases.
      checkpointAckRef.current = {
        submitted: captured,
        accept: (acknowledged, version) => {
          if (!isCurrent() || !options.isCurrent()) return null;
          const current =
            version === undefined
              ? acknowledged
              : version === acknowledged.version
                ? reconcileCheckpointFlush(
                    captured,
                    options.readDocument(),
                    acknowledged
                  )
                : null;
          if (current) options.applyDocument(current);
          return current;
        }
      };
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
    []
  );

  return {
    status,
    failureReason:
      statusEntry.projectId === projectId && status === 'rejected'
        ? (statusEntry.reason ?? null)
        : null,
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

/**
 * "Keep my version" in an encrypted room: the kept document, sealed on the
 * room version the user chose to replace, as an ordinary envelope submission.
 * The room orders it like any other; the acknowledgement echoes it back.
 */
function sealKeptFrame(
  codecLoad: Promise<EncryptedRoomCodec>,
  clientId: () => string
) {
  return async (
    kept: ProjectDocument,
    baseVersion: number,
    leaseId: string
  ): Promise<string> => {
    const codec = await codecLoad;
    const encoded = await codec.encode(kept, baseVersion, { echo: true });
    if (encoded.kind === 'same') {
      throw new Error('The room already holds this version.');
    }
    return JSON.stringify({
      type: 'e2ee-document',
      clientId: clientId(),
      version: encoded.submission,
      leaseId
    });
  };
}
