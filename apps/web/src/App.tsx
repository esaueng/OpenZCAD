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
  Crosshair,
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
  SlidersHorizontal,
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
  appendRevision,
  createCheckpoint,
  createProjectDocument,
  duplicateProjectDocument,
  findBodyNode,
  findFeature,
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  listExposedParameters,
  listParameters,
  normalizeDocument,
  repairedDirectEditOperation,
  resolveParamValue,
  restoreFromSaveState,
  staleDirectEditFaceRepair,
  withoutDerivedProjection,
  type ExtrudeInput,
  type StaleDirectEditFaceRepair
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
import { parseStl } from '@openzcad/io-stl';
import type {
  ArtifactKind,
  AccountDeletionScope,
  ArtifactRecord,
  BodyId,
  BodyRepresentation,
  EntityId,
  FeatureId,
  FeatureNode,
  FaceGeometry,
  FaceTopology,
  ParamValue,
  ProjectCheckpoint,
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
  BODY_COLOR_METADATA_KEY,
  BODY_OPACITY_METADATA_KEY,
  compareProjectSummaries,
  DEFAULT_PROJECT_ORGANIZATION,
  duplicateProjectName,
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  isFeatureRollbackSuppressed,
  isFeatureSuppressed,
  projectBranchPoint,
  projectOrganization,
  toProjectId,
  TRASH_RETENTION_DAYS
} from '@openzcad/shared';
import type {
  AppSettings,
  AppSettingsResponse,
  AuthConfigResponse,
  AuthSession,
  HealthResponse,
  ProjectCollaborationCapabilitiesResponse
} from '@openzcad/shared';
import {
  toArtifactId,
  toShaprImportId,
  toSketchConstraintId,
  toUserId,
  UNIT_TO_MM
} from '@openzcad/shared';
import {
  buildConstraint,
  constraintToolSpec,
  describeConstraint,
  refusePick,
  type ConstraintPick
} from './lib/sketch/constraints';
import {
  solveStatusLabel,
  solvedSketchCommands
} from './lib/sketch/applySolve';
import type { SketchSolveStatus } from './components/SketchToolRail';
import { ApiError, api, isProjectDocumentUnavailableError } from './lib/api';
import { uploadArtifactBody } from './lib/artifactUpload';
import {
  archiveLocalOnlyImportSources,
  createInFlightImportChecksums,
  listLocalOnlyImportSources
} from './lib/importArchival';
import {
  LOCAL_AUTOSAVE_FAILED_STATUS,
  reparkFailedAutosave
} from './lib/localAutosaveFailure';
import { MAX_SOURCE_IMPORT_BYTES, runStepImport } from './lib/stepImportRun';
import {
  inspectShaprPair,
  type ShaprPairInspection
} from './lib/shaprImportWorkerClient';
import { shaprMigrationDraft } from './lib/shaprMigration';
import { presentedWorkspaceSaveState } from './lib/workspaceSaveStatePresentation';
import {
  cancelDesktopSignIn,
  isDesktopApp,
  listenForDesktopMenu,
  openDesktopCadFile,
  pollDesktopSignIn,
  protectDesktopClose,
  saveCadBinaryFile,
  saveCadTextFile,
  startDesktopSignIn,
  type CadBinaryExportFormat,
  type DesktopMenuCommand
} from './lib/desktopBridge';
import {
  cloudFunctionsAreEnabled,
  setCloudFunctionsEnabled
} from './lib/cloudMode';
import { CloudSettingsAutosave } from './lib/cloudSettingsAutosave';
import {
  CloudProjectAutosave,
  currentVersionOf,
  type WorkspaceSaveState
} from './lib/cloudProjectAutosave';
import {
  decideProjectSync,
  shouldPollForFreshness
} from './lib/projectSyncDecision';
import {
  claimProjectOwnership,
  type ProjectOwnershipClaim
} from './lib/projectTabOwnership';

import { countReactCommit, mark, measure, timed, timedAsync } from './lib/perf';
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
import { ViewModeRail } from './components/ViewModeRail';
import { Sidebar } from './components/Sidebar';
import { TweakPanel } from './components/TweakPanel';
import { WorkspaceTour } from './components/WorkspaceTour';
import { StatusBar } from './components/StatusBar';
import { StartScreen } from './components/StartScreen';
import { StartupScreen } from './components/StartupScreen';
import type { AuthConfigStatus } from './components/SettingsPage';
import {
  DEMO_DEFINITIONS,
  VISUAL_SELECTION_ACCEPTANCE_DEMO
} from './lib/demoDefinitions';
import type { DemoDefinition } from './lib/demoDefinitions';
import { createProjectSharingClient } from './lib/projectSharing';
import {
  captureProjectInvitationLink,
  clearPendingProjectInvitation
} from './lib/projectInvitationLink';
import {
  captureProjectShareToken,
  clearProjectShareFragment
} from './lib/projectShareLink';
import { fetchSharedProject } from './lib/projectShareClient';
import { ProjectConflictDialog } from './components/ProjectConflictDialog';
import { SaveRevisionDialog } from './components/SaveRevisionDialog';
import type {
  ExportProgress,
  MeshExportDialogFormat
} from './components/ExportDialog';
import type { ShaprImportDialogPhase } from './components/ShaprImportDialog';
import type { GeometryWorkerState } from './worker/geometryWorker';

/** The export dialog's progress stage for one geometry-worker state. */
function exportProgressFor(state: GeometryWorkerState): ExportProgress | null {
  switch (state.phase) {
    case 'starting':
      return 'preparing';
    case 'loading-remus':
      return 'loading-kernel';
    case 'rebuilding':
      return 'building';
    default:
      return null; // Terminal states arrive as the result or the error.
  }
}

/** Per-format file identity for exports from the Export Mesh dialog. */
const MESH_EXPORT_FILE_INFO: Record<
  MeshExportDialogFormat,
  {
    extension: string;
    contentType: string;
    label: string;
    kind: ArtifactKind;
    binaryFormat: CadBinaryExportFormat;
  }
> = {
  '3mf': {
    extension: '3mf',
    contentType: 'model/3mf',
    label: '3MF',
    kind: '3mf-export',
    binaryFormat: '3mf'
  },
  'stl-binary': {
    extension: 'stl',
    contentType: 'model/stl',
    label: 'STL',
    kind: 'stl-export',
    binaryFormat: 'stl'
  },
  stl: {
    extension: 'stl',
    contentType: 'model/stl',
    label: 'STL',
    kind: 'stl-export',
    binaryFormat: 'stl'
  },
  obj: {
    extension: 'obj',
    contentType: 'model/obj',
    label: 'OBJ',
    kind: 'obj-export',
    binaryFormat: 'obj'
  },
  glb: {
    extension: 'glb',
    contentType: 'model/gltf-binary',
    label: 'glTF',
    kind: 'gltf-export',
    binaryFormat: 'glb'
  }
};
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
  sameCylinderAxis,
  supportsRadialCylinderPreview
} from './lib/interaction/cylinderRadius';
import {
  primitiveCylinderHeightAncestor,
  primitiveCylinderRadiusAncestor
} from './lib/interaction/cylinderPrimitiveAncestry';
import { resolveOffsetPreviewFace } from './lib/interaction/offsetPreview';
import {
  blendRadialDirection,
  canRemoveImportedBlendFace,
  editableFilletFeature,
  importedBlendSnapshot,
  newBlendFaceSelections,
  resolveFilletBlendFace,
  resolveImportedBlendFace
} from './lib/interaction/filletFaceEdit';
import { ToolCard } from './components/ToolCard';
import { NumericKeypad, type KeypadRequest } from './components/NumericKeypad';
import type { DimensionMode } from './lib/keypad';
import {
  IDLE,
  escapeTarget,
  interactionReducer,
  commandSessionFor,
  isOperationState,
  radialFaceOperationName,
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
import {
  edgeLengthMeasurement,
  faceLabel,
  textLabelSegments,
  topologySelectionLabelSegments,
  type LabelSegment
} from './lib/topologyLabels';
import type { FeatureSelectionSource } from './lib/inspectorHeading';
import type { CommandDiagnostic } from './lib/interaction/machine';
import { resolveFace } from './lib/topologyResolution';
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
import {
  resolveExtrudeOperation,
  type ResolvedExtrude
} from './lib/extrudeInference';
import type {
  BodyAppearancePreview,
  ExtrudePreview,
  FaceResizeCommit,
  NormalToFaceRequest
} from './components/ModelViewer';
import type {
  SelectionFilter,
  AxisProjection,
  DisplayMode,
  PickDetail,
  SketchOverlay,
  ViewTarget
} from '@openzcad/viewport/types';
import type { MovePreview, MoveSnap, SectionPlaneId } from '@openzcad/viewport';

/**
 * Space activates focused buttons and belongs in free-text fields. Numeric and
 * expression controls do not require spaces, though, and feature inspectors
 * can leave one focused after the user clicks a face in the viewport; let the
 * face shortcut through in that specific case without touching its value.
 */
function focusedControlOwnsSpace(target: HTMLElement | null): boolean {
  if (!target) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return (
      target.type !== 'number' &&
      target.type !== 'range' &&
      !target.closest('.expr-field')
    );
  }
  if (
    target.closest(
      'button, a, [role="button"], [role="tab"], [contenteditable="true"]'
    )
  ) {
    return true;
  }
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return true;
  }
  return false;
}

const LazyViewerShell = lazy(() =>
  import('./components/ViewerShell').then((module) => ({
    default: module.ViewerShell
  }))
);
const LazyViewModeBar = lazy(() =>
  import('./components/ViewModeBar').then((module) => ({
    default: module.ViewModeBar
  }))
);
const LazyMeasurementDock = lazy(() =>
  import('./components/MeasurementDock').then((module) => ({
    default: module.MeasurementDock
  }))
);
const LazySketchToolRail = lazy(() =>
  import('./components/SketchToolRail').then((module) => ({
    default: module.SketchToolRail
  }))
);
const LazySketchEntityEditor = lazy(() =>
  import('./components/SketchEntityEditor').then((module) => ({
    default: module.SketchEntityEditor
  }))
);
const LazyAssistantPanel = lazy(() =>
  import('./components/assistant/AssistantPanel').then((module) => ({
    default: module.AssistantPanel
  }))
);
/**
 * Surfaces that open on a deliberate gesture, and so are not first paint.
 *
 * Settings is the largest single module in the app after the viewport, and it
 * pulls the cloud-deletion dialog in behind it; sharing and export are modals
 * that most sessions never open. Loading all three eagerly put their whole
 * weight in the launcher chunk — before a project is even open — for the sake
 * of a click that may never come.
 */
const LazySettingsPage = lazy(() =>
  import('./components/SettingsPage').then((module) => ({
    default: module.SettingsPage
  }))
);
const LazyProjectSharingDialog = lazy(() =>
  import('./components/ProjectSharingDialog').then((module) => ({
    default: module.ProjectSharingDialog
  }))
);
const LazyExportDialog = lazy(() =>
  import('./components/ExportDialog').then((module) => ({
    default: module.ExportDialog
  }))
);
const LazyShaprImportDialog = lazy(() =>
  import('./components/ShaprImportDialog').then((module) => ({
    default: module.ShaprImportDialog
  }))
);
/**
 * The edit panel, which only exists while something is being edited.
 *
 * `inspectorActive` gates it, so it is never on screen at first paint and
 * often never in a session spent reading a model. Between them the two forms
 * and the field library behind them were the largest workspace-only weight
 * left in the launcher chunk.
 */
const LazyInspector = lazy(() =>
  import('./components/Inspector').then((module) => ({
    default: module.Inspector
  }))
);
const LazyModelingOperationsForm = lazy(() =>
  import('./components/forms/ModelingOperationsForm').then((module) => ({
    default: module.ModelingOperationsForm
  }))
);

function AssistantPanel(props: ComponentProps<typeof LazyAssistantPanel>) {
  return (
    <Suspense fallback={null}>
      <LazyAssistantPanel {...props} />
    </Suspense>
  );
}

function ViewerShell(props: ComponentProps<typeof LazyViewerShell>) {
  return (
    <Suspense
      fallback={
        <div className="viewer-shell" role="status" aria-live="polite">
          Loading 3D viewport…
        </div>
      }
    >
      <LazyViewerShell {...props} />
    </Suspense>
  );
}

function ViewModeBar(props: ComponentProps<typeof LazyViewModeBar>) {
  return (
    <Suspense fallback={null}>
      <LazyViewModeBar {...props} />
    </Suspense>
  );
}

function MeasurementDock(props: ComponentProps<typeof LazyMeasurementDock>) {
  return (
    <Suspense fallback={null}>
      <LazyMeasurementDock {...props} />
    </Suspense>
  );
}

function SketchToolRail(props: ComponentProps<typeof LazySketchToolRail>) {
  return (
    <Suspense fallback={null}>
      <LazySketchToolRail {...props} />
    </Suspense>
  );
}

function SketchEntityEditor(
  props: ComponentProps<typeof LazySketchEntityEditor>
) {
  return (
    <Suspense fallback={null}>
      <LazySketchEntityEditor {...props} />
    </Suspense>
  );
}

function SettingsPage(props: ComponentProps<typeof LazySettingsPage>) {
  return (
    <Suspense fallback={null}>
      <LazySettingsPage {...props} />
    </Suspense>
  );
}

function ProjectSharingDialog(
  props: ComponentProps<typeof LazyProjectSharingDialog>
) {
  return (
    <Suspense fallback={null}>
      <LazyProjectSharingDialog {...props} />
    </Suspense>
  );
}

function ExportDialog(props: ComponentProps<typeof LazyExportDialog>) {
  return (
    <Suspense fallback={null}>
      <LazyExportDialog {...props} />
    </Suspense>
  );
}

function ShaprImportDialog(
  props: ComponentProps<typeof LazyShaprImportDialog>
) {
  return (
    <Suspense fallback={null}>
      <LazyShaprImportDialog {...props} />
    </Suspense>
  );
}

function Inspector(props: ComponentProps<typeof LazyInspector>) {
  return (
    <Suspense fallback={null}>
      <LazyInspector {...props} />
    </Suspense>
  );
}

function ModelingOperationsForm(
  props: ComponentProps<typeof LazyModelingOperationsForm>
) {
  return (
    <Suspense fallback={null}>
      <LazyModelingOperationsForm {...props} />
    </Suspense>
  );
}

function extrudeInferenceDescription(resolved: ResolvedExtrude | null): string {
  if (!resolved) {
    return 'Measuring positive-volume overlap in the exact kernel…';
  }
  const inference = resolved.inference;
  switch (inference.reason) {
    case 'enclosed':
      return `Enclosed by ${inference.targetBodyName}; Cut is stored.`;
    case 'partial-overlap':
      return `Partially overlaps ${inference.targetBodyName}; Add is stored.`;
    case 'multiple-overlap':
      return 'Several bodies overlap; New Body avoids implicit consumption.';
    case 'coincident':
      return 'Coincident volume is ambiguous; New Body is stored.';
    case 'exact-measurement-refused':
      return 'Exact overlap was inconclusive; New Body is stored.';
    case 'no-live-body':
      return 'No live body can be targeted; New Body is stored.';
    case 'no-overlap':
      return 'No positive-volume overlap; New Body is stored.';
  }
}
import {
  chooseProjectDocument,
  clearAllLastSyncedVersions,
  clearLastSyncedVersion,
  deleteLocalProject,
  isLocalStorageBlockedError,
  listLocalProjectOrganizations,
  listLocalProjects,
  listLocalSaveStateIds,
  loadLastSyncedVersion,
  loadLocalProject,
  loadLocalSaveState,
  loadProjectMeasurements,
  loadProjectThumbnail,
  loadSourceBlob,
  purgeExpiredLocalProjects,
  restoreDuplicateDerivedProjection,
  saveLastSyncedVersion,
  saveLocalProjectOrganization,
  saveProjectMeasurements,
  saveProjectThumbnail,
  saveLocalProject,
  withMatchingLocalDerived
} from './lib/localProjectStore';
import {
  applyLocalProjectOrganizations,
  cachedThumbnailSource,
  mergeProjectSummaries
} from './lib/projectShelf';
import { LivePreview } from './lib/livePreview';
import { errorMessage } from './lib/errors';
import { describeSyncFailure, type SyncEntry } from './lib/syncRun';
import { useGeometryWorker } from './hooks/useGeometryWorker';
import { useProjectView } from './hooks/useProjectView';
import { useDirectEditCommit } from './hooks/useDirectEditCommit';
import { useValidatedFeatureCommit } from './hooks/useValidatedFeatureCommit';
import {
  affectedFeatureTargets,
  type AffectedFeatureTarget
} from './lib/affectedFeatureTargets';
import { directEditRejection } from './lib/directEdit';
import { validatedFeatureRejection } from './lib/featureValidation';
import { useCollaboration } from './lib/useCollaboration';
import { preflightCadPatch } from './lib/aiPatchPreflight';
import type { AssistantPreviewOutcome } from './components/assistant/AssistantPanel';
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
  type ModelingOperationSubmission,
  type ModelingPathOption,
  type ModelingProfileOption
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
  resolvedAppTheme,
  saveLocalAppSettings,
  shouldAdoptAccountSettings
} from './lib/appSettings';
import type {
  Measurement,
  MeasurementDisplayOptions,
  MeasurementMode,
  MeasurementTarget,
  MeasurementViewportAnnotation,
  RadialDisplay
} from './lib/measurements';
/**
 * The measurement module's shape, for the deferred handle below. A type-only
 * namespace import is erased at build time exactly like the named ones above,
 * so naming the module here does not pull it back into the eager chunk.
 */
import type * as MeasurementModule from './lib/measurements';
import { buildMeasurementRecord } from './lib/measurementRecord';
import {
  EMPTY_MEASURE_SESSION,
  edgeRunIsTotalable,
  nextEdgeRun
} from './lib/measureSession';
import {
  loadPanelState,
  savePanelState,
  toggleSidebarSection,
  type PanelState,
  type SidebarSectionId,
  type WorkspaceMode
} from './lib/panelState';
import {
  loadSettingsViewState,
  updateSettingsViewState
} from './lib/settingsViewState';
import {
  ASSISTANT_WIDTH_LIMITS,
  clampAssistantWidth,
  clampSidebarWidth,
  maxAssistantWidth,
  maxSidebarWidth,
  savedPanelWidths,
  SIDEBAR_WIDTH_LIMITS
} from './lib/panelWidths';

const START_SCREEN_DEMOS =
  (import.meta.env as unknown as { VITE_E2E?: string }).VITE_E2E === '1'
    ? [...DEMO_DEFINITIONS, VISUAL_SELECTION_ACCEPTANCE_DEMO]
    : DEMO_DEFINITIONS;

declare global {
  interface Window {
    /**
     * Overrides the offset previewer's slow-frame budget, honoured only in
     * `VITE_E2E=1` builds. Whether a rebuild degrades otherwise depends on how
     * long the kernel happens to take, which an end-to-end test cannot pin
     * down; setting this to 0 makes the deferred-preview path deterministic.
     */
    __openzcadE2ESlowFrameMs?: number;
  }
}

const E2E_SLOW_FRAME_MS =
  (import.meta.env as unknown as { VITE_E2E?: string }).VITE_E2E === '1' &&
  typeof window !== 'undefined' &&
  typeof window.__openzcadE2ESlowFrameMs === 'number'
    ? window.__openzcadE2ESlowFrameMs
    : undefined;

/**
 * How often an open cloud project checks whether another device has moved it.
 * Focus and reconnect cover the cases that matter most; the interval is the
 * backstop for a tab left open and in front of somebody.
 */
const FRESHNESS_POLL_INTERVAL_MS = 60_000;
/**
 * The save point a restore leaves behind for itself. Named once so the panel
 * and the handler agree on the row a user goes looking for to undo a restore
 * they have already closed the tab on.
 */
const BEFORE_RESTORE_REASON = 'Before restore';
/**
 * What an unnamed save is called. Ctrl+S stays a reflex and takes this; naming
 * one is its own gesture (Ctrl+Shift+S).
 */
const DEFAULT_SAVE_REASON = 'Manual save';
const DISABLED_COLLABORATION_ROLLOUT: ProjectCollaborationCapabilitiesResponse =
  {
    sharingEnabled: false,
    editLeasesEnforced: false,
    personalSyncEnabled: false,
    canary: false
  };
const projectSharingClient = createProjectSharingClient();
const localUserId = toUserId('user_local_browser');
const DISPLAY_MODE_ORDER: DisplayMode[] = [
  'shaded-edges',
  'shaded',
  'wireframe'
];

type AdoptLocalProjectResult =
  | { state: 'adopted' | 'already-adopted' | 'missing' }
  | { state: 'conflict'; conflict: ProjectConflict };

interface OffsetEditPlan {
  command: AnyCommand;
  bodyId: BodyId;
  successMessage: string;
  validationTargets?: AffectedFeatureTarget[];
  preflightRejection?: string;
}

interface OffsetPreviewCandidate {
  document: ProjectDocument;
  offset: number;
  bodyId: BodyId;
  label: string;
  baseProjectId: ProjectDocument['projectId'];
  baseVersion: number;
  validationTargets?: AffectedFeatureTarget[];
}

interface OffsetPreviewResult {
  derived: ProjectDocument['derived'];
  rejection: CommandDiagnostic | null;
}

function desktopAuthorizationAttemptFromLocation(): string | null {
  if (typeof globalThis.location === 'undefined' || isDesktopApp()) {
    return null;
  }
  const attempt = new URLSearchParams(globalThis.location.search).get(
    'desktopAuth'
  );
  return attempt && /^[A-Za-z0-9-]{16,64}$/.test(attempt) ? attempt : null;
}

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

interface AccountProjectLoadResult {
  document: ProjectDocument | null;
  error?: unknown;
}

