import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react';
import type {
  DisplayMode,
  ProjectionMode,
  SectionViewSettings,
  ViewerSettings,
  ViewportCameraState
} from '@openzcad/viewport';
import {
  loadProjectView,
  saveProjectView,
  type ProjectViewState
} from '../lib/workspaceSession';

/** What a project falls back to when it has no remembered view. */
export interface ProjectViewDefaults {
  projection: ProjectionMode;
  showGrid: boolean;
  displayMode: DisplayMode;
  reducedMotion: boolean;
  zoomToCursor: boolean;
  middleDrag: 'pan' | 'orbit' | 'zoom';
  pointerNavigation: 'auto' | 'mouse' | 'trackpad';
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
  /**
   * Sketches shown or hidden by hand on this device, by sketch id; a sketch
   * with no entry follows the default (hidden once a feature consumes it).
   */
  sketchVisibility: Readonly<Record<string, boolean>>;
  setSketchVisibility: Dispatch<
    SetStateAction<Readonly<Record<string, boolean>>>
  >;
  /** Applies a project's remembered view, falling back to the defaults. */
  restore(projectId: string, defaults: ProjectViewDefaults): void;
  /** The viewport reported a live pose; keep it immediately available. */
  onCameraChange(projectId: string | null, camera: ViewportCameraState): void;
  /** The viewport pose settled; persist the final pose against this project. */
  onCameraSettled(projectId: string | null, camera: ViewportCameraState): void;
  /** Persist a settled cut; intermediate slider frames remain in memory. */
  persistSection(section: SectionViewSettings | undefined): void;
  apply(view: ProjectViewState): void;
  snapshot(): ProjectViewState | null;
  /** Closing a project: drop the remembered pose so the next one refits. */
  forget(): void;
}

const NO_SKETCH_VISIBILITY: Readonly<Record<string, boolean>> = {};

/**
 * Per-project viewport preferences — camera pose, projection, display
 * settings, which bodies are hidden and which sketches were shown or hidden
 * by hand — and their persistence. All of it is this device's view, kept
 * beside the document and never in it.
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
  const [sketchVisibility, setSketchVisibility] =
    useState<Readonly<Record<string, boolean>>>(NO_SKETCH_VISIBILITY);
  /**
   * The last pose the viewport reported. Held in a ref because the settings
   * effect below needs to persist it without re-running on every orbit.
   */
  const cameraRef = useRef<ViewportCameraState | null>(null);
  // A reload can interrupt the controller's damping/settle timer. Keep its
  // latest pose on pagehide too; idle frames still never write storage.
  const flushView = useRef<() => void>(() => {});
  flushView.current = () => {
    if (projectId && cameraRef.current) persist(projectId, cameraRef.current);
  };
  useEffect(() => {
    const flush = () => flushView.current();
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

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
      hiddenBodyIds: [...(next?.hiddenBodyIds ?? hiddenBodyIds)],
      ...(Object.keys(sketchVisibility).length > 0
        ? { sketchVisibility: { ...sketchVisibility } }
        : {})
    });
  }

  // Persist when the surrounding view settings change. Gesture-time camera
  // changes only refresh `cameraRef`; their final pose is saved through
  // `onCameraSettled` once the controller reports that motion has stopped.
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
    sketchVisibility,
    projection,
    settings.displayMode,
    settings.showGrid,
    settings.xray
  ]);

  return {
    projection,
    setProjection,
    settings,
    setSettings,
    initialView,
    hiddenBodyIds,
    setHiddenBodyIds,
    sketchVisibility,
    setSketchVisibility,
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
        zoomToCursor: defaults.zoomToCursor,
        middleDrag: defaults.middleDrag,
        pointerNavigation: defaults.pointerNavigation
      });
      setHiddenBodyIds(new Set(saved?.hiddenBodyIds ?? []));
      setSketchVisibility(saved?.sketchVisibility ?? NO_SKETCH_VISIBILITY);
    },
    onCameraChange(_id, camera) {
      cameraRef.current = camera;
    },
    onCameraSettled(id, camera) {
      cameraRef.current = camera;
      if (id) {
        persist(id, camera);
      }
    },
    persistSection(sectionView) {
      const camera = cameraRef.current;
      if (projectId && camera) {
        persist(projectId, camera, {
          settings: { ...settings, sectionView }
        });
      }
    },
    snapshot() {
      return cameraRef.current
        ? {
            camera: cameraRef.current,
            projection,
            settings,
            hiddenBodyIds: [...hiddenBodyIds],
            ...(Object.keys(sketchVisibility).length > 0
              ? { sketchVisibility: { ...sketchVisibility } }
              : {})
          }
        : null;
    },
    apply(view) {
      cameraRef.current = view.camera;
      setInitialView(view.camera);
      setProjection(view.projection);
      setSettings((current) => ({ ...current, ...view.settings }));
      setHiddenBodyIds(new Set(view.hiddenBodyIds));
      // A view from another device carries no sketch choices; this device's
      // own stay, and are written back with the applied view.
      const sketches = view.sketchVisibility ?? sketchVisibility;
      if (view.sketchVisibility) setSketchVisibility(view.sketchVisibility);
      if (projectId) {
        saveProjectView(projectId, {
          ...view,
          ...(Object.keys(sketches).length > 0
            ? { sketchVisibility: { ...sketches } }
            : {})
        });
      }
    },
    forget() {
      cameraRef.current = null;
      setInitialView(null);
    }
  };
}
