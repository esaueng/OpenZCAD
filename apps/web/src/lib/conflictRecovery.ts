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
  source: ConflictSource;
  localVersion: number;
  remoteVersion: number;
  detectedAt: number;
  /**
   * Which sides of THIS divergence have already been preserved as recovery
   * projects, as `side:version` keys. A conflict is re-raised on every room
   * frame while it stays unresolved, and a failed resolution can be retried —
   * without this record each attempt would mint another recovery project.
   */
  recoveryCopies?: string[];
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

/**
 * One marker per (project, source). The room and the account are independent
 * version lines that can diverge from the local document at the same time;
 * a single shared key let each side overwrite the other's recorded versions.
 * encodeURIComponent escapes ':', so the suffix cannot collide with an id.
 */
function markerKey(projectId: string, source: ConflictSource): string {
  return `${CONFLICT_MARKER_PREFIX}${encodeURIComponent(projectId)}:${source}`;
}

/** The pre-source key, still read and cleared so old markers cannot strand. */
function legacyMarkerKey(projectId: string): string {
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
  storage.setItem(
    markerKey(marker.projectId, marker.source),
    JSON.stringify(marker)
  );
}

function parseMarker(
  value: string | null,
  projectId: string,
  source: ConflictSource
): UnresolvedConflictMarker | null {
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
    return { ...marker, source } as UnresolvedConflictMarker;
  } catch {
    return null;
  }
}

export function readUnresolvedConflict(
  projectId: string,
  source: ConflictSource,
  storage: Storage = localStorage
): UnresolvedConflictMarker | null {
  return (
    parseMarker(
      storage.getItem(markerKey(projectId, source)),
      projectId,
      source
    ) ??
    parseMarker(storage.getItem(legacyMarkerKey(projectId)), projectId, source)
  );
}

/** Whether any source — room, account, or a pre-source marker — is unresolved. */
export function hasUnresolvedConflict(
  projectId: string,
  storage: Storage = localStorage
): boolean {
  return (
    readUnresolvedConflict(projectId, 'room', storage) !== null ||
    readUnresolvedConflict(projectId, 'account', storage) !== null
  );
}

export function clearUnresolvedConflict(
  projectId: string,
  source: ConflictSource,
  storage: Storage = localStorage
): void {
  storage.removeItem(markerKey(projectId, source));
  storage.removeItem(legacyMarkerKey(projectId));
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
  // A conflict is re-detected on every inbound frame while unresolved. Keep
  // the original detection time and the record of recovery copies already
  // written for the same divergence; only a new version pair resets them.
  const existing = readUnresolvedConflict(localDocument.projectId, source);
  const sameDivergence =
    existing !== null &&
    existing.localVersion === localDocument.version &&
    existing.remoteVersion === remoteDocument.version;
  rememberUnresolvedConflict({
    projectId: localDocument.projectId,
    source,
    localVersion: localDocument.version,
    remoteVersion: remoteDocument.version,
    detectedAt: sameDivergence ? existing.detectedAt : detectedAt,
    ...(sameDivergence && existing.recoveryCopies
      ? { recoveryCopies: existing.recoveryCopies }
      : {})
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
 * Names a recovery project after its source without letting the labels nest:
 * a copy of "Part (Recovery)" is another "Part (Recovery)", never
 * "Part (Recovery) (Recovery)".
 */
export function recoveryCopyName(
  name: string,
  label: 'Recovery' | 'Local copy'
): string {
  const stripped = name.replace(/(?:\s*\((?:Recovery|Local copy)\))+$/, '');
  return `${stripped.trimEnd() || name} (${label})`;
}

/**
 * Resolve an explicit user choice. Once authorization and version invariants
 * are known to be valid, the side the user is NOT keeping is written as a
 * recovery project before invoking a handler that can replace either side of
 * the conflict — but only once per divergence: the same conflict can be
 * re-raised by every room frame and a failed handler can be retried, and
 * neither may mint another copy of a document already preserved.
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

  // 'keep-mine' discards the remote copy; the other two discard the local one
  // ('save-local-copy' preserves it via this same write).
  const losingSide = resolution === 'keep-mine' ? 'remote' : 'local';
  const losingDocument =
    losingSide === 'remote' ? conflict.remoteDocument : conflict.localDocument;
  const copyKey = `${losingSide}:${losingDocument.version}`;
  const marker = readUnresolvedConflict(conflict.projectId, conflict.source);
  const markerMatches =
    marker !== null &&
    marker.localVersion === conflict.localDocument.version &&
    marker.remoteVersion === conflict.remoteDocument.version;
  const alreadyPreserved =
    markerMatches && (marker.recoveryCopies ?? []).includes(copyKey);
  if (!alreadyPreserved) {
    await handlers.writeRecoveryCopy(structuredClone(losingDocument));
    rememberUnresolvedConflict({
      projectId: conflict.projectId,
      source: conflict.source,
      localVersion: conflict.localDocument.version,
      remoteVersion: conflict.remoteDocument.version,
      detectedAt: markerMatches
        ? marker.detectedAt
        : (context.now ?? Date.now()),
      recoveryCopies: [
        ...(markerMatches ? (marker.recoveryCopies ?? []) : []),
        copyKey
      ]
    });
  }

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
