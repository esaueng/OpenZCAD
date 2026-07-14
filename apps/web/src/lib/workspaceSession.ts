import type {
  DisplayMode,
  ProjectionMode,
  ViewerSettings
} from '../components/ModelViewer';

export const WORKSPACE_SESSION_STORAGE_KEY = 'openzcad-workspace-session:v1';

const WORKSPACE_SESSION_VERSION = 1;
const MAX_SAVED_PROJECT_VIEWS = 20;

type Vector3Tuple = [number, number, number];

export interface ViewportCameraState {
  position: Vector3Tuple;
  target: Vector3Tuple;
  orthographicZoom: number;
}

export interface ProjectViewState {
  camera: ViewportCameraState;
  projection: ProjectionMode;
  settings: ViewerSettings;
  hiddenBodyIds: string[];
}

interface StoredProjectView extends ProjectViewState {
  updatedAt: number;
}

interface WorkspaceSession {
  version: typeof WORKSPACE_SESSION_VERSION;
  activeProjectId: string | null;
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
    value === 'shaded-edges' ||
    value === 'shaded' ||
    value === 'wireframe'
  );
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
      orthographicZoom: camera.orthographicZoom
    },
    projection: candidate.projection,
    settings: { ...settings },
    hiddenBodyIds: [...candidate.hiddenBodyIds],
    updatedAt: candidate.updatedAt
  };
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

export function loadActiveProjectId(
  storage: StorageLike | null = defaultStorage()
): string | null {
  return readSession(storage).activeProjectId;
}

export function rememberActiveProject(
  projectId: string,
  storage: StorageLike | null = defaultStorage()
): boolean {
  const session = readSession(storage);
  return writeSession({ ...session, activeProjectId: projectId }, storage);
}

export function clearActiveProject(
  storage: StorageLike | null = defaultStorage()
): boolean {
  const session = readSession(storage);
  return writeSession({ ...session, activeProjectId: null }, storage);
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
      orthographicZoom: view.camera.orthographicZoom
    },
    projection: view.projection,
    settings: { ...view.settings },
    hiddenBodyIds: [...view.hiddenBodyIds]
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
