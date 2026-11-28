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
import type { UnitSystem } from '@openzcad/shared';
import {
  scaledCameraPose,
  scaledSectionView,
  storedUnitFactor
} from '../lib/storedUnitView';
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
  orbitMode: 'free' | 'turntable';
  pointerNavigation: 'auto' | 'mouse' | 'trackpad';
}

type ProjectViewSnapshot = Omit<
  ProjectViewState,
  'camera' | 'hiddenReferences' | 'units'
> & {
  camera: ViewportCameraState;
};

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
  hiddenDatumIds: ReadonlySet<string>;
  setHiddenDatumIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  hiddenReferenceImageIds: ReadonlySet<string>;
  setHiddenReferenceImageIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /**
   * Applies a project's remembered view, falling back to the defaults.
   * `units` is the project's stored unit: a view remembered in another
   * unit (converted since) is rescaled to it. `legacyUnits` is the unit
   * this device last held the project in, when known: a view written
   * before views recorded their unit is taken to be in it (the project may
   * have been converted on another device since), else in `units`.
   * `'unknown'` says the project has been converted but this device cannot
   * tell which unit such a view is in: its camera and section are dropped
   * (the project refits) rather than shown at the wrong scale.
   *
   * A restore of the project already on screen in another unit (an account
   * refresh bringing in a conversion made elsewhere) keeps the view on
   * screen, rescaled, and answers the pose the live camera must land on:
   * the viewer reads `initialView` only when it mounts. Null otherwise.
   */
  restore(
    projectId: string,
    defaults: ProjectViewDefaults,
    units?: UnitSystem,
    legacyUnits?: UnitSystem | 'unknown',
    /**
     * Bodies the document asks a first view to hide (a model shared without
     * history keeps the owner's hidden bodies hidden). Used when this device
     * has no hidden set of its own for the project, or always when
     * `overrideSaved` is set.
     */
    initialHidden?: { bodyIds: readonly string[]; overrideSaved?: boolean }
  ): { pose: ViewportCameraState; projection: ProjectionMode } | null;
  /** The viewport reported a live pose; keep it immediately available. */
  onCameraChange(projectId: string | null, camera: ViewportCameraState): void;
  /** The viewport pose settled; persist the final pose against this project. */
  onCameraSettled(projectId: string | null, camera: ViewportCameraState): void;
  /** Persist a settled cut; intermediate slider frames remain in memory. */
  persistSection(section: SectionViewSettings | undefined): void;
  /**
   * I03: the open project's stored unit changed under the view (a
   * conversion, its undo or redo, a checkpoint restore). Rescales the
   * remembered camera and section to `to` and persists them, and answers
   * what changed, or null when the view was already in `to`. `from` is the
   * unit being left, used when the view has no unit of its own yet.
   */
  rescale(
    from: UnitSystem,
    to: UnitSystem
  ): {
    factor: number;
    camera: ViewportCameraState | null;
    sectionView: SectionViewSettings | undefined;
  } | null;
  apply(view: ProjectViewSnapshot): void;
  /**
   * The project's view as it would be remembered, or null before the
   * viewport reports a pose and while the view is suspended: what is on
   * screen then is not the project's view.
   */
  snapshot(): ProjectViewSnapshot | null;
  /**
   * Something else is on screen in the project's place (a saved version
   * previewed): the project's view is held as it stands, and nothing the
   * view does from here is remembered. The camera, fit, cut, display and
   * visibility choices made meanwhile are of what is on screen, in its
   * stored unit, and writing them under the project would move its own view
   * (a millimetre pose stamped as inches leaves the model out of frame).
   */
  suspend(): void;
  /**
   * Ends a suspension: the held view is put back, and its pose answered so
   * the mounted viewer can land on it (it reads `initialView` only when it
   * mounts). Null when nothing was held, or the project it was held for is
   * no longer the one open.
   */
  resume(): {
    pose: ViewportCameraState | null;
    projection: ProjectionMode;
    sectionView: SectionViewSettings | undefined;
  } | null;
  /** Closing a project: drop the remembered pose so the next one refits. */
  forget(): void;
}

const NO_SKETCH_VISIBILITY: Readonly<Record<string, boolean>> = {};

