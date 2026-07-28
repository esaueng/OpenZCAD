import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  DisplayMode,
  ProjectionMode,
  ViewerSettings,
  ViewportCameraState
} from '@openzcad/viewport';
import { loadProjectView, saveProjectView } from '../lib/workspaceSession';

/** What a project falls back to when it has no remembered view. */
export interface ProjectViewDefaults {
  projection: ProjectionMode;
  showGrid: boolean;
  displayMode: DisplayMode;
  reducedMotion: boolean;
  zoomToCursor: boolean;
}

export interface ProjectView {
  projection: ProjectionMode;
  setProjection: Dispatch<SetStateAction<ProjectionMode>>;
  settings: ViewerSettings;
  setSettings: Dispatch<SetStateAction<ViewerSettings>>;
  /** Camera pose handed to the viewport before its first automatic fit. */
  initialView: ViewportCameraState | null;
  hiddenBodyIds: ReadonlySet<string>;
  setHiddenBodyIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** Applies a project's remembered view, falling back to the defaults. */
  restore(projectId: string, defaults: ProjectViewDefaults): void;
  /** The viewport reported a new pose; persist it against this project. */
  onCameraChange(projectId: string | null, camera: ViewportCameraState): void;
  /** Closing a project: drop the remembered pose so the next one refits. */
  forget(): void;
}

/**
 * Per-project viewport preferences — camera pose, projection, display
 * settings, and which bodies are hidden — and their persistence.
 *
 * Two things used to write the same payload from different places: the
 * viewport reporting a new camera pose, and an effect watching the settings
 * that surround it. They now share one writer, so a field added to a saved
 * view cannot be persisted by one path and forgotten by the other.
 */
export function useProjectView(projectId: string | null): ProjectView {
  const [projection, setProjection] = useState<ProjectionMode>('perspective');
  const [settings, setSettings] = useState<ViewerSettings>({
    showGrid: true,
    displayMode: 'shaded-edges'
  });
  const [initialView, setInitialView] = useState<ViewportCameraState | null>(
    null
  );
  const [hiddenBodyIds, setHiddenBodyIds] = useState<ReadonlySet<string>>(
    new Set()
  );
  /**
   * The last pose the viewport reported. Held in a ref because the settings
   * effect below needs to persist it without re-running on every orbit.
   */
  const cameraRef = useRef<ViewportCameraState | null>(null);

  function persist(
    id: string,
    camera: ViewportCameraState,
    next?: Partial<{
      projection: ProjectionMode;
      settings: ViewerSettings;
      hiddenBodyIds: ReadonlySet<string>;
    }>
  ) {
    saveProjectView(id, {
      camera,
      projection: next?.projection ?? projection,
      settings: next?.settings ?? settings,
      hiddenBodyIds: [...(next?.hiddenBodyIds ?? hiddenBodyIds)]
    });
  }

  // Persist when the surrounding view settings change. The camera itself is
  // saved as it moves, through `onCameraChange`.
  useEffect(() => {
    const camera = cameraRef.current;
    if (!projectId || !camera) {
      return;
    }
    persist(projectId, camera);
    // `persist` reads the current projection/settings/hidden set directly.
    // Only the fields worth re-persisting on are listed.
  }, [
    projectId,
    hiddenBodyIds,
    projection,
    settings.displayMode,
    settings.showGrid
  ]);

  return {
    projection,
    setProjection,
    settings,
    setSettings,
    initialView,
    hiddenBodyIds,
    setHiddenBodyIds,
    restore(id, defaults) {
      const saved = loadProjectView(id);
      const camera = saved?.camera ?? null;
      cameraRef.current = camera;
      setInitialView(camera);
      setProjection(saved?.projection ?? defaults.projection);
      setSettings({
        showGrid: defaults.showGrid,
        displayMode: defaults.displayMode,
        ...saved?.settings,
        reducedMotion: defaults.reducedMotion,
        zoomToCursor: defaults.zoomToCursor
      });
      setHiddenBodyIds(new Set(saved?.hiddenBodyIds ?? []));
    },
    onCameraChange(id, camera) {
      cameraRef.current = camera;
      if (id) {
        persist(id, camera);
      }
    },
    forget() {
      cameraRef.current = null;
      setInitialView(null);
    }
  };
}
