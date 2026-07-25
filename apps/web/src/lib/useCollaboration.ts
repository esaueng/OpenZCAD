import { useEffect, useRef, useState } from 'react';
import type {
  AuthSession,
  CollaborationMember,
  CollaborationServerMessage,
  ProjectDocument
} from '@openzcad/shared';

export type CollaborationStatus =
  | 'connecting'
  | 'live'
  | 'offline'
  | 'conflict'
  | 'oversize';

interface CollaborationOptions {
  document: ProjectDocument | null;
  session: AuthSession | null;
  onRemoteDocument(document: ProjectDocument): void;
  onConflict(document: ProjectDocument): void;
}

const MAX_MESSAGE_BYTES = 900_000;

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
}: CollaborationOptions): {
  status: CollaborationStatus;
  members: CollaborationMember[];
} {
  const [status, setStatus] = useState<CollaborationStatus>('offline');
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const documentRef = useRef(document);
  const remoteHandlerRef = useRef(onRemoteDocument);
  const conflictHandlerRef = useRef(onConflict);
  const lastSentVersionRef = useRef<number | null>(null);
  const serverVersionRef = useRef<number | null>(null);
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
      return;
    }
    let disposed = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    const id = clientId();

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
        document: collaborationDocument(current)
      });
      if (new TextEncoder().encode(payload).byteLength > MAX_MESSAGE_BYTES) {
        setStatus('oversize');
        void fetch(`/api/projects/${projectId}/collaboration`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: id,
            baseVersion: serverVersionRef.current,
            document: collaborationDocument(current)
          })
        })
          .then(async (response) => {
            const message = (await response.json()) as CollaborationServerMessage;
            if (!response.ok || message.type === 'conflict') {
              if (message.type === 'conflict') {
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
              lastSentVersionRef.current = current.version;
            }
            if (type === 'hello' && socket.readyState === WebSocket.OPEN) {
              socket.send(
                JSON.stringify({
                  type: 'hello',
                  clientId: id,
                  displayName,
                  baseVersion: serverVersionRef.current,
                  document: null
                })
              );
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

    const connect = () => {
      if (disposed) {
        return;
      }
      setStatus('connecting');
      const url = new URL(
        `/api/projects/${projectId}/collaboration`,
        window.location.href
      );
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        reconnectAttempt = 0;
        if (sendDocument(socket, 'hello')) {
          setStatus('live');
        }
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          return;
        }
        let message: CollaborationServerMessage;
        try {
          message = JSON.parse(event.data) as CollaborationServerMessage;
        } catch {
          return;
        }
        if (message.type === 'presence') {
          setMembers(message.members);
          return;
        }
        if (message.type === 'state') {
          setMembers(message.members);
          if (message.document) {
            lastSentVersionRef.current = message.document.version;
            serverVersionRef.current = message.document.version;
            remoteHandlerRef.current(message.document);
          }
          return;
        }
        if (message.type === 'document') {
          lastSentVersionRef.current = message.document.version;
          serverVersionRef.current = message.document.version;
          remoteHandlerRef.current(message.document);
          return;
        }
        if (message.type === 'ack') {
          lastSentVersionRef.current = message.version;
          serverVersionRef.current = message.version;
          setStatus('live');
          // Present only when the server merged our submission into something
          // else; adopting it is what keeps this client from diverging.
          if (message.document) {
            remoteHandlerRef.current(message.document);
          }
          return;
        }
        if (message.type === 'conflict') {
          setStatus('conflict');
          conflictHandlerRef.current(message.document);
        }
      });
      socket.addEventListener('close', () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        if (disposed) {
          return;
        }
        setStatus('offline');
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(
          connect,
          Math.min(10_000, 750 * 2 ** reconnectAttempt)
        );
      });
      socket.addEventListener('error', () => socket.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socketRef.current?.close(1000, 'Project changed.');
      socketRef.current = null;
      setMembers([]);
    };
  }, [displayName, projectId, userId]);

  useEffect(() => {
    if (!document || lastSentVersionRef.current === document.version) {
      return;
    }
    const timeout = window.setTimeout(() => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const payload = JSON.stringify({
        type: 'document',
        clientId: clientId(),
        baseVersion: serverVersionRef.current,
        document: collaborationDocument(document)
      });
      if (new TextEncoder().encode(payload).byteLength > MAX_MESSAGE_BYTES) {
        setStatus('oversize');
        void fetch(`/api/projects/${document.projectId}/collaboration`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: clientId(),
            baseVersion: serverVersionRef.current,
            document: collaborationDocument(document)
          })
        })
          .then(async (response) => {
            const message = (await response.json()) as CollaborationServerMessage;
            if (!response.ok || message.type === 'conflict') {
              if (message.type === 'conflict') {
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

  return { status, members };
}
