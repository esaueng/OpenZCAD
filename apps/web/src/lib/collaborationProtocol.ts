import {
  isDocumentHistory,
  MAX_CHECKPOINT_REASON_LENGTH,
  type CollaborationMember,
  type CollaborationServerMessage,
  type ProjectAccessRole,
  type ProjectDocument,
  type ProjectEditLease
} from '@openzcad/shared';

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
    typeof value.schemaVersion === 'number' &&
    (value.editHistory === undefined ||
      isDocumentHistory(value.editHistory, projectId))
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

import type { CollaborationStatus } from './useCollaboration';

export function collaborationDocument(
  document: ProjectDocument
): ProjectDocument {
  // Strip the derived projection BEFORE cloning: the old order cloned every
  // mesh buffer only to throw the copies away on the next line.
  return structuredClone({
    ...document,
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: document.derived.updatedAt
    }
  });
}

/**
 * Maps a refusal frame to the status it should show, or null when the message
 * is not a refusal. The room kept its previous state either way, so the caller
 * adopts nothing and stays on its own document.
 */
export function rejectionStatus(
  message: CollaborationServerMessage
): CollaborationStatus | null {
  if (message.type !== 'error') {
    return null;
  }
  console.error(`Collaboration rejected: ${message.message}`);
  return message.code === 'document-too-large' ? 'oversize' : 'rejected';
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

export function normalizeCheckpointReason(reason: string): string {
  const normalized = reason.trim() || 'Saved';
  return normalized.length > MAX_CHECKPOINT_REASON_LENGTH
    ? `${normalized.slice(0, MAX_CHECKPOINT_REASON_LENGTH - 1)}…`
    : normalized;
}
