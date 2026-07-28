import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent
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
  commandsForCadPatch,
  type AnyCommand
} from '@openzcad/command-system';
import type {
  CadPatchProposal,
  CadSelectionContext
} from '@openzcad/ai-contracts';
import {
  createProjectDocument,
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  listParameters,
  normalizeDocument
} from '@openzcad/document-core';
import {
  circleProfile,
  frameForPlaneRef,
  polygonProfile,
  rectangleProfile,
  type Vec2
} from '@openzcad/geometry';
import { parseStepMetadata } from '@openzcad/io-step';
import { parseStl } from '@openzcad/io-stl';
import { createKernelAdapter } from '@openzcad/kernel-adapter';
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
  ProjectSummary,
  SketchId,
  SketchNode,
  SketchObjectData,
  TopologySelection,
  UnitSystem
} from '@openzcad/shared';
import type {
  AppSettings,
  AppSettingsResponse,
  AuthConfigResponse,
  AuthSession
} from '@openzcad/shared';
import { toUserId } from '@openzcad/shared';
import { ApiError, api } from './lib/api';
import { timed } from './lib/perf';
import {
  PLANE_LABELS,
  downloadText,
  evalParamValue,
  exportFileStem,
  inferContentType
} from './lib/model';
import {
  SHORTCUT_TO_TOOL,
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  type ToolAvailability,
  type ToolId
} from './lib/tools';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopBar } from './components/TopBar';
import { ToolBar } from './components/ToolBar';
import { Sidebar } from './components/Sidebar';
import { ViewerShell } from './components/ViewerShell';
import { Inspector } from './components/Inspector';
import { StatusBar } from './components/StatusBar';
import { StartScreen } from './components/StartScreen';
import { StartupScreen } from './components/StartupScreen';
import { SettingsPage, type AuthConfigStatus } from './components/SettingsPage';
import { buildDemoDocument, DEMO_DEFINITIONS } from './lib/demos';
import type { DemoDefinition } from './lib/demos';
import { AssistantPanel } from './components/assistant/AssistantPanel';
import {
  ExtrudeOverlay,
  MoveOverlay,
  ProfileQuickAction
} from './components/DirectModelingOverlays';
import { composeMoveTransform } from '@openzcad/viewport';
import { ToolCard } from './components/ToolCard';
import { NumericKeypad, type KeypadRequest } from './components/NumericKeypad';
import {
  IDLE,
  interactionReducer,
  toolCardFor,
  type FaceTarget
} from './lib/interaction/machine';
import type { SelectionActionId } from './lib/interaction/capabilities';
import { frameFromFace } from './lib/sketch/session';
import { edgeLabel, edgeLength, faceLabel } from './lib/topologyLabels';
import { SketchToolRail } from './components/SketchToolRail';
import { SketchEntityEditor } from './components/SketchEntityEditor';
import { objectPolyline } from './components/viewer/sketchModeController';
import type { RegionPickData } from './components/viewer/regionOverlay';
import { computeSketchRegions } from '@openzcad/geometry';
import { Undo2 } from 'lucide-react';
import {
  CommandPalette,
  type PaletteCommand
} from './components/CommandPalette';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { DISPLAY_MODE_LABELS } from './components/ViewerToolbar';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import type {
  ExtrudePreview,
  FaceResizeCommit
} from './components/ModelViewer';
import type {
  AxisProjection,
  DisplayMode,
  MovePreview,
  MoveSnap,
  PickDetail,
  SketchOverlay,
  StandardView
} from '@openzcad/viewport';
import {
  listLocalProjects,
  loadLocalProject,
  selectProjectDocument,
  saveLocalProject
} from './lib/localProjectStore';
import { LivePreview } from './lib/livePreview';
import { errorMessage } from './lib/errors';
import { useGeometryWorker } from './hooks/useGeometryWorker';
import { useProjectView } from './hooks/useProjectView';
import { useDirectEditCommit } from './hooks/useDirectEditCommit';
import { useCollaboration } from './lib/useCollaboration';
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

const kernel = createKernelAdapter();
const localUserId = toUserId('user_local_browser');
const MAX_EMBEDDED_STEP_BYTES = 12 * 1024 * 1024;
const DISPLAY_MODE_ORDER: DisplayMode[] = [
  'shaded-edges',
  'shaded',
  'wireframe'
];

