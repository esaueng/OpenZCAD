import type {
  DisplayMode,
  ProjectionMode,
  SectionViewSettings,
  ViewportCameraState
} from '@openzcad/viewport';

/**
 * Named camera views for a project, kept on this device beside the remembered
 * workspace view rather than in the document: a saved view is presentation,
 * and writing it into the model would mark the project as changed (and
 * diverge it from its cloud copy) whenever someone looked at it differently.
 */
export const SAVED_VIEWS_STORAGE_KEY = 'openzcad-saved-views:v1';
export const MAX_SAVED_VIEWS = 8;

export interface SavedView {
  id: string;
  name: string;
  camera: ViewportCameraState;
  projection: ProjectionMode;
  displayMode: DisplayMode;
  /** The section the view was saved with; absent means no section. */
  sectionView?: SectionViewSettings;
  /** Saved in X-ray; absent (older views) means not. */
  xray?: boolean;
  savedAt: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(storage: StorageLike | null): Record<string, SavedView[]> {
  try {
    const raw = storage?.getItem(SAVED_VIEWS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, SavedView[]>)
      : {};
  } catch {
    return {};
  }
}

const isVector = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isPositive = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const DISPLAY_MODES: readonly unknown[] = [
  'shaded-edges',
  'shaded',
  'wireframe'
];
const SECTION_PLANES: readonly unknown[] = ['XY', 'XZ', 'YZ'];

/** Absent, or a canonical plane at a finite offset. */
const isSection = (value: unknown): boolean => {
  if (value === undefined) return true;
  const section = value as SectionViewSettings | null;
  return Boolean(
    section &&
    SECTION_PLANES.includes(section.plane) &&
    typeof section.offset === 'number' &&
    Number.isFinite(section.offset)
  );
};

/**
 * A malformed entry would hand the camera NaN transforms and leave the
 * viewport unusable, so anything short of finite three-number vectors and a
 * finite positive zoom is dropped rather than offered.
 */
function isSavedView(value: unknown): value is SavedView {
  const view = value as SavedView | null;
  return Boolean(
    view &&
    typeof view.id === 'string' &&
    typeof view.name === 'string' &&
    isVector(view.camera?.position) &&
    isVector(view.camera?.target) &&
    isPositive(view.camera?.orthographicZoom) &&
    (view.camera.orthographicHalfHeight === undefined ||
      isPositive(view.camera.orthographicHalfHeight)) &&
    (view.projection === 'perspective' || view.projection === 'orthographic') &&
    DISPLAY_MODES.includes(view.displayMode) &&
    isSection(view.sectionView) &&
    (view.xray === undefined || typeof view.xray === 'boolean')
  );
}

export function loadSavedViews(
  projectId: string,
  storage: StorageLike | null = defaultStorage()
): SavedView[] {
  const views = readAll(storage)[projectId];
  return Array.isArray(views) ? views.filter(isSavedView) : [];
}

function write(
  projectId: string,
  views: SavedView[],
  storage: StorageLike | null
): boolean {
  if (!storage) return false;
  try {
    const all = readAll(storage);
    if (views.length === 0) delete all[projectId];
    else all[projectId] = views;
    storage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export type SaveViewResult =
  | { ok: true; views: SavedView[]; view: SavedView }
  | { ok: false; reason: string };

/** Adds a view named "View n" (the lowest free number), up to the limit. */
export function saveView(
  projectId: string,
  view: Omit<SavedView, 'id' | 'name' | 'savedAt'>,
  options: { storage?: StorageLike | null; now?: number; id?: string } = {}
): SaveViewResult {
  const storage =
    options.storage === undefined ? defaultStorage() : options.storage;
  const existing = loadSavedViews(projectId, storage);
  if (existing.length >= MAX_SAVED_VIEWS) {
    return {
      ok: false,
      reason: `A project keeps up to ${MAX_SAVED_VIEWS} saved views. Delete one to save another.`
    };
  }
  const taken = new Set(existing.map((entry) => entry.name));
  let n = 1;
  while (taken.has(`View ${n}`)) n += 1;
  const saved: SavedView = {
    ...view,
    id: options.id ?? `view_${Math.random().toString(36).slice(2, 10)}`,
    name: `View ${n}`,
    savedAt: options.now ?? Date.now()
  };
  const views = [...existing, saved];
  return write(projectId, views, storage)
    ? { ok: true, views, view: saved }
    : { ok: false, reason: 'This browser is not keeping saved views.' };
}

/** The remaining views, or null when the browser refused the write. */
export function deleteSavedView(
  projectId: string,
  viewId: string,
  storage: StorageLike | null = defaultStorage()
): SavedView[] | null {
  const views = loadSavedViews(projectId, storage).filter(
    (view) => view.id !== viewId
  );
  return write(projectId, views, storage) ? views : null;
}

/** A permanently deleted project takes its saved views with it. */
export function forgetSavedViews(
  projectId: string,
  storage: StorageLike | null = defaultStorage()
): void {
  if (readAll(storage)[projectId]) write(projectId, [], storage);
}
