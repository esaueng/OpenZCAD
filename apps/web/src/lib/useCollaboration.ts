import { useCallback, useEffect, useRef, useState } from 'react';
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
  document: ProjectDocument | null;
  session: AuthSession | null;
  onRemoteDocument(document: ProjectDocument): void;
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
}

const MAX_MESSAGE_BYTES = 900_000;
/**
 * Inbound frames wrap a room document (bounded server-side by
 * MAX_PERSISTED_DOCUMENT_BYTES, 1.5 MB) plus presence/lease metadata. A frame
 * larger than this cannot have come from a well-behaved room and is dropped.
 */
const MAX_INBOUND_MESSAGE_BYTES = 2_000_000;

const PROJECT_ROLES: readonly ProjectAccessRole[] = [
  'owner',
  'editor',
  'viewer'
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMembers(value: unknown): value is CollaborationMember[] {
  return (
    Array.isArray(value) &&
    value.every(
      (member) =>
        isRecord(member) &&
        typeof member.clientId === 'string' &&
        typeof member.userId === 'string' &&
        typeof member.displayName === 'string'
    )
  );
}

function isRoomDocument(
  value: unknown,
  projectId: string
): value is ProjectDocument {
  return (
    isRecord(value) &&
    value.projectId === projectId &&
    typeof value.version === 'number' &&
    typeof value.schemaVersion === 'number'
  );
}

function isLease(value: unknown, projectId: string): value is ProjectEditLease {
  return (
    isRecord(value) &&
    typeof value.leaseId === 'string' &&
    value.projectId === projectId &&
    typeof value.expiresAt === 'number'
  );
}

/**
 * Parses and shape-checks a frame from the room. The Durable Object is the
 * trust boundary, but a self-defending client drops oversized, malformed, or
 * foreign-project frames instead of adopting them into the local document or
 * throwing out of the message handler.
 */
export function parseServerMessage(
  raw: string,
  projectId: string
): CollaborationServerMessage | null {
  if (raw.length > MAX_INBOUND_MESSAGE_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }
  const message = parsed as unknown as CollaborationServerMessage;
  const document = parsed.document;
  const documentOk = (required: boolean): boolean =>
    document == null ? !required : isRoomDocument(document, projectId);
  switch (parsed.type) {
    case 'presence':
      return isMembers(parsed.members) ? message : null;
    case 'state':
      return isMembers(parsed.members) &&
        PROJECT_ROLES.includes(parsed.role as ProjectAccessRole) &&
        documentOk(false)
        ? message
        : null;
    case 'document':
    case 'conflict':
      return documentOk(true) ? message : null;
    case 'ack':
      return typeof parsed.version === 'number' && documentOk(false)
        ? message
        : null;
    case 'lease-granted':
      return isLease(parsed.lease, projectId) ? message : null;
    case 'lease-denied':
      return parsed.reason === 'held' || parsed.reason === 'read-only'
        ? message
        : null;
    case 'lease-lost':
      return parsed.reason === 'expired' ||
        parsed.reason === 'released' ||
        parsed.reason === 'role-changed' ||
        parsed.reason === 'invalid'
        ? message
        : null;
    case 'error':
      return typeof parsed.message === 'string' && parsed.message.length <= 1000
        ? message
        : null;
    default:
      return null;
  }
}

function collaborationDocument(document: ProjectDocument): ProjectDocument {
  return {
    ...structuredClone(document),
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: document.derived.updatedAt
    }
  };
}

/**
 * Maps a refusal frame to the status it should show, or null when the message
 * is not a refusal. The room kept its previous state either way, so the caller
 * adopts nothing and stays on its own document.
 */
