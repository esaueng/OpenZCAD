import type {
  DisplayMode,
  ProjectionMode,
  ViewerSettings,
  ViewportCameraState
} from '@openzcad/viewport';

export type { ViewportCameraState };

type Vector3Tuple = ViewportCameraState['position'];

export const WORKSPACE_SESSION_STORAGE_KEY = 'openzcad-workspace-session:v1';

const WORKSPACE_SESSION_VERSION = 1;
const MAX_SAVED_PROJECT_VIEWS = 20;

/**
 * The camera pose lives with the camera controller that produces it; this
 * module only persists it alongside the rest of the session.
 */

export interface ProjectViewState {
  camera: ViewportCameraState;
  projection: ProjectionMode;
  settings: ViewerSettings;
  hiddenBodyIds: string[];
  /**
   * Sketches shown or hidden by hand, by sketch id. Absent from views
   * written before it, and from the cross-device resume state, which keeps
   * this device's own choices; an id with no entry follows the default.
   */
  sketchVisibility?: Record<string, boolean>;
}

interface StoredProjectView extends ProjectViewState {
  updatedAt: number;
}

interface WorkspaceSession {
  version: typeof WORKSPACE_SESSION_VERSION;
  activeProjectId: string | null;
  /**
   * Bumped by every pointer write, so a snapshot sees a write that left the
   * same id behind (A→B→A, or a second return home). Sessions written before
   * it, or by hand, read as 0; the id comparison still catches those.
   */
  pointerRevision: number;
  views: Record<string, StoredProjectView>;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function emptySession(): WorkspaceSession {
  return {
    version: WORKSPACE_SESSION_VERSION,
    activeProjectId: null,
    pointerRevision: 0,
    views: {}
  };
}

function isVector3Tuple(value: unknown): value is Vector3Tuple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) =>
      typeof component === 'number' ? Number.isFinite(component) : false
    )
  );
}

function isProjectionMode(value: unknown): value is ProjectionMode {
  return value === 'perspective' || value === 'orthographic';
}

function isDisplayMode(value: unknown): value is DisplayMode {
  return (
    value === 'shaded-edges' || value === 'shaded' || value === 'wireframe'
  );
}

/**
 * At most this many per project, the newest kept; sketch ids are short, the
 * session small.
 */
const MAX_SKETCH_VISIBILITY_ENTRIES = 500;

/** Only well-formed entries survive; a bad map reads as no choices made. */
function parseSketchVisibility(
  value: unknown
): Record<string, boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      (entry): entry is [string, boolean] =>
        entry[0].length > 0 &&
        entry[0].length <= 200 &&
        typeof entry[1] === 'boolean'
    )
    .slice(-MAX_SKETCH_VISIBILITY_ENTRIES);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** A recorded field of view, or nothing: a bad one reads as unrecorded. */
function withFieldOfView(
  value: unknown
): Pick<ViewportCameraState, 'fieldOfView'> {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value < 180
    ? { fieldOfView: value }
    : {};
}

function parseStoredView(value: unknown): StoredProjectView | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<StoredProjectView>;
  const camera = candidate.camera;
  const settings = candidate.settings;
  if (
    !camera ||
    !isVector3Tuple(camera.position) ||
    !isVector3Tuple(camera.target) ||
    !Number.isFinite(camera.orthographicZoom) ||
    camera.orthographicZoom <= 0 ||
    (camera.orthographicHalfHeight !== undefined &&
      (!Number.isFinite(camera.orthographicHalfHeight) ||
        camera.orthographicHalfHeight <= 0)) ||
    !isProjectionMode(candidate.projection) ||
    !settings ||
    typeof settings.showGrid !== 'boolean' ||
    !isDisplayMode(settings.displayMode) ||
    !Array.isArray(candidate.hiddenBodyIds) ||
    !candidate.hiddenBodyIds.every((id) => typeof id === 'string') ||
    typeof candidate.updatedAt !== 'number' ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    return null;
  }
  return {
    camera: {
      position: [...camera.position],
      target: [...camera.target],
      orthographicZoom: camera.orthographicZoom,
      orthographicHalfHeight: camera.orthographicHalfHeight,
      ...withFieldOfView(camera.fieldOfView)
    },
    projection: candidate.projection,
    settings: {
      ...settings,
      ...(settings.xray === undefined || typeof settings.xray === 'boolean'
        ? {}
        : { xray: false })
    },
    hiddenBodyIds: [...candidate.hiddenBodyIds],
    ...withSketchVisibility(parseSketchVisibility(candidate.sketchVisibility)),
    updatedAt: candidate.updatedAt
  };
}

function withSketchVisibility(
  visibility: Record<string, boolean> | undefined
): Pick<ProjectViewState, 'sketchVisibility'> {
  return visibility ? { sketchVisibility: { ...visibility } } : {};
}