function mergeProjectSummaries(
  local: ProjectSummary[],
  remote: ProjectSummary[]
): ProjectSummary[] {
  const merged = new Map(local.map((project) => [project.projectId, project]));
  for (const project of remote) {
    const existing = merged.get(project.projectId);
    if (!existing || project.updatedAt > existing.updatedAt) {
      merged.set(project.projectId, project);
    }
  }
  return [...merged.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );
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
  const [accountSettings, setAccountSettings] =
    useState<AppSettingsResponse | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfigResponse | null>(null);
  const [authConfigStatus, setAuthConfigStatus] =
    useState<AuthConfigStatus>('loading');
  const [assistantCollapsed, setAssistantCollapsed] = useState(false);
  /** Bumped to move focus into the assistant prompt, like `viewRequest`. */
  const [assistantFocusNonce, setAssistantFocusNonce] = useState(0);
  const [panelState, setPanelState] = useState<PanelState>(() =>
    loadPanelState()
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState(
    'Changes save on this device immediately.'
  );
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
  // Viewport body selection in pick order; drives boolean/move pre-fills.
  const [selectedBodyIds, setSelectedBodyIds] = useState<BodyId[]>([]);
  const [selectedSketchProfileId, setSelectedSketchProfileId] =
    useState<SketchId | null>(null);
  const [extrudePreview, setExtrudePreview] = useState<ExtrudePreview | null>(
    null
  );
  const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
  const [moveSnap, setMoveSnap] = useState<MoveSnap | null>(null);
  const [tool, setTool] = useState<ToolId | null>(null);
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
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'offline'>(
    'saving'
  );
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [viewRequest, setViewRequest] = useState<{
    view: StandardView;
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
  const contextMenuActionsRef = useRef<Record<string, () => void>>({});
  const managerRef = useRef<CommandManager | null>(null);
  const geometry = useGeometryWorker({
    manager: () => managerRef.current,
    onDerived: (derived) => {
      const manager = managerRef.current;
      if (manager) {
        setDoc(manager.commitDerivedState(derived));
      }
    },
    onError: setStatus
  });
  const remoteVersionsRef = useRef(new Map<string, number>());
  const viewNonceRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const { run: executeValidatedDirectEdit } = useDirectEditCommit({
    manager: () => managerRef.current,
    derive: (document) => geometry.syncOnce(document),
    commit: (command) => executeCommand(command),
    onValidationStart: (value) =>
      dispatchInteraction({ type: 'validation-start', value }),
    onValidationFailed: (message, value) =>
      dispatchInteraction({ type: 'validation-failed', message, value }),
    onCommitted: (bodyId) => {
      dispatchInteraction({ type: 'commit-complete' });
      setSelectedTopology(null);
      setSelectedEdges([]);
      setSelectedBodyIds([bodyId]);
      setSelectedFeatureNodeId(featureNodeIdForBody(bodyId));
    },
    onBusy: setBusy,
    onStatus: setStatus
  });

  const collaboration = useCollaboration({
    document: doc,
    // A signed-in user can still be editing a device-only project. Only attach
    // account cookies to a collaboration room after this exact project has
    // been resolved as a cloud-backed document.
    session: cloudAvailable ? session : null,
    onRemoteDocument(remoteDocument) {
      const current = managerRef.current?.document;
      if (
        !current ||
        current.projectId !== remoteDocument.projectId ||
        remoteDocument.version <= current.version
      ) {
        return;
      }
      hydrateDocument(remoteDocument, {
        restoreView: false,
        rememberProject: false
      });
      setStatus(
        `Applied live revision ${remoteDocument.version} from a collaborator.`
      );
    },
    onConflict(remoteDocument) {
      setStatus(
        `Collaboration conflict at revision ${remoteDocument.version}; local edits were preserved.`
      );
    }
  });

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
    let cancelled = false;
    void (async () => {
      try {
        const [local, health, rememberedLocal, currentAuth] = await Promise.all(
          [
            listLocalProjects().catch(() => []),
            api.health().catch(() => null),
            startupProjectId
              ? loadLocalProject(startupProjectId).catch(() => null)
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
          ]
        );
        const activeSession = await api.session().catch(() => null);
        const [remote, rememberedRemote, remoteSettings] = activeSession
          ? await Promise.all([
              api.listProjects().catch(() => null),
              startupProjectId
                ? api.loadProject(startupProjectId).catch(() => null)
                : Promise.resolve(null),
              api.getSettings().catch(() => null)
            ])
          : [null, null, null];
        if (cancelled) {
          return;
        }
        const remoteProjects = remote?.projects ?? [];
        const merged = mergeProjectSummaries(local, remoteProjects);
        const restoredDocument = selectProjectDocument(
          rememberedLocal,
          rememberedRemote
        );
        const canUseCloud = Boolean(activeSession && rememberedRemote);
        if (rememberedRemote) {
          remoteVersionsRef.current.set(
            rememberedRemote.projectId,
            rememberedRemote.version
          );
        }
        setProjects(merged);
        setCloudAvailable(canUseCloud);
        setSession(activeSession);
        setAuthConfig(currentAuth.config);
        setAuthConfigStatus(currentAuth.status);
        if (remoteSettings) {
          setAccountSettings(remoteSettings);
          // Adopting the account copy over an unsaved local change would revert
          // it silently — for the assistant switch, that reads as the switch
          // not working at all.
          if (
            remoteSettings.synced &&
            shouldAdoptAccountSettings(bootSettingsRef.current)
          ) {
            syncedRevisionRef.current = remoteSettings.revision;
            setAppSettings(remoteSettings.settings);
            saveLocalAppSettings(
              remoteSettings.settings,
              remoteSettings.revision
            );
          } else if (remoteSettings.synced) {
            setSettingsMessage(
              'This device has settings that are not saved to your account yet.'
            );
          }
        }
        setSaveState(canUseCloud ? 'saved' : 'offline');
        if (startupProjectId && restoredDocument) {
          hydrateDocument(restoredDocument);
          setStatus(`Reopened ${restoredDocument.name}.`);
          return;
        }
        if (startupProjectId) {
          clearActiveProject();
        }
        setStatus(
          activeSession && remote
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
    const timeout = window.setTimeout(() => {
      void saveLocalProject(doc)
        .then(() => setSaveState(cloudAvailable ? 'saved' : 'offline'))
        .catch(() => {
          setSaveState('offline');
          setStatus('Local autosave failed. Export your model before closing.');
        });
    }, 450);
    return () => window.clearTimeout(timeout);
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

  const representations = doc?.derived.bodyRepresentations ?? {};
  // Warnings must describe what is actually on screen. While a preview is up the
  // viewport shows previewDoc's bodies, so showing the live document's warnings
  // would hide exactly the problems the preview exists to reveal.
  const warnings = (previewDoc ?? doc)?.derived.warnings ?? [];

  const viewerBodies = useMemo<BodyRepresentation[]>(
    () =>
      (previewDoc
        ? Object.values(previewDoc.derived.bodyRepresentations)
        : doc
          ? Object.values(doc.derived.bodyRepresentations)
          : []
      ).filter((body) => !body.consumed && !hiddenBodyIds.has(body.bodyId)),
    [doc, previewDoc, hiddenBodyIds]
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

  const selectedBody = selectedFeature?.bodyId
    ? (representations[selectedFeature.bodyId] ?? null)
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
        const body = representations[edge.bodyId];
        return sum + (edgeLength(body, edge.hash, edge.topologyId) ?? 0);
      }, 0);
      return {
        label: `${selectedEdges.length} edges`,
        detail: total > 0 ? `≈ ${round(total)} ${units}` : undefined
      };
    }
    if (selectedEdges.length === 1 || selectedTopology?.kind === 'edge') {
      const bodyId = selectedEdges[0]?.bodyId ?? selectedTopology?.bodyId;
      const body = bodyId ? representations[bodyId] : undefined;
      const hash = selectedEdges[0]?.hash ?? selectedTopology?.hash;
      const topologyId =
        selectedEdges[0]?.topologyId ?? selectedTopology?.topologyId;
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
    if (selectedTopology?.kind === 'face') {
      const body = representations[selectedTopology.bodyId];
      const face = body?.topology?.faces.find(
        (candidate) => candidate.hash === selectedTopology.hash
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
        selectedTopology.hash,
        selectedTopology.topologyId
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
    const body = bodyId ? representations[bodyId] : null;
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
    selectedTopology,
    selectedBodyIds,
    representations
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
      const basis = frameForPlaneRef(
        sketch.planeRef,
        (value) => evalParamValue(value, scope) ?? 0
      );
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
    sketchCount: sketchOptions.length,
    liveBodyCount: viewerBodies.length,
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
    setExtrudePreview(null);
    setTool(null);
  }

  function handleViewportChange(camera: ViewportCameraState) {
    reportCameraPose(doc?.projectId ?? null, camera);
  }

  function executeCommand(command: AnyCommand): boolean {
    if (!managerRef.current) {
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
    if (!managerRef.current || commands.length === 0) {
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

  function createFeature(command: AnyCommand): void {
    if (executeCommand(command)) {
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
  }

  function startExtrude(sketchId: SketchId) {
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(sketchId);
    setExtrudePreview({ sketchId, distance: 0 });
    setTool('extrude');
    requestView('iso');
    setStatus('Extrude: drag the arrow to either side of the sketch plane.');
  }

  function confirmExtrude() {
    if (!extrudePreview || Math.abs(extrudePreview.distance) < 0.1) {
      setStatus('Drag the extrusion arrow away from the sketch plane first.');
      return;
    }
    const created = executeCommand(
      commandFactories.extrudeSketch({
        name: `Extrude ${features.filter((feature) => feature.featureKind === 'extrude').length + 1}`,
        sketchId: extrudePreview.sketchId as SketchId,
        distance: extrudePreview.distance
      })
    );
    if (!created) {
      return;
    }
    const createdFeature = listFeaturesInOrder(managerRef.current!.document).at(
      -1
    );
    setExtrudePreview(null);
    setSelectedSketchProfileId(null);
    setTool(null);
    setSelectedFeatureNodeId(createdFeature?.id ?? null);
    setSelectedBodyIds(createdFeature?.bodyId ? [createdFeature.bodyId] : []);
    setStatus(
      `Created ${createdFeature?.name ?? 'extrusion'} ${extrudePreview.distance > 0 ? 'above' : 'below'} the sketch plane.`
    );
  }

  function launchTool(nextTool: ToolId) {
    const reason = toolDisabledReason(nextTool, availability);
    if (reason) {
      setStatus(`${TOOL_META[nextTool].label}: ${reason}.`);
      return;
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
        selectedSketchProfileId ??
        selectedSketch?.sketchId ??
        (sketchOptions.length === 1 ? sketchOptions[0]!.sketchId : null);
      if (sketchId) {
        startExtrude(sketchId);
      } else {
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
    // Selection is kept on purpose: booleans/move/fillet pre-fill from it.
    setExtrudePreview(null);
    setTool(nextTool);
  }

  function cancelPanel() {
    setExtrudePreview(null);
    setMovePreview(null);
    setTool(null);
    setSelectedFeatureNodeId(null);
  }

  function confirmMove() {
    const preview = movePreview;
    if (!preview || !doc) {
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
    createFeature(
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
  }

  function clearSelection() {
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setSelectedEdges([]);
    setSelectedBodyIds([]);
    setSelectedSketchProfileId(null);
    if (interaction.mode !== 'idle' && interaction.mode !== 'sketch') {
      dispatchInteraction({ type: 'clear' });
    }
  }

  function requestView(view: StandardView) {
    setViewRequest({ view, nonce: ++viewNonceRef.current });
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
    syncedRevisionRef.current = null;
    setAppSettings(next);
    setSettingsMessage(
      accountSettings?.synced
        ? 'Saved on this device · not yet saved to your account.'
        : 'Saved on this device.'
    );
  }

  function focusAssistantPrompt() {
    setAssistantFocusNonce((nonce) => nonce + 1);
  }

  function openSettings() {
    setSettingsOpen(true);
    setPaletteOpen(false);
    setSettingsMessage('Changes save on this device immediately.');
    setAuthConfigStatus('loading');
    void Promise.all([
      api
        .authConfig()
        .then((config) => ({ config, status: 'ready' as const }))
        .catch(() => ({ config: null, status: 'unavailable' as const })),
      api.session().catch(() => null)
    ]).then(async ([nextAuth, activeSession]) => {
      setAuthConfig(nextAuth.config);
      setAuthConfigStatus(nextAuth.status);
      setSession(activeSession);
      if (!activeSession) {
        setAccountSettings(null);
        setSettingsMessage(
          nextAuth.status === 'ready'
            ? 'Device settings active · sign in for cloud sync.'
            : 'Beta sign-in unavailable · device settings remain active.'
        );
        return;
      }
      try {
        setAccountSettings(await api.getSettings());
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

  async function handleSaveAppSettings() {
    if (!session || !accountSettings) {
      setSettingsMessage('Account sync unavailable · device settings active.');
      return;
    }
    setSettingsBusy(true);
    setSettingsMessage('Saving account settings…');
    try {
      const response = await api.updateSettings({
        settings: appSettings,
        expectedRevision: accountSettings.revision
      });
      setAccountSettings(response);
      syncedRevisionRef.current = response.revision;
      saveLocalAppSettings(appSettings, response.revision);
      setSettingsMessage('Saved to this device and account.');
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Account settings save failed.'));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function syncSettingsBeforeAssistantAction() {
    if (!session || !accountSettings) {
      throw new Error('Account settings storage is unavailable.');
    }
    const response = await api.updateSettings({
      settings: appSettings,
      expectedRevision: accountSettings.revision
    });
    setAccountSettings(response);
    syncedRevisionRef.current = response.revision;
    saveLocalAppSettings(appSettings, response.revision);
    return response;
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
      const [remoteSettings, localProjects, remoteProjects] = await Promise.all(
        [
          api.getSettings(),
          listLocalProjects().catch(() => []),
          api.listProjects().catch(() => ({ projects: [] }))
        ]
      );
      setSession(activeSession);
      setAccountSettings(remoteSettings);
      setProjects(
        mergeProjectSummaries(localProjects, remoteProjects.projects)
      );
      const activeProjectIsCloud = Boolean(
        doc && remoteVersionsRef.current.has(doc.projectId)
      );
      setCloudAvailable(activeProjectIsCloud);
      if (doc) {
        setSaveState(activeProjectIsCloud ? 'saved' : 'offline');
      }
      setSettingsMessage(
        `Signed in as ${activeSession.email ?? activeSession.displayName}.`
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
      await api.logout();
      const localProjects = await listLocalProjects().catch(() => []);
      remoteVersionsRef.current.clear();
      setSession(null);
      setAccountSettings(null);
      setCloudAvailable(false);
      setProjects(localProjects);
      setSaveState('offline');
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
    syncedRevisionRef.current = null;
    setAppSettings(defaults);
    saveLocalAppSettings(defaults, null);
    setSettingsMessage('Application settings reset on this device.');
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
    setBusy(true);
    try {
      if (!session) {
        const localDocument = createProjectDocument(name, localUserId, units);
        await saveLocalProject(localDocument);
        hydrateDocument(localDocument);
        setProjects((current) => [
          {
            projectId: localDocument.projectId,
            name: localDocument.name,
            updatedAt: localDocument.derived.updatedAt,
            revisionCount: localDocument.checkpoints.length
          },
          ...current
        ]);
        setCloudAvailable(false);
        setSaveState('offline');
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
        setSession(null);
        setAccountSettings(null);
      }
      const localDocument = createProjectDocument(
        name,
        sessionExpired ? localUserId : (session?.userId ?? localUserId),
        units
      );
      await saveLocalProject(localDocument);
      hydrateDocument(localDocument);
      setProjects((current) => [
        {
          projectId: localDocument.projectId,
          name: localDocument.name,
          updatedAt: localDocument.derived.updatedAt,
          revisionCount: localDocument.checkpoints.length
        },
        ...current
      ]);
      setCloudAvailable(false);
      setSaveState('offline');
      setStatus(`${errorMessage(error, 'Cloud unavailable')} Working locally.`);
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
        {
          projectId: document.projectId,
          name: document.name,
          updatedAt: document.derived.updatedAt,
          revisionCount: document.checkpoints.length
        },
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
      const [localDocument, remoteDocument] = await Promise.all([
        loadLocalProject(projectId),
        session
          ? api.loadProject(projectId).catch(() => null)
          : Promise.resolve(null)
      ]);
      const loaded = selectProjectDocument(localDocument, remoteDocument);
      if (!loaded) {
        throw new Error('Project not found locally or in the beta API.');
      }
      setCloudAvailable(Boolean(remoteDocument));
      if (remoteDocument) {
        remoteVersionsRef.current.set(
          remoteDocument.projectId,
          remoteDocument.version
        );
      }
      hydrateDocument(loaded);
      setStatus(
        loaded === localDocument && remoteDocument
          ? `Opened newer local edits for ${loaded.name}.`
          : `Opened ${loaded.name}.`
      );
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to open project.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoHome() {
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
    setExtrudePreview(null);
    setTool(null);
    try {
      const [local, remote] = await Promise.all([
        listLocalProjects(),
        session ? api.listProjects().catch(() => null) : Promise.resolve(null)
      ]);
      const merged = mergeProjectSummaries(local, remote?.projects ?? []);
      setProjects(merged);
      setCloudAvailable(Boolean(remote));
      setStatus(`${merged.length} project(s) available.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to refresh projects.'));
    }
  }

  function handleUndo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.undo());
    setExtrudePreview(null);
    setTool(null);
    clearSelection();
    setStatus('Undo');
  }

  function handleRedo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.redo());
    setExtrudePreview(null);
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
      const expectedVersion = remoteVersionsRef.current.get(doc.projectId);
      if (!session || expectedVersion === undefined) {
        setCloudAvailable(false);
        setSaveState('offline');
        setStatus('Saved locally.');
        return;
      }
      const saved = await api.saveRevision({
        projectId: doc.projectId,
        reason: 'Manual save',
        expectedVersion,
        document: doc
      });
      remoteVersionsRef.current.set(saved.projectId, saved.version);
      if (managerRef.current) {
        managerRef.current.document = saved;
      }
      setDoc(saved);
      setCloudAvailable(true);
      setSaveState('saved');
      setStatus('Saved revision.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        remoteVersionsRef.current.clear();
        setSession(null);
        setAccountSettings(null);
      }
      setCloudAvailable(false);
      setSaveState('offline');
      setStatus(`${errorMessage(error, 'Cloud save failed')} Saved locally.`);
    }
  }

  function handlePreviewPatch(proposal: CadPatchProposal | null): boolean {
    if (!proposal || !doc) {
      setPreviewDoc(null);
      setStatus('Preview cleared.');
      return true;
    }
    try {
      const previewManager = new CommandManager(doc);
      const preview = previewManager.runTransaction(
        'Preview AI patch',
        commandsForCadPatch(doc, proposal)
      );
      // The compat kernel shares the exact kernel's primitive frame, so
      // placement is faithful, but it cannot build every feature kind. Say so
      // when it had to skip something rather than showing a quietly partial
      // model.
      const derived = kernel.syncDocument(preview);
      setPreviewDoc({ ...preview, derived });
      setStatus(
        derived.warnings.length > 0
          ? `Previewing proposed patch · ${derived.warnings.length} warning(s) · exact rebuild occurs after apply.`
          : 'Previewing proposed patch · exact rebuild occurs after apply.'
      );
      return true;
    } catch (error) {
      setPreviewDoc(null);
      setStatus(errorMessage(error, 'Patch preview failed.'));
      return false;
    }
  }

  function handleApplyPatch(proposal: CadPatchProposal): boolean {
    if (!doc) {
      return false;
    }
    try {
      const applied = executeTransaction(
        'Apply AI patch',
        commandsForCadPatch(doc, proposal)
      );
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
    if (!managerRef.current || !doc) {
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

  function featureNodeIdForBody(bodyId: BodyId): string | null {
    if (!doc) {
      return null;
    }
    const bodyNode = listNodesByKind(doc, 'body').find(
      (body) => body.bodyId === bodyId
    );
    const feature = bodyNode
      ? features.find((candidate) => candidate.featureId === bodyNode.featureId)
      : undefined;
    return feature?.id ?? null;
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
    const geometry = faceTopology?.geometry;
    if (geometry?.surfaceType !== 'plane' || target.hash === undefined) {
      setStatus('Pick a planar face to sketch on, or choose a plane.');
      return false;
    }
    dispatchInteraction({
      type: 'enter-sketch',
      plane: {
        type: 'face',
        bodyId: target.bodyId as BodyId,
        faceHash: target.hash,
        sourceArea: geometry.area,
        sourceCenter: geometry.center,
        sourceNormal: geometry.normal ?? {
          x: target.normal[0],
          y: target.normal[1],
          z: target.normal[2]
        },
        frame: frameFromFace(
          geometry.center,
          geometry.normal ?? {
            x: target.normal[0],
            y: target.normal[1],
            z: target.normal[2]
          }
        )
      }
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
          point: [detail.point.x, detail.point.y, detail.point.z],
          normal: [detail.normal.x, detail.normal.y, detail.normal.z],
          surfaceType: 'planar'
        };
        if (startSketchOnFace(target)) {
          return;
        }
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
      const surface = faceTopology?.geometry?.surfaceType;
      const target: FaceTarget = {
        bodyId: selection.bodyId,
        topologyId: selection.topologyId,
        hash: selection.hash,
        point: [detail.point.x, detail.point.y, detail.point.z],
        normal: [detail.normal.x, detail.normal.y, detail.normal.z],
        surfaceType:
          surface === 'plane'
            ? 'planar'
            : surface === 'cylinder'
              ? 'cylindrical'
              : 'other',
        diameter: faceTopology?.geometry?.diameter
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
    const edges = (body.topology?.edges ?? []).map(
      (edge): TopologySelection => ({
        bodyId: body.bodyId,
        kind: 'edge',
        topologyId: edge.topologyId,
        hash: edge.hash
      })
    );
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
  const parameterScopeRef = useRef(parameterScope);
  parameterScopeRef.current = parameterScope;
  const sketchBasis = useMemo(
    () =>
      sketchSessionPlane
        ? frameForPlaneRef(
            sketchSessionPlane,
            (value) =>
              evalParamValue(value, parameterScopeRef.current.scope) ?? 0
          )
        : null,
    [sketchSessionPlane]
  );

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
      parameterScope: parameterScope.scope
    };
  }, [
    interaction,
    doc,
    sketchBasis,
    appSettings.sketching,
    parameterScope.scope
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
    const session = interaction.session;
    if (!session.sketchId) {
      const name = `Sketch ${String(sketchOptions.length + 1).padStart(2, '0')}`;
      if (
        !executeCommand(
          commandFactories.addSketch({
            name,
            planeRef: session.plane,
            objects: [object]
          })
        )
      ) {
        return;
      }
      const sketchId = managerRef.current?.document.sketchOrder.at(-1);
      if (sketchId) {
        dispatchInteraction({ type: 'sketch-created', sketchId });
      }
      setStatus(`${name} started.`);
      return;
    }
    executeCommand(
      commandFactories.addSketchObjects(
        {
          sketchId: session.sketchId as SketchId,
          objects: [object]
        },
        `Add ${object.objectKind}`
      )
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
    if (
      executeCommand(
        commandFactories.updateSketchObject(
          {
            sketchId: interaction.session.sketchId as SketchId,
            objectId: interaction.session.selectedObjectId as EntityId,
            data
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
    if (!doc || !appSettings.experiments.directManipulation) {
      return [];
    }
    const scope = parameterScope.scope;
    const resolve = (value: unknown): number =>
      evalParamValue(value as ParamValue, scope) ?? 0;
    return listNodesByKind(doc, 'sketch').flatMap((sketch) => {
      if (
        interaction.mode === 'sketch' &&
        interaction.session.sketchId === sketch.sketchId
      ) {
        return [];
      }
      const objects = sketch.objectIds.flatMap((objectId) => {
        const node = doc.nodes[objectId];
        return node?.kind === 'sketch-object'
          ? [{ id: objectId, data: node.data }]
          : [];
      });
      if (objects.length === 0) {
        return [];
      }
      const basis = frameForPlaneRef(sketch.planeRef, resolve);
      const curves = objects.flatMap((object) => {
        try {
          const polyline = objectPolyline(object.data, resolve);
          return polyline ? [polyline] : [];
        } catch {
          return [];
        }
      });
      let regions: {
        regionFingerprint: number;
        samplePoint: { x: number; y: number };
        area: number;
        outer: { x: number; y: number }[];
        holes: { x: number; y: number }[][];
      }[] = [];
      try {
        regions = computeSketchRegions(objects, (value) => resolve(value)).map(
          (region) => ({
            regionFingerprint: region.regionFingerprint,
            samplePoint: region.samplePoint,
            area: region.area,
            outer: region.outer.polyline,
            holes: region.holes.map((hole) => hole.polyline)
          })
        );
      } catch {
        // Unresolvable sketches simply render without pickable regions.
      }
      return [{ sketchId: sketch.sketchId, basis, curves, regions }];
    });
  }, [
    doc,
    parameterScope,
    appSettings.experiments.directManipulation,
    interaction
  ]);

  /** After a region extrude, offer a one-click return to its sketch. */
  const [revertPill, setRevertPill] = useState<{ sketchId: SketchId } | null>(
    null
  );
  useEffect(() => {
    if (interaction.mode !== 'idle') {
      setRevertPill(null);
    }
  }, [interaction.mode]);

  /** A detected region was clicked: arm the extrude handle. */
  function handleSelectRegion(region: RegionPickData) {
    if (!appSettings.experiments.directManipulation) {
      return;
    }
    setSelectedSketchProfileId(null);
    setExtrudePreview(null);
    dispatchInteraction({
      type: 'select-region',
      target: {
        sketchId: region.sketchId,
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.samplePoint,
        area: region.area
      }
    });
    setStatus('Drag the arrow to extrude the region, or tap the value.');
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
    const command = commandFactories.extrudeSketch({
      name: 'Extrude',
      sketchId: target.sketchId as SketchId,
      distance: exact ?? rounded,
      profile: {
        regionFingerprint: target.regionFingerprint,
        samplePoint: target.samplePoint,
        sourceArea: target.area
      }
    });
    const resultBodyId =
      command.payload.ids?.bodyId ?? (target.sketchId as unknown as BodyId);
    void executeValidatedDirectEdit(
      command,
      resultBodyId,
      `Extruded region by ${rounded} ${doc?.units ?? ''}.`,
      rounded,
      () => setRevertPill({ sketchId: target.sketchId as SketchId })
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
    if (interaction.mode !== 'face' || interaction.phase === 'validating') {
      return null;
    }
    const target = interaction.target;
    const point = {
      x: target.point[0],
      y: target.point[1],
      z: target.point[2]
    };
    if (interaction.op === 'offset-face') {
      if (target.surfaceType !== 'planar') {
        return null;
      }
      return {
        bodyId: target.bodyId,
        topologyId: target.topologyId,
        point,
        normal: {
          x: target.normal[0],
          y: target.normal[1],
          z: target.normal[2]
        },
        initialValue: interaction.lastValue ?? 0
      };
    }
    // resize-hole: the drag direction is radial — outward from the
    // cylinder's axis through the click point.
    const radial = cylinderRadialAt(target);
    if (!radial) {
      return null;
    }
    return {
      bodyId: target.bodyId,
      topologyId: target.topologyId,
      point,
      normal: radial.direction,
      initialValue:
        interaction.lastValue !== null && target.diameter !== undefined
          ? interaction.lastValue - target.diameter
          : 0
    };
  }, [interaction]);

  /**
   * Radial outward direction and concavity of a cylindrical face at a click
   * point. Concavity comes from the picked triangle normal: a bore's surface
   * faces the axis, a boss faces away from it.
   */
  function cylinderRadialAt(target: FaceTarget): {
    direction: { x: number; y: number; z: number };
    concavity: 'hole' | 'boss';
  } | null {
    const geometry = representations[
      target.bodyId as BodyId
    ]?.topology?.faces.find(
      (face) => face.topologyId === target.topologyId
    )?.geometry;
    if (!geometry?.axisStart || !geometry.axisEnd) {
      return null;
    }
    const a = geometry.axisStart;
    const b = geometry.axisEnd;
    const axis = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const axisLength = Math.hypot(axis.x, axis.y, axis.z);
    if (axisLength < 1e-9) {
      return null;
    }
    const unit = {
      x: axis.x / axisLength,
      y: axis.y / axisLength,
      z: axis.z / axisLength
    };
    const toPoint = {
      x: target.point[0] - a.x,
      y: target.point[1] - a.y,
      z: target.point[2] - a.z
    };
    const along = toPoint.x * unit.x + toPoint.y * unit.y + toPoint.z * unit.z;
    const foot = {
      x: a.x + unit.x * along,
      y: a.y + unit.y * along,
      z: a.z + unit.z * along
    };
    const radial = {
      x: target.point[0] - foot.x,
      y: target.point[1] - foot.y,
      z: target.point[2] - foot.z
    };
    const radialLength = Math.hypot(radial.x, radial.y, radial.z);
    if (radialLength < 1e-9) {
      return null;
    }
    const direction = {
      x: radial.x / radialLength,
      y: radial.y / radialLength,
      z: radial.z / radialLength
    };
    const facesInward =
      target.normal[0] * direction.x +
        target.normal[1] * direction.y +
        target.normal[2] * direction.z <
      0;
    return { direction, concavity: facesInward ? 'hole' : 'boss' };
  }

  /** Commits a cylindrical-face resize; `diameter` is the absolute value. */
  function handleResizeCylindricalCommit(diameter: number) {
    if (interaction.mode !== 'face' || interaction.op !== 'resize-hole') {
      return;
    }
    const target = interaction.target;
    const geometry = representations[
      target.bodyId as BodyId
    ]?.topology?.faces.find(
      (face) => face.topologyId === target.topologyId
    )?.geometry;
    const radial = cylinderRadialAt(target);
    if (
      !geometry?.radius ||
      !geometry.axisStart ||
      !geometry.axisEnd ||
      !radial ||
      target.hash === undefined
    ) {
      setStatus('Exact cylinder measurements are unavailable.');
      dispatchInteraction({ type: 'clear' });
      return;
    }
    const rounded = Math.round(diameter * 1000) / 1000;
    if (rounded <= 0) {
      setStatus('Diameter must be greater than zero.');
      return;
    }
    void executeValidatedDirectEdit(
      commandFactories.directEditBody({
        name: radial.concavity === 'hole' ? 'Resize hole' : 'Resize boss',
        targetBodyId: target.bodyId as BodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: target.hash,
          sourceRadius: geometry.radius,
          sourceAxisStart: geometry.axisStart,
          sourceAxisEnd: geometry.axisEnd,
          concavity: radial.concavity,
          radius: rounded / 2
        }
      }),
      target.bodyId as BodyId,
      `Resized ${radial.concavity} to ⌀ ${rounded} ${doc?.units ?? ''}.`,
      rounded
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
    if (!bodyId || edgeHashes.length === 0) {
      return null;
    }
    const payload = {
      name:
        currentInteraction.op === 'fillet'
          ? 'Fillet edges'
          : 'Chamfer edges',
      targetBodyId: bodyId,
      edgeHashes,
      size
    };
    return currentInteraction.op === 'fillet'
      ? commandFactories.filletEdges(payload)
      : commandFactories.chamferEdges(payload);
  }

  /** Edge-radius drag released (or exact entry): commit fillet/chamfer. */
  function handleEdgeCommit(size: number, exact?: ParamValue) {
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
    if (interaction.mode === 'face' && interaction.op === 'resize-hole') {
      const geometry = representations[
        interaction.target.bodyId as BodyId
      ]?.topology?.faces.find(
        (face) => face.topologyId === interaction.target.topologyId
      )?.geometry;
      setKeypad({
        kind: 'diameter',
        label: '⌀',
        initial:
          geometry?.diameter !== undefined
            ? String(
                Math.round((geometry.diameter + currentOffset) * 100) / 100
              )
            : '',
        unitKind: 'length',
        baseline: geometry?.diameter
      });
      return;
    }
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

  function handleSelectionAction(action: SelectionActionId) {
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
    if (interaction.mode === 'face' && interaction.op === 'resize-hole') {
      // The drag reads as a diameter delta on the current bore/boss.
      const geometry = representations[
        interaction.target.bodyId as BodyId
      ]?.topology?.faces.find(
        (face) => face.topologyId === interaction.target.topologyId
      )?.geometry;
      if (geometry?.diameter !== undefined) {
        handleResizeCylindricalCommit(geometry.diameter + offset);
      }
      return;
    }
    if (interaction.mode !== 'face' || interaction.op !== 'offset-face') {
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
    const label = 'Remove imported feature';
    void executeValidatedDirectEdit(
      commandFactories.directEditBody({
        name: label,
        targetBodyId: selection.bodyId,
        operation: {
          kind: 'remove-face-feature',
          faceHash: selection.hash ?? -1,
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
    setSelectedSketchProfileId(
      node?.kind === 'feature' && node.data.featureKind === 'sketch'
        ? node.data.sketchId
        : null
    );
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

  function openContextMenu(
    x: number,
    y: number,
    entries: { item: ContextMenuState['items'][number]; run(): void }[]
  ) {
    contextMenuActionsRef.current = Object.fromEntries(
      entries.map((entry) => [entry.item.id, entry.run])
    );
    setContextMenu({ x, y, items: entries.map((entry) => entry.item) });
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
      openContextMenu(x, y, [
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
      ]);
      return;
    }
    // Adopt the clicked geometry as the selection so actions target it.
    handleSelectTopologyFromViewer(selection, false);
    const nodeId = featureNodeIdForBody(selection.bodyId);
    const node = nodeId ? doc.nodes[nodeId] : undefined;
    const feature = node?.kind === 'feature' ? node : null;
    const edge = selection.kind === 'edge';
    openContextMenu(x, y, [
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
    ]);
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

  // Workspace keyboard map (ignored while typing in a field).
  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
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
          confirmExtrude();
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

      if (typing || meta || event.altKey) {
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
            dispatchInteraction({ type: 'escape' });
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
      const shortcutTool = SHORTCUT_TO_TOOL[key];
      if (shortcutTool) {
        // Without this the same keystroke would type into the form field
        // that the tool dialog autofocuses.
        event.preventDefault();
        launchTool(shortcutTool);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (startupState === 'restoring') {
    return <StartupScreen />;
  }

  if (settingsOpen) {
    return (
      <SettingsPage
        settings={appSettings}
        accountState={accountSettings}
        authConfig={authConfig}
        authConfigStatus={authConfigStatus}
        session={session}
        busy={settingsBusy}
        message={settingsMessage}
        onChange={handleAppSettingsChange}
        onSave={() => void handleSaveAppSettings()}
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
    );
  }

  if (!doc) {
    return (
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
      />
    );
  }

  const tone: 'ready' | 'warning' | 'running' =
    /fail|error|invalid|unable|denied/i.test(status) ? 'warning' : 'ready';

  const hint =
    tool === 'sketch'
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
                    : 'Ctrl+K commands · ? shortcuts';

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
  // rail's mount effect. A direct-manipulation mode hides it temporarily.
  const assistantAvailable = appSettings.assistant.enabled && !directMode;
  const contextualToolCard = toolCardFor(interaction);
  const inspectorActive =
    !directMode && (tool !== null || selectedFeature !== null);

  return (
    <AppShell
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
          onRenameProject={(name) =>
            executeCommand(
              commandFactories.renameNode({ nodeId: doc.rootNodeId, name })
            )
          }
          onGoHome={() => void handleGoHome()}
          onOpenSettings={openSettings}
        />
      }
      toolBar={
        tool === 'sketch' ? (
          <div className="direct-mode-strip">
            <PenLine size={16} aria-hidden="true" />
            <strong>Sketch mode</strong>
            <span>
              Draw one closed profile · dimensions stay editable in history
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
            selectedTopology={selectedTopology}
            selectedEdges={selectedEdges}
            settings={viewerSettings}
            fitSignal={fitSignal}
            viewRequest={viewRequest}
            units={doc.units}
            editableBodyIds={directEditableBodyIds}
            extrudePreview={extrudePreview}
            movePreview={movePreview}
            hideViewerToolbar={false}
            selectionChip={selectionChip}
            onClearSelection={clearSelection}
            onStartPrimitive={launchTool}
            onAskAssistant={
              assistantAvailable
                ? () => {
                    setAssistantCollapsed(false);
                    focusAssistantPrompt();
                  }
                : null
            }
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
            onSelectRegion={handleSelectRegion}
            regionHandle={regionHandleTarget}
            modeOverlay={
              contextualToolCard ? (
                <>
                  <ToolCard
                    model={contextualToolCard}
                    onAction={handleSelectionAction}
                    onClose={() =>
                      dispatchInteraction({
                        type:
                          interaction.mode === 'sketch'
                            ? 'exit-sketch'
                            : 'clear'
                      })
                    }
                  />
                  {interaction.mode === 'sketch' && (
                    <SketchToolRail
                      tool={interaction.session.tool}
                      onTool={(sketchTool) =>
                        dispatchInteraction({
                          type: 'sketch-tool',
                          tool: sketchTool
                        })
                      }
                      onExit={() =>
                        dispatchInteraction({ type: 'exit-sketch' })
                      }
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
                        // The rig animates a delta; absolute kinds convert.
                        offsetSetterRef.current?.(
                          keypad.baseline === undefined
                            ? value
                            : value - keypad.baseline
                        );
                        if (keypad.kind === 'edge') {
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
                        } else if (keypad.kind === 'diameter') {
                          handleResizeCylindricalCommit(value);
                        } else {
                          handleOffsetCommit(
                            value,
                            isExpression ? raw : undefined
                          );
                        }
                      }}
                      onCancel={() => {
                        offsetSetterRef.current?.(0);
                        if (keypad.kind === 'edge') {
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
                  <Undo2 size={14} aria-hidden="true" />
                  Revert to Sketch
                </button>
              ) : movePreview ? (
                <MoveOverlay
                  bodyName={
                    representations[movePreview.bodyId as BodyId]?.name ??
                    'Selected body'
                  }
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
                  profileName={selectedSketchProfileName}
                  distance={extrudePreview.distance}
                  units={doc.units}
                  onDistanceChange={(distance) =>
                    Number.isFinite(distance) &&
                    setExtrudePreview((current) =>
                      current ? { ...current, distance } : current
                    )
                  }
                  onConfirm={confirmExtrude}
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
              ) : selectedSketchProfileId && selectedSketchProfileName ? (
                <ProfileQuickAction
                  profileName={selectedSketchProfileName}
                  onExtrude={() => startExtrude(selectedSketchProfileId)}
                  onDismiss={() => setSelectedSketchProfileId(null)}
                />
              ) : null
            }
            projection={projection}
            orientationRef={orientationRef}
            onSelectTopology={handleSelectTopologyFromViewer}
            onSelectEdgeChain={handleSelectEdgeChainFromViewer}
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
            <Inspector
              tool={tool}
              selectedFeature={selectedFeature}
              selectedSketch={selectedSketch}
              selectedSketchObject={selectedSketchObject}
              selectedBody={selectedBody}
              selectedTopology={selectedTopology}
              selectedEdges={selectedEdges}
              edgeModifierBody={edgeModifierBody}
              scope={parameterScope.scope}
              sketches={sketchOptions}
              bodies={bodyOptions}
              units={doc.units}
              selectedBodyIds={selectedBodyIds}
              preferredSketchId={selectedSketch?.sketchId ?? null}
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
              onCreateBoolean={(value) =>
                createFeature(commandFactories.booleanBodies(value))
              }
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
                if (feature.data.featureKind !== 'sketch' || !selectedSketch) {
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
              onApplyExtrude={(feature, value) =>
                executeCommand(
                  commandFactories.updateFeature(
                    {
                      featureId: feature.featureId,
                      name: value.name,
                      data: {
                        featureKind: 'extrude',
                        sketchId: value.sketchId,
                        distance: value.distance
                      }
                    },
                    `Edit ${value.name}`
                  )
                )
              }
              onApplyRevolve={(feature, value) =>
                executeCommand(
                  commandFactories.updateFeature(
                    {
                      featureId: feature.featureId,
                      name: value.name,
                      data: {
                        featureKind: 'revolve',
                        sketchId: value.sketchId,
                        axis: value.axis
                      }
                    },
                    `Edit ${value.name}`
                  )
                )
              }
              onApplyBoolean={(feature, value) =>
                executeCommand(
                  commandFactories.updateFeature(
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
                  )
                )
              }
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
              focusNonce={assistantFocusNonce}
            />
          </ErrorBoundary>
        ) : null
      }
      statusBar={
        <StatusBar
          status={status}
          tone={tone}
          hint={hint}
          projectName={doc.name}
          bodyCount={viewerBodies.length}
          featureCount={features.length}
          warningCount={warnings.length}
          documentVersion={doc.version}
          units={doc.units}
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
          {contextMenu && (
            <ContextMenu
              menu={contextMenu}
              onSelect={(itemId) => contextMenuActionsRef.current[itemId]?.()}
              onClose={() => setContextMenu(null)}
            />
          )}
        </>
      }
    />
  );
}
