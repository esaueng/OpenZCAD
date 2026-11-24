import {
  VIEWPORT_FIELD_OF_VIEW_BOUNDS,
  type UnitSystem
} from '@openzcad/shared';
import type {
  DisplayMode,
  ProjectionMode,
  SectionViewSettings,
  ViewportCameraState
} from '@openzcad/viewport';
import {
  isStoredUnit,
  scaledCameraPose,
  scaledSectionView,
  storedUnitFactor
} from './storedUnitView';

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
  /** Captured camera angle; absent in older saved views. */
  fieldOfView?: number;
  /**
   * I03: the project's stored unit when the view was saved; the camera and
   * section are lengths in it. Absent in views saved before it was
   * recorded: those are stamped when the project next opens or converts
   * here, with the unit they are known to be in, or `'unknown'` when that
   * cannot be told (converted elsewhere, or no history to rule it out). An
   * unknown view is shown as saved and never stamped later.
   */
  units?: UnitSystem | 'unknown';
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

function readAll(
  storage: StorageLike | null,
  requireReadable = false
): Record<string, SavedView[]> {
  try {
    const raw = storage?.getItem(SAVED_VIEWS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, SavedView[]>)
      : {};
  } catch (error) {
    if (requireReadable) throw error;
    return {};
  }
}

const isVector = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isPositive = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Absent, or an angle the field-of-view preference could have produced. */
const isFieldOfView = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= VIEWPORT_FIELD_OF_VIEW_BOUNDS.min &&
    value <= VIEWPORT_FIELD_OF_VIEW_BOUNDS.max);

/** Absent (right way up), or a finite direction the camera held as up. */
const isUp = (value: unknown): boolean =>
  value === undefined ||
  (isVector(value) && Math.hypot(...(value as number[])) > 1e-9);

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
    Number.isFinite(section.offset) &&
    (section.flipped === undefined || typeof section.flipped === 'boolean')
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
    (view.xray === undefined || typeof view.xray === 'boolean') &&
    isFieldOfView(view.fieldOfView) &&
    isFieldOfView(view.camera.fieldOfView) &&
    isUp(view.camera.up) &&
    (view.units === undefined ||
      view.units === 'unknown' ||
      isStoredUnit(view.units))
  );
}

/**
 * The view to show in a project stored in `units`: the same view of the
 * same part, its camera and section rescaled when it was saved in another
 * unit (the project was converted since). An unstamped view is taken to be
 * in `units` already.
 */
export function savedViewInUnits(
  view: SavedView,
  units: UnitSystem
): SavedView {
  if (!isStoredUnit(view.units) || view.units === units) return view;
  const factor = storedUnitFactor(view.units, units);
  return {
    ...view,
    units,
    camera: scaledCameraPose(view.camera, factor),
    ...(view.sectionView
      ? { sectionView: scaledSectionView(view.sectionView, factor) }
      : {})
  };
}

/**
 * Records the known unit, or `'unknown'`, on older unstamped project views.
 * Existing markers are preserved. Returns false when view storage cannot be
 * read or written.
 */
export function stampSavedViewUnits(
  projectId: string,
  units: UnitSystem | 'unknown',
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!storage) return false;
  try {
    const all = readAll(storage, true);
    const views = all[projectId];
    if (!Array.isArray(views)) return true;
    const unstamped = (view: SavedView) =>
      isSavedView(view) && view.units === undefined;
    if (!views.some(unstamped)) return true;
    all[projectId] = views.map((view) =>
      unstamped(view) ? { ...view, units } : view
    );
    storage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
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

/** The longest name a saved view keeps; the flyout row is one line. */
export const SAVED_VIEW_NAME_MAX = 40;

/**
 * Renames a saved view. A blank name keeps the old one. The views after the
 * change, or null when the browser refused the write.
 */
export function renameSavedView(
  projectId: string,
  viewId: string,
  name: string,
  storage: StorageLike | null = defaultStorage()
): SavedView[] | null {
  const views = loadSavedViews(projectId, storage);
  const trimmed = name.trim().slice(0, SAVED_VIEW_NAME_MAX);
  if (!trimmed) return views;
  const next = views.map((view) =>
    view.id === viewId ? { ...view, name: trimmed } : view
  );
  return write(projectId, next, storage) ? next : null;
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
