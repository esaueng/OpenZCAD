import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps
} from 'react';
import {
  Camera,
  Combine,
  Download,
  Eye,
  FolderOpen,
  Grid3x3,
  Layers3,
  Maximize2,
  Monitor,
  PenLine,
  Move3d,
  Save,
  Settings as SettingsIcon,
  Scissors,
  Spline,
  Trash2,
  TriangleRight,
  Upload
} from 'lucide-react';
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import type {
  CadPatchProposal,
  CadSelectionContext
} from '@openzcad/ai-contracts';
import {
  createProjectDocument,
  duplicateProjectDocument,
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  listParameters,
  normalizeDocument,
  resolveParamValue,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  circleProfile,
  computeSketchProfileAnalysis,
  computeSketchRegions,
  frameForPlaneRef,
  polygonProfile,
  rectangleProfile,
  type PlaneBasis,
  type Vec2
} from '@openzcad/geometry';
import {
  resolveFaceAttachment,
  type FaceAttachmentCandidate
} from '@openzcad/kernel-adapter/face-attachment';
import { parseStepMetadata } from '@openzcad/io-step';
import { parseStl } from '@openzcad/io-stl';
import type {
  ArtifactKind,
  ArtifactRecord,
  BodyId,
  BodyRepresentation,
  EntityId,
  FeatureId,
  FeatureNode,
  FaceGeometry,
  ParamValue,
  ProjectDocument,
  ProjectOrganization,
  ProjectStatus,
  ProjectSummary,
  SketchId,
  SketchNode,
  SketchObjectData,
  SketchPlaneRef,
  TopologySelection,
  UnitSystem
} from '@openzcad/shared';
import {
  applyOrganizationUpdate,
  compareProjectSummaries,
  DEFAULT_PROJECT_ORGANIZATION,
  duplicateProjectName,
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  isFeatureRollbackSuppressed,
  isFeatureSuppressed,
  projectOrganization,
  toProjectId,
  TRASH_RETENTION_DAYS
} from '@openzcad/shared';
import type {
  AppSettings,
  AppSettingsResponse,
  AuthConfigResponse,
  AuthSession,
  HealthResponse
} from '@openzcad/shared';
import { toUserId } from '@openzcad/shared';
import { ApiError, api } from './lib/api';
import { CloudSettingsAutosave } from './lib/cloudSettingsAutosave';
import {
  CloudProjectAutosave,
  type WorkspaceSaveState
} from './lib/cloudProjectAutosave';
import {
  decideProjectSync,
  shouldPollForFreshness
} from './lib/projectSyncDecision';

/**
 * How often an open cloud project checks whether another device has moved it.
 * Focus and reconnect cover the cases that matter most; the interval is the
 * backstop for a tab left open and in front of somebody.
 */
const FRESHNESS_POLL_INTERVAL_MS = 60_000;
import { mark, measure, timed, timedAsync } from './lib/perf';
import { useModalFocus } from './lib/useModalFocus';
import {
  PLANE_LABELS,
  downloadText,
  evalParamValue,
  exportFileStem,
  formatNumber,
  inferContentType
} from './lib/model';
import { useDocumentFonts } from './lib/textFonts';
import { createProjectDiagnosticBundle } from './lib/projectDiagnostics';
import { KERNEL_BUILD } from './lib/kernelBuild';
import {
  SHORTCUT_TO_TOOL,
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  type ToolAvailability,
  type ToolId
} from './lib/tools';
import { AppShell } from './components/AppShell';
import { PanelResizer } from './components/PanelResizer';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopBar } from './components/TopBar';
import { ToolBar } from './components/ToolBar';
import { Sidebar } from './components/Sidebar';
import { Inspector } from './components/Inspector';
import { ModelingOperationsForm } from './components/forms/ModelingOperationsForm';
import { StatusBar } from './components/StatusBar';
import { StartScreen } from './components/StartScreen';
import { StartupScreen } from './components/StartupScreen';
import { SettingsPage, type AuthConfigStatus } from './components/SettingsPage';
import { buildDemoDocument, DEMO_DEFINITIONS } from './lib/demos';
import type { DemoDefinition } from './lib/demos';
import { AssistantPanel } from './components/assistant/AssistantPanel';
import { ProjectSharingDialog } from './components/ProjectSharingDialog';
import { ProjectConflictDialog } from './components/ProjectConflictDialog';
import {
  ExtrudeOverlay,
  MoveOverlay,
  ProfileQuickAction
} from './components/DirectModelingOverlays';
import { composeMoveTransform } from '@openzcad/viewport/move-transform';
import { SELECTION_FILTERS } from '@openzcad/viewport/types';
import { effectiveSelectionFilter } from './lib/selectionFilter';
import { commandPromptText } from './lib/interaction/prompt';
import {
  cylinderRadialFrame,
  isValidCylinderRadius,
  sameCylinderAxis
} from './lib/interaction/cylinderRadius';
import { ToolCard } from './components/ToolCard';
import { NumericKeypad, type KeypadRequest } from './components/NumericKeypad';
import {
  IDLE,
  interactionReducer,
  toolCardFor,
  type FaceTarget
} from './lib/interaction/machine';
import { updateProfileSelection } from './lib/profileSelection';
import {
  isEntityWideProfileSource,
  profileReferencesForSelection
} from './lib/profileReferences';
import type { SelectionActionId } from './lib/interaction/capabilities';
import {
  faceSketchAttachment,
  fixedPlaneRefForLegacyAttachment
} from './lib/faceSketchAttachment';
import { edgeLabel, edgeLength, faceLabel } from './lib/topologyLabels';
import { SketchToolRail } from './components/SketchToolRail';
import { SketchEntityEditor } from './components/SketchEntityEditor';
import { objectPolylines } from './lib/objectPolyline';
import type { RegionPickData } from './components/viewer/regionOverlay';
import {
  CommandPalette,
  type PaletteCommand
} from './components/CommandPalette';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { DISPLAY_MODE_LABELS } from './lib/displayMode';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import { MarkingMenu } from './components/MarkingMenu';
import type {
  ExtrudePreview,
  FaceResizeCommit
} from './components/ModelViewer';
import type {
  SelectionFilter,
  AxisProjection,
  DisplayMode,
  PickDetail,
  SketchOverlay,
  ViewTarget
} from '@openzcad/viewport/types';
import type { MovePreview, MoveSnap } from '@openzcad/viewport';

const LazyViewerShell = lazy(() =>
  import('./components/ViewerShell').then((module) => ({
    default: module.ViewerShell
  }))
);

function ViewerShell(props: ComponentProps<typeof LazyViewerShell>) {
  return (
    <Suspense
      fallback={
        <div className="viewer" role="status" aria-live="polite">
          Loading 3D viewport…
        </div>
      }
    >
      <LazyViewerShell {...props} />
    </Suspense>
  );
}
import {
  chooseProjectDocument,
  clearAllLastSyncedVersions,
  deleteLocalProject,
  listLocalProjectOrganizations,
  listLocalProjects,
  loadLastSyncedVersion,
  loadLocalProject,
  purgeExpiredLocalProjects,
  saveLastSyncedVersion,
  saveLocalProjectOrganization,
  selectProjectDocument,
  saveLocalProject
} from './lib/localProjectStore';
import {
  applyLocalProjectOrganizations,
  mergeProjectSummaries
} from './lib/projectShelf';
import { LivePreview } from './lib/livePreview';
import { errorMessage } from './lib/errors';
import { describeSyncFailure, type SyncEntry } from './lib/syncRun';
import { useGeometryWorker } from './hooks/useGeometryWorker';
import { useProjectView } from './hooks/useProjectView';
import { useDirectEditCommit } from './hooks/useDirectEditCommit';
import { useValidatedFeatureCommit } from './hooks/useValidatedFeatureCommit';
import { useCollaboration } from './lib/useCollaboration';
import { preflightCadPatch } from './lib/aiPatchPreflight';
import {
  clearUnresolvedConflict,
  conflictFromDocuments,
  readUnresolvedConflict,
  resolveProjectConflict,
  type ConflictResolution,
  type ConflictResolutionHandlers,
  type ProjectConflict
} from './lib/conflictRecovery';
import {
  modelingFaceOptions,
  modelingOperationDisabledReason,
  type ModelingOperationKind,
  type ModelingOperationSubmission
} from './lib/modelingOperations';
import {
  clearActiveProject,
  loadActiveProjectId,
  rememberActiveProject,
  type ViewportCameraState
} from './lib/workspaceSession';
import {
  defaultAppSettings,
  loadLocalAppSettingsRecord,
  saveLocalAppSettings,
  shouldAdoptAccountSettings
} from './lib/appSettings';
import {
  loadPanelState,
  savePanelState,
  toggleSidebarSection,
  type PanelState,
  type SidebarSectionId
} from './lib/panelState';
import {
  ASSISTANT_WIDTH_LIMITS,
  clampAssistantWidth,
  clampSidebarWidth,
  maxAssistantWidth,
  maxSidebarWidth,
  savedPanelWidths,
  SIDEBAR_WIDTH_LIMITS
} from './lib/panelWidths';

const localUserId = toUserId('user_local_browser');
const MAX_EMBEDDED_STEP_BYTES = 12 * 1024 * 1024;
const DISPLAY_MODE_ORDER: DisplayMode[] = [
  'shaded-edges',
  'shaded',
  'wireframe'
];

/** Start-screen summary of a document held on this device. */
function summarizeLocalDocument(
  document: ProjectDocument,
  organization?: ProjectOrganization
): ProjectSummary {
  return {
    projectId: document.projectId,
    name: document.name,
    lastRevisionId: document.revisions.at(-1)?.revisionId,
    updatedAt: document.derived.updatedAt,
    revisionCount: document.checkpoints.length,
    ...(organization ? { organization } : {})
  };
}

/**
 * Every project this device can reach. Device shelf state is reconciled before
 * expired local copies are purged so a temporarily failed cloud mirror cannot
 * resurrect a project after its local retention window closes.
 */
async function loadProjectSummaries(signedIn: boolean): Promise<{
  projects: ProjectSummary[];
  remoteReached: boolean;
  /**
   * Which of `projects` the account actually holds. Everything else exists on
   * this device alone and can be adopted. Empty when the listing never reached
   * the account, which is why callers must pair it with `remoteReached` rather
   * than reading an absence as "local-only".
   */
  cloudProjectIds: Set<string>;
}> {
  const [local, localOrganizations, remote] = await Promise.all([
    listLocalProjects().catch(() => []),
    listLocalProjectOrganizations().catch(
      () => new Map<string, ProjectOrganization>()
    ),
    signedIn ? api.listProjects().catch(() => null) : Promise.resolve(null)
  ]);
  const remoteProjects = remote?.projects ?? [];
  const mirrorFailures = remote
    ? await reconcileRemoteOrganizations(localOrganizations, remoteProjects)
    : new Set<string>();
  // While signed in but offline, defer irreversible local purging until the
  // cloud copy can be reconciled. Otherwise a failed mirror could later make
  // an active remote row reappear after the local tombstone was destroyed.
  const purgedProjectIds =
    !signedIn || remote
      ? await purgeExpiredLocalProjects(Date.now(), mirrorFailures).catch(
          () => []
        )
      : [];
  const remoteIds = new Set(remoteProjects.map((project) => project.projectId));
  const purged = new Set(purgedProjectIds);
  const projects = applyLocalProjectOrganizations(
    mergeProjectSummaries(local, remoteProjects),
    localOrganizations
  ).filter(
    (project) =>
      !purged.has(project.projectId) || remoteIds.has(project.projectId)
  );
  return {
    projects,
    remoteReached: Boolean(remote),
    cloudProjectIds: remoteIds
  };
}

function sameWritableOrganization(
  left: ProjectOrganization,
  right: ProjectOrganization
): boolean {
  return (
    left.status === right.status &&
    left.pinned === right.pinned &&
    left.sortOrder === right.sortOrder
  );
}

/**
 * Adopts account metadata only when this device has none. Once the device has
 * organised a project, its copy stays authoritative and any failed account
 * mirror is retried on the next successful listing.
 */
async function reconcileRemoteOrganizations(
  local: ReadonlyMap<string, ProjectOrganization>,
  remote: ProjectSummary[]
): Promise<Set<string>> {
  const mirrorFailures = new Set<string>();
  await Promise.all(
    remote.map(async (project) => {
      const localOrganization = local.get(project.projectId);
      if (!localOrganization) {
        if (project.organization) {
          await saveLocalProjectOrganization(
            project.projectId,
            project.organization
          ).catch(() => undefined);
        }
        return;
      }
      if (
        sameWritableOrganization(
          localOrganization,
          projectOrganization(project)
        )
      ) {
        return;
      }
      try {
        await api.updateProject({
          projectId: toProjectId(project.projectId),
          status: localOrganization.status,
          pinned: localOrganization.pinned,
          sortOrder: localOrganization.sortOrder
        });
      } catch {
        mirrorFailures.add(project.projectId);
      }
    })
  );
  return mirrorFailures;
}

function localRecoveryCopy(
  source: ProjectDocument,
  label: 'Recovery' | 'Local copy'
): ProjectDocument {
  const copy = structuredClone(source);
  const projectId = toProjectId(`proj_recovery_${crypto.randomUUID()}`);
  const name = `${source.name} (${label})`;
  copy.projectId = projectId;
  copy.name = name;
  copy.revisions = [];
  copy.checkpoints = [];
  copy.derived.updatedAt = new Date().toISOString();
  const root = copy.nodes[copy.rootNodeId];
  if (root?.kind === 'project') {
    root.projectId = projectId;
    root.name = name;
    root.revisionId = null;
  }
  return copy;
}

function resolvedSketchPlaneBasis(
  document: ProjectDocument,
  planeRef: SketchPlaneRef,
  resolveOffset: (value: ParamValue) => number,
  sketchName: string
): PlaneBasis {
  if (planeRef.type !== 'face' || !planeRef.faceReference) {
    return frameForPlaneRef(planeRef, resolveOffset);
  }
  const body = document.derived.bodyRepresentations[planeRef.bodyId];
  const candidates: FaceAttachmentCandidate[] = (body?.topology?.faces ?? [])
    .filter(
      (face) => face.reference?.kind === 'face' && face.geometry !== undefined
    )
    .map((face) => {
      const reference = face.reference!;
      const geometry = face.geometry!;
      return {
        kind: 'face',
        currentHash: face.hash,
        witnessVersion: 1,
        witness: reference.witness,
        plane:
          geometry.surfaceType.toLowerCase() === 'plane' && geometry.normal
            ? { center: geometry.center, normal: geometry.normal }
            : null,
        lineage: {
          source: 'derived',
          identity: {
            producingFeatureId: reference.producingFeatureId,
            lineageName: reference.lineageName
          }
        }
      };
    });
  const sourceFeature = listFeaturesInOrder(document).find(
    (feature) =>
      feature.featureId === planeRef.faceReference?.producingFeatureId
  );
  const frame = resolveFaceAttachment({
    reference: planeRef.faceReference,
    candidates,
    snapshot: {
      sourceArea: planeRef.sourceArea,
      sourceCenter: planeRef.sourceCenter,
      sourceNormal: planeRef.sourceNormal,
      frame: planeRef.frame
    },
    sketchName,
    sourceFeatureName:
      sourceFeature?.name ?? String(planeRef.faceReference.producingFeatureId)
  });
  return {
    origin: frame.origin,
    u: frame.xAxis,
    v: frame.yAxis,
    normal: frame.zAxis
  };
}

