import type {
  ProjectAccessRole,
  ProjectDocument,
  ProjectEditLease
} from '@openzcad/shared';

const CONFLICT_MARKER_PREFIX = 'openzcad-unresolved-collaboration-conflict:';

export interface CollaborationConflict {
  projectId: string;
  localDocument: ProjectDocument;
  roomDocument: ProjectDocument;
  /** The exact room version against which a keep-mine write must be based. */
  expectedRoomVersion: number;
}

export interface UnresolvedConflictMarker {
  projectId: string;
  localVersion: number;
  roomVersion: number;
  detectedAt: number;
}

export type ConflictResolution = 'use-room' | 'keep-mine' | 'save-local-copy';

export interface ConflictRecoveryCopyWriter {
  /** Persist the untouched divergent document before any resolution mutates state. */
  writeRecoveryCopy(document: ProjectDocument): Promise<void>;
}

export interface ConflictResolutionHandlers extends ConflictRecoveryCopyWriter {
  useRoomVersion(document: ProjectDocument): Promise<void> | void;
  keepMyVersion(input: {
    document: ProjectDocument;
    expectedRoomVersion: number;
    leaseId: string;
  }): Promise<void> | void;
  saveLocalAsCopy(document: ProjectDocument): Promise<void> | void;
}

export interface ConflictResolutionContext {
  role: ProjectAccessRole | null;
  lease: ProjectEditLease | null;
  now?: number;
}

export class ConflictRecoveryError extends Error {
  constructor(
    readonly code:
      | 'PROJECT_MISMATCH'
      | 'ROOM_VERSION_MISMATCH'
      | 'VIEWER_FORBIDDEN'
      | 'LEASE_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'ConflictRecoveryError';
  }
}

function markerKey(projectId: string): string {
  return `${CONFLICT_MARKER_PREFIX}${encodeURIComponent(projectId)}`;
}

/**
 * Persist only the small conflict sentinel. The full local document remains in
 * the normal IndexedDB project store and is supplied again by the app after a
 * reload; the next room state reconstructs the conflict without putting a CAD
 * document in synchronous Web Storage.
 */
export function rememberUnresolvedConflict(
  marker: UnresolvedConflictMarker,
  storage: Storage = localStorage
): void {
  storage.setItem(markerKey(marker.projectId), JSON.stringify(marker));
}

export function readUnresolvedConflict(
  projectId: string,
  storage: Storage = localStorage
): UnresolvedConflictMarker | null {
  const value = storage.getItem(markerKey(projectId));
  if (!value) {
    return null;
  }
  try {
    const marker = JSON.parse(value) as Partial<UnresolvedConflictMarker>;
    if (
      marker.projectId !== projectId ||
      !Number.isSafeInteger(marker.localVersion) ||
      !Number.isSafeInteger(marker.roomVersion) ||
      typeof marker.detectedAt !== 'number' ||
      !Number.isFinite(marker.detectedAt)
    ) {
      return null;
    }
    return marker as UnresolvedConflictMarker;
  } catch {
    return null;
  }
}

export function clearUnresolvedConflict(
  projectId: string,
  storage: Storage = localStorage
): void {
  storage.removeItem(markerKey(projectId));
}

export function conflictFromDocuments(
  localDocument: ProjectDocument,
  roomDocument: ProjectDocument,
  detectedAt = Date.now()
): CollaborationConflict {
  if (localDocument.projectId !== roomDocument.projectId) {
    throw new ConflictRecoveryError(
      'PROJECT_MISMATCH',
      'Local and room documents belong to different projects.'
    );
  }
  rememberUnresolvedConflict({
    projectId: localDocument.projectId,
    localVersion: localDocument.version,
    roomVersion: roomDocument.version,
    detectedAt
  });
  return {
    projectId: localDocument.projectId,
    localDocument: structuredClone(localDocument),
    roomDocument: structuredClone(roomDocument),
    expectedRoomVersion: roomDocument.version
  };
}

/**
 * Resolve an explicit user choice. Once authorization and version invariants
 * are known to be valid, every path writes the recovery copy before invoking a
 * handler that can replace either side of the conflict.
 */
export async function resolveCollaborationConflict(
  conflict: CollaborationConflict,
  resolution: ConflictResolution,
  context: ConflictResolutionContext,
  handlers: ConflictResolutionHandlers
): Promise<void> {
  if (
    conflict.projectId !== conflict.localDocument.projectId ||
    conflict.projectId !== conflict.roomDocument.projectId
  ) {
    throw new ConflictRecoveryError(
      'PROJECT_MISMATCH',
      'Conflict documents no longer identify one project.'
    );
  }
  if (conflict.expectedRoomVersion !== conflict.roomDocument.version) {
    throw new ConflictRecoveryError(
      'ROOM_VERSION_MISMATCH',
      'The room version changed before conflict recovery began.'
    );
  }
  if (resolution === 'keep-mine') {
    if (context.role === 'viewer') {
      throw new ConflictRecoveryError(
        'VIEWER_FORBIDDEN',
        'Viewers cannot replace the room version.'
      );
    }
    const now = context.now ?? Date.now();
    if (
      !context.lease ||
      context.lease.projectId !== conflict.projectId ||
      context.lease.expiresAt <= now
    ) {
      throw new ConflictRecoveryError(
        'LEASE_REQUIRED',
        'Keeping the local version requires an active project edit lease.'
      );
    }
  }

  await handlers.writeRecoveryCopy(structuredClone(conflict.localDocument));

  if (resolution === 'use-room') {
    await handlers.useRoomVersion(structuredClone(conflict.roomDocument));
  } else if (resolution === 'keep-mine') {
    await handlers.keepMyVersion({
      document: structuredClone(conflict.localDocument),
      expectedRoomVersion: conflict.expectedRoomVersion,
      leaseId: context.lease!.leaseId
    });
  } else {
    await handlers.saveLocalAsCopy(structuredClone(conflict.localDocument));
    await handlers.useRoomVersion(structuredClone(conflict.roomDocument));
  }
}