async function loadAccountProjectResult(
  projectId: string
): Promise<AccountProjectLoadResult> {
  try {
    return { document: await api.loadProject(projectId) };
  } catch (error) {
    return { document: null, error };
  }
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
  const unavailableAs =
    <T,>(fallback: T) =>
    (error: unknown): T => {
      // A device with no IndexedDB is legitimately a device with no local
      // projects. A blocked schema upgrade is temporary and actionable; calling
      // it an empty shelf would tell the user their projects disappeared.
      if (isLocalStorageBlockedError(error)) {
        throw error;
      }
      return fallback;
    };
  const [local, localOrganizations, remote] = await Promise.all([
    listLocalProjects().catch(unavailableAs<ProjectSummary[]>([])),
    listLocalProjectOrganizations().catch(
      unavailableAs(new Map<string, ProjectOrganization>())
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

/**
 * Stable empties for viewport props. An inline `[]` is a new array every
 * render, and the viewport treats a new array as new content to install.
 */
const EMPTY_SKETCH_OVERLAYS: SketchOverlay[] = [];
const EMPTY_BODY_IDS: string[] = [];

interface PendingShaprImport {
  shaprFile: File;
  sourceStepFile: File;
  phase: ShaprImportDialogPhase;
  progress: string;
  error: string | null;
  inspection: ShaprPairInspection | null;
}

export function App() {
  // Counts this component's commits for the interaction probes. Deliberately
  // dependency-free so it runs after every commit, and deliberately inside
  // App rather than around it: a wrapper never re-renders when App's own
  // state changes, which is exactly the traffic worth counting.
  useEffect(() => {
    if (import.meta.env.OZ_PERF === '1') {
      countReactCommit();
    }
  });
  const [desktopAuthorizationAttempt] = useState(
    desktopAuthorizationAttemptFromLocation
  );
  const [pendingInvitationToken, setPendingInvitationToken] = useState(
    captureProjectInvitationLink
  );
  /**
   * A `#share=` link this tab was opened with, read once at mount. Non-null
   * turns this into a shared-link session: the shared document is fetched
   * anonymously, pinned to the Tweak workspace, and never written to this
   * device's storage — Make a copy is the one road out.
   */
  const [pendingShareToken] = useState(captureProjectShareToken);
  const [shareSession, setShareSession] = useState<{ token: string } | null>(
    null
  );
  const shareSessionRef = useRef(shareSession);
  shareSessionRef.current = shareSession;
  const shareOpenAttemptRef = useRef(false);
  const [pendingInvitationError, setPendingInvitationError] = useState<
    string | null
  >(null);
  const pendingInvitationAttemptRef = useRef<string | null>(null);
  const acceptPendingInvitationRef = useRef<(token: string) => Promise<void>>(
    async () => undefined
  );
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
  const [cloudFunctionsEnabled, setCloudFunctionsEnabledState] = useState(
    cloudFunctionsAreEnabled
  );
  const cloudFunctionsEnabledRef = useRef(cloudFunctionsEnabled);
  cloudFunctionsEnabledRef.current = cloudFunctionsEnabled;
  const bootCloudFunctionsEnabledRef = useRef(cloudFunctionsEnabled);
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
    !pendingInvitationToken &&
    !pendingShareToken &&
    appSettings.general.reopenLastProject
      ? loadActiveProjectId()
      : null
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
  const setWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    setPanelState((current) => ({ ...current, workspaceMode: mode }));
  }, []);
  const workspaceRef = useRef<HTMLElement | null>(null);
  // Panel widths are capped against the window, so a narrower window has to
  // recompute them. The stored preference is never rewritten by a resize: it is
  // what the user asked for, and it applies again on a screen that can hold it.
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 0
  );
  useEffect(() => {
    // Coalesced to one render per frame: dragging a window edge emits resize
    // events faster than the editor can usefully re-render, and every one of
    // them re-renders the whole tree on top of the canvas resize the viewport
    // is already doing.
    let frame: number | null = null;
    const onResize = () => {
      if (frame !== null) {
        return;
      }
      frame = globalThis.requestAnimationFrame(() => {
        frame = null;
        setWindowWidth(globalThis.innerWidth);
      });
    };
    setWindowWidth(globalThis.innerWidth);
    globalThis.addEventListener('resize', onResize);
    return () => {
      if (frame !== null) {
        globalThis.cancelAnimationFrame(frame);
      }
      globalThis.removeEventListener('resize', onResize);
    };
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
  const [settingsOpen, setSettingsOpen] = useState(
    () =>
      pendingInvitationToken !== null ||
      desktopAuthorizationAttempt !== null ||
      loadSettingsViewState().open
  );
  const settingsDialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(settingsDialogRef, {
    enabled: settingsOpen,
    autoFocus: true
  });
  const [sharingOpen, setSharingOpen] = useState(false);
  const [meshExportOpen, setMeshExportOpen] = useState(false);
  const [pendingShaprImport, setPendingShaprImport] =
    useState<PendingShaprImport | null>(null);
  const shaprPreviewAbortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      shaprPreviewAbortRef.current?.abort();
    },
    []
  );
  /**
   * First-model tour eligibility, latched per project: set when a project
   * OPENS empty on this device, so the tour rides along while its first
   * features are added but never appears over someone's existing model.
   */
  const [tourProjectId, setTourProjectId] = useState<string | null>(null);
  /** The export dialog has been opened this session — the tour's last signal. */
  const [tourExportSeen, setTourExportSeen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState(
    pendingInvitationToken
      ? 'Sign in to open the shared project automatically.'
      : desktopAuthorizationAttempt
        ? 'Sign in, then approve OpenZCAD for macOS.'
        : 'Changes save on this device immediately.'
  );
  const [desktopAuthorizationCode, setDesktopAuthorizationCode] = useState('');
  const [desktopAuthorizationApproved, setDesktopAuthorizationApproved] =
    useState(false);
  const cloudSettingsAutosaveRef = useRef<CloudSettingsAutosave | null>(null);
  const cloudProjectAutosaveRef = useRef<CloudProjectAutosave | null>(null);
  const cloudSettingsSessionUserRef = useRef<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  /**
   * Which of the open project's save points can actually be opened. Empty
   * until the stores answer, so a row never offers an action before it is
   * known to work.
   */
  const [restorableCheckpointIds, setRestorableCheckpointIds] = useState<
    ReadonlySet<string>
  >(new Set());
  /** Open while the user is naming a save point. */
  const [namingSave, setNamingSave] = useState(false);
  // Named `doc` (not `document`) so the global DOM document is never shadowed.
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  /**
   * The feature the inspector is showing, and how it got there.
   *
   * A history-tree click *pins* a feature: the user asked for that feature, so
   * it names the panel. A viewport pick *infers* the feature that currently
   * defines the picked body — an answer to "what made this shape", which is
   * not the command the pick just armed. Keeping the provenance is what stops
   * the panel from titling itself after an unrelated earlier operation.
   */
  const [selectedFeatureNode, setSelectedFeatureNode] = useState<{
    id: string;
    source: FeatureSelectionSource;
  } | null>(null);
  const selectedFeatureNodeId = selectedFeatureNode?.id ?? null;
  const featureSelectionSource = selectedFeatureNode?.source ?? null;
  function selectFeatureNode(
    id: string | null,
    source: FeatureSelectionSource
  ) {
    // Keep the object when nothing moved. Re-picking the same feature used to
    // set an unchanged string and cost no render; a fresh object every time
    // would re-render the workspace on every repeat pick.
    setSelectedFeatureNode((current) =>
      current?.id === id && current.source === source
        ? current
        : id
          ? { id, source }
          : null
    );
  }
  /** The feature that currently defines a picked body, if there is one. */
  function inferFeatureNodeFor(bodyId: BodyId | null) {
    selectFeatureNode(bodyId ? featureNodeIdForBody(bodyId) : null, 'inferred');
  }
  const [selectedTopology, setSelectedTopology] =
    useState<TopologySelection | null>(null);
  // Viewport-only edge picks for one fillet/chamfer feature. The document
  // remains the source of truth once the command is committed.
  const [selectedEdges, setSelectedEdges] = useState<TopologySelection[]>([]);
  /**
   * Armed face re-pick for a direct edit whose stored face went stale. While
   * set, the next viewport face pick repairs that feature instead of arming
   * a selection; Escape disarms it.
   */
  const [faceRepair, setFaceRepair] =
    useState<StaleDirectEditFaceRepair | null>(null);
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
  const [resolvedExtrudePreview, setResolvedExtrudePreview] =
    useState<ResolvedExtrude | null>(null);
  const extrudePreviewRef = useRef(extrudePreview);
  extrudePreviewRef.current = extrudePreview;
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  /**
   * Name for the Move feature the gizmo is about to create. The gizmo is now
   * the only way to make one (WF-07), so the name it commits under has to be
   * editable here rather than in the form this replaced.
   */
  const [moveName, setMoveName] = useState('Move');
  /**
   * A committed Move whose exact rebuild is still in flight. The viewer keeps
   * the body posed at the applied transform until the recomputed meshes land,
   * so the old geometry never flashes at its resting position.
   */
  const [moveCommitHold, setMoveCommitHold] = useState<MovePreview | null>(
    null
  );
  /**
   * Drag-phase body color/opacity patch rendered without a document write;
   * committed through node metadata when the pointer releases.
   */
  const [bodyAppearancePreview, setBodyAppearancePreview] =
    useState<BodyAppearancePreview | null>(null);
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
  const [status, setStatus] = useState(
    cloudFunctionsEnabled ? 'Checking beta API...' : 'Offline workspace'
  );
  const [busy, setBusy] = useState(false);
  /**
   * The last refusal from an exact rebuild, shown inside the form that asked
   * for it. Cleared whenever a panel opens or closes so a stale reason can
   * never outlive the attempt that produced it.
   */
  const [featureFormError, setFeatureFormError] = useState<string | null>(null);
  const {
    projection,
    setProjection,
    settings: viewerSettings,
    setSettings: setViewerSettings,
    initialView,
    hiddenBodyIds,
    setHiddenBodyIds,
    restore: restoreProjectView,
    onCameraChange: updateCameraPose,
    onCameraSettled: persistCameraPose,
    forget: forgetProjectView
  } = useProjectView(doc?.projectId ?? null);
  const [previewDoc, setPreviewDoc] = useState<ProjectDocument | null>(null);
  const [saveState, setSaveState] = useState<WorkspaceSaveState>('saving');
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const desktopMenuHandlerRef = useRef<(command: DesktopMenuCommand) => void>(
    () => undefined
  );
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [deploymentHealth, setDeploymentHealth] =
    useState<HealthResponse | null>(null);
  const [collaborationRollout, setCollaborationRollout] = useState(
    DISABLED_COLLABORATION_ROLLOUT
  );
  const [session, setSession] = useState<AuthSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  /**
   * The shelf's preview source. This reads a small device-cached or cloud
   * image and nothing else — deliberately not the project document. Loading
   * documents here made the start screen unreachable for large imports: a
   * part with a few-hundred-megabyte source had to be pulled into memory in
   * full, per tile, just to draw a 360×200 card, which could take the tab and
   * the machine down and leave the owner unable to open or delete their work.
   * A project with no published preview simply shows the placeholder.
   */
  const loadThumbnail = useCallback(
    async (project: ProjectSummary): Promise<string | null | undefined> => {
      const cached = await loadProjectThumbnail(project.projectId).catch(
        () => null
      );
      const cachedSource = cachedThumbnailSource(cached, project);
      if (cachedSource !== undefined || !project.thumbnailArtifactId) {
        return cachedSource;
      }
      const { downloadCloudThumbnail } = await import('./lib/cloudThumbnail');
      return downloadCloudThumbnail(project.thumbnailArtifactId).catch(
        () => undefined
      );
    },
    []
  );
  const [fitSignal, setFitSignal] = useState(0);
  const [viewRequest, setViewRequest] = useState<{
    view: ViewTarget;
    nonce: number;
  } | null>(null);
  const [normalToFaceRequest, setNormalToFaceRequest] =
    useState<NormalToFaceRequest | null>(null);
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
  const keypadRef = useRef(keypad);
  keypadRef.current = keypad;
  /** Latest pointer/entry value stays transient until an exact frame lands. */
  const offsetPreviewValueRef = useRef<number | null>(null);
  /**
   * True once a gesture's rebuilds became too slow to keep previewing. The
   * handle keeps moving; the geometry does not, and the value chip says so.
   */
  const [previewDeferred, setPreviewDeferred] = useState(false);
  /** Signed offset represented by the currently published previewDoc. */
  const [renderedOffsetPreview, setRenderedOffsetPreview] = useState<
    number | null
  >(null);
  /** New exact blend faces, computed once when an edge-fillet preview lands. */
  const [previewBlendFaces, setPreviewBlendFaces] = useState<
    TopologySelection[]
  >([]);
  const [cylinderDimensionMode, setCylinderDimensionMode] =
    useState<DimensionMode>('diameter');
  const keypadAnchorRef = useRef<
    ((point: { x: number; y: number } | null) => void) | null
  >(null);
  /** Lets keypad typing drive the viewport's offset-handle preview. */
  const offsetSetterRef = useRef<((offset: number) => void) | null>(null);
  /**
   * Live move-drag values, published by the viewport straight to the panel
   * that shows them. Workspace state learns the result when the drag settles.
   */
  const moveValuesSetterRef = useRef<
    | ((
        translation: MovePreview['translation'],
        rotationDeg: MovePreview['rotationDeg'],
        snap: MoveSnap
      ) => void)
    | null
  >(null);
  /** Whether the running command will render the current edit's rejection. */
  const commandOwnsDiagnosticRef = useRef(false);
  /** Cancels the viewport's captured pointer session on keyboard Escape. */
  const cancelDirectManipulationRef = useRef<(() => boolean) | null>(null);
  /** Opens exact entry for the armed handle, as tapping its chip would. */
  const openExactEntryRef = useRef<(() => boolean) | null>(null);
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
        applyEdgeReferenceRepairs(derived.referenceRepairs);
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
   * A project known to exist in the account whose document object could not be
   * read. Keep it out of the autosave controller until an explicit retry loads
   * the account copy, while IndexedDB continues to receive every edit.
   */
  const accountDocumentUnavailableProjectIdRef = useRef<string | null>(null);
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
   * Whether the last account project listing actually reached the server.
   * An empty successful list means every local project is device-only; a
   * failed list means their cloud status is unknown and must not be relabelled.
   */
  const [accountProjectListReached, setAccountProjectListReached] =
    useState(false);
  const thumbnailBackfillRuntimeRef = useRef({
    cloudProjectIds
  });
  thumbnailBackfillRuntimeRef.current = {
    cloudProjectIds
  };
  const thumbnailAccountUserId = session?.userId;
  /**
   * Publishes a device-cached preview when the account has no artifact. A cache
   * miss stays a placeholder so the recovery shelf never loads project data.
   */
  const backfillThumbnail = useCallback(
    async (project: ProjectSummary): Promise<string | null | undefined> => {
      const [thumbnail, backfill] = await Promise.all([
        import('./lib/partThumbnail'),
        import('./lib/projectThumbnailBackfill')
      ]);
      return thumbnail.queuePartThumbnail(async () => {
        const runtime = thumbnailBackfillRuntimeRef.current;
        const cloudBacked =
          Boolean(thumbnailAccountUserId && accountProjectListReached) &&
          runtime.cloudProjectIds.has(project.projectId);
        const result = await backfill.backfillProjectThumbnail(project, {
          loadCached: (projectId) =>
            loadProjectThumbnail(projectId).catch(() => null),
          ...(cloudBacked
            ? {
                publish: async (input: {
                  projectId: ProjectDocument['projectId'];
                  source: string;
                  version: number;
                  updatedAt: string;
                }) => {
                  const { uploadCloudThumbnail } =
                    await import('./lib/cloudThumbnail');
                  return uploadCloudThumbnail(api, input);
                }
              }
            : {}),
          save: saveProjectThumbnail
        });
        if (result.artifactId) {
          setProjects((current) =>
            current.map((candidate) =>
              candidate.projectId === project.projectId
                ? { ...candidate, thumbnailArtifactId: result.artifactId }
                : candidate
            )
          );
        }
        return result.source;
      });
    },
    [accountProjectListReached, thumbnailAccountUserId]
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
  // Reached from the page-hide listener, which is registered once and would
  // otherwise hold the first render's closure.
  const flushPendingLocalSaveRef = useRef<() => Promise<void>>(() =>
    Promise.resolve()
  );
  /**
   * Another tab is already editing this project, so this one must not write
   * over its storage. Mirrored into a ref because the autosave path that has
   * to check it is not a render.
   */
  const [projectOpenElsewhere, setProjectOpenElsewhere] = useState(false);
  const projectOpenElsewhereRef = useRef(projectOpenElsewhere);
  projectOpenElsewhereRef.current = projectOpenElsewhere;
  /**
   * Settles once this tab knows whether it owns the open project. Claiming is
   * asynchronous and the autosave debounce is not, so without somewhere to wait
   * the first write can land before the answer does — which is the overwrite
   * the claim exists to prevent.
   */
  const projectOwnershipSettledRef = useRef<Promise<void> | null>(null);
  const cylinderRadiusPreview = useRef(
    new LivePreview<ProjectDocument, ProjectDocument['derived']>({
      build: (radius) => {
        const plan = buildCylinderRadiusCommand(radius);
        const base = managerRef.current?.document;
        return plan && base ? plan.command.apply(base) : null;
      },
      derive: (document) => geometry.syncOnce(document),
      publish: (preview) =>
        setPreviewDoc(
          preview ? { ...preview.document, derived: preview.derived } : null
        ),
      continueAfterSlow: true
    })
  ).current;

  /**
   * Exact planar push/pull preview. The document wrapper carries validation
   * context alongside the candidate, but only its rebuilt ProjectDocument is
   * ever published into previewDoc; manager.document is never touched.
   */
  const offsetPreview = useRef(
    new LivePreview<OffsetPreviewCandidate, OffsetPreviewResult>({
      build: (offset) => {
        const base = managerRef.current?.document;
        const plan = base ? buildOffsetEditPlan(offset, undefined, base) : null;
        return base && plan
          ? {
              document: plan.command.apply(base),
              offset,
              bodyId: plan.bodyId,
              label: plan.command.label,
              baseProjectId: base.projectId,
              baseVersion: base.version,
              ...(plan.validationTargets
                ? { validationTargets: plan.validationTargets }
                : {})
            }
          : null;
      },
      derive: async (candidate) => {
        const derived = await geometry.syncOnce(candidate.document);
        const live = managerRef.current;
        const documentMoved =
          !live ||
          live.document.projectId !== candidate.baseProjectId ||
          live.document.version !== candidate.baseVersion;
        let rejection: CommandDiagnostic | null = null;
        if (candidate.validationTargets) {
          for (const target of candidate.validationTargets) {
            rejection = validatedFeatureRejection({
              featureName: target.featureName,
              ...(target.featureId ? { featureId: target.featureId } : {}),
              warnings: derived.warnings,
              bodyPresent: Boolean(
                derived.bodyRepresentations[target.resultBodyId]
              ),
              documentMoved
            });
            if (rejection) {
              break;
            }
          }
          if (
            !rejection &&
            candidate.validationTargets.length === 0 &&
            documentMoved
          ) {
            rejection = {
              message: 'The document changed while the preview was rebuilding.'
            };
          }
        } else {
          const message = directEditRejection({
            label: candidate.label,
            warnings: derived.warnings,
            bodyPresent: Boolean(derived.bodyRepresentations[candidate.bodyId]),
            documentMoved
          });
          rejection = message ? { message } : null;
        }
        return { derived, rejection };
      },
      publish: (preview) => {
        if (!preview) {
          setPreviewDoc(null);
          setRenderedOffsetPreview(null);
          return;
        }
        if (preview.derived.rejection) {
          reportOffsetPreviewFailure(
            preview.derived.rejection.message,
            preview.document.offset
          );
          return;
        }
        setPreviewDoc({
          ...preview.document.document,
          derived: preview.derived.derived
        });
        setRenderedOffsetPreview(preview.document.offset);
        recoverOffsetPreviewInteraction();
      },
      onFailure: ({ error, value }) =>
        reportOffsetPreviewFailure(
          errorMessage(error, 'Exact offset preview failed.'),
          value
        ),
      acceptValue: (offset) =>
        Number.isFinite(offset) && Math.abs(offset) > 1e-9,
      continueAfterSlow: false,
      ...(E2E_SLOW_FRAME_MS === undefined
        ? {}
        : { slowFrameMs: E2E_SLOW_FRAME_MS }),
      onDegrade: () => setPreviewDeferred(true)
    })
  ).current;

  /**
   * Exact profile extrusion preview. LivePreview supplies newest-request wins
   * sequencing, so a slow worker response can never replace a newer distance
   * or profile selection.
   */
  const profileExtrudePreview = useRef(
    new LivePreview<
      { base: ProjectDocument; input: ExtrudeInput },
      ResolvedExtrude
    >({
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
        const command = commandFactories.extrudeSketch({
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
        });
        return { base, input: command.payload };
      },
      derive: ({ base, input }) =>
        resolveExtrudeOperation({
          base,
          input,
          derive: (document) => geometry.syncOnce(document)
        }),
      publish: (preview) => {
        setPreviewDoc(
          preview
            ? {
                ...preview.derived.document,
                derived: preview.derived.derived
              }
            : null
        );
        setResolvedExtrudePreview(preview?.derived ?? null);
        if (preview) {
          const count = selectedProfilesRef.current.length;
          const inference = preview.derived.inference;
          const operation =
            inference.operation === 'new-body'
              ? 'New Body'
              : inference.operation === 'add'
                ? `Add to ${inference.targetBodyName}`
                : `Cut ${inference.targetBodyName}`;
          setStatus(
            `${count} profile${count === 1 ? '' : 's'} selected · exact preview ready · ${operation}.`
          );
        }
      },
      acceptValue: (distance) =>
        Number.isFinite(distance) && Math.abs(distance) >= 0.1,
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
    setResolvedExtrudePreview(null);
    profileExtrudePreview.request(extrudePreview.distance);
  }, [extrudePreview, profileExtrudePreview, selectedProfiles]);

  const { run: executeValidatedDirectEdit } = useDirectEditCommit({
    manager: () => managerRef.current,
    derive: (document) => geometry.syncOnce(document),
    commit: (command, derived) => executeCommand(command, derived),
    onValidationStart: (value) => {
      // Recorded before the dispatch, while the machine still holds the state
      // the reducer will test: a command that owns this run will render its own
      // rejection, so the status line must not print a second copy.
      commandOwnsDiagnosticRef.current = isOperationState(
        interactionRef.current
      );
      dispatchInteraction({ type: 'validation-start', value });
    },
    onValidationFailed: (diagnostic, value) => {
      cylinderRadiusPreview.clear();
      offsetPreview.clear();
      setPreviewDeferred(false);
      offsetPreviewValueRef.current = null;
      dispatchInteraction({
        type: 'validation-failed',
        diagnostic,
        value
      });
      if (!commandOwnsDiagnosticRef.current) {
        setStatus(diagnostic.message);
      }
    },
    onCommitted: (bodyId) => {
      cylinderRadiusPreview.clear();
      offsetPreview.clear();
      setPreviewDeferred(false);
      offsetPreviewValueRef.current = null;
      dispatchInteraction({ type: 'commit-complete' });
      setSelectedTopology(null);
      setSelectedEdges([]);
      setSelectedBodyIds([bodyId]);
      inferFeatureNodeFor(bodyId);
    },
    onBusy: setBusy,
    onStatus: setStatus
  });
  // Held whole rather than destructured, because the STEP import hands the
  // reservation it took back to the run that adopts it: two callbacks pulled
  // out separately could be wired from different hook instances, and a
  // reservation the run does not recognise degrades in silence.
  const validatedFeature = useValidatedFeatureCommit({
    manager: () => managerRef.current,
    derive: (document) => geometry.syncOnce(document),
    commit: (command, derived) => executeCommand(command, derived ?? undefined),
    commitTransaction: (label, commands, derived) =>
      executeTransaction(label, commands, derived ?? undefined),
    onBusy: setBusy,
    onStatus: setStatus,
    onFailure: setFeatureFormError
  });
  const executeValidatedFeature = validatedFeature.run;
  /**
   * Checksums of imports between their blob write and their commit decision.
   * Content addressing puts a re-import of the same file on the same key, so
   * without this a second import's cleanup can delete the bytes the first one
   * is still validating against.
   */
  const inFlightImportChecksums = useRef(createInFlightImportChecksums());
  /**
   * Checksums this tab wrote for an import that then ended without a verdict on
   * the file — the document moved out from under it, or the commit lock had
   * been taken by the time it asked. The bytes are deliberately kept: they are
   * exactly what the retry needs, and content addressing makes that retry's
   * write a no-op instead of another 250 MB.
   *
   * Remembering them is what keeps the retry's cleanup armed. Without it the
   * retry finds the key already present, concludes it is not its to delete, and
   * a genuine kernel refusal would then keep the whole source forever.
   */
  const abandonedImportChecksums = useRef(new Set<string>());

  const projectSharingPreferenceEnabled = appSettings.collaboration.enabled;
  const projectSharingEnabled =
    projectSharingPreferenceEnabled && collaborationRollout.sharingEnabled;
  const liveCollaborationEnabled =
    projectSharingPreferenceEnabled &&
    (collaborationRollout.sharingEnabled ||
      collaborationRollout.personalSyncEnabled);

  const collaboration = useCollaboration({
    enabled: cloudFunctionsEnabled,
    document: doc,
    // A signed-in user can still be editing a device-only project. Only attach
    // account credentials to a collaboration room after this exact project has
    // been resolved as a cloud-backed document. Desktop exchanges its native
    // bearer credential for a short-lived, one-use WebSocket ticket.
    session: cloudAvailable && liveCollaborationEnabled ? session : null,
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
      void (async () => {
        try {
          await saveLocalProject(remoteDocument);
          await saveLastSyncedVersion(
            remoteDocument.projectId,
            remoteDocument.version
          );
        } catch {
          setSaveState('offline');
          setStatus(
            'The incoming account update is open, but could not be saved on this device. Export it before closing.'
          );
        }
      })();
      cloudProjectAutosaveRef.current?.adoptAccountVersion(
        remoteDocument.projectId,
        remoteDocument.version
      );
      hydrateDocument(remoteDocument, {
        restoreView: false,
        rememberProject: false
      });
      setStatus(
        projectSharingEnabled
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
  const sharedProjectDisabled = Boolean(
    !projectSharingPreferenceEnabled &&
    doc &&
    session &&
    doc.ownerUserId !== session.userId
  );
  // A read-only share has no build workspace to offer, so the mode switch is
  // pinned to View rather than presenting a Build mode that refuses every
  // edit. A shared-link session locks Build for its own reason: the visitor's
  // workspace is the parameters, and Make a copy is the road to Build.
  const buildModeDisabledReason = shareSession
    ? 'This is a shared link — Make a copy to open Build mode'
    : !sharedProjectDisabled &&
        cloudAvailable &&
        session &&
        projectSharingEnabled &&
        (collaboration.role === 'viewer' ||
          collaboration.status === 'read-only')
      ? 'This shared project is read-only'
      : null;
  // A parameter change is still a document edit, so a read-only seat locks
  // Tweak exactly as it locks Build. A shared link is the opposite: Tweak is
  // the whole point of the visit.
  const tweakModeDisabledReason = shareSession ? null : buildModeDisabledReason;
  // The stored preference resolves against what the project allows: a
  // read-only share pins the workspace to View whatever this device prefers,
  // and a shared link lands in Tweak unless the visitor chose View.
  const resolvedWorkspaceMode: WorkspaceMode = shareSession
    ? panelState.workspaceMode === 'view'
      ? 'view'
      : 'tweak'
    : buildModeDisabledReason !== null
      ? 'view'
      : panelState.workspaceMode;
  const viewMode = resolvedWorkspaceMode === 'view';
  const tweakMode = resolvedWorkspaceMode === 'tweak';
  // Both reading workspaces disarm every modeling surface — tools, handles,
  // sketches, the inspector. Tweak differs from View in one thing only: the
  // parameter guard below lets `parameter.set` commands through.
  const modelingLocked = viewMode || tweakMode;
  // Conditions that lock the document whatever workspace is showing. Tweak's
  // parameter edits answer to these too: a second tab or a read-only
  // collaboration seat locks parameters as firmly as features.
  const projectEditDisabledReason = projectOpenElsewhere
    ? 'This project is open in another tab'
    : shareSession
      ? // A shared-link session has no account seat, no lease and no second
        // tab: its edits live and die in this browser session.
        null
      : sharedProjectDisabled
        ? 'Project sharing is disabled in Settings'
        : !cloudAvailable || !session || !projectSharingEnabled
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
  // View mode joins the same guard every other modeling edit uses. Project
  // rename has its own mode-aware guard below because it is workspace metadata:
  // owners may change it from either mode, while editors remain Build-only.
  const editDisabledReason = projectOpenElsewhere
    ? projectEditDisabledReason
    : viewMode
      ? // "Switch to Build" is only advice worth giving to someone who can.
        // A read-only share pins the mode to View, so telling a viewer to
        // switch names a route they will find disabled — say why instead.
        (buildModeDisabledReason ??
        'View mode is read-only — switch to Build to edit')
      : tweakMode
        ? 'Tweak mode adjusts parameters only — switch to Build to edit'
        : projectEditDisabledReason;
  // The parameter guard: the same chain, except Tweak deliberately passes —
  // adjusting a published dimension is the one edit that workspace allows.
  const parameterEditDisabledReason = projectOpenElsewhere
    ? projectEditDisabledReason
    : viewMode
      ? (buildModeDisabledReason ??
        'View mode is read-only — switch to Tweak or Build to change parameters')
      : projectEditDisabledReason;
  const ownsOpenProject = Boolean(
    doc &&
    (doc.ownerUserId === session?.userId ||
      (!cloudAvailable && doc.ownerUserId === localUserId))
  );
  // Editors keep rename in the modeling workspace only; Tweak is a reading
  // workspace like View, so it stays owner-only too.
  const hasProjectRenameAccess =
    ownsOpenProject || (!modelingLocked && collaboration.role === 'editor');
  const projectRenameDisabledReason = !hasProjectRenameAccess
    ? 'Only the project owner can rename outside Build mode'
    : projectEditDisabledReason;
  const canRenameProject = projectRenameDisabledReason === null;

  // Read through a ref, because an async caller holds the closure of the
  // render it started in: a STEP import that spends minutes rebuilding and
  // archiving would otherwise check a permission that was current before View
  // mode was entered or the project was opened in a second tab.
  const editDisabledReasonRef = useRef(editDisabledReason);
  editDisabledReasonRef.current = editDisabledReason;
  const parameterEditDisabledReasonRef = useRef(parameterEditDisabledReason);
  parameterEditDisabledReasonRef.current = parameterEditDisabledReason;
  const projectRenameDisabledReasonRef = useRef(projectRenameDisabledReason);
  projectRenameDisabledReasonRef.current = projectRenameDisabledReason;

  function ensureCanEdit(action = 'edit this project'): boolean {
    const reason = editDisabledReasonRef.current;
    if (!reason) {
      return true;
    }
    setStatus(`Cannot ${action}: ${reason}.`);
    return false;
  }

  function ensureCanEditParameters(action = 'change this parameter'): boolean {
    const reason = parameterEditDisabledReasonRef.current;
    if (!reason) {
      return true;
    }
    setStatus(`Cannot ${action}: ${reason}.`);
    return false;
  }

  /**
   * Routes a batch of commands to the guard that governs it. A batch made
   * only of parameter sets is Tweak's whole vocabulary and passes in Tweak
   * mode; anything else needs the full editing guard. Deciding per batch at
   * the choke point means no caller — palette, keyboard, AI, panel — can
   * smuggle a feature edit through Tweak mode by pairing it with a
   * parameter change.
   */
  function ensureCanExecute(commands: AnyCommand[], action: string): boolean {
    const parametersOnly =
      commands.length > 0 &&
      commands.every((command) => command.kind === 'parameter.set');
    return parametersOnly
      ? ensureCanEditParameters(action)
      : ensureCanEdit(action);
  }

  function ensureCanRenameProject(): boolean {
    const reason = projectRenameDisabledReasonRef.current;
    if (!reason) {
      return true;
    }
    setStatus(`Cannot rename this project: ${reason}.`);
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
      remoteVersionsRef.current.set(restored.projectId, restored.version);
      const live = managerRef.current?.document;
      if (
        live &&
        (live.projectId !== document.projectId ||
          live.version !== document.version)
      ) {
        // The canonical document moved while the fenced write round-tripped.
        // Adopting the server echo now would erase those edits; record the
        // account version and let autosave carry the newer document up.
        await saveLastSyncedVersion(restored.projectId, restored.version);
        cloudProjectAutosaveRef.current?.adoptAccountVersion(
          restored.projectId,
          restored.version
        );
        setAccountConflict(null);
        setStatus('Kept this device’s version; a recovery copy was saved.');
        return;
      }
      await saveLocalProject(restored);
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
      middleDrag: appSettings.viewport.middleDrag,
      pointerNavigation: appSettings.viewport.pointerNavigation
    }));
  }, [appSettings]);

  useEffect(() => {
    // Resolves the theme setting to the palette actually painted. 'system'
    // tracks the host's preference live, so an OS appearance change mid-
    // session re-themes the chrome without a reload; an explicit choice
    // needs no listener. The 3D viewport keeps its dark stage either way —
    // only the chrome tokens switch (see theme/tokens.css).
    const root = globalThis.document.documentElement;
    const theme = appSettings.appearance.theme;
    if (theme !== 'system') {
      root.dataset.theme = theme;
      return;
    }
    const media = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    if (!media) {
      root.dataset.theme = 'dark';
      return;
    }
    const apply = () => {
      root.dataset.theme = resolvedAppTheme('system', media.matches);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [appSettings.appearance.theme]);

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
        if (status.state === 'repair' && status.projectId) {
          accountDocumentUnavailableProjectIdRef.current = status.projectId;
          setCloudAvailable(false);
          setStatus(
            'The account copy needs repair. Your work remains saved on this device; click Repair needed to retry.'
          );
        } else if (status.state === 'refused') {
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
        raiseAccountConflict(projectId, localDocument, accountVersion);
      },
      onSessionExpired() {
        remoteVersionsRef.current.clear();
        accountDocumentUnavailableProjectIdRef.current = null;
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
      enabled: cloudFunctionsEnabled && appSettings.files.cloudAutosave,
      idleDelayMs: appSettings.files.cloudAutosaveDelaySeconds * 1000
    });
  }, [
    appSettings.files.cloudAutosave,
    appSettings.files.cloudAutosaveDelaySeconds,
    cloudFunctionsEnabled
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
    if (
      !cloudFunctionsEnabled ||
      !projectId ||
      !session ||
      accountDocumentUnavailableProjectIdRef.current === projectId ||
      accountVersion === undefined
    ) {
      controller.closeProject();
      return;
    }
    controller.openProject(projectId, accountVersion);
  }, [cloudFunctionsEnabled, doc?.projectId, session]);

  /**
   * Exactly one tab writes a project's device storage.
   *
   * Autosave replaces the whole document under one key, so a second tab editing
   * the same project does not merge with the first — it overwrites it, and
   * whichever tab saved last wins with no record that the other's work existed.
   * The tab that does not hold the project opens read-only instead, and takes
   * over if the owner goes away.
   */
  useEffect(() => {
    const projectId = doc?.projectId ?? null;
    if (!projectId || shareSession) {
      // A shared-link session never writes device storage, so it has no
      // claim to make — and must not contest one. The owner opening their
      // own share link must not knock their real tab read-only.
      projectOwnershipSettledRef.current = null;
      setProjectOpenElsewhere(false);
      return;
    }
    let cancelled = false;
    let claim: ProjectOwnershipClaim | null = null;
    const settled = claimProjectOwnership(projectId, () => {
      if (cancelled) {
        return;
      }
      setProjectOpenElsewhere(false);
      void adoptStoredProject(projectId);
    }).then((result) => {
      if (cancelled) {
        result.release();
        return;
      }
      claim = result;
      setProjectOpenElsewhere(!result.owned);
      if (!result.owned) {
        // The project is on this device — the other tab is keeping it that
        // way. Nothing here is unsaved, and nothing here may be saved.
        setSaveState('local');
      }
    });
    projectOwnershipSettledRef.current = settled;
    return () => {
      cancelled = true;
      projectOwnershipSettledRef.current = null;
      claim?.release();
    };
  }, [doc?.projectId, shareSession]);

  useEffect(() => {
    // An armed face re-pick names a feature by id; a different project's
    // features must never satisfy it.
    setFaceRepair(null);
  }, [doc?.projectId]);

  useEffect(() => {
    // Read through the manager so the latch keys on the project alone: the
    // eligibility question is "did this project OPEN empty", which must not
    // re-evaluate as its first features arrive.
    const current = managerRef.current?.document;
    if (!current) {
      setTourProjectId(null);
      return;
    }
    setTourProjectId((previous) =>
      previous === current.projectId
        ? previous
        : listFeaturesInOrder(current).length === 0
          ? current.projectId
          : null
    );
  }, [doc?.projectId]);

  useEffect(() => {
    if (meshExportOpen) {
      setTourExportSeen(true);
    }
  }, [meshExportOpen]);

  /**
   * Last call before the tab goes away. `pagehide` is the only one of these
   * that fires reliably on mobile, and `visibilitychange` is the only one that
   * fires when a tab is merely backgrounded — which on a phone is usually the
   * last thing that happens before it is discarded.
   */
  useEffect(() => {
    const flush = () => {
      // The device write comes first and the account drain is chained behind
      // it: the controller only learns of an edit once the local save has
      // stored it, so draining the account copy first would miss an edit still
      // sitting in the 450 ms debounce and the tab would take it with it.
      // `keepalive` lets the account write started during teardown outlive
      // the page; without it the browser aborts the fetch with the document.
      void flushPendingLocalSaveRef
        .current()
        .then(() =>
          cloudProjectAutosaveRef.current?.flushPending({ keepalive: true })
        );
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
    if (!cloudFunctionsEnabled || !doc?.projectId || !session) {
      return;
    }
    let cancelled = false;

    async function check() {
      const controller = cloudProjectAutosaveRef.current;
      const current = managerRef.current?.document;
      if (cancelled || !controller || !current) {
        return;
      }
      // Asked on every tick rather than once when the effect was set up. Both
      // answers change without anything here changing with them: saving the
      // open project to the account makes it worth polling, and resolving a
      // conflict releases the controller that was holding it back.
      if (
        !shouldPollForFreshness({
          projectId: current.projectId,
          signedIn: Boolean(session),
          accountHoldsProject: remoteVersionsRef.current.has(current.projectId),
          awaitingResolution: controller.isHalted
        })
      ) {
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
      await saveLastSyncedVersion(remote.projectId, remote.version);
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
  }, [cloudFunctionsEnabled, doc?.projectId, session]);

  useEffect(() => {
    const controller = cloudSettingsAutosaveRef.current;
    const userId = session?.userId ?? null;
    if (!controller) {
      return;
    }
    if (!cloudFunctionsEnabled || !userId || !accountSettings) {
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
  }, [accountSettings, cloudFunctionsEnabled, session]);

  useEffect(() => {
    let cancelled = false;
    mark('startup.begin', { rememberedProject: Boolean(startupProjectId) });
    void (async () => {
      try {
        const [health, rememberedLocal, currentAuth] = await Promise.all([
          bootCloudFunctionsEnabledRef.current
            ? api.health().catch(() => null)
            : null,
          startupProjectId
            ? timedAsync('startup.localProject', () =>
                loadLocalProject(startupProjectId).catch(() => null)
              )
            : Promise.resolve(null),
          bootCloudFunctionsEnabledRef.current
            ? api
                .authConfig()
                .then((config) => ({
                  config,
                  status: 'ready' as const
                }))
                .catch(() => ({
                  config: null,
                  status: 'unavailable' as const
                }))
            : {
                config: null,
                status: 'unavailable' as const
              }
        ]);
        const activeSession = bootCloudFunctionsEnabledRef.current
          ? await timedAsync('startup.session', () =>
              api.session().catch(() => null)
            )
          : null;
        const [
          listed,
          rememberedRemoteResult,
          remoteSettings,
          collaborationCapabilities
        ] = await Promise.all([
          timedAsync('startup.projectList', () =>
            loadProjectSummaries(Boolean(activeSession))
          ),
          activeSession && startupProjectId
            ? loadAccountProjectResult(startupProjectId)
            : Promise.resolve<AccountProjectLoadResult>({
                document: null
              }),
          activeSession ? api.getSettings().catch(() => null) : null,
          activeSession
            ? api
                .collaborationCapabilities()
                .catch(() => DISABLED_COLLABORATION_ROLLOUT)
            : DISABLED_COLLABORATION_ROLLOUT
        ]);
        if (cancelled) {
          return;
        }
        setDeploymentHealth(health);
        const merged = listed.projects;
        const rememberedRemote = rememberedRemoteResult.document;
        const accountOwnsStartupProject = Boolean(
          startupProjectId && listed.cloudProjectIds.has(startupProjectId)
        );
        const accountDocumentNeedsRepair = Boolean(
          accountOwnsStartupProject &&
          isProjectDocumentUnavailableError(rememberedRemoteResult.error)
        );
        const accountDocumentLoadFailed = Boolean(
          accountOwnsStartupProject && rememberedRemoteResult.error
        );
        const restoredOutcome = chooseProjectDocument(
          rememberedLocal,
          rememberedRemote,
          startupProjectId
            ? await loadLastSyncedVersion(startupProjectId)
            : null
        );
        let restoredDocument =
          restoredOutcome.choice === 'none'
            ? null
            : restoredOutcome.choice === 'diverged'
              ? restoredOutcome.local
              : restoredOutcome.document;
        if (
          startupProjectId &&
          restoredOutcome.choice === 'remote' &&
          restoredDocument
        ) {
          restoredDocument = rememberedLocal
            ? withLocalDerived(restoredDocument, rememberedLocal)
            : restoredDocument;
          await saveLocalProject(restoredDocument);
          await saveLastSyncedVersion(
            restoredDocument.projectId,
            restoredDocument.version
          );
          if (cancelled) {
            return;
          }
        }
        const canUseCloud = Boolean(activeSession && rememberedRemote);
        accountDocumentUnavailableProjectIdRef.current =
          accountDocumentNeedsRepair && startupProjectId
            ? startupProjectId
            : null;
        setCollaborationRollout(collaborationCapabilities);
        if (rememberedRemote) {
          remoteVersionsRef.current.set(
            rememberedRemote.projectId,
            rememberedRemote.version
          );
        }
        setProjects(merged);
        setCloudProjectIds(listed.cloudProjectIds);
        setAccountProjectListReached(listed.remoteReached);
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
        setSaveState(
          !canUseCloud
            ? accountDocumentNeedsRepair
              ? 'repair'
              : accountDocumentLoadFailed
                ? 'offline'
                : 'local'
            : restoredOutcome.choice === 'diverged'
              ? 'conflict'
              : restoredOutcome.choice === 'local'
                ? 'syncing'
                : 'synced'
        );
        if (startupProjectId && restoredDocument) {
          hydrateDocument(restoredDocument);
          if (accountDocumentNeedsRepair) {
            setSaveState('repair');
            setStatus(
              `Reopened ${restoredDocument.name}. The account copy needs repair; your work remains saved on this device.`
            );
            return;
          }
          if (accountDocumentLoadFailed) {
            setSaveState('offline');
            setStatus(
              `Reopened ${restoredDocument.name}. The account copy is currently unreachable; your work remains saved on this device.`
            );
            return;
          }
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
          !bootCloudFunctionsEnabledRef.current
            ? `Offline mode · ${merged.length} local project(s)`
            : activeSession && listed.remoteReached
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
    if (shareSession) {
      // Shared-link tweaks are session-local by design: nothing is written
      // to this device until the visitor makes the model their own copy.
      setSaveState('local');
      return;
    }
    if (projectOpenElsewhereRef.current) {
      // Nothing here is on its way to storage, so the indicator must not claim
      // it is. The tab that owns the project is the one keeping it current.
      setSaveState('local');
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
  }, [doc, cloudAvailable, shareSession]);

  useEffect(() => {
    const projectId = doc?.projectId;
    if (!projectId) {
      setRestorableCheckpointIds(new Set());
      return;
    }
    const checkpoints = doc.checkpoints;
    let cancelled = false;
    void (async () => {
      const restorable = new Set(
        await listLocalSaveStateIds(projectId).catch(() => new Set<string>())
      );
      // The account holds save states this device never had — made on another
      // machine, or older than this device's own retention — so a project the
      // account knows is asked as well, and the two answers are merged.
      if (session && cloudProjectIds.has(projectId)) {
        const stored = await api
          .listRevisions(projectId)
          .then(
            (response) =>
              new Set(response.revisions.map((revision) => revision.revisionId))
          )
          .catch(() => null);
        for (const checkpoint of stored ? checkpoints : []) {
          if (stored?.has(checkpoint.revisionId)) {
            restorable.add(checkpoint.checkpointId);
          }
        }
      }
      if (!cancelled) {
        setRestorableCheckpointIds(restorable);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the checkpoint count rather than the array: every command
    // clones the document, so the array's identity changes on each edit and
    // depending on it would re-ask both stores — one of them over the
    // network — for every keystroke's worth of modelling. Checkpoints are
    // only ever appended, so a change in length is the only thing that can
    // change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.projectId, doc?.checkpoints.length, session, cloudProjectIds]);

  useEffect(() => {
    if (!doc || !session || !cloudProjectIds.has(doc.projectId)) {
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
  }, [cloudProjectIds, doc?.projectId, session]);

  useEffect(() => {
    geometry.sync(doc);
  }, [doc]);

  const features = useMemo<FeatureNode[]>(
    () => (doc ? listFeaturesInOrder(doc) : []),
    [doc]
  );
  const parameters = useMemo(() => (doc ? listParameters(doc) : []), [doc]);
  // What Tweak mode and a share link offer. An uncurated document offers
  // everything, so the rule lives in document-core rather than here — the
  // panel and the Build-mode toggles must never disagree about it.
  const exposedParameters = useMemo(
    () => (doc ? listExposedParameters(doc) : []),
    [doc]
  );
  const exposedParameterNames = useMemo(
    () => new Set(exposedParameters.map((parameter) => parameter.name)),
    [exposedParameters]
  );
  // Import sources that were never archived to the account. They gate the
  // sync indicator: a doc that references them is not fully "Synced".
  const localOnlySources = useMemo(
    () => (doc ? listLocalOnlyImportSources(doc) : []),
    [doc]
  );
  const presentedSaveState = presentedWorkspaceSaveState(
    saveState,
    localOnlySources.length
  );
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
   * Exact regeneration may assign a new topology ID to an edited face. Keep
   * selection attached through operation-specific immutable identity: exact
   * fillet evolution lineage, the translated source plane for offsets, or the
   * fixed axis for cylinder radii.
   */
  const renderedSelectedTopology = useMemo<TopologySelection | null>(() => {
    if (selectedTopology?.kind !== 'face') {
      return selectedTopology;
    }
    const body = renderedRepresentations[selectedTopology.bodyId];
    const faces = body?.topology?.faces ?? [];
    if (
      interaction.mode === 'face' &&
      interaction.op === 'edit-fillet' &&
      interaction.target.bodyId === selectedTopology.bodyId &&
      (interaction.target.filletFeatureId ||
        interaction.target.canResizeImportedBlend)
    ) {
      const sourceFace = representations[
        selectedTopology.bodyId
      ]?.topology?.faces.find(
        (face) => face.topologyId === selectedTopology.topologyId
      );
      const regenerated = sourceFace
        ? interaction.target.filletFeatureId
          ? resolveFilletBlendFace(faces, sourceFace)
          : resolveImportedBlendFace(
              faces,
              sourceFace,
              interaction.target.directEditFeatureId
            )
        : null;
      if (regenerated) {
        return {
          bodyId: selectedTopology.bodyId,
          kind: 'face',
          topologyId: regenerated.topologyId,
          hash: regenerated.hash,
          ...(regenerated.reference ? { reference: regenerated.reference } : {})
        };
      }
      return null;
    }
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
      interaction.mode === 'face' &&
      interaction.op === 'offset-face' &&
      interaction.target.bodyId === selectedTopology.bodyId &&
      renderedOffsetPreview !== null
    ) {
      const regenerated = resolveOffsetPreviewFace(
        faces,
        {
          point: {
            x: interaction.target.point[0],
            y: interaction.target.point[1],
            z: interaction.target.point[2]
          },
          normal: {
            x: interaction.target.normal[0],
            y: interaction.target.normal[1],
            z: interaction.target.normal[2]
          },
          ...(interaction.target.surfaceCenter
            ? {
                center: {
                  x: interaction.target.surfaceCenter[0],
                  y: interaction.target.surfaceCenter[1],
                  z: interaction.target.surfaceCenter[2]
                }
              }
            : {})
        },
        renderedOffsetPreview
      );
      if (regenerated) {
        return {
          bodyId: selectedTopology.bodyId,
          kind: 'face',
          topologyId: regenerated.topologyId,
          hash: regenerated.hash
        };
      }
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
  }, [
    interaction,
    representations,
    renderedOffsetPreview,
    renderedRepresentations,
    selectedTopology
  ]);
  const normalToFaceTarget = useMemo(() => {
    const selection = renderedSelectedTopology;
    if (selection?.kind !== 'face' || !selection.topologyId) {
      return null;
    }
    const body = renderedRepresentations[selection.bodyId];
    const face = body?.topology?.faces.find(
      (candidate) =>
        candidate.topologyId === selection.topologyId ||
        (selection.hash !== undefined && candidate.hash === selection.hash)
    );
    const geometry = face?.geometry;
    if (
      !body ||
      !face ||
      face.triangleCount <= 0 ||
      geometry?.surfaceType !== 'plane' ||
      !geometry.normal ||
      ![
        geometry.center.x,
        geometry.center.y,
        geometry.center.z,
        geometry.normal.x,
        geometry.normal.y,
        geometry.normal.z
      ].every(Number.isFinite) ||
      Math.hypot(geometry.normal.x, geometry.normal.y, geometry.normal.z) <
        1e-12
    ) {
      return null;
    }
    return {
      bodyId: body.bodyId,
      topologyId: face.topologyId,
      label: faceLabel(body, face.hash, face.topologyId)
    };
  }, [renderedRepresentations, renderedSelectedTopology]);
  // Warnings must describe what is actually on screen. While a preview is up the
  // viewport shows previewDoc's bodies, so showing the live document's warnings
  // would hide exactly the problems the preview exists to reveal.
  const warnings = (previewDoc ?? doc)?.derived.warnings ?? [];

  // Keyed on the derived body table, not the whole document: commands clone
  // the document but share `derived` by reference, so keying on `doc` gave
  // these arrays a new identity on every edit and made the viewport dispose
  // and re-upload every GPU buffer twice per command (once on the optimistic
  // document swap, again when the worker result landed) for identical
  // geometry.
  const liveBodyRepresentations = doc?.derived.bodyRepresentations ?? null;
  const viewerBodies = useMemo<BodyRepresentation[]>(
    () =>
      (previewDoc
        ? Object.values(renderedRepresentations)
        : liveBodyRepresentations
          ? Object.values(liveBodyRepresentations)
          : []
      ).filter((body) => !body.consumed && !hiddenBodyIds.has(body.bodyId)),
    [
      liveBodyRepresentations,
      previewDoc,
      renderedRepresentations,
      hiddenBodyIds
    ]
  );

  /**
   * Every body the model ends up with, hidden ones included — `viewerBodies`
   * drops those, and a parts list that loses a row when you hide it is a list
   * you cannot unhide from. Consumed bodies stay out: they are boolean
   * scaffolding, not parts.
   */
  const partBodies = useMemo<BodyRepresentation[]>(
    () =>
      (previewDoc
        ? Object.values(renderedRepresentations)
        : liveBodyRepresentations
          ? Object.values(liveBodyRepresentations)
          : []
      ).filter((body) => !body.consumed),
    [liveBodyRepresentations, previewDoc, renderedRepresentations]
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

  /**
   * What the current selection is, and the figure that goes with it.
   *
   * This stays a lightweight live readout. The measurement workbench records
   * explicit pick events below rather than coupling its history to selection
   * state effects.
   */
  const selectionSummary = useMemo<{
    label: readonly LabelSegment[];
    detail?: string;
  } | null>(() => {
    if (!doc || tool === 'sketch') {
      return null;
    }
    const units = doc.units;
    const round = (value: number) => Math.round(value * 100) / 100;
    if (selectedEdges.length > 1) {
      let sampled = false;
      const total = selectedEdges.reduce((sum, edge) => {
        const body = renderedRepresentations[edge.bodyId];
        const measured = edgeLengthMeasurement(
          body,
          edge.hash,
          edge.topologyId
        );
        sampled = sampled || measured?.quality === 'sampled';
        return sum + (measured?.value ?? 0);
      }, 0);
      const label = textLabelSegments(`${selectedEdges.length} edges`);
      const value =
        total > 0
          ? `${sampled ? '≈ ' : ''}${round(total)} ${units}`
          : undefined;
      return {
        label,
        detail: value
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
      const length = edgeLengthMeasurement(body, hash, topologyId);
      const label = topologySelectionLabelSegments(body, {
        kind: 'edge',
        hash,
        topologyId
      });
      const value =
        length && length.value > 0
          ? `${length.quality === 'sampled' ? '≈ ' : ''}${round(length.value)} ${units}`
          : undefined;
      return {
        label,
        detail: value
      };
    }
    if (renderedSelectedTopology?.kind === 'face') {
      const body = renderedRepresentations[renderedSelectedTopology.bodyId];
      // Through the shared fail-closed resolver rather than a local `find`, so
      // the chip cannot print a confident figure for a pick the measurement
      // tape is simultaneously refusing as ambiguous.
      const resolved = resolveFace(body, renderedSelectedTopology);
      const geometry = resolved.ok ? resolved.entry.geometry : undefined;
      if (
        geometry?.featureType === 'through-hole' &&
        geometry.diameter !== undefined
      ) {
        const value = `Ø ${round(geometry.diameter)} ${units}`;
        return {
          label: textLabelSegments('Through hole'),
          detail: value
        };
      }
      const label = topologySelectionLabelSegments(
        body,
        renderedSelectedTopology
      );
      // A cylinder is the other pick that carries a number of its own; every
      // other face kind has a name but nothing to measure yet.
      const cylinderDiameter =
        geometry?.surfaceType === 'cylinder' ? geometry.diameter : undefined;
      return {
        label,
        detail:
          cylinderDiameter !== undefined
            ? `Ø ${round(cylinderDiameter)} ${units}`
            : geometry?.area !== undefined
              ? `${round(geometry.area)} ${units}²`
              : undefined
      };
    }
    if (selectedBodyIds.length > 1) {
      return {
        label: textLabelSegments(`${selectedBodyIds.length} bodies`),
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
      const value = `${size.x} × ${size.y} × ${size.z} ${units}`;
      return {
        label: textLabelSegments(body.name),
        detail: value
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

  const selectionChip = useMemo(
    () =>
      selectionSummary
        ? { label: selectionSummary.label, detail: selectionSummary.detail }
        : null,
    [selectionSummary]
  );

  /** View-only measurement session. None of this enters document/history. */
  const [measuring, setMeasuring] = useState(false);
  const [measurementMode, setMeasurementMode] =
    useState<MeasurementMode>('smart');
  const [measurementDraft, setMeasurementDraft] =
    useState<MeasurementTarget | null>(null);
  /**
   * Edges accumulated by Shift+Click for a running total. Owned here rather
   * than read from `selectedEdges`, which is what let measuring rewrite the
   * workspace's selection; the rules live in `measureSession.ts`.
   */
  const [measurementEdgeRun, setMeasurementEdgeRun] = useState<
    readonly TopologySelection[]
  >(EMPTY_MEASURE_SESSION.edgeRun);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  /** Advances whenever a persisted list replaces the in-memory measurement list. */
  const [measurementRestoreGeneration, setMeasurementRestoreGeneration] =
    useState(0);
  const applyStoredMeasurements = useCallback((restored: Measurement[]) => {
    setMeasurements(restored);
    setMeasurementRestoreGeneration((current) => current + 1);
  }, []);
  const [activeMeasurementId, setActiveMeasurementId] = useState<string | null>(
    null
  );
  const [measurementUnit, setMeasurementUnit] = useState<UnitSystem>('mm');
  const [measurementPrecision, setMeasurementPrecision] = useState(2);
  const [radialDisplay, setRadialDisplay] = useState<RadialDisplay>('diameter');
  /**
   * The project whose stored list has been answered, including the answer
   * "none". Until this matches the open project, writes stay disabled: an
   * empty initial render must never outrun a slow read and erase the record it
   * was still loading.
   */
  const [measurementHydratedProjectId, setMeasurementHydratedProjectId] =
    useState<string | null>(null);
  const measurementDisplay = useMemo<MeasurementDisplayOptions>(
    () => ({
      unit: measurementUnit,
      precision: measurementPrecision,
      radialDisplay
    }),
    [measurementPrecision, measurementUnit, radialDisplay]
  );

  // A measurement session belongs to one open project, not the application.
  //
  // The list is cleared first and then restored from storage, so a project
  // with no stored measurements lands empty rather than inheriting the last
  // project's. The restore is deliberately not awaited before clearing: an
  // in-flight read for the PREVIOUS project must not be able to land on this
  // one, which the id check inside the effect prevents.
  useEffect(() => {
    setMeasurements([]);
    setActiveMeasurementId(null);
    clearMeasurementPicks();
    setMeasurementHydratedProjectId(null);
    if (!doc) {
      return;
    }
    const projectId = doc.projectId;
    setMeasurementUnit(doc.units);
    setMeasurementPrecision(2);
    setRadialDisplay('diameter');
    let cancelled = false;
    void loadProjectMeasurements(projectId)
      .then((record) => {
        if (cancelled) {
          return;
        }
        if (record) {
          applyStoredMeasurements(record.measurements);
          setMeasurementUnit(record.display.unit);
          setMeasurementPrecision(record.display.precision);
          setRadialDisplay(record.display.radialDisplay);
        }
        setMeasurementHydratedProjectId(projectId);
      })
      .catch(() => {
        // Leave writes disabled for this project. Besides unavailable storage,
        // this includes a record from a newer build: writing the empty v1 list
        // over fields this build refused to read would be the data loss the
        // parser's forward-version guard exists to prevent.
      });
    return () => {
      cancelled = true;
    };
  }, [applyStoredMeasurements, doc?.projectId]);

  /**
   * Writes the measurement list back, debounced.
   *
   * Coalesced rather than written per pick because a Shift+Click run rewrites
   * the list on every click, and an IndexedDB put per click would serialise
   * the whole list each time for a result that is superseded a moment later.
   */
  useEffect(() => {
    if (!doc || measurementHydratedProjectId !== doc.projectId) {
      return;
    }
    const projectId = doc.projectId;
    const timeout = window.setTimeout(() => {
      void saveProjectMeasurements(
        buildMeasurementRecord(
          projectId,
          measurements,
          measurementDisplay,
          new Date().toISOString()
        )
      ).catch(() => {
        // Same as the read: a device that cannot store them still measures.
      });
    }, 400);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    doc?.projectId,
    measurementHydratedProjectId,
    measurements,
    measurementDisplay
  ]);

  /**
   * The measurement library, loaded on first entry to View mode.
   *
   * It is roughly nine kilobytes of derivation, formatting and export that
   * only View mode can reach, and importing it at the top of this file put all
   * of it in the eager entry chunk — which the bundle budget guards precisely
   * because it is what every visitor downloads before anything renders. Types
   * are erased at build time, so `import type` above costs nothing; only the
   * runtime import is deferred.
   *
   * Every consumer below therefore has to tolerate `null` for the frame or two
   * between entering View mode and the chunk arriving. That is a real state
   * rather than a formality: a fast picker can click before it lands, and the
   * pick is dropped rather than half-handled.
   *
   * This is the interim shape. The measure seam replaces it with a session
   * that owns this state outright instead of App holding it at arm's length.
   */
  const [measurementApi, setMeasurementApi] = useState<
    typeof MeasurementModule | null
  >(null);

  useEffect(() => {
    if (!modelingLocked || measurementApi) {
      return;
    }
    let cancelled = false;
    void import('./lib/measurements').then((module) => {
      if (!cancelled) {
        setMeasurementApi(module);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [modelingLocked, measurementApi]);

  useEffect(() => {
    if (!doc || !exactGeometryReady || !measurementApi) {
      return;
    }
    // Stored rows and worker bodies can arrive in either order. Re-resolve on
    // each authoritative arrival even when the document revision is equal;
    // the library's default short-circuit remains intact for other callers.
    // Only the committed exact projection is authoritative here: previewDoc is
    // transient and must never rewrite the persisted list. Hidden bodies stay
    // included because visibility does not invalidate their measurements.
    const bodies = Object.values(representations).filter(
      (body) => !body.consumed
    );
    setMeasurements((current) =>
      measurementApi.refreshMeasurements(current, bodies, doc.version, {
        force: true
      })
    );
  }, [
    representations,
    doc?.version,
    exactGeometryReady,
    measurementApi,
    measurementRestoreGeneration
  ]);

  function recordMeasurement(measurement: Measurement) {
    // Checked before the state update rather than inside it, so the refusal can
    // be reported. The list is capped rather than self-trimming: dropping the
    // oldest row to make room is data loss nobody was told about.
    if (!measurementApi) {
      return;
    }
    if (!measurementApi.canAppendMeasurement(measurements, measurement)) {
      setStatus(measurementApi.MEASUREMENT_LIMIT_MESSAGE);
      return;
    }
    setMeasurements((current) =>
      measurementApi.appendMeasurement(current, measurement)
    );
    setActiveMeasurementId(measurement.id);
    setMeasurementDraft(null);
    setStatus(`${measurement.label} measured.`);
  }

  /**
   * What measuring this pick WOULD report, without recording anything.
   *
   * A tool that only answers after you commit makes you record a row to find
   * out whether you picked the right thing, then delete it. The preview runs
   * the SAME derivation the click will run rather than a cheaper estimate that
   * could disagree with the number that lands.
   *
   * Null when there is nothing honest to say, which includes an ambiguous
   * pick: a hover is not the place to explain ADR-011, and a silent absence
   * beats a confident wrong number.
   */
  function previewMeasurement(
    selection: TopologySelection,
    point?: { x: number; y: number; z: number }
  ): string | null {
    if (!doc || !modelingLocked || !measuring || !measurementApi) {
      return null;
    }
    const body = renderedRepresentations[selection.bodyId];
    if (!body) {
      return null;
    }
    if (measurementMode === 'smart') {
      const measurement = measurementApi.createSmartMeasurement(
        body,
        selection,
        point,
        doc.version,
        doc.units
      );
      return measurement
        ? measurementApi.formatMeasurement(measurement, measurementDisplay)
            .value
        : null;
    }
    const target = measurementApi.measurementTargetFromSelection(
      body,
      selection,
      point,
      measurementMode
    );
    if (!target?.point) {
      return null;
    }
    // The first of two picks has nothing to measure against yet, so it names
    // the target rather than guessing at a distance.
    if (!measurementDraft) {
      return target.label;
    }
    const measurement =
      measurementMode === 'distance'
        ? measurementApi.createDistanceMeasurement(
            measurementDraft,
            target,
            doc.version,
            doc.units
          )
        : measurementApi.createAngleMeasurement(
            measurementDraft,
            target,
            doc.version,
            doc.units
          );
    return measurement
      ? measurementApi.formatMeasurement(measurement, measurementDisplay).value
      : null;
  }

  /**
   * Abandons whatever pick was in progress: the two-pick draft and the running
   * edge total both. Not called after a measurement is recorded — a run has to
   * survive that, or a fourth Shift+Click could not extend a total of three.
   */
  function clearMeasurementPicks() {
    setMeasurementDraft(null);
    setMeasurementEdgeRun(EMPTY_MEASURE_SESSION.edgeRun);
  }

  /**
   * Measures a pick, and reports whether it consumed it.
   *
   * The return value is the point. This used to be called for its side effects
   * and fall straight through into sketch entry, direct manipulation, and the
   * selection update — so measuring an edge in View mode silently replaced
   * whatever a modelling session had selected, and the two features quietly
   * shared one piece of state.
   */
  function handleMeasurementPick(
    selection: TopologySelection,
    additive: boolean,
    detail?: PickDetail
  ): boolean {
    if (!doc || !modelingLocked || !measuring) {
      return false;
    }
    // One guard for the whole handler. Dropping a pick that lands before the
    // measurement chunk arrives is better than servicing half of it, and the
    // window is a frame or two on first entry to View mode only. It still
    // counts as consumed: falling through to selection would be the very
    // coupling this seam removes.
    if (!measurementApi) {
      setStatus('Measure is still loading. Try that pick again.');
      return true;
    }
    const body = renderedRepresentations[selection.bodyId];
    if (!body) {
      setStatus(
        'The selected body has no current exact projection to measure.'
      );
      return true;
    }
    const point = detail?.point;
    if (measurementMode === 'smart') {
      if (selection.kind === 'edge') {
        // The run lives in the measure session rather than in `selectedEdges`,
        // which is what let measuring rewrite the workspace's selection.
        const run = nextEdgeRun(measurementEdgeRun, selection, additive);
        setMeasurementEdgeRun(run);
        if (edgeRunIsTotalable(run)) {
          const total = measurementApi.createEdgeTotalMeasurement(
            viewerBodies,
            run,
            doc.version,
            doc.units
          );
          if (total) {
            recordMeasurement(total);
            return true;
          }
        }
      }
      const measurement = measurementApi.createSmartMeasurement(
        body,
        selection,
        point,
        doc.version,
        doc.units
      );
      if (measurement) {
        recordMeasurement(measurement);
      } else {
        setStatus(
          measurementApi.measurementSelectionFailure(body, selection) ??
            'That selection does not expose a trustworthy measurement.'
        );
      }
      return true;
    }
    const target = measurementApi.measurementTargetFromSelection(
      body,
      selection,
      point,
      measurementMode
    );
    if (!target?.point) {
      setStatus(
        measurementApi.measurementSelectionFailure(body, selection) ??
          (measurementMode === 'angle'
            ? 'Angle needs a straight edge, circular axis, or measured face direction.'
            : 'That selection does not expose a trustworthy measurement point.')
      );
      return true;
    }
    if (!measurementDraft) {
      setMeasurementDraft(target);
      setStatus(`${target.label} selected · pick the second target.`);
      return true;
    }
    const measurement =
      measurementMode === 'distance'
        ? measurementApi.createDistanceMeasurement(
            measurementDraft,
            target,
            doc.version,
            doc.units
          )
        : measurementApi.createAngleMeasurement(
            measurementDraft,
            target,
            doc.version,
            doc.units
          );
    if (measurement) {
      recordMeasurement(measurement);
    } else {
      setStatus(
        measurementMode === 'angle'
          ? 'Those targets do not provide two stable directions; the first target is still selected.'
          : 'Those targets could not produce a stable distance; the first target is still selected.'
      );
    }
    return true;
  }

  const measurementAnnotations = useMemo<
    MeasurementViewportAnnotation[]
  >(() => {
    if (!measurementApi) {
      return [];
    }
    const pinned = measurements.flatMap((measurement) => {
      const annotation = measurementApi.measurementToViewportAnnotation(
        measurement,
        measurementDisplay,
        measurement.id === activeMeasurementId
      );
      return annotation ? [annotation] : [];
    });
    return measurementDraft?.point
      ? [
          ...pinned,
          {
            id: 'measurement-draft',
            label: `A · ${measurementDraft.semantic.replaceAll('-', ' ')}`,
            selected: true,
            status: 'current' as const,
            // The first of two picks marks a point; there is no second point
            // to span to until it lands.
            graphic: 'anchor' as const,
            anchor: measurementDraft.point,
            segments: []
          }
        ]
      : pinned;
  }, [
    activeMeasurementId,
    measurementDisplay,
    measurementDraft,
    measurements,
    measurementApi
  ]);
  const formattedMeasurements = useMemo(
    () =>
      measurementApi
        ? Object.fromEntries(
            measurements.map((measurement) => [
              measurement.id,
              measurementApi.formatMeasurement(measurement, measurementDisplay)
            ])
          )
        : {},
    [measurementDisplay, measurements, measurementApi]
  );

  async function copyMeasurements(measurement?: Measurement) {
    const selected = measurement ? [measurement] : measurements;
    if (selected.length === 0 || !measurementApi) {
      return;
    }
    try {
      await navigator.clipboard.writeText(
        measurementApi.measurementsToText(selected, measurementDisplay)
      );
      setStatus(
        `Copied ${selected.length} measurement${selected.length === 1 ? '' : 's'}.`
      );
    } catch {
      setStatus('Could not reach the clipboard. Export CSV instead.');
    }
  }

  function exportMeasurements() {
    if (!doc || measurements.length === 0 || !measurementApi) {
      return;
    }
    const fileName = `${exportFileStem(doc.name)}.measurements.csv`;
    downloadText(
      fileName,
      `${measurementApi.measurementsToCsv(measurements, measurementDisplay)}\n`,
      'text/csv'
    );
    setStatus(`Exported ${measurements.length} measurements to ${fileName}.`);
  }

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

  // The viewport installs and tears down real scene objects when these props
  // change identity, so each one is memoized rather than built inline: a fresh
  // `[]` or `.map()` on every render re-arms the sketch overlay, region state,
  // and extrude-preview effects — during a drag, once per pointer event.
  const viewerSketches = useMemo(
    () =>
      // Region-based rendering (sketchViews) supersedes the legacy
      // single-profile overlays under direct manipulation.
      appSettings.experiments.directManipulation
        ? EMPTY_SKETCH_OVERLAYS
        : sketchOverlays,
    [appSettings.experiments.directManipulation, sketchOverlays]
  );
  const viewerEditableBodyIds = useMemo(
    () => (modelingLocked ? EMPTY_BODY_IDS : directEditableBodyIds),
    [modelingLocked, directEditableBodyIds]
  );
  const viewerSelectedProfileIds = useMemo(
    () => selectedProfiles.map((profile) => profile.profileId),
    [selectedProfiles]
  );

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
        middleDrag: appSettings.viewport.middleDrag,
        pointerNavigation: appSettings.viewport.pointerNavigation
      });
    }
    if (rememberProject) {
      rememberActiveProject(normalized.projectId);
    }
    managerRef.current = new CommandManager(normalized);
    geometry.invalidate();
    setDoc(normalized);
    setPreviewDoc(null);
    setSelectedFeatureNode(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(null);
    setSelectedProfiles([]);
    setExtrudePreview(null);
    setMoveCommitHold(null);
    setTool(null);
  }

  /**
   * Picks up a project this tab had open read-only, once the tab that owned it
   * has gone. A read-only tab has no edits of its own to weigh, so whatever is
   * stored is unambiguously the version to continue from.
   */
  async function adoptStoredProject(projectId: string) {
    const stored = await loadLocalProject(projectId).catch(() => null);
    const current = managerRef.current?.document;
    if (
      !stored ||
      !current ||
      stored.projectId !== current.projectId ||
      stored.version === current.version
    ) {
      return;
    }
    hydrateDocument(stored, { restoreView: false, rememberProject: false });
    setStatus('Editing this project here now.');
  }

  async function flushPendingLocalSave() {
    if (localSaveTimeoutRef.current !== null) {
      window.clearTimeout(localSaveTimeoutRef.current);
      localSaveTimeoutRef.current = null;
    }
    if (shareSessionRef.current) {
      // Belt to the autosave effect's braces: a shared-link document must
      // never reach this device's project store under the owner's id.
      pendingLocalSaveRef.current = null;
      return;
    }
    const pending = pendingLocalSaveRef.current;
    pendingLocalSaveRef.current = null;
    // The debounce can come due before the claim has been answered. Writing on
    // the strength of not having heard "no" yet is the overwrite this is here
    // to prevent, so wait for the answer rather than assume it.
    await projectOwnershipSettledRef.current;
    if (projectOpenElsewhereRef.current) {
      // Another tab owns this project's storage. Its copy is the one being
      // kept up to date; writing here would land on top of it.
      setSaveState('local');
      return;
    }
    if (!pending) {
      return;
    }
    try {
      await saveLocalProject(pending);
      if (
        accountDocumentUnavailableProjectIdRef.current === pending.projectId
      ) {
        setSaveState('repair');
        return;
      }
      // The device write is the save; the account copy follows on its own
      // schedule. Handing the document over here rather than from the edit
      // effect means nothing is ever queued for the account that this device
      // has not already stored.
      const controller = cloudProjectAutosaveRef.current;
      if (!controller) {
        setSaveState(cloudAvailable ? 'synced' : 'local');
      } else if (controller.holdsDocument(pending)) {
        // An adoption, not an edit: the account already has this exact
        // version, so there is nothing to mirror back.
        setSaveState('synced');
      } else {
        controller.schedule(pending);
      }
    } catch {
      // The document goes back in the queue rather than on the floor. It was
      // taken out of the ref above so a write that LANDS is not repeated, but a
      // write that did not land leaves this closure holding the only copy of
      // those edits — and simply returning loses them outright.
      const repark = reparkFailedAutosave({
        pending,
        queued: pendingLocalSaveRef.current
      });
      if (repark) {
        pendingLocalSaveRef.current = repark;
      }
      setSaveState('offline');
      setStatus(LOCAL_AUTOSAVE_FAILED_STATUS);
    }
  }

  flushPendingLocalSaveRef.current = flushPendingLocalSave;

  function handleViewportChange(camera: ViewportCameraState) {
    updateCameraPose(doc?.projectId ?? null, camera);
  }

  function handleViewportSettled(camera: ViewportCameraState) {
    persistCameraPose(doc?.projectId ?? null, camera);
  }

  /**
   * Backfills kernel-proven v5 references onto legacy hash-only fillet and
   * chamfer features. A closed-edge hash embeds its length, so the only
   * moment a legacy feature can be upgraded is while its stored hashes still
   * resolve — right after the clean rebuild that carried these repairs.
   * Applied as a normalization: it persists and syncs like an edit without
   * stealing an undo step from the user.
   */
  function applyEdgeReferenceRepairs(
    repairs: ProjectDocument['derived']['referenceRepairs']
  ): void {
    const manager = managerRef.current;
    if (!manager || !repairs?.length || editDisabledReason) {
      return;
    }
    try {
      for (const repair of repairs) {
        manager.normalize(
          commandFactories.updateFeature(
            {
              featureId: repair.featureId,
              data: { edgeReferences: repair.edgeReferences }
            },
            'Repair edge references'
          )
        );
      }
      setDoc(manager.document);
    } catch {
      // A failed repair leaves the document exactly as it was; the legacy
      // hash resolver keeps working at the current geometry.
    }
  }

  function executeCommand(
    command: AnyCommand,
    derived?: ProjectDocument['derived'],
    permission: 'edit' | 'rename' = 'edit'
  ): boolean {
    if (
      !managerRef.current ||
      !(permission === 'rename'
        ? ensureCanRenameProject()
        : ensureCanExecute([command], 'run this command'))
    ) {
      return false;
    }
    try {
      setPreviewDoc(null);
      let next = managerRef.current.execute(command);
      if (derived) {
        // Validation already rebuilt this exact result; attaching it now
        // renders the new geometry in the same batch instead of flashing the
        // stale meshes until the broadcast rebuild echoes back.
        next = managerRef.current.commitDerivedState(derived);
        setMoveCommitHold(null);
      }
      setDoc(next);
      setStatus(command.label);
      return true;
    } catch (error) {
      setStatus(errorMessage(error, 'Command failed.'));
      return false;
    }
  }

  function executeTransaction(
    label: string,
    commands: AnyCommand[],
    derived?: ProjectDocument['derived']
  ): boolean {
    if (
      !managerRef.current ||
      commands.length === 0 ||
      !ensureCanExecute(commands, 'apply this edit')
    ) {
      return false;
    }
    try {
      setPreviewDoc(null);
      let next = managerRef.current.runTransaction(label, commands);
      if (derived) {
        next = managerRef.current.commitDerivedState(derived);
        setMoveCommitHold(null);
      }
      setDoc(next);
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
    setSelectedFeatureNode(null);
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

  function updateExtrudeDistance(distance: number) {
    if (!Number.isFinite(distance)) {
      return;
    }
    setResolvedExtrudePreview(null);
    setExtrudePreview((current) =>
      current ? { ...current, distance } : current
    );
  }

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
    setSelectedFeatureNode(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(sketchId);
    setSelectedProfiles(initialProfiles);
    setResolvedExtrudePreview(null);
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
        ? `${initialProfiles.length} profile${initialProfiles.length === 1 ? '' : 's'} selected · exact preview updating.`
        : `Select one or more closed profiles · ${available.length} valid profiles available.`
    );
  }

  async function confirmExtrude() {
    if (
      !extrudePreview ||
      !resolvedExtrudePreview ||
      selectedProfiles.length === 0 ||
      Math.abs(extrudePreview.distance) < 0.1
    ) {
      setStatus(
        resolvedExtrudePreview
          ? 'Drag the extrusion arrow away from the sketch plane first.'
          : 'Wait for exact overlap inference to finish.'
      );
      return;
    }
    const manager = managerRef.current;
    if (
      !manager ||
      manager.document.version !== resolvedExtrudePreview.baseVersion
    ) {
      setResolvedExtrudePreview(null);
      profileExtrudePreview.request(extrudePreview.distance);
      setStatus(
        'The document changed; refreshing exact extrusion inference before applying.'
      );
      return;
    }
    const resolvedInput = resolvedExtrudePreview.command.payload;
    const command = commandFactories.extrudeSketch({
      ...resolvedInput,
      name: `Extrude ${features.filter((feature) => feature.featureKind === 'extrude').length + 1}`,
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
      `Created ${resolvedExtrudePreview.inference.operation} extrusion ${extrudePreview.distance > 0 ? 'above' : 'below'} the sketch plane.`,
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
    setResolvedExtrudePreview(null);
    setPreviewDoc(null);
    setSelectedProfiles([]);
    setSelectedSketchProfileId(null);
    setTool(null);
    extrudeSketchReturnRef.current = null;
    extrudeSelectionReturnRef.current = null;
    selectFeatureNode(createdFeature?.id ?? null, 'pinned');
    setSelectedBodyIds(createdFeature?.bodyId ? [createdFeature.bodyId] : []);
    setStatus(`Created ${createdFeature?.name ?? 'extrusion'}.`);
  }

  async function createInferredExtrude(input: ExtrudeInput) {
    const manager = managerRef.current;
    if (!manager) {
      return;
    }
    const base = manager.document;
    setBusy(true);
    setStatus('Inferring the extrusion operation with the exact kernel…');
    let resolved: ResolvedExtrude;
    try {
      resolved = await resolveExtrudeOperation({
        base,
        input,
        derive: (document) => geometry.syncOnce(document)
      });
    } catch (error) {
      setStatus(errorMessage(error, 'Extrusion inference failed.'));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (
      managerRef.current !== manager ||
      manager.document.version !== base.version
    ) {
      setStatus('The document changed while extrusion inference was running.');
      return;
    }
    const command = commandFactories.extrudeSketch({
      ...resolved.command.payload,
      name: input.name
    });
    const bodyId = command.payload.ids?.bodyId;
    if (!bodyId) {
      setStatus('Extrude could not reserve a result body.');
      return;
    }
    await executeValidatedDirectEdit(
      command,
      bodyId,
      `Created ${resolved.inference.operation} extrusion.`,
      typeof input.distance === 'number' ? input.distance : 0,
      finishFeatureCreation
    );
  }

  function launchTool(nextTool: ToolId) {
    const reason = toolDisabledReason(nextTool, availability);
    if (reason) {
      setStatus(`${TOOL_META[nextTool].label}: ${reason}.`);
      return;
    }
    setFeatureFormError(null);
    // A toolbar command owns the next gesture. Preserve the body selection
    // that pre-fills Move/boolean forms, but disarm any selection-first face or
    // edge handle so two manipulators can never claim the same pointer.
    if (interaction.mode !== 'idle') {
      cancelDirectManipulationRef.current?.();
      cylinderRadiusPreview.clear();
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
        setSelectedFeatureNode(null);
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
      // WF-07 (resolved): Move used to be two UIs for one command, and which
      // one you got was decided by document state rather than by what you
      // asked for — the gizmo had a live preview, the form had a Name field
      // and a body picker, and they committed through differently labelled
      // buttons. The gizmo now carries both, so it is the only Move UI. With
      // nothing selected in a multi-body document it opens on the first body
      // and the picker changes it, which is what the form's picker was for.
      // `.at(-1)`, not `[0]`: the retired form defaulted to the last live body
      // — the one you most likely just made — and changing which body an
      // unselected Move lands on would silently rewrite existing flows.
      const targetBodyId =
        selectedBodyIds.at(-1) ?? viewerBodies.at(-1)?.bodyId ?? null;
      if (targetBodyId) {
        setMoveName('Move');
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
      nextTool === 'split' ||
      nextTool === 'hole' ||
      nextTool === 'shell' ||
      nextTool === 'solid-offset' ||
      nextTool === 'draft' ||
      nextTool === 'thicken'
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
    setFeatureFormError(null);
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
    setSelectedFeatureNode(null);
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
   * Switches workspaces. Leaving Build tears down whatever gesture was in
   * flight first: a sketch or an extrude preview whose panel is about to be
   * unmounted would otherwise keep owning the pointer with nothing on screen
   * to cancel it from.
   */
  function handleWorkspaceMode(mode: WorkspaceMode) {
    if (mode === 'view' || mode === 'tweak') {
      cancelDirectManipulationRef.current?.();
      cylinderRadiusPreview.clear();
      edgePreview.clear();
      setKeypad(null);
      dispatchInteraction({ type: 'clear' });
      cancelPanel();
      setStatus(
        mode === 'view'
          ? 'View mode · the model is read-only here.'
          : 'Tweak mode · adjust parameters; the design stays locked.'
      );
    } else {
      // The tape survives the trip — leaving to make an edit and coming back
      // should not cost the figures you just took — but recording stops.
      setMeasuring(false);
      setStatus('Build mode · modeling tools are back.');
    }
    setWorkspaceMode(mode);
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

  /**
   * A settled move drag, not a live one: the viewport streams the in-progress
   * values straight to the panel, and calls this once when the gesture ends.
   */
  const handleMovePreviewChange = useCallback(
    (
      translation: MovePreview['translation'],
      rotationDeg: MovePreview['rotationDeg'],
      snap: MoveSnap
    ) => {
      setMoveSnap(snap);
      setMovePreview((current) =>
        current ? { ...current, translation, rotationDeg } : current
      );
    },
    []
  );

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
        // Whatever the gizmo's Name field holds, falling back to the default
        // rather than committing a feature with a blank name.
        name: moveName.trim() || 'Move',
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
    setSelectedFeatureNode(null);
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

  function requestNormalToSelectedFace() {
    if (!normalToFaceTarget) {
      setStatus('Normal view requires an exact planar face selection.');
      return;
    }
    setNormalToFaceRequest({
      bodyId: normalToFaceTarget.bodyId,
      topologyId: normalToFaceTarget.topologyId,
      nonce: ++viewNonceRef.current
    });
    setStatus(`${normalToFaceTarget.label}: viewing normal to face.`);
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

  /**
   * The live model's extent along the axis a section plane slides on, so the
   * offset slider spans exactly the geometry it can cut. Null with no bodies.
   */
  function sectionAxisRange(
    plane: SectionPlaneId
  ): { min: number; max: number } | null {
    const axis = plane === 'XY' ? 'z' : plane === 'XZ' ? 'y' : 'x';
    let min = Infinity;
    let max = -Infinity;
    for (const body of Object.values(doc?.derived.bodyRepresentations ?? {})) {
      if (body.consumed) {
        continue;
      }
      min = Math.min(min, body.bbox.min[axis]);
      max = Math.max(max, body.bbox.max[axis]);
    }
    return min < max ? { min, max } : null;
  }

  /** Off → XY → XZ → YZ → off, each plane starting at the model's centre. */
  function cycleSectionView() {
    const order: (SectionPlaneId | null)[] = [null, 'XY', 'XZ', 'YZ'];
    const currentPlane = viewerSettings.sectionView?.plane ?? null;
    const next = order[(order.indexOf(currentPlane) + 1) % order.length]!;
    if (!next) {
      setViewerSettings(({ sectionView: _cleared, ...rest }) => rest);
      setStatus('Section view off.');
      return;
    }
    const range = sectionAxisRange(next);
    const offset = range ? (range.min + range.max) / 2 : 0;
    setViewerSettings((current) => ({
      ...current,
      sectionView: { plane: next, offset }
    }));
    setStatus(
      `Section view: ${next} plane. Drag the slider to move the cut; the model itself is untouched.`
    );
  }

  function setSectionOffset(offset: number) {
    setViewerSettings((current) =>
      current.sectionView
        ? { ...current, sectionView: { ...current.sectionView, offset } }
        : current
    );
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

  function previewBodyAppearance(preview: BodyAppearancePreview | null) {
    setBodyAppearancePreview(preview);
  }

  function commitBodyAppearance(
    bodyId: BodyId,
    appearance: { color?: string; opacity?: number | null }
  ) {
    if (!doc) {
      return;
    }
    const bodyNode = findBodyNode(doc, bodyId);
    if (!bodyNode) {
      return;
    }
    const metadata: Record<string, string | number | null> = {};
    if (appearance.color !== undefined) {
      metadata[BODY_COLOR_METADATA_KEY] = appearance.color;
    }
    if (appearance.opacity !== undefined) {
      // null deletes the key, returning the body to fully opaque.
      metadata[BODY_OPACITY_METADATA_KEY] = appearance.opacity;
    }
    if (Object.keys(metadata).length === 0) {
      return;
    }
    // The drag-phase preview has already shown this value; clearing it before
    // the commit lets the rebuild arrive as the new committed look.
    setBodyAppearancePreview(null);
    executeCommand(
      commandFactories.setNodeMetadata(
        { nodeId: bodyNode.id, metadata },
        `Set ${bodyNode.name} appearance`
      )
    );
  }

  function showAllBodies() {
    setHiddenBodyIds(new Set());
    setStatus('All bodies visible.');
  }

  /**
   * Hides every part except one. Running it again on the part already alone on
   * screen brings the rest back, so the same control both enters and leaves the
   * isolated view rather than stranding someone with everything hidden.
   */
  function isolateBody(bodyId: string) {
    const others = partBodies.filter((body) => body.bodyId !== bodyId);
    const alreadyAlone = others.every((body) => hiddenBodyIds.has(body.bodyId));
    if (alreadyAlone) {
      showAllBodies();
      return;
    }
    setHiddenBodyIds(new Set(others.map((body) => body.bodyId)));
    const name = partBodies.find((body) => body.bodyId === bodyId)?.name;
    setStatus(
      `Showing ${name ?? 'one body'} only · ${others.length} hidden. Isolate again to show all.`
    );
  }

  function handleAppSettingsChange(next: AppSettings) {
    appSettingsRef.current = next;
    setAppSettings(next);
    const controller = cloudSettingsAutosaveRef.current;
    if (cloudFunctionsEnabledRef.current && controller) {
      controller.schedule(next);
    } else {
      syncedRevisionRef.current = null;
      saveLocalAppSettings(next, null);
    }
    if (
      cloudFunctionsEnabledRef.current &&
      sessionRef.current &&
      accountSettingsRef.current
    ) {
      setSettingsMessage('Saved on this device · saving to cloud profile…');
    } else {
      setSettingsMessage('Saved on this device.');
    }
  }

  function handleCloudFunctionsEnabledChange(next: boolean) {
    if (next === cloudFunctionsEnabledRef.current) {
      return;
    }
    // Flip the transport gate before React can render another cloud consumer.
    // This also aborts active browser API and assistant fetches when going off.
    setCloudFunctionsEnabled(next);
    cloudFunctionsEnabledRef.current = next;
    setCloudFunctionsEnabledState(next);

    if (next) {
      setSettingsMessage('Cloud features enabled · reconnecting…');
      setStatus('Cloud features enabled · reconnecting…');
      void refreshCloudConnection();
      return;
    }

    cloudProjectAutosaveRef.current?.configure({ enabled: false });
    cloudProjectAutosaveRef.current?.closeProject();
    cloudSettingsAutosaveRef.current?.endSession();
    cloudSettingsSessionUserRef.current = null;
    remoteVersionsRef.current.clear();
    accountDocumentUnavailableProjectIdRef.current = null;
    sessionRef.current = null;
    accountSettingsRef.current = null;
    setSession(null);
    setAccountSettings(null);
    setAuthConfig(null);
    setAuthConfigStatus('unavailable');
    setDeploymentHealth(null);
    setCollaborationRollout(DISABLED_COLLABORATION_ROLLOUT);
    setCloudAvailable(false);
    setCloudProjectIds(new Set());
    setAccountProjectListReached(false);
    setArtifacts([]);
    setSharingOpen(false);
    setAccountConflict(null);
    setSyncRun(null);
    setSaveState('local');
    setSettingsMessage(
      'Offline mode active · cloud functions are disabled on this device.'
    );
    setStatus('Offline mode · work is saved on this device.');
    void loadProjectSummaries(false)
      .then((listed) => {
        if (!cloudFunctionsEnabledRef.current) {
          setProjects(listed.projects);
        }
      })
      .catch(() => undefined);
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
    void clearAllLastSyncedVersions().catch(() => {
      setStatus(
        'Could not clear this account’s sync baselines. Check which copy you keep if this project is opened again on this device.'
      );
    });
    sessionRef.current = null;
    accountSettingsRef.current = null;
    setSession(null);
    setAccountSettings(null);
    setCollaborationRollout(DISABLED_COLLABORATION_ROLLOUT);
  }

  async function refreshCloudConnection() {
    if (!cloudFunctionsEnabledRef.current) {
      return;
    }
    setAuthConfigStatus('loading');
    void api
      .health()
      .then(setDeploymentHealth)
      .catch(() => setDeploymentHealth(null));
    const [nextAuth, activeSession] = await Promise.all([
      api
        .authConfig()
        .then((config) => ({ config, status: 'ready' as const }))
        .catch(() => ({ config: null, status: 'unavailable' as const })),
      api.session().catch(() => null)
    ]);
    if (!cloudFunctionsEnabledRef.current) {
      return;
    }
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
    setCollaborationRollout(DISABLED_COLLABORATION_ROLLOUT);
    try {
      const [remoteSettings, collaborationCapabilities] = await Promise.all([
        api.getSettings(),
        api
          .collaborationCapabilities()
          .catch(() => DISABLED_COLLABORATION_ROLLOUT)
      ]);
      if (!cloudFunctionsEnabledRef.current) {
        return;
      }
      accountSettingsRef.current = remoteSettings;
      setAccountSettings(remoteSettings);
      setCollaborationRollout(collaborationCapabilities);
      const listed = await loadProjectSummaries(true);
      if (!cloudFunctionsEnabledRef.current) {
        return;
      }
      setProjects(listed.projects);
      setCloudProjectIds(listed.cloudProjectIds);
      setAccountProjectListReached(listed.remoteReached);
      setSettingsMessage('Cloud profile connected.');
      setStatus(`Cloud profile ready · ${listed.projects.length} project(s)`);
    } catch {
      if (cloudFunctionsEnabledRef.current) {
        setSettingsMessage(
          'Cloud profile unavailable · device settings remain active.'
        );
      }
    }
  }

  function openSettings() {
    updateSettingsViewState({ open: true });
    setSettingsOpen(true);
    setPaletteOpen(false);
    if (!cloudFunctionsEnabledRef.current) {
      setSettingsMessage(
        'Offline mode active · cloud functions are disabled on this device.'
      );
      setAuthConfigStatus('unavailable');
      return;
    }
    setSettingsMessage('Changes save on this device immediately.');
    void refreshCloudConnection();
  }

  function closeSettings() {
    updateSettingsViewState({ open: false });
    setSettingsOpen(false);
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

  async function activateCloudSession(activeSession: AuthSession) {
    const [remoteSettings, listed, collaborationCapabilities] =
      await Promise.all([
        api.getSettings(),
        loadProjectSummaries(true),
        api
          .collaborationCapabilities()
          .catch(() => DISABLED_COLLABORATION_ROLLOUT)
      ]);
    sessionRef.current = activeSession;
    setSession(activeSession);
    accountSettingsRef.current = remoteSettings;
    setAccountSettings(remoteSettings);
    setCollaborationRollout(collaborationCapabilities);
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
    setAccountProjectListReached(listed.remoteReached);
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
    const localOnly = listed.remoteReached
      ? listed.projects.filter(
          (project) => !listed.cloudProjectIds.has(project.projectId)
        ).length
      : 0;
    setSettingsMessage(
      !listed.remoteReached
        ? `Signed in as ${activeSession.email ?? activeSession.displayName} · cloud projects are temporarily unavailable.`
        : localOnly === 0
          ? `Signed in as ${activeSession.email ?? activeSession.displayName}.`
          : `Signed in as ${activeSession.email ?? activeSession.displayName} · ${localOnly} project(s) on this device only.`
    );
  }

  async function handleVerifyLoginCode(challengeId: string, code: string) {
    setSettingsBusy(true);
    setSettingsMessage('Verifying sign-in code…');
    try {
      const activeSession = await api.verifyEmailLogin({
        challengeId,
        code
      });
      await activateCloudSession(activeSession);
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Sign-in failed.'));
      throw error;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleStartDesktopLogin() {
    setSettingsBusy(true);
    setSettingsMessage('Opening secure sign-in in your browser…');
    let authorized = false;
    try {
      const started = await startDesktopSignIn();
      const deadline = Date.now() + started.expiresInSeconds * 1_000;
      setSettingsMessage(
        `Finish the email sign-in in your browser, then enter desktop code ${started.userCode}. OpenZCAD will reconnect automatically.`
      );
      while (Date.now() < deadline) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
        const result = await pollDesktopSignIn();
        if (result.status === 'authorized' && result.session) {
          await activateCloudSession(result.session as AuthSession);
          authorized = true;
          return;
        }
      }
      throw new Error('The desktop sign-in attempt expired. Start again.');
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Desktop sign-in failed.'));
      throw error;
    } finally {
      if (!authorized) {
        await cancelDesktopSignIn().catch(() => undefined);
      }
      setSettingsBusy(false);
    }
  }

  async function handleApproveDesktopLogin() {
    if (!desktopAuthorizationAttempt) {
      throw new Error('The desktop sign-in attempt is missing.');
    }
    setSettingsBusy(true);
    setSettingsMessage('Connecting OpenZCAD for macOS…');
    try {
      await api.approveDesktopLogin(
        desktopAuthorizationAttempt,
        desktopAuthorizationCode
      );
      setDesktopAuthorizationApproved(true);
      setSettingsMessage(
        'OpenZCAD for macOS is connected. You can return to the app.'
      );
    } catch (error) {
      setSettingsMessage(
        errorMessage(error, 'Could not connect OpenZCAD for macOS.')
      );
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
      accountDocumentUnavailableProjectIdRef.current = null;
      cloudSettingsAutosaveRef.current?.endSession();
      cloudSettingsSessionUserRef.current = null;
      // The next sign-in on this device may be a different account. Awaited so
      // it cannot be cut short by whatever navigation follows sign-out, and a
      // failure is reported rather than left for a later reconciliation to
      // resolve against a baseline belonging to the account that just left.
      let baselinesCleared = true;
      try {
        await clearAllLastSyncedVersions();
      } catch {
        baselinesCleared = false;
      }
      sessionRef.current = null;
      setSession(null);
      accountSettingsRef.current = null;
      setAccountSettings(null);
      setCollaborationRollout(DISABLED_COLLABORATION_ROLLOUT);
      setCloudAvailable(false);
      setProjects(listed.projects);
      // Nothing is in "the account" once there is no account in session, so the
      // shelf must stop claiming otherwise.
      setCloudProjectIds(new Set());
      setAccountProjectListReached(false);
      setSaveState('local');
      pendingInvitationAttemptRef.current = null;
      setPendingInvitationError(null);
      setSettingsMessage(
        !baselinesCleared
          ? 'Signed out · this account’s sync baselines could not be cleared, so check which copy you keep if one of its projects is opened again here.'
          : pendingInvitationToken
            ? 'Signed out · sign in with the email address that received the project invitation.'
            : 'Signed out · device settings remain active.'
      );
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Sign-out failed.'));
      throw error;
    } finally {
      setSettingsBusy(false);
    }
  }

  async function handleDeleteCloudData(
    scope: AccountDeletionScope,
    confirmation: string
  ) {
    setSettingsBusy(true);
    setSettingsMessage(
      scope === 'projects'
        ? 'Permanently deleting cloud projects…'
        : scope === 'profile'
          ? 'Permanently deleting cloud profile…'
          : 'Permanently deleting all cloud data…'
    );
    try {
      const projectController = cloudProjectAutosaveRef.current;
      if (scope === 'profile') {
        await projectController?.flushPending();
        projectController?.closeProject();
      } else {
        // The device copy is already authoritative and safe. Discard a queued
        // cloud mirror before erasure instead of recreating data the user just
        // confirmed they want gone, then wait for any request already in flight.
        projectController?.closeProject();
        await projectController?.whenIdle();
      }
      await cloudSettingsAutosaveRef.current?.flushPending();

      const deleted = await api.deleteAccountData(scope, confirmation);
      if (deleted.signedOut) {
        projectController?.closeProject();
        const listed = await loadProjectSummaries(false);
        remoteVersionsRef.current.clear();
        // The successful response invalidated the browser cookie (and the
        // desktop proxy drops its Keychain credential). Mirror that immediately
        // in React so no signed-in UI or account state survives the deletion.
        endCloudSettingsSession();
        setCloudAvailable(false);
        setProjects(listed.projects);
        setCloudProjectIds(new Set());
        setAccountProjectListReached(false);
        setSaveState('local');
        setSettingsMessage(
          scope === 'all'
            ? 'All cloud data deleted permanently · local data remains on this device.'
            : 'Cloud profile deleted permanently · cloud projects and local data remain.'
        );
        return;
      }

      await Promise.all(
        deleted.deletedProjectIds.map(async (projectId) => {
          remoteVersionsRef.current.delete(projectId);
          await clearLastSyncedVersion(projectId).catch(() => undefined);
        })
      );
      const listed = await loadProjectSummaries(true);
      setProjects(listed.projects);
      setCloudProjectIds(listed.cloudProjectIds);
      setAccountProjectListReached(listed.remoteReached);
      const currentProjectId = doc?.projectId;
      const currentIsCloud = Boolean(
        currentProjectId && listed.cloudProjectIds.has(currentProjectId)
      );
      setCloudAvailable(currentIsCloud);
      setSaveState(currentIsCloud ? 'synced' : 'local');
      const currentVersion = currentProjectId
        ? remoteVersionsRef.current.get(currentProjectId)
        : undefined;
      if (currentProjectId && currentVersion !== undefined) {
        projectController?.openProject(currentProjectId, currentVersion);
      }
      setSettingsMessage(
        `${deleted.deletedProjectIds.length} cloud project(s) deleted permanently · local copies remain.`
      );
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Cloud data deletion failed.'));
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
      await saveLocalProject(response.document);
      remoteVersionsRef.current.set(
        response.document.projectId,
        response.document.version
      );
      await saveLastSyncedVersion(
        response.document.projectId,
        response.document.version
      );
      setCloudAvailable(true);
      setCloudProjectIds((current) =>
        new Set(current).add(response.document.projectId)
      );
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
    return withMatchingLocalDerived(remote, local);
  }

  /** Stores a document that the account has acknowledged on every local path. */
  async function acceptAccountDocument(
    remote: ProjectDocument,
    local: ProjectDocument,
    summary: ProjectSummary = summarizeLocalDocument(remote)
  ): Promise<ProjectDocument> {
    const merged = withLocalDerived(remote, local);
    // The baseline is only valid after the corresponding account document is
    // durable locally. Keep this order so a partial IndexedDB failure can only
    // lose the baseline (which forces conservative reconciliation), never put
    // the baseline ahead of the device copy.
    await saveLocalProject(merged);
    await saveLastSyncedVersion(merged.projectId, merged.version);
    if (accountDocumentUnavailableProjectIdRef.current === merged.projectId) {
      accountDocumentUnavailableProjectIdRef.current = null;
    }
    remoteVersionsRef.current.set(merged.projectId, merged.version);
    setCloudProjectIds((current) => new Set(current).add(merged.projectId));
    setProjects((current) => mergeProjectSummaries([summary], current));
    if (managerRef.current?.document.projectId === merged.projectId) {
      if (managerRef.current.document.version !== local.version) {
        // The open document moved past the device snapshot this
        // reconciliation was computed from (an edit landed during the network
        // round-trip, or the local read lagged the autosave debounce).
        // Swapping now would revert those edits; keep the live document and
        // let autosave push it against the recorded account version.
        setCloudAvailable(true);
        cloudProjectAutosaveRef.current?.adoptAccountVersion(
          merged.projectId,
          merged.version
        );
        return merged;
      }
      managerRef.current.document = merged;
      setDoc(merged);
      setCloudAvailable(true);
      setSaveState('synced');
      cloudProjectAutosaveRef.current?.adoptAccountVersion(
        merged.projectId,
        merged.version
      );
    }
    return merged;
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
  ): Promise<AdoptLocalProjectResult> {
    const local = await loadLocalProject(projectId);
    if (!local) {
      return { state: 'missing' };
    }
    try {
      const response = await api.adoptProject(local);
      await acceptAccountDocument(response.document, local, response.project);
      return { state: 'adopted' };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ALREADY_ADOPTED') {
        // A lost adoption response and a genuinely pre-existing account copy
        // produce the same 409. Fetch the actual document and reconcile it;
        // merely painting the cloud badge here would claim agreement without
        // ever comparing the work.
        const [remote, lastSyncedVersion] = await Promise.all([
          api.loadProject(projectId),
          loadLastSyncedVersion(projectId)
        ]);
        remoteVersionsRef.current.set(projectId, remote.version);
        setCloudProjectIds((current) => new Set(current).add(projectId));
        const outcome = chooseProjectDocument(local, remote, lastSyncedVersion);
        if (outcome.choice === 'diverged') {
          return {
            state: 'conflict',
            conflict: conflictFromDocuments(
              outcome.local,
              outcome.remote,
              'account'
            )
          };
        }
        if (outcome.choice === 'remote') {
          await acceptAccountDocument(outcome.document, local);
          return { state: 'already-adopted' };
        }
        if (outcome.choice === 'local') {
          // The baseline proves only this device moved. Complete the interrupted
          // sync with a fenced document write rather than asking the user to
          // resolve a conflict that does not exist.
          const candidate = {
            ...outcome.document,
            ownerUserId: remote.ownerUserId
          };
          const saved = await api.saveProjectDocument({
            projectId: candidate.projectId,
            expectedVersion: remote.version,
            document: withoutDerivedProjection(candidate)
          });
          await acceptAccountDocument(
            {
              ...candidate,
              version: saved.version,
              derived: {
                ...candidate.derived,
                updatedAt: saved.updatedAt
              }
            },
            local
          );
          return { state: 'already-adopted' };
        }
        return { state: 'missing' };
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
      if (outcome.state === 'conflict') {
        hydrateDocument(outcome.conflict.localDocument);
        setAccountConflict(outcome.conflict);
        setCloudAvailable(true);
        setSaveState('conflict');
        setStatus(
          `${project.name} changed here and in your account. Nothing has been discarded — choose which to keep.`
        );
        return;
      }
      setStatus(
        outcome.state === 'adopted'
          ? `Saved ${project.name} to your account.`
          : outcome.state === 'already-adopted'
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
      if (outcome.state === 'missing') {
        patchSyncEntry(candidate.projectId, {
          state: 'failed',
          detail: 'No copy of this project exists on this device.'
        });
        return { adopted: false, failed: true, halt: false };
      }
      if (outcome.state === 'conflict') {
        patchSyncEntry(candidate.projectId, {
          state: 'failed',
          detail:
            'Changed on this device and in your account. Open it to choose which to keep.'
        });
        return { adopted: false, failed: true, halt: false };
      }
      patchSyncEntry(candidate.projectId, {
        state: 'synced',
        detail:
          outcome.state === 'already-adopted'
            ? 'Was already in your account.'
            : undefined
      });
      return {
        adopted: outcome.state === 'adopted',
        failed: false,
        halt: false
      };
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
      // The builders are only reachable from here, and only for a demo that
      // has not been seeded yet — the branch above returns for every later
      // open. Fetching them now keeps them out of first paint.
      const { buildDemoDocument } = await import('./lib/demos');
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
      if (
        accountDocumentUnavailableProjectIdRef.current !== null &&
        accountDocumentUnavailableProjectIdRef.current !== projectId
      ) {
        accountDocumentUnavailableProjectIdRef.current = null;
      }
      const [localDocument, remoteResult, lastSyncedVersion] =
        await Promise.all([
          loadLocalProject(projectId),
          session
            ? loadAccountProjectResult(projectId)
            : Promise.resolve<AccountProjectLoadResult>({
                document: null
              }),
          loadLastSyncedVersion(projectId)
        ]);
      const remoteDocument = remoteResult.document;
      if (remoteResult.error && localDocument) {
        const needsRepair = isProjectDocumentUnavailableError(
          remoteResult.error
        );
        accountDocumentUnavailableProjectIdRef.current = needsRepair
          ? projectId
          : null;
        setCloudAvailable(false);
        hydrateDocument(localDocument);
        setSaveState(needsRepair ? 'repair' : 'offline');
        setStatus(
          needsRepair
            ? `Opened ${localDocument.name}. The account copy needs repair; your work remains saved on this device.`
            : `Opened ${localDocument.name}. The account copy is currently unreachable; your work remains saved on this device.`
        );
        return;
      }
      if (remoteResult.error && !localDocument) {
        throw remoteResult.error instanceof Error
          ? remoteResult.error
          : new Error('The account project could not be loaded.');
      }
      const outcome = chooseProjectDocument(
        localDocument,
        remoteDocument,
        lastSyncedVersion
      );
      if (outcome.choice === 'none') {
        throw new Error('Project not found locally or in the beta API.');
      }
      if (
        accountDocumentUnavailableProjectIdRef.current === projectId &&
        remoteDocument
      ) {
        accountDocumentUnavailableProjectIdRef.current = null;
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
      const openedDocument =
        outcome.choice === 'remote' && localDocument
          ? withLocalDerived(outcome.document, localDocument)
          : outcome.document;
      hydrateDocument(openedDocument);
      if (outcome.choice === 'remote') {
        await saveLocalProject(openedDocument);
        await saveLastSyncedVersion(projectId, openedDocument.version);
      }
      setStatus(
        outcome.choice === 'local' && remoteDocument
          ? `Opened newer local edits for ${openedDocument.name}.`
          : `Opened ${openedDocument.name}.`
      );
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to open project.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleAcceptProjectInvitation(token: string) {
    if (!session || !projectSharingEnabled) {
      throw new Error('Project sharing is not enabled for this account.');
    }
    setBusy(true);
    setStatus('Accepting project invitation…');
    try {
      const accepted = await projectSharingClient.acceptInvitation(token);
      const listed = await loadProjectSummaries(true);
      setProjects(listed.projects);
      setCloudProjectIds(listed.cloudProjectIds);
      setAccountProjectListReached(listed.remoteReached);
      setStatus(`Invitation accepted with ${accepted.role} access.`);
      await handleOpenProject(accepted.projectId);
    } catch (error) {
      setStatus(errorMessage(error, 'Could not accept the invitation.'));
      throw error;
    } finally {
      setBusy(false);
    }
  }
  acceptPendingInvitationRef.current = handleAcceptProjectInvitation;

  /**
   * Opens a `#share=` link: fetches the shared snapshot anonymously and
   * hydrates it as a session-local document. Nothing is remembered and
   * nothing is stored — reloading the link re-fetches the owner's current
   * model, and Make a copy below is how the visitor keeps anything.
   */
  useEffect(() => {
    if (!pendingShareToken || shareOpenAttemptRef.current) {
      return;
    }
    shareOpenAttemptRef.current = true;
    setBusy(true);
    void (async () => {
      try {
        const shared = await fetchSharedProject(pendingShareToken);
        if (!shared) {
          setStatus(
            'This share link is no longer available. It may have been revoked.'
          );
          return;
        }
        // Before the document lands: the collaboration hook and the cloud
        // autosave controller must treat this project as not account-backed,
        // whatever this browser knew about the account before.
        setCloudAvailable(false);
        setShareSession({ token: pendingShareToken });
        shareSessionRef.current = { token: pendingShareToken };
        hydrateDocument(shared.document, {
          rememberProject: false
        });
        setStatus(
          `Opened shared model ${shared.project.name} · adjust its parameters and export. Make a copy to build on it.`
        );
      } catch (error) {
        setStatus(errorMessage(error, 'Could not open the share link.'));
      } finally {
        setBusy(false);
      }
    })();
  }, [pendingShareToken]);

  /**
   * The road out of a shared-link session: the shared document becomes an
   * ordinary project of the visitor's own — new project id, saved on this
   * device, Build unlocked. From here every existing flow (cloud adoption,
   * sync, export) treats it like any other local project.
   */
  async function handleMakeShareCopy() {
    const source = managerRef.current?.document;
    if (!source || !shareSessionRef.current) {
      return;
    }
    setBusy(true);
    try {
      const copy = duplicateProjectDocument(
        source,
        duplicateProjectName(
          source.name,
          projects.map((summary) => summary.name)
        ),
        session?.userId ?? localUserId
      );
      setShareSession(null);
      shareSessionRef.current = null;
      clearProjectShareFragment();
      await saveLocalProject(copy);
      setProjects((current) =>
        [
          ...current,
          summarizeLocalDocument(copy, DEFAULT_PROJECT_ORGANIZATION)
        ].sort(compareProjectSummaries)
      );
      hydrateDocument(copy);
      handleWorkspaceMode('build');
      setStatus(
        `${copy.name} is yours now — saved on this device. Build mode is open.`
      );
    } catch (error) {
      setStatus(errorMessage(error, 'Could not copy the shared model.'));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (
      startupState !== 'ready' ||
      !pendingInvitationToken ||
      !session ||
      !collaborationRollout.sharingEnabled
    ) {
      return;
    }
    const attempt = `${session.userId}:${pendingInvitationToken}`;
    if (pendingInvitationAttemptRef.current === attempt) {
      return;
    }
    pendingInvitationAttemptRef.current = attempt;
    setPendingInvitationError(null);
    setSettingsMessage('Opening the shared project…');
    void acceptPendingInvitationRef
      .current(pendingInvitationToken)
      .then(() => {
        clearPendingProjectInvitation();
        setPendingInvitationToken(null);
        setPendingInvitationError(null);
        updateSettingsViewState({ open: false });
        setSettingsOpen(false);
      })
      .catch(() => {
        setPendingInvitationError(
          'This invitation could not be accepted. It may be expired, revoked, or intended for a different email address.'
        );
        setSettingsMessage('The project invitation needs attention.');
        updateSettingsViewState({
          open: true,
          activeSection: 'account'
        });
        setSettingsOpen(true);
      });
  }, [
    collaborationRollout.sharingEnabled,
    pendingInvitationToken,
    session,
    startupState
  ]);

  function dismissProjectInvitation() {
    clearPendingProjectInvitation();
    pendingInvitationAttemptRef.current = null;
    setPendingInvitationToken(null);
    setPendingInvitationError(null);
    closeSettings();
  }

  async function handleGoHome() {
    await flushPendingLocalSave();
    await cloudProjectAutosaveRef.current?.flushPending();
    if (shareSessionRef.current) {
      // Leaving the shared session drops it: the shelf that follows is this
      // device's own projects, and the link in the URL has been consumed.
      setShareSession(null);
      shareSessionRef.current = null;
      clearProjectShareFragment();
    }
    clearActiveProject();
    forgetProjectView();
    managerRef.current = null;
    setDoc(null);
    setArtifacts([]);
    setSelectedFeatureNode(null);
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
      setAccountProjectListReached(listed.remoteReached);
      setCloudAvailable(listed.remoteReached);
      setStatus(
        session && !listed.remoteReached
          ? `Cloud projects are temporarily unavailable · ${listed.projects.length} project(s) remain on this device.`
          : `${listed.projects.length} project(s) available.`
      );
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

  /**
   * Copies a project, optionally starting from one of its save states.
   *
   * Branching is the same operation as duplicating, aimed at an earlier point:
   * a new project, a new id, no link back except the lineage it records. Giving
   * it its own handler would mean a second copy of the cloud-then-device
   * fallback, the derived-projection rescue and the shelf bookkeeping below,
   * which is where the interesting failure modes live.
   */
  async function handleDuplicateProject(
    project: ProjectSummary,
    saveState?: ProjectCheckpoint
  ) {
    setBusy(true);
    try {
      await flushPendingLocalSave();
      if (session) {
        try {
          const response = await api.duplicateProject(project.projectId, {
            ...(saveState ? { revisionId: saveState.revisionId } : {})
          });
          const localSource = await loadLocalProject(project.projectId).catch(
            () => null
          );
          let localCopy = restoreDuplicateDerivedProjection(
            response.document,
            localSource
          );
          if (localCopy === response.document) {
            // This device may not have the exact source revision cached. The
            // kernel stays in the browser, so rebuild the copy here rather
            // than asking cloud persistence to store a derived projection.
            const derived = await geometry
              .syncOnce(response.document)
              .catch(() => null);
            if (derived) {
              localCopy = { ...response.document, derived };
            }
          }
          // Kept on the device too, so the copy opens offline exactly like the
          // original it was made from.
          await saveLocalProject(localCopy).catch(() => undefined);
          if (response.project.organization) {
            await saveLocalProjectOrganization(
              response.project.projectId,
              response.project.organization
            ).catch(() => undefined);
          }
          setProjects((current) =>
            [...current, response.project].sort(compareProjectSummaries)
          );
          setStatus(
            saveState
              ? `Branched ${project.name} from “${saveState.reason}” as ${response.project.name}.`
              : `Duplicated ${project.name} as ${response.project.name}.`
          );
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
      const head = await loadLocalProject(project.projectId);
      if (!head) {
        throw new Error('The project could not be read from this device.');
      }
      const source = saveState
        ? await loadLocalSaveState(project.projectId, saveState.checkpointId)
        : head;
      if (!source) {
        throw new Error(
          'That save state is not stored on this device, and your account could not be reached to fetch it.'
        );
      }
      const copy = duplicateProjectDocument(
        source,
        duplicateProjectName(
          head.name,
          projects.map((summary) => summary.name)
        ),
        session?.userId ?? localUserId,
        saveState
          ? projectBranchPoint(head, {
              revisionId: saveState.revisionId,
              reason: saveState.reason
            })
          : undefined
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
      setStatus(
        saveState
          ? `Branched ${project.name} from “${saveState.reason}” as ${copy.name}.`
          : `Duplicated ${project.name} as ${copy.name}.`
      );
    } catch (error) {
      setStatus(
        errorMessage(
          error,
          saveState
            ? 'Could not branch that save state.'
            : 'Could not duplicate the project.'
        )
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * One save state's document: this device first, the account second.
   *
   * Device first because it is the faster and more available of the two and
   * holds the same bytes — and because a restore has to work with the network
   * down. The account is the fallback for save states older than this device's
   * retention, or made on another device entirely.
   */
  async function loadSaveStateDocument(
    projectId: string,
    checkpoint: ProjectCheckpoint
  ): Promise<ProjectDocument | null> {
    const local = await loadLocalSaveState(
      projectId,
      checkpoint.checkpointId
    ).catch(() => null);
    if (local) {
      return local;
    }
    if (!session || !cloudProjectIds.has(projectId)) {
      return null;
    }
    return api.loadRevision(projectId, checkpoint.revisionId).catch(() => null);
  }

  /**
   * Rewinds the open project to one of its save states.
   *
   * Two invariants shape the order of the steps. The pre-restore document is
   * checkpointed and written *first*, so the state being left is reachable
   * afterwards even past the undo depth — a restore the user cannot escape is
   * a data-loss feature. And the restore itself goes through the command
   * manager as one document edit, which makes it a single Undo and leaves the
   * durable timeline running forward (see `restoreFromSaveState`) instead of
   * rewinding a clock that collaboration and every fenced cloud write compare
   * against.
   */
  async function handleRestoreSaveState(checkpoint: ProjectCheckpoint) {
    const manager = managerRef.current;
    const current = manager?.document;
    if (!manager || !current) {
      return;
    }
    if (shareSessionRef.current) {
      setStatus(
        'This is a shared link session — Make a copy before restoring a save.'
      );
      return;
    }
    if (!ensureCanEdit('restore a save state')) {
      return;
    }
    setBusy(true);
    try {
      await flushPendingLocalSave();
      const snapshot = await loadSaveStateDocument(
        current.projectId,
        checkpoint
      );
      if (!snapshot) {
        setStatus(
          'That save state is no longer stored on this device or in your account.'
        );
        return;
      }
      const guarded = createCheckpoint(
        appendRevision(current, BEFORE_RESTORE_REASON),
        BEFORE_RESTORE_REASON
      );
      // Written before anything is replaced: this is the way back.
      await saveLocalProject(guarded);
      const reason = `Restored “${checkpoint.reason}”`;
      const restored = createCheckpoint(
        restoreFromSaveState(guarded, snapshot, reason),
        reason
      );
      manager.applyDocumentEdit(restored, reason);
      // The meshes on screen belong to the document being left, and the
      // restored history has to be rebuilt from scratch to replace them.
      geometry.invalidate();
      setDoc(restored);
      setSelectedFeatureNode(null);
      setSelectedTopology(null);
      setSelectedEdges([]);
      setSelectedBodyIds([]);
      setSelectedSketchProfileId(null);
      setSelectedProfiles([]);
      setExtrudePreview(null);
      setPreviewDoc(null);
      setTool(null);
      setStatus(`${reason}. Undo puts it back.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Could not restore that save state.'));
    } finally {
      setBusy(false);
    }
  }

  /** Branches the open project's save state into a project of its own. */
  async function handleBranchSaveState(checkpoint: ProjectCheckpoint) {
    const current = managerRef.current?.document;
    if (!current) {
      return;
    }
    const project =
      projects.find((summary) => summary.projectId === current.projectId) ??
      summarizeLocalDocument(current, DEFAULT_PROJECT_ORGANIZATION);
    await handleDuplicateProject(project, checkpoint);
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
    // An assistant preview was preflighted against the document this rewind
    // just replaced; keeping it would render geometry from a lineage that no
    // longer exists.
    setPreviewDoc(null);
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
    setPreviewDoc(null);
    setExtrudePreview(null);
    setMoveCommitHold(null);
    setTool(null);
    clearSelection();
    setStatus('Redo');
  }

  /**
   * Turns a refused write into a choice between two real documents rather than
   * two version numbers.
   *
   * Autosave and an explicit save can both lose the version fence, and losing
   * it is not the same as losing the connection: the account answered, and it
   * answered that it holds something this device has not seen.
   */
  function raiseAccountConflict(
    projectId: string,
    localDocument: ProjectDocument,
    accountVersion: number | null
  ) {
    setStatus(
      accountVersion === null
        ? 'This project changed elsewhere. Your work is saved on this device.'
        : `This project changed elsewhere (account version ${accountVersion}). Your work is saved on this device.`
    );
    void api
      .loadProject(projectId)
      .then((remote) => {
        accountDocumentUnavailableProjectIdRef.current = null;
        setCloudAvailable(true);
        setAccountConflict(
          conflictFromDocuments(localDocument, remote, 'account')
        );
      })
      .catch((error) => {
        if (isProjectDocumentUnavailableError(error)) {
          accountDocumentUnavailableProjectIdRef.current = projectId;
          setCloudAvailable(false);
          setSaveState('repair');
          setStatus(
            'The account copy needs repair. Your work remains saved on this device; click Repair needed to retry.'
          );
          return;
        }
        setStatus(
          `${errorMessage(error, 'Could not load the account copy.')} Your work remains saved on this device.`
        );
      });
  }

  async function retryUnavailableAccountProject(
    localDocument: ProjectDocument
  ): Promise<void> {
    setStatus('Checking the account copy…');
    try {
      const [remote, lastSyncedVersion] = await Promise.all([
        api.loadProject(localDocument.projectId),
        loadLastSyncedVersion(localDocument.projectId)
      ]);
      accountDocumentUnavailableProjectIdRef.current = null;
      remoteVersionsRef.current.set(remote.projectId, remote.version);
      setCloudProjectIds((current) => new Set(current).add(remote.projectId));
      setCloudAvailable(true);
      const outcome = chooseProjectDocument(
        localDocument,
        remote,
        lastSyncedVersion
      );
      if (outcome.choice === 'diverged') {
        setAccountConflict(
          conflictFromDocuments(outcome.local, outcome.remote, 'account')
        );
        setSaveState('conflict');
        setStatus(
          `${localDocument.name} changed here and in your account. Nothing has been discarded — choose which to keep.`
        );
        return;
      }
      if (outcome.choice === 'remote') {
        await acceptAccountDocument(outcome.document, localDocument);
        setStatus('The account copy is available again.');
        return;
      }
      if (outcome.choice === 'local') {
        const controller = cloudProjectAutosaveRef.current;
        controller?.adoptAccountVersion(remote.projectId, remote.version);
        controller?.schedule(outcome.document);
        setSaveState(controller ? 'syncing' : 'offline');
        setStatus(
          controller
            ? 'The account copy is available again · updating it from this device…'
            : 'The account copy is available again; save again to update it.'
        );
        return;
      }
      setSaveState('offline');
    } catch (error) {
      if (isProjectDocumentUnavailableError(error)) {
        await restoreUnavailableAccountProject(localDocument);
        return;
      }
      setSaveState('offline');
      setStatus(
        `${errorMessage(error, 'Could not check the account copy.')} Your work remains saved on this device.`
      );
    }
  }

  async function restoreUnavailableAccountProject(
    localDocument: ProjectDocument
  ): Promise<void> {
    accountDocumentUnavailableProjectIdRef.current = localDocument.projectId;
    setCloudAvailable(false);
    setSaveState('repair');

    let summary: ProjectSummary | undefined;
    try {
      summary = (await api.listProjects()).projects.find(
        (project) => project.projectId === localDocument.projectId
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        remoteVersionsRef.current.clear();
        endCloudSettingsSession();
      }
      setStatus(
        `${errorMessage(error, 'Could not verify the account record.')} Your work remains saved on this device.`
      );
      return;
    }
    if (summary?.documentVersion === undefined) {
      setStatus(
        'The account record could not be verified, so nothing was replaced. Your work remains saved on this device.'
      );
      return;
    }
    if (localDocument.version < summary.documentVersion) {
      setStatus(
        `The account record is newer than this device (version ${summary.documentVersion} vs ${localDocument.version}), so nothing was replaced. Your work remains saved on this device.`
      );
      return;
    }
    if (
      !window.confirm(
        `Restore ${localDocument.name} in your account from the copy saved on this device?\n\nThe unreadable current account copy will be replaced. Existing revisions are not changed.`
      )
    ) {
      setStatus(
        'Account restore canceled. Your work remains saved on this device.'
      );
      return;
    }

    setSaveState('saving');
    setStatus('Restoring the account copy from this device…');
    try {
      const saved = await api.saveProjectDocument({
        projectId: localDocument.projectId,
        expectedVersion: summary.documentVersion,
        document: withoutDerivedProjection(localDocument)
      });
      const restored = {
        ...localDocument,
        version: saved.version,
        derived: {
          ...localDocument.derived,
          updatedAt: saved.updatedAt
        }
      };
      await acceptAccountDocument(restored, localDocument, {
        ...summary,
        name: restored.name,
        updatedAt: saved.updatedAt,
        documentVersion: saved.version
      });
      setStatus('Restored the account copy from this device.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setSaveState('repair');
        setStatus(
          'The account record changed during restore, so nothing was overwritten. Retry after checking the other device.'
        );
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        remoteVersionsRef.current.clear();
        endCloudSettingsSession();
      }
      setCloudAvailable(false);
      setSaveState('repair');
      setStatus(
        `${errorMessage(error, 'Could not restore the account copy.')} Your work remains saved on this device.`
      );
    }
  }

  /**
   * Opens the naming dialog, when there is something to name.
   *
   * The refusals mirror `handleSave`'s own: a shared-link session has nothing
   * of its own to save, and a viewer cannot write to the project. Checking
   * them here keeps the user from typing a name into a save that was never
   * going to happen.
   */
  function openSaveNameDialog() {
    if (!doc) {
      return;
    }
    if (shareSessionRef.current) {
      setStatus(
        'This is a shared link session — Make a copy to keep the model.'
      );
      return;
    }
    if (!ensureCanEdit('save a named revision')) {
      return;
    }
    setNamingSave(true);
  }

  /**
   * Marks the current state as a save point.
   *
   * `reason` is what the history panel shows for it ever after, which is why
   * naming is worth a gesture of its own — see {@link SaveRevisionDialog}. The
   * default keeps Ctrl+S a reflex.
   */
  async function handleSave(reason: string = DEFAULT_SAVE_REASON) {
    if (!doc) {
      return;
    }
    if (shareSessionRef.current) {
      setStatus(
        'This is a shared link session — Make a copy to keep the model.'
      );
      return;
    }
    try {
      setSaveState('saving');
      await saveLocalProject(doc);
      if (accountDocumentUnavailableProjectIdRef.current === doc.projectId) {
        await retryUnavailableAccountProject(doc);
        return;
      }
      if (!ensureCanEdit('save a shared revision')) {
        setSaveState('offline');
        return;
      }
      const expectedVersion = remoteVersionsRef.current.get(doc.projectId);
      if (!session || expectedVersion === undefined) {
        // No account will checkpoint this one, so the save point is made here.
        // Without it a device-only project could never gain a save beyond the
        // one it was born with — which would leave restore and branch with
        // nothing to offer exactly where they are needed most, and would drop
        // a name the user had just typed.
        const marked = createCheckpoint(doc, reason);
        const live = managerRef.current?.document;
        if (
          !live ||
          (live.projectId === doc.projectId && live.version === doc.version)
        ) {
          await saveLocalProject(marked);
          if (managerRef.current) {
            managerRef.current.document = marked;
          }
          setDoc(marked);
        }
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
        reason,
        expectedVersion:
          cloudProjectAutosaveRef.current?.syncedVersion ?? expectedVersion,
        document: withoutDerivedProjection(doc)
      });
      remoteVersionsRef.current.set(saved.projectId, saved.version);
      const live = managerRef.current?.document;
      if (
        live &&
        (live.projectId !== doc.projectId || live.version !== doc.version)
      ) {
        // Edits landed while the revision round-tripped. The account holds
        // the pre-edit snapshot this handler sent; adopting its echo would
        // erase those edits from the canonical document while their undo
        // entries survive. Record the account version so the next autosave
        // fences correctly and let it carry the newer edits up.
        await saveLastSyncedVersion(saved.projectId, saved.version);
        setCloudAvailable(true);
        cloudProjectAutosaveRef.current?.adoptAccountVersion(
          saved.projectId,
          saved.version
        );
        setStatus('Saved revision.');
        return;
      }
      const restored = withLocalDerived(saved, doc);
      await saveLocalProject(restored);
      await saveLastSyncedVersion(restored.projectId, restored.version);
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
      if (error instanceof ApiError && error.status === 409) {
        // The account is plainly reachable — it is what refused the write — so
        // this is a divergence to resolve, not a connection to give up on.
        setSaveState('conflict');
        raiseAccountConflict(doc.projectId, doc, currentVersionOf(error));
        return;
      }
      if (isProjectDocumentUnavailableError(error)) {
        accountDocumentUnavailableProjectIdRef.current = doc.projectId;
        setCloudAvailable(false);
        setSaveState('repair');
        setStatus(
          'The account copy needs repair. Your work remains saved on this device; click Repair needed to retry.'
        );
        return;
      }
      setCloudAvailable(false);
      setSaveState('offline');
      setStatus(
        `${errorMessage(error, 'Cloud save failed')} Saved on this device.`
      );
    }
  }

  const aiPreviewEpochRef = useRef(0);

  async function handlePreviewPatch(
    proposal: CadPatchProposal | null
  ): Promise<AssistantPreviewOutcome> {
    const epoch = ++aiPreviewEpochRef.current;
    if (!proposal) {
      setPreviewDoc(null);
      setStatus('Preview cleared.');
      return { ok: true };
    }
    const current = managerRef.current?.document;
    if (!current) {
      return { ok: false, reason: 'No project is open to preview.' };
    }
    try {
      setStatus('Checking the AI preview against exact geometry…');
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
        return {
          ok: false,
          reason:
            'The document changed during exact AI preflight. Review the refreshed proposal.'
        };
      }
      setPreviewDoc(preflight.candidate);
      setStatus('Previewing exact proposed geometry.');
      return { ok: true };
    } catch (error) {
      if (epoch !== aiPreviewEpochRef.current) {
        return {
          ok: false,
          reason:
            'The document changed during exact AI preflight. Review the refreshed proposal.'
        };
      }
      setPreviewDoc(null);
      const reason = errorMessage(error, 'Patch preview failed.');
      setStatus(reason);
      return { ok: false, reason };
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
      setStatus('Checking the AI change against exact geometry…');
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
      throw new Error(
        editDisabledReasonRef.current ?? 'Project editing is unavailable.'
      );
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
    // Chunked above the part size, single PUT below; retries each part and
    // aborts the multipart state if the upload cannot finish.
    await uploadArtifactBody(
      api,
      { uploadSessionId: upload.uploadSessionId, uploadUrl: upload.uploadUrl },
      input.body
    );
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

    if (lowerName.endsWith('.shapr')) {
      setStatus(
        'Shapr3D migration requires selecting one .shapr project and its companion .step file together.'
      );
      return;
    }
    if (!/\.(?:stl|step|stp)$/i.test(file.name)) {
      setStatus(`Unsupported import format: ${file.name}`);
      return;
    }

    if (lowerName.endsWith('.stl')) {
      if (file.size > MAX_SOURCE_IMPORT_BYTES) {
        setStatus('STL import is limited to 250 MB.');
        return;
      }
      let parsed;
      try {
        parsed = parseStl(await file.arrayBuffer(), file.name);
      } catch (error) {
        setStatus(errorMessage(error, 'STL import failed.'));
        return;
      }
      // STL carries no unit declaration; the interchange convention is
      // millimetres, and exportStl multiplies by UNIT_TO_MM on the way out.
      // Adopting the vertices at 1/UNIT_TO_MM keeps a non-mm document's
      // round trip at the same physical size.
      const meshScale = 1 / UNIT_TO_MM[doc.units];
      const vertices =
        meshScale === 1
          ? parsed.vertices
          : parsed.vertices.map((value) => value * meshScale);

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
          vertices,
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

    await runStepImport({
      file,
      contentType,
      archive: archiveArtifact,
      validatedFeature,
      status: { setStatus, setFeatureFormError },
      marks: {
        inFlight: inFlightImportChecksums.current,
        abandoned: abandonedImportChecksums.current
      },
      currentDocument: () => managerRef.current?.document ?? null,
      editDisabledReason: () => editDisabledReasonRef.current,
      newId: () => crypto.randomUUID()
    });
  }

  function cancelShaprImport() {
    shaprPreviewAbortRef.current?.abort();
    shaprPreviewAbortRef.current = null;
    setPendingShaprImport(null);
  }

  async function handleImportFiles(files: File[]) {
    const shaprFiles = files.filter((file) => /\.shapr$/i.test(file.name));
    if (shaprFiles.length === 0) {
      if (files.length !== 1) {
        setStatus('Select one STEP or STL file, or one .shapr + STEP pair.');
        return;
      }
      await handleImportFile(files[0]!);
      return;
    }
    const stepFiles = files.filter((file) =>
      /\.(?:step|stp)$/i.test(file.name)
    );
    if (
      files.length !== 2 ||
      shaprFiles.length !== 1 ||
      stepFiles.length !== 1
    ) {
      setStatus(
        'Shapr3D migration requires exactly one .shapr project and one companion .step or .stp file.'
      );
      return;
    }
    if (!managerRef.current || !doc || !ensureCanEdit('import geometry')) {
      return;
    }

    shaprPreviewAbortRef.current?.abort();
    const controller = new AbortController();
    shaprPreviewAbortRef.current = controller;
    const shaprFile = shaprFiles[0]!;
    const sourceStepFile = stepFiles[0]!;
    setPendingShaprImport({
      shaprFile,
      sourceStepFile,
      phase: 'parsing',
      progress: 'Starting the isolated parser worker…',
      error: null,
      inspection: null
    });
    try {
      const inspection = await inspectShaprPair(shaprFile, sourceStepFile, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (shaprPreviewAbortRef.current === controller) {
            setPendingShaprImport((current) =>
              current ? { ...current, progress } : null
            );
          }
        }
      });
      if (shaprPreviewAbortRef.current !== controller) {
        return;
      }
      setPendingShaprImport((current) =>
        current
          ? {
              ...current,
              phase: 'preview',
              progress: 'Preview ready.',
              inspection
            }
          : null
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      const message = errorMessage(error, 'Shapr3D preview failed.');
      setStatus(message);
      setPendingShaprImport((current) =>
        current
          ? { ...current, phase: 'preview', progress: '', error: message }
          : null
      );
    } finally {
      if (shaprPreviewAbortRef.current === controller) {
        shaprPreviewAbortRef.current = null;
      }
    }
  }

  async function applyShaprImport() {
    const pending = pendingShaprImport;
    if (
      !pending?.inspection ||
      !managerRef.current ||
      !doc ||
      !ensureCanEdit('import geometry')
    ) {
      return;
    }
    const migration = shaprMigrationDraft({
      ir: pending.inspection.ir,
      shaprFileName: pending.shaprFile.name,
      stepFileName: pending.sourceStepFile.name,
      stepChecksumSha256: pending.inspection.stepChecksumSha256
    });
    const importId = toShaprImportId(`shapr_${crypto.randomUUID()}`);
    setPendingShaprImport((current) =>
      current
        ? {
            ...current,
            phase: 'applying',
            progress: 'Validating the sanitized STEP in the exact kernel…',
            error: null
          }
        : null
    );
    const result = await runStepImport({
      file: pending.inspection.sanitizedStepFile,
      contentType:
        pending.inspection.sanitizedStepFile.type || 'application/step',
      archive: archiveArtifact,
      validatedFeature,
      status: { setStatus, setFeatureFormError },
      marks: {
        inFlight: inFlightImportChecksums.current,
        abandoned: abandonedImportChecksums.current
      },
      currentDocument: () => managerRef.current?.document ?? null,
      editDisabledReason: () => editDisabledReasonRef.current,
      newId: () => crypto.randomUUID(),
      commandFactory: (step) =>
        commandFactories.importShaprGuided({ step, migration, importId }),
      validatingMessage:
        'Rebuilding the companion STEP and checking exact geometry…',
      successMessage: ({ archived }) =>
        `Imported ${pending.shaprFile.name}: exact STEP body rebuilt; recovered history saved as non-operative evidence` +
        (archived
          ? '; sanitized STEP source archived.'
          : '; sanitized STEP source saved locally.')
    });
    if (result.outcome === 'committed') {
      setPendingShaprImport(null);
      return;
    }
    setPendingShaprImport((current) =>
      current
        ? {
            ...current,
            phase: 'preview',
            progress: 'Preview ready.',
            error:
              'The exact STEP body was not committed. Review the status message, then retry or cancel.'
          }
        : null
    );
  }

  /**
   * Uploads import sources that exist only in this browser (their archival
   * failed at import time) and points the owning features at the finalized
   * artifacts. Runs on the user's explicit request from the File menu; a
   * partial failure leaves the remaining features local-only and retryable.
   */
  async function handleArchiveLocalSources() {
    if (
      !doc ||
      localOnlySources.length === 0 ||
      !ensureCanEdit('archive import sources')
    ) {
      return;
    }
    setStatus(`Archiving ${localOnlySources.length} local import source(s)…`);
    const result = await archiveLocalOnlyImportSources({
      document: doc,
      loadSourceBytes: loadSourceBlob,
      archive: (input) => archiveArtifact(input),
      applyArtifactId: (featureId, artifactId) =>
        executeCommand(
          commandFactories.updateFeature(
            { featureId, data: { artifactId: toArtifactId(artifactId) } },
            'Archive import source'
          )
        )
    });
    const notes: string[] = [];
    if (result.archived.length > 0) {
      notes.push(`archived ${result.archived.join(', ')}`);
    }
    if (result.missing.length > 0) {
      notes.push(
        `source bytes for ${result.missing.join(', ')} are not on this device`
      );
    }
    if (result.failed.length > 0) {
      notes.push(`upload failed for ${result.failed.join(', ')} — try again`);
    }
    setStatus(
      notes.length > 0
        ? `Archive local sources: ${notes.join('; ')}.`
        : 'No local import sources needed archiving.'
    );
  }

  /** Export one selected planar face's outline as a DXF for laser cutting. */
  async function handleExportFaceDxf(target: {
    bodyId: string;
    topologyId: string;
  }) {
    if (!doc) {
      return;
    }
    const face = representations[target.bodyId as BodyId]?.topology?.faces.find(
      (candidate) => candidate.topologyId === target.topologyId
    );
    if (!face) {
      setStatus('The selected face is no longer available.');
      return;
    }
    const stem = exportFileStem(doc.name);
    try {
      setStatus('Exporting face outline as DXF…');
      const result = await geometry.exportModel(
        'dxf',
        doc,
        [target.bodyId as BodyId],
        {
          face: {
            bodyId: target.bodyId as BodyId,
            faceHash: face.hash,
            ...(face.reference?.kind === 'face'
              ? { faceReference: face.reference }
              : {})
          }
        }
      );
      if (!('text' in result)) {
        throw new Error('The DXF export returned no text.');
      }
      const saved = await saveCadTextFile(
        `${stem}-face.dxf`,
        'dxf',
        result.text
      );
      setStatus(
        saved
          ? `Exported face outline to ${stem}-face.dxf.`
          : 'DXF export cancelled.'
      );
    } catch (error) {
      setStatus(errorMessage(error, 'DXF export failed.'));
    }
  }

  async function handleExportStep() {
    if (!doc || exportBodyIds.length === 0) {
      setStatus('Create a body before exporting.');
      return;
    }
    const stem = exportFileStem(doc.name);
    try {
      setStatus('Exporting exact STEP…');
      const result = await geometry.exportModel('step', doc, exportBodyIds);
      if (!('text' in result)) {
        throw new Error('The STEP export returned no text.');
      }
      const fileName = `${stem}.step`;
      const contentType = 'model/step';
      const saved = await saveCadTextFile(fileName, 'step', result.text);
      if (!saved) {
        setStatus('STEP export cancelled.');
        return;
      }
      let archived = false;
      try {
        await archiveArtifact({
          fileName,
          contentType,
          kind: 'step-export',
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
      setStatus(
        result.warnings.length > 0
          ? `Exported STEP with ${result.warnings.length} warning(s).`
          : `Exported ${exportBodyIds.length} body(ies) to ${stem}.step${archived ? ' and archived it' : ''}.`
      );
    } catch (error) {
      setStatus(errorMessage(error, 'STEP export failed.'));
    }
  }

  /**
   * Mesh export from the dialog. Throws on failure so the dialog can show
   * the error in place; a cancelled save dialog resolves quietly.
   */
  async function handleExportMesh(
    format: MeshExportDialogFormat,
    deflection: number,
    options?: {
      signal?: AbortSignal;
      onProgress?(progress: ExportProgress): void;
    }
  ) {
    if (!doc || exportBodyIds.length === 0) {
      throw new Error('Create a body before exporting.');
    }
    const info = MESH_EXPORT_FILE_INFO[format];
    const stem = exportFileStem(doc.name);
    const fileName = `${stem}.${info.extension}`;
    setStatus(`Exporting ${info.label}…`);
    let result: Awaited<ReturnType<typeof geometry.exportModel>>;
    try {
      result = await geometry.exportModel(format, doc, exportBodyIds, {
        deflection,
        ...(options?.signal ? { signal: options.signal } : {}),
        onState: (state) => {
          const progress = exportProgressFor(state);
          if (progress) {
            options?.onProgress?.(progress);
          }
        }
      });
    } catch (error) {
      if (options?.signal?.aborted) {
        setStatus(`${info.label} export cancelled.`);
      }
      throw error;
    }
    // The result can win the race against a cancel click; the user asked to
    // stop, so no save prompt may appear.
    if (options?.signal?.aborted) {
      setStatus(`${info.label} export cancelled.`);
      return;
    }
    options?.onProgress?.('saving');
    let body: Blob;
    let saved: boolean;
    if ('data' in result) {
      body = new Blob([result.data], { type: info.contentType });
      saved = await saveCadBinaryFile(fileName, info.binaryFormat, result.data);
    } else {
      body = new Blob([result.text], { type: info.contentType });
      saved = await saveCadTextFile(fileName, 'stl', result.text);
    }
    if (!saved) {
      setStatus(`${info.label} export cancelled.`);
      return;
    }
    let archived = false;
    try {
      await archiveArtifact({
        fileName,
        contentType: info.contentType,
        kind: info.kind,
        body,
        metadata: {
          bodyIds: exportBodyIds.join(','),
          documentVersion: doc.version,
          units: doc.units,
          format,
          deflectionMm: deflection
        }
      });
      archived = true;
    } catch {
      // The local download has already completed successfully.
    }
    setStatus(
      `Exported ${exportBodyIds.length} body(ies) to ${fileName}${archived ? ' and archived it' : ''}.`
    );
  }

  function handleCheckMeshQuality(
    deflection: number,
    options?: { onProgress?(progress: ExportProgress): void }
  ) {
    if (!doc || exportBodyIds.length === 0) {
      return Promise.reject(
        new Error('Create a body before checking printability.')
      );
    }
    return geometry.meshQuality(doc, exportBodyIds, deflection, {
      onState: (state) => {
        const progress = exportProgressFor(state);
        if (progress) {
          options?.onProgress?.(progress);
        }
      }
    });
  }

  function handleExportDiagnostics() {
    if (!doc) {
      setStatus('Open a project before exporting diagnostics.');
      return;
    }
    try {
      const bundle = createProjectDiagnosticBundle(doc, {
        remusVersion: KERNEL_BUILD.packageVersion,
        remusCommit: KERNEL_BUILD.sourceCommit
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

  desktopMenuHandlerRef.current = (command) => {
    switch (command) {
      case 'open-model':
        void openDesktopCadFile()
          .then((file) => (file ? handleImportFile(file) : undefined))
          .catch((error) => {
            setStatus(errorMessage(error, 'Could not open the CAD model.'));
          });
        break;
      case 'save-project':
        void handleSave();
        break;
      case 'export-step':
        void handleExportStep();
        break;
      case 'export-mesh':
        if (exportBodyIds.length > 0) {
          setMeshExportOpen(true);
        } else {
          setStatus('Create a body before exporting.');
        }
        break;
      case 'undo':
        handleUndo();
        break;
      case 'redo':
        handleRedo();
        break;
      case 'settings':
        openSettings();
        break;
    }
  };

  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const register = async () => {
      const next = await Promise.all([
        listenForDesktopMenu((command) => {
          desktopMenuHandlerRef.current(command);
        }),
        protectDesktopClose(() => saveStateRef.current === 'saving')
      ]);
      if (disposed) {
        next.forEach((cleanup) => cleanup());
      } else {
        cleanups.push(...next);
      }
    };
    void register().catch((error) => {
      console.error('Desktop integration setup failed.', error);
    });
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

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
    setSelectedFeatureNode(null);
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
    setSelectedFeatureNode(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setTool(null);
    // Not "Esc exits": a sketch opens with the Line tool armed, so the first
    // Escape returns to selection and only the second leaves. The live hint
    // beside this message already names the rung you are actually on, and two
    // contradictory promises on one status bar is worse than one honest one.
    setStatus('Sketching on the selected face · Finish Sketch when done.');
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
    // An armed face re-pick owns the click outright: the pick answers "which
    // face should this broken edit use", never a selection or a drag handle.
    if (faceRepair) {
      handleFaceRepairPick(selection);
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
    // Measuring owns the pick outright. Without this return the same click
    // went on to arm a sketch, arm a drag handle, and replace the selection —
    // so an inspection pass rewrote the state a modelling session was holding.
    if (handleMeasurementPick(selection, additive, detail)) {
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
      const filletFeature =
        faceTopology && geometry?.featureType === 'blend'
          ? editableFilletFeature(
              doc,
              faceTopology,
              representations[selection.bodyId]?.topology?.faces ?? []
            )
          : null;
      const sourceFeature = features.find(
        (feature) => feature.bodyId === selection.bodyId
      );
      const importedBlend =
        !filletFeature &&
        sourceFeature?.data.featureKind === 'imported-step' &&
        faceTopology
          ? importedBlendSnapshot(faceTopology)
          : null;
      const filletRadialDirection =
        (filletFeature || importedBlend) && geometry
          ? blendRadialDirection(geometry, detail.point, detail.normal)
          : null;
      const removableImportedBlend =
        !filletFeature && faceTopology
          ? canRemoveImportedBlendFace(
              representations[selection.bodyId]!,
              faceTopology
            )
          : false;
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
        ...(geometry?.center
          ? {
              surfaceCenter: [
                geometry.center.x,
                geometry.center.y,
                geometry.center.z
              ] as [number, number, number]
            }
          : {}),
        surfaceType:
          surface === 'plane'
            ? 'planar'
            : surface === 'cylinder'
              ? 'cylindrical'
              : 'other',
        ...(geometry?.blendRadius !== undefined
          ? { blendRadius: geometry.blendRadius }
          : {}),
        ...(geometry?.featureType ? { featureType: geometry.featureType } : {}),
        ...(geometry?.diameter !== undefined
          ? { diameter: geometry.diameter }
          : {}),
        ...(filletFeature ? { filletFeatureId: filletFeature.featureId } : {}),
        ...(importedBlend
          ? {
              canResizeImportedBlend: true,
              blendSurfaceClass: importedBlend.surfaceClass,
              blendCenter: [
                importedBlend.center.x,
                importedBlend.center.y,
                importedBlend.center.z
              ] as [number, number, number],
              blendAxis: [
                importedBlend.axis.x,
                importedBlend.axis.y,
                importedBlend.axis.z
              ] as [number, number, number],
              ...(faceTopology?.reference?.lineageName ===
              'direct-edit.resize-blend.band'
                ? {
                    directEditFeatureId: String(
                      faceTopology.reference.producingFeatureId
                    )
                  }
                : {})
            }
          : {}),
        ...(removableImportedBlend ? { canRemoveFaceFeature: true } : {}),
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
              radialDirection: filletRadialDirection
                ? ([
                    filletRadialDirection.x,
                    filletRadialDirection.y,
                    filletRadialDirection.z
                  ] as [number, number, number])
                : ([
                    radialFrame.radialDirection.x,
                    radialFrame.radialDirection.y,
                    radialFrame.radialDirection.z
                  ] as [number, number, number]),
              concavity: radialFrame.concavity
            }
          : filletRadialDirection
            ? {
                radialDirection: [
                  filletRadialDirection.x,
                  filletRadialDirection.y,
                  filletRadialDirection.z
                ] as [number, number, number]
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
      inferFeatureNodeFor(selection.bodyId);
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
      inferFeatureNodeFor(nextIds[0]!);
    } else {
      setSelectedTopology(null);
      setSelectedFeatureNode(null);
    }
  }

  function handleSelectAllEdges(body: BodyRepresentation) {
    const edges = (body.topology?.edges ?? [])
      .filter((edge) => edge.displayRole !== 'seam')
      .map((edge): TopologySelection => ({
        bodyId: body.bodyId,
        kind: 'edge',
        topologyId: edge.topologyId,
        hash: edge.hash,
        reference: edge.reference
      }));
    setSelectedEdges(edges);
    setSelectedBodyIds([body.bodyId]);
    setSelectedTopology(edges.at(-1) ?? { bodyId: body.bodyId, kind: 'body' });
    inferFeatureNodeFor(body.bodyId);
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
    inferFeatureNodeFor(first.bodyId);
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
    // A move in flight owns the drag. The gizmo answers within about 15 px of
    // its arrow, so a grab that slips a little further lands on empty space
    // and used to arrive here as an empty box selection — which cleared the
    // selection out from under the Move panel, leaving the panel and the
    // gizmo on screen still naming a body that was no longer selected. The
    // near miss should cost nothing, not the selection.
    if (movePreview && bodyIds.length === 0) {
      return;
    }
    // A sweep that does pick something is a change of intent, so the move goes
    // rather than staying armed on a body the user has just selected away from.
    if (movePreview) {
      setMovePreview(null);
      setTool(null);
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
    inferFeatureNodeFor(bodyIds.length === 1 ? (bodyIds[0] as BodyId) : null);
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
  // Exact entry remains mounted after a refused preview so its disabled Apply
  // state and error stay actionable; Escape, deselection, and commits close it.
  useEffect(() => {
    const open =
      interaction.mode !== 'idle' &&
      interaction.mode !== 'sketch' &&
      (interaction.phase === 'exact-entry' || interaction.phase === 'failed');
    if (!open) {
      setKeypad(null);
    }
  }, [interaction]);

  // Leaving either edge creation or face-backed fillet editing abandons its
  // in-flight exact preview document.
  const edgePreviewInteraction =
    interaction.mode === 'edges' ||
    (interaction.mode === 'face' && interaction.op === 'edit-fillet');
  useEffect(() => {
    if (!edgePreviewInteraction) {
      edgePreview.clear();
    }
  }, [edgePreviewInteraction]);

  const offsetInteractionKey =
    interaction.mode === 'face' && interaction.op === 'offset-face'
      ? `${interaction.target.bodyId}:${interaction.target.topologyId}`
      : null;
  useEffect(() => {
    offsetPreview.clear();
    setPreviewDeferred(false);
    offsetPreviewValueRef.current = null;
  }, [offsetInteractionKey, offsetPreview]);

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
  const sketchDocumentRef = useRef(doc);
  sketchDocumentRef.current = doc;
  const sketchSessionNameRef = useRef(sketchSessionName);
  sketchSessionNameRef.current = sketchSessionName;
  const sketchBasis = useMemo(() => {
    const sessionDocument = sketchDocumentRef.current;
    if (!sketchSessionPlane || !sessionDocument) {
      return null;
    }
    try {
      return resolvedSketchPlaneBasis(
        sessionDocument,
        sketchSessionPlane,
        (value) => evalParamValue(value, parameterScopeRef.current.scope) ?? 0,
        sketchSessionNameRef.current
      );
    } catch {
      return null;
    }
  }, [sketchSessionPlane]);

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
    const resolve = (value: unknown): number =>
      evalParamValue(value as ParamValue, parameterScope.scope) ?? 0;
    let profiles: {
      outer: { x: number; y: number }[];
      holes: { x: number; y: number }[][];
    }[] = [];
    try {
      profiles = computeSketchRegions(objects, resolve).map((profile) => ({
        outer: profile.outer.polyline,
        holes: profile.holes.map((hole) => hole.polyline)
      }));
    } catch {
      // An unresolved parameter must not make the sketch session disappear.
    }
    return {
      basis: sketchBasis,
      tool: session.tool,
      circleMode: session.circleMode,
      snapStep: appSettings.sketching.snapEnabled
        ? appSettings.sketching.linearSnap
        : null,
      gridVisible: appSettings.sketching.gridVisible,
      geometrySnapEnabled: appSettings.sketching.geometrySnapEnabled,
      inferenceEnabled: appSettings.sketching.inferenceEnabled,
      snapTolerancePx: appSettings.sketching.snapTolerancePx,
      drawing: session.drawing,
      objects,
      profiles,
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

  // ---------------------------------------------------------------------
  // Sketch constraints (stage 1): pick routing, CRUD, and solve-apply.
  // ---------------------------------------------------------------------
  const [sketchSolveStatus, setSketchSolveStatus] =
    useState<SketchSolveStatus | null>(null);
  const [sketchSolving, setSketchSolving] = useState(false);
  // The pill describes a solve of THIS session's sketch; leaving sketch mode
  // orphans it.
  useEffect(() => {
    if (interaction.mode !== 'sketch') {
      setSketchSolveStatus(null);
      setSketchSolving(false);
    }
  }, [interaction.mode]);

  const editingSketchNode =
    interaction.mode === 'sketch' && interaction.session.sketchId && doc
      ? (findSketch(doc, interaction.session.sketchId as SketchId) ?? null)
      : null;

  const sketchConstraintItems = useMemo(() => {
    if (!editingSketchNode || !doc) {
      return [];
    }
    const nameOf = (objectId: EntityId) => {
      const node = doc.nodes[objectId];
      return node?.kind === 'sketch-object'
        ? node.name || node.data.objectKind
        : 'entity';
    };
    return (editingSketchNode.constraints ?? []).map(
      ({ constraintId, data }) => ({
        constraintId: String(constraintId),
        label: describeConstraint(data, nameOf)
      })
    );
  }, [editingSketchNode, doc]);

  /**
   * Routes a sketch click while a constraint tool is armed. Returns true
   * when the click was consumed — an armed tool never falls through to
   * selection, even on a miss, so a stray click cannot silently deselect
   * mid-sequence.
   */
  function handleSketchConstraintPick(
    objectId: string | null,
    snapPoint: { objectId: string; point: 'start' | 'end' | 'center' } | null
  ): boolean {
    if (
      interaction.mode !== 'sketch' ||
      !interaction.session.pendingConstraint
    ) {
      return false;
    }
    if (!doc || !editingSketchNode) {
      return true;
    }
    const pending = interaction.session.pendingConstraint;
    const spec = constraintToolSpec(pending.kind);
    const pick: ConstraintPick | null =
      spec.pickKind === 'point'
        ? snapPoint
          ? { kind: 'point', ...snapPoint }
          : null
        : objectId
          ? { kind: 'object', objectId }
          : null;
    if (!pick) {
      setStatus(spec.hint);
      return true;
    }
    const refusal = refusePick(
      doc,
      editingSketchNode,
      pending.kind,
      pending.picks,
      pick
    );
    if (refusal) {
      setStatus(refusal);
      return true;
    }
    const picks = [...pending.picks, pick];
    if (picks.length < spec.picks) {
      dispatchInteraction({ type: 'sketch-constraint-pick', pick });
      setStatus(`${spec.label}: pick ${picks.length + 1} of ${spec.picks}.`);
      return true;
    }
    const built = buildConstraint(doc, editingSketchNode, pending.kind, picks);
    if ('error' in built) {
      setStatus(built.error);
    } else if (
      executeCommand(
        commandFactories.addSketchConstraint(
          {
            sketchId: editingSketchNode.sketchId,
            constraint: built.data
          },
          `Add ${spec.label.toLowerCase()} constraint`
        )
      )
    ) {
      setSketchSolveStatus(null);
      setStatus(`${spec.label} constraint added · Solve applies it.`);
    }
    dispatchInteraction({ type: 'sketch-constraint-tool', kind: null });
    return true;
  }

  function handleDeleteSketchConstraint(constraintId: string) {
    if (!editingSketchNode) {
      return;
    }
    if (
      executeCommand(
        commandFactories.deleteSketchConstraint(
          {
            sketchId: editingSketchNode.sketchId,
            constraintId: toSketchConstraintId(constraintId)
          },
          'Delete constraint'
        )
      )
    ) {
      setSketchSolveStatus(null);
      setStatus('Deleted constraint.');
    }
  }

  async function handleSolveSketch() {
    if (!doc || !editingSketchNode || sketchSolving) {
      return;
    }
    setSketchSolving(true);
    try {
      const outcome = await geometry.solveSketch(
        doc,
        editingSketchNode.sketchId
      );
      setSketchSolveStatus({
        label: solveStatusLabel(outcome),
        tone:
          outcome.classification === 'solved'
            ? 'ok'
            : outcome.classification === 'underConstrained'
              ? 'info'
              : 'warn'
      });
      if (!outcome.converged || outcome.rolledBack) {
        setStatus('Constraints did not solve; sketch geometry left unchanged.');
        return;
      }
      const commands = solvedSketchCommands(
        doc,
        editingSketchNode.sketchId,
        outcome
      );
      if (commands.length === 0) {
        setStatus('Sketch already satisfies its constraints.');
        return;
      }
      if (executeTransaction('Solve sketch', commands)) {
        setStatus(
          `Solved sketch · ${commands.length} ${commands.length === 1 ? 'entity' : 'entities'} updated · ${solveStatusLabel(outcome)}.`
        );
      }
    } catch (error) {
      setSketchSolveStatus({ label: 'Solve failed', tone: 'warn' });
      setStatus(
        error instanceof Error
          ? `Sketch solve failed: ${error.message}`
          : 'Sketch solve failed.'
      );
    } finally {
      setSketchSolving(false);
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
    setResolvedExtrudePreview(null);
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
    setResolvedExtrudePreview(null);
    setSelectedSketchProfileId(region.sketchId as SketchId);
    setSelectedFeatureNode(null);
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
      interaction.mode === 'face' &&
      interaction.op === 'edit-fillet' &&
      interaction.phase !== 'validating' &&
      interaction.target.blendRadius !== undefined &&
      interaction.target.radialDirection
    ) {
      return {
        bodyId: interaction.target.bodyId,
        topologyId: interaction.target.topologyId,
        op: 'fillet' as const,
        edgeCount: 1,
        initialValue: interaction.lastValue ?? interaction.target.blendRadius,
        placement: {
          origin: {
            x: interaction.target.point[0],
            y: interaction.target.point[1],
            z: interaction.target.point[2]
          },
          direction: {
            x: interaction.target.radialDirection[0],
            y: interaction.target.radialDirection[1],
            z: interaction.target.radialDirection[2]
          }
        },
        label: 'Edit Fillet',
        allowRemoval: true
      };
    }
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
    const primitive =
      doc && target.hash !== undefined
        ? primitiveCylinderHeightAncestor(
            doc,
            target.bodyId as BodyId,
            target.reference,
            target.hash
          )
        : null;
    const totalBaseline =
      primitive?.data.featureKind === 'primitive' &&
      primitive.data.primitiveKind === 'cylinder' &&
      typeof primitive.data.dimensions.height === 'number'
        ? primitive.data.dimensions.height
        : undefined;
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
      initialValue:
        renderedOffsetPreview ??
        offsetPreviewValueRef.current ??
        interaction.lastValue ??
        0,
      ...(totalBaseline === undefined ? {} : { totalBaseline })
    };
  }, [doc, interaction, renderedOffsetPreview]);

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
      originalRadius: target.radius,
      smoothPreview:
        target.concavity === 'boss' &&
        supportsRadialCylinderPreview(
          representations[target.bodyId as BodyId],
          {
            x: target.axisStart[0],
            y: target.axisStart[1],
            z: target.axisStart[2]
          },
          {
            x: target.axisEnd[0],
            y: target.axisEnd[1],
            z: target.axisEnd[2]
          }
        )
    };
  }, [interaction, representations]);
  const cylinderSelectionKey =
    interaction.mode === 'face' && interaction.op === 'resize-cylinder-radius'
      ? `${interaction.target.bodyId}:${interaction.target.topologyId}`
      : null;
  useEffect(() => {
    setCylinderDimensionMode('diameter');
  }, [cylinderSelectionKey]);

  function buildCylinderRadiusCommand(
    radius: ParamValue
  ): { command: AnyCommand; sourceFeatureId?: FeatureId } | null {
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

    if (
      target.featureType === 'through-hole' &&
      target.diameter !== undefined
    ) {
      const diameter: ParamValue =
        typeof radius === 'number' ? radius * 2 : `(${radius}) * 2`;
      return {
        command: commandFactories.directEditBody({
          name: 'Resize Through Hole',
          targetBodyId: target.bodyId as BodyId,
          operation: {
            kind: 'resize-through-hole',
            faceHash: target.hash,
            ...(target.reference ? { faceReference: target.reference } : {}),
            sourceDiameter: target.diameter,
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
            diameter
          }
        })
      };
    }

    // Preserve the parametric source edit through any uninterrupted chain of
    // fillet/chamfer result bodies. Their stored lineage regenerates the exact
    // downstream B-reps; arbitrary result features and direct edits remain on
    // the strict generic cylindrical-face path.
    const primitive = primitiveCylinderRadiusAncestor(
      base,
      target.bodyId as BodyId
    );
    if (primitive?.data.featureKind === 'primitive') {
      return {
        command: commandFactories.updateFeature(
          {
            featureId: primitive.featureId,
            data: {
              dimensions: {
                ...primitive.data.dimensions,
                radius
              }
            }
          },
          radialFaceOperationName(target)
        ),
        sourceFeatureId: primitive.featureId
      };
    }

    return {
      command: commandFactories.directEditBody({
        // The history row and the command card read the same name, so a
        // feature is called the same thing while it runs and afterwards.
        name: radialFaceOperationName(target),
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
      })
    };
  }

  function handleCylinderRadiusPreview(radius: number, exactGeometry = true) {
    const current = interactionRef.current;
    if (
      current.mode !== 'face' ||
      current.op !== 'resize-cylinder-radius' ||
      current.target.radius === undefined ||
      !isValidCylinderRadius(radius, current.target.radius)
    ) {
      return;
    }
    if (exactGeometry) {
      cylinderRadiusPreview.request(radius);
    } else {
      // A simple standalone cylinder is projected with a disposable viewport
      // transform during drag. Drop any older worker result so it cannot flash
      // over that proxy; release still validates one exact kernel rebuild.
      cylinderRadiusPreview.clear();
    }
  }

  function handleCylinderRadiusCancel() {
    cylinderRadiusPreview.clear();
  }

  function handleCylinderRadiusCommit(radius: number, exact?: ParamValue) {
    if (!requireExactGeometryReady()) {
      return false;
    }
    const current = interactionRef.current;
    if (current.mode !== 'face' || current.op !== 'resize-cylinder-radius') {
      return false;
    }
    const sourceRadius = current.target.radius;
    const plan = buildCylinderRadiusCommand(exact ?? radius);
    if (
      sourceRadius === undefined ||
      !isValidCylinderRadius(radius, sourceRadius) ||
      !plan
    ) {
      setStatus('Radius is too small to form valid geometry at this scale.');
      return false;
    }
    void executeValidatedDirectEdit(
      plan.command,
      current.target.bodyId as BodyId,
      `Adjusted cylinder ${cylinderDimensionMode === 'diameter' ? 'diameter' : 'radius'} to ${cylinderDimensionMode === 'diameter' ? 'Ø' : 'R'} ${formatNumber(cylinderDimensionMode === 'diameter' ? radius * 2 : radius)} ${doc?.units ?? ''}.`,
      radius,
      undefined,
      plan.sourceFeatureId
        ? affectedFeatureTargets(
            managerRef.current!.document,
            plan.sourceFeatureId
          )
        : undefined
    );
    return true;
  }

  /**
   * Live fillet/chamfer preview while the radius handle drags. One rebuild
   * in flight, newest value wins, and it gives up for the rest of the
   * gesture if the kernel gets slow.
   */
  const edgePreview = useRef(
    new LivePreview<ProjectDocument, ProjectDocument['derived']>({
      build: (size) => {
        const base = managerRef.current?.document;
        const command = base ? buildEdgeModifierCommand(size, base) : null;
        return command && base ? command.apply(base) : null;
      },
      derive: (document) => geometry.syncOnce(document),
      publish: (preview) => {
        if (!preview) {
          setPreviewDoc(null);
          setPreviewBlendFaces([]);
          return;
        }
        setPreviewDoc({ ...preview.document, derived: preview.derived });
        const current = interactionRef.current;
        const base = managerRef.current?.document;
        setPreviewBlendFaces(
          current.mode === 'edges' && current.op === 'fillet' && base
            ? newBlendFaceSelections(base, preview.derived)
            : []
        );
      },
      acceptValue: (size) => {
        const current = interactionRef.current;
        return (
          Number.isFinite(size) &&
          (current.mode === 'face' && current.op === 'edit-fillet'
            ? size >= 0
            : size > 0)
        );
      }
    })
  ).current;

  function buildEdgeModifierCommand(
    size: ParamValue,
    baseDocument?: ProjectDocument
  ): AnyCommand | null {
    const currentInteraction = interactionRef.current;
    if (
      currentInteraction.mode === 'face' &&
      currentInteraction.op === 'edit-fillet' &&
      currentInteraction.target.filletFeatureId
    ) {
      const base = baseDocument ?? managerRef.current?.document;
      const feature = base
        ? findFeature(base, currentInteraction.target.filletFeatureId)
        : null;
      if (feature?.data.featureKind !== 'fillet') {
        return null;
      }
      const evaluated =
        typeof size === 'number'
          ? size
          : base
            ? evalParamValue(size, getParameterScope(base).scope)
            : null;
      return evaluated !== null && evaluated <= 1e-9
        ? commandFactories.deleteFeature(
            { featureId: feature.featureId },
            `Remove ${feature.name}`
          )
        : commandFactories.updateFeature(
            { featureId: feature.featureId, data: { radius: size } },
            `Edit ${feature.name}`
          );
    }
    if (
      currentInteraction.mode === 'face' &&
      currentInteraction.op === 'edit-fillet' &&
      currentInteraction.target.canResizeImportedBlend
    ) {
      const target = currentInteraction.target;
      if (
        target.hash === undefined ||
        target.blendRadius === undefined ||
        !target.blendSurfaceClass ||
        !target.blendCenter ||
        !target.blendAxis
      ) {
        return null;
      }
      return commandFactories.directEditBody({
        name: 'Resize Imported Blend',
        targetBodyId: target.bodyId as BodyId,
        operation: {
          kind: 'resize-blend',
          faceHash: target.hash,
          ...(target.reference ? { faceReference: target.reference } : {}),
          surfaceClass: target.blendSurfaceClass,
          recordedRadius: target.blendRadius,
          recordedCenter: {
            x: target.blendCenter[0],
            y: target.blendCenter[1],
            z: target.blendCenter[2]
          },
          recordedAxis: {
            x: target.blendAxis[0],
            y: target.blendAxis[1],
            z: target.blendAxis[2]
          },
          newRadius: size
        }
      });
    }
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
    if (interaction.mode === 'face' && interaction.op === 'edit-fillet') {
      handleFilletFaceCommit(size, exact);
      return;
    }
    if (interaction.mode !== 'edges') {
      return;
    }
    edgePreview.clear();
    const rounded = Math.round(size * 1000) / 1000;
    const command = buildEdgeModifierCommand(exact ?? rounded);
    if (
      !command ||
      rounded <= 0 ||
      !('targetBodyId' in command.payload) ||
      !('edgeHashes' in command.payload)
    ) {
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
    if (
      interaction.mode !== 'edges' &&
      !(interaction.mode === 'face' && interaction.op === 'edit-fillet')
    ) {
      return;
    }
    dispatchInteraction({ type: 'keypad-open' });
    setKeypad({
      kind: 'edge',
      label:
        interaction.mode === 'face' || interaction.op === 'fillet'
          ? 'Radius'
          : 'Distance',
      initial:
        currentSize > 0 ? String(Math.round(currentSize * 100) / 100) : '',
      unitKind: 'length'
    });
  }

  function handleEdgeCancel() {
    edgePreview.clear();
  }

  function filletRemovalTargets(
    base: ProjectDocument,
    feature: FeatureNode
  ): AffectedFeatureTarget[] {
    if (feature.data.featureKind !== 'fillet') {
      return [];
    }
    const targetBodyId = feature.data.targetBodyId;
    const source = listFeaturesInOrder(base).find(
      (candidate) => candidate.bodyId === targetBodyId
    );
    return [
      {
        featureName: source?.name ?? feature.name,
        featureId: source?.featureId ?? feature.featureId,
        resultBodyId: targetBodyId
      },
      ...affectedFeatureTargets(base, feature.featureId).slice(1)
    ];
  }

  /** Commit a native history fillet or an exact imported-band direct edit. */
  function handleFilletFaceCommit(size: number, exact?: ParamValue) {
    if (!requireExactGeometryReady()) {
      return;
    }
    const current = interactionRef.current;
    const base = managerRef.current?.document;
    if (
      !base ||
      current.mode !== 'face' ||
      current.op !== 'edit-fillet' ||
      size < 0
    ) {
      return;
    }
    const feature = current.target.filletFeatureId
      ? findFeature(base, current.target.filletFeatureId)
      : null;
    const imported = current.target.canResizeImportedBlend === true;
    if (
      current.target.filletFeatureId &&
      feature?.data.featureKind !== 'fillet'
    ) {
      setStatus('The producing Fillet feature no longer exists.');
      dispatchInteraction({ type: 'clear' });
      return;
    }
    if (!imported && feature?.data.featureKind !== 'fillet') {
      return;
    }
    const command = buildEdgeModifierCommand(exact ?? size, base);
    if (!command) {
      return;
    }
    edgePreview.clear();
    const removing = size <= 1e-9;
    const sourceFace = base.derived.bodyRepresentations[
      current.target.bodyId as BodyId
    ]?.topology?.faces.find(
      (face) => face.topologyId === current.target.topologyId
    );
    const committedDirectEditFeatureId =
      imported &&
      'ids' in command.payload &&
      command.payload.ids &&
      'featureId' in command.payload.ids
        ? String(command.payload.ids.featureId)
        : undefined;
    const targetBodyId = removing
      ? feature?.data.featureKind === 'fillet'
        ? feature.data.targetBodyId
        : (current.target.bodyId as BodyId)
      : (current.target.bodyId as BodyId);
    const validationTargets =
      feature?.data.featureKind === 'fillet'
        ? removing
          ? filletRemovalTargets(base, feature)
          : affectedFeatureTargets(base, feature.featureId)
        : undefined;
    void executeValidatedDirectEdit(
      command,
      targetBodyId,
      removing
        ? feature
          ? `Removed ${feature.name}.`
          : 'Removed imported blend.'
        : `Set ${feature?.name ?? 'imported blend'} radius to R ${formatNumber(size)} ${base.units}.`,
      size,
      removing
        ? undefined
        : () => {
            const committed = managerRef.current?.document;
            const faces =
              committed?.derived.bodyRepresentations[
                current.target.bodyId as BodyId
              ]?.topology?.faces;
            const regenerated =
              faces && sourceFace
                ? feature
                  ? resolveFilletBlendFace(faces, sourceFace)
                  : resolveImportedBlendFace(
                      faces,
                      sourceFace,
                      committedDirectEditFeatureId
                    )
                : null;
            if (!regenerated?.geometry) {
              return;
            }
            const importedSnapshot = importedBlendSnapshot(regenerated);
            const radial = blendRadialDirection(
              regenerated.geometry,
              {
                x: current.target.point[0],
                y: current.target.point[1],
                z: current.target.point[2]
              },
              current.target.radialDirection
                ? {
                    x: current.target.radialDirection[0],
                    y: current.target.radialDirection[1],
                    z: current.target.radialDirection[2]
                  }
                : {
                    x: current.target.normal[0],
                    y: current.target.normal[1],
                    z: current.target.normal[2]
                  }
            );
            const { reference: _staleReference, ...stableTarget } =
              current.target;
            const nextTarget: FaceTarget = {
              ...stableTarget,
              topologyId: regenerated.topologyId,
              hash: regenerated.hash,
              ...(regenerated.reference
                ? { reference: regenerated.reference }
                : {}),
              blendRadius: size,
              surfaceCenter: [
                regenerated.geometry.center.x,
                regenerated.geometry.center.y,
                regenerated.geometry.center.z
              ],
              ...(importedSnapshot
                ? {
                    canResizeImportedBlend: true,
                    blendSurfaceClass: importedSnapshot.surfaceClass,
                    blendCenter: [
                      importedSnapshot.center.x,
                      importedSnapshot.center.y,
                      importedSnapshot.center.z
                    ] as [number, number, number],
                    blendAxis: [
                      importedSnapshot.axis.x,
                      importedSnapshot.axis.y,
                      importedSnapshot.axis.z
                    ] as [number, number, number],
                    ...(committedDirectEditFeatureId
                      ? { directEditFeatureId: committedDirectEditFeatureId }
                      : {})
                  }
                : {}),
              ...(radial
                ? {
                    radialDirection: [radial.x, radial.y, radial.z] as [
                      number,
                      number,
                      number
                    ]
                  }
                : {})
            };
            const selection: TopologySelection = {
              bodyId: current.target.bodyId as BodyId,
              kind: 'face',
              topologyId: regenerated.topologyId,
              hash: regenerated.hash,
              ...(regenerated.reference
                ? { reference: regenerated.reference }
                : {})
            };
            setSelectedTopology(selection);
            setSelectedBodyIds([current.target.bodyId as BodyId]);
            const committedFeature = committed
              ? [...listFeaturesInOrder(committed)]
                  .reverse()
                  .find(
                    (candidate) =>
                      candidate.data.featureKind === 'direct-edit' &&
                      candidate.data.targetBodyId === current.target.bodyId
                  )
              : null;
            selectFeatureNode(
              feature?.id ?? committedFeature?.id ?? null,
              'inferred'
            );
            dispatchInteraction({ type: 'select-face', target: nextTarget });
          },
      validationTargets
    );
  }

  /** Chip tapped: open the anchored keypad prefilled with the drag value. */
  function handleOpenOffsetKeypad(
    currentOffset: number,
    totalBaseline?: number
  ) {
    if (interaction.mode !== 'face' && interaction.mode !== 'region') {
      return;
    }
    dispatchInteraction({ type: 'keypad-open' });
    setKeypad({
      kind: 'offset',
      label:
        totalBaseline === undefined
          ? interaction.mode === 'region'
            ? 'Height'
            : 'Offset'
          : 'Total',
      initial:
        totalBaseline !== undefined || currentOffset !== 0
          ? String(
              Math.round(((totalBaseline ?? 0) + currentOffset) * 100) / 100
            )
          : '',
      unitKind: 'length',
      ...(totalBaseline === undefined ? {} : { totalBaseline })
    });
  }

  function handleOpenCylinderRadiusKeypad(
    radius: number,
    dimensionMode: DimensionMode
  ) {
    if (
      interaction.mode !== 'face' ||
      interaction.op !== 'resize-cylinder-radius'
    ) {
      return;
    }
    dispatchInteraction({ type: 'keypad-open' });
    setKeypad({
      kind: 'radius',
      label: dimensionMode === 'diameter' ? 'Diameter' : 'Radius',
      initial: String(dimensionMode === 'diameter' ? radius * 2 : radius),
      unitKind: 'length',
      dimensionMode,
      baseline: interaction.target.radius
    });
  }

  function reportOffsetPreviewFailure(message: string, value: number) {
    const current = interactionRef.current;
    if (current.mode !== 'face' || current.op !== 'offset-face') {
      return;
    }
    setPreviewDoc(null);
    setRenderedOffsetPreview(null);
    dispatchInteraction({
      type: 'validation-failed',
      diagnostic: { message },
      value
    });
    setStatus(`Offset preview refused: ${message}`);
  }

  function recoverOffsetPreviewInteraction() {
    const current = interactionRef.current;
    if (
      current.mode !== 'face' ||
      current.op !== 'offset-face' ||
      current.phase !== 'failed'
    ) {
      return;
    }
    dispatchInteraction({ type: 'recover' });
    dispatchInteraction({
      type: keypadRef.current?.kind === 'offset' ? 'keypad-open' : 'drag-engage'
    });
  }

  function handleOffsetPreview(offset: number) {
    const current = interactionRef.current;
    if (
      current.mode !== 'face' ||
      current.op !== 'offset-face' ||
      current.phase === 'validating'
    ) {
      return;
    }
    offsetPreviewValueRef.current = offset;
    if (Math.abs(offset) <= 1e-9) {
      offsetPreview.clear();
      setPreviewDeferred(false);
      recoverOffsetPreviewInteraction();
      return;
    }
    offsetPreview.request(offset);
  }

  function handleOffsetCancel() {
    offsetPreview.clear();
    // clear() re-arms the slow-frame guard, so the chip must stop reporting a
    // paused preview too. Commit and validation failure already do this; a
    // canceled gesture left it latched until the next one of those.
    setPreviewDeferred(false);
    offsetPreviewValueRef.current = null;
    setRenderedOffsetPreview(null);
    const current = interactionRef.current;
    if (current.mode === 'face' && current.op === 'offset-face') {
      // Re-selecting the same semantic target resets the existing lifecycle
      // to armed, including a failed value, without adding a machine state.
      dispatchInteraction({ type: 'select-face', target: current.target });
    }
  }

  function handleSelectionAction(action: SelectionActionId) {
    if (
      (action === 'sketch-on-face' ||
        action === 'fillet' ||
        action === 'chamfer' ||
        action === 'remove-fillet' ||
        action === 'remove-face-feature') &&
      !requireExactGeometryReady()
    ) {
      return;
    }
    if (action === 'sketch-on-face' && interaction.mode === 'face') {
      startSketchOnFace(interaction.target);
      return;
    }
    if (action === 'export-face-dxf' && interaction.mode === 'face') {
      void handleExportFaceDxf(interaction.target);
      return;
    }
    if (
      action === 'remove-fillet' &&
      interaction.mode === 'face' &&
      interaction.op === 'edit-fillet'
    ) {
      handleFilletFaceCommit(0);
      return;
    }
    if (
      action === 'remove-face-feature' &&
      interaction.mode === 'face' &&
      interaction.op === 'remove-face-feature'
    ) {
      const face = representations[
        interaction.target.bodyId as BodyId
      ]?.topology?.faces.find(
        (candidate) => candidate.topologyId === interaction.target.topologyId
      );
      if (face?.geometry) {
        handleRemoveFaceFeature(
          {
            bodyId: interaction.target.bodyId as BodyId,
            kind: 'face',
            topologyId: face.topologyId,
            hash: face.hash,
            ...(face.reference ? { reference: face.reference } : {})
          },
          face.geometry
        );
      }
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
   * A cap drag on a cylinder means "make it this tall", not "push this disc".
   * Once the rim is filleted the blend belongs to the edge, so offsetting the
   * flat remainder alone leaves a step where the part should simply have
   * grown. Retarget the drag onto the primitive's height whenever the picked
   * face is provably its top cap; the wall stretches and the fillet
   * regenerates at the new rim, which is what keeping the modifier in history
   * is for. Anything unproven stays on the generic offset.
   */
  function buildCylinderHeightCommand(
    face: FaceTopology,
    faceHash: number,
    bodyId: BodyId,
    offset: number,
    exact?: ParamValue,
    baseDocument?: ProjectDocument
  ): {
    command: AnyCommand;
    sourceFeatureId: FeatureId;
    height: number;
  } | null {
    const base = baseDocument ?? managerRef.current?.document;
    if (!base || Math.abs(offset) <= 1e-9) {
      return null;
    }
    const primitive = primitiveCylinderHeightAncestor(
      base,
      bodyId,
      face.reference,
      faceHash
    );
    const dimensions =
      primitive?.data.featureKind === 'primitive'
        ? primitive.data.dimensions
        : null;
    // The ancestry only resolves against a numeric height; narrowing here
    // keeps that guarantee visible instead of casting it away.
    if (!primitive || !dimensions || typeof dimensions.height !== 'number') {
      return null;
    }
    // The drag was measured along the cap's outward normal, which is the
    // primitive's own axis direction whatever rigid placement it sits under,
    // so the gesture is a signed delta on the stored height. `offset` is the
    // evaluated distance even when `exact` is a typed expression; composing
    // keeps that expression live in the document.
    const height = dimensions.height + offset;
    return {
      command: commandFactories.updateFeature(
        {
          featureId: primitive.featureId,
          data: {
            dimensions: {
              ...dimensions,
              height:
                typeof exact === 'string'
                  ? `${dimensions.height} + (${exact})`
                  : Math.round(height * 1000) / 1000
            }
          }
        },
        'Resize Cylinder Height'
      ),
      sourceFeatureId: primitive.featureId,
      height
    };
  }

  function buildOffsetEditPlan(
    offset: number,
    exact?: ParamValue,
    baseDocument?: ProjectDocument
  ): OffsetEditPlan | null {
    const current = interactionRef.current;
    const base = baseDocument ?? managerRef.current?.document;
    if (!base || current.mode !== 'face' || current.op !== 'offset-face') {
      return null;
    }
    const target = current.target;
    const bodyId = target.bodyId as BodyId;
    const faceTopology = base.derived.bodyRepresentations[
      bodyId
    ]?.topology?.faces.find(
      (face) =>
        face.topologyId === target.topologyId ||
        (target.hash !== undefined && face.hash === target.hash)
    );
    const geometry = faceTopology?.geometry;
    if (
      !faceTopology ||
      geometry?.surfaceType !== 'plane' ||
      target.hash === undefined
    ) {
      return null;
    }
    const heightPlan = buildCylinderHeightCommand(
      faceTopology,
      target.hash,
      bodyId,
      offset,
      exact,
      base
    );
    if (heightPlan) {
      return {
        command: heightPlan.command,
        bodyId,
        successMessage: `Cylinder height set to ${formatNumber(heightPlan.height)} ${base.units}.`,
        validationTargets: affectedFeatureTargets(
          base,
          heightPlan.sourceFeatureId
        ),
        ...(heightPlan.height <= 0
          ? {
              preflightRejection:
                'That distance would leave the cylinder with no height.'
            }
          : {})
      };
    }
    return {
      command: commandFactories.directEditBody({
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
          sourceNormal: {
            x: target.normal[0],
            y: target.normal[1],
            z: target.normal[2]
          },
          offset: exact ?? Math.round(offset * 1000) / 1000
        }
      }),
      bodyId,
      successMessage: `Offset face by ${Math.round(offset * 100) / 100} ${base.units}.`
    };
  }

  /**
   * Face-offset commit as a validated direct edit. `exact` preserves a typed
   * expression as the stored parametric value; plain drags store the number.
   */
  function handleOffsetCommit(offset: number, exact?: ParamValue): boolean {
    // The arrow rig is shared: in region mode its drag is an extrude height.
    if (interaction.mode === 'region') {
      handleRegionExtrudeCommit(offset, exact);
      return true;
    }
    const current = interactionRef.current;
    if (current.mode !== 'face' || current.op !== 'offset-face') {
      return false;
    }
    if (!requireExactGeometryReady()) {
      return false;
    }
    if (current.phase === 'failed') {
      setStatus(
        current.error?.message ?? 'The current offset preview is invalid.'
      );
      return false;
    }
    const plan = buildOffsetEditPlan(offset, exact);
    if (!plan) {
      setStatus('Exact face measurements are unavailable for this offset.');
      dispatchInteraction({ type: 'clear' });
      return false;
    }
    if (plan.preflightRejection) {
      reportOffsetPreviewFailure(plan.preflightRejection, offset);
      return false;
    }
    offsetPreview.clear();
    offsetPreviewValueRef.current = null;
    void executeValidatedDirectEdit(
      plan.command,
      plan.bodyId,
      plan.successMessage,
      offset,
      undefined,
      plan.validationTargets
    );
    return true;
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

  /**
   * Open the existing feature a refusal named.
   *
   * The recorded failure told the user to go and edit an earlier fillet and
   * left them to find it. The rejection already knows which feature refused,
   * so this is routing rather than new attribution: clear the failed command
   * and select that feature exactly as clicking it in the tree would.
   */
  function handleEditCulpritFeature(featureId: string) {
    const node = doc
      ? Object.values(doc.nodes).find(
          (candidate) =>
            candidate.kind === 'feature' && candidate.featureId === featureId
        )
      : undefined;
    if (!node) {
      return;
    }
    handleSelectFeatureFromTree(node.id);
  }

  function handleSelectFeatureFromTree(nodeId: string) {
    setTool(null);
    setExtrudePreview(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    // Picking in the tree is a selection change like any other. Dropping the
    // topology selection while leaving the machine armed would leave a command
    // running against geometry the panel no longer shows.
    dispatchInteraction({ type: 'clear' });
    const next = selectedFeatureNodeId === nodeId ? null : nodeId;
    selectFeatureNode(next, 'pinned');
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
      inferFeatureNodeFor(nextIds[0]!);
    } else {
      setSelectedFeatureNode(null);
    }
    setStatus(
      nextIds.length > 0
        ? `${nextIds.length} ${nextIds.length === 1 ? 'body' : 'bodies'} selected.`
        : 'Body selection cleared.'
    );
  }

  /**
   * Include or exclude one declared solid of an imported STEP feature. The
   * inspector disables removing the last included solid, and the adapter
   * refuses an empty selection as a build warning if one arrives anyway.
   */
  function handleToggleImportedSolid(featureId: FeatureId, solidIndex: number) {
    if (!doc) {
      return;
    }
    const feature = findFeature(doc, featureId);
    if (
      !feature ||
      feature.data.featureKind !== 'imported-step' ||
      !feature.bodyId
    ) {
      return;
    }
    const declared =
      doc.derived.bodyRepresentations[feature.bodyId]
        ?.importedStepDeclaredSolidCount ?? 0;
    if (declared === 0) {
      return;
    }
    const current =
      feature.data.solidIndices ??
      Array.from({ length: declared }, (_, index) => index);
    const excluding = current.includes(solidIndex);
    const next = excluding
      ? current.filter((index) => index !== solidIndex)
      : [...current, solidIndex].sort((a, b) => a - b);
    if (next.length === 0) {
      return;
    }
    executeCommand(
      commandFactories.updateFeature(
        { featureId, data: { solidIndices: next } },
        excluding ? 'Exclude imported solid' : 'Include imported solid'
      )
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

  function handleReorderFeature(featureId: FeatureId, toIndex: number) {
    const name =
      doc &&
      listFeaturesInOrder(doc).find((f) => f.featureId === featureId)?.name;
    executeCommand(
      commandFactories.moveFeature(
        { featureId, toIndex },
        name ? `Reorder ${name}` : 'Reorder feature'
      )
    );
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
    // View mode gets the viewport menu whatever was clicked: the selection
    // menu is entirely modeling actions, and an empty one would be worse than
    // the viewport controls someone reading a model actually wants.
    if (!selection || modelingLocked) {
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

  /** What kind of face the armed repair is waiting for, for the prompt. */
  function faceRepairPickHint(repair: StaleDirectEditFaceRepair): string {
    switch (repair.operationKind) {
      case 'offset-face':
        return 'planar face';
      case 'resize-cylindrical-face':
        return 'cylindrical face';
      case 'resize-through-hole':
        return 'through-hole wall';
    }
  }

  function armFaceRepair(repair: StaleDirectEditFaceRepair) {
    if (!ensureCanEdit('repair a feature')) {
      return;
    }
    setTool(null);
    setExtrudePreview(null);
    clearSelection();
    setFaceRepair(repair);
    const bodyName =
      representations[repair.targetBodyId]?.name ?? 'the edited body';
    setStatus(
      `Re-pick the face for "${repair.featureName}": click the ${faceRepairPickHint(repair)} on ${bodyName} · Esc cancels.`
    );
  }

  /**
   * Consumes a viewport pick while a face re-pick is armed. A pick that
   * cannot repair the feature keeps the re-pick armed and says why, so the
   * user can simply click again; only a validated commit or Escape ends it.
   */
  function handleFaceRepairPick(selection: TopologySelection | null) {
    const repair = faceRepair;
    if (!repair || !doc) {
      return;
    }
    const feature = findFeature(doc, repair.featureId);
    if (!feature || feature.data.featureKind !== 'direct-edit') {
      setFaceRepair(null);
      setStatus('The feature to repair is no longer in the document.');
      return;
    }
    if (!selection) {
      setStatus(
        `Click the face for "${repair.featureName}" · Esc cancels the re-pick.`
      );
      return;
    }
    if (!exactGeometryReady) {
      setStatus(
        'Exact geometry is still rebuilding. Try the re-pick again in a moment.'
      );
      return;
    }
    if (selection.kind !== 'face' || selection.bodyId !== repair.targetBodyId) {
      const bodyName =
        representations[repair.targetBodyId]?.name ?? 'the edited body';
      setStatus(
        `Pick a ${faceRepairPickHint(repair)} on ${bodyName} to repair "${repair.featureName}" · Esc cancels.`
      );
      return;
    }
    const face = representations[selection.bodyId]?.topology?.faces.find(
      (candidate) => candidate.topologyId === selection.topologyId
    );
    if (!face) {
      setStatus('That face has no exact measurements; pick another face.');
      return;
    }
    try {
      const operation = repairedDirectEditOperation(
        feature.data.operation,
        face
      );
      const targets = affectedFeatureTargets(doc, repair.featureId);
      void executeValidatedFeature(
        commandFactories.updateFeature(
          { featureId: repair.featureId, data: { operation } },
          `Re-pick face for ${feature.name}`
        ),
        {
          featureName: feature.name,
          resultBodyId: repair.targetBodyId,
          ...(targets.length > 0 ? { targets } : {}),
          validatingMessage: `Rebuilding "${feature.name}" with the re-picked face…`,
          successMessage: `"${feature.name}" rebuilt with the re-picked face.`,
          onSuccess: () => setFaceRepair(null),
          // The refusal belongs in the status bar (there is no open feature
          // form for the host sink to render into), and the re-pick stays
          // armed so the next click can try a different face.
          onFailure: () => {}
        }
      );
    } catch (error) {
      setStatus(errorMessage(error, 'That face cannot carry this edit.'));
    }
  }

  function handleFeatureContextMenu(
    event: React.MouseEvent,
    feature: FeatureNode
  ) {
    const bodyId = feature.bodyId ?? null;
    const body = bodyId ? representations[bodyId] : null;
    const repair = staleDirectEditFaceRepair(feature, warnings);
    openContextMenu(event.clientX, event.clientY, [
      {
        item: { id: 'edit', label: 'Edit Properties' },
        run: () => handleSelectFeatureFromTree(feature.id)
      },
      ...(repair
        ? [
            {
              item: {
                id: 'repair-face',
                label: 'Re-pick Face…',
                icon: <Crosshair size={13} aria-hidden="true" />
              },
              run: () => armFaceRepair(repair)
            }
          ]
        : []),
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

  useEffect(() => {
    if (!projectSharingPreferenceEnabled) {
      setSharingOpen(false);
    }
  }, [projectSharingPreferenceEnabled]);

  /**
   * Whether the workspace still owns the keyboard. A surface layered over it
   * takes the keys with it: Settings sits on top of a live document, so
   * Backspace deleting a feature or Ctrl+Z rewinding history behind it would
   * edit a model the user cannot see. The palette and the shortcut overlay are
   * not listed — they are handled inside the map, which they need to reach.
   */
  const workspaceInputEnabled =
    !settingsOpen && !sharingOpen && !pendingShaprImport;

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

      if (meta && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        // Cycle View → Tweak → Build, skipping whatever the project locks.
        const order: readonly WorkspaceMode[] = ['view', 'tweak', 'build'];
        const at = order.indexOf(resolvedWorkspaceMode);
        for (let step = 1; step <= order.length; step += 1) {
          const next = order[(at + step) % order.length]!;
          const reason =
            next === 'build'
              ? buildModeDisabledReason
              : next === 'tweak'
                ? tweakModeDisabledReason
                : null;
          if (reason !== null) {
            continue;
          }
          if (next === resolvedWorkspaceMode) {
            // Every other mode is locked; say why instead of "switching"
            // to where we already are.
            setStatus(
              `Workspace pinned to View: ${buildModeDisabledReason ?? 'other modes are unavailable'}.`
            );
          } else {
            handleWorkspaceMode(next);
          }
          return;
        }
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
        // `tool` is only 'sketch' while the plane prompt is up: choosing a
        // plane clears it and hands the keys to the sketch session, which is
        // matched by `interaction.mode` below. Drawing shortcuts stay reserved
        // here so a stray letter cannot launch a primitive over the prompt,
        // but Escape has to keep working — the prompt has no other way out,
        // and the workspace promises Escape is always a way back.
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelPanel();
          setStatus('Sketch canceled · no plane was chosen.');
        }
        return;
      }
      if (tool === 'extrude') {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelPanel();
          return;
        }
        if (event.key === 'Enter' && !typing) {
          event.preventDefault();
          void confirmExtrude();
          return;
        }
        // Everything else used to stop here, which took the view keys with it.
        // Profile picking asks the user to click a region it has not framed —
        // the camera returns to the solid, and the profiles can be off-screen
        // entirely — so F, the standard views, the grid and the display mode
        // are exactly what someone reaches for, and exactly what did nothing.
        // Only the letters that would launch another tool mid-pick stay
        // reserved.
        if (SHORTCUT_TO_TOOL[event.key.toLowerCase()]) {
          return;
        }
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

      const historyKey =
        meta &&
        (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y');
      if (historyKey && modelingLocked) {
        // Undo stays locked in Tweak too: history snapshots restore whole
        // documents, so an undo here could quietly revert modeling work.
        event.preventDefault();
        ensureCanEdit('undo or redo');
        return;
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
        if (event.shiftKey) {
          openSaveNameDialog();
        } else {
          void handleSave();
        }
        return;
      }

      const normalViewSpace =
        (event.code === 'Space' || event.key === ' ') &&
        !event.repeat &&
        !meta &&
        !event.altKey &&
        !event.shiftKey;
      const stableFaceSelection =
        renderedSelectedTopology?.kind === 'face' &&
        (interaction.mode === 'idle' ||
          (interaction.mode === 'face' && interaction.phase === 'armed'));
      if (
        normalViewSpace &&
        tool === null &&
        stableFaceSelection &&
        !focusedControlOwnsSpace(target)
      ) {
        event.preventDefault();
        requestNormalToSelectedFace();
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
      // Enter is the keyboard half of drag-or-type. Every armed handle can be
      // dragged or tapped to type an exact value; without this the typing half
      // needed a pointer, which is not a contract at all.
      if (
        event.key === 'Enter' &&
        isOperationState(interaction) &&
        interaction.phase === 'armed' &&
        !keypad
      ) {
        if (openExactEntryRef.current?.() === true) {
          event.preventDefault();
          return;
        }
      }
      switch (event.key) {
        case 'Escape':
          if (modelingLocked && measuring) {
            event.preventDefault();
            if (measurementDraft) {
              clearMeasurementPicks();
              setStatus(
                `${measurementMode} measurement canceled · pick the first target.`
              );
            } else {
              setMeasuring(false);
              setStatus(
                'Measure off · pinned results remain in this View session.'
              );
            }
            return;
          }
          if (faceRepair) {
            event.preventDefault();
            setFaceRepair(null);
            setStatus('Face re-pick canceled · the feature is unchanged.');
            return;
          }
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
            if (
              cancelledPointer &&
              (interaction.mode === 'edges' ||
                (interaction.mode === 'face' &&
                  interaction.op === 'edit-fillet'))
            ) {
              edgePreview.clear();
            }
            if (!cancelledPointer) {
              // Read the rung before climbing it. Escape out of a sketch left
              // the "Sketching on ..." message standing over a workspace the
              // sketch had already been left — only Finish Sketch said
              // anything. Both dispatch the same exit, so both can say so.
              const leftSketch = escapeTarget(interaction) === 'exit-sketch';
              dispatchInteraction({ type: 'escape' });
              if (leftSketch) {
                setStatus('Sketch closed · sketch edits preserved.');
              }
            }
          } else if (tool || selectedFeatureNodeId) {
            cancelPanel();
          } else {
            clearSelection();
          }
          return;
        case 'Delete':
        case 'Backspace':
          if (modelingLocked) {
            if (activeMeasurementId) {
              event.preventDefault();
              setMeasurements((current) =>
                current.filter(
                  (measurement) => measurement.id !== activeMeasurementId
                )
              );
              setActiveMeasurementId(null);
              setStatus('Measurement removed.');
            }
            return;
          }
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
      if (key === 'm' && modelingLocked) {
        event.preventDefault();
        const next = !measuring;
        setMeasuring(next);
        clearMeasurementPicks();
        setStatus(
          next
            ? 'Measure ready · Smart inspects one pick; Distance and Angle use two.'
            : 'Measure off · pinned results stay available in this View session.'
        );
        return;
      }
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
      if (shortcutTool && modelingLocked) {
        event.preventDefault();
        ensureCanEdit(`use ${TOOL_META[shortcutTool].label}`);
        return;
      }
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
   * Keep it above the restore-screen return so every rendered shelf reads the
   * marker written by the latest reconciliation attempt.
   */
  const conflictedProjectIds = new Set(
    projects
      .map((project) => project.projectId)
      .filter((projectId) => readUnresolvedConflict(projectId) !== null)
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
        cloudFunctionsEnabled={cloudFunctionsEnabled}
        accountState={accountSettings}
        authConfig={authConfig}
        authConfigStatus={authConfigStatus}
        health={deploymentHealth}
        session={session}
        busy={settingsBusy}
        message={settingsMessage}
        initialSection={
          pendingInvitationToken || desktopAuthorizationAttempt
            ? 'account'
            : undefined
        }
        projectInvitationPending={pendingInvitationToken !== null}
        projectInvitationError={pendingInvitationError}
        desktopAuthorizationAttempt={desktopAuthorizationAttempt}
        desktopAuthorizationApproved={desktopAuthorizationApproved}
        desktopAuthorizationCode={desktopAuthorizationCode}
        onDesktopAuthorizationCodeChange={setDesktopAuthorizationCode}
        onChange={handleAppSettingsChange}
        onCloudFunctionsEnabledChange={handleCloudFunctionsEnabledChange}
        onSaveCredential={(token) => void handleSaveAssistantCredential(token)}
        onDeleteCredential={() => void handleDeleteAssistantCredential()}
        onTestAssistant={() => void handleTestAssistantConnection()}
        onRequestLoginCode={handleRequestLoginCode}
        onVerifyLoginCode={handleVerifyLoginCode}
        onRefreshAuthConfig={handleRefreshAuthConfig}
        onStartDesktopLogin={handleStartDesktopLogin}
        onApproveDesktopLogin={handleApproveDesktopLogin}
        onLogout={handleLogout}
        onDeleteCloudData={handleDeleteCloudData}
        onReset={handleResetAppSettings}
        onApplyViewportDefaults={applyViewportDefaults}
        onDismissProjectInvitation={dismissProjectInvitation}
        onClose={closeSettings}
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
          demos={START_SCREEN_DEMOS}
          defaultUnits={appSettings.general.defaultUnits}
          onCreate={(name, units) => void handleCreateProject(name, units)}
          onOpen={(projectId) => void handleOpenProject(projectId)}
          onOpenDemo={(definition) => void handleOpenDemo(definition)}
          onOpenSettings={openSettings}
          onDuplicate={(project) => void handleDuplicateProject(project)}
          cloudProjectIds={cloudProjectIds}
          accountProjectListReached={accountProjectListReached}
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
          loadThumbnail={loadThumbnail}
          backfillThumbnail={backfillThumbnail}
        />
        {settingsOverlay}
      </>
    );
  }

  const geometryPhaseLabel: Record<typeof geometry.state.phase, string> = {
    starting: 'Starting geometry worker',
    'loading-remus': 'Loading exact Remus kernel',
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
  // View mode writes its own hints rather than filtering the build chain below.
  // Selecting a cylinder still arms the radius interaction even with its handle
  // disarmed, and "drag the radial handle" is a promise View mode cannot keep.
  const viewModeHint = measuring
    ? measurementDraft
      ? `${measurementDraft.label} selected · pick the second target · Esc cancels`
      : measurementMode === 'smart'
        ? 'Smart measure · pick geometry · Shift+Click totals edges · M exits'
        : measurementMode === 'distance'
          ? 'Distance · pick the first target · centers resolve automatically'
          : 'Angle · pick a straight edge or measured face direction'
    : selectedTopology?.kind === 'face'
      ? 'Face selected — Space faces it head-on'
      : viewerBodies.length > 0
        ? 'Click a body, face, or edge · Measure records what you pick'
        : 'Ctrl+K commands · ? shortcuts';
  const tweakModeHint = measuring
    ? viewModeHint
    : parameters.length > 0
      ? 'Edit a parameter and press Enter · the model rebuilds exactly'
      : 'This model has no parameters · Build mode is where they are defined';
  const hint = viewMode
    ? viewModeHint
    : tweakMode
      ? tweakModeHint
      : (commandPromptText(
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
                  : selectedTopology?.kind === 'face'
                    ? 'Face selected — Space faces it head-on'
                    : selectedTopology?.kind === 'edge'
                      ? // Neither tool has a shortcut, so the rail is the only
                        // route: name it the way the rail names itself.
                        'Edge selected — Fillet or Chamfer in Feature tools'
                      : selectedFeature
                        ? 'Edit in the panel · Del deletes · Esc closes'
                        : viewerBodies.length > 0
                          ? 'Click a body, face, or edge · Shift+Click adds to selection'
                          : 'Ctrl+K commands · ? shortcuts'));

  const paletteCommands: PaletteCommand[] = [
    // Modeling tools leave the palette entirely in the reading workspaces
    // rather than appearing greyed out: a list of things you cannot do is
    // not a menu.
    ...(modelingLocked
      ? []
      : TOOL_GROUPS.flatMap((group) =>
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
        )),
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
      id: 'view-normal-to-face',
      label: 'Normal to selected face',
      group: 'View',
      shortcut: 'Space',
      icon: <Monitor size={16} aria-hidden="true" />,
      disabledReason:
        renderedSelectedTopology?.kind !== 'face'
          ? 'Select a planar face first'
          : normalToFaceTarget
            ? null
            : 'The selected face is not an exact plane',
      run: requestNormalToSelectedFace
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
      id: 'file-save-named',
      label: 'Save revision with a name…',
      group: 'File',
      shortcut: 'Ctrl+Shift+S',
      icon: <Save size={16} aria-hidden="true" />,
      run: openSaveNameDialog
    },
    {
      id: 'file-export-step',
      label: 'Export STEP',
      group: 'File',
      icon: <Download size={16} aria-hidden="true" />,
      disabledReason: exportBodyIds.length === 0 ? 'Create a body first' : null,
      run: () => void handleExportStep()
    },
    {
      id: 'file-export-mesh',
      label: 'Export mesh (3MF / STL)…',
      group: 'File',
      icon: <Download size={16} aria-hidden="true" />,
      disabledReason: exportBodyIds.length === 0 ? 'Create a body first' : null,
      run: () => setMeshExportOpen(true)
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
    // One palette entry per workspace the user is not already in: naming the
    // destination beats a toggle whose meaning depends on where you stand.
    ...(!viewMode
      ? [
          {
            id: 'workspace-mode-view',
            label: 'Switch to View mode',
            group: 'General',
            shortcut: 'Ctrl+Shift+M',
            icon: <Eye size={16} aria-hidden="true" />,
            run: () => handleWorkspaceMode('view')
          } satisfies PaletteCommand
        ]
      : []),
    ...(!tweakMode
      ? [
          {
            id: 'workspace-mode-tweak',
            label: 'Switch to Tweak mode',
            group: 'General',
            shortcut: 'Ctrl+Shift+M',
            icon: <SlidersHorizontal size={16} aria-hidden="true" />,
            disabledReason: tweakModeDisabledReason,
            run: () => handleWorkspaceMode('tweak')
          } satisfies PaletteCommand
        ]
      : []),
    ...(!(resolvedWorkspaceMode === 'build')
      ? [
          {
            id: 'workspace-mode-build',
            label: 'Switch to Build mode',
            group: 'General',
            shortcut: 'Ctrl+Shift+M',
            icon: <PenLine size={16} aria-hidden="true" />,
            disabledReason: buildModeDisabledReason,
            run: () => handleWorkspaceMode('build')
          } satisfies PaletteCommand
        ]
      : []),
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
  // Locked in Tweak as well: the assistant authors feature edits, which is
  // exactly what Tweak promises cannot happen.
  const assistantAvailable =
    cloudFunctionsEnabled && appSettings.assistant.enabled && !modelingLocked;
  const assistantHidden = directMode;
  const commandSession = commandSessionFor(interaction);
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
    !modelingLocked &&
    !directMode &&
    (tool !== null || selectedFeature !== null);
  const modelingOperation: ModelingOperationKind | null =
    tool === 'mirror' ||
    tool === 'split' ||
    tool === 'hole' ||
    tool === 'shell' ||
    tool === 'solid-offset' ||
    tool === 'loft' ||
    tool === 'sweep' ||
    tool === 'helical-sweep' ||
    tool === 'draft' ||
    tool === 'thicken'
      ? tool
      : null;
  const modelingProfileOptions: ModelingProfileOption[] = sketchViews.flatMap(
    (view) =>
      view.regions.flatMap((region, index) => {
        const sketchName =
          sketchOptions.find((option) => option.sketchId === view.sketchId)
            ?.name ?? 'Sketch';
        const pick: RegionPickData = {
          sketchId: view.sketchId,
          profileId: region.profileId,
          regionFingerprint: region.regionFingerprint,
          samplePoint: region.samplePoint,
          centroid: region.centroid,
          boundingBox: region.boundingBox,
          sourceEntityIds: region.sourceEntityIds,
          area: region.area
        };
        const [profile] = profileReferencesForSelection(
          [pick],
          entityWideProfileSource
        );
        return !profile || profile.all === true
          ? []
          : [
              {
                id: `${view.sketchId}:${region.profileId}`,
                label: `${sketchName} · Profile ${index + 1}`,
                section: { sketchId: view.sketchId, profile }
              }
            ];
      })
  );
  const modelingPathOptions: ModelingPathOption[] = doc
    ? sketchOptions.flatMap((option) => {
        const sketch = findSketch(doc, option.sketchId);
        if (!sketch) return [];
        const entityIds = sketch.objectIds.filter((entityId) => {
          const node = doc.nodes[entityId];
          return (
            node?.kind === 'sketch-object' &&
            (node.data.objectKind === 'line' || node.data.objectKind === 'arc')
          );
        });
        return entityIds.length === 0
          ? []
          : [
              {
                id: option.sketchId,
                label: `${option.name} · ${entityIds.length} path ${entityIds.length === 1 ? 'entity' : 'entities'}`,
                path: { sketchId: option.sketchId, entityIds }
              }
            ];
      })
    : [];
  const modelingTargetBody = modelingTargetBodyId
    ? representations[modelingTargetBodyId]
    : undefined;
  const modelingFaces = modelingFaceOptions(modelingTargetBody?.topology);
  const modelingOperationFaces =
    modelingOperation === 'draft' || modelingOperation === 'hole'
      ? modelingFaces.filter((face) => face.surfaceType === 'plane')
      : modelingFaces;
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
        openingFaceCount: modelingOperationFaces.length,
        profileCount: modelingProfileOptions.length,
        pathCount: modelingPathOptions.length
      }))
    : null;

  function commandForModelingSubmission(
    submission: ModelingOperationSubmission
  ): AnyCommand {
    switch (submission.operation) {
      case 'mirror':
        return commandFactories.mirrorBody(submission.input);
      case 'split':
        return commandFactories.splitBody(submission.input);
      case 'hole':
        return commandFactories.holeBody(submission.input);
      case 'shell':
        return commandFactories.shellBody(submission.input);
      case 'solid-offset':
        return commandFactories.offsetSolidBody(submission.input);
      case 'loft':
        return commandFactories.loftSections(submission.input);
      case 'sweep':
        return commandFactories.sweepProfile(submission.input);
      case 'helical-sweep':
        return commandFactories.helicalSweepProfile(submission.input);
      case 'draft':
        return commandFactories.draftBody(submission.input);
      case 'thicken':
        return commandFactories.thickenFace(submission.input);
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
          canExport={exportBodyIds.length > 0}
          exportScope={
            selectedBody &&
            !selectedBody.consumed &&
            selectedBody.exportableStep
              ? selectedBody.name
              : null
          }
          saveState={presentedSaveState}
          localOnlySourceCount={localOnlySources.length}
          artifacts={artifacts}
          session={session}
          accountState={
            session
              ? 'signed-in'
              : authConfigStatus === 'loading'
                ? 'checking'
                : authConfigStatus === 'ready'
                  ? 'signed-out'
                  : 'unavailable'
          }
          collaborationStatus={collaboration.status}
          collaboratorCount={collaboration.members.length}
          projectSharingEnabled={
            cloudFunctionsEnabled && projectSharingPreferenceEnabled
          }
          workspaceMode={resolvedWorkspaceMode}
          canRenameProject={canRenameProject}
          buildModeDisabledReason={buildModeDisabledReason}
          tweakModeDisabledReason={tweakModeDisabledReason}
          onWorkspaceMode={handleWorkspaceMode}
          onSave={() => void handleSave()}
          onImportFiles={(files) => void handleImportFiles(files)}
          onExportStep={() => void handleExportStep()}
          onOpenMeshExport={() => setMeshExportOpen(true)}
          onArchiveLocalSources={() => void handleArchiveLocalSources()}
          onExportDiagnostics={handleExportDiagnostics}
          onRenameProject={(name) =>
            executeCommand(
              commandFactories.renameNode({ nodeId: doc.rootNodeId, name }),
              undefined,
              'rename'
            )
          }
          onGoHome={() => void handleGoHome()}
          onOpenSharing={() => setSharingOpen(true)}
          onOpenSettings={openSettings}
        />
      }
      toolBar={
        modelingLocked ? (
          <ViewModeBar
            settings={viewerSettings}
            projection={projection}
            measuring={measuring}
            onMeasure={(next) => {
              setMeasuring(next);
              clearMeasurementPicks();
              setStatus(
                next
                  ? 'Measure ready · Smart inspects one pick; Distance and Angle use two.'
                  : 'Measure off · pinned results stay available in this View session.'
              );
            }}
            onFit={() => setFitSignal((value) => value + 1)}
            onToggleGrid={() =>
              setViewerSettings((current) => ({
                ...current,
                showGrid: !current.showGrid
              }))
            }
            onView={requestView}
            onCycleDisplayMode={cycleDisplayMode}
            onToggleProjection={toggleProjection}
          />
        ) : tool === 'sketch' ? (
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
        viewMode ? null : tweakMode ? (
          <TweakPanel
            parameters={exposedParameters}
            parameterValues={parameterScope.scope}
            canExport={exportBodyIds.length > 0}
            exportScope={
              selectedBody &&
              !selectedBody.consumed &&
              selectedBody.exportableStep
                ? selectedBody.name
                : null
            }
            onSetParameter={(name, expression) =>
              executeCommand(
                commandFactories.setParameter({ name, expression })
              )
            }
            onExportStep={() => void handleExportStep()}
            onOpenMeshExport={() => setMeshExportOpen(true)}
            share={
              shareSession
                ? { onMakeCopy: () => void handleMakeShareCopy() }
                : null
            }
          />
        ) : (
          <Sidebar
            parameters={parameters}
            parameterValues={parameterScope.scope}
            features={features}
            representations={representations}
            selectedFeatureNodeId={selectedFeatureNodeId}
            hiddenBodyIds={hiddenBodyIds}
            warnings={warnings}
            checkpoints={doc?.checkpoints ?? []}
            documentVersion={doc?.version ?? 0}
            restorableCheckpointIds={restorableCheckpointIds}
            onSelectFeature={handleSelectFeatureFromTree}
            onSelectBody={handleSelectBodyFromTree}
            selectedBodyIds={selectedBodyIds}
            onToggleBodyVisibility={toggleBodyVisibility}
            onFeatureContextMenu={handleFeatureContextMenu}
            onToggleFeatureSuppression={handleToggleFeatureSuppression}
            onRollbackAfterFeature={handleRollbackAfterFeature}
            onSetParameter={(name, expression) =>
              executeCommand(
                commandFactories.setParameter({ name, expression })
              )
            }
            onDeleteParameter={(name) =>
              executeCommand(commandFactories.deleteParameter({ name }))
            }
            onExposeParameter={(name, exposed) =>
              executeCommand(
                commandFactories.setParameterExposed({ name, exposed })
              )
            }
            onDescribeParameter={(name, description) =>
              executeCommand(
                commandFactories.setParameterDescription({ name, description })
              )
            }
            exposedParameterNames={exposedParameterNames}
            onDeleteFeature={handleDeleteFeature}
            onReorderFeature={handleReorderFeature}
            onRestoreCheckpoint={(checkpoint) =>
              void handleRestoreSaveState(checkpoint)
            }
            onBranchCheckpoint={(checkpoint) =>
              void handleBranchSaveState(checkpoint)
            }
            panelState={panelState}
            onToggleSection={(id: SidebarSectionId) =>
              setPanelState((current) => toggleSidebarSection(current, id))
            }
          />
        )
      }
      viewer={
        <ErrorBoundary
          label="3D viewer"
          resetKey={`${doc.projectId}:${doc.version}`}
        >
          <ViewerShell
            projectId={doc.projectId}
            bodies={viewerBodies}
            measurementAnnotations={measurementAnnotations}
            measurementCloudSync={[
              doc.projectId,
              deploymentHealth?.projectMeasurementSyncEnabled,
              cloudProjectIds,
              measurementHydratedProjectId,
              measurements,
              measurementDisplay,
              applyStoredMeasurements,
              setMeasurementUnit,
              setMeasurementPrecision,
              setRadialDisplay,
              loadProjectMeasurements,
              saveProjectMeasurements
            ]}
            projectThumbnailSync={
              geometry.state.phase === 'ready'
                ? [
                    doc.projectId,
                    doc.version,
                    doc.derived.updatedAt,
                    doc.derived.bodyRepresentations,
                    Boolean(
                      session &&
                      cloudProjectIds.has(doc.projectId) &&
                      !editDisabledReason
                    ),
                    api,
                    loadProjectThumbnail,
                    saveProjectThumbnail
                  ]
                : undefined
            }
            sketches={viewerSketches}
            selectedBodyIds={selectedBodyIds}
            selectedTopology={renderedSelectedTopology}
            previewFaceHighlights={previewBlendFaces}
            selectedEdges={selectedEdges}
            pickListEnabled={appSettings.experiments.directManipulation}
            settings={viewerSettings}
            fitSignal={fitSignal}
            viewRequest={viewRequest}
            normalToFaceRequest={normalToFaceRequest}
            rotateRequest={rotateRequest}
            units={doc.units}
            // Every drag handle below is disarmed by passing nothing to arm:
            // the viewer only builds a manipulator when it is given a target,
            // so view mode keeps orbit, pan and picking while no gesture can
            // reach the document.
            editableBodyIds={viewerEditableBodyIds}
            extrudePreview={extrudePreview}
            movePreview={movePreview}
            moveCommitHold={moveCommitHold}
            appearancePreview={bodyAppearancePreview}
            hideViewerToolbar={false}
            viewMode={modelingLocked}
            selectionChip={selectionChip}
            onClearSelection={clearSelection}
            canUndo={!modelingLocked && (managerRef.current?.canUndo ?? false)}
            canRedo={!modelingLocked && (managerRef.current?.canRedo ?? false)}
            onUndo={handleUndo}
            onRedo={handleRedo}
            initialView={initialView}
            onViewChange={handleViewportChange}
            onViewSettled={handleViewportSettled}
            onMovePreviewChange={handleMovePreviewChange}
            moveValuesSetterRef={moveValuesSetterRef}
            offsetHandle={modelingLocked ? null : offsetHandleTarget}
            onOffsetPreview={handleOffsetPreview}
            onOffsetCommit={handleOffsetCommit}
            onOffsetCancel={handleOffsetCancel}
            offsetPreviewInvalid={
              interaction.mode === 'face' &&
              interaction.op === 'offset-face' &&
              interaction.phase === 'failed'
            }
            previewDeferred={previewDeferred}
            onOpenOffsetKeypad={handleOpenOffsetKeypad}
            keypadAnchorRef={keypadAnchorRef}
            offsetSetterRef={offsetSetterRef}
            cylinderRadiusHandle={
              modelingLocked ? null : cylinderRadiusHandleTarget
            }
            cylinderDimensionMode={cylinderDimensionMode}
            onCylinderDimensionModeChange={setCylinderDimensionMode}
            onCylinderRadiusPreview={handleCylinderRadiusPreview}
            onCylinderRadiusCommit={handleCylinderRadiusCommit}
            onCylinderRadiusCancel={handleCylinderRadiusCancel}
            onOpenCylinderRadiusKeypad={handleOpenCylinderRadiusKeypad}
            cancelDirectManipulationRef={cancelDirectManipulationRef}
            openExactEntryRef={openExactEntryRef}
            edgeHandle={modelingLocked ? null : edgeHandleTarget}
            onEdgeRadiusPreview={(size) => edgePreview.request(size)}
            onEdgeCommit={handleEdgeCommit}
            onEdgeCancel={handleEdgeCancel}
            onOpenEdgeKeypad={handleOpenEdgeKeypad}
            onDirectManipulationChange={(dragging) =>
              dispatchInteraction({
                type: dragging ? 'drag-engage' : 'drag-release'
              })
            }
            sketchMode={modelingLocked ? null : sketchModeState}
            onSketchCommit={handleSketchCommit}
            onSketchDrawingChange={(drawing) =>
              dispatchInteraction({ type: 'sketch-drawing', drawing })
            }
            onSketchSelectObject={(objectId, snapPoint) => {
              if (handleSketchConstraintPick(objectId, snapPoint ?? null)) {
                return;
              }
              dispatchInteraction({ type: 'sketch-select-object', objectId });
            }}
            sketchViews={sketchViews}
            selectedProfileIds={viewerSelectedProfileIds}
            profileSelectionMode={tool === 'extrude'}
            onSelectRegion={handleSelectRegion}
            onHoverRegion={handleHoverRegion}
            onMeasurePreview={
              modelingLocked && measuring ? previewMeasurement : null
            }
            regionHandle={modelingLocked ? null : regionHandleTarget}
            modeOverlay={
              modelingLocked ? (
                <>
                  <ViewModeRail
                    bodies={partBodies}
                    hiddenBodyIds={hiddenBodyIds}
                    selectedBodyIds={selectedBodyIds}
                    open={panelState.viewModeRailOpen}
                    onOpenChange={(viewModeRailOpen) =>
                      setPanelState((current) => ({
                        ...current,
                        viewModeRailOpen
                      }))
                    }
                    onSelectBody={handleSelectBodyFromTree}
                    onToggleVisibility={toggleBodyVisibility}
                    onIsolate={isolateBody}
                    onShowAll={showAllBodies}
                  />
                  {(measuring || measurements.length > 0) && (
                    <MeasurementDock
                      measurements={measurements}
                      formattedMeasurements={formattedMeasurements}
                      enabled={measuring}
                      activeMeasurementId={activeMeasurementId}
                      mode={measurementMode}
                      draftTargetLabel={measurementDraft?.label ?? null}
                      display={measurementDisplay}
                      onMode={(mode) => {
                        setMeasuring(true);
                        setMeasurementMode(mode);
                        clearMeasurementPicks();
                        setStatus(
                          mode === 'smart'
                            ? 'Smart measure · pick an edge, face, hole, or body.'
                            : mode === 'distance'
                              ? 'Distance · pick the first target.'
                              : 'Angle · pick the first straight edge or measured face direction.'
                        );
                      }}
                      onUnit={setMeasurementUnit}
                      onPrecision={setMeasurementPrecision}
                      onRadialDisplay={setRadialDisplay}
                      onSelect={setActiveMeasurementId}
                      onToggleVisibility={(id) =>
                        setMeasurements((current) =>
                          current.map((measurement) =>
                            measurement.id === id
                              ? {
                                  ...measurement,
                                  visible: !measurement.visible
                                }
                              : measurement
                          )
                        )
                      }
                      onRename={(id, label, note) =>
                        setMeasurements((current) =>
                          current.map((measurement) =>
                            measurement.id === id
                              ? {
                                  ...measurement,
                                  label,
                                  note: note || undefined,
                                  renamed: true
                                }
                              : measurement
                          )
                        )
                      }
                      onDelete={(id) => {
                        setMeasurements((current) =>
                          current.filter((measurement) => measurement.id !== id)
                        );
                        setActiveMeasurementId((current) =>
                          current === id ? null : current
                        );
                        setStatus('Measurement removed.');
                      }}
                      onClear={() => {
                        if (
                          appSettings.general.confirmDestructiveActions &&
                          !window.confirm(
                            'Clear every measurement in this View session?'
                          )
                        ) {
                          return;
                        }
                        setMeasurements([]);
                        setActiveMeasurementId(null);
                        clearMeasurementPicks();
                        setStatus('Measurement list cleared.');
                      }}
                      onCopy={(measurement) =>
                        void copyMeasurements(measurement)
                      }
                      onExport={exportMeasurements}
                    />
                  )}
                </>
              ) : contextualToolCard ? (
                <>
                  <ToolCard
                    model={contextualToolCard}
                    onAction={handleSelectionAction}
                    onEditCulprit={handleEditCulpritFeature}
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
                      circleMode={interaction.session.circleMode}
                      construction={sketchConstruction}
                      settings={appSettings.sketching}
                      units={doc.units}
                      paletteVisible={selectedSketchEntity === null}
                      canConstrain={Boolean(interaction.session.sketchId)}
                      pendingConstraint={interaction.session.pendingConstraint}
                      constraints={sketchConstraintItems}
                      solveStatus={sketchSolveStatus}
                      solving={sketchSolving}
                      onConstraintTool={(kind) => {
                        dispatchInteraction({
                          type: 'sketch-constraint-tool',
                          kind
                        });
                        if (kind) {
                          setStatus(constraintToolSpec(kind).hint);
                        }
                      }}
                      onDeleteConstraint={handleDeleteSketchConstraint}
                      onSolve={() => {
                        void handleSolveSketch();
                      }}
                      onTool={(sketchTool) =>
                        dispatchInteraction({
                          type: 'sketch-tool',
                          tool: sketchTool
                        })
                      }
                      onCircleMode={(mode) =>
                        dispatchInteraction({
                          type: 'sketch-circle-mode',
                          mode
                        })
                      }
                      onConstruction={setSketchConstruction}
                      onSettings={(sketching) => {
                        const current = appSettingsRef.current;
                        handleAppSettingsChange({ ...current, sketching });
                      }}
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
                      onDimensionModeChange={setCylinderDimensionMode}
                      onPreview={(value) => {
                        offsetSetterRef.current?.(value);
                        if (keypad.kind === 'radius') {
                          handleCylinderRadiusPreview(value);
                        } else if (keypad.kind === 'edge') {
                          edgePreview.request(value);
                        } else {
                          handleOffsetPreview(value);
                        }
                      }}
                      // A refused value is refused for every command, not just
                      // offsets: leaving the control live beside its own
                      // rejection invited the same value to be submitted again.
                      commitDisabled={
                        isOperationState(interaction) &&
                        (interaction.phase === 'failed' ||
                          interaction.phase === 'validating')
                      }
                      commitDisabledReason={
                        interaction.mode !== 'idle' &&
                        interaction.mode !== 'sketch'
                          ? (interaction.error?.message ?? null)
                          : null
                      }
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
                          handleEdgeCancel();
                        } else {
                          handleOffsetCancel();
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
                      // Every other way into a sketch says so; this one left
                      // whatever the last message was standing over a
                      // workspace that had just changed underneath it.
                      setStatus(
                        `Editing ${sketch.name} · Finish Sketch when done.`
                      );
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
                  // A sketch move commits as a sketch translation, not a named
                  // feature, so it gets neither a name nor a body picker.
                  name={movePreview.target === 'sketch' ? undefined : moveName}
                  onName={
                    movePreview.target === 'sketch' ? undefined : setMoveName
                  }
                  targets={
                    movePreview.target === 'sketch'
                      ? undefined
                      : viewerBodies.map((body) => ({
                          bodyId: body.bodyId,
                          name:
                            representations[body.bodyId]?.name ?? body.bodyId
                        }))
                  }
                  targetBodyId={movePreview.bodyId}
                  onTargetBody={(bodyId) => {
                    setSelectedBodyIds([bodyId as BodyId]);
                    setMoveSnap(null);
                    setMovePreview((current) =>
                      current
                        ? {
                            ...current,
                            bodyId,
                            // Values are relative to the body's own centre, so
                            // carrying them to a different body would apply a
                            // move nobody asked for.
                            translation: { x: 0, y: 0, z: 0 },
                            rotationDeg: { x: 0, y: 0, z: 0 }
                          }
                        : current
                    );
                  }}
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
                  liveValuesRef={moveValuesSetterRef}
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
                            // Keep the plane id here rather than PLANE_LABELS:
                            // the e2e test that pins the label-to-plane
                            // mapping reads this line precisely because it is
                            // derived from the id, so a rename that only edits
                            // strings cannot keep it green. Only the "Esc
                            // exits" claim goes — the armed Line tool makes it
                            // untrue on the first press.
                            `Sketching on the ${plane} plane · Finish Sketch when done.`
                          );
                        }}
                      >
                        {PLANE_LABELS[plane]}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="sketch-plane-dismiss"
                      aria-label="Cancel sketch"
                      title="Cancel sketch (Esc)"
                      onClick={() => {
                        cancelPanel();
                        setStatus('Sketch canceled · no plane was chosen.');
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ) : extrudePreview && selectedSketchProfileName ? (
                <ExtrudeOverlay
                  profileName={`${selectedSketchProfileName} · ${selectedProfiles.length} bounded cell${selectedProfiles.length === 1 ? '' : 's'}`}
                  profileCount={selectedProfiles.length}
                  availableProfileCount={availableExtrudeProfiles.length}
                  distance={extrudePreview.distance}
                  units={doc.units}
                  operation={
                    resolvedExtrudePreview?.inference.operation ?? 'inferring'
                  }
                  operationDetail={extrudeInferenceDescription(
                    resolvedExtrudePreview
                  )}
                  canConfirm={
                    resolvedExtrudePreview !== null &&
                    resolvedExtrudePreview.baseVersion === doc.version
                  }
                  onDistanceChange={updateExtrudeDistance}
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
            onExtrudeDistanceChange={updateExtrudeDistance}
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
            sectionRange={
              viewerSettings.sectionView
                ? sectionAxisRange(viewerSettings.sectionView.plane)
                : null
            }
            onCycleSection={cycleSectionView}
            onSectionOffset={setSectionOffset}
          />
          {!modelingLocked &&
            !panelState.workspaceTourDismissed &&
            tourProjectId === doc.projectId &&
            interaction.mode !== 'sketch' && (
              <WorkspaceTour
                featureCount={features.length}
                hasSelection={
                  selectedTopology !== null ||
                  selectedEdges.length > 0 ||
                  selectedBodyIds.length > 0
                }
                exportSeen={tourExportSeen}
                onDismiss={() =>
                  setPanelState((current) => ({
                    ...current,
                    workspaceTourDismissed: true
                  }))
                }
              />
            )}
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
                faceOptions={modelingOperationFaces}
                profileOptions={modelingProfileOptions}
                pathOptions={modelingPathOptions}
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
                    `${TOOL_META[modelingOperation].label}: pick an exact face, then select it in the face list.`
                  );
                }}
              />
            ) : (
              <Inspector
                tool={tool}
                commitError={featureFormError}
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
                commandSession={commandSession}
                featureSelectionSource={featureSelectionSource}
                onLaunchTool={launchTool}
                onPreviewBodyAppearance={previewBodyAppearance}
                onCommitBodyAppearance={commitBodyAppearance}
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
                onCreateExtrude={(value) => void createInferredExtrude(value)}
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
                      rotationDeg: value.rotationDeg,
                      ...(value.scale !== undefined
                        ? { scale: value.scale }
                        : {})
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
                onApplyPrimitive={(feature, name, dimensions) => {
                  const command = commandFactories.updateFeature(
                    {
                      featureId: feature.featureId,
                      name,
                      data: { dimensions }
                    },
                    `Edit ${name}`
                  );
                  if (!doc || !feature.bodyId) {
                    executeCommand(command);
                    return;
                  }
                  void executeValidatedFeature(command, {
                    featureName: name,
                    resultBodyId: feature.bodyId,
                    targets: affectedFeatureTargets(doc, feature.featureId).map(
                      (target, index) =>
                        index === 0 ? { ...target, featureName: name } : target
                    ),
                    successMessage: command.label
                  });
                }}
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
                    // Same reason as the revert pill: entering a sketch from
                    // the tree changes what every key does, so it should say
                    // so rather than leaving the previous message in place.
                    setStatus(
                      `Editing ${sketch.name} · Finish Sketch when done.`
                    );
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
                          distance: value.distance,
                          // Stored explicitly on edits: updateFeature patches
                          // keys and cannot delete one, so unchecking must
                          // write false rather than omit the key — and a
                          // cleared back distance writes the explicit 0.
                          symmetric: value.symmetric === true,
                          backDistance: value.backDistance ?? 0
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
                            rotationDeg: value.rotationDeg,
                            // Replaces the whole transform object, so leaving
                            // scale out here is what clears a previous one.
                            ...(value.scale !== undefined
                              ? { scale: value.scale }
                              : {})
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
                                ...(value.edgeReferences
                                  ? { edgeReferences: value.edgeReferences }
                                  : {}),
                                radius: value.size
                              }
                            : {
                                featureKind: 'chamfer',
                                targetBodyId: value.targetBodyId,
                                edgeHashes: value.edgeHashes,
                                ...(value.edgeReferences
                                  ? { edgeReferences: value.edgeReferences }
                                  : {}),
                                distance: value.size,
                                ...(value.angleDeg !== undefined
                                  ? { angleDeg: value.angleDeg }
                                  : {})
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
                          angleDeg: value.angleDeg,
                          ...(value.direction
                            ? { direction: value.direction }
                            : {}),
                          ...(value.axis2 ? { axis2: value.axis2 } : {}),
                          ...(value.spacing2 !== undefined
                            ? { spacing2: value.spacing2 }
                            : {}),
                          ...(value.count2 !== undefined
                            ? { count2: value.count2 }
                            : {})
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
                onToggleImportedSolid={handleToggleImportedSolid}
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
          saveState={presentedSaveState}
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
            accept=".shapr,.stl,.step,.stp"
            multiple
            style={{ display: 'none' }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length > 0) {
                void handleImportFiles(files);
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
          {sharingOpen &&
            cloudFunctionsEnabled &&
            projectSharingPreferenceEnabled &&
            doc && (
              <ProjectSharingDialog
                projectId={doc.projectId}
                role={collaboration.role}
                collaborationStatus={collaboration.status}
                lease={collaboration.lease}
                liveMembers={collaboration.members}
                currentUserId={session?.userId}
                conflict={collaboration.conflict}
                conflictHandlers={conflictHandlers}
                editorInvitationsEnabled={
                  collaborationRollout.editLeasesEnforced
                }
                onClose={() => setSharingOpen(false)}
              />
            )}
          {namingSave && doc && (
            <SaveRevisionDialog
              projectName={doc.name}
              onCancel={() => setNamingSave(false)}
              onSave={(name) => {
                setNamingSave(false);
                void handleSave(name);
              }}
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
          {meshExportOpen && doc && exportBodyIds.length > 0 && (
            <ExportDialog
              scopeLabel={
                selectedBody &&
                !selectedBody.consumed &&
                selectedBody.exportableStep
                  ? selectedBody.name
                  : `all bodies (${exportBodyIds.length})`
              }
              bodies={exportBodyIds.map((bodyId) => ({
                bodyId,
                name: doc.derived.bodyRepresentations[bodyId]?.name ?? bodyId
              }))}
              onClose={() => setMeshExportOpen(false)}
              onExport={handleExportMesh}
              onCheckQuality={handleCheckMeshQuality}
            />
          )}
          {pendingShaprImport && (
            <ShaprImportDialog
              shaprFileName={pendingShaprImport.shaprFile.name}
              stepFileName={pendingShaprImport.sourceStepFile.name}
              phase={pendingShaprImport.phase}
              progress={pendingShaprImport.progress}
              error={pendingShaprImport.error}
              inspection={pendingShaprImport.inspection}
              onCancel={cancelShaprImport}
              onApply={() => void applyShaprImport()}
            />
          )}
          {settingsOverlay}
        </>
      }
    />
  );
}
