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
}

export type ConflictResolution = 'use-remote' | 'keep-mine' | 'save-local-copy';

/** Whether an explicit Keep both request saved a local project. */
export interface ConflictResolutionOutcome {
  localCopy: 'not-requested' | 'saved' | 'already-saved';
}

export interface ConflictResolutionHandlers {
  useRemoteVersion(
    document: ProjectDocument,
    outcome: ConflictResolutionOutcome
  ): Promise<void> | void;
  keepMyVersion(
    input: {
      document: ProjectDocument;
      expectedRemoteVersion: number;
      /** Absent outside a room, where nothing hands out leases. */
      leaseId?: string;
    },
    outcome: ConflictResolutionOutcome
  ): Promise<void> | void;
  /** Persist a new project before replacing the local original. */
  saveLocalAsCopy(document: ProjectDocument): Promise<string>;
  /** Check durable storage, since a saved retry copy may have been deleted. */
  localCopyExists(projectId: string): Promise<boolean>;
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
  // the original detection time for the same divergence.
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
    detectedAt: sameDivergence ? existing.detectedAt : detectedAt
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
 * The same question, asked about the document now on screen. When a re-check
 * cannot reach the remote, the open question must not keep citing the local
 * copy from before an intervening choice: "Keep mine" would then write that
 * superseded copy back. The remote side and its version fence stay as last
 * seen, so a stale remote still cannot be overwritten blindly.
 */
export function reaskConflict(
  conflict: ProjectConflict,
  localDocument: ProjectDocument
): ProjectConflict {
  if (localDocument.projectId !== conflict.projectId) return conflict;
  return {
    ...conflict,
    localDocument: structuredClone(localDocument)
  };
}

/** Only Keep both should claim that a separate project exists. */
export function conflictCopyNote(outcome: ConflictResolutionOutcome): string {
  return outcome.localCopy === 'not-requested'
    ? ''
    : '; your changes were kept as a separate project';
}
