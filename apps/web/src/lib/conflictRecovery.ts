import type {
  ProjectAccessRole,
  ProjectDocument,
  ProjectEditLease
} from '@openzcad/shared';

const CONFLICT_MARKER_PREFIX = 'openzcad-unresolved-project-conflict:';

/**
 * Where the divergent copy came from. The resolutions are identical either
 * way — this only decides how the winning document gets written back, and lets
 * the UI name the other side accurately.
 */
export type ConflictSource = 'room' | 'account';

export interface ProjectConflict {
  projectId: string;
  source: ConflictSource;
  localDocument: ProjectDocument;
  remoteDocument: ProjectDocument;
  /** The exact remote version against which a keep-mine write must be based. */
  expectedRemoteVersion: number;
}

export interface UnresolvedConflictMarker {
  projectId: string;
  localVersion: number;
  remoteVersion: number;
  detectedAt: number;
}

export type ConflictResolution = 'use-remote' | 'keep-mine' | 'save-local-copy';

export interface ConflictRecoveryCopyWriter {
  /** Persist the untouched divergent document before any resolution mutates state. */
  writeRecoveryCopy(document: ProjectDocument): Promise<void>;
}

export interface ConflictResolutionHandlers extends ConflictRecoveryCopyWriter {
  useRemoteVersion(document: ProjectDocument): Promise<void> | void;
  keepMyVersion(input: {
    document: ProjectDocument;
    expectedRemoteVersion: number;
    /** Absent outside a room, where nothing hands out leases. */
    leaseId?: string;
  }): Promise<void> | void;
  saveLocalAsCopy(document: ProjectDocument): Promise<void> | void;
}

export interface ConflictResolutionContext {
  role: ProjectAccessRole | null;
  lease: ProjectEditLease | null;
  /**
   * Whether this deployment enforces the project edit lease. A conflict against
   * the account rather than a room has no lease to hold, and demanding one
   * would make the divergence unresolvable.
   */
  leasesEnforced?: boolean;
  now?: number;
}

export class ConflictRecoveryError extends Error {
  constructor(
    readonly code:
      | 'PROJECT_MISMATCH'
      | 'REMOTE_VERSION_MISMATCH'
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
 * reload; the next remote state reconstructs the conflict without putting a CAD
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
      !Number.isSafeInteger(marker.remoteVersion) ||
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
  remoteDocument: ProjectDocument,
  source: ConflictSource = 'room',
  detectedAt = Date.now()
): ProjectConflict {
  if (localDocument.projectId !== remoteDocument.projectId) {
    throw new ConflictRecoveryError(
      'PROJECT_MISMATCH',
      'Local and remote documents belong to different projects.'
    );
  }
  rememberUnresolvedConflict({
    projectId: localDocument.projectId,
    localVersion: localDocument.version,
    remoteVersion: remoteDocument.version,
    detectedAt
  });
  return {
    projectId: localDocument.projectId,
    source,
    localDocument: structuredClone(localDocument),
    remoteDocument: structuredClone(remoteDocument),
    expectedRemoteVersion: remoteDocument.version
  };
}

/**
 * Resolve an explicit user choice. Once authorization and version invariants
 * are known to be valid, every path writes the recovery copy before invoking a
 * handler that can replace either side of the conflict.
 */
export async function resolveProjectConflict(
  conflict: ProjectConflict,
  resolution: ConflictResolution,
  context: ConflictResolutionContext,
  handlers: ConflictResolutionHandlers
): Promise<void> {
  if (
    conflict.projectId !== conflict.localDocument.projectId ||
    conflict.projectId !== conflict.remoteDocument.projectId
  ) {
    throw new ConflictRecoveryError(
      'PROJECT_MISMATCH',
      'Conflict documents no longer identify one project.'
    );
  }
  if (conflict.expectedRemoteVersion !== conflict.remoteDocument.version) {
    throw new ConflictRecoveryError(
      'REMOTE_VERSION_MISMATCH',
      'The remote version changed before conflict recovery began.'
    );
  }
  if (resolution === 'keep-mine') {
    if (context.role === 'viewer') {
      throw new ConflictRecoveryError(
        'VIEWER_FORBIDDEN',
        'Viewers cannot replace the remote version.'
      );
    }
    // A lease is a room concept. Requiring one for a conflict against the
    // account — where none is ever issued — would leave the user with a
    // divergence they are not permitted to resolve.
    const leaseRequired =
      conflict.source === 'room' && context.leasesEnforced !== false;
    const now = context.now ?? Date.now();
    if (
      leaseRequired &&
      (!context.lease ||
        context.lease.projectId !== conflict.projectId ||
        context.lease.expiresAt <= now)
    ) {
      throw new ConflictRecoveryError(
        'LEASE_REQUIRED',
        'Keeping the local version requires an active project edit lease.'
      );
    }
  }

  await handlers.writeRecoveryCopy(structuredClone(conflict.localDocument));

  if (resolution === 'use-remote') {
    await handlers.useRemoteVersion(structuredClone(conflict.remoteDocument));
  } else if (resolution === 'keep-mine') {
    await handlers.keepMyVersion({
      document: structuredClone(conflict.localDocument),
      expectedRemoteVersion: conflict.expectedRemoteVersion,
      ...(context.lease ? { leaseId: context.lease.leaseId } : {})
    });
  } else {
    await handlers.saveLocalAsCopy(structuredClone(conflict.localDocument));
    await handlers.useRemoteVersion(structuredClone(conflict.remoteDocument));
  }
}