function rejectionStatus(
  message: CollaborationServerMessage
): CollaborationStatus | null {
  if (message.type !== 'error') {
    return null;
  }
  console.error(`Collaboration rejected: ${message.message}`);
  return message.code === 'document-too-large' ? 'oversize' : 'rejected';
}

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
  document,
  session,
  onRemoteDocument,
  onConflict
}: CollaborationOptions): CollaborationClientState {
  const [status, setStatus] = useState<CollaborationStatus>('offline');
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
  const roleRef = useRef<ProjectAccessRole | null>(null);
  const leaseIdRef = useRef<string | null>(null);
  const leaseRef = useRef<ProjectEditLease | null>(null);
  const conflictRef = useRef<ProjectConflict | null>(null);
  const keepMinePendingRef = useRef(false);
  documentRef.current = document;
  remoteHandlerRef.current = onRemoteDocument;
  conflictHandlerRef.current = onConflict;

  const projectId = document?.projectId ?? null;
  const userId = session?.userId ?? null;
  const displayName = session?.displayName ?? null;

  useEffect(() => {
    if (!projectId || !userId || !displayName) {
      setStatus('offline');
      setMembers([]);
      setRole(null);
      setLease(null);
      setRoomVersion(null);
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
    setRoomVersion(null);
    keepMinePendingRef.current = false;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let leaseRetryTimer: number | undefined;
    let reconnectAttempt = 0;
    const id = clientId();

    const retainConflict = (
      roomDocument: ProjectDocument,
      force = false
    ): boolean => {
      const localDocument = documentRef.current;
      const marker = readUnresolvedConflict(projectId);
      if (!localDocument || (!force && !marker && !conflictRef.current)) {
        return false;
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

    const sendDocument = (
      socket: WebSocket,
      type: 'hello' | 'document'
    ): boolean => {
      const current = documentRef.current;
      if (!current || current.projectId !== projectId) {
        return false;
      }
      const payload = JSON.stringify({
        type,
        clientId: id,
        displayName,
        baseVersion: serverVersionRef.current,
        document: type === 'hello' ? null : collaborationDocument(current),
        ...(leaseIdRef.current ? { leaseId: leaseIdRef.current } : {})
      });
      if (type === 'hello') {
        socket.send(payload);
        return true;
      }
      if (
        conflictRef.current ||
        roleRef.current === 'viewer' ||
        !leaseIdRef.current
      ) {
        return false;
      }
      if (new TextEncoder().encode(payload).byteLength > MAX_MESSAGE_BYTES) {
        setStatus('oversize');
        void desktopFetch(`/api/projects/${projectId}/collaboration`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: id,
            baseVersion: serverVersionRef.current,
            document: collaborationDocument(current),
            leaseId: leaseIdRef.current
          })
        })
          .then(async (response) => {
            const message = parseServerMessage(
              await response.text(),
              projectId
            );
            if (!message) {
              console.error('Collaboration returned an unreadable response.');
              return;
            }
            const rejected = rejectionStatus(message);
            if (rejected) {
              setStatus(rejected);
              return;
            }
            if (!response.ok || message.type === 'conflict') {
              if (message.type === 'conflict') {
                serverVersionRef.current = message.document.version;
                setRoomVersion(message.document.version);
                retainConflict(message.document, true);
              }
              setStatus('conflict');
              return;
            }
            if (message.type === 'ack') {
              lastSentVersionRef.current = message.version;
              serverVersionRef.current = message.version;
              if (message.document) {
                remoteHandlerRef.current(message.document);
              }
            } else {
              lastSentVersionRef.current = current.version;
            }
            setStatus('live');
          })
          .catch(() => setStatus('offline'));
        return false;
      }
      socket.send(payload);
      lastSentVersionRef.current = current.version;
      return true;
    };

    const scheduleReconnect = () => {
      if (disposed) {
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
      if (disposed) {
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
        reconnectAttempt = 0;
        leaseIdRef.current = null;
        leaseRef.current = null;
        setLease(null);
        roleRef.current = null;
        setRole(null);
        sendDocument(socket, 'hello');
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
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
            if (!readUnresolvedConflict(projectId)) {
              setStatus('read-only');
            }
          }
          if (message.document) {
            if (rejectsNewerSchema(message.document)) {
              return;
            }
            serverVersionRef.current = message.document.version;
            setRoomVersion(message.document.version);
            // A viewer cannot submit local work, so the room is authoritative.
            // Editors must keep a divergent offline document until their lease
            // is granted and the room answers that submission with ack/conflict.
            const retained = retainConflict(message.document);
            if (message.role === 'viewer' && !retained) {
              lastSentVersionRef.current = message.document.version;
              documentRef.current = message.document;
              remoteHandlerRef.current(message.document);
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
          if (conflictRef.current || readUnresolvedConflict(projectId)) {
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
            conflictRef.current || readUnresolvedConflict(projectId)
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
                if (!disposed && socket.readyState === WebSocket.OPEN) {
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
          leaseIdRef.current = null;
          leaseRef.current = null;
          setLease(null);
          if (message.reason === 'role-changed') {
            roleRef.current = 'viewer';
            setRole('viewer');
            setStatus(
              conflictRef.current || readUnresolvedConflict(projectId)
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
          lastSentVersionRef.current = message.document.version;
          serverVersionRef.current = message.document.version;
          setRoomVersion(message.document.version);
          if (!retainConflict(message.document)) {
            remoteHandlerRef.current(message.document);
          }
          return;
        }
        if (message.type === 'ack') {
          lastSentVersionRef.current = message.version;
          serverVersionRef.current = message.version;
          setRoomVersion(message.version);
          if (keepMinePendingRef.current) {
            keepMinePendingRef.current = false;
            clearUnresolvedConflict(projectId);
            conflictRef.current = null;
            setConflict(null);
          }
          setStatus('live');
          // Present only when the server merged our submission into something
          // else; adopting it is what keeps this client from diverging.
          if (message.document) {
            remoteHandlerRef.current(message.document);
          }
          return;
        }
        if (message.type === 'conflict') {
          if (rejectsNewerSchema(message.document)) {
            return;
          }
          keepMinePendingRef.current = false;
          serverVersionRef.current = message.document.version;
          setRoomVersion(message.document.version);
          setStatus('conflict');
          retainConflict(message.document, true);
          return;
        }
        const rejected = rejectionStatus(message);
        if (rejected) {
          setStatus(rejected);
        }
      });
      socket.addEventListener('close', () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        if (disposed) {
          return;
        }
        scheduleReconnect();
      });
      socket.addEventListener('error', () => socket.close());
    };

    function connect() {
      if (disposed) {
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
        `/api/projects/${projectId}/collaboration`,
        window.location.href
      );
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      connectToUrl(url);
    }

    connect();
    const leaseRenewTimer = window.setInterval(() => {
      const socket = socketRef.current;
      const leaseId = leaseIdRef.current;
      if (socket?.readyState === WebSocket.OPEN && leaseId) {
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
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      if (leaseRetryTimer !== undefined) {
        window.clearTimeout(leaseRetryTimer);
      }
      window.clearInterval(leaseRenewTimer);
      if (
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
  }, [displayName, projectId, userId]);

  useEffect(() => {
    if (
      !document ||
      conflictRef.current ||
      readUnresolvedConflict(document.projectId) ||
      lastSentVersionRef.current === document.version
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (roleRef.current === 'viewer' || !leaseIdRef.current) {
        return;
      }
      const payload = JSON.stringify({
        type: 'document',
        clientId: clientId(),
        baseVersion: serverVersionRef.current,
        document: collaborationDocument(document),
        leaseId: leaseIdRef.current
      });
      if (new TextEncoder().encode(payload).byteLength > MAX_MESSAGE_BYTES) {
        setStatus('oversize');
        void desktopFetch(`/api/projects/${document.projectId}/collaboration`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: clientId(),
            baseVersion: serverVersionRef.current,
            document: collaborationDocument(document),
            leaseId: leaseIdRef.current
          })
        })
          .then(async (response) => {
            const message = parseServerMessage(
              await response.text(),
              document.projectId
            );
            if (!message) {
              console.error('Collaboration returned an unreadable response.');
              return;
            }
            const rejected = rejectionStatus(message);
            if (rejected) {
              setStatus(rejected);
              return;
            }
            if (!response.ok || message.type === 'conflict') {
              if (message.type === 'conflict') {
                serverVersionRef.current = message.document.version;
                setRoomVersion(message.document.version);
                let pending: ProjectConflict;
                try {
                  pending = conflictFromDocuments(document, message.document);
                } catch {
                  return;
                }
                conflictRef.current = pending;
                setConflict(pending);
                conflictHandlerRef.current(message.document);
              }
              setStatus('conflict');
              return;
            }
            if (message.type === 'ack') {
              lastSentVersionRef.current = message.version;
              serverVersionRef.current = message.version;
              if (message.document) {
                remoteHandlerRef.current(message.document);
              }
            } else {
              lastSentVersionRef.current = document.version;
            }
            setStatus('live');
          })
          .catch(() => setStatus('offline'));
        return;
      }
      socket.send(payload);
      lastSentVersionRef.current = document.version;
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [document?.projectId, document?.version]);

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
      clearUnresolvedConflict(pending.projectId);
      conflictRef.current = null;
      setConflict(null);
      keepMinePendingRef.current = false;
      lastSentVersionRef.current = roomDocument.version;
      documentRef.current = roomDocument;
      remoteHandlerRef.current(roomDocument);
      setStatus(roleRef.current === 'viewer' ? 'read-only' : 'live');
      return true;
    },
    [projectId]
  );

  const keepLocalVersion = useCallback(
    async (expectedRemoteVersion: number): Promise<void> => {
      const pending = conflictRef.current;
      const activeLease = leaseRef.current;
      const socket = socketRef.current;
      const current = documentRef.current;
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
        throw new Error(
          'Keep my version requires an active project edit lease.'
        );
      }
      const body = {
        type: 'document' as const,
        clientId: clientId(),
        baseVersion: expectedRemoteVersion,
        document: collaborationDocument(current),
        leaseId: activeLease.leaseId
      };
      const payload = JSON.stringify(body);
      keepMinePendingRef.current = true;
      lastSentVersionRef.current = current.version;
      setStatus('connecting');

      if (new TextEncoder().encode(payload).byteLength <= MAX_MESSAGE_BYTES) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          keepMinePendingRef.current = false;
          setStatus('conflict');
          throw new Error('The collaboration room is offline.');
        }
        socket.send(payload);
        return;
      }

      try {
        const response = await desktopFetch(
          `/api/projects/${projectId}/collaboration`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              clientId: body.clientId,
              baseVersion: body.baseVersion,
              document: body.document,
              leaseId: body.leaseId
            })
          }
        );
        const message = parseServerMessage(await response.text(), projectId);
        if (!message) {
          throw new Error('The room returned an unreadable response.');
        }
        if (message.type === 'conflict') {
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
        serverVersionRef.current = message.version;
        setRoomVersion(message.version);
        clearUnresolvedConflict(projectId);
        conflictRef.current = null;
        setConflict(null);
        setStatus('live');
        if (message.document) {
          documentRef.current = message.document;
          remoteHandlerRef.current(message.document);
        }
      } finally {
        keepMinePendingRef.current = false;
      }
    },
    [projectId]
  );

  return {
    status,
    members,
    role,
    lease,
    roomVersion,
    conflict,
    useRemoteVersion,
    keepLocalVersion
  };
}