export function App() {
  /**
   * What was on this device at mount, read once. The account fetch resolves
   * long after the settings-persistence effect has already written to storage,
   * so re-reading it there would always look locally-edited.
   */
  const bootSettingsRef = useRef(loadLocalAppSettingsRecord());
  const [appSettings, setAppSettings] = useState<AppSettings>(
    () => bootSettingsRef.current?.settings ?? defaultAppSettings()
  );
  const appSettingsRef = useRef(appSettings);
  appSettingsRef.current = appSettings;
  /**
   * The account revision `appSettings` is in step with, or null once edited
   * here without being saved. Persisted with the settings so a reload can tell
   * an unsaved local change from a stale cache of the account copy.
   */
  const syncedRevisionRef = useRef<number | null>(
    bootSettingsRef.current?.syncedRevision ?? null
  );
  // The active-project pointer is synchronous knowledge. Reading it lazily
  // lets the first render choose a stable restore surface instead of mounting
  // the launcher while IndexedDB and the optional cloud copy are still loading.
  const [startupProjectId] = useState<string | null>(() =>
    appSettings.general.reopenLastProject ? loadActiveProjectId() : null
  );
  const [startupState, setStartupState] = useState<'restoring' | 'ready'>(() =>
    startupProjectId ? 'restoring' : 'ready'
  );
  const shellMarkedRef = useRef(false);
  useLayoutEffect(() => {
    if (shellMarkedRef.current) {
      return;
    }
    shellMarkedRef.current = true;
    mark('app.mounted');
    measure('startup.shell', 'bundle.evaluated', 'app.mounted');
  }, []);
  const [accountSettings, setAccountSettings] =
    useState<AppSettingsResponse | null>(null);
  const accountSettingsRef = useRef(accountSettings);
  accountSettingsRef.current = accountSettings;
  const [authConfig, setAuthConfig] = useState<AuthConfigResponse | null>(null);
  const [authConfigStatus, setAuthConfigStatus] =
    useState<AuthConfigStatus>('loading');
  const [panelState, setPanelState] = useState<PanelState>(() =>
    loadPanelState()
  );
  // Collapsing the assistant is chrome layout, so it is remembered with the
  // rest of it rather than reset on every reload.
  const assistantCollapsed = panelState.assistantCollapsed;
  const setAssistantCollapsed = useCallback((collapsed: boolean) => {
    setPanelState((current) => ({ ...current, assistantCollapsed: collapsed }));
  }, []);
  const workspaceRef = useRef<HTMLElement | null>(null);
  // Panel widths are capped against the window, so a narrower window has to
  // recompute them. The stored preference is never rewritten by a resize: it is
  // what the user asked for, and it applies again on a screen that can hold it.
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 0
  );
  useEffect(() => {
    const onResize = () => setWindowWidth(globalThis.innerWidth);
    onResize();
    globalThis.addEventListener('resize', onResize);
    return () => globalThis.removeEventListener('resize', onResize);
  }, []);
  const savedWidths = savedPanelWidths(appSettings);
  const sidebarWidth = clampSidebarWidth(savedWidths.sidebar, windowWidth);
  const assistantWidth = clampAssistantWidth(
    savedWidths.assistant,
    windowWidth
  );
  /**
   * The width under the pointer, written straight to the grid. A drag emits one
   * of these a frame; sending them through React would re-render the editor and
   * the viewport with them, which is what makes a splitter feel heavy.
   */
  const previewPanelWidth = useCallback(
    (variable: '--sidebar-w' | '--assistant-w', width: number) => {
      workspaceRef.current?.style.setProperty(variable, `${width}px`);
    },
    []
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsDialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(settingsDialogRef, {
    enabled: settingsOpen,
    autoFocus: true
  });
  const [sharingOpen, setSharingOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState(
    'Changes save on this device immediately.'
  );
  const cloudSettingsAutosaveRef = useRef<CloudSettingsAutosave | null>(null);
  const cloudProjectAutosaveRef = useRef<CloudProjectAutosave | null>(null);
  const cloudSettingsSessionUserRef = useRef<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  // Named `doc` (not `document`) so the global DOM document is never shadowed.
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [selectedFeatureNodeId, setSelectedFeatureNodeId] = useState<
    string | null
  >(null);
  const [selectedTopology, setSelectedTopology] =
    useState<TopologySelection | null>(null);
  // Viewport-only edge picks for one fillet/chamfer feature. The document
  // remains the source of truth once the command is committed.
  const [selectedEdges, setSelectedEdges] = useState<TopologySelection[]>([]);
  /** Null means the active tool decides what picking is narrowed to. */
  const [manualSelectionFilter, setManualSelectionFilter] =
    useState<SelectionFilter | null>(null);
  // Viewport body selection in pick order; drives boolean/move pre-fills.
  const [selectedBodyIds, setSelectedBodyIds] = useState<BodyId[]>([]);
  const [selectedSketchProfileId, setSelectedSketchProfileId] =
    useState<SketchId | null>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<RegionPickData[]>(
    []
  );
  const selectedProfilesRef = useRef(selectedProfiles);
  selectedProfilesRef.current = selectedProfiles;
  const [extrudePreview, setExtrudePreview] = useState<ExtrudePreview | null>(
    null
  );
  const extrudePreviewRef = useRef(extrudePreview);
  extrudePreviewRef.current = extrudePreview;
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  /**
   * A committed Move whose exact rebuild is still in flight. The viewer keeps
   * the body posed at the applied transform until the recomputed meshes land,
   * so the old geometry never flashes at its resting position.
   */
  const [moveCommitHold, setMoveCommitHold] = useState<MovePreview | null>(
    null
  );
  const [moveSnap, setMoveSnap] = useState<MoveSnap | null>(null);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [modelingTargetBodyId, setModelingTargetBodyId] =
    useState<BodyId | null>(null);
  const modelingPreflightRef = useRef<{
    signature: string;
    command: AnyCommand;
    resultBodyId: BodyId;
    featureName: string;
    baseVersion: number;
  } | null>(null);
  const [sketchConstruction, setSketchConstruction] = useState(false);
  const [sketchDiagnosticPoints, setSketchDiagnosticPoints] = useState<
    { x: number; y: number }[]
  >([]);
  /**
   * What picking is narrowed to right now. A manual choice outranks the tool's
   * so that arming Fillet does not silently undo a filter set on purpose.
   */
  const selectionFilter = effectiveSelectionFilter(manualSelectionFilter, tool);
  const [status, setStatus] = useState('Checking beta API...');
  const [busy, setBusy] = useState(false);
  const {
    projection,
    setProjection,
    settings: viewerSettings,
    setSettings: setViewerSettings,
    initialView,
    hiddenBodyIds,
    setHiddenBodyIds,
    restore: restoreProjectView,
    onCameraChange: reportCameraPose,
    forget: forgetProjectView
  } = useProjectView(doc?.projectId ?? null);
  const [previewDoc, setPreviewDoc] = useState<ProjectDocument | null>(null);
  const [saveState, setSaveState] = useState<WorkspaceSaveState>('saving');
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [deploymentHealth, setDeploymentHealth] =
    useState<HealthResponse | null>(null);
  const [collaborationRollout, setCollaborationRollout] = useState({
    sharingEnabled: false,
    editLeasesEnforced: false,
    /**
     * The owner's own devices may join a room. Independent of `sharingEnabled`
     * on purpose — it must never be read as permission to invite anyone, show
     * sharing UI, or enforce a lease.
     */
    personalSyncEnabled: false
  });
  const [session, setSession] = useState<AuthSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const loadThumbnailBodies = useCallback(
    async (project: ProjectSummary): Promise<BodyRepresentation[]> => {
      const localDocument = await loadLocalProject(project.projectId).catch(
        () => null
      );
      const localRevisionId = localDocument?.revisions.at(-1)?.revisionId;
      const localMatchesSummary =
        localDocument !== null &&
        (!project.lastRevisionId || localRevisionId === project.lastRevisionId);

      const remoteDocument =
        !localMatchesSummary && session
          ? await api.loadProject(project.projectId).catch(() => null)
          : null;
      const thumbnailDocument = selectProjectDocument(
        localDocument,
        remoteDocument
      );
      return thumbnailDocument
        ? Object.values(thumbnailDocument.derived.bodyRepresentations)
        : [];
    },
    [session]
  );
  const [fitSignal, setFitSignal] = useState(0);
  const [viewRequest, setViewRequest] = useState<{
    view: ViewTarget;
    nonce: number;
  } | null>(null);
  const [rotateRequest, setRotateRequest] = useState<{
    direction: 'cw' | 'ccw';
    nonce: number;
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const orientationRef = useRef<((axes: AxisProjection) => void) | null>(null);
  /** Click point + normal of the latest topology pick (drag-handle anchor). */
  const lastPickDetailRef = useRef<PickDetail | null>(null);
  /** Selection-first direct-manipulation mode machine (behind experiment flag). */
  const [interaction, dispatchInteraction] = useReducer(
    interactionReducer,
    IDLE
  );
  // The live-preview coalescer survives for the App lifetime. Its build
  // callback must read the current mode/selection rather than the initial
  // `idle` render it was constructed during.
  const interactionRef = useRef(interaction);
  interactionRef.current = interaction;
  /** Open exact-value entry (anchored keypad) for the armed handle. */
  const [keypad, setKeypad] = useState<KeypadRequest | null>(null);
  const keypadAnchorRef = useRef<
    ((point: { x: number; y: number } | null) => void) | null
  >(null);
  /** Lets keypad typing drive the viewport's offset-handle preview. */
  const offsetSetterRef = useRef<((offset: number) => void) | null>(null);
  /** Localized inspector update; avoids rerendering the whole workspace per move. */
  const cylinderRadiusInspectorSetterRef = useRef<
    ((radius: number | null) => void) | null
  >(null);
  /** Cancels the viewport's captured pointer session on keyboard Escape. */
  const cancelDirectManipulationRef = useRef<(() => boolean) | null>(null);
  const contextMenuActionsRef = useRef<Record<string, () => void>>({});
  const managerRef = useRef<CommandManager | null>(null);
  const geometry = useGeometryWorker({
    manager: () => managerRef.current,
    onDerived: (derived) => {
      const manager = managerRef.current;
      if (manager) {
        setDoc(manager.commitDerivedState(derived));
        // Fresh meshes now reflect the document (worker results are dropped
        // unless their version matches), so any held Move pose must release
        // in this same batch — one render later would double-transform.
        setMoveCommitHold(null);
      }
    },
    onError: (message) => {
      // No rebuild is coming; render the stored geometry truthfully.
      setMoveCommitHold(null);
      setStatus(message);
    }
  });
  const exactGeometryReady = geometry.isReadyFor(doc);
  function requireExactGeometryReady(): boolean {
    const ready = geometry.isReadyFor(managerRef.current?.document ?? null);
    if (!ready) {
      setStatus(
        'Exact geometry is still rebuilding. Topology actions are temporarily unavailable.'
      );
    }
    return ready;
  }
  const remoteVersionsRef = useRef(new Map<string, number>());
  /**
   * Projects the account holds, as of the last listing that reached it. Kept
   * apart from `remoteVersionsRef`, which only knows about projects this
   * session has opened or written: the shelf has to mark every local-only
   * project, including ones never opened here.
   */
  const [cloudProjectIds, setCloudProjectIds] = useState<ReadonlySet<string>>(
    new Set()
  );
  /**
   * A divergence against the account, as opposed to against a live room. Held
   * here rather than in the collaboration hook because it can happen with no
   * room in the picture at all — which, with sharing off, is every time.
   */
  const [accountConflict, setAccountConflict] =
    useState<ProjectConflict | null>(null);
  /**
   * The save-to-account run currently on screen, one entry per project in
   * attempt order. Deliberately not cleared when the loop finishes: the
   * failures and their reasons are the whole point, and they stay up until
   * the user dismisses them or starts another run.
   */
  const [syncRun, setSyncRun] = useState<SyncEntry[] | null>(null);
  const viewNonceRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const pendingLocalSaveRef = useRef<ProjectDocument | null>(null);
  const localSaveTimeoutRef = useRef<number | null>(null);
  const cylinderRadiusPreview = useRef(
    new LivePreview<ProjectDocument, ProjectDocument['derived']>({
      build: (radius) => {
        const command = buildCylinderRadiusCommand(radius);
        const base = managerRef.current?.document;
        return command && base ? command.apply(base) : null;
      },
      derive: (document) => geometry.syncOnce(document),
      publish: (preview) =>
        setPreviewDoc(
          preview ? { ...preview.document, derived: preview.derived } : null
        ),
      acceptValue: (distance) =>
        Number.isFinite(distance) && Math.abs(distance) >= 0.1,
      continueAfterSlow: true
    })
  ).current;

  /**
   * Exact profile extrusion preview. LivePreview supplies newest-request wins
   * sequencing, so a slow worker response can never replace a newer distance
   * or profile selection.
   */
  const profileExtrudePreview = useRef(
    new LivePreview<ProjectDocument, ProjectDocument['derived']>({
      build: (distance) => {
        const draft = extrudePreviewRef.current;
        const profiles = selectedProfilesRef.current;
        const base = managerRef.current?.document;
        if (
          !base ||
          !draft ||
          profiles.length === 0 ||
          Math.abs(distance) < 0.1 ||
          profiles.some((profile) => profile.sketchId !== draft.sketchId)
        ) {
          return null;
        }
        return commandFactories
          .extrudeSketch({
            name: 'Extrude preview',
            sketchId: draft.sketchId as SketchId,
            distance,
            profiles: profiles.map((profile) => ({
              profileId: profile.profileId,
              regionFingerprint: profile.regionFingerprint,
              samplePoint: profile.samplePoint,
              sourceArea: profile.area,
              sourceEntityIds: profile.sourceEntityIds
            }))
          })
          .apply(base);
      },
      derive: (document) => geometry.syncOnce(document),
      publish: (preview) => {
        setPreviewDoc(
          preview ? { ...preview.document, derived: preview.derived } : null
        );
        if (preview) {
          const count = selectedProfilesRef.current.length;
          setStatus(
            `${count} profile${count === 1 ? '' : 's'} selected · exact preview ready.`
          );
        }
      },
      continueAfterSlow: true
    })
  ).current;

  useEffect(() => {
    if (
      !extrudePreview ||
      selectedProfiles.length === 0 ||
      Math.abs(extrudePreview.distance) < 0.1
    ) {
      profileExtrudePreview.clear();
      return;
    }
    profileExtrudePreview.request(extrudePreview.distance);
  }, [extrudePreview, profileExtrudePreview, selectedProfiles]);

  const { run: executeValidatedDirectEdit } = useDirectEditCommit({
    manager: () => managerRef.current,
    derive: (document) => geometry.syncOnce(document),
    commit: (command) => executeCommand(command),
    onValidationStart: (value) =>
      dispatchInteraction({ type: 'validation-start', value }),
    onValidationFailed: (message, value) => {
      cylinderRadiusPreview.clear();
      cylinderRadiusInspectorSetterRef.current?.(null);
      dispatchInteraction({ type: 'validation-failed', message, value });
    },
    onCommitted: (bodyId) => {
      cylinderRadiusPreview.clear();
      dispatchInteraction({ type: 'commit-complete' });
      setSelectedTopology(null);
      setSelectedEdges([]);
      setSelectedBodyIds([bodyId]);
      setSelectedFeatureNodeId(featureNodeIdForBody(bodyId));
    },
    onBusy: setBusy,
    onStatus: setStatus
  });
  const { run: executeValidatedFeature } = useValidatedFeatureCommit({
    manager: () => managerRef.current,
    derive: (document) => geometry.syncOnce(document),
    commit: (command) => executeCommand(command),
    commitTransaction: (label, commands) => executeTransaction(label, commands),
    onBusy: setBusy,
    onStatus: setStatus
  });

  const collaboration = useCollaboration({
    document: doc,
    // A signed-in user can still be editing a device-only project. Only attach
    // account cookies to a collaboration room after this exact project has
    // been resolved as a cloud-backed document.
    session:
      cloudAvailable &&
      (collaborationRollout.sharingEnabled ||
        collaborationRollout.personalSyncEnabled)
        ? session
        : null,
    onRemoteDocument(remoteDocument) {
      const current = managerRef.current?.document;
      if (
        !current ||
        current.projectId !== remoteDocument.projectId ||
        remoteDocument.version <= current.version
      ) {
        return;
      }
      // The room and the freshness poll are two routes to the same place, so
      // they have to leave the same state behind: without re-baselining here,
      // the next autosave would be fenced against a version this device has
      // already moved past and would report a conflict that does not exist.
      remoteVersionsRef.current.set(
        remoteDocument.projectId,
        remoteDocument.version
      );
      cloudProjectAutosaveRef.current?.adoptAccountVersion(
        remoteDocument.projectId,
        remoteDocument.version
      );
      hydrateDocument(remoteDocument, {
        restoreView: false,
        rememberProject: false
      });
      setStatus(
        collaborationRollout.sharingEnabled
          ? `Applied live revision ${remoteDocument.version} from a collaborator.`
          : `Applied revision ${remoteDocument.version} from another of your devices.`
      );
    },
    onConflict(remoteDocument) {
      setStatus(
        `Collaboration conflict at revision ${remoteDocument.version}; local edits were preserved.`
      );
    }
  });

  const activeCollaborationLease = Boolean(
    collaboration.lease &&
    collaboration.lease.projectId === doc?.projectId &&
    collaboration.lease.expiresAt > Date.now()
  );
  const editDisabledReason =
    !cloudAvailable || !session || !collaborationRollout.sharingEnabled
      ? null
      : collaboration.conflict
        ? 'Resolve the collaboration conflict before editing'
        : collaboration.role === 'viewer' ||
            collaboration.status === 'read-only'
          ? 'This shared project is read-only'
          : collaboration.role === null
            ? 'Waiting for project access'
            : collaborationRollout.editLeasesEnforced &&
                !activeCollaborationLease
              ? collaboration.status === 'lease-denied'
                ? 'Another collaborator holds the edit lease'
                : 'Waiting for the project edit lease'
              : null;

  function ensureCanEdit(action = 'edit this project'): boolean {
    if (!editDisabledReason) {
      return true;
    }
    setStatus(`Cannot ${action}: ${editDisabledReason}.`);
    return false;
  }

  const conflictHandlers: ConflictResolutionHandlers = {
    async writeRecoveryCopy(source) {
      const copy = localRecoveryCopy(source, 'Recovery');
      await saveLocalProject(copy);
      setProjects((current) =>
        mergeProjectSummaries(
          [
            {
              projectId: copy.projectId,
              name: copy.name,
              updatedAt: copy.derived.updatedAt,
              revisionCount: 0
            }
          ],
          current
        )
      );
    },
    useRemoteVersion(remoteDocument) {
      if (!collaboration.useRemoteVersion(remoteDocument.version)) {
        throw new Error(
          'The room version changed before recovery could complete.'
        );
      }
      setStatus(
        'Using the current room version; a local recovery copy was saved.'
      );
    },
    async keepMyVersion({ expectedRemoteVersion }) {
      await collaboration.keepLocalVersion(expectedRemoteVersion);
      setStatus('Submitting the preserved local version to the room.');
    },
    saveLocalAsCopy() {
      setStatus('Saved the divergent document as a local recovery project.');
    }
  };

  /**
   * The same three resolutions, for a conflict the account raised rather than a
   * room. There is no lease and no live channel here: taking the account's copy
   * is a local hydrate, and keeping this device's is an ordinary fenced write
   * against the version the account reported.
   */
  const accountConflictHandlers: ConflictResolutionHandlers = {
    writeRecoveryCopy: conflictHandlers.writeRecoveryCopy,
    async useRemoteVersion(remoteDocument) {
      await saveLocalProject(remoteDocument);
      remoteVersionsRef.current.set(
        remoteDocument.projectId,
        remoteDocument.version
      );
      await saveLastSyncedVersion(
        remoteDocument.projectId,
        remoteDocument.version
      );
      cloudProjectAutosaveRef.current?.adoptAccountVersion(
        remoteDocument.projectId,
        remoteDocument.version
      );
      hydrateDocument(remoteDocument, { restoreView: false });
      setAccountConflict(null);
      setStatus(
        'Using the version from your account; a local recovery copy was saved.'
      );
    },
    async keepMyVersion({ document, expectedRemoteVersion }) {
      const saved = await api.saveRevision({
        projectId: document.projectId,
        reason: 'Kept this device’s version',
        expectedVersion: expectedRemoteVersion,
        document: withoutDerivedProjection(document)
      });
      const restored = withLocalDerived(saved, document);
      await saveLocalProject(restored);
      remoteVersionsRef.current.set(restored.projectId, restored.version);
      await saveLastSyncedVersion(restored.projectId, restored.version);
      if (managerRef.current) {
        managerRef.current.document = restored;
      }
      setDoc(restored);
      cloudProjectAutosaveRef.current?.adoptAccountVersion(
        restored.projectId,
        restored.version
      );
      setAccountConflict(null);
      setSaveState('synced');
      setStatus('Kept this device’s version; a recovery copy was saved.');
    },
    saveLocalAsCopy() {
      setStatus('Saved the divergent document as a local recovery project.');
    }
  };

  async function resolveAccountConflict(resolution: ConflictResolution) {
    if (!accountConflict) {
      return;
    }
    setBusy(true);
    try {
      await resolveProjectConflict(
        accountConflict,
        resolution,
        { role: collaboration.role, lease: null, leasesEnforced: false },
        accountConflictHandlers
      );
      clearUnresolvedConflict(accountConflict.projectId);
    } catch (error) {
      setStatus(errorMessage(error, 'Could not resolve the conflict.'));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (collaboration.conflict) {
      setSharingOpen(true);
    }
  }, [collaboration.conflict]);

  useEffect(() => {
    savePanelState(panelState);
  }, [panelState]);

  useEffect(() => {
    saveLocalAppSettings(appSettings, syncedRevisionRef.current);
    globalThis.document.documentElement.dataset.density =
      appSettings.appearance.density;
    globalThis.document.documentElement.dataset.reducedMotion = appSettings
      .appearance.reducedMotion
      ? 'true'
      : 'false';
    setViewerSettings((current) => ({
      ...current,
      reducedMotion: appSettings.appearance.reducedMotion,
      zoomToCursor: appSettings.viewport.zoomToCursor,
      middleDrag: appSettings.viewport.middleDrag
    }));
  }, [appSettings]);

  useEffect(() => {
    const controller = new CloudSettingsAutosave({
      initialSettings: appSettingsRef.current,
      initialSyncedRevision: syncedRevisionRef.current,
      api,
      onAccountSettings(response) {
        accountSettingsRef.current = response;
        setAccountSettings(response);
      },
      onLocalSettings(settings, syncedRevision) {
        syncedRevisionRef.current = syncedRevision;
        saveLocalAppSettings(settings, syncedRevision);
      },
      onStatus(status) {
        switch (status.state) {
          case 'pending':
            setSettingsMessage(
              'Saved on this device · saving to cloud profile…'
            );
            break;
          case 'offline':
            setSettingsMessage(
              'Saved on this device · cloud sync paused until you are online.'
            );
            break;
          case 'saved':
            setSettingsMessage('Saved to this device and cloud profile.');
            break;
          case 'error':
            setSettingsMessage(
              errorMessage(
                status.error,
                'Cloud autosave failed · changes remain saved on this device.'
              )
            );
            break;
        }
      }
    });
    cloudSettingsAutosaveRef.current = controller;
    return () => {
      controller.dispose();
      if (cloudSettingsAutosaveRef.current === controller) {
        cloudSettingsAutosaveRef.current = null;
      }
      cloudSettingsSessionUserRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new CloudProjectAutosave({
      api,
      onStatus(status) {
        setSaveState(status.state);
        if (status.state === 'refused') {
          setStatus(
            errorMessage(
              status.error,
              'This document is too large for the account. It stays saved on this device.'
            )
          );
        }
      },
      onSynced({ projectId, version }) {
        remoteVersionsRef.current.set(projectId, version);
        // The durable baseline. Everything the conflict machinery decides is
        // measured from here, so it has to be written on the acknowledgement
        // rather than inferred later from versions alone.
        void saveLastSyncedVersion(projectId, version);
      },
      onConflict({ projectId, localDocument, accountVersion }) {
        setStatus(
          `This project changed elsewhere (account version ${accountVersion}). Your work is saved on this device.`
        );
        // Fetch the account's copy so the user is choosing between two real
        // documents rather than two version numbers.
        void api
          .loadProject(projectId)
          .then((remote) => {
            setAccountConflict(
              conflictFromDocuments(localDocument, remote, 'account')
            );
          })
          .catch(() => undefined);
      },
      onSessionExpired() {
        remoteVersionsRef.current.clear();
        setCloudAvailable(false);
        endCloudSettingsSession();
      }
    });
    cloudProjectAutosaveRef.current = controller;
    return () => {
      controller.dispose();
      if (cloudProjectAutosaveRef.current === controller) {
        cloudProjectAutosaveRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    cloudProjectAutosaveRef.current?.configure({
      enabled: appSettings.files.cloudAutosave,
      idleDelayMs: appSettings.files.cloudAutosaveDelaySeconds * 1000
    });
  }, [
    appSettings.files.cloudAutosave,
    appSettings.files.cloudAutosaveDelaySeconds
  ]);

  /**
   * Points the autosave controller at whichever project is open, and only when
   * the account actually holds it. A project the account has never seen is not
   * a sync failure — it is something to adopt, which the start screen offers.
   */
  useEffect(() => {
    const controller = cloudProjectAutosaveRef.current;
    if (!controller) {
      return;
    }
    const projectId = doc?.projectId;
    const accountVersion = projectId
      ? remoteVersionsRef.current.get(projectId)
      : undefined;
    if (!projectId || !session || accountVersion === undefined) {
      controller.closeProject();
      return;
    }
    controller.openProject(projectId, accountVersion);
  }, [doc?.projectId, session]);

  /**
   * Last call before the tab goes away. `pagehide` is the only one of these
   * that fires reliably on mobile, and `visibilitychange` is the only one that
   * fires when a tab is merely backgrounded — which on a phone is usually the
   * last thing that happens before it is discarded.
   */
  useEffect(() => {
    const flush = () => {
      void cloudProjectAutosaveRef.current?.flushPending();
    };
    const onVisibilityChange = () => {
      if (globalThis.document.visibilityState === 'hidden') {
        flush();
      }
    };
    window.addEventListener('pagehide', flush);
    globalThis.document.addEventListener(
      'visibilitychange',
      onVisibilityChange
    );
    return () => {
      window.removeEventListener('pagehide', flush);
      globalThis.document.removeEventListener(
        'visibilitychange',
        onVisibilityChange
      );
    };
  }, []);

  /**
   * Asks the account whether the open project has moved elsewhere, and pulls it
   * when this device has nothing of its own outstanding.
   *
   * A version comparison, not a document fetch — cheap enough to be the
   * permanent answer rather than a placeholder for the live room. It narrows
   * the window in which two devices diverge unnoticed; it does not close it,
   * which is what the room is for.
   */
  useEffect(() => {
    const projectId = doc?.projectId ?? null;
    if (
      !shouldPollForFreshness({
        projectId,
        signedIn: Boolean(session),
        accountHoldsProject: Boolean(
          projectId && remoteVersionsRef.current.has(projectId)
        ),
        awaitingResolution: cloudProjectAutosaveRef.current?.isHalted !== false
      })
    ) {
      return;
    }
    let cancelled = false;

    async function check() {
      const controller = cloudProjectAutosaveRef.current;
      const current = managerRef.current?.document;
      if (cancelled || !controller || !current || controller.isHalted) {
        return;
      }
      const summary = (
        await api.listProjects().catch(() => null)
      )?.projects.find((project) => project.projectId === current.projectId);
      if (cancelled || summary?.documentVersion === undefined) {
        return;
      }
      const action = decideProjectSync({
        localVersion: current.version,
        accountVersion: summary.documentVersion,
        lastSyncedVersion: controller.syncedVersion,
        hasUnsentChanges: controller.hasPendingChanges
      });
      if (action !== 'pull') {
        // `push` is already the autosave controller's job, and `conflict` is
        // raised by the write that gets fenced rather than guessed at here.
        return;
      }
      const remote = await api.loadProject(current.projectId).catch(() => null);
      const live = managerRef.current?.document;
      // Anything the user did while the document was in flight makes it stale.
      if (
        cancelled ||
        !remote ||
        !live ||
        live.projectId !== current.projectId ||
        live.version !== current.version ||
        controller.hasPendingChanges
      ) {
        return;
      }
      await saveLocalProject(remote);
      remoteVersionsRef.current.set(remote.projectId, remote.version);
      controller.adoptAccountVersion(remote.projectId, remote.version);
      hydrateDocument(remote);
      setStatus(`Updated to the version saved on another device.`);
    }

    const onFocus = () => void check();
    const interval = window.setInterval(
      () => void check(),
      FRESHNESS_POLL_INTERVAL_MS
    );
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
    };
  }, [doc?.projectId, session]);

  useEffect(() => {
    const controller = cloudSettingsAutosaveRef.current;
    const userId = session?.userId ?? null;
    if (!controller) {
      return;
    }
    if (!userId || !accountSettings) {
      if (cloudSettingsSessionUserRef.current !== null) {
        controller.endSession();
        cloudSettingsSessionUserRef.current = null;
      }
      return;
    }
    if (cloudSettingsSessionUserRef.current !== userId) {
      if (cloudSettingsSessionUserRef.current !== null) {
        controller.endSession();
      }
      controller.connectSession(userId, accountSettings);
      cloudSettingsSessionUserRef.current = userId;
      return;
    }
    controller.updateAccountSettings(accountSettings);
  }, [accountSettings, session]);

  useEffect(() => {
    let cancelled = false;
    mark('startup.begin', { rememberedProject: Boolean(startupProjectId) });
    void (async () => {
      try {
        const [health, rememberedLocal, currentAuth] = await Promise.all([
          api.health().catch(() => null),
          startupProjectId
            ? timedAsync('startup.localProject', () =>
                loadLocalProject(startupProjectId).catch(() => null)
              )
            : Promise.resolve(null),
          api
            .authConfig()
            .then((config) => ({
              config,
              status: 'ready' as const
            }))
            .catch(() => ({
              config: null,
              status: 'unavailable' as const
            }))
        ]);
        const activeSession = await timedAsync('startup.session', () =>
          api.session().catch(() => null)
        );
        const [listed, rememberedRemote, remoteSettings] = await Promise.all([
          timedAsync('startup.projectList', () =>
            loadProjectSummaries(Boolean(activeSession))
          ),
          activeSession && startupProjectId
            ? api.loadProject(startupProjectId).catch(() => null)
            : Promise.resolve(null),
          activeSession ? api.getSettings().catch(() => null) : null
        ]);
        if (cancelled) {
          return;
        }
        setDeploymentHealth(health);
        const merged = listed.projects;
        const restoredOutcome = chooseProjectDocument(
          rememberedLocal,
          rememberedRemote,
          startupProjectId
            ? await loadLastSyncedVersion(startupProjectId)
            : null
        );
        const restoredDocument =
          restoredOutcome.choice === 'none'
            ? null
            : restoredOutcome.choice === 'diverged'
              ? restoredOutcome.local
              : restoredOutcome.document;
        const canUseCloud = Boolean(activeSession && rememberedRemote);
        setCollaborationRollout({
          sharingEnabled: health?.projectSharingEnabled === true,
          editLeasesEnforced:
            health?.projectSharingEnabled === true &&
            health.projectEditLeasesEnforced === true,
          personalSyncEnabled: health?.projectPersonalSyncEnabled === true
        });
        if (rememberedRemote) {
          remoteVersionsRef.current.set(
            rememberedRemote.projectId,
            rememberedRemote.version
          );
        }
        setProjects(merged);
        setCloudProjectIds(listed.cloudProjectIds);
        setCloudAvailable(canUseCloud);
        sessionRef.current = activeSession;
        setSession(activeSession);
        setAuthConfig(currentAuth.config);
        setAuthConfigStatus(currentAuth.status);
        if (remoteSettings) {
          accountSettingsRef.current = remoteSettings;
          setAccountSettings(remoteSettings);
          // Adopting the account copy over an unsaved local change would revert
          // it silently — for the assistant switch, that reads as the switch
          // not working at all.
          if (
            remoteSettings.synced &&
            shouldAdoptAccountSettings(bootSettingsRef.current)
          ) {
            appSettingsRef.current = remoteSettings.settings;
            setAppSettings(remoteSettings.settings);
            const controller = cloudSettingsAutosaveRef.current;
            if (controller) {
              controller.adoptSyncedSettings(
                remoteSettings.settings,
                remoteSettings
              );
            } else {
              syncedRevisionRef.current = remoteSettings.revision;
              saveLocalAppSettings(
                remoteSettings.settings,
                remoteSettings.revision
              );
            }
          } else {
            setSettingsMessage(
              'This device has settings that are not saved to your account yet · saving to cloud profile…'
            );
            cloudSettingsAutosaveRef.current?.schedule(appSettingsRef.current);
          }
        }
        setSaveState(canUseCloud ? 'synced' : 'local');
        if (startupProjectId && restoredDocument) {
          hydrateDocument(restoredDocument);
          if (restoredOutcome.choice === 'diverged') {
            setAccountConflict(
              conflictFromDocuments(
                restoredOutcome.local,
                restoredOutcome.remote,
                'account'
              )
            );
            setSaveState('conflict');
            setStatus(
              `${restoredDocument.name} changed here and in your account. Nothing has been discarded — choose which to keep.`
            );
            return;
          }
          setStatus(`Reopened ${restoredDocument.name}.`);
          return;
        }
        if (startupProjectId) {
          clearActiveProject();
        }
        setStatus(
          activeSession && listed.remoteReached
            ? `Cloud profile ready · ${merged.length} project(s)`
            : health
              ? `Local workspace · ${merged.length} local project(s)`
              : `Offline workspace · ${merged.length} local project(s)`
        );
      } catch (error) {
        if (!cancelled) {
          clearActiveProject();
          setStatus(errorMessage(error, 'Could not restore the workspace.'));
        }
      } finally {
        if (!cancelled) {
          mark('startup.ready');
          measure('startup.restore', 'startup.begin', 'startup.ready');
          measure('startup.total', 'bundle.evaluated', 'startup.ready');
          setStartupState('ready');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Startup settings are intentionally read once. Later settings changes
    // should not re-run project discovery or reopen a different document.
  }, [startupProjectId]);

  useEffect(() => {
    if (!doc) {
      return;
    }
    setSaveState('saving');
    pendingLocalSaveRef.current = doc;
    const timeout = window.setTimeout(() => {
      localSaveTimeoutRef.current = null;
      void flushPendingLocalSave();
    }, 450);
    localSaveTimeoutRef.current = timeout;
    return () => {
      if (localSaveTimeoutRef.current === timeout) {
        window.clearTimeout(timeout);
        localSaveTimeoutRef.current = null;
      }
    };
  }, [doc, cloudAvailable]);

  useEffect(() => {
    if (!doc || !cloudAvailable) {
      setArtifacts([]);
      return;
    }
    let cancelled = false;
    void api
      .listArtifacts(doc.projectId)
      .then((response) => {
        if (!cancelled) {
          setArtifacts(response.artifacts);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setArtifacts([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [doc?.projectId, cloudAvailable]);

  useEffect(() => {
    geometry.sync(doc);
  }, [doc]);

  const features = useMemo<FeatureNode[]>(
    () => (doc ? listFeaturesInOrder(doc) : []),
    [doc]
  );
  const parameters = useMemo(() => (doc ? listParameters(doc) : []), [doc]);
  const parameterScope = useMemo(
    () => (doc ? getParameterScope(doc) : { scope: {}, errors: [] }),
    [doc]
  );

  // Text profiles resolve faces synchronously on this thread as well as in the
  // worker, so the faces this document names have to be parsed here too.
  const textFontsVersion = useDocumentFonts(doc ?? null);

  const representations = doc?.derived.bodyRepresentations ?? {};
  const renderedRepresentations =
    previewDoc?.derived.bodyRepresentations ?? representations;
  /**
   * Exact regeneration is allowed to assign a new topology ID to the resized
   * wall. Keep the selected face attached to the preview by its fixed
   * world-space axis; do not apply this fallback to unrelated edit types.
   */
  const renderedSelectedTopology = useMemo<TopologySelection | null>(() => {
    if (selectedTopology?.kind !== 'face') {
      return selectedTopology;
    }
    const body = renderedRepresentations[selectedTopology.bodyId];
    const faces = body?.topology?.faces ?? [];
    const exact = faces.find(
      (face) =>
        face.topologyId === selectedTopology.topologyId ||
        (selectedTopology.hash !== undefined &&
          face.hash === selectedTopology.hash)
    );
    if (exact) {
      return {
        bodyId: selectedTopology.bodyId,
        kind: 'face',
        topologyId: exact.topologyId,
        hash: exact.hash
      };
    }
    if (
      interaction.mode !== 'face' ||
      interaction.op !== 'resize-cylinder-radius' ||
      interaction.target.bodyId !== selectedTopology.bodyId ||
      !interaction.target.axisStart ||
      !interaction.target.axisEnd
    ) {
      return selectedTopology;
    }
    const axisStart = {
      x: interaction.target.axisStart[0],
      y: interaction.target.axisStart[1],
      z: interaction.target.axisStart[2]
    };
    const axisEnd = {
      x: interaction.target.axisEnd[0],
      y: interaction.target.axisEnd[1],
      z: interaction.target.axisEnd[2]
    };
    const regenerated = faces.find((face) => {
      const geometry = face.geometry;
      return (
        geometry?.surfaceType === 'cylinder' &&
        geometry.axisStart !== undefined &&
        geometry.axisEnd !== undefined &&
        sameCylinderAxis(
          axisStart,
          axisEnd,
          geometry.axisStart,
          geometry.axisEnd
        )
      );
    });
    return regenerated
      ? {
          bodyId: selectedTopology.bodyId,
          kind: 'face',
          topologyId: regenerated.topologyId,
          hash: regenerated.hash
        }
      : selectedTopology;
  }, [interaction, renderedRepresentations, selectedTopology]);
  // Warnings must describe what is actually on screen. While a preview is up the
  // viewport shows previewDoc's bodies, so showing the live document's warnings
  // would hide exactly the problems the preview exists to reveal.
  const warnings = (previewDoc ?? doc)?.derived.warnings ?? [];

  const viewerBodies = useMemo<BodyRepresentation[]>(
    () =>
      (previewDoc
        ? Object.values(renderedRepresentations)
        : doc
          ? Object.values(doc.derived.bodyRepresentations)
          : []
      ).filter((body) => !body.consumed && !hiddenBodyIds.has(body.bodyId)),
    [doc, previewDoc, renderedRepresentations, hiddenBodyIds]
  );

  const directEditableBodyIds = useMemo<string[]>(
    () =>
      previewDoc
        ? []
        : features.flatMap((feature) =>
            feature.bodyId &&
            feature.data.featureKind === 'primitive' &&
            feature.data.primitiveKind === 'box' &&
            Object.values(feature.data.dimensions).every(
              (value) => typeof value === 'number'
            )
              ? [feature.bodyId]
              : []
          ),
    [features, previewDoc]
  );

  const bodyOptions = useMemo(() => {
    if (!doc) {
      return [];
    }
    const byBodyId = new Map(
      listNodesByKind(doc, 'body').map((body) => [body.bodyId, body] as const)
    );
    return doc.bodyOrder.flatMap((bodyId) => {
      const node = byBodyId.get(bodyId);
      if (!node) {
        return [];
      }
      const representation = doc.derived.bodyRepresentations[bodyId];
      return [
        { bodyId, name: node.name, consumed: representation?.consumed ?? false }
      ];
    });
  }, [doc]);

  const sketchOptions = useMemo(() => {
    if (!doc) {
      return [];
    }
    const sketches = listNodesByKind(doc, 'sketch');
    return doc.sketchOrder.flatMap((sketchId) => {
      const sketch = sketches.find(
        (candidate) => candidate.sketchId === sketchId
      );
      return sketch ? [{ sketchId, name: sketch.name }] : [];
    });
  }, [doc]);

  const selectedFeature = useMemo<FeatureNode | null>(() => {
    if (!doc || !selectedFeatureNodeId) {
      return null;
    }
    const node = doc.nodes[selectedFeatureNodeId];
    return node?.kind === 'feature' ? node : null;
  }, [doc, selectedFeatureNodeId]);

  const selectedSketch = useMemo<SketchNode | null>(() => {
    if (
      !doc ||
      !selectedFeature ||
      selectedFeature.data.featureKind !== 'sketch'
    ) {
      return null;
    }
    return findSketch(doc, selectedFeature.data.sketchId) ?? null;
  }, [doc, selectedFeature]);

  const selectedSketchObject = useMemo<SketchObjectData | null>(() => {
    if (!doc || !selectedSketch) {
      return null;
    }
    const objectNode = selectedSketch.objectIds[0]
      ? doc.nodes[selectedSketch.objectIds[0]]
      : undefined;
    return objectNode?.kind === 'sketch-object' ? objectNode.data : null;
  }, [doc, selectedSketch]);

  const selectedFeatureBodyId =
    selectedFeature?.bodyId ??
    (selectedFeature?.data.featureKind === 'transform' ||
    selectedFeature?.data.featureKind === 'direct-edit'
      ? selectedFeature.data.targetBodyId
      : null);
  const selectedBody = selectedFeatureBodyId
    ? (renderedRepresentations[selectedFeatureBodyId] ?? null)
    : null;

  const assistantSelection = useMemo<CadSelectionContext>(
    () => ({
      featureIds: selectedFeature ? [selectedFeature.featureId] : [],
      bodyIds: selectedBodyIds,
      topologies:
        selectedEdges.length > 0
          ? selectedEdges
          : selectedTopology
            ? [selectedTopology]
            : []
    }),
    [selectedBodyIds, selectedEdges, selectedFeature, selectedTopology]
  );

  const edgeModifierBody = useMemo<BodyRepresentation | null>(() => {
    const candidateId =
      selectedEdges[0]?.bodyId ??
      selectedTopology?.bodyId ??
      selectedBodyIds.at(-1);
    if (candidateId) {
      const candidate = viewerBodies.find(
        (body) => body.bodyId === candidateId
      );
      if (candidate) {
        return candidate;
      }
    }
    return viewerBodies.length === 1 ? viewerBodies[0]! : null;
  }, [selectedBodyIds, selectedEdges, selectedTopology, viewerBodies]);

  const exportBodyIds = useMemo<BodyId[]>(() => {
    if (!doc) {
      return [];
    }
    if (selectedBody && !selectedBody.consumed && selectedBody.exportableStep) {
      return [selectedBody.bodyId];
    }
    return doc.derived.exportableBodyIds;
  }, [doc, selectedBody]);

  // Bottom-center selection summary: what is picked plus a quick measurement.
  const selectionChip = useMemo<{
    label: string;
    detail?: string;
  } | null>(() => {
    if (!doc || tool === 'sketch') {
      return null;
    }
    const units = doc.units;
    const round = (value: number) => Math.round(value * 100) / 100;
    if (selectedEdges.length > 1) {
      const total = selectedEdges.reduce((sum, edge) => {
        const body = renderedRepresentations[edge.bodyId];
        return sum + (edgeLength(body, edge.hash, edge.topologyId) ?? 0);
      }, 0);
      return {
        label: `${selectedEdges.length} edges`,
        detail: total > 0 ? `≈ ${round(total)} ${units}` : undefined
      };
    }
    if (
      selectedEdges.length === 1 ||
      renderedSelectedTopology?.kind === 'edge'
    ) {
      const bodyId =
        selectedEdges[0]?.bodyId ?? renderedSelectedTopology?.bodyId;
      const body = bodyId ? renderedRepresentations[bodyId] : undefined;
      const hash = selectedEdges[0]?.hash ?? renderedSelectedTopology?.hash;
      const topologyId =
        selectedEdges[0]?.topologyId ?? renderedSelectedTopology?.topologyId;
      const name = edgeLabel(body, hash, topologyId);
      const length = edgeLength(body, hash, topologyId);
      return {
        label: body ? `${body.name} · ${name}` : name,
        detail:
          length !== null && length > 0
            ? `${round(length)} ${units}`
            : undefined
      };
    }
    if (renderedSelectedTopology?.kind === 'face') {
      const body = renderedRepresentations[renderedSelectedTopology.bodyId];
      const face = body?.topology?.faces.find(
        (candidate) =>
          candidate.topologyId === renderedSelectedTopology.topologyId
      );
      const geometry = face?.geometry;
      if (
        geometry?.featureType === 'through-hole' &&
        geometry.diameter !== undefined
      ) {
        return {
          label: 'Through hole',
          detail: `Ø ${round(geometry.diameter)} ${units}`
        };
      }
      const name = faceLabel(
        body,
        renderedSelectedTopology.hash,
        renderedSelectedTopology.topologyId
      );
      return {
        label: body ? `${body.name} · ${name}` : name
      };
    }
    if (selectedBodyIds.length > 1) {
      return {
        label: `${selectedBodyIds.length} bodies`,
        detail: 'U union · X subtract · I intersect'
      };
    }
    const bodyId = selectedBodyIds[0];
    const body = bodyId ? renderedRepresentations[bodyId] : null;
    if (body) {
      const size = {
        x: round(body.bbox.max.x - body.bbox.min.x),
        y: round(body.bbox.max.y - body.bbox.min.y),
        z: round(body.bbox.max.z - body.bbox.min.z)
      };
      return {
        label: body.name,
        detail: `${size.x} × ${size.y} × ${size.z} ${units}`
      };
    }
    return null;
  }, [
    doc,
    tool,
    selectedEdges,
    renderedSelectedTopology,
    selectedBodyIds,
    renderedRepresentations
  ]);

  // Sketch profiles lifted onto their 3D planes for the viewport overlay.
  const sketchOverlays = useMemo<SketchOverlay[]>(() => {
    if (!doc) {
      return [];
    }
    const scope = parameterScope.scope;
    return listNodesByKind(doc, 'sketch').flatMap((sketch) => {
      const objectNode = sketch.objectIds[0]
        ? doc.nodes[sketch.objectIds[0]]
        : undefined;
      if (objectNode?.kind !== 'sketch-object') {
        return [];
      }
      const data = objectNode.data;
      if (data.objectKind === 'line' || data.objectKind === 'arc') {
        // Open curves have no fill; region overlays render them separately.
        return [];
      }
      if (data.objectKind === 'text') {
        // Text has no single closed profile — it is many regions with holes,
        // and the region overlay renders it.
        return [];
      }
      const centerX = evalParamValue(data.centerX, scope);
      const centerY = evalParamValue(data.centerY, scope);
      if (centerX === null || centerY === null) {
        return [];
      }
      let profile: Vec2[];
      try {
        if (data.objectKind === 'rectangle') {
          const width = evalParamValue(data.width, scope);
          const height = evalParamValue(data.height, scope);
          if (width === null || height === null) {
            return [];
          }
          profile = rectangleProfile(width, height, centerX, centerY);
        } else if (data.objectKind === 'circle') {
          const radius = evalParamValue(data.radius, scope);
          if (radius === null) {
            return [];
          }
          profile = circleProfile(radius, centerX, centerY);
        } else {
          const sides = evalParamValue(data.sides, scope);
          const radius = evalParamValue(data.radius, scope);
          if (sides === null || radius === null) {
            return [];
          }
          profile = polygonProfile(sides, radius, centerX, centerY);
        }
      } catch {
        return [];
      }
      let basis: PlaneBasis;
      try {
        basis = resolvedSketchPlaneBasis(
          doc,
          sketch.planeRef,
          (value) => evalParamValue(value, scope) ?? 0,
          sketch.name
        );
      } catch {
        return [];
      }
      const points = profile.map((point) => ({
        x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
        y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
        z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
      }));
      return [
        {
          sketchId: sketch.sketchId,
          name: sketch.name,
          selected:
            selectedSketchProfileId === sketch.sketchId ||
            selectedSketch?.sketchId === sketch.sketchId,
          profile,
          normal: basis.normal,
          points
        }
      ];
    });
  }, [doc, parameterScope, selectedSketch, selectedSketchProfileId]);

  const selectedSketchProfileName = useMemo(
    () =>
      selectedSketchProfileId
        ? (sketchOptions.find(
            (candidate) => candidate.sketchId === selectedSketchProfileId
          )?.name ?? 'Closed profile')
        : null,
    [selectedSketchProfileId, sketchOptions]
  );

  const availability: ToolAvailability = {
    editDisabledReason,
    sketchCount: sketchOptions.length,
    liveBodyCount: viewerBodies.length,
    exactGeometryReady,
    hasEdgeSelected: selectedEdges.length > 0
  };

  function hydrateDocument(
    nextDocument: ProjectDocument,
    options: { restoreView?: boolean; rememberProject?: boolean } = {}
  ) {
    return timed('document.hydrate', () =>
      hydrateDocumentInner(nextDocument, options)
    );
  }

  function hydrateDocumentInner(
    nextDocument: ProjectDocument,
    options: { restoreView?: boolean; rememberProject?: boolean } = {}
  ) {
    const normalized = normalizeDocument(nextDocument);
    const restoreView = options.restoreView ?? true;
    const rememberProject = options.rememberProject ?? true;
    if (restoreView) {
      restoreProjectView(normalized.projectId, {
        projection: appSettings.viewport.defaultProjection,
        showGrid: appSettings.viewport.showGrid,
        displayMode: appSettings.viewport.displayMode,
        reducedMotion: appSettings.appearance.reducedMotion,
        zoomToCursor: appSettings.viewport.zoomToCursor,
        middleDrag: appSettings.viewport.middleDrag
      });
    }
    if (rememberProject) {
      rememberActiveProject(normalized.projectId);
    }
    managerRef.current = new CommandManager(normalized);
    geometry.invalidate();
    setDoc(normalized);
    setPreviewDoc(null);
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(null);
    setSelectedProfiles([]);
    setExtrudePreview(null);
    setMoveCommitHold(null);
    setTool(null);
  }

  async function flushPendingLocalSave() {
    if (localSaveTimeoutRef.current !== null) {
      window.clearTimeout(localSaveTimeoutRef.current);
      localSaveTimeoutRef.current = null;
    }
    const pending = pendingLocalSaveRef.current;
    pendingLocalSaveRef.current = null;
    if (!pending) {
      return;
    }
    try {
      await saveLocalProject(pending);
      // The device write is the save; the account copy follows on its own
      // schedule. Handing the document over here rather than from the edit
      // effect means nothing is ever queued for the account that this device
      // has not already stored.
      const controller = cloudProjectAutosaveRef.current;
      if (controller) {
        controller.schedule(pending);
      } else {
        setSaveState(cloudAvailable ? 'synced' : 'local');
      }
    } catch {
      setSaveState('offline');
      setStatus('Local autosave failed. Export your model before closing.');
    }
  }

  function handleViewportChange(camera: ViewportCameraState) {
    reportCameraPose(doc?.projectId ?? null, camera);
  }

  function executeCommand(command: AnyCommand): boolean {
    if (!managerRef.current || !ensureCanEdit('run this command')) {
      return false;
    }
    try {
      setPreviewDoc(null);
      setDoc(managerRef.current.execute(command));
      setStatus(command.label);
      return true;
    } catch (error) {
      setStatus(errorMessage(error, 'Command failed.'));
      return false;
    }
  }

  function executeTransaction(label: string, commands: AnyCommand[]): boolean {
    if (
      !managerRef.current ||
      commands.length === 0 ||
      !ensureCanEdit('apply this edit')
    ) {
      return false;
    }
    try {
      setPreviewDoc(null);
      setDoc(managerRef.current.runTransaction(label, commands));
      setStatus(label);
      return true;
    } catch (error) {
      setStatus(errorMessage(error, 'Edit failed.'));
      return false;
    }
  }

  function finishFeatureCreation(): void {
    // Back to an idle viewport so sequential adds stay one key away; the
    // new feature is selectable from the history or the viewport.
    setTool(null);
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(null);
    setExtrudePreview(null);
  }

  function createFeature(command: AnyCommand): boolean {
    if (executeCommand(command)) {
      finishFeatureCreation();
      return true;
    }
    return false;
  }

  const extrudeSketchReturnRef = useRef<{
    plane: SketchPlaneRef;
    sketchId: string;
  } | null>(null);
  const extrudeSelectionReturnRef = useRef<{
    profiles: RegionPickData[];
    sketchId: SketchId | null;
  } | null>(null);

  /**
   * True for a sketch entity whose profiles must be referenced as a whole.
   *
   * Text is the case: the region count itself changes when the string does,
   * so a geometry-identity reference to one glyph breaks on exactly the edit
   * the feature is for. See `lib/profileReferences.ts`.
   */
  const entityWideProfileSource = useCallback(
    (entityId: string): boolean => {
      const node = doc?.nodes[entityId as EntityId];
      return (
        node?.kind === 'sketch-object' && isEntityWideProfileSource(node.data)
      );
    },
    [doc]
  );

  function startExtrude(sketchId: SketchId) {
    if (tool !== 'extrude') {
      extrudeSelectionReturnRef.current = {
        profiles: [...selectedProfiles],
        sketchId: selectedSketchProfileId
      };
    }
    const view = sketchViews.find(
      (candidate) => candidate.sketchId === sketchId
    );
    const available =
      view?.regions.map((region): RegionPickData => ({
        sketchId,
        profileId: region.profileId,
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.samplePoint,
        centroid: region.centroid,
        boundingBox: region.boundingBox,
        sourceEntityIds: region.sourceEntityIds,
        area: region.area
      })) ?? [];
    if (available.length === 0) {
      setStatus(
        'Open profile — close the boundary or use Profile diagnostics.'
      );
      return;
    }
    const activeSketch =
      interaction.mode === 'sketch' && interaction.session.sketchId === sketchId
        ? interaction.session
        : null;
    const existing = selectedProfiles.filter(
      (profile) =>
        profile.sketchId === sketchId &&
        available.some((candidate) => candidate.profileId === profile.profileId)
    );
    const initialProfiles =
      existing.length > 0 ? existing : available.length === 1 ? available : [];
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(sketchId);
    setSelectedProfiles(initialProfiles);
    setExtrudePreview(
      initialProfiles.length > 0 ? { sketchId, distance: 24 } : null
    );
    setTool('extrude');
    if (activeSketch) {
      extrudeSketchReturnRef.current = {
        plane: activeSketch.plane,
        sketchId
      };
      dispatchInteraction({ type: 'exit-sketch' });
    } else if (interaction.mode !== 'idle') {
      dispatchInteraction({ type: 'clear' });
    }
    requestView('iso');
    setStatus(
      initialProfiles.length > 0
        ? `${initialProfiles.length} profile${initialProfiles.length === 1 ? '' : 's'} selected · exact preview ready.`
        : `Select one or more closed profiles · ${available.length} valid profiles available.`
    );
  }

  async function confirmExtrude() {
    if (
      !extrudePreview ||
      selectedProfiles.length === 0 ||
      Math.abs(extrudePreview.distance) < 0.1
    ) {
      setStatus('Drag the extrusion arrow away from the sketch plane first.');
      return;
    }
    const command = commandFactories.extrudeSketch({
      name: `Extrude ${features.filter((feature) => feature.featureKind === 'extrude').length + 1}`,
      sketchId: extrudePreview.sketchId as SketchId,
      distance: extrudePreview.distance,
      profiles: profileReferencesForSelection(
        selectedProfiles,
        entityWideProfileSource
      )
    });
    const createdBodyId = command.payload.ids!.bodyId;
    profileExtrudePreview.clear();
    const created = await executeValidatedDirectEdit(
      command,
      createdBodyId,
      `Created extrusion ${extrudePreview.distance > 0 ? 'above' : 'below'} the sketch plane.`,
      extrudePreview.distance
    );
    if (!created) {
      profileExtrudePreview.request(extrudePreview.distance);
      return;
    }
    const createdFeature = listFeaturesInOrder(managerRef.current!.document).at(
      -1
    );
    setExtrudePreview(null);
    setPreviewDoc(null);
    setSelectedProfiles([]);
    setSelectedSketchProfileId(null);
    setTool(null);
    extrudeSketchReturnRef.current = null;
    extrudeSelectionReturnRef.current = null;
    setSelectedFeatureNodeId(createdFeature?.id ?? null);
    setSelectedBodyIds(createdFeature?.bodyId ? [createdFeature.bodyId] : []);
    setStatus(`Created ${createdFeature?.name ?? 'extrusion'}.`);
  }

  function launchTool(nextTool: ToolId) {
    const reason = toolDisabledReason(nextTool, availability);
    if (reason) {
      setStatus(`${TOOL_META[nextTool].label}: ${reason}.`);
      return;
    }
    // A toolbar command owns the next gesture. Preserve the body selection
    // that pre-fills Move/boolean forms, but disarm any selection-first face or
    // edge handle so two manipulators can never claim the same pointer.
    if (interaction.mode !== 'idle') {
      cancelDirectManipulationRef.current?.();
      cylinderRadiusPreview.clear();
      cylinderRadiusInspectorSetterRef.current?.(null);
      edgePreview.clear();
      dispatchInteraction({ type: 'clear' });
      setKeypad(null);
    }
    if (nextTool === 'sketch') {
      clearSelection();
      setExtrudePreview(null);
      setTool('sketch');
      setStatus('Sketch mode: draw one closed profile on the selected plane.');
      return;
    }
    if (nextTool === 'extrude') {
      const sketchId =
        (selectedProfiles[0]?.sketchId as SketchId | undefined) ??
        (interaction.mode === 'sketch' && interaction.session.sketchId
          ? (interaction.session.sketchId as SketchId)
          : null) ??
        selectedSketchProfileId ??
        selectedSketch?.sketchId ??
        (sketchOptions.length === 1 ? sketchOptions[0]!.sketchId : null);
      if (sketchId) {
        startExtrude(sketchId);
      } else {
        extrudeSelectionReturnRef.current = {
          profiles: [...selectedProfiles],
          sketchId: selectedSketchProfileId
        };
        setSelectedFeatureNodeId(null);
        setSelectedTopology(null);
        setSelectedEdges([]);
        setSelectedBodyIds([]);
        setTool('extrude');
        setStatus('Extrude: select a shaded closed profile in the viewport.');
      }
      return;
    }
    if (nextTool === 'transform') {
      // A selected sketch takes the gizmo too: translation-only, committed as
      // a sketch translation rather than a Move feature, so every downstream
      // extrude rebuilds in place.
      if (selectedSketch) {
        setExtrudePreview(null);
        setMovePreview({
          bodyId: selectedSketch.sketchId,
          target: 'sketch',
          translation: { x: 0, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        });
        setMoveSnap(null);
        setTool('transform');
        setStatus(
          'Move sketch: drag the arrows — centers snap to faces of other bodies, Shift is free.'
        );
        return;
      }
      // Prefer the gizmo flow when a target body is unambiguous; the classic
      // form remains for multi-body documents with nothing selected.
      const targetBodyId =
        selectedBodyIds.at(-1) ??
        (viewerBodies.length === 1 ? viewerBodies[0]!.bodyId : null);
      if (targetBodyId) {
        setExtrudePreview(null);
        setSelectedBodyIds([targetBodyId]);
        setMovePreview({
          bodyId: targetBodyId,
          translation: { x: 0, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        });
        setMoveSnap(null);
        setTool('transform');
        setStatus(
          'Move/Rotate: drag the arrows or rings — snapping follows your zoom, Shift is free.'
        );
        return;
      }
    }
    if (
      nextTool === 'mirror' ||
      nextTool === 'shell' ||
      nextTool === 'solid-offset'
    ) {
      setModelingTargetBodyId(
        selectedTopology?.bodyId ??
          selectedBodyIds.at(-1) ??
          viewerBodies[0]?.bodyId ??
          null
      );
    }
    // Selection is kept on purpose: booleans/move/fillet pre-fill from it.
    setExtrudePreview(null);
    setTool(nextTool);
  }

  function cancelPanel() {
    const sketchReturn =
      tool === 'extrude' || extrudePreview
        ? extrudeSketchReturnRef.current
        : null;
    const selectionReturn = extrudeSelectionReturnRef.current;
    profileExtrudePreview.clear();
    setPreviewDoc(null);
    setExtrudePreview(null);
    setSelectedProfiles(selectionReturn?.profiles ?? []);
    setSelectedSketchProfileId(selectionReturn?.sketchId ?? null);
    setMovePreview(null);
    setTool(null);
    setSelectedFeatureNodeId(null);
    extrudeSketchReturnRef.current = null;
    extrudeSelectionReturnRef.current = null;
    if (sketchReturn) {
      dispatchInteraction({
        type: 'enter-sketch',
        plane: sketchReturn.plane,
        sketchId: sketchReturn.sketchId
      });
      setStatus(
        'Back in the sketch · extrude canceled; sketch edits preserved.'
      );
    } else if (selectionReturn) {
      setStatus('Extrude canceled · prior profile selection restored.');
    }
  }

  /**
   * Commits a sketch drag: the world translation projects onto the sketch
   * plane's axes, becoming an in-plane object translation plus — for a
   * canonical-plane sketch — a plane-offset change. A face-attached sketch
   * is bound to its surface, so any normal component of the drag is dropped
   * and said out loud rather than silently discarded.
   */
  function confirmSketchMove(preview: MovePreview) {
    if (!doc) {
      return;
    }
    const view = sketchViews.find(
      (candidate) => candidate.sketchId === preview.bodyId
    );
    const sketch = findSketch(doc, preview.bodyId as SketchId);
    if (!view || !sketch) {
      setMovePreview(null);
      return;
    }
    const basis = view.basis;
    const t = preview.translation;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const du = round(t.x * basis.u.x + t.y * basis.u.y + t.z * basis.u.z);
    const dv = round(t.x * basis.v.x + t.y * basis.v.y + t.z * basis.v.z);
    const rawDn =
      t.x * basis.normal.x + t.y * basis.normal.y + t.z * basis.normal.z;
    const canonical = sketch.planeRef.type === 'canonical';
    const dn = canonical ? round(rawDn) : 0;
    setMovePreview(null);
    if (du === 0 && dv === 0 && dn === 0) {
      setTool(null);
      return;
    }
    if (
      executeCommand(
        commandFactories.translateSketch(
          { sketchId: preview.bodyId as SketchId, du, dv, dn },
          `Move ${sketch.name}`
        )
      )
    ) {
      setTool(null);
      setStatus(
        !canonical && Math.abs(rawDn) > 1e-6
          ? `Moved ${sketch.name} in its plane · the out-of-plane part was dropped (a face sketch stays on its face).`
          : `Moved ${sketch.name}.`
      );
    }
  }

  function confirmMove() {
    const preview = movePreview;
    if (!preview || !doc) {
      return;
    }
    if (preview.target === 'sketch') {
      confirmSketchMove(preview);
      return;
    }
    const body = representations[preview.bodyId as BodyId];
    if (!body) {
      return;
    }
    const center = {
      x: (body.bbox.min.x + body.bbox.max.x) / 2,
      y: (body.bbox.min.y + body.bbox.max.y) / 2,
      z: (body.bbox.min.z + body.bbox.max.z) / 2
    };
    // Rotation is about the gizmo center; fold the pivot into the feature's
    // world-origin translation (see composeMoveTransform).
    const translation = composeMoveTransform(
      center,
      preview.translation,
      preview.rotationDeg
    );
    const round = (value: number) => Math.round(value * 1000) / 1000;
    setMovePreview(null);
    const created = createFeature(
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: preview.bodyId as BodyId,
        translation: {
          x: round(translation.x),
          y: round(translation.y),
          z: round(translation.z)
        },
        rotationDeg: {
          x: round(preview.rotationDeg.x),
          y: round(preview.rotationDeg.y),
          z: round(preview.rotationDeg.z)
        }
      })
    );
    if (created) {
      // Hold the gizmo pose on screen until the exact rebuild replaces the
      // meshes; cleared by onDerived in the same batch as the new geometry.
      setMoveCommitHold(preview);
    }
  }

  function clearSelection() {
    if (
      interaction.mode === 'face' &&
      interaction.op === 'resize-cylinder-radius'
    ) {
      cancelDirectManipulationRef.current?.();
      handleCylinderRadiusCancel();
    }
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(null);
    setSelectedProfiles([]);
    if (interaction.mode !== 'idle' && interaction.mode !== 'sketch') {
      dispatchInteraction({ type: 'clear' });
    }
  }

  function requestView(view: ViewTarget) {
    setViewRequest({ view, nonce: ++viewNonceRef.current });
  }

  function requestRotate(direction: 'cw' | 'ccw') {
    setRotateRequest({ direction, nonce: ++viewNonceRef.current });
  }

  function cycleDisplayMode() {
    const index = DISPLAY_MODE_ORDER.indexOf(viewerSettings.displayMode);
    const next =
      DISPLAY_MODE_ORDER[(index + 1) % DISPLAY_MODE_ORDER.length] ??
      'shaded-edges';
    setViewerSettings((current) => ({ ...current, displayMode: next }));
    setStatus(`Display: ${DISPLAY_MODE_LABELS[next]}.`);
  }

  function toggleProjection() {
    setProjection((current) => {
      const next = current === 'perspective' ? 'orthographic' : 'perspective';
      setStatus(`Projection: ${next}.`);
      return next;
    });
  }

  function toggleBodyVisibility(bodyId: string) {
    setHiddenBodyIds((current) => {
      const next = new Set(current);
      if (next.has(bodyId)) {
        next.delete(bodyId);
      } else {
        next.add(bodyId);
      }
      return next;
    });
  }

  function showAllBodies() {
    setHiddenBodyIds(new Set());
    setStatus('All bodies visible.');
  }

  function handleAppSettingsChange(next: AppSettings) {
    appSettingsRef.current = next;
    setAppSettings(next);
    const controller = cloudSettingsAutosaveRef.current;
    if (controller) {
      controller.schedule(next);
    } else {
      syncedRevisionRef.current = null;
      saveLocalAppSettings(next, null);
    }
    if (sessionRef.current && accountSettingsRef.current) {
      setSettingsMessage('Saved on this device · saving to cloud profile…');
    } else {
      setSettingsMessage('Saved on this device.');
    }
  }

  /**
   * Keeps a resized panel. It goes down the same road as every other
   * preference: the device copy is written immediately, and a signed-in session
   * syncs it to the account profile, so the width follows the person rather
   * than the browser they set it in.
   */
  function commitPanelWidth(panel: 'sidebar' | 'assistant', width: number) {
    const current = appSettingsRef.current;
    const saved = savedPanelWidths(current);
    if (saved[panel] === width) {
      return;
    }
    handleAppSettingsChange({
      ...current,
      layout: {
        sidebarWidth: panel === 'sidebar' ? width : saved.sidebar,
        assistantWidth: panel === 'assistant' ? width : saved.assistant
      }
    });
  }

  function endCloudSettingsSession() {
    if (cloudSettingsSessionUserRef.current !== null) {
      cloudSettingsAutosaveRef.current?.endSession();
      cloudSettingsSessionUserRef.current = null;
    }
    // The next session on this device may be a different account; it must not
    // reconcile against this account's sync baselines.
    void clearAllLastSyncedVersions();
    sessionRef.current = null;
    accountSettingsRef.current = null;
    setSession(null);
    setAccountSettings(null);
  }

  function openSettings() {
    setSettingsOpen(true);
    setPaletteOpen(false);
    setSettingsMessage('Changes save on this device immediately.');
    setAuthConfigStatus('loading');
    void api
      .health()
      .then(setDeploymentHealth)
      .catch(() => setDeploymentHealth(null));
    void Promise.all([
      api
        .authConfig()
        .then((config) => ({ config, status: 'ready' as const }))
        .catch(() => ({ config: null, status: 'unavailable' as const })),
      api.session().catch(() => null)
    ]).then(async ([nextAuth, activeSession]) => {
      setAuthConfig(nextAuth.config);
      setAuthConfigStatus(nextAuth.status);
      sessionRef.current = activeSession;
      setSession(activeSession);
      if (!activeSession) {
        endCloudSettingsSession();
        setSettingsMessage(
          nextAuth.status === 'ready'
            ? 'Device settings active · sign in for cloud sync.'
            : 'Beta sign-in unavailable · device settings remain active.'
        );
        return;
      }
      try {
        const remoteSettings = await api.getSettings();
        accountSettingsRef.current = remoteSettings;
        setAccountSettings(remoteSettings);
        setSettingsMessage('Cloud profile connected.');
      } catch {
        setSettingsMessage(
          'Cloud profile unavailable · device settings remain active.'
        );
      }
    });
  }

  async function handleRefreshAuthConfig() {
    setAuthConfigStatus('loading');
    setSettingsMessage('Checking beta sign-in readiness…');
    try {
      const nextAuthConfig = await api.authConfig();
      setAuthConfig(nextAuthConfig);
      setAuthConfigStatus('ready');
      setSettingsMessage(
        nextAuthConfig.emailCodeEnabled
          ? 'Email sign-in ready.'
          : 'Email sign-in is not configured · device settings remain active.'
      );
    } catch {
      setAuthConfig(null);
      setAuthConfigStatus('unavailable');
      setSettingsMessage(
        'Beta sign-in configuration unavailable · device settings remain active.'
      );
    }
  }

  async function syncSettingsBeforeAssistantAction() {
    const controller = cloudSettingsAutosaveRef.current;
    if (!sessionRef.current || !accountSettingsRef.current || !controller) {
      throw new Error('Account settings storage is unavailable.');
    }
    if (
      !controller.hasPendingChanges &&
      controller.syncedRevision === accountSettingsRef.current.revision
    ) {
      return accountSettingsRef.current;
    }
    if (!controller.hasPendingChanges) {
      controller.schedule(appSettingsRef.current, 0);
    }
    const response = await controller.flushPending();
    const currentAccount = accountSettingsRef.current;
    if (
      !currentAccount ||
      controller.hasPendingChanges ||
      controller.syncedRevision !== currentAccount.revision
    ) {
      throw new Error(
        'Cloud settings could not be saved. Your device copy is still safe.'
      );
    }
    return response ?? currentAccount;
  }

  async function handleSaveAssistantCredential(token: string) {
    setSettingsBusy(true);
    setSettingsMessage('Encrypting and saving personal credential…');
    try {
      await syncSettingsBeforeAssistantAction();
      const response = await api.saveAssistantCredential({ token });
      setAccountSettings(response);
      setSettingsMessage(
        `Personal credential saved as ${response.credential.hint}.`
      );
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Credential save failed.'));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleDeleteAssistantCredential() {
    if (
      appSettings.general.confirmDestructiveActions &&
      !window.confirm('Remove the saved personal AI credential?')
    ) {
      return;
    }
    setSettingsBusy(true);
    setSettingsMessage('Removing personal credential…');
    try {
      const response = await api.deleteAssistantCredential();
      setAccountSettings(response);
      setSettingsMessage('Personal credential removed.');
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Credential removal failed.'));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleTestAssistantConnection() {
    setSettingsBusy(true);
    setSettingsMessage('Testing the configured provider…');
    try {
      await syncSettingsBeforeAssistantAction();
      const result = await api.testAssistantConnection();
      const response = await api.getSettings();
      setAccountSettings(response);
      setSettingsMessage(`Connection ready · ${result.latencyMs} ms.`);
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Connection test failed.'));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleRequestLoginCode(email: string, turnstileToken: string) {
    setSettingsBusy(true);
    setSettingsMessage('Sending a sign-in code…');
    try {
      const response = await api.startEmailLogin({ email, turnstileToken });
      setSettingsMessage('Code sent. Check your email.');
      return response;
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Could not send a sign-in code.'));
      throw error;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleVerifyLoginCode(challengeId: string, code: string) {
    setSettingsBusy(true);
    setSettingsMessage('Verifying sign-in code…');
    try {
      const activeSession = await api.verifyEmailLogin({
        challengeId,
        code
      });
      const [remoteSettings, listed] = await Promise.all([
        api.getSettings(),
        loadProjectSummaries(true)
      ]);
      sessionRef.current = activeSession;
      setSession(activeSession);
      accountSettingsRef.current = remoteSettings;
      setAccountSettings(remoteSettings);
      if (
        remoteSettings.synced &&
        shouldAdoptAccountSettings({
          settings: appSettingsRef.current,
          syncedRevision: syncedRevisionRef.current
        })
      ) {
        appSettingsRef.current = remoteSettings.settings;
        setAppSettings(remoteSettings.settings);
        cloudSettingsAutosaveRef.current?.adoptSyncedSettings(
          remoteSettings.settings,
          remoteSettings
        );
      } else {
        cloudSettingsAutosaveRef.current?.schedule(appSettingsRef.current, 0);
      }
      setProjects(listed.projects);
      setCloudProjectIds(listed.cloudProjectIds);
      const activeProjectIsCloud = Boolean(
        doc && remoteVersionsRef.current.has(doc.projectId)
      );
      setCloudAvailable(activeProjectIsCloud);
      if (doc) {
        setSaveState(activeProjectIsCloud ? 'synced' : 'local');
      }
      // Signing in does not upload anything on its own. Projects made while
      // signed out are still the user's to keep on one device if they want, so
      // the count is an offer the start screen makes, not an action taken here.
      const localOnly = listed.projects.filter(
        (project) => !listed.cloudProjectIds.has(project.projectId)
      ).length;
      setSettingsMessage(
        localOnly === 0
          ? `Signed in as ${activeSession.email ?? activeSession.displayName}.`
          : `Signed in as ${activeSession.email ?? activeSession.displayName} · ${localOnly} project(s) on this device only.`
      );
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Sign-in failed.'));
      throw error;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleLogout() {
    setSettingsBusy(true);
    setSettingsMessage('Signing out…');
    try {
      // Both queues drain before the session goes away, or their contents
      // become unsendable the moment the cookie does.
      await cloudProjectAutosaveRef.current?.flushPending();
      cloudProjectAutosaveRef.current?.closeProject();
      await cloudSettingsAutosaveRef.current?.flushPending();
      await api.logout();
      const listed = await loadProjectSummaries(false);
      remoteVersionsRef.current.clear();
      cloudSettingsAutosaveRef.current?.endSession();
      cloudSettingsSessionUserRef.current = null;
      // The next sign-in on this device may be a different account.
      void clearAllLastSyncedVersions();
      sessionRef.current = null;
      setSession(null);
      accountSettingsRef.current = null;
      setAccountSettings(null);
      setCloudAvailable(false);
      setProjects(listed.projects);
      // Nothing is in "the account" once there is no account in session, so the
      // shelf must stop claiming otherwise.
      setCloudProjectIds(new Set());
      setSaveState('local');
      setSettingsMessage('Signed out · device settings remain active.');
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Sign-out failed.'));
      throw error;
    } finally {
      setSettingsBusy(false);
    }
  }

  function handleResetAppSettings() {
    if (
      appSettings.general.confirmDestructiveActions &&
      !window.confirm(
        'Reset application settings on this device? Projects are not deleted.'
      )
    ) {
      return;
    }
    const defaults = defaultAppSettings();
    // A reset is a local edit like any other: it must survive the next boot
    // rather than being undone by the account copy.
    handleAppSettingsChange(defaults);
    setSettingsMessage(
      sessionRef.current && accountSettingsRef.current
        ? 'Application settings reset · saving to cloud profile…'
        : 'Application settings reset on this device.'
    );
  }

  function applyViewportDefaults() {
    setProjection(appSettings.viewport.defaultProjection);
    setViewerSettings({
      showGrid: appSettings.viewport.showGrid,
      displayMode: appSettings.viewport.displayMode,
      reducedMotion: appSettings.appearance.reducedMotion
    });
    setSettingsMessage('Viewport defaults applied to the current view.');
  }

  async function handleCreateProject(name: string, units: UnitSystem) {
    setAssistantCollapsed(true);
    setBusy(true);
    try {
      await flushPendingLocalSave();
      if (!session) {
        const localDocument = createProjectDocument(name, localUserId, units);
        await saveLocalProject(localDocument);
        hydrateDocument(localDocument);
        setProjects((current) => [
          summarizeLocalDocument(localDocument),
          ...current
        ]);
        setCloudAvailable(false);
        setSaveState('local');
        setStatus(`Created ${localDocument.name} locally.`);
        return;
      }
      const response = await api.createProject({ name, units });
      remoteVersionsRef.current.set(
        response.document.projectId,
        response.document.version
      );
      setCloudAvailable(true);
      hydrateDocument(response.document);
      setProjects((current) => [response.project, ...current]);
      setStatus(`Created ${response.project.name}.`);
    } catch (error) {
      // A refused request is not an unreachable one. Falling back to local mode
      // on a validation failure would persist exactly the project the server
      // just rejected, so surface it and let the user correct the input.
      if (
        error instanceof ApiError &&
        error.isClientError &&
        error.status !== 401
      ) {
        setCloudAvailable(true);
        setStatus(errorMessage(error, 'Could not create the project.'));
        return;
      }
      const sessionExpired = error instanceof ApiError && error.status === 401;
      if (sessionExpired) {
        remoteVersionsRef.current.clear();
        endCloudSettingsSession();
      }
      const localDocument = createProjectDocument(
        name,
        sessionExpired ? localUserId : (session?.userId ?? localUserId),
        units
      );
      await saveLocalProject(localDocument);
      hydrateDocument(localDocument);
      setProjects((current) => [
        summarizeLocalDocument(localDocument),
        ...current
      ]);
      setCloudAvailable(false);
      setSaveState('local');
      setStatus(
        `${errorMessage(error, 'Cloud unavailable')} Working locally · save it to your account later.`
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * The account's copy of a just-adopted project, wearing this device's derived
   * geometry. Adoption changes ownership and appends a checkpoint but leaves
   * canonical history and `version` alone, so the meshes the device already has
   * still describe the document — and reusing them keeps the viewport from
   * blanking while an identical rebuild runs.
   */
  function withLocalDerived(
    remote: ProjectDocument,
    local: ProjectDocument
  ): ProjectDocument {
    return {
      ...remote,
      derived: {
        ...remote.derived,
        bodyRepresentations: local.derived.bodyRepresentations,
        exportableBodyIds: local.derived.exportableBodyIds
      }
    };
  }

  /**
   * Gives one device-local project an account record, keeping its id so the
   * device's own copy and shelf state stay pointed at the same project.
   *
   * Returns whether anything changed rather than reporting status itself: the
   * bulk path has to summarize many of these, and one line per project would
   * bury the result.
   */
  async function adoptLocalProject(
    projectId: string
  ): Promise<'adopted' | 'already-adopted' | 'missing'> {
    const local = await loadLocalProject(projectId);
    if (!local) {
      return 'missing';
    }
    try {
      const response = await api.adoptProject(local);
      const merged = withLocalDerived(response.document, local);
      await saveLocalProject(merged);
      remoteVersionsRef.current.set(merged.projectId, merged.version);
      setCloudProjectIds((current) => new Set(current).add(merged.projectId));
      setProjects((current) =>
        mergeProjectSummaries([response.project], current)
      );
      if (managerRef.current?.document.projectId === merged.projectId) {
        managerRef.current.document = merged;
        setDoc(merged);
        setCloudAvailable(true);
        setSaveState('synced');
        cloudProjectAutosaveRef.current?.adoptAccountVersion(
          merged.projectId,
          merged.version
        );
      }
      return 'adopted';
    } catch (error) {
      // The account already has it — the device was simply out of date about
      // that, which is not a failure and must not be reported as one.
      if (error instanceof ApiError && error.code === 'ALREADY_ADOPTED') {
        setCloudProjectIds((current) => new Set(current).add(projectId));
        return 'already-adopted';
      }
      throw error;
    }
  }

  async function handleSaveToAccount(project: ProjectSummary) {
    if (!session) {
      setStatus('Sign in to save this project to your account.');
      return;
    }
    setBusy(true);
    try {
      await flushPendingLocalSave();
      const outcome = await adoptLocalProject(project.projectId);
      setStatus(
        outcome === 'adopted'
          ? `Saved ${project.name} to your account.`
          : outcome === 'already-adopted'
            ? `${project.name} was already in your account.`
            : `${project.name} has no copy on this device to save.`
      );
    } catch (error) {
      setStatus(
        errorMessage(error, `Could not save ${project.name} to your account.`)
      );
    } finally {
      setBusy(false);
    }
  }

  function patchSyncEntry(projectId: string, patch: Partial<SyncEntry>) {
    setSyncRun((current) =>
      current
        ? current.map((entry) =>
            entry.projectId === projectId ? { ...entry, ...patch } : entry
          )
        : current
    );
  }

  /**
   * Runs one project's adoption and records the outcome on its sync entry.
   * Returns whether the attempt should stop the run: an expired session fails
   * every later project identically, so retrying N more times is just noise.
   */
  async function syncOneToAccount(candidate: {
    projectId: string;
    name: string;
  }): Promise<{ adopted: boolean; failed: boolean; halt: boolean }> {
    patchSyncEntry(candidate.projectId, {
      state: 'syncing',
      detail: undefined
    });
    try {
      const outcome = await adoptLocalProject(candidate.projectId);
      if (outcome === 'missing') {
        patchSyncEntry(candidate.projectId, {
          state: 'failed',
          detail: 'No copy of this project exists on this device.'
        });
        return { adopted: false, failed: true, halt: false };
      }
      patchSyncEntry(candidate.projectId, {
        state: 'synced',
        detail:
          outcome === 'already-adopted'
            ? 'Was already in your account.'
            : undefined
      });
      return { adopted: outcome === 'adopted', failed: false, halt: false };
    } catch (error) {
      const { detail, auth } = describeSyncFailure(error);
      patchSyncEntry(candidate.projectId, { state: 'failed', detail });
      if (auth) {
        remoteVersionsRef.current.clear();
        endCloudSettingsSession();
      }
      return { adopted: false, failed: true, halt: auth };
    }
  }

  /**
   * Uploads every project this device holds alone. Failures are recorded
   * rather than thrown: one document the account refuses — too large, say —
   * must not strand the rest. Progress is published per project through
   * `syncRun` so the shelf can show each upload as it happens and keep the
   * failures, with reasons, on screen afterwards.
   */
  async function handleSaveAllToAccount(candidates: ProjectSummary[]) {
    if (!session || candidates.length === 0) {
      return;
    }
    setBusy(true);
    setStatus(`Saving ${candidates.length} project(s) to your account…`);
    setSyncRun(
      candidates.map((candidate) => ({
        projectId: candidate.projectId,
        name: candidate.name,
        state: 'pending'
      }))
    );
    try {
      await flushPendingLocalSave();
      let saved = 0;
      let failed = 0;
      let halted = false;
      for (const candidate of candidates) {
        if (halted) {
          failed += 1;
          patchSyncEntry(candidate.projectId, {
            state: 'failed',
            detail: 'Not attempted — sign in again first.'
          });
          continue;
        }
        const result = await syncOneToAccount(candidate);
        if (result.adopted) {
          saved += 1;
        }
        if (result.failed) {
          failed += 1;
        }
        halted = result.halt;
      }
      // The names and reasons live in the sync panel; repeating them here
      // would overflow the status line with the very names that failed.
      setStatus(
        failed === 0
          ? `Saved ${saved} project(s) to your account.`
          : `Saved ${saved} project(s) · ${failed} could not be saved. See the list above for why.`
      );
    } finally {
      setBusy(false);
    }
  }

  /** Re-attempts a single failed entry from the sync panel. */
  async function handleRetrySync(projectId: string) {
    if (!session) {
      setStatus('Sign in to retry saving this project.');
      return;
    }
    const entry = syncRun?.find(
      (candidate) => candidate.projectId === projectId
    );
    if (!entry) {
      return;
    }
    setBusy(true);
    try {
      await flushPendingLocalSave();
      await syncOneToAccount(entry);
    } finally {
      setBusy(false);
    }
  }

  /**
   * One-off exact sync against the geometry worker, resolved by request id —
   * used for seeding demo documents, whose finishing features need exact edge
   * ordinals before the document is ever opened.
   */

  async function handleOpenDemo(definition: DemoDefinition) {
    setBusy(true);
    try {
      await flushPendingLocalSave();
      const existing = await loadLocalProject(definition.projectId);
      if (existing) {
        hydrateDocument(existing);
        setStatus(`Opened ${existing.name}.`);
        return;
      }
      setStatus(`Building ${definition.name}…`);
      const document = await buildDemoDocument(
        definition,
        session?.userId ?? localUserId,
        (candidate) => geometry.syncOnce(candidate)
      );
      await saveLocalProject(document);
      hydrateDocument(document);
      setCloudAvailable(false);
      setProjects((current) => [
        summarizeLocalDocument(document),
        ...current.filter((project) => project.projectId !== document.projectId)
      ]);
      setStatus(
        `${definition.name} ready — three revisions in the feature history.`
      );
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to build the demo.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenProject(projectId: string) {
    setBusy(true);
    try {
      await flushPendingLocalSave();
      const [localDocument, remoteDocument, lastSyncedVersion] =
        await Promise.all([
          loadLocalProject(projectId),
          session
            ? api.loadProject(projectId).catch(() => null)
            : Promise.resolve(null),
          loadLastSyncedVersion(projectId)
        ]);
      const outcome = chooseProjectDocument(
        localDocument,
        remoteDocument,
        lastSyncedVersion
      );
      if (outcome.choice === 'none') {
        throw new Error('Project not found locally or in the beta API.');
      }
      setCloudAvailable(Boolean(remoteDocument));
      if (remoteDocument) {
        remoteVersionsRef.current.set(
          remoteDocument.projectId,
          remoteDocument.version
        );
      }
      if (outcome.choice === 'diverged') {
        // Both copies moved since this device last agreed with the account.
        // Open the local one — it is the work in front of the user — and ask
        // rather than discarding either side.
        hydrateDocument(outcome.local);
        setAccountConflict(
          conflictFromDocuments(outcome.local, outcome.remote, 'account')
        );
        setSaveState('conflict');
        setStatus(
          `${outcome.local.name} changed here and in your account. Nothing has been discarded — choose which to keep.`
        );
        return;
      }
      hydrateDocument(outcome.document);
      if (outcome.choice === 'remote') {
        await saveLocalProject(outcome.document);
        await saveLastSyncedVersion(projectId, outcome.document.version);
      }
      setStatus(
        outcome.choice === 'local' && remoteDocument
          ? `Opened newer local edits for ${outcome.document.name}.`
          : `Opened ${outcome.document.name}.`
      );
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to open project.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoHome() {
    await flushPendingLocalSave();
    await cloudProjectAutosaveRef.current?.flushPending();
    clearActiveProject();
    forgetProjectView();
    managerRef.current = null;
    setDoc(null);
    setArtifacts([]);
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(null);
    setSelectedProfiles([]);
    setExtrudePreview(null);
    setTool(null);
    try {
      const listed = await loadProjectSummaries(Boolean(session));
      setProjects(listed.projects);
      setCloudProjectIds(listed.cloudProjectIds);
      setCloudAvailable(listed.remoteReached);
      setStatus(`${listed.projects.length} project(s) available.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to refresh projects.'));
    }
  }

  /**
   * Records shelf state in both stores. The device copy is written first and
   * is the one the UI trusts, so organising a part keeps working with the
   * cloud unreachable or the project local-only; the account write is a
   * best-effort mirror for the owner's other devices.
   */
  async function persistOrganization(
    projectId: string,
    organization: ProjectOrganization
  ): Promise<void> {
    // The device copy is authoritative. Do not claim success unless it is
    // durable locally; a failed account mirror is retried during discovery.
    await saveLocalProjectOrganization(projectId, organization);
    setProjects((current) =>
      current
        .map((project) =>
          project.projectId === projectId
            ? { ...project, organization }
            : project
        )
        .sort(compareProjectSummaries)
    );
    if (!session) {
      return;
    }
    await api
      .updateProject({
        projectId: toProjectId(projectId),
        status: organization.status,
        pinned: organization.pinned,
        sortOrder: organization.sortOrder
      })
      .catch(() => undefined);
  }

  async function handleMoveProjectToShelf(
    project: ProjectSummary,
    status: ProjectStatus
  ) {
    try {
      const organization = applyOrganizationUpdate(
        projectOrganization(project),
        { status }
      );
      await persistOrganization(project.projectId, organization);
      setStatus(
        status === 'deleted'
          ? `Moved ${project.name} to the trash · restorable for ${TRASH_RETENTION_DAYS} days.`
          : status === 'archived'
            ? `Archived ${project.name}.`
            : `Restored ${project.name}.`
      );
    } catch (error) {
      setStatus(errorMessage(error, `Could not move ${project.name}.`));
    }
  }

  async function handleTogglePin(project: ProjectSummary) {
    try {
      const current = projectOrganization(project);
      await persistOrganization(
        project.projectId,
        applyOrganizationUpdate(current, { pinned: !current.pinned })
      );
      setStatus(
        current.pinned ? `Unpinned ${project.name}.` : `Pinned ${project.name}.`
      );
    } catch (error) {
      setStatus(errorMessage(error, `Could not update ${project.name}.`));
    }
  }

  async function handleReorderProjects(projectIds: string[]) {
    const positions = new Map(projectIds.map((id, index) => [id, index]));
    const organizations = new Map(
      projects
        .filter((project) => positions.has(project.projectId))
        .map((project) => [
          project.projectId,
          {
            ...projectOrganization(project),
            sortOrder: positions.get(project.projectId)!
          }
        ])
    );
    try {
      await Promise.all(
        [...organizations].map(([projectId, organization]) =>
          saveLocalProjectOrganization(projectId, organization)
        )
      );
      setProjects((current) =>
        current
          .map((project) => {
            const organization = organizations.get(project.projectId);
            return organization ? { ...project, organization } : project;
          })
          .sort(compareProjectSummaries)
      );
      if (session) {
        await api
          .reorderProjects({ projectIds: projectIds.map(toProjectId) })
          .catch(() => undefined);
      }
    } catch (error) {
      setStatus(errorMessage(error, 'Could not reorder the projects.'));
    }
  }

  async function handleDuplicateProject(project: ProjectSummary) {
    setBusy(true);
    try {
      await flushPendingLocalSave();
      if (session) {
        try {
          const response = await api.duplicateProject(project.projectId);
          // Kept on the device too, so the copy opens offline exactly like the
          // original it was made from.
          await saveLocalProject(response.document).catch(() => undefined);
          if (response.project.organization) {
            await saveLocalProjectOrganization(
              response.project.projectId,
              response.project.organization
            ).catch(() => undefined);
          }
          setProjects((current) =>
            [...current, response.project].sort(compareProjectSummaries)
          );
          setStatus(`Duplicated ${project.name} as ${response.project.name}.`);
          return;
        } catch (error) {
          // A project the account has never seen is not a failure — it just
          // means the device holding it has to make the copy.
          const missing =
            error instanceof ApiError &&
            (error.status === 404 || error.status === 401);
          if (!missing) {
            throw error;
          }
        }
      }
      const source = await loadLocalProject(project.projectId);
      if (!source) {
        throw new Error('The project could not be read from this device.');
      }
      const copy = duplicateProjectDocument(
        source,
        duplicateProjectName(
          source.name,
          projects.map((summary) => summary.name)
        ),
        session?.userId ?? localUserId
      );
      const organization: ProjectOrganization = {
        ...DEFAULT_PROJECT_ORGANIZATION,
        sortOrder: projectOrganization(project).sortOrder
      };
      await saveLocalProject(copy);
      await saveLocalProjectOrganization(copy.projectId, organization).catch(
        () => undefined
      );
      setProjects((current) =>
        [...current, summarizeLocalDocument(copy, organization)].sort(
          compareProjectSummaries
        )
      );
      setStatus(`Duplicated ${project.name} as ${copy.name}.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Could not duplicate the project.'));
    } finally {
      setBusy(false);
    }
  }

  /** Destroys projects in both stores. There is no undo past this point. */
  async function destroyProjects(targets: ProjectSummary[]): Promise<void> {
    const outcomes = await Promise.all(
      targets.map(async (project) => {
        let failure: unknown;
        try {
          await deleteLocalProject(project.projectId);
        } catch (error) {
          failure = error;
        }
        if (session) {
          try {
            await api.deleteProject(project.projectId);
          } catch (error) {
            // A signed-in user can still have local-only projects. Missing from
            // the account is therefore success, but every other failure must be
            // visible and retryable.
            if (!(error instanceof ApiError && error.status === 404)) {
              failure ??= error;
            }
          }
        }
        return { projectId: project.projectId, failure };
      })
    );
    const destroyed = new Set(
      outcomes
        .filter((outcome) => outcome.failure === undefined)
        .map((outcome) => outcome.projectId)
    );
    setProjects((current) =>
      current.filter((project) => !destroyed.has(project.projectId))
    );
    const failed = outcomes.find((outcome) => outcome.failure !== undefined);
    if (failed) {
      throw failed.failure;
    }
  }

  async function handleDeleteProjectForever(project: ProjectSummary) {
    if (
      appSettings.general.confirmDestructiveActions &&
      !window.confirm(
        `Permanently delete “${project.name}”? This cannot be undone.`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await destroyProjects([project]);
      setStatus(`Deleted ${project.name} permanently.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Could not delete the project.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleEmptyTrash(trashed: ProjectSummary[]) {
    if (trashed.length === 0) {
      return;
    }
    if (
      appSettings.general.confirmDestructiveActions &&
      !window.confirm(
        `Permanently delete ${trashed.length} project(s) in the trash? This cannot be undone.`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await destroyProjects(trashed);
      setStatus(`Emptied the trash · ${trashed.length} project(s) deleted.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Could not empty the trash.'));
    } finally {
      setBusy(false);
    }
  }

  function handleUndo() {
    if (!managerRef.current || !ensureCanEdit('undo')) {
      return;
    }
    setDoc(managerRef.current.undo());
    setExtrudePreview(null);
    setMoveCommitHold(null);
    setTool(null);
    clearSelection();
    setStatus('Undo');
  }

  function handleRedo() {
    if (!managerRef.current || !ensureCanEdit('redo')) {
      return;
    }
    setDoc(managerRef.current.redo());
    setExtrudePreview(null);
    setMoveCommitHold(null);
    setTool(null);
    clearSelection();
    setStatus('Redo');
  }

  async function handleSave() {
    if (!doc) {
      return;
    }
    try {
      setSaveState('saving');
      await saveLocalProject(doc);
      if (!ensureCanEdit('save a shared revision')) {
        setSaveState('offline');
        return;
      }
      const expectedVersion = remoteVersionsRef.current.get(doc.projectId);
      if (!session || expectedVersion === undefined) {
        setCloudAvailable(false);
        setSaveState('local');
        setStatus('Saved on this device.');
        return;
      }
      // A queued autosave writing the same document behind this one would race
      // the checkpoint for the version fence, and the loser reports a conflict
      // that does not exist. Drain it first; a manual save is worth the wait.
      await cloudProjectAutosaveRef.current?.flushPending();
      const saved = await api.saveRevision({
        projectId: doc.projectId,
        reason: 'Manual save',
        expectedVersion:
          cloudProjectAutosaveRef.current?.syncedVersion ?? expectedVersion,
        document: withoutDerivedProjection(doc)
      });
      remoteVersionsRef.current.set(saved.projectId, saved.version);
      const restored = withLocalDerived(saved, doc);
      if (managerRef.current) {
        managerRef.current.document = restored;
      }
      setDoc(restored);
      setCloudAvailable(true);
      setSaveState('synced');
      cloudProjectAutosaveRef.current?.adoptAccountVersion(
        restored.projectId,
        restored.version
      );
      setStatus('Saved revision.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        remoteVersionsRef.current.clear();
        endCloudSettingsSession();
      }
      setCloudAvailable(false);
      setSaveState(
        error instanceof ApiError && error.status === 409
          ? 'conflict'
          : 'offline'
      );
      setStatus(
        `${errorMessage(error, 'Cloud save failed')} Saved on this device.`
      );
    }
  }

  const aiPreviewEpochRef = useRef(0);

  async function handlePreviewPatch(
    proposal: CadPatchProposal | null
  ): Promise<boolean> {
    const epoch = ++aiPreviewEpochRef.current;
    if (!proposal) {
      setPreviewDoc(null);
      setStatus('Preview cleared.');
      return true;
    }
    const current = managerRef.current?.document;
    if (!current) {
      return false;
    }
    try {
      setStatus('Validating AI preview with the exact geometry kernel…');
      const preflight = await preflightCadPatch(
        current,
        proposal,
        (candidate) => geometry.syncOnce(candidate)
      );
      const live = managerRef.current?.document;
      if (
        epoch !== aiPreviewEpochRef.current ||
        !live ||
        live.projectId !== current.projectId ||
        live.version !== current.version
      ) {
        return false;
      }
      setPreviewDoc(preflight.candidate);
      setStatus('Previewing exact proposed geometry.');
      return true;
    } catch (error) {
      if (epoch !== aiPreviewEpochRef.current) {
        return false;
      }
      setPreviewDoc(null);
      setStatus(errorMessage(error, 'Patch preview failed.'));
      return false;
    }
  }

  async function handleApplyPatch(
    proposal: CadPatchProposal
  ): Promise<boolean> {
    if (!ensureCanEdit('apply this AI proposal')) {
      return false;
    }
    const current = managerRef.current?.document;
    if (!current) {
      return false;
    }
    setBusy(true);
    try {
      setStatus('Validating AI patch with the exact geometry kernel…');
      const preflight = await preflightCadPatch(
        current,
        proposal,
        (candidate) => geometry.syncOnce(candidate)
      );
      const live = managerRef.current?.document;
      if (
        !live ||
        live.projectId !== current.projectId ||
        live.version !== current.version
      ) {
        throw new Error(
          'The document changed during exact AI preflight. Review the refreshed proposal before applying it.'
        );
      }
      const applied = executeTransaction('Apply AI patch', preflight.commands);
      if (applied) {
        // Topology ids belong to the pre-patch body. A fillet, boolean, or
        // pattern may consume that body and rebuild different edges/faces, so
        // retaining the old selection would poison the next assistant turn.
        setTool(null);
        clearSelection();
      }
      return applied;
    } catch (error) {
      setStatus(errorMessage(error, 'Patch could not be applied.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function archiveArtifact(input: {
    fileName: string;
    contentType: string;
    kind: ArtifactKind;
    body: Blob;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<string> {
    if (!doc) {
      throw new Error('No project is open.');
    }
    if (!ensureCanEdit('upload a project artifact')) {
      throw new Error(editDisabledReason ?? 'Project editing is unavailable.');
    }
    const { session: upload } = await api.createUploadSession({
      projectId: doc.projectId,
      fileName: input.fileName,
      contentType: input.contentType,
      kind: input.kind,
      metadata: input.metadata
    });
    if (!upload.uploadUrl) {
      throw new Error('Artifact upload is unavailable.');
    }
    await api.uploadArtifact(upload.uploadUrl, input.body);
    await api.finalizeArtifact({
      projectId: doc.projectId,
      uploadSessionId: upload.uploadSessionId,
      artifactId: upload.artifactId
    });
    const stored = await api.getArtifactMetadata(upload.artifactId);
    if (stored.artifact) {
      const artifact = stored.artifact;
      setArtifacts((current) => [
        artifact,
        ...current.filter(
          (currentArtifact) =>
            currentArtifact.artifactId !== artifact.artifactId
        )
      ]);
    }
    return upload.artifactId;
  }

  async function handleImportFile(file: File) {
    if (!managerRef.current || !doc || !ensureCanEdit('import geometry')) {
      return;
    }
    const contentType = file.type || inferContentType(file.name);
    const lowerName = file.name.toLowerCase();

    if (lowerName.endsWith('.stl')) {
      let parsed;
      try {
        parsed = parseStl(await file.arrayBuffer(), file.name);
      } catch (error) {
        setStatus(errorMessage(error, 'STL import failed.'));
        return;
      }

      // Best-effort archive of the original upload; the mesh itself lives in
      // the document, so a storage failure must not block the import.
      let artifactId = `artifact_local_${crypto.randomUUID()}`;
      let archived = false;
      try {
        artifactId = await archiveArtifact({
          fileName: file.name,
          contentType,
          kind: 'stl-import',
          body: file,
          metadata: { source: 'direct-upload' }
        });
        archived = true;
      } catch {
        // Continue with the local import.
      }

      const created = executeCommand(
        commandFactories.importMesh({
          name: parsed.name,
          artifactId,
          sourceName: parsed.name,
          triangleCount: parsed.triangleCount,
          vertices: parsed.vertices,
          indices: parsed.indices
        })
      );
      if (created) {
        setStatus(
          `Imported ${parsed.triangleCount} triangles from ${file.name}` +
            (archived
              ? '.'
              : ' (original file not archived: upload unavailable).')
        );
      }
      return;
    }

    if (file.size > MAX_EMBEDDED_STEP_BYTES) {
      setStatus(
        'STEP import is limited to 12 MB while source B-reps are stored in the offline document.'
      );
      return;
    }

    try {
      const stepText = await file.text();
      const metadata = parseStepMetadata(file.name, stepText);
      const productName = metadata.products[0]?.trim();
      let artifactId = `artifact_local_${crypto.randomUUID()}`;
      let archived = false;
      try {
        artifactId = await archiveArtifact({
          fileName: file.name,
          contentType,
          kind: 'step-import',
          body: file,
          metadata: { source: 'direct-upload' }
        });
        archived = true;
      } catch {
        // The STEP source remains embedded for deterministic offline rebuilds.
      }

      const imported = executeCommand(
        commandFactories.importStep({
          name: productName || file.name.replace(/\.(step|stp)$/i, ''),
          artifactId,
          sourceName: file.name,
          stepText
        })
      );
      if (imported) {
        setStatus(
          `Imported editable STEP solid from ${file.name}` +
            (archived
              ? '.'
              : ' (cloud archive unavailable; source saved locally).')
        );
      }
    } catch (error) {
      setStatus(errorMessage(error, 'STEP import failed.'));
    }
  }

  async function handleExport(format: 'step' | 'stl') {
    if (!doc || exportBodyIds.length === 0) {
      setStatus('Create a body before exporting.');
      return;
    }
    const stem = exportFileStem(doc.name);
    try {
      setStatus(`Exporting exact ${format.toUpperCase()}…`);
      const result = await geometry.exportModel(format, doc, exportBodyIds);
      const fileName = `${stem}.${format}`;
      const contentType = format === 'step' ? 'model/step' : 'model/stl';
      downloadText(fileName, result.text);
      let archived = false;
      try {
        await archiveArtifact({
          fileName,
          contentType,
          kind: format === 'step' ? 'step-export' : 'stl-export',
          body: new Blob([result.text], { type: contentType }),
          metadata: {
            bodyIds: exportBodyIds.join(','),
            documentVersion: doc.version,
            units: doc.units
          }
        });
        archived = true;
      } catch {
        // The local download has already completed successfully.
      }
      if (format === 'step') {
        setStatus(
          result.warnings.length > 0
            ? `Exported STEP with ${result.warnings.length} warning(s).`
            : `Exported ${exportBodyIds.length} body(ies) to ${stem}.step${archived ? ' and archived it' : ''}.`
        );
      } else {
        setStatus(
          `Exported ${exportBodyIds.length} body(ies) to ${stem}.stl${archived ? ' and archived it' : ''}.`
        );
      }
    } catch (error) {
      setStatus(errorMessage(error, `${format.toUpperCase()} export failed.`));
    }
  }

  function handleExportDiagnostics() {
    if (!doc) {
      setStatus('Open a project before exporting diagnostics.');
      return;
    }
    try {
      const bundle = createProjectDiagnosticBundle(doc, {
        brepkitVersion: KERNEL_BUILD.packageVersion,
        brepkitCommit: KERNEL_BUILD.sourceCommit
      });
      const fileName = `${exportFileStem(doc.name)}.openzcad-diagnostic.json`;
      downloadText(
        fileName,
        `${JSON.stringify(bundle, null, 2)}\n`,
        'application/json'
      );
      setStatus(`Exported sanitized diagnostics to ${fileName}.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Diagnostic export failed.'));
    }
  }

  function featureNodeIdForBody(bodyId: BodyId): string | null {
    if (!doc) {
      return null;
    }
    // Transform and direct-edit features keep BodyId stable. Walk history
    // backwards so the inspector follows the operation that currently defines
    // the selected body instead of jumping back to its original primitive.
    for (let index = features.length - 1; index >= 0; index -= 1) {
      const feature = features[index]!;
      if (feature.bodyId === bodyId) {
        return feature.id;
      }
      const data = feature.data;
      if (
        (data.featureKind === 'transform' ||
          data.featureKind === 'direct-edit') &&
        data.targetBodyId === bodyId
      ) {
        return feature.id;
      }
    }
    return null;
  }

  function handleSelectSketchProfile(sketchId: string) {
    const typedSketchId = sketchId as SketchId;
    if (tool === 'extrude' && !extrudePreview) {
      startExtrude(typedSketchId);
      return;
    }
    setTool(null);
    setExtrudePreview(null);
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(typedSketchId);
    const name =
      sketchOptions.find((candidate) => candidate.sketchId === typedSketchId)
        ?.name ?? 'Profile';
    setStatus(`${name}: closed profile selected · press E to extrude.`);
  }

  function startSketchOnFace(target: FaceTarget): boolean {
    const faceTopology = representations[
      target.bodyId as BodyId
    ]?.topology?.faces.find((face) => face.topologyId === target.topologyId);
    const attachment = faceSketchAttachment({
      bodyId: target.bodyId as BodyId,
      pickedHash: target.hash,
      face: faceTopology
    });
    if (!attachment.ok) {
      setStatus(attachment.reason);
      return false;
    }
    dispatchInteraction({
      type: 'enter-sketch',
      plane: attachment.planeRef
    });
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setTool(null);
    setStatus('Sketching on the selected face. Esc exits.');
    return true;
  }

  function handleSelectTopologyFromViewer(
    selection: TopologySelection | null,
    additive: boolean,
    detail?: PickDetail
  ) {
    if (!doc) {
      return;
    }
    // The pick detail (click point + normal) anchors selection-first drag
    // handles; stashed for the direct-manipulation flow.
    lastPickDetailRef.current = detail ?? null;
    setSelectedSketchProfileId(null);
    setExtrudePreview(null);
    if (!selection) {
      if (!additive) {
        clearSelection();
      }
      return;
    }
    if (selection.kind !== 'body' && !exactGeometryReady) {
      setStatus(
        'Exact geometry is still rebuilding. Topology actions are temporarily unavailable.'
      );
      return;
    }
    // Sketch entry: with the Sketch tool armed, a planar face click starts a
    // face-attached sketch instead of arming the offset handle.
    if (
      tool === 'sketch' &&
      selection.kind === 'face' &&
      selection.topologyId &&
      detail?.normal
    ) {
      const faceTopology = representations[
        selection.bodyId
      ]?.topology?.faces.find(
        (face) => face.topologyId === selection.topologyId
      );
      const geometry = faceTopology?.geometry;
      if (geometry?.surfaceType === 'plane' && selection.hash !== undefined) {
        const target: FaceTarget = {
          bodyId: selection.bodyId,
          topologyId: selection.topologyId,
          hash: selection.hash,
          ...(faceTopology?.reference
            ? { reference: faceTopology.reference }
            : {}),
          point: [detail.point.x, detail.point.y, detail.point.z],
          normal: [detail.normal.x, detail.normal.y, detail.normal.z],
          surfaceType: 'planar'
        };
        startSketchOnFace(target);
        return;
      }
      setStatus('Pick a planar face to sketch on, or choose a plane.');
      return;
    }
    // Selection-first direct manipulation: a face click arms its drag handle.
    if (
      appSettings.experiments.directManipulation &&
      selection.kind === 'face' &&
      selection.topologyId &&
      detail?.normal
    ) {
      const faceTopology = representations[
        selection.bodyId
      ]?.topology?.faces.find(
        (face) => face.topologyId === selection.topologyId
      );
      const geometry = faceTopology?.geometry;
      const surface = geometry?.surfaceType;
      const radialFrame =
        surface === 'cylinder' &&
        geometry?.axisStart &&
        geometry.axisEnd &&
        geometry.radius !== undefined
          ? cylinderRadialFrame(
              detail.point,
              detail.normal,
              geometry.axisStart,
              geometry.axisEnd
            )
          : null;
      const target: FaceTarget = {
        bodyId: selection.bodyId,
        topologyId: selection.topologyId,
        hash: selection.hash,
        ...(faceTopology?.reference
          ? { reference: faceTopology.reference }
          : {}),
        point: [detail.point.x, detail.point.y, detail.point.z],
        normal: [detail.normal.x, detail.normal.y, detail.normal.z],
        surfaceType:
          surface === 'plane'
            ? 'planar'
            : surface === 'cylinder'
              ? 'cylindrical'
              : 'other',
        ...(radialFrame && geometry?.radius !== undefined
          ? {
              radius: geometry.radius,
              axisStart: [
                geometry.axisStart!.x,
                geometry.axisStart!.y,
                geometry.axisStart!.z
              ] as [number, number, number],
              axisEnd: [
                geometry.axisEnd!.x,
                geometry.axisEnd!.y,
                geometry.axisEnd!.z
              ] as [number, number, number],
              axialLength: geometry.axialLength,
              radialDirection: [
                radialFrame.radialDirection.x,
                radialFrame.radialDirection.y,
                radialFrame.radialDirection.z
              ] as [number, number, number],
              concavity: radialFrame.concavity
            }
          : {})
      };
      dispatchInteraction({ type: 'select-face', target });
    } else if (interaction.mode !== 'idle' && interaction.mode !== 'sketch') {
      dispatchInteraction({ type: 'clear' });
    }
    if (selection.kind === 'edge') {
      const sameBody = selectedEdges.every(
        (edge) => edge.bodyId === selection.bodyId
      );
      if (appSettings.experiments.directManipulation) {
        // Selection-first: picking edges arms the fillet/chamfer handle.
        dispatchInteraction({
          type: 'select-edge',
          selection,
          additive: additive && sameBody
        });
      }
      const alreadySelected = selectedEdges.some(
        (edge) => edge.topologyId === selection.topologyId
      );
      const nextEdges =
        additive && sameBody
          ? alreadySelected
            ? selectedEdges.filter(
                (edge) => edge.topologyId !== selection.topologyId
              )
            : [...selectedEdges, selection]
          : [selection];
      setSelectedEdges(nextEdges);
      setSelectedBodyIds([selection.bodyId]);
      setSelectedTopology(
        nextEdges.at(-1) ?? { bodyId: selection.bodyId, kind: 'body' }
      );
      setSelectedFeatureNodeId(featureNodeIdForBody(selection.bodyId));
      if (!additive && tool !== 'fillet' && tool !== 'chamfer') {
        setTool(null);
      }
      setStatus(
        nextEdges.length > 0
          ? `${nextEdges.length} exact edge${nextEdges.length === 1 ? '' : 's'} selected.`
          : 'Edge selection cleared.'
      );
      return;
    }
    setSelectedEdges([]);
    const nextIds = additive
      ? selectedBodyIds.includes(selection.bodyId)
        ? selectedBodyIds.filter((id) => id !== selection.bodyId)
        : [...selectedBodyIds, selection.bodyId]
      : [selection.bodyId];
    setSelectedBodyIds(nextIds);
    if (!additive && tool !== 'fillet' && tool !== 'chamfer') {
      setTool(null);
    }
    // The edit panel and topology context follow a single-body selection;
    // multi-select keeps them clear so the pick order reads as boolean input.
    if (nextIds.length === 1) {
      setSelectedTopology(
        additive ? { bodyId: nextIds[0]!, kind: 'body' } : selection
      );
      setSelectedFeatureNodeId(featureNodeIdForBody(nextIds[0]!));
    } else {
      setSelectedTopology(null);
      setSelectedFeatureNodeId(null);
    }
  }

  function handleSelectAllEdges(body: BodyRepresentation) {
    const edges = (body.topology?.edges ?? [])
      .filter((edge) => edge.displayRole !== 'seam')
      .map((edge): TopologySelection => ({
        bodyId: body.bodyId,
        kind: 'edge',
        topologyId: edge.topologyId,
        hash: edge.hash
      }));
    setSelectedEdges(edges);
    setSelectedBodyIds([body.bodyId]);
    setSelectedTopology(edges.at(-1) ?? { bodyId: body.bodyId, kind: 'body' });
    setSelectedFeatureNodeId(featureNodeIdForBody(body.bodyId));
    setStatus(`Selected all ${edges.length} exact edges on ${body.name}.`);
  }

  /**
   * A whole smooth run of edges, from double-clicking one of them.
   *
   * Set in one update rather than replayed through
   * `handleSelectTopologyFromViewer`: that reads `selectedEdges` from its
   * closure, so N calls in a row would each append to the same stale list and
   * only the last would survive. The reducer does accumulate, so the fillet
   * handle is still armed edge by edge.
   */
  function handleSelectEdgeChainFromViewer(selections: TopologySelection[]) {
    const first = selections[0];
    if (!doc || !first) {
      return;
    }
    setSelectedSketchProfileId(null);
    setExtrudePreview(null);
    if (appSettings.experiments.directManipulation) {
      selections.forEach((selection, index) => {
        dispatchInteraction({
          type: 'select-edge',
          selection,
          additive: index > 0
        });
      });
    }
    setSelectedEdges(selections);
    setSelectedBodyIds([first.bodyId]);
    setSelectedTopology(selections.at(-1) ?? first);
    setSelectedFeatureNodeId(featureNodeIdForBody(first.bodyId));
    setStatus(
      `Selected a run of ${selections.length} connected edges. Fillet or chamfer applies to all of them.`
    );
  }

  /**
   * Bodies swept by an unmodified drag rectangle.
   *
   * Replaces the selection rather than adding to it: the rectangle is the
   * statement of what the user wants, and accumulating across sweeps would
   * make a second attempt at aiming impossible to distinguish from a
   * deliberate addition.
   */
  function handleBoxSelectFromViewer(bodyIds: string[]) {
    if (!doc) {
      return;
    }
    // A box selection replaces the active topology selection. Any direct-
    // manipulation target belongs to that old face or edge, so retaining it
    // would leave a handle capable of editing geometry that is no longer
    // selected.
    if (interaction.mode !== 'idle' && interaction.mode !== 'sketch') {
      dispatchInteraction({ type: 'clear' });
    }
    setSelectedSketchProfileId(null);
    setExtrudePreview(null);
    setSelectedEdges([]);
    setSelectedBodyIds(bodyIds as BodyId[]);
    setSelectedTopology(
      bodyIds.length === 1
        ? { bodyId: bodyIds[0] as BodyId, kind: 'body' }
        : null
    );
    setSelectedFeatureNodeId(
      bodyIds.length === 1 ? featureNodeIdForBody(bodyIds[0] as BodyId) : null
    );
    setStatus(
      bodyIds.length === 0
        ? 'Nothing in the box. Selection cleared.'
        : `${bodyIds.length} ${bodyIds.length === 1 ? 'body' : 'bodies'} selected.`
    );
  }

  function handleClearSelectedEdges() {
    setSelectedEdges([]);
    const bodyId = edgeModifierBody?.bodyId;
    setSelectedTopology(bodyId ? { bodyId, kind: 'body' } : null);
    setSelectedBodyIds(bodyId ? [bodyId] : []);
    setStatus('Edge selection cleared.');
  }

  /**
   * Armed face-offset handle for the viewport. Memoized so the drag rig is
   * built once per selection instead of on every App render — rebuilding it
   * mid-hover would reset its screen-constant scale and drop pointer picks.
   */
  // The keypad's lifetime mirrors the exact-entry phase. Escape, deselection,
  // and commits all close it through the reducer.
  useEffect(() => {
    const open =
      interaction.mode !== 'idle' &&
      interaction.mode !== 'sketch' &&
      interaction.phase === 'exact-entry';
    if (!open) {
      setKeypad(null);
    }
  }, [interaction]);

  // Leaving edges mode abandons any in-flight preview document.
  useEffect(() => {
    if (interaction.mode !== 'edges') {
      edgePreview.clear();
    }
  }, [interaction.mode]);

  /**
   * The sketch plane basis is memoized on the session's plane reference
   * alone: it must keep its identity across entity commits, or the viewport
   * would tear down and re-enter the mode (camera glide included) on every
   * committed entity. The parameter scope is only consulted at entry.
   */
  const sketchSessionPlane =
    interaction.mode === 'sketch' ? interaction.session.plane : null;
  const sketchSessionName =
    interaction.mode === 'sketch' && interaction.session.sketchId && doc
      ? (listNodesByKind(doc, 'sketch').find(
          (candidate) => candidate.sketchId === interaction.session.sketchId
        )?.name ?? 'Sketch')
      : 'New sketch';
  const parameterScopeRef = useRef(parameterScope);
  parameterScopeRef.current = parameterScope;
  const sketchBasis = useMemo(() => {
    if (!sketchSessionPlane || !doc) {
      return null;
    }
    try {
      return resolvedSketchPlaneBasis(
        doc,
        sketchSessionPlane,
        (value) => evalParamValue(value, parameterScopeRef.current.scope) ?? 0,
        sketchSessionName
      );
    } catch {
      return null;
    }
  }, [doc, sketchSessionName, sketchSessionPlane]);

  /** Active in-viewport sketch session for the viewport. */
  const sketchModeState = useMemo(() => {
    if (interaction.mode !== 'sketch' || !doc || !sketchBasis) {
      return null;
    }
    const session = interaction.session;
    const sketch = session.sketchId
      ? listNodesByKind(doc, 'sketch').find(
          (candidate) => candidate.sketchId === session.sketchId
        )
      : undefined;
    const objects =
      sketch?.objectIds.flatMap((objectId) => {
        const node = doc.nodes[objectId];
        return node?.kind === 'sketch-object'
          ? [{ id: objectId, data: node.data }]
          : [];
      }) ?? [];
    return {
      basis: sketchBasis,
      tool: session.tool,
      snapStep: appSettings.sketching.snapEnabled
        ? appSettings.sketching.linearSnap
        : null,
      drawing: session.drawing,
      objects,
      selectedObjectId: session.selectedObjectId,
      parameterScope: parameterScope.scope,
      diagnosticPoints: sketchDiagnosticPoints
    };
  }, [
    interaction,
    doc,
    sketchBasis,
    appSettings.sketching,
    parameterScope.scope,
    sketchDiagnosticPoints
  ]);

  const selectedSketchEntity = useMemo(() => {
    if (
      interaction.mode !== 'sketch' ||
      !interaction.session.selectedObjectId ||
      !doc
    ) {
      return null;
    }
    const node = doc.nodes[interaction.session.selectedObjectId as EntityId];
    return node?.kind === 'sketch-object' ? node : null;
  }, [interaction, doc]);

  /** A drawing gesture finished: commit the entity as a real command. */
  function handleSketchCommit(object: SketchObjectData) {
    if (interaction.mode !== 'sketch') {
      return;
    }
    setSketchDiagnosticPoints([]);
    const session = interaction.session;
    const committedObject: SketchObjectData = {
      ...object,
      ...(sketchConstruction ? { construction: true } : {})
    };
    /**
     * A placed text object says "Text" in a default face — useless until it is
     * edited, and the editor is where every one of its parameters lives. So
     * placing one selects it and hands over to Select, the way a drawing app
     * drops you into the caret.
     *
     * This has to run for the first object of a brand-new sketch as well as
     * for later ones. Start a sketch, press T, click — that is the common
     * path, and it is the one that goes through `addSketch`.
     */
    const selectIfText = (sketchId: SketchId) => {
      if (committedObject.objectKind !== 'text') {
        return;
      }
      const objectId = managerRef.current
        ? findSketch(managerRef.current.document, sketchId)?.objectIds.at(-1)
        : undefined;
      if (objectId) {
        dispatchInteraction({ type: 'sketch-tool', tool: 'select' });
        dispatchInteraction({ type: 'sketch-select-object', objectId });
      }
    };

    if (!session.sketchId) {
      const name = `Sketch ${String(sketchOptions.length + 1).padStart(2, '0')}`;
      if (
        !executeCommand(
          commandFactories.addSketch({
            name,
            planeRef: session.plane,
            objects: [committedObject]
          })
        )
      ) {
        return;
      }
      const sketchId = managerRef.current?.document.sketchOrder.at(-1);
      if (sketchId) {
        dispatchInteraction({ type: 'sketch-created', sketchId });
        selectIfText(sketchId);
      }
      setStatus(`${name} started.`);
      return;
    }
    if (
      executeCommand(
        commandFactories.addSketchObjects(
          {
            sketchId: session.sketchId as SketchId,
            objects: [committedObject]
          },
          `Add ${committedObject.objectKind}`
        )
      )
    ) {
      selectIfText(session.sketchId as SketchId);
    }
  }

  function showProfileDiagnostics() {
    if (
      interaction.mode !== 'sketch' ||
      !interaction.session.sketchId ||
      !doc
    ) {
      setStatus('Draw sketch geometry before running profile diagnostics.');
      return;
    }
    const sketch = findSketch(doc, interaction.session.sketchId as SketchId);
    if (!sketch) {
      setStatus('The active sketch is unavailable.');
      return;
    }
    const objects = sketch.objectIds.flatMap((objectId) => {
      const node = doc.nodes[objectId];
      return node?.kind === 'sketch-object'
        ? [{ id: objectId, data: node.data }]
        : [];
    });
    const analysis = computeSketchProfileAnalysis(objects, (value) =>
      resolveParamValue(value, parameterScope.scope, 'sketch dimension')
    );
    const actionable = analysis.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity !== 'info' || diagnostic.code === 'open-endpoint'
    );
    const problems =
      actionable.length > 0
        ? actionable
        : analysis.profiles.length === 0
          ? analysis.diagnostics
          : [];
    setSketchDiagnosticPoints(
      problems
        .flatMap((diagnostic) => diagnostic.points)
        .filter(
          (point, index, points) =>
            points.findIndex(
              (candidate) =>
                Math.hypot(candidate.x - point.x, candidate.y - point.y) <=
                analysis.tolerance
            ) === index
        )
    );
    if (problems.length === 0) {
      setStatus(
        `${analysis.profiles.length} valid closed profile${analysis.profiles.length === 1 ? '' : 's'} · no blocking profile diagnostics.`
      );
      return;
    }
    setStatus(
      `Profile diagnostics: ${problems[0]!.message} ${problems.length > 1 ? `(+${problems.length - 1} more)` : ''}`
    );
  }

  function handleUpdateSketchEntity(data: SketchObjectData) {
    if (
      interaction.mode !== 'sketch' ||
      !interaction.session.sketchId ||
      !interaction.session.selectedObjectId
    ) {
      return;
    }
    const selectedNode =
      doc?.nodes[interaction.session.selectedObjectId as EntityId];
    const nextData =
      selectedNode?.kind === 'sketch-object' && selectedNode.data.construction
        ? { ...data, construction: true }
        : data;
    setSketchDiagnosticPoints([]);
    if (
      executeCommand(
        commandFactories.updateSketchObject(
          {
            sketchId: interaction.session.sketchId as SketchId,
            objectId: interaction.session.selectedObjectId as EntityId,
            data: nextData
          },
          `Edit ${data.objectKind}`
        )
      )
    ) {
      setStatus(`Updated ${data.objectKind} geometry.`);
    }
  }

  function handleDeleteSketchEntity() {
    if (
      interaction.mode !== 'sketch' ||
      !interaction.session.sketchId ||
      !interaction.session.selectedObjectId
    ) {
      return;
    }
    setSketchDiagnosticPoints([]);
    if (
      executeCommand(
        commandFactories.deleteSketchObject(
          {
            sketchId: interaction.session.sketchId as SketchId,
            objectId: interaction.session.selectedObjectId as EntityId
          },
          'Delete sketch entity'
        )
      )
    ) {
      dispatchInteraction({ type: 'sketch-select-object', objectId: null });
      setStatus('Deleted sketch entity.');
    }
  }

  /**
   * Region-detected sketch rendering data: every sketch's curves plus its
   * detected closed regions, lifted by the shared plane resolution. The
   * sketch being edited in-session is skipped (its rig renders live).
   */
  const sketchViews = useMemo(() => {
    if (!doc) {
      return [];
    }
    const scope = parameterScope.scope;
    const resolve = (value: unknown): number =>
      evalParamValue(value as ParamValue, scope) ?? 0;
    return listNodesByKind(doc, 'sketch').flatMap((sketch) => {
      const active =
        interaction.mode === 'sketch' &&
        interaction.session.sketchId === sketch.sketchId;
      const selected =
        selectedSketch?.sketchId === sketch.sketchId ||
        selectedSketchProfileId === sketch.sketchId;
      const objects = sketch.objectIds.flatMap((objectId) => {
        const node = doc.nodes[objectId];
        return node?.kind === 'sketch-object'
          ? [{ id: objectId, data: node.data }]
          : [];
      });
      if (objects.length === 0) {
        return [];
      }
      let basis: PlaneBasis;
      try {
        basis = resolvedSketchPlaneBasis(
          doc,
          sketch.planeRef,
          resolve,
          sketch.name
        );
      } catch {
        return [];
      }
      const curves = active
        ? []
        : objects.flatMap((object) => {
            try {
              // A text object draws one run per glyph region plus one per
              // counter, so this is many runs from one object.
              return objectPolylines(object.data, resolve).map((polyline) => ({
                ...polyline,
                construction: object.data.construction === true
              }));
            } catch {
              return [];
            }
          });
      let regions: {
        profileId: string;
        regionFingerprint: number;
        samplePoint: { x: number; y: number };
        centroid: { x: number; y: number };
        boundingBox: {
          min: { x: number; y: number };
          max: { x: number; y: number };
        };
        sourceEntityIds: string[];
        area: number;
        outer: { x: number; y: number }[];
        holes: { x: number; y: number }[][];
      }[] = [];
      try {
        regions = computeSketchRegions(objects, (value) => resolve(value)).map(
          (region) => ({
            profileId: region.profileId,
            regionFingerprint: region.regionFingerprint,
            samplePoint: region.samplePoint,
            centroid: region.centroid,
            boundingBox: region.boundingBox,
            sourceEntityIds: region.sourceEntityIds,
            area: region.area,
            outer: region.outer.polyline,
            holes: region.holes.map((hole) => hole.polyline)
          })
        );
      } catch {
        // Unresolvable sketches simply render without pickable regions.
      }
      return [
        {
          sketchId: sketch.sketchId,
          basis,
          active,
          selected,
          curves,
          regions
        }
      ];
    });
  }, [
    doc,
    parameterScope,
    interaction,
    selectedSketch,
    selectedSketchProfileId,
    // Text outlines resolve from already-parsed faces, so a face arriving
    // after this memo last ran has to re-run it or the glyph stays a
    // diagnostic until something unrelated invalidates the memo.
    textFontsVersion
  ]);

  useEffect(() => {
    setSelectedProfiles((current) => {
      if (current.length === 0) {
        return current;
      }
      const remapped = current.flatMap((selected) => {
        const view = sketchViews.find(
          (candidate) => candidate.sketchId === selected.sketchId
        );
        const sourceMatches =
          view?.regions.filter(
            (candidate) =>
              candidate.sourceEntityIds.slice().sort().join('|') ===
              selected.sourceEntityIds.slice().sort().join('|')
          ) ?? [];
        const profile =
          view?.regions.find(
            (candidate) => candidate.profileId === selected.profileId
          ) ??
          view?.regions.find(
            (candidate) =>
              candidate.regionFingerprint === selected.regionFingerprint &&
              Math.abs(candidate.area - selected.area) <=
                Math.max(selected.area * 0.01, 1e-9)
          ) ??
          (sourceMatches.length === 1 ? sourceMatches[0] : undefined);
        return profile
          ? [
              {
                sketchId: selected.sketchId,
                profileId: profile.profileId,
                regionFingerprint: profile.regionFingerprint,
                samplePoint: profile.samplePoint,
                centroid: profile.centroid,
                boundingBox: profile.boundingBox,
                sourceEntityIds: profile.sourceEntityIds,
                area: profile.area
              }
            ]
          : [];
      });
      const unchanged =
        remapped.length === current.length &&
        remapped.every(
          (profile, index) =>
            profile.profileId === current[index]?.profileId &&
            profile.regionFingerprint === current[index]?.regionFingerprint
        );
      return unchanged ? current : remapped;
    });
  }, [sketchViews]);

  const extrudeSketchId =
    extrudePreview?.sketchId ??
    selectedProfiles[0]?.sketchId ??
    selectedSketchProfileId;
  const availableExtrudeProfiles = useMemo(() => {
    if (!extrudeSketchId) {
      return [];
    }
    const view = sketchViews.find(
      (candidate) => candidate.sketchId === extrudeSketchId
    );
    return (
      view?.regions.map((profile): RegionPickData => ({
        sketchId: extrudeSketchId,
        profileId: profile.profileId,
        regionFingerprint: profile.regionFingerprint,
        samplePoint: profile.samplePoint,
        centroid: profile.centroid,
        boundingBox: profile.boundingBox,
        sourceEntityIds: profile.sourceEntityIds,
        area: profile.area
      })) ?? []
    );
  }, [extrudeSketchId, sketchViews]);

  function selectAllValidExtrudeProfiles() {
    if (!extrudeSketchId || availableExtrudeProfiles.length === 0) {
      return;
    }
    setSelectedProfiles(availableExtrudeProfiles);
    setExtrudePreview((current) => ({
      sketchId: extrudeSketchId,
      distance: current?.distance ?? 24
    }));
    setStatus(
      `${availableExtrudeProfiles.length} valid profiles selected · exact preview updating.`
    );
  }

  function clearExtrudeProfiles() {
    profileExtrudePreview.clear();
    setPreviewDoc(null);
    setSelectedProfiles([]);
    setExtrudePreview(null);
    setStatus('Select one or more closed profiles.');
  }

  /** After a region extrude, offer a one-click edit of its source sketch. */
  const [revertPill, setRevertPill] = useState<{ sketchId: SketchId } | null>(
    null
  );
  useEffect(() => {
    if (interaction.mode !== 'idle') {
      setRevertPill(null);
    }
  }, [interaction.mode]);

  /** A detected bounded cell was clicked: update persistent profile selection. */
  function handleSelectRegion(
    region: RegionPickData,
    modifiers: { additive: boolean; toggle: boolean }
  ) {
    const nextProfiles = updateProfileSelection(
      selectedProfiles,
      region,
      modifiers
    );
    setSelectedProfiles(nextProfiles);
    setSelectedSketchProfileId(region.sketchId as SketchId);
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);

    if (interaction.mode === 'sketch') {
      setStatus(
        nextProfiles.length > 0
          ? `${nextProfiles.length} closed sketch profile${nextProfiles.length === 1 ? '' : 's'} selected.`
          : 'Sketch profile selection cleared.'
      );
      return;
    }
    if (tool === 'extrude') {
      setExtrudePreview(
        nextProfiles.length > 0
          ? {
              sketchId: region.sketchId,
              distance:
                extrudePreview?.sketchId === region.sketchId
                  ? extrudePreview.distance
                  : 24
            }
          : null
      );
      if (interaction.mode !== 'idle') {
        dispatchInteraction({ type: 'clear' });
      }
      setStatus(
        nextProfiles.length > 0
          ? `${nextProfiles.length} profile${nextProfiles.length === 1 ? '' : 's'} selected · exact preview updating.`
          : 'Select one or more closed profiles.'
      );
      return;
    }

    setExtrudePreview(null);
    dispatchInteraction({
      type: 'select-region',
      target: {
        sketchId: region.sketchId,
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.samplePoint,
        area: region.area,
        sourceEntityIds: region.sourceEntityIds
      }
    });
    setStatus(
      'Closed sketch profile selected · press E to Extrude, or drag the arrow.'
    );
  }

  function handleHoverRegion(region: RegionPickData | null) {
    if (region) {
      setStatus('Closed sketch profile — click to select.');
      return;
    }
    if (tool === 'extrude') {
      setStatus(
        selectedProfiles.length > 0
          ? `${selectedProfiles.length} profile${selectedProfiles.length === 1 ? '' : 's'} selected.`
          : 'Select one or more closed profiles.'
      );
    }
  }

  /** Armed region handle for the viewport. */
  const regionHandleTarget = useMemo(() => {
    if (interaction.mode !== 'region' || interaction.phase === 'validating') {
      return null;
    }
    return {
      sketchId: interaction.target.sketchId,
      regionFingerprint: interaction.target.regionFingerprint,
      samplePoint: interaction.target.samplePoint,
      area: interaction.target.area,
      initialValue: interaction.lastValue ?? 0
    };
  }, [interaction]);

  /** Region-extrude drag released (or exact entry): commit the feature. */
  function handleRegionExtrudeCommit(distance: number, exact?: ParamValue) {
    if (interaction.mode !== 'region') {
      return;
    }
    const target = interaction.target;
    const rounded = Math.round(distance * 1000) / 1000;
    if (rounded === 0) {
      return;
    }
    const profiles =
      selectedProfiles.length > 0
        ? selectedProfiles
        : [
            {
              sketchId: target.sketchId,
              profileId: `legacy_${target.regionFingerprint}`,
              regionFingerprint: target.regionFingerprint,
              samplePoint: target.samplePoint,
              centroid: target.samplePoint,
              boundingBox: {
                min: target.samplePoint,
                max: target.samplePoint
              },
              // The target's source entities, not [] — over a text region this
              // is what lets profileReferencesForSelection store the
              // entity-wide reference, so a drag-extruded label still rebuilds
              // after its string is edited.
              sourceEntityIds: target.sourceEntityIds,
              area: target.area
            }
          ];
    const command = commandFactories.extrudeSketch({
      name: 'Extrude',
      sketchId: target.sketchId as SketchId,
      distance: exact ?? rounded,
      profiles: profileReferencesForSelection(profiles, entityWideProfileSource)
    });
    const resultBodyId =
      command.payload.ids?.bodyId ?? (target.sketchId as unknown as BodyId);
    void executeValidatedDirectEdit(
      command,
      resultBodyId,
      `Extruded region by ${rounded} ${doc?.units ?? ''}.`,
      rounded,
      () => {
        setSelectedProfiles([]);
        setRevertPill({ sketchId: target.sketchId as SketchId });
      }
    );
  }

  /** Armed edge handle; memoized for the same rig-stability reason as faces. */
  const edgeHandleTarget = useMemo(() => {
    if (
      interaction.mode !== 'edges' ||
      interaction.edges.length === 0 ||
      interaction.phase === 'validating'
    ) {
      return null;
    }
    const last = interaction.edges.at(-1)!;
    return {
      bodyId: last.bodyId,
      topologyId: last.topologyId ?? '',
      op: interaction.op,
      edgeCount: interaction.edges.length,
      initialValue: interaction.lastValue ?? 0
    };
  }, [interaction]);

  const offsetHandleTarget = useMemo(() => {
    if (
      interaction.mode !== 'face' ||
      interaction.op !== 'offset-face' ||
      interaction.phase === 'validating'
    ) {
      return null;
    }
    const target = interaction.target;
    if (target.surfaceType !== 'planar') {
      return null;
    }
    return {
      bodyId: target.bodyId,
      topologyId: target.topologyId,
      point: {
        x: target.point[0],
        y: target.point[1],
        z: target.point[2]
      },
      normal: {
        x: target.normal[0],
        y: target.normal[1],
        z: target.normal[2]
      },
      initialValue: interaction.lastValue ?? 0
    };
  }, [interaction]);

  const cylinderRadiusHandleTarget = useMemo(() => {
    if (
      interaction.mode !== 'face' ||
      interaction.op !== 'resize-cylinder-radius' ||
      interaction.phase === 'validating'
    ) {
      return null;
    }
    const target = interaction.target;
    if (
      target.radius === undefined ||
      !target.axisStart ||
      !target.axisEnd ||
      !target.radialDirection
    ) {
      return null;
    }
    return {
      bodyId: target.bodyId,
      topologyId: target.topologyId,
      point: {
        x: target.point[0],
        y: target.point[1],
        z: target.point[2]
      },
      radialDirection: {
        x: target.radialDirection[0],
        y: target.radialDirection[1],
        z: target.radialDirection[2]
      },
      axisStart: {
        x: target.axisStart[0],
        y: target.axisStart[1],
        z: target.axisStart[2]
      },
      axisEnd: {
        x: target.axisEnd[0],
        y: target.axisEnd[1],
        z: target.axisEnd[2]
      },
      originalRadius: target.radius
    };
  }, [interaction]);
  const cylinderRadiusInspectorInitial =
    interaction.mode === 'face' &&
    interaction.op === 'resize-cylinder-radius' &&
    interaction.target.radius !== undefined
      ? interaction.target.radius
      : null;
  const cylinderRadiusInspectorEdit = useMemo(
    () =>
      cylinderRadiusInspectorInitial === null
        ? null
        : { initialRadius: cylinderRadiusInspectorInitial },
    [cylinderRadiusInspectorInitial]
  );

  function buildCylinderRadiusCommand(radius: ParamValue): AnyCommand | null {
    const current = interactionRef.current;
    const base = managerRef.current?.document;
    if (
      !base ||
      current.mode !== 'face' ||
      current.op !== 'resize-cylinder-radius'
    ) {
      return null;
    }
    const target = current.target;
    if (
      target.hash === undefined ||
      target.radius === undefined ||
      !target.axisStart ||
      !target.axisEnd ||
      !target.concavity
    ) {
      return null;
    }

    // Keep native primitive cylinders parametric whenever no earlier
    // topology-level edit depends on their old radius. Transform features keep
    // BodyId stable, so editing the primitive still works after move/rotate.
    const ordered = listFeaturesInOrder(base);
    const bodyNode = listNodesByKind(base, 'body').find(
      (body) => body.bodyId === (target.bodyId as BodyId)
    );
    const primitive = bodyNode
      ? ordered.find((feature) => feature.featureId === bodyNode.featureId)
      : undefined;
    const primitiveIndex = primitive ? ordered.indexOf(primitive) : -1;
    const hasDependentDirectEdit =
      primitiveIndex >= 0 &&
      ordered
        .slice(primitiveIndex + 1)
        .some(
          (feature) =>
            feature.data.featureKind === 'direct-edit' &&
            feature.data.targetBodyId === target.bodyId
        );
    if (
      primitive?.data.featureKind === 'primitive' &&
      primitive.data.primitiveKind === 'cylinder' &&
      typeof primitive.data.dimensions.radius === 'number' &&
      !hasDependentDirectEdit
    ) {
      return commandFactories.updateFeature(
        {
          featureId: primitive.featureId,
          data: {
            dimensions: {
              ...primitive.data.dimensions,
              radius
            }
          }
        },
        'Resize Cylinder Radius'
      );
    }

    return commandFactories.directEditBody({
      name: 'Resize Cylinder Radius',
      targetBodyId: target.bodyId as BodyId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: target.hash,
        ...(target.reference ? { faceReference: target.reference } : {}),
        sourceRadius: target.radius,
        sourceAxisStart: {
          x: target.axisStart[0],
          y: target.axisStart[1],
          z: target.axisStart[2]
        },
        sourceAxisEnd: {
          x: target.axisEnd[0],
          y: target.axisEnd[1],
          z: target.axisEnd[2]
        },
        concavity: target.concavity,
        radius
      }
    });
  }

  function handleCylinderRadiusPreview(radius: number) {
    const current = interactionRef.current;
    if (
      current.mode !== 'face' ||
      current.op !== 'resize-cylinder-radius' ||
      current.target.radius === undefined ||
      !isValidCylinderRadius(radius, current.target.radius)
    ) {
      return;
    }
    cylinderRadiusInspectorSetterRef.current?.(radius);
    cylinderRadiusPreview.request(radius);
  }

  function handleCylinderRadiusCancel() {
    cylinderRadiusPreview.clear();
    cylinderRadiusInspectorSetterRef.current?.(null);
  }

  function handleCylinderRadiusCommit(radius: number, exact?: ParamValue) {
    if (!requireExactGeometryReady()) {
      return;
    }
    const current = interactionRef.current;
    if (current.mode !== 'face' || current.op !== 'resize-cylinder-radius') {
      return;
    }
    const sourceRadius = current.target.radius;
    const command = buildCylinderRadiusCommand(exact ?? radius);
    if (
      sourceRadius === undefined ||
      !isValidCylinderRadius(radius, sourceRadius) ||
      !command
    ) {
      cylinderRadiusInspectorSetterRef.current?.(null);
      setStatus('Radius is too small to form valid geometry at this scale.');
      return;
    }
    void executeValidatedDirectEdit(
      command,
      current.target.bodyId as BodyId,
      `Adjusted cylinder radius to R ${formatNumber(radius)} ${doc?.units ?? ''}.`,
      radius
    );
  }

  /**
   * Live fillet/chamfer preview while the radius handle drags. One rebuild
   * in flight, newest value wins, and it gives up for the rest of the
   * gesture if the kernel gets slow.
   */
  const edgePreview = useRef(
    new LivePreview<ProjectDocument, ProjectDocument['derived']>({
      build: (size) => {
        const command = buildEdgeModifierCommand(size);
        const base = managerRef.current?.document;
        return command && base ? command.apply(base) : null;
      },
      derive: (document) => geometry.syncOnce(document),
      publish: (preview) =>
        setPreviewDoc(
          preview ? { ...preview.document, derived: preview.derived } : null
        )
    })
  ).current;

  function buildEdgeModifierCommand(size: ParamValue) {
    const currentInteraction = interactionRef.current;
    if (currentInteraction.mode !== 'edges') {
      return null;
    }
    const edges = currentInteraction.edges;
    const bodyId = edges[0]?.bodyId;
    const edgeHashes = edges
      .map((edge) => edge.hash)
      .filter((hash): hash is number => hash !== undefined);
    const edgeReferences = edges.flatMap((edge) =>
      edge.reference?.kind === 'edge' ? [edge.reference] : []
    );
    if (!bodyId || edgeHashes.length === 0) {
      return null;
    }
    const payload = {
      name:
        currentInteraction.op === 'fillet' ? 'Fillet edges' : 'Chamfer edges',
      targetBodyId: bodyId,
      edgeHashes,
      ...(edges.length === edgeHashes.length &&
      edgeReferences.length === edges.length
        ? { edgeReferences }
        : {}),
      size
    };
    return currentInteraction.op === 'fillet'
      ? commandFactories.filletEdges(payload)
      : commandFactories.chamferEdges(payload);
  }

  /** Edge-radius drag released (or exact entry): commit fillet/chamfer. */
  function handleEdgeCommit(size: number, exact?: ParamValue) {
    if (!requireExactGeometryReady()) {
      return;
    }
    if (interaction.mode !== 'edges') {
      return;
    }
    edgePreview.clear();
    const rounded = Math.round(size * 1000) / 1000;
    const command = buildEdgeModifierCommand(exact ?? rounded);
    if (!command || rounded <= 0) {
      return;
    }
    const op = interaction.op;
    const resultBodyId =
      command.payload.ids?.bodyId ?? command.payload.targetBodyId;
    void executeValidatedDirectEdit(
      command,
      resultBodyId,
      `${op === 'fillet' ? 'Filleted' : 'Chamfered'} ${command.payload.edgeHashes.length} edge${command.payload.edgeHashes.length === 1 ? '' : 's'} at ${rounded} ${doc?.units ?? ''}.`,
      rounded
    );
  }

  /** Edge chip tapped: exact entry for the blend radius/distance. */
  function handleOpenEdgeKeypad(currentSize: number) {
    if (interaction.mode !== 'edges') {
      return;
    }
    dispatchInteraction({ type: 'keypad-open' });
    setKeypad({
      kind: 'edge',
      label: interaction.op === 'fillet' ? 'Radius' : 'Distance',
      initial:
        currentSize > 0 ? String(Math.round(currentSize * 100) / 100) : '',
      unitKind: 'length'
    });
  }

  /** Chip tapped: open the anchored keypad prefilled with the drag value. */
  function handleOpenOffsetKeypad(currentOffset: number) {
    if (interaction.mode !== 'face' && interaction.mode !== 'region') {
      return;
    }
    dispatchInteraction({ type: 'keypad-open' });
    setKeypad({
      kind: 'offset',
      label: interaction.mode === 'region' ? 'Height' : 'Offset',
      initial:
        currentOffset !== 0
          ? String(Math.round(currentOffset * 100) / 100)
          : '',
      unitKind: 'length'
    });
  }

  function handleOpenCylinderRadiusKeypad(radius: number) {
    if (
      interaction.mode !== 'face' ||
      interaction.op !== 'resize-cylinder-radius'
    ) {
      return;
    }
    dispatchInteraction({ type: 'keypad-open' });
    setKeypad({
      kind: 'radius',
      label: 'Radius',
      initial: String(radius),
      unitKind: 'length',
      baseline: interaction.target.radius
    });
  }

  function handleSelectionAction(action: SelectionActionId) {
    if (
      (action === 'sketch-on-face' ||
        action === 'fillet' ||
        action === 'chamfer') &&
      !requireExactGeometryReady()
    ) {
      return;
    }
    if (action === 'sketch-on-face' && interaction.mode === 'face') {
      startSketchOnFace(interaction.target);
      return;
    }
    if (
      interaction.mode === 'edges' &&
      (action === 'fillet' || action === 'chamfer')
    ) {
      edgePreview.clear();
      dispatchInteraction({ type: 'set-edge-op', op: action });
    }
  }

  /**
   * Face-offset commit as a validated direct edit. `exact` preserves a typed
   * expression as the stored parametric value; plain drags store the number.
   */
  function handleOffsetCommit(offset: number, exact?: ParamValue) {
    // The arrow rig is shared: in region mode its drag is an extrude height.
    if (interaction.mode === 'region') {
      handleRegionExtrudeCommit(offset, exact);
      return;
    }
    if (interaction.mode !== 'face' || interaction.op !== 'offset-face') {
      return;
    }
    if (!requireExactGeometryReady()) {
      return;
    }
    const target = interaction.target;
    const bodyId = target.bodyId as BodyId;
    const faceTopology = representations[bodyId]?.topology?.faces.find(
      (face) => face.topologyId === target.topologyId
    );
    const geometry = faceTopology?.geometry;
    if (
      !faceTopology ||
      geometry?.surfaceType !== 'plane' ||
      target.hash === undefined
    ) {
      setStatus('Exact face measurements are unavailable for this offset.');
      dispatchInteraction({ type: 'clear' });
      return;
    }
    void executeValidatedDirectEdit(
      commandFactories.directEditBody({
        name: 'Offset face',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: target.hash,
          ...(faceTopology.reference
            ? { faceReference: faceTopology.reference }
            : {}),
          sourceSurfaceType: 'plane',
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          // The drag was measured along the picked (outward-facing) normal,
          // so it defines the offset's sign; the kernel only verifies that
          // the face's plane still matches this orientation up to sign.
          sourceNormal: {
            x: target.normal[0],
            y: target.normal[1],
            z: target.normal[2]
          },
          offset: exact ?? Math.round(offset * 1000) / 1000
        }
      }),
      bodyId,
      `Offset face by ${Math.round(offset * 100) / 100} ${doc?.units ?? ''}.`,
      offset
    );
  }

  function handleResizeThroughHole(
    selection: TopologySelection,
    geometry: FaceGeometry,
    diameter: ParamValue
  ) {
    if (!requireExactGeometryReady()) {
      return;
    }
    if (
      geometry.diameter === undefined ||
      !geometry.axisStart ||
      !geometry.axisEnd
    ) {
      setStatus('Exact through-hole dimensions are unavailable.');
      return;
    }
    const label = 'Resize through hole';
    void executeValidatedDirectEdit(
      commandFactories.directEditBody({
        name: label,
        targetBodyId: selection.bodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: selection.hash ?? -1,
          ...(selection.reference?.kind === 'face'
            ? { faceReference: selection.reference }
            : {}),
          sourceDiameter: geometry.diameter,
          sourceAxisStart: geometry.axisStart,
          sourceAxisEnd: geometry.axisEnd,
          diameter
        }
      }),
      selection.bodyId,
      `Updated through-hole diameter to ${String(diameter)} ${doc?.units ?? ''}.`,
      typeof diameter === 'number' ? diameter : 0
    );
  }

  function handleRemoveFaceFeature(
    selection: TopologySelection,
    geometry: FaceGeometry
  ) {
    if (!requireExactGeometryReady()) {
      return;
    }
    const label = 'Remove imported feature';
    void executeValidatedDirectEdit(
      commandFactories.directEditBody({
        name: label,
        targetBodyId: selection.bodyId,
        operation: {
          kind: 'remove-face-feature',
          faceHash: selection.hash ?? -1,
          ...(selection.reference?.kind === 'face'
            ? { faceReference: selection.reference }
            : {}),
          sourceSurfaceType: geometry.surfaceType,
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceDiameter: geometry.diameter,
          sourceAxisStart: geometry.axisStart,
          sourceAxisEnd: geometry.axisEnd
        }
      }),
      selection.bodyId,
      'Removed the selected imported feature.'
    );
  }

  function handleResizePrimitiveFace(commit: FaceResizeCommit) {
    if (!requireExactGeometryReady()) {
      return;
    }
    if (!doc) {
      return;
    }
    const nodeId = featureNodeIdForBody(commit.bodyId);
    const feature = nodeId ? doc.nodes[nodeId] : undefined;
    if (
      feature?.kind !== 'feature' ||
      feature.data.featureKind !== 'primitive' ||
      feature.data.primitiveKind !== 'box'
    ) {
      setStatus('Direct face resize is available for primitive boxes.');
      return;
    }
    const dimension =
      commit.axis === 'x' ? 'width' : commit.axis === 'y' ? 'height' : 'depth';
    const existing = feature.data.dimensions[dimension];
    if (typeof existing !== 'number') {
      setStatus(
        `${feature.name} ${dimension} is expression-driven; edit it in the inspector.`
      );
      return;
    }
    executeCommand(
      commandFactories.updateFeature(
        {
          featureId: feature.featureId,
          data: {
            dimensions: {
              ...feature.data.dimensions,
              [dimension]: Math.max(0.1, commit.value)
            }
          }
        },
        `Resize ${feature.name} ${dimension}`
      )
    );
  }

  function handleSelectFeatureFromTree(nodeId: string) {
    setTool(null);
    setExtrudePreview(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    const next = selectedFeatureNodeId === nodeId ? null : nodeId;
    setSelectedFeatureNodeId(next);
    const node = next && doc ? doc.nodes[next] : undefined;
    const bodyId = node?.kind === 'feature' ? node.bodyId : undefined;
    const sourceSketchId =
      node?.kind === 'feature' &&
      (node.data.featureKind === 'sketch' ||
        node.data.featureKind === 'extrude')
        ? node.data.sketchId
        : null;
    setSelectedSketchProfileId(sourceSketchId);
    if (node?.kind === 'feature' && node.data.featureKind === 'extrude') {
      const extrudeData = node.data;
      const references =
        extrudeData.profiles && extrudeData.profiles.length > 0
          ? extrudeData.profiles
          : extrudeData.profile
            ? [extrudeData.profile]
            : [];
      const view = sketchViews.find(
        (candidate) => candidate.sketchId === extrudeData.sketchId
      );
      // Mirrors resolveRegionProfiles: an `all: true` reference covers every
      // region its entities bound, so it can legitimately light up many
      // regions — or, after a text edit, a different number than last time.
      const perReference = references.map((reference) => {
        if (reference.all === true) {
          const referenced = new Set(reference.sourceEntityIds);
          return (
            view?.regions.filter(
              (candidate) =>
                candidate.sourceEntityIds.length > 0 &&
                candidate.sourceEntityIds.every((entityId) =>
                  referenced.has(entityId)
                )
            ) ?? []
          );
        }
        const sourceMatches = reference.sourceEntityIds
          ? (view?.regions.filter(
              (candidate) =>
                candidate.sourceEntityIds.slice().sort().join('|') ===
                reference.sourceEntityIds!.slice().sort().join('|')
            ) ?? [])
          : [];
        const region =
          view?.regions.find(
            (candidate) =>
              reference.profileId && candidate.profileId === reference.profileId
          ) ??
          view?.regions.find(
            (candidate) =>
              candidate.regionFingerprint === reference.regionFingerprint &&
              Math.abs(candidate.area - reference.sourceArea) <=
                Math.max(reference.sourceArea * 0.01, 1e-9)
          ) ??
          (sourceMatches.length === 1 ? sourceMatches[0] : undefined);
        return region ? [region] : [];
      });
      const highlighted = perReference.flat().map((region) => ({
        sketchId: extrudeData.sketchId,
        profileId: region.profileId,
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.samplePoint,
        centroid: region.centroid,
        boundingBox: region.boundingBox,
        sourceEntityIds: region.sourceEntityIds,
        area: region.area
      }));
      setSelectedProfiles(highlighted);
      if (perReference.some((regions) => regions.length === 0)) {
        setStatus(
          'Broken profile reference — edit the source sketch or reselect the extrusion profiles.'
        );
      }
    } else {
      setSelectedProfiles([]);
    }
    const representation = bodyId
      ? doc?.derived.bodyRepresentations[bodyId]
      : undefined;
    setSelectedBodyIds(
      bodyId && representation && !representation.consumed ? [bodyId] : []
    );
  }

  function handleSelectBodyFromTree(bodyId: BodyId, additive: boolean) {
    if (interaction.mode !== 'idle') {
      dispatchInteraction({ type: 'clear' });
    }
    setSelectedEdges([]);
    setSelectedTopology(null);
    const nextIds = additive
      ? selectedBodyIds.includes(bodyId)
        ? selectedBodyIds.filter((id) => id !== bodyId)
        : [...selectedBodyIds, bodyId]
      : [bodyId];
    setSelectedBodyIds(nextIds);
    if (nextIds.length === 1) {
      setSelectedTopology({ bodyId: nextIds[0]!, kind: 'body' });
      setSelectedFeatureNodeId(featureNodeIdForBody(nextIds[0]!));
    } else {
      setSelectedFeatureNodeId(null);
    }
    setStatus(
      nextIds.length > 0
        ? `${nextIds.length} ${nextIds.length === 1 ? 'body' : 'bodies'} selected.`
        : 'Body selection cleared.'
    );
  }

  function handleDeleteFeature(featureId: FeatureId, name: string) {
    if (
      executeCommand(
        commandFactories.deleteFeature({ featureId }, `Delete ${name}`)
      )
    ) {
      clearSelection();
    }
  }

  function handleToggleFeatureSuppression(feature: FeatureNode) {
    const resume = isFeatureSuppressed(feature);
    executeCommand(
      commandFactories.setNodeMetadata(
        {
          nodeId: feature.id,
          metadata: resume
            ? {
                [FEATURE_SUPPRESSED_METADATA_KEY]: null,
                [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: null
              }
            : { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
        },
        resume ? `Resume ${feature.name}` : `Suppress ${feature.name}`
      )
    );
  }

  function handleRollbackAfterFeature(featureId: FeatureId, name: string) {
    const markerIndex = features.findIndex(
      (feature) => feature.featureId === featureId
    );
    if (markerIndex < 0) {
      setStatus('The rollback feature is no longer in this document.');
      return;
    }
    const commands = features.flatMap((feature, index) => {
      const rollbackSuppressed = index > markerIndex;
      if (isFeatureRollbackSuppressed(feature) === rollbackSuppressed) {
        return [];
      }
      return [
        commandFactories.setNodeMetadata(
          {
            nodeId: feature.id,
            metadata: {
              [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: rollbackSuppressed
                ? true
                : null
            }
          },
          rollbackSuppressed
            ? `Roll back ${feature.name}`
            : `Resume ${feature.name}`
        )
      ];
    });
    if (commands.length === 0) {
      setStatus(`History is already rolled back after ${name}.`);
      return;
    }
    executeTransaction(`Roll back after ${name}`, commands);
  }

  function openContextMenu(
    x: number,
    y: number,
    entries: { item: ContextMenuState['items'][number]; run(): void }[],
    origin: 'viewport' | 'list' = 'list'
  ) {
    contextMenuActionsRef.current = Object.fromEntries(
      entries.map((entry) => [entry.item.id, entry.run])
    );
    setContextMenu({
      x,
      y,
      origin,
      items: entries.map((entry) => entry.item)
    });
  }

  function handleViewportContextMenu(
    x: number,
    y: number,
    selection: TopologySelection | null
  ) {
    if (!doc) {
      return;
    }
    if (!selection) {
      openContextMenu(
        x,
        y,
        [
          {
            item: {
              id: 'fit',
              label: 'Fit View',
              icon: <Maximize2 size={13} aria-hidden="true" />,
              shortcut: 'F'
            },
            run: () => setFitSignal((value) => value + 1)
          },
          {
            item: {
              id: 'grid',
              label: viewerSettings.showGrid ? 'Hide Grid' : 'Show Grid',
              icon: <Grid3x3 size={13} aria-hidden="true" />,
              shortcut: 'G'
            },
            run: () =>
              setViewerSettings((current) => ({
                ...current,
                showGrid: !current.showGrid
              }))
          },
          {
            item: {
              id: 'projection',
              label: `Projection: ${projection === 'perspective' ? 'Orthographic' : 'Perspective'}`,
              icon: <Camera size={13} aria-hidden="true" />,
              shortcut: 'P'
            },
            run: toggleProjection
          },
          {
            item: {
              id: 'showAll',
              label: 'Show All Bodies',
              icon: <Eye size={13} aria-hidden="true" />,
              disabled: hiddenBodyIds.size === 0
            },
            run: showAllBodies
          }
        ],
        'viewport'
      );
      return;
    }
    // Adopt the clicked geometry as the selection so actions target it.
    handleSelectTopologyFromViewer(selection, false);
    const nodeId = featureNodeIdForBody(selection.bodyId);
    const node = nodeId ? doc.nodes[nodeId] : undefined;
    const feature = node?.kind === 'feature' ? node : null;
    const edge = selection.kind === 'edge';
    openContextMenu(
      x,
      y,
      [
        ...(edge
          ? [
              {
                item: {
                  id: 'fillet',
                  label: 'Fillet Edge…',
                  icon: <Spline size={13} aria-hidden="true" />
                },
                run: () => launchTool('fillet')
              },
              {
                item: {
                  id: 'chamfer',
                  label: 'Chamfer Edge…',
                  icon: <TriangleRight size={13} aria-hidden="true" />
                },
                run: () => launchTool('chamfer')
              }
            ]
          : []),
        {
          item: {
            id: 'move',
            label: 'Move / Rotate…',
            icon: <Move3d size={13} aria-hidden="true" />,
            shortcut: 'M',
            section: edge
          },
          run: () => launchTool('transform')
        },
        {
          item: {
            id: 'union',
            label: 'Union…',
            icon: <Combine size={13} aria-hidden="true" />,
            shortcut: 'U',
            disabled: viewerBodies.length < 2
          },
          run: () => launchTool('union')
        },
        {
          item: {
            id: 'subtract',
            label: 'Subtract…',
            icon: <Scissors size={13} aria-hidden="true" />,
            shortcut: 'X',
            disabled: viewerBodies.length < 2
          },
          run: () => launchTool('subtract')
        },
        {
          item: {
            id: 'hide',
            label: 'Hide Body',
            icon: <Eye size={13} aria-hidden="true" />,
            section: true
          },
          run: () => toggleBodyVisibility(selection.bodyId)
        },
        {
          item: {
            id: 'fit',
            label: 'Fit View',
            icon: <Maximize2 size={13} aria-hidden="true" />,
            shortcut: 'F'
          },
          run: () => setFitSignal((value) => value + 1)
        },
        ...(feature
          ? [
              {
                item: {
                  id: 'delete',
                  label: `Delete ${feature.name}`,
                  icon: <Trash2 size={13} aria-hidden="true" />,
                  shortcut: 'Del',
                  danger: true,
                  section: true
                },
                run: () => handleDeleteFeature(feature.featureId, feature.name)
              }
            ]
          : [])
      ],
      'viewport'
    );
  }

  function handleFeatureContextMenu(
    event: React.MouseEvent,
    feature: FeatureNode
  ) {
    const bodyId = feature.bodyId ?? null;
    const body = bodyId ? representations[bodyId] : null;
    openContextMenu(event.clientX, event.clientY, [
      {
        item: { id: 'edit', label: 'Edit Properties' },
        run: () => handleSelectFeatureFromTree(feature.id)
      },
      ...(bodyId && body && !body.consumed
        ? [
            {
              item: {
                id: 'visibility',
                label: hiddenBodyIds.has(bodyId) ? 'Show Body' : 'Hide Body',
                icon: <Eye size={13} aria-hidden="true" />
              },
              run: () => toggleBodyVisibility(bodyId)
            }
          ]
        : []),
      {
        item: {
          id: 'delete',
          label: 'Delete',
          icon: <Trash2 size={13} aria-hidden="true" />,
          shortcut: 'Del',
          danger: true,
          section: true
        },
        run: () => handleDeleteFeature(feature.featureId, feature.name)
      }
    ]);
  }

  // `previewDoc` renders geometry from a proposal nobody has applied, and only
  // the assistant can retire it. Turning the assistant off in Settings unmounts
  // the panel, so the workspace has to drop the preview itself or the viewport
  // keeps showing a proposal nothing left on screen can clear. Merely hiding
  // the panel must not do this: the proposal is still live behind the sketch.
  useEffect(() => {
    if (!appSettings.assistant.enabled) {
      setPreviewDoc(null);
    }
  }, [appSettings.assistant.enabled]);

  /**
   * Whether the workspace still owns the keyboard. A surface layered over it
   * takes the keys with it: Settings sits on top of a live document, so
   * Backspace deleting a feature or Ctrl+Z rewinding history behind it would
   * edit a model the user cannot see. The palette and the shortcut overlay are
   * not listed — they are handled inside the map, which they need to reach.
   */
  const workspaceInputEnabled = !settingsOpen && !sharingOpen;

  // Workspace keyboard map (ignored while typing in a field). The ref must be
  // refreshed before paint: a keydown arriving between a commit and a passive
  // effect flush would otherwise run the previous render's closure — where a
  // freshly opened document was still null and every shortcut a no-op.
  const workspaceKeyDownRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    workspaceKeyDownRef.current = function onKeyDown(event: KeyboardEvent) {
      if (!workspaceInputEnabled) {
        return;
      }
      const meta = event.ctrlKey || event.metaKey;

      if (meta && event.key === ',') {
        event.preventDefault();
        openSettings();
        return;
      }

      if (!doc) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA');
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setShortcutsOpen(false);
        setPaletteOpen((open) => !open);
        return;
      }
      if (paletteOpen || shortcutsOpen) {
        // Modals own their keys; Escape is handled here as a safety net.
        if (event.key === 'Escape') {
          setPaletteOpen(false);
          setShortcutsOpen(false);
        }
        return;
      }

      if (tool === 'sketch') {
        // The focused sketch workspace owns drawing shortcuts and Escape.
        return;
      }
      if (tool === 'extrude') {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelPanel();
        } else if (event.key === 'Enter' && !typing) {
          event.preventDefault();
          void confirmExtrude();
        }
        return;
      }
      if (movePreview) {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelPanel();
          return;
        }
        if (event.key === 'Enter' && !typing) {
          event.preventDefault();
          confirmMove();
          return;
        }
      }

      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }
      if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        handleRedo();
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
        return;
      }

      // Escape is exempt from the typing guard. Every other shortcut must
      // yield to a focused field, but a panel that autofocuses an input is
      // exactly the situation someone presses Escape to get out of, and
      // swallowing it there breaks the one key the workspace promises is
      // always a way back.
      if ((typing && event.key !== 'Escape') || meta || event.altKey) {
        return;
      }

      if (interaction.mode === 'sketch' && event.key !== 'Escape') {
        if (
          (event.key === 'Delete' || event.key === 'Backspace') &&
          interaction.session.selectedObjectId
        ) {
          event.preventDefault();
          handleDeleteSketchEntity();
          return;
        }
        const sketchTool =
          event.key.toLowerCase() === 'v'
            ? ('select' as const)
            : event.key.toLowerCase() === 'l'
              ? ('line' as const)
              : event.key.toLowerCase() === 'a'
                ? ('arc' as const)
                : event.key.toLowerCase() === 'c'
                  ? ('circle' as const)
                  : event.key.toLowerCase() === 'r'
                    ? ('rectangle' as const)
                    : event.key.toLowerCase() === 't'
                      ? ('text' as const)
                      : null;
        if (sketchTool) {
          event.preventDefault();
          dispatchInteraction({ type: 'sketch-tool', tool: sketchTool });
        }
        return;
      }
      switch (event.key) {
        case 'Escape':
          if (interaction.mode !== 'idle') {
            event.preventDefault();
            if (
              interaction.mode === 'sketch' &&
              !interaction.session.drawing &&
              interaction.session.tool === 'select' &&
              !interaction.session.selectedObjectId &&
              selectedProfiles.length > 0
            ) {
              setSelectedProfiles([]);
              setStatus('Sketch profile selection cleared.');
              return;
            }
            const cancelledPointer =
              interaction.mode !== 'sketch' &&
              cancelDirectManipulationRef.current?.() === true;
            if (cancelledPointer && interaction.mode === 'edges') {
              edgePreview.clear();
            }
            if (!cancelledPointer) {
              dispatchInteraction({ type: 'escape' });
            }
          } else if (tool || selectedFeatureNodeId) {
            cancelPanel();
          } else {
            clearSelection();
          }
          return;
        case 'Delete':
        case 'Backspace':
          if (selectedFeature) {
            event.preventDefault();
            handleDeleteFeature(
              selectedFeature.featureId,
              selectedFeature.name
            );
          }
          return;
        case '?':
          event.preventDefault();
          setShortcutsOpen(true);
          return;
        case '/':
          event.preventDefault();
          setPaletteOpen(true);
          return;
        case '1':
          requestView('front');
          return;
        case '2':
          requestView('top');
          return;
        case '3':
          requestView('right');
          return;
        case '4':
          requestView('iso');
          return;
      }

      const key = event.key.toLowerCase();
      if (key === 'f') {
        setFitSignal((value) => value + 1);
        return;
      }
      if (key === 'g') {
        setViewerSettings((current) => ({
          ...current,
          showGrid: !current.showGrid
        }));
        return;
      }
      if (key === 'w') {
        cycleDisplayMode();
        return;
      }
      if (key === 'p') {
        toggleProjection();
        return;
      }
      if (key === 'q') {
        // Advances from the filter in force, not from the manual one: with a
        // tool choosing the filter those differ, and stepping from the manual
        // slot would make the first press appear to do nothing.
        const at = SELECTION_FILTERS.indexOf(selectionFilter);
        setManualSelectionFilter(
          SELECTION_FILTERS[(at + 1) % SELECTION_FILTERS.length] ?? 'any'
        );
        return;
      }
      const shortcutTool = SHORTCUT_TO_TOOL[key];
      if (shortcutTool) {
        // Without this the same keystroke would type into the form field
        // that the tool dialog autofocuses.
        event.preventDefault();
        launchTool(shortcutTool);
      }
    };
  });

  // One registration for the app's lifetime. The map closes over roughly forty
  // pieces of state, so re-binding it on every render was the only way to keep
  // it current; routing through the ref above does that without touching the
  // listener, and without an omitted dependency going stale.
  useLayoutEffect(() => {
    const listener = (event: KeyboardEvent) =>
      workspaceKeyDownRef.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  /**
   * Projects carrying an unresolved divergence marker. Recomputed from the
   * shelf rather than tracked in state: the markers outlive the session that
   * wrote them, so reading them is the only way the shelf can be right after a
   * reload.
   *
   * Must stay above the restore-screen return below — every hook does. Putting
   * it after meant the hook count changed as the app left that screen, which
   * React treats as a broken component rather than a late memo.
   */
  const conflictedProjectIds = useMemo(
    () =>
      new Set(
        projects
          .map((project) => project.projectId)
          .filter((projectId) => readUnresolvedConflict(projectId) !== null)
      ),
    [projects]
  );

  if (startupState === 'restoring') {
    return <StartupScreen />;
  }

  // Settings layers over whatever is behind it instead of replacing it.
  // Returning it in place of the shell unmounted the whole workspace, and with
  // it the assistant's conversation and any request still streaming.
  const settingsOverlay = settingsOpen ? (
    <div
      ref={settingsDialogRef}
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabIndex={-1}
    >
      <SettingsPage
        settings={appSettings}
        accountState={accountSettings}
        authConfig={authConfig}
        authConfigStatus={authConfigStatus}
        health={deploymentHealth}
        session={session}
        busy={settingsBusy}
        message={settingsMessage}
        onChange={handleAppSettingsChange}
        onSaveCredential={(token) => void handleSaveAssistantCredential(token)}
        onDeleteCredential={() => void handleDeleteAssistantCredential()}
        onTestAssistant={() => void handleTestAssistantConnection()}
        onRequestLoginCode={handleRequestLoginCode}
        onVerifyLoginCode={handleVerifyLoginCode}
        onRefreshAuthConfig={handleRefreshAuthConfig}
        onLogout={handleLogout}
        onReset={handleResetAppSettings}
        onApplyViewportDefaults={applyViewportDefaults}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  ) : null;

  if (!doc) {
    return (
      <>
        <StartScreen
          projects={projects}
          status={status}
          busy={busy}
          demos={DEMO_DEFINITIONS}
          defaultUnits={appSettings.general.defaultUnits}
          onCreate={(name, units) => void handleCreateProject(name, units)}
          onOpen={(projectId) => void handleOpenProject(projectId)}
          onOpenDemo={(definition) => void handleOpenDemo(definition)}
          onOpenSettings={openSettings}
          onDuplicate={(project) => void handleDuplicateProject(project)}
          cloudProjectIds={cloudProjectIds}
          conflictedProjectIds={conflictedProjectIds}
          signedIn={Boolean(session)}
          onSaveToAccount={(project) => void handleSaveToAccount(project)}
          onSaveAllToAccount={(candidates) =>
            void handleSaveAllToAccount(candidates)
          }
          syncRun={syncRun}
          onRetrySync={(projectId) => void handleRetrySync(projectId)}
          onDismissSyncRun={() => setSyncRun(null)}
          onMoveToShelf={(project, shelf) =>
            void handleMoveProjectToShelf(project, shelf)
          }
          onTogglePin={(project) => void handleTogglePin(project)}
          onReorder={(projectIds) => void handleReorderProjects(projectIds)}
          onDeleteForever={(project) =>
            void handleDeleteProjectForever(project)
          }
          onEmptyTrash={(trashed) => void handleEmptyTrash(trashed)}
          loadThumbnailBodies={loadThumbnailBodies}
        />
        {settingsOverlay}
      </>
    );
  }

  const geometryPhaseLabel: Record<typeof geometry.state.phase, string> = {
    starting: 'Starting geometry worker',
    'loading-brepkit': 'Loading exact BrepKit kernel',
    rebuilding: 'Rebuilding exact geometry',
    ready: 'Exact geometry ready',
    failed: 'Exact geometry failed'
  };
  const staleProjectionLabel =
    Object.keys(representations).length > 0
      ? 'showing the last valid projection as stale'
      : 'no exact projection is available yet';
  const visibleStatus = exactGeometryReady
    ? status
    : `${
        geometry.state.phase === 'ready'
          ? 'Waiting for exact geometry for this revision'
          : geometry.state.phase === 'failed' && geometry.state.error
            ? `Exact geometry failed: ${geometry.state.error}`
            : geometryPhaseLabel[geometry.state.phase]
      } · ${staleProjectionLabel}`;
  const tone: 'ready' | 'warning' | 'running' =
    geometry.state.phase === 'failed'
      ? 'warning'
      : !exactGeometryReady
        ? 'running'
        : /fail|error|invalid|unable|denied/i.test(status)
          ? 'warning'
          : 'ready';

  // An operation in flight outranks the tool hint: it knows which rung of
  // the Escape ladder you are on, which is the one thing a generic
  // "Esc cancels" can never tell you.
  const hint =
    commandPromptText(
      interaction,
      tool !== null || selectedFeatureNodeId !== null
    ) ??
    (tool === 'sketch'
      ? 'Drag to draw · R rectangle · C circle · P polygon · Enter finishes'
      : tool === 'extrude'
        ? extrudePreview
          ? 'Drag the arrow across the plane · Enter creates · Esc cancels'
          : 'Click a shaded closed profile · Esc cancels'
        : tool === 'fillet' || tool === 'chamfer'
          ? selectedEdges.length > 0
            ? `${selectedEdges.length} edge${selectedEdges.length === 1 ? '' : 's'} selected · Shift+Click adjusts · Enter creates`
            : 'Click edges with Shift or choose Select all edges · Esc cancels'
          : tool
            ? 'Enter creates · Esc cancels'
            : selectedBodyIds.length >= 2
              ? `${selectedBodyIds.length} bodies picked — U union · X subtract · I intersect`
              : selectedTopology?.kind === 'edge'
                ? 'Edge selected — Fillet or Chamfer from the toolbar'
                : selectedFeature
                  ? 'Edit in the panel · Del deletes · Esc closes'
                  : viewerBodies.length > 0
                    ? 'Click a body, face, or edge · Shift+Click adds to selection'
                    : 'Ctrl+K commands · ? shortcuts');

  const paletteCommands: PaletteCommand[] = [
    ...TOOL_GROUPS.flatMap((group) =>
      group.tools.map((toolId): PaletteCommand => {
        const meta = TOOL_META[toolId];
        return {
          id: `tool-${toolId}`,
          label: meta.label,
          group: group.label,
          shortcut: meta.shortcut,
          icon: meta.icon,
          disabledReason: toolDisabledReason(toolId, availability),
          run: () => launchTool(toolId)
        };
      })
    ),
    {
      id: 'view-front',
      label: 'Front view',
      group: 'View',
      shortcut: '1',
      icon: <Monitor size={16} aria-hidden="true" />,
      run: () => requestView('front')
    },
    {
      id: 'view-top',
      label: 'Top view',
      group: 'View',
      shortcut: '2',
      icon: <Monitor size={16} aria-hidden="true" />,
      run: () => requestView('top')
    },
    {
      id: 'view-right',
      label: 'Right view',
      group: 'View',
      shortcut: '3',
      icon: <Monitor size={16} aria-hidden="true" />,
      run: () => requestView('right')
    },
    {
      id: 'view-iso',
      label: 'Isometric view',
      group: 'View',
      shortcut: '4',
      icon: <Monitor size={16} aria-hidden="true" />,
      run: () => requestView('iso')
    },
    {
      id: 'view-fit',
      label: 'Fit view',
      group: 'View',
      shortcut: 'F',
      icon: <Maximize2 size={16} aria-hidden="true" />,
      run: () => setFitSignal((value) => value + 1)
    },
    {
      id: 'view-grid',
      label: viewerSettings.showGrid ? 'Hide grid' : 'Show grid',
      group: 'View',
      shortcut: 'G',
      icon: <Grid3x3 size={16} aria-hidden="true" />,
      run: () =>
        setViewerSettings((current) => ({
          ...current,
          showGrid: !current.showGrid
        }))
    },
    {
      id: 'view-display',
      label: `Display mode: next (now ${DISPLAY_MODE_LABELS[viewerSettings.displayMode]})`,
      group: 'View',
      shortcut: 'W',
      icon: <Monitor size={16} aria-hidden="true" />,
      run: cycleDisplayMode
    },
    {
      id: 'view-projection',
      label: `Projection: switch to ${projection === 'perspective' ? 'orthographic' : 'perspective'}`,
      group: 'View',
      shortcut: 'P',
      icon: <Camera size={16} aria-hidden="true" />,
      run: toggleProjection
    },
    {
      id: 'view-show-all',
      label: 'Show all bodies',
      group: 'View',
      icon: <Eye size={16} aria-hidden="true" />,
      disabledReason: hiddenBodyIds.size === 0 ? 'No bodies are hidden' : null,
      run: showAllBodies
    },
    {
      id: 'file-save',
      label: 'Save revision',
      group: 'File',
      shortcut: 'Ctrl+S',
      icon: <Save size={16} aria-hidden="true" />,
      run: () => void handleSave()
    },
    {
      id: 'file-export-step',
      label: 'Export STEP',
      group: 'File',
      icon: <Download size={16} aria-hidden="true" />,
      disabledReason: exportBodyIds.length === 0 ? 'Create a body first' : null,
      run: () => void handleExport('step')
    },
    {
      id: 'file-export-stl',
      label: 'Export STL',
      group: 'File',
      icon: <Download size={16} aria-hidden="true" />,
      disabledReason: exportBodyIds.length === 0 ? 'Create a body first' : null,
      run: () => void handleExport('stl')
    },
    {
      id: 'file-import',
      label: 'Import STEP / STL…',
      group: 'File',
      icon: <Upload size={16} aria-hidden="true" />,
      run: () => importInputRef.current?.click()
    },
    {
      id: 'file-home',
      label: 'Back to projects',
      group: 'File',
      icon: <FolderOpen size={16} aria-hidden="true" />,
      run: () => void handleGoHome()
    },
    {
      id: 'app-settings',
      label: 'Open settings',
      group: 'General',
      shortcut: 'Ctrl+,',
      icon: <SettingsIcon size={16} aria-hidden="true" />,
      run: openSettings
    }
  ];

  const directMode =
    tool === 'sketch' ||
    tool === 'extrude' ||
    (tool === 'transform' && movePreview !== null);
  // The setting is the only gate on the assistant's presence: rendering nothing
  // also means no /api/assistant/status probe, since that fetch lives in the
  // rail's mount effect. A direct-manipulation mode only hides it — the panel
  // owns the conversation and the in-flight request, so unmounting to enter a
  // sketch would throw both away.
  const assistantAvailable = appSettings.assistant.enabled;
  const assistantHidden = directMode;
  const baseToolCard = toolCardFor(interaction);
  const editingSketchName =
    interaction.mode === 'sketch' && interaction.session.sketchId
      ? (sketchOptions.find(
          (sketch) => sketch.sketchId === interaction.session.sketchId
        )?.name ?? 'Sketch')
      : 'New Sketch';
  const contextualToolCard =
    baseToolCard && interaction.mode === 'sketch'
      ? { ...baseToolCard, title: `Editing Sketch: ${editingSketchName}` }
      : baseToolCard;
  const inspectorActive =
    !directMode && (tool !== null || selectedFeature !== null);
  const modelingOperation: ModelingOperationKind | null =
    tool === 'mirror' || tool === 'shell' || tool === 'solid-offset'
      ? tool
      : null;
  const modelingTargetBody = modelingTargetBodyId
    ? representations[modelingTargetBodyId]
    : undefined;
  const modelingFaces = modelingFaceOptions(modelingTargetBody?.topology);
  const modelingUnsupportedReason = modelingOperation
    ? (editDisabledReason ??
      modelingOperationDisabledReason(modelingOperation, {
        exactState: exactGeometryReady
          ? 'ready'
          : geometry.state.phase === 'failed'
            ? 'failed'
            : 'pending',
        exactFailureReason: geometry.state.error,
        hasTargetBody: Boolean(modelingTargetBody),
        openingFaceCount: modelingFaces.length
      }))
    : null;

  function commandForModelingSubmission(
    submission: ModelingOperationSubmission
  ): AnyCommand {
    switch (submission.operation) {
      case 'mirror':
        return commandFactories.mirrorBody(submission.input);
      case 'shell':
        return commandFactories.shellBody(submission.input);
      case 'solid-offset':
        return commandFactories.offsetSolidBody(submission.input);
    }
  }

  async function preflightModelingSubmission(
    submission: ModelingOperationSubmission
  ): Promise<{ status: 'ready' } | { status: 'refused'; reason: string }> {
    const manager = managerRef.current;
    if (!manager || !ensureCanEdit('preflight this modeling operation')) {
      return {
        status: 'refused',
        reason: editDisabledReason ?? 'Project editing is unavailable.'
      };
    }
    const current = manager.document;
    const signature = JSON.stringify(submission);
    try {
      const command = commandForModelingSubmission(submission);
      command.validate(current);
      const candidate = command.apply(current);
      const derived = await geometry.syncOnce(candidate);
      const existingWarnings = new Set(current.derived.warnings);
      const warning = derived.warnings.find(
        (candidateWarning) => !existingWarnings.has(candidateWarning)
      );
      if (warning) {
        throw new Error(warning);
      }
      const ids = (
        command.payload as unknown as {
          ids?: { bodyId?: BodyId };
        }
      ).ids;
      const resultBodyId = ids?.bodyId;
      if (!resultBodyId || !derived.bodyRepresentations[resultBodyId]) {
        throw new Error(
          `${submission.input.name} did not produce its expected exact result body.`
        );
      }
      if (
        managerRef.current !== manager ||
        manager.document.projectId !== current.projectId ||
        manager.document.version !== current.version
      ) {
        throw new Error(
          'The document changed during exact preflight. Recheck the operation.'
        );
      }
      modelingPreflightRef.current = {
        signature,
        command,
        resultBodyId,
        featureName: submission.input.name,
        baseVersion: current.version
      };
      return { status: 'ready' };
    } catch (error) {
      modelingPreflightRef.current = null;
      return {
        status: 'refused',
        reason: errorMessage(error, 'Exact preflight failed.')
      };
    }
  }

  function submitModelingOperation(submission: ModelingOperationSubmission) {
    const approved = modelingPreflightRef.current;
    const manager = managerRef.current;
    if (
      !approved ||
      !manager ||
      approved.signature !== JSON.stringify(submission) ||
      approved.baseVersion !== manager.document.version
    ) {
      setStatus(
        'The modeling preflight is stale. Check the exact result again.'
      );
      return;
    }
    void executeValidatedFeature(approved.command, {
      featureName: approved.featureName,
      resultBodyId: approved.resultBodyId,
      successMessage: approved.command.label,
      onSuccess: finishFeatureCreation
    });
  }

  return (
    <AppShell
      workspaceRef={workspaceRef}
      sidebarWidth={sidebarWidth}
      assistantWidth={assistantWidth}
      sidebarResizer={
        <PanelResizer
          label="Resize the sidebar"
          edge="left"
          width={sidebarWidth}
          min={SIDEBAR_WIDTH_LIMITS.min}
          max={maxSidebarWidth(windowWidth)}
          onPreview={(width) => previewPanelWidth('--sidebar-w', width)}
          onCommit={(width) => commitPanelWidth('sidebar', width)}
          onReset={() =>
            commitPanelWidth('sidebar', SIDEBAR_WIDTH_LIMITS.default)
          }
        />
      }
      assistantResizer={
        <PanelResizer
          label="Resize the assistant"
          edge="right"
          width={assistantWidth}
          min={ASSISTANT_WIDTH_LIMITS.min}
          max={maxAssistantWidth(windowWidth)}
          onPreview={(width) => previewPanelWidth('--assistant-w', width)}
          onCommit={(width) => commitPanelWidth('assistant', width)}
          onReset={() =>
            commitPanelWidth('assistant', ASSISTANT_WIDTH_LIMITS.default)
          }
        />
      }
      topBar={
        <TopBar
          projectName={doc.name}
          units={doc.units}
          canUndo={managerRef.current?.canUndo ?? false}
          canRedo={managerRef.current?.canRedo ?? false}
          canExport={exportBodyIds.length > 0}
          exportScope={
            selectedBody &&
            !selectedBody.consumed &&
            selectedBody.exportableStep
              ? selectedBody.name
              : null
          }
          saveState={saveState}
          artifacts={artifacts}
          session={session}
          collaborationStatus={collaboration.status}
          collaboratorCount={collaboration.members.length}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onSave={() => void handleSave()}
          onImportFile={(file) => void handleImportFile(file)}
          onExport={(format) => void handleExport(format)}
          onExportDiagnostics={handleExportDiagnostics}
          onRenameProject={(name) =>
            executeCommand(
              commandFactories.renameNode({ nodeId: doc.rootNodeId, name })
            )
          }
          onGoHome={() => void handleGoHome()}
          onOpenSharing={() => setSharingOpen(true)}
          onOpenSettings={openSettings}
        />
      }
      toolBar={
        tool === 'sketch' ? (
          <div className="direct-mode-strip">
            <PenLine size={16} aria-hidden="true" />
            <strong>Editing Sketch: {editingSketchName}</strong>
            <span>
              Closed profiles fill as they form · Finish Sketch preserves edits
            </span>
          </div>
        ) : tool === 'extrude' ? (
          <div className="direct-mode-strip extrude-mode">
            <Layers3 size={16} aria-hidden="true" />
            <strong>Direct extrude</strong>
            <span>
              Drag across the plane for a positive or negative distance
            </span>
          </div>
        ) : (
          <ToolBar
            activeTool={tool}
            availability={availability}
            onLaunchTool={launchTool}
            onOpenSearch={() => setPaletteOpen(true)}
            open={panelState.toolPaletteOpen}
            onOpenChange={(toolPaletteOpen) =>
              setPanelState((current) => ({ ...current, toolPaletteOpen }))
            }
          />
        )
      }
      sidebar={
        <Sidebar
          parameters={parameters}
          parameterValues={parameterScope.scope}
          features={features}
          representations={representations}
          selectedFeatureNodeId={selectedFeatureNodeId}
          hiddenBodyIds={hiddenBodyIds}
          warnings={warnings}
          checkpoints={doc?.checkpoints ?? []}
          onSelectFeature={handleSelectFeatureFromTree}
          onSelectBody={handleSelectBodyFromTree}
          selectedBodyIds={selectedBodyIds}
          onToggleBodyVisibility={toggleBodyVisibility}
          onFeatureContextMenu={handleFeatureContextMenu}
          onToggleFeatureSuppression={handleToggleFeatureSuppression}
          onRollbackAfterFeature={handleRollbackAfterFeature}
          onSetParameter={(name, expression) =>
            executeCommand(commandFactories.setParameter({ name, expression }))
          }
          onDeleteParameter={(name) =>
            executeCommand(commandFactories.deleteParameter({ name }))
          }
          onDeleteFeature={handleDeleteFeature}
          panelState={panelState}
          onToggleSection={(id: SidebarSectionId) =>
            setPanelState((current) => toggleSidebarSection(current, id))
          }
        />
      }
      viewer={
        <ErrorBoundary
          label="3D viewer"
          resetKey={`${doc.projectId}:${doc.version}`}
        >
          <ViewerShell
            projectId={doc.projectId}
            bodies={viewerBodies}
            sketches={
              // Region-based rendering (sketchViews) supersedes the legacy
              // single-profile overlays under direct manipulation.
              appSettings.experiments.directManipulation ? [] : sketchOverlays
            }
            selectedBodyIds={selectedBodyIds}
            selectedTopology={renderedSelectedTopology}
            selectedEdges={selectedEdges}
            settings={viewerSettings}
            fitSignal={fitSignal}
            viewRequest={viewRequest}
            rotateRequest={rotateRequest}
            units={doc.units}
            editableBodyIds={directEditableBodyIds}
            extrudePreview={extrudePreview}
            movePreview={movePreview}
            moveCommitHold={moveCommitHold}
            hideViewerToolbar={false}
            selectionChip={selectionChip}
            onClearSelection={clearSelection}
            initialView={initialView}
            onViewChange={handleViewportChange}
            onMovePreviewChange={(translation, rotationDeg, snap) => {
              setMoveSnap(snap);
              setMovePreview((current) =>
                current ? { ...current, translation, rotationDeg } : current
              );
            }}
            offsetHandle={offsetHandleTarget}
            onOffsetCommit={handleOffsetCommit}
            onOpenOffsetKeypad={handleOpenOffsetKeypad}
            keypadAnchorRef={keypadAnchorRef}
            offsetSetterRef={offsetSetterRef}
            cylinderRadiusHandle={cylinderRadiusHandleTarget}
            onCylinderRadiusPreview={handleCylinderRadiusPreview}
            onCylinderRadiusCommit={handleCylinderRadiusCommit}
            onCylinderRadiusCancel={handleCylinderRadiusCancel}
            onOpenCylinderRadiusKeypad={handleOpenCylinderRadiusKeypad}
            cancelDirectManipulationRef={cancelDirectManipulationRef}
            edgeHandle={edgeHandleTarget}
            onEdgeRadiusPreview={(size) => edgePreview.request(size)}
            onEdgeCommit={handleEdgeCommit}
            onOpenEdgeKeypad={handleOpenEdgeKeypad}
            onDirectManipulationChange={(dragging) =>
              dispatchInteraction({
                type: dragging ? 'drag-engage' : 'drag-release'
              })
            }
            sketchMode={sketchModeState}
            onSketchCommit={handleSketchCommit}
            onSketchDrawingChange={(drawing) =>
              dispatchInteraction({ type: 'sketch-drawing', drawing })
            }
            onSketchSelectObject={(objectId) =>
              dispatchInteraction({ type: 'sketch-select-object', objectId })
            }
            sketchViews={sketchViews}
            selectedProfileIds={selectedProfiles.map(
              (profile) => profile.profileId
            )}
            profileSelectionMode={tool === 'extrude'}
            onSelectRegion={handleSelectRegion}
            onHoverRegion={handleHoverRegion}
            regionHandle={regionHandleTarget}
            modeOverlay={
              contextualToolCard ? (
                <>
                  <ToolCard
                    model={contextualToolCard}
                    onAction={handleSelectionAction}
                    onClose={() => {
                      if (
                        interaction.mode !== 'idle' &&
                        interaction.mode !== 'sketch' &&
                        interaction.phase === 'dragging'
                      ) {
                        cancelDirectManipulationRef.current?.();
                        if (interaction.mode === 'edges') {
                          edgePreview.clear();
                        }
                      }
                      dispatchInteraction({
                        type:
                          interaction.mode === 'sketch'
                            ? 'exit-sketch'
                            : 'clear'
                      });
                    }}
                  />
                  {interaction.mode === 'sketch' && (
                    <SketchToolRail
                      tool={interaction.session.tool}
                      construction={sketchConstruction}
                      onTool={(sketchTool) =>
                        dispatchInteraction({
                          type: 'sketch-tool',
                          tool: sketchTool
                        })
                      }
                      onConstruction={setSketchConstruction}
                      onDiagnostics={showProfileDiagnostics}
                      onExtrude={() => {
                        if (interaction.session.sketchId) {
                          startExtrude(
                            interaction.session.sketchId as SketchId
                          );
                        } else {
                          setStatus('Close a profile before starting Extrude.');
                        }
                      }}
                      onExit={() => {
                        dispatchInteraction({ type: 'exit-sketch' });
                        setStatus(
                          `${editingSketchName} finished · sketch edits preserved.`
                        );
                      }}
                    />
                  )}
                  {interaction.mode === 'sketch' && selectedSketchEntity && (
                    <SketchEntityEditor
                      key={selectedSketchEntity.id}
                      data={selectedSketchEntity.data}
                      scope={parameterScope.scope}
                      onApply={handleUpdateSketchEntity}
                      onDelete={handleDeleteSketchEntity}
                      onClose={() =>
                        dispatchInteraction({
                          type: 'sketch-select-object',
                          objectId: null
                        })
                      }
                    />
                  )}
                  {keypad && (
                    <NumericKeypad
                      request={keypad}
                      units={doc.units}
                      scope={parameterScope.scope}
                      anchorRef={keypadAnchorRef}
                      onPreview={(value) => {
                        offsetSetterRef.current?.(value);
                        if (keypad.kind === 'radius') {
                          handleCylinderRadiusPreview(value);
                        } else if (keypad.kind === 'edge') {
                          edgePreview.request(value);
                        }
                      }}
                      onCommit={(value, raw) => {
                        setKeypad(null);
                        dispatchInteraction({ type: 'keypad-close' });
                        // Expressions stay parametric in the stored feature.
                        const isExpression = !Number.isFinite(Number(raw));
                        if (keypad.kind === 'edge') {
                          handleEdgeCommit(
                            value,
                            isExpression ? raw : undefined
                          );
                        } else if (keypad.kind === 'radius') {
                          handleCylinderRadiusCommit(
                            value,
                            isExpression ? raw : undefined
                          );
                        } else {
                          handleOffsetCommit(
                            value,
                            isExpression ? raw : undefined
                          );
                        }
                      }}
                      onCancel={() => {
                        offsetSetterRef.current?.(keypad.baseline ?? 0);
                        if (keypad.kind === 'radius') {
                          handleCylinderRadiusCancel();
                        } else if (keypad.kind === 'edge') {
                          edgePreview.clear();
                        }
                        dispatchInteraction({ type: 'keypad-close' });
                        setKeypad(null);
                      }}
                    />
                  )}
                </>
              ) : revertPill ? (
                <button
                  type="button"
                  className="revert-sketch-pill"
                  onClick={() => {
                    const sketch = doc
                      ? listNodesByKind(doc, 'sketch').find(
                          (candidate) =>
                            candidate.sketchId === revertPill.sketchId
                        )
                      : undefined;
                    setRevertPill(null);
                    if (sketch) {
                      dispatchInteraction({
                        type: 'enter-sketch',
                        plane: sketch.planeRef,
                        sketchId: sketch.sketchId
                      });
                    }
                  }}
                >
                  <PenLine size={14} aria-hidden="true" />
                  Edit Sketch
                </button>
              ) : movePreview ? (
                <MoveOverlay
                  bodyName={
                    movePreview.target === 'sketch'
                      ? (findSketch(doc, movePreview.bodyId as SketchId)
                          ?.name ?? 'Selected sketch')
                      : (representations[movePreview.bodyId as BodyId]?.name ??
                        'Selected body')
                  }
                  hideRotation={movePreview.target === 'sketch'}
                  values={{
                    translation: movePreview.translation,
                    rotationDeg: movePreview.rotationDeg
                  }}
                  units={doc.units}
                  snap={moveSnap}
                  onChange={(values) =>
                    setMovePreview((current) =>
                      current
                        ? {
                            ...current,
                            translation: values.translation,
                            rotationDeg: values.rotationDeg
                          }
                        : current
                    )
                  }
                  onConfirm={confirmMove}
                  onCancel={cancelPanel}
                />
              ) : tool === 'sketch' ? (
                <div className="sketch-plane-prompt" role="status">
                  <span>
                    <strong>Pick a sketch plane</strong>
                    <small>
                      Click a planar face on the model, or start on a principal
                      plane.
                    </small>
                  </span>
                  <span className="sketch-plane-buttons">
                    {(['XY', 'XZ', 'YZ'] as const).map((plane) => (
                      <button
                        key={plane}
                        type="button"
                        onClick={() => {
                          dispatchInteraction({
                            type: 'enter-sketch',
                            plane: { type: 'canonical', plane, offset: 0 }
                          });
                          setTool(null);
                          setStatus(
                            `Sketching on the ${plane} plane. Esc exits.`
                          );
                        }}
                      >
                        {PLANE_LABELS[plane]}
                      </button>
                    ))}
                  </span>
                </div>
              ) : extrudePreview && selectedSketchProfileName ? (
                <ExtrudeOverlay
                  profileName={`${selectedSketchProfileName} · ${selectedProfiles.length} bounded cell${selectedProfiles.length === 1 ? '' : 's'}`}
                  profileCount={selectedProfiles.length}
                  availableProfileCount={availableExtrudeProfiles.length}
                  distance={extrudePreview.distance}
                  units={doc.units}
                  onDistanceChange={(distance) =>
                    Number.isFinite(distance) &&
                    setExtrudePreview((current) =>
                      current ? { ...current, distance } : current
                    )
                  }
                  onClearProfiles={clearExtrudeProfiles}
                  onSelectAllProfiles={selectAllValidExtrudeProfiles}
                  onBackToSketch={
                    extrudeSketchReturnRef.current ? cancelPanel : undefined
                  }
                  onConfirm={() => void confirmExtrude()}
                  onCancel={cancelPanel}
                />
              ) : tool === 'extrude' ? (
                <div className="profile-pick-prompt" role="status">
                  <Layers3 size={18} aria-hidden="true" />
                  <span>
                    <strong>Select a closed profile</strong>
                    <small>
                      Click a shaded sketch region to begin extruding.
                    </small>
                  </span>
                </div>
              ) : selectedProfiles.length > 0 && selectedSketchProfileName ? (
                <ProfileQuickAction
                  profileName={selectedSketchProfileName}
                  profileCount={selectedProfiles.length}
                  onExtrude={() =>
                    startExtrude(selectedProfiles[0]!.sketchId as SketchId)
                  }
                  onDismiss={() => {
                    setSelectedProfiles([]);
                    setSelectedSketchProfileId(null);
                  }}
                />
              ) : null
            }
            projection={projection}
            orientationRef={orientationRef}
            onSelectTopology={handleSelectTopologyFromViewer}
            onSelectEdgeChain={handleSelectEdgeChainFromViewer}
            selectionFilter={selectionFilter}
            onBoxSelect={handleBoxSelectFromViewer}
            onSelectSketchProfile={handleSelectSketchProfile}
            onResizePrimitiveFace={handleResizePrimitiveFace}
            onExtrudeDistanceChange={(distance) =>
              setExtrudePreview((current) =>
                current ? { ...current, distance } : current
              )
            }
            onContextMenu={handleViewportContextMenu}
            onToggleGrid={() =>
              setViewerSettings((current) => ({
                ...current,
                showGrid: !current.showGrid
              }))
            }
            onFit={() => setFitSignal((value) => value + 1)}
            onView={requestView}
            onRotateView={requestRotate}
            onCycleDisplayMode={cycleDisplayMode}
            onToggleProjection={toggleProjection}
          />
        </ErrorBoundary>
      }
      inspector={
        inspectorActive ? (
          <ErrorBoundary
            label="Inspector"
            resetKey={`${doc.projectId}:${doc.version}`}
          >
            {modelingOperation ? (
              <ModelingOperationsForm
                key={modelingOperation}
                operation={modelingOperation}
                scope={parameterScope.scope}
                bodies={bodyOptions}
                faceOptions={modelingFaces}
                initialTarget={modelingTargetBodyId ?? undefined}
                unsupportedReason={modelingUnsupportedReason ?? undefined}
                onPreflight={preflightModelingSubmission}
                onSubmit={submitModelingOperation}
                onCancel={cancelPanel}
                onTargetBodyChange={(bodyId) => {
                  modelingPreflightRef.current = null;
                  setModelingTargetBodyId(bodyId);
                  setSelectedBodyIds([bodyId]);
                  setSelectedTopology(null);
                }}
                onOpeningFaceSelectionChange={(hashes) => {
                  const selectedHash = hashes.at(-1);
                  const face = modelingTargetBody?.topology?.faces.find(
                    (candidate) => candidate.hash === selectedHash
                  );
                  setSelectedTopology(
                    selectedHash !== undefined && face && modelingTargetBodyId
                      ? {
                          kind: 'face',
                          bodyId: modelingTargetBodyId,
                          topologyId: face.topologyId,
                          hash: face.hash,
                          reference: face.reference
                        }
                      : null
                  );
                }}
                onRequestOpeningFaceSelection={() => {
                  setManualSelectionFilter('face');
                  setStatus(
                    'Shell: pick an exact opening face, then select it in the face list.'
                  );
                }}
              />
            ) : (
              <Inspector
                tool={tool}
                selectedFeature={selectedFeature}
                selectedSketch={selectedSketch}
                selectedSketchObject={selectedSketchObject}
                selectedBody={selectedBody}
                selectedTopology={renderedSelectedTopology}
                selectedEdges={selectedEdges}
                edgeModifierBody={edgeModifierBody}
                scope={parameterScope.scope}
                sketches={sketchOptions}
                bodies={bodyOptions}
                units={doc.units}
                selectedBodyIds={selectedBodyIds}
                preferredSketchId={selectedSketch?.sketchId ?? null}
                cylinderRadiusEdit={cylinderRadiusInspectorEdit}
                cylinderRadiusSetterRef={cylinderRadiusInspectorSetterRef}
                onLaunchTool={launchTool}
                onCancel={cancelPanel}
                onSelectAllEdges={handleSelectAllEdges}
                onClearSelectedEdges={handleClearSelectedEdges}
                onCreatePrimitive={(kind, name, dimensions) =>
                  createFeature(
                    commandFactories.addPrimitive({
                      name,
                      primitiveKind: kind,
                      dimensions
                    })
                  )
                }
                onCreateSketch={(value) =>
                  createFeature(commandFactories.addSketch(value))
                }
                onCreateExtrude={(value) =>
                  createFeature(commandFactories.extrudeSketch(value))
                }
                onCreateRevolve={(value) =>
                  createFeature(commandFactories.revolveSketch(value))
                }
                onCreateBoolean={(value) => {
                  const command = commandFactories.booleanBodies(value);
                  if (value.operation !== 'union') {
                    createFeature(command);
                    return;
                  }
                  const resultBodyId = command.payload.ids?.bodyId;
                  if (!resultBodyId) {
                    setStatus('Union could not reserve a result body.');
                    return;
                  }
                  void executeValidatedFeature(command, {
                    featureName: value.name,
                    resultBodyId,
                    successMessage: command.label,
                    onSuccess: finishFeatureCreation
                  });
                }}
                onCreateTransform={(value) =>
                  createFeature(
                    commandFactories.transformBody({
                      name: value.name,
                      targetBodyId: value.targetBodyId,
                      translation: value.translation,
                      rotationDeg: value.rotationDeg
                    })
                  )
                }
                onCreateEdgeModifier={(kind, value) =>
                  createFeature(
                    kind === 'fillet'
                      ? commandFactories.filletEdges(value)
                      : commandFactories.chamferEdges(value)
                  )
                }
                onCreatePattern={(value) =>
                  createFeature(commandFactories.patternBody(value))
                }
                onApplyPrimitive={(feature, name, dimensions) =>
                  executeCommand(
                    commandFactories.updateFeature(
                      {
                        featureId: feature.featureId,
                        name,
                        data: { dimensions }
                      },
                      `Edit ${name}`
                    )
                  )
                }
                onApplySketch={(feature, value) => {
                  if (
                    feature.data.featureKind !== 'sketch' ||
                    !selectedSketch
                  ) {
                    return;
                  }
                  const commands: AnyCommand[] = [
                    commandFactories.updateSketch(
                      {
                        sketchId: feature.data.sketchId,
                        plane: value.plane,
                        offset: value.offset,
                        object: value.object
                      },
                      `Edit ${value.name}`
                    )
                  ];
                  if (value.name !== feature.name) {
                    commands.push(
                      commandFactories.renameNode({
                        nodeId: feature.id,
                        name: value.name
                      }),
                      commandFactories.renameNode({
                        nodeId: selectedSketch.id,
                        name: value.name
                      })
                    );
                  }
                  executeTransaction(`Edit ${value.name}`, commands);
                }}
                onConvertSketchToFixedPlane={(sketch) => {
                  const planeRef = fixedPlaneRefForLegacyAttachment(
                    sketch.planeRef
                  );
                  if (!planeRef) {
                    setStatus(
                      `${sketch.name} is not a legacy face attachment.`
                    );
                    return;
                  }
                  executeCommand(
                    commandFactories.updateSketch(
                      { sketchId: sketch.sketchId, planeRef },
                      `Convert ${sketch.name} to fixed plane`
                    )
                  );
                }}
                onApplyTextSketch={(feature, value) => {
                  if (
                    feature.data.featureKind !== 'sketch' ||
                    !selectedSketch ||
                    !selectedSketch.objectIds[0]
                  ) {
                    return;
                  }
                  // updateSketchObject, not updateSketch: the object changes
                  // and the plane must not — a face-attached text sketch has
                  // to stay on its face.
                  const commands: AnyCommand[] = [
                    commandFactories.updateSketchObject(
                      {
                        sketchId: feature.data.sketchId,
                        objectId: selectedSketch.objectIds[0],
                        data: value.data
                      },
                      `Edit ${value.name}`
                    )
                  ];
                  if (value.name !== feature.name) {
                    commands.push(
                      commandFactories.renameNode({
                        nodeId: feature.id,
                        name: value.name
                      }),
                      commandFactories.renameNode({
                        nodeId: selectedSketch.id,
                        name: value.name
                      })
                    );
                  }
                  executeTransaction(`Edit ${value.name}`, commands);
                }}
                onEditSketchInViewport={(feature) => {
                  if (feature.data.featureKind !== 'sketch' || !doc) {
                    return;
                  }
                  const sketch = findSketch(doc, feature.data.sketchId);
                  if (sketch) {
                    dispatchInteraction({
                      type: 'enter-sketch',
                      plane: sketch.planeRef,
                      sketchId: sketch.sketchId
                    });
                  }
                }}
                onApplyExtrude={(feature, value) => {
                  if (
                    feature.data.featureKind !== 'extrude' ||
                    value.sketchId !== feature.data.sketchId
                  ) {
                    setStatus(
                      'Changing an Extrude source sketch requires profile reselection.'
                    );
                    return;
                  }
                  executeCommand(
                    commandFactories.updateFeature(
                      {
                        featureId: feature.featureId,
                        name: value.name,
                        data: {
                          ...feature.data,
                          distance: value.distance
                        }
                      },
                      `Edit ${value.name}`
                    )
                  );
                }}
                onApplyRevolve={(feature, value) =>
                  executeCommand(
                    commandFactories.updateFeature(
                      {
                        featureId: feature.featureId,
                        name: value.name,
                        data: {
                          featureKind: 'revolve',
                          sketchId: value.sketchId,
                          axis: value.axis,
                          angleDeg: value.angleDeg
                        }
                      },
                      `Edit ${value.name}`
                    )
                  )
                }
                onApplyBoolean={(feature, value) => {
                  const command = commandFactories.updateFeature(
                    {
                      featureId: feature.featureId,
                      name: value.name,
                      data: {
                        featureKind: 'boolean',
                        operation: value.operation,
                        targetBodyIds: value.targetBodyIds
                      }
                    },
                    `Edit ${value.name}`
                  );
                  if (value.operation !== 'union') {
                    executeCommand(command);
                    return;
                  }
                  if (!feature.bodyId) {
                    setStatus('Boolean feature has no result body.');
                    return;
                  }
                  void executeValidatedFeature(command, {
                    featureName: value.name,
                    resultBodyId: feature.bodyId,
                    successMessage: command.label
                  });
                }}
                onApplyTransform={(feature, value) =>
                  executeCommand(
                    commandFactories.updateFeature(
                      {
                        featureId: feature.featureId,
                        name: value.name,
                        data: {
                          featureKind: 'transform',
                          targetBodyId: value.targetBodyId,
                          transform: {
                            translation: value.translation,
                            rotationDeg: value.rotationDeg
                          }
                        }
                      },
                      `Edit ${value.name}`
                    )
                  )
                }
                onApplyEdgeModifier={(feature, kind, value) =>
                  executeCommand(
                    commandFactories.updateFeature(
                      {
                        featureId: feature.featureId,
                        name: value.name,
                        data:
                          kind === 'fillet'
                            ? {
                                featureKind: 'fillet',
                                targetBodyId: value.targetBodyId,
                                edgeHashes: value.edgeHashes,
                                radius: value.size
                              }
                            : {
                                featureKind: 'chamfer',
                                targetBodyId: value.targetBodyId,
                                edgeHashes: value.edgeHashes,
                                distance: value.size
                              }
                      },
                      `Edit ${value.name}`
                    )
                  )
                }
                onApplyPattern={(feature, value) =>
                  executeCommand(
                    commandFactories.updateFeature(
                      {
                        featureId: feature.featureId,
                        name: value.name,
                        data: {
                          featureKind: 'pattern',
                          targetBodyId: value.targetBodyId,
                          patternKind: value.patternKind,
                          count: value.count,
                          axis: value.axis,
                          spacing: value.spacing,
                          angleDeg: value.angleDeg
                        }
                      },
                      `Edit ${value.name}`
                    )
                  )
                }
                onResizeThroughHole={handleResizeThroughHole}
                onRemoveFaceFeature={handleRemoveFaceFeature}
                onDeleteFeature={(feature) =>
                  handleDeleteFeature(feature.featureId, feature.name)
                }
              />
            )}
          </ErrorBoundary>
        ) : null
      }
      assistant={
        assistantAvailable ? (
          <ErrorBoundary label="Assistant">
            <AssistantPanel
              document={doc}
              selection={assistantSelection}
              onApply={handleApplyPatch}
              onPreview={handlePreviewPatch}
              collapsed={assistantCollapsed}
              onCollapsedChange={setAssistantCollapsed}
              hidden={assistantHidden}
            />
          </ErrorBoundary>
        ) : null
      }
      assistantHidden={assistantHidden}
      assistantCollapsed={assistantCollapsed}
      statusBar={
        <StatusBar
          status={visibleStatus}
          tone={tone}
          hint={hint}
          projectName={doc.name}
          bodyCount={viewerBodies.length}
          featureCount={features.length}
          warningCount={warnings.length}
          documentVersion={doc.version}
          units={doc.units}
          selectionFilter={selectionFilter}
          selectionFilterIsAutomatic={manualSelectionFilter === null}
          onSelectionFilter={setManualSelectionFilter}
        />
      }
      overlays={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".stl,.step,.stp"
            style={{ display: 'none' }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) {
                void handleImportFile(file);
              }
            }}
          />
          {paletteOpen && (
            <CommandPalette
              commands={paletteCommands}
              onClose={() => setPaletteOpen(false)}
            />
          )}
          {shortcutsOpen && (
            <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
          )}
          {contextMenu &&
            (contextMenu.origin === 'viewport' ? (
              <MarkingMenu
                x={contextMenu.x}
                y={contextMenu.y}
                items={contextMenu.items}
                onSelect={(itemId) => contextMenuActionsRef.current[itemId]?.()}
                onClose={() => setContextMenu(null)}
              />
            ) : (
              <ContextMenu
                menu={contextMenu}
                onSelect={(itemId) => contextMenuActionsRef.current[itemId]?.()}
                onClose={() => setContextMenu(null)}
              />
            ))}
          {sharingOpen && doc && (
            <ProjectSharingDialog
              projectId={doc.projectId}
              role={collaboration.role}
              collaborationStatus={collaboration.status}
              lease={collaboration.lease}
              liveMembers={collaboration.members}
              conflict={collaboration.conflict}
              conflictHandlers={conflictHandlers}
              onClose={() => setSharingOpen(false)}
            />
          )}
          {accountConflict && (
            <ProjectConflictDialog
              conflict={accountConflict}
              busy={busy}
              onResolve={(resolution) =>
                void resolveAccountConflict(resolution)
              }
              onClose={() => setAccountConflict(null)}
            />
          )}
          {settingsOverlay}
        </>
      }
    />
  );
}