function readSession(storage: StorageLike | null): WorkspaceSession {
  if (!storage) {
    return emptySession();
  }
  try {
    const raw = storage.getItem(WORKSPACE_SESSION_STORAGE_KEY);
    if (!raw) {
      return emptySession();
    }
    const parsed = JSON.parse(raw) as Partial<WorkspaceSession>;
    if (
      parsed.version !== WORKSPACE_SESSION_VERSION ||
      !parsed.views ||
      typeof parsed.views !== 'object'
    ) {
      return emptySession();
    }
    const views = Object.fromEntries(
      Object.entries(parsed.views).flatMap(([projectId, view]) => {
        const valid = parseStoredView(view);
        return projectId && valid ? [[projectId, valid] as const] : [];
      })
    );
    return {
      version: WORKSPACE_SESSION_VERSION,
      activeProjectId:
        typeof parsed.activeProjectId === 'string'
          ? parsed.activeProjectId
          : null,
      pointerRevision:
        typeof parsed.pointerRevision === 'number' &&
        Number.isSafeInteger(parsed.pointerRevision) &&
        parsed.pointerRevision >= 0
          ? parsed.pointerRevision
          : 0,
      views
    };
  } catch {
    return emptySession();
  }
}

function writeSession(
  session: WorkspaceSession,
  storage: StorageLike | null
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

function pointerMovedSince(
  session: WorkspaceSession,
  since: ActiveProjectSnapshot | undefined
): boolean {
  return Boolean(
    since &&
    (session.activeProjectId !== since.activeProjectId ||
      session.pointerRevision !== since.pointerRevision)
  );
}

function withPointer(
  session: WorkspaceSession,
  activeProjectId: string | null
): WorkspaceSession {
  return {
    ...session,
    activeProjectId,
    pointerRevision: session.pointerRevision + 1
  };
}

export function loadActiveProjectId(
  storage: StorageLike | null = defaultStorage()
): string | null {
  return readSession(storage).activeProjectId;
}

/**
 * What the active-project pointer held when an open began. Opening a project
 * awaits storage and the network before it records itself, and in that time
 * another tab (or a test seeding the session) may have pointed the session
 * somewhere newer.
 */
export interface ActiveProjectSnapshot {
  readonly activeProjectId: string | null;
  readonly pointerRevision: number;
}

export function snapshotActiveProject(
  storage: StorageLike | null = defaultStorage()
): ActiveProjectSnapshot {
  const { activeProjectId, pointerRevision } = readSession(storage);
  return { activeProjectId, pointerRevision };
}

/**
 * Points the session at `projectId`. Given the snapshot taken when the open
 * began, this is a compare-and-set: a pointer written since then, even back to
 * the same id, is a newer choice than this open, and is kept.
 */
export function rememberActiveProject(
  projectId: string,
  storage: StorageLike | null = defaultStorage(),
  since?: ActiveProjectSnapshot
): boolean {
  const session = readSession(storage);
  if (pointerMovedSince(session, since)) {
    // Already pointing here is success, but rewriting it would bump the
    // revision and make a newer open's snapshot look stale.
    return session.activeProjectId === projectId;
  }
  return writeSession(withPointer(session, projectId), storage);
}

/** With a snapshot, keeps a pointer written since it, as remembering does. */
export function clearActiveProject(
  storage: StorageLike | null = defaultStorage(),
  since?: ActiveProjectSnapshot
): boolean {
  const session = readSession(storage);
  if (pointerMovedSince(session, since)) {
    return false;
  }
  return writeSession(withPointer(session, null), storage);
}

/** Transfers device view state without changing its recorded camera or time. */
export function rekeyWorkspaceProject(
  sourceProjectId: string,
  targetProjectId: string,
  storage: StorageLike | null = defaultStorage(),
  preserveSource = false
): boolean {
  const session = readSession(storage);
  const views = { ...session.views };
  if (views[sourceProjectId]) {
    views[targetProjectId] = views[sourceProjectId];
    if (!preserveSource) delete views[sourceProjectId];
  }
  return writeSession(
    session.activeProjectId === sourceProjectId
      ? { ...withPointer(session, targetProjectId), views }
      : { ...session, views },
    storage
  );
}

export function loadProjectView(
  projectId: string,
  storage: StorageLike | null = defaultStorage()
): ProjectViewState | null {
  const view = readSession(storage).views[projectId];
  if (!view) {
    return null;
  }
  return {
    camera: {
      position: [...view.camera.position],
      target: [...view.camera.target],
      orthographicZoom: view.camera.orthographicZoom,
      orthographicHalfHeight: view.camera.orthographicHalfHeight,
      ...withFieldOfView(view.camera.fieldOfView)
    },
    projection: view.projection,
    settings: { ...view.settings },
    hiddenBodyIds: [...view.hiddenBodyIds],
    ...withSketchVisibility(view.sketchVisibility)
  };
}

export function saveProjectView(
  projectId: string,
  view: ProjectViewState,
  storage: StorageLike | null = defaultStorage()
): boolean {
  const session = readSession(storage);
  const views = {
    ...session.views,
    [projectId]: { ...view, updatedAt: Date.now() }
  };
  const limitedViews = Object.fromEntries(
    Object.entries(views)
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(-MAX_SAVED_PROJECT_VIEWS)
  );
  return writeSession({ ...session, views: limitedViews }, storage);
}