/**
 * Per-project viewport preferences — camera pose, projection, display
 * settings and object visibility choices — and their persistence. All of it
 * is this device's view, kept beside the document and never in it.
 *
 * Two things used to write the same payload from different places: the
 * viewport reporting a new camera pose, and an effect watching the settings
 * that surround it. They now share one writer, so a field added to a saved
 * view cannot be persisted by one path and forgotten by the other.
 */
export function useProjectView(
  projectId: string | null,
  /**
   * The hidden-body set to save in place of the one on screen, when a
   * temporary view (isolation) hides bodies the user did not choose to hide.
   * The saved view and the account's resume state then carry the user's own
   * set, so a reload never keeps that temporary hiding. It should return a
   * stable set: the save effect re-runs when its identity changes.
   */
  savedHiddenBodyIds?: (onScreen: ReadonlySet<string>) => ReadonlySet<string>,
  /**
   * Asked at each write: false keeps the view on screen without remembering
   * it on this device. A share session whose snapshot carries the id of a
   * project this device knows answers false, so the public session's view
   * never becomes that project's (see `shareSessionKeepsView`).
   */
  keepsView?: (projectId: string) => boolean
): ProjectView {
  const keepsViewRef = useRef(keepsView);
  keepsViewRef.current = keepsView;
  // Read by `resume`, which runs from the render that suspended.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  /**
   * The project's own view while it is suspended; see `suspend`. Its camera
   * and cut are in `unitsRef`'s unit, like the ones on screen otherwise.
   */
  const heldRef = useRef<{
    projectId: string;
    camera: ViewportCameraState | null;
    projection: ProjectionMode;
    showGrid: boolean;
    displayMode: DisplayMode;
    xray: boolean | undefined;
    sectionView: SectionViewSettings | undefined;
    hiddenBodyIds: ReadonlySet<string>;
    sketchVisibility: Readonly<Record<string, boolean>>;
    hiddenDatumIds: ReadonlySet<string>;
    hiddenReferenceImageIds: ReadonlySet<string>;
  } | null>(null);
  /** Every remembered-view write goes through here. */
  function remember(id: string, view: ProjectViewState) {
    // Suspended: the view on screen is not the project's to remember.
    if (heldRef.current) return;
    if (keepsViewRef.current?.(id) === false) return;
    saveProjectView(id, view);
  }
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
  const [hiddenDatumIds, setHiddenDatumIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [hiddenReferenceImageIds, setHiddenReferenceImageIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const savedHiddenReferencesProject = useRef<string | null>(null);
  /**
   * The last pose the viewport reported. Held in a ref because the settings
   * effect below needs to persist it without re-running on every orbit.
   */
  const cameraRef = useRef<ViewportCameraState | null>(null);
  /**
   * The stored unit the camera and section above are in, stamped on every
   * write; null until a restore names one.
   */
  const unitsRef = useRef<UnitSystem | null>(null);
  /** The project the last restore was for. */
  const restoredProjectRef = useRef<string | null>(null);
  // A reload can interrupt the controller's damping/settle timer. Keep its
  // latest pose on pagehide too; idle frames still never write storage.
  const flushView = useRef<() => void>(() => {});
  flushView.current = persistCurrentView;
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

  /**
   * A view whose hidden set the document overrode (a model shared without
   * history, which keeps its owner's project id) saves the set this device
   * already had, never the shared model's own body ids: those would replace
   * the owner's choices for their real project.
   */
  const keptHiddenRef = useRef<{
    projectId: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  const kept = keptHiddenRef.current;
  const savedHidden =
    kept && kept.projectId === projectId
      ? kept.ids
      : (savedHiddenBodyIds?.(hiddenBodyIds) ?? hiddenBodyIds);

  function hiddenReferences(): ProjectViewState['hiddenReferences'] {
    return hiddenDatumIds.size || hiddenReferenceImageIds.size
      ? {
          datumIds: [...hiddenDatumIds],
          imageIds: [...hiddenReferenceImageIds]
        }
      : undefined;
  }

  function persist(
    id: string,
    camera: ViewportCameraState | null,
    next?: Partial<{
      projection: ProjectionMode;
      settings: ViewerSettings;
      hiddenBodyIds: ReadonlySet<string>;
    }>
  ) {
    if (heldRef.current) return;
    const references = hiddenReferences();
    savedHiddenReferencesProject.current = references ? id : null;
    remember(id, {
      camera,
      projection: next?.projection ?? projection,
      settings: next?.settings ?? settings,
      hiddenBodyIds: [...(next?.hiddenBodyIds ?? savedHidden)],
      hiddenReferences: references,
      ...(Object.keys(sketchVisibility).length > 0
        ? { sketchVisibility: { ...sketchVisibility } }
        : {}),
      ...unitsStamp()
    });
  }

  function unitsStamp(): Pick<ProjectViewState, 'units'> {
    return unitsRef.current ? { units: unitsRef.current } : {};
  }

  function persistCurrentView() {
    if (!projectId) return;
    const camera = cameraRef.current;
    // Reference-only projects may have no camera pose yet. Persist their
    // hidden IDs anyway, including when the last hidden object is shown.
    if (
      camera ||
      hiddenDatumIds.size ||
      hiddenReferenceImageIds.size ||
      savedHiddenReferencesProject.current === projectId
    ) {
      persist(projectId, camera);
    }
  }

  // Persist when the surrounding view settings change. Gesture-time camera
  // changes only refresh `cameraRef`; their final pose is saved through
  // `onCameraSettled` once the controller reports that motion has stopped.
  useEffect(persistCurrentView, [
    projectId,
    savedHidden,
    sketchVisibility,
    hiddenDatumIds,
    hiddenReferenceImageIds,
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
    hiddenDatumIds,
    setHiddenDatumIds,
    hiddenReferenceImageIds,
    setHiddenReferenceImageIds,
    restore(id, defaults, units, legacyUnits, initialHidden) {
      // The view restored is the project's from here; nothing is held.
      heldRef.current = null;
      const shownUnits =
        restoredProjectRef.current === id ? unitsRef.current : null;
      const shownCamera = cameraRef.current;
      restoredProjectRef.current = id;
      const saved = loadProjectView(id);
      savedHiddenReferencesProject.current = saved?.hiddenReferences
        ? id
        : null;
      unitsRef.current = units ?? null;
      const ambiguous = Boolean(
        saved && !saved.units && legacyUnits === 'unknown'
      );
      const savedUnits =
        saved?.units ?? (legacyUnits === 'unknown' ? undefined : legacyUnits);
      const factor =
        savedUnits && units ? storedUnitFactor(savedUnits, units) : 1;
      const savedCamera = ambiguous ? null : (saved?.camera ?? null);
      const camera =
        savedCamera && factor !== 1
          ? scaledCameraPose(savedCamera, factor)
          : savedCamera;
      const savedSection = saved?.settings.sectionView;
      const { sectionView: _unknownScale, ...savedSettings } =
        saved?.settings ?? {};
      // The same project, now in another unit: the view on screen stays,
      // rescaled, rather than jumping to whatever was last stored.
      const refreshed =
        shownUnits && units && shownUnits !== units && shownCamera
          ? scaledCameraPose(shownCamera, storedUnitFactor(shownUnits, units))
          : null;
      const projection = saved?.projection ?? defaults.projection;
      cameraRef.current = refreshed ?? camera;
      setInitialView(refreshed ?? camera);
      setProjection(projection);
      setSettings({
        showGrid: defaults.showGrid,
        displayMode: defaults.displayMode,
        ...(ambiguous ? savedSettings : saved?.settings),
        ...(savedSection && !ambiguous && factor !== 1
          ? { sectionView: scaledSectionView(savedSection, factor) }
          : {}),
        reducedMotion: defaults.reducedMotion,
        zoomToCursor: defaults.zoomToCursor,
        middleDrag: defaults.middleDrag,
        orbitMode: defaults.orbitMode,
        pointerNavigation: defaults.pointerNavigation
      });
      keptHiddenRef.current = initialHidden?.overrideSaved
        ? { projectId: id, ids: new Set(saved?.hiddenBodyIds ?? []) }
        : null;
      setHiddenBodyIds(
        new Set(
          initialHidden && (initialHidden.overrideSaved || !saved)
            ? initialHidden.bodyIds
            : (saved?.hiddenBodyIds ?? [])
        )
      );
      setSketchVisibility(saved?.sketchVisibility ?? NO_SKETCH_VISIBILITY);
      setHiddenDatumIds(new Set(saved?.hiddenReferences?.datumIds));
      setHiddenReferenceImageIds(new Set(saved?.hiddenReferences?.imageIds));
      // A view written before views recorded their unit is rewritten now,
      // read or dropped and stamped, so a later open (after a newer copy is
      // cached here) cannot read it in another unit.
      if (saved && !saved.units && units) {
        const { sectionView: _legacy, ...unitFree } = saved.settings;
        const sectionView =
          ambiguous || !savedSection
            ? undefined
            : factor !== 1
              ? scaledSectionView(savedSection, factor)
              : savedSection;
        remember(id, {
          ...saved,
          camera,
          settings: { ...unitFree, ...(sectionView ? { sectionView } : {}) },
          units
        });
      }
      return refreshed ? { pose: refreshed, projection } : null;
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
    rescale(from, to) {
      const factor = storedUnitFactor(unitsRef.current ?? from, to);
      unitsRef.current = to;
      if (factor === 1) return null;
      const held = heldRef.current;
      if (held) {
        // The project's own view follows its unit while it is held; what is
        // on screen in its place is in another document's unit already.
        heldRef.current = {
          ...held,
          camera: held.camera ? scaledCameraPose(held.camera, factor) : null,
          sectionView: held.sectionView
            ? scaledSectionView(held.sectionView, factor)
            : undefined
        };
        return null;
      }
      const camera = cameraRef.current
        ? scaledCameraPose(cameraRef.current, factor)
        : null;
      cameraRef.current = camera;
      const sectionView = settings.sectionView
        ? scaledSectionView(settings.sectionView, factor)
        : undefined;
      setSettings((current) =>
        current.sectionView
          ? {
              ...current,
              sectionView: scaledSectionView(current.sectionView, factor)
            }
          : current
      );
      // The live camera only reports its new pose once the viewport has
      // moved to it; the remembered one is rewritten now, so a reload in
      // between cannot bring back the old unit's numbers.
      if (projectId && camera)
        persist(projectId, camera, { settings: { ...settings, sectionView } });
      return { factor, camera, sectionView };
    },
    snapshot() {
      return cameraRef.current && !heldRef.current
        ? {
            camera: cameraRef.current,
            projection,
            settings,
            hiddenBodyIds: [...savedHidden],
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
      // A view from another device leaves this device's reference visibility
      // choices in place. When it has no sketch choices, those also stay.
      const sketches = view.sketchVisibility ?? sketchVisibility;
      if (view.sketchVisibility) setSketchVisibility(view.sketchVisibility);
      if (projectId) {
        remember(projectId, {
          ...view,
          hiddenReferences: hiddenReferences(),
          ...(Object.keys(sketches).length > 0
            ? { sketchVisibility: { ...sketches } }
            : {}),
          ...unitsStamp()
        });
      }
    },
    forget() {
      heldRef.current = null;
      restoredProjectRef.current = null;
      cameraRef.current = null;
      setInitialView(null);
    },
    suspend() {
      if (!projectId || heldRef.current) return;
      heldRef.current = {
        projectId,
        camera: cameraRef.current,
        projection,
        showGrid: settings.showGrid,
        displayMode: settings.displayMode,
        xray: settings.xray,
        sectionView: settings.sectionView,
        hiddenBodyIds,
        sketchVisibility,
        hiddenDatumIds,
        hiddenReferenceImageIds
      };
    },
    resume() {
      const held = heldRef.current;
      heldRef.current = null;
      if (!held || held.projectId !== projectIdRef.current) return null;
      cameraRef.current = held.camera;
      setProjection(held.projection);
      // Only what a project's view holds: the device's navigation settings
      // changed meanwhile stay as they are.
      setSettings((current) => {
        const { xray: _xray, sectionView: _section, ...rest } = current;
        return {
          ...rest,
          showGrid: held.showGrid,
          displayMode: held.displayMode,
          ...(held.xray !== undefined ? { xray: held.xray } : {}),
          ...(held.sectionView ? { sectionView: held.sectionView } : {})
        };
      });
      setHiddenBodyIds(held.hiddenBodyIds);
      setSketchVisibility(held.sketchVisibility);
      setHiddenDatumIds(held.hiddenDatumIds);
      setHiddenReferenceImageIds(held.hiddenReferenceImageIds);
      return {
        pose: held.camera,
        projection: held.projection,
        sectionView: held.sectionView
      };
    }
  };
}
