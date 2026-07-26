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
  AuthSession
} from '@openzcad/shared';
import { toUserId } from '@openzcad/shared';
import { api } from './lib/api';
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
import { SettingsPage } from './components/SettingsPage';
import { buildDemoDocument, DEMO_DEFINITIONS } from './lib/demos';
import type { DemoDefinition } from './lib/demos';
import { AiCommandRail } from './components/AiCommandRail';
import { SketchWorkspace } from './components/SketchWorkspace';
import {
  ExtrudeOverlay,
  MoveOverlay,
  ProfileQuickAction
} from './components/DirectModelingOverlays';
import { composeMoveTransform } from './components/ModelViewer';
import type { SketchFormValue } from './components/forms/FeatureForms';
import { ToolCard } from './components/ToolCard';
import {
  NumericKeypad,
  type KeypadRequest
} from './components/NumericKeypad';
import {
  IDLE,
  interactionReducer,
  toolCardFor,
  type FaceTarget
} from './lib/interaction/machine';
import { frameFromFace } from './lib/sketch/session';
import { SketchToolRail } from './components/SketchToolRail';
import {
  CommandPalette,
  type PaletteCommand
} from './components/CommandPalette';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { DISPLAY_MODE_LABELS } from './components/ViewerToolbar';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import type {
  AxisProjection,
  DisplayMode,
  ExtrudePreview,
  FaceResizeCommit,
  MovePreview,
  MoveSnap,
  PickDetail,
  ProjectionMode,
  SketchOverlay,
  StandardView,
  ViewerSettings
} from './components/ModelViewer';
import {
  listLocalProjects,
  loadLocalProject,
  selectProjectDocument,
  saveLocalProject
} from './lib/localProjectStore';
import type {
  GeometryExportResult,
  GeometryWorkerResult
} from './worker/geometryWorker';
import { useCollaboration } from './lib/useCollaboration';
import {
  clearActiveProject,
  loadActiveProjectId,
  loadProjectView,
  rememberActiveProject,
  saveProjectView,
  type ViewportCameraState
} from './lib/workspaceSession';
import {
  defaultAppSettings,
  loadLocalAppSettings,
  saveLocalAppSettings
} from './lib/appSettings';

const kernel = createKernelAdapter();
const localUserId = toUserId('user_local_browser');
const MAX_EMBEDDED_STEP_BYTES = 12 * 1024 * 1024;
const DISPLAY_MODE_ORDER: DisplayMode[] = [
  'shaded-edges',
  'shaded',
  'wireframe'
];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

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
  const [appSettings, setAppSettings] = useState<AppSettings>(() =>
    loadLocalAppSettings()
  );
  const [accountSettings, setAccountSettings] =
    useState<AppSettingsResponse | null>(null);
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
  const [viewerSettings, setViewerSettings] = useState<ViewerSettings>(() => ({
    showGrid: appSettings.viewport.showGrid,
    displayMode: appSettings.viewport.displayMode
  }));
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
  const [projection, setProjection] = useState<ProjectionMode>(
    appSettings.viewport.defaultProjection
  );
  const [initialView, setInitialView] = useState<ViewportCameraState | null>(
    null
  );
  const [hiddenBodyIds, setHiddenBodyIds] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const orientationRef = useRef<((axes: AxisProjection) => void) | null>(null);
  /** Click point + normal of the latest topology pick (drag-handle anchor). */
  const lastPickDetailRef = useRef<PickDetail | null>(null);
  /** Selection-first direct-manipulation mode machine (behind experiment flag). */
  const [interaction, dispatchInteraction] = useReducer(
    interactionReducer,
    IDLE
  );
  /** Open exact-value entry (anchored keypad) for the armed handle. */
  const [keypad, setKeypad] = useState<KeypadRequest | null>(null);
  const keypadAnchorRef = useRef<
    ((point: { x: number; y: number } | null) => void) | null
  >(null);
  /** Lets keypad typing drive the viewport's offset-handle preview. */
  const offsetSetterRef = useRef<((offset: number) => void) | null>(null);
  const contextMenuActionsRef = useRef<Record<string, () => void>>({});
  const managerRef = useRef<CommandManager | null>(null);
  const geometryWorkerRef = useRef<Worker | null>(null);
  const exportRequestsRef = useRef(
    new Map<
      string,
      {
        resolve(result: Extract<GeometryExportResult, { ok: true }>): void;
        reject(error: Error): void;
      }
    >()
  );
  const syncRequestsRef = useRef(
    new Map<
      string,
      {
        resolve(derived: ProjectDocument['derived']): void;
        reject(error: Error): void;
      }
    >()
  );
  const lastSyncedKeyRef = useRef<string | null>(null);
  const remoteVersionsRef = useRef(new Map<string, number>());
  const directEditInFlightRef = useRef(false);
  const viewNonceRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const viewportCameraRef = useRef<ViewportCameraState | null>(null);

  const collaboration = useCollaboration({
    document: doc,
    session,
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
    saveLocalAppSettings(appSettings);
    globalThis.document.documentElement.dataset.density =
      appSettings.appearance.density;
    globalThis.document.documentElement.dataset.reducedMotion = appSettings
      .appearance.reducedMotion
      ? 'true'
      : 'false';
  }, [appSettings]);

  useEffect(() => {
    const worker = new Worker(
      new URL('./worker/geometryWorker.ts', import.meta.url),
      {
        type: 'module'
      }
    );
    geometryWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent<GeometryWorkerResult>) => {
      if (event.data.type === 'export') {
        const pending = exportRequestsRef.current.get(event.data.requestId);
        if (!pending) {
          return;
        }
        exportRequestsRef.current.delete(event.data.requestId);
        if (event.data.ok) {
          pending.resolve(event.data);
        } else {
          pending.reject(new Error(event.data.error));
        }
        return;
      }
      // Caller-owned one-off syncs (demo seeding) resolve by request id.
      if (event.data.requestId) {
        const pending = syncRequestsRef.current.get(event.data.requestId);
        if (pending) {
          syncRequestsRef.current.delete(event.data.requestId);
          if (event.data.ok) {
            pending.resolve(event.data.derived);
          } else {
            pending.reject(new Error(event.data.error));
          }
        }
        return;
      }
      const manager = managerRef.current;
      if (!manager) {
        return;
      }
      const result = event.data;
      // Ignore results for documents we are no longer showing.
      if (
        result.projectId !== manager.document.projectId ||
        result.version !== manager.document.version
      ) {
        return;
      }
      if (!result.ok) {
        setStatus(`Geometry rebuild failed: ${result.error}`);
        return;
      }
      setDoc(manager.commitDerivedState(result.derived));
    };

    return () => {
      for (const request of exportRequestsRef.current.values()) {
        request.reject(new Error('Geometry worker closed.'));
      }
      exportRequestsRef.current.clear();
      for (const request of syncRequestsRef.current.values()) {
        request.reject(new Error('Geometry worker closed.'));
      }
      syncRequestsRef.current.clear();
      worker.terminate();
      geometryWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const activeProjectId = appSettings.general.reopenLastProject
        ? loadActiveProjectId()
        : null;
      const [local, remote, rememberedLocal, rememberedRemote, remoteSettings] =
        await Promise.all([
          listLocalProjects().catch(() => []),
          Promise.all([api.health(), api.session(), api.listProjects()]).catch(
            () => null
          ),
          activeProjectId
            ? loadLocalProject(activeProjectId).catch(() => null)
            : Promise.resolve(null),
          activeProjectId
            ? api.loadProject(activeProjectId).catch(() => null)
            : Promise.resolve(null),
          api.getSettings().catch(() => null)
        ]);
      const remoteProjects = remote?.[2].projects ?? [];
      const merged = mergeProjectSummaries(local, remoteProjects);
      const restoredDocument = selectProjectDocument(
        rememberedLocal,
        rememberedRemote
      );
      const canUseCloud = Boolean(remote || rememberedRemote);
      if (rememberedRemote) {
        remoteVersionsRef.current.set(
          rememberedRemote.projectId,
          rememberedRemote.version
        );
      }
      setProjects(merged);
      setCloudAvailable(canUseCloud);
      setSession(remote?.[1] ?? null);
      if (remoteSettings) {
        setAccountSettings(remoteSettings);
        setAppSettings(remoteSettings.settings);
        saveLocalAppSettings(remoteSettings.settings);
      }
      setSaveState(canUseCloud ? 'saved' : 'offline');
      if (activeProjectId && restoredDocument) {
        hydrateDocument(restoredDocument);
        setStatus(`Reopened ${restoredDocument.name}.`);
        return;
      }
      if (activeProjectId) {
        clearActiveProject();
      }
      setStatus(
        remote
          ? `Beta API ready · ${merged.length} project(s)`
          : `Offline workspace · ${merged.length} local project(s)`
      );
    })();
    // Startup settings are intentionally read once. Later settings changes
    // should not re-run project discovery or reopen a different document.
  }, []);

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
    const camera = viewportCameraRef.current;
    if (!doc || !camera) {
      return;
    }
    saveProjectView(doc.projectId, {
      camera,
      projection,
      settings: viewerSettings,
      hiddenBodyIds: [...hiddenBodyIds]
    });
  }, [
    doc?.projectId,
    hiddenBodyIds,
    projection,
    viewerSettings.displayMode,
    viewerSettings.showGrid
  ]);

  useEffect(() => {
    if (!doc || !geometryWorkerRef.current) {
      return;
    }
    // Re-derive geometry only when the model itself changed. Derived-state
    // commits keep the same version, which breaks the otherwise infinite
    // post -> derive -> commit -> post cycle.
    const syncKey = `${doc.projectId}:${doc.version}`;
    if (lastSyncedKeyRef.current === syncKey) {
      return;
    }
    lastSyncedKeyRef.current = syncKey;
    geometryWorkerRef.current.postMessage({ type: 'sync', document: doc });
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
      return { label: `${selectedEdges.length} edges` };
    }
    if (selectedEdges.length === 1 || selectedTopology?.kind === 'edge') {
      return {
        label: '1 edge',
        detail: selectedEdges[0]?.topologyId ?? selectedTopology?.topologyId
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
      return {
        label: '1 face',
        detail: body
          ? `${body.name} · ${selectedTopology.topologyId}`
          : selectedTopology.topologyId
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
      if (
        data.objectKind === 'line' ||
        data.objectKind === 'arc'
      ) {
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
    const normalized = normalizeDocument(nextDocument);
    const restoreView = options.restoreView ?? true;
    const rememberProject = options.rememberProject ?? true;
    if (restoreView) {
      const savedView = loadProjectView(normalized.projectId);
      const camera = savedView?.camera ?? null;
      viewportCameraRef.current = camera;
      setInitialView(camera);
      setProjection(
        savedView?.projection ?? appSettings.viewport.defaultProjection
      );
      setViewerSettings(
        savedView?.settings ?? {
          showGrid: appSettings.viewport.showGrid,
          displayMode: appSettings.viewport.displayMode
        }
      );
      setHiddenBodyIds(new Set(savedView?.hiddenBodyIds ?? []));
    }
    if (rememberProject) {
      rememberActiveProject(normalized.projectId);
    }
    managerRef.current = new CommandManager(normalized);
    lastSyncedKeyRef.current = null;
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
    viewportCameraRef.current = camera;
    if (!doc) {
      return;
    }
    saveProjectView(doc.projectId, {
      camera,
      projection,
      settings: viewerSettings,
      hiddenBodyIds: [...hiddenBodyIds]
    });
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

  function finishSketch(value: SketchFormValue) {
    if (!executeCommand(commandFactories.addSketch(value))) {
      return;
    }
    const sketchId = managerRef.current?.document.sketchOrder.at(-1);
    if (!sketchId) {
      return;
    }
    setTool(null);
    setSelectedFeatureNodeId(null);
    setSelectedSketchProfileId(sketchId);
    // Face the finished profile so the extrude drag is usable. Each plane is
    // named for the axes it spans, so with Z up the ground plane is XY: mapping
    // it to the front view would put the profile edge-on and invisible.
    requestView(
      value.plane === 'XY' ? 'top' : value.plane === 'XZ' ? 'front' : 'right'
    );
    setStatus('Closed profile created. Select Extrude or press E.');
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
    setAppSettings(next);
    setSettingsMessage('Saved on this device.');
  }

  function openSettings() {
    setSettingsOpen(true);
    setPaletteOpen(false);
    setSettingsMessage('Changes save on this device immediately.');
    void api
      .getSettings()
      .then(setAccountSettings)
      .catch(() => {
        setSettingsMessage(
          'Account sync unavailable · device settings active.'
        );
      });
  }

  async function handleSaveAppSettings() {
    if (!accountSettings?.synced) {
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
      setSettingsMessage('Saved to this device and account.');
    } catch (error) {
      setSettingsMessage(errorMessage(error, 'Account settings save failed.'));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function syncSettingsBeforeAssistantAction() {
    if (!accountSettings?.synced) {
      throw new Error('Account settings storage is unavailable.');
    }
    const response = await api.updateSettings({
      settings: appSettings,
      expectedRevision: accountSettings.revision
    });
    setAccountSettings(response);
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
    setAppSettings(defaults);
    saveLocalAppSettings(defaults);
    setSettingsMessage('Application settings reset on this device.');
  }

  function applyViewportDefaults() {
    setProjection(appSettings.viewport.defaultProjection);
    setViewerSettings({
      showGrid: appSettings.viewport.showGrid,
      displayMode: appSettings.viewport.displayMode
    });
    setSettingsMessage('Viewport defaults applied to the current view.');
  }

  async function handleCreateProject(name: string, units: UnitSystem) {
    setBusy(true);
    try {
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
      const localDocument = createProjectDocument(
        name,
        session?.userId ?? localUserId,
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
  function requestExactSync(
    document: ProjectDocument
  ): Promise<ProjectDocument['derived']> {
    const worker = geometryWorkerRef.current;
    if (!worker) {
      return Promise.reject(new Error('Geometry worker unavailable.'));
    }
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      syncRequestsRef.current.set(requestId, { resolve, reject });
      worker.postMessage({ type: 'sync', document, requestId });
    });
  }

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
        requestExactSync
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
        api.loadProject(projectId).catch(() => null)
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
    viewportCameraRef.current = null;
    setInitialView(null);
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
        api.listProjects().catch(() => null)
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
      let expectedVersion = remoteVersionsRef.current.get(doc.projectId);
      if (expectedVersion === undefined) {
        const remote = await api.loadProject(doc.projectId);
        expectedVersion = remote.version;
        remoteVersionsRef.current.set(doc.projectId, expectedVersion);
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

  function exportWithWorker(
    format: 'step' | 'stl',
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<Extract<GeometryExportResult, { ok: true }>> {
    const worker = geometryWorkerRef.current;
    if (!worker) {
      return Promise.reject(new Error('Geometry worker is unavailable.'));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      exportRequestsRef.current.set(requestId, { resolve, reject });
      worker.postMessage({
        type: 'export',
        requestId,
        document,
        bodyIds,
        format
      });
    });
  }

  async function handleExport(format: 'step' | 'stl') {
    if (!doc || exportBodyIds.length === 0) {
      setStatus('Create a body before exporting.');
      return;
    }
    const stem = exportFileStem(doc.name);
    try {
      setStatus(`Exporting exact ${format.toUpperCase()}…`);
      const result = await exportWithWorker(format, doc, exportBodyIds);
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
      appSettings.experiments.directManipulation &&
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
      if (
        geometry?.surfaceType === 'plane' &&
        selection.hash !== undefined
      ) {
        const frame = frameFromFace(
          geometry.center,
          geometry.normal ?? detail.normal
        );
        dispatchInteraction({
          type: 'enter-sketch',
          plane: {
            type: 'face',
            bodyId: selection.bodyId,
            faceHash: selection.hash,
            sourceArea: geometry.area,
            sourceCenter: geometry.center,
            sourceNormal: geometry.normal ?? detail.normal,
            frame
          }
        });
        setTool(null);
        setStatus('Sketching on the selected face. Esc exits.');
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

  function handleClearSelectedEdges() {
    setSelectedEdges([]);
    const bodyId = edgeModifierBody?.bodyId;
    setSelectedTopology(bodyId ? { bodyId, kind: 'body' } : null);
    setSelectedBodyIds(bodyId ? [bodyId] : []);
    setStatus('Edge selection cleared.');
  }

  async function executeValidatedDirectEdit(
    command: AnyCommand,
    targetBodyId: BodyId,
    successMessage: string
  ): Promise<void> {
    const manager = managerRef.current;
    if (!manager || directEditInFlightRef.current) {
      return;
    }
    directEditInFlightRef.current = true;
    const current = manager.document;
    setBusy(true);
    setStatus('Validating direct edit with the exact geometry kernel…');
    try {
      command.validate(current);
      const preview = command.apply(current);
      const derived = await requestExactSync(preview);
      const directEditWarning = derived.warnings.find((warning) =>
        warning.startsWith(`Feature "${command.label}":`)
      );
      if (directEditWarning) {
        throw new Error(directEditWarning.replace(/^Feature "[^"]+":\s*/, ''));
      }
      if (!derived.bodyRepresentations[targetBodyId]) {
        throw new Error('Direct edit did not produce the selected body.');
      }
      if (
        managerRef.current !== manager ||
        manager.document.projectId !== current.projectId ||
        manager.document.version !== current.version
      ) {
        throw new Error('The document changed while the edit was validating.');
      }
      if (!executeCommand(command)) {
        return;
      }
      setSelectedTopology(null);
      setSelectedEdges([]);
      setSelectedBodyIds([targetBodyId]);
      setSelectedFeatureNodeId(featureNodeIdForBody(targetBodyId));
      setStatus(successMessage);
    } catch (error) {
      setStatus(errorMessage(error, 'Direct edit was not applied.'));
    } finally {
      directEditInFlightRef.current = false;
      setBusy(false);
    }
  }

  /**
   * Armed face-offset handle for the viewport. Memoized so the drag rig is
   * built once per selection instead of on every App render — rebuilding it
   * mid-hover would reset its screen-constant scale and drop pointer picks.
   */
  // The keypad's lifetime mirrors the machine's keypadOpen flag: Escape,
  // deselection, and commits all close it through the reducer.
  useEffect(() => {
    const open =
      interaction.mode !== 'idle' &&
      'keypadOpen' in interaction &&
      interaction.keypadOpen;
    if (!open) {
      setKeypad(null);
    }
  }, [interaction]);

  // Leaving edges mode abandons any in-flight preview document.
  useEffect(() => {
    if (interaction.mode !== 'edges') {
      clearEdgePreview();
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
        return node?.kind === 'sketch-object' ? [node.data] : [];
      }) ?? [];
    return {
      basis: sketchBasis,
      tool: session.tool,
      snapStep: appSettings.sketching.snapEnabled
        ? appSettings.sketching.linearSnap
        : null,
      drawing: session.drawing,
      objects
    };
  }, [interaction, doc, sketchBasis, appSettings.sketching]);

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

  /** Armed edge handle; memoized for the same rig-stability reason as faces. */
  const edgeHandleTarget = useMemo(() => {
    if (interaction.mode !== 'edges' || interaction.edges.length === 0) {
      return null;
    }
    const last = interaction.edges.at(-1)!;
    return {
      bodyId: last.bodyId,
      topologyId: last.topologyId ?? '',
      op: interaction.op,
      edgeCount: interaction.edges.length
    };
  }, [interaction]);

  const offsetHandleTarget = useMemo(() => {
    if (
      interaction.mode !== 'face' ||
      interaction.op !== 'offset-face' ||
      interaction.target.surfaceType !== 'planar'
    ) {
      return null;
    }
    return {
      bodyId: interaction.target.bodyId,
      topologyId: interaction.target.topologyId,
      point: {
        x: interaction.target.point[0],
        y: interaction.target.point[1],
        z: interaction.target.point[2]
      },
      normal: {
        x: interaction.target.normal[0],
        y: interaction.target.normal[1],
        z: interaction.target.normal[2]
      }
    };
  }, [interaction]);

  /**
   * Throttled kernel previews for edge-radius drags. One sync in flight,
   * latest value wins; a slow document (>400ms per preview) degrades to the
   * chip readout only, and the drag still commits exactly on release.
   */
  const edgePreviewRef = useRef({
    token: 0,
    inFlight: false,
    pending: null as number | null,
    slow: false,
    active: false
  });

  function buildEdgeModifierCommand(size: ParamValue) {
    if (interaction.mode !== 'edges') {
      return null;
    }
    const edges = interaction.edges;
    const bodyId = edges[0]?.bodyId;
    const edgeHashes = edges
      .map((edge) => edge.hash)
      .filter((hash): hash is number => hash !== undefined);
    if (!bodyId || edgeHashes.length === 0) {
      return null;
    }
    const payload = {
      name: interaction.op === 'fillet' ? 'Fillet edges' : 'Chamfer edges',
      targetBodyId: bodyId,
      edgeHashes,
      size
    };
    return interaction.op === 'fillet'
      ? commandFactories.filletEdges(payload)
      : commandFactories.chamferEdges(payload);
  }

  function requestEdgePreview(size: number) {
    const state = edgePreviewRef.current;
    if (state.slow || size <= 0) {
      return;
    }
    state.pending = size;
    state.active = true;
    if (!state.inFlight) {
      void runEdgePreviews();
    }
  }

  async function runEdgePreviews() {
    const state = edgePreviewRef.current;
    state.inFlight = true;
    try {
      while (state.pending !== null) {
        const size = state.pending;
        state.pending = null;
        const token = ++state.token;
        const command = buildEdgeModifierCommand(size);
        if (!command) {
          break;
        }
        const base = managerRef.current?.document;
        if (!base) {
          break;
        }
        const started = performance.now();
        try {
          const preview = command.apply(base);
          const derived = await requestExactSync(preview);
          if (token !== state.token || !state.active) {
            continue;
          }
          setPreviewDoc({ ...preview, derived });
        } catch {
          // Invalid radii simply skip the preview frame.
        }
        if (performance.now() - started > 400) {
          state.slow = true;
          break;
        }
      }
    } finally {
      state.inFlight = false;
    }
  }

  function clearEdgePreview() {
    const state = edgePreviewRef.current;
    state.token += 1;
    state.pending = null;
    state.slow = false;
    if (state.active) {
      state.active = false;
      setPreviewDoc(null);
    }
  }

  /** Edge-radius drag released (or exact entry): commit fillet/chamfer. */
  function handleEdgeCommit(size: number, exact?: ParamValue) {
    if (interaction.mode !== 'edges') {
      return;
    }
    clearEdgePreview();
    const rounded = Math.round(size * 1000) / 1000;
    const command = buildEdgeModifierCommand(exact ?? rounded);
    if (!command || rounded <= 0) {
      return;
    }
    const op = interaction.op;
    dispatchInteraction({ type: 'commit-complete' });
    const resultBodyId =
      command.payload.ids?.bodyId ?? command.payload.targetBodyId;
    void executeValidatedDirectEdit(
      command,
      resultBodyId,
      `${op === 'fillet' ? 'Filleted' : 'Chamfered'} ${command.payload.edgeHashes.length} edge${command.payload.edgeHashes.length === 1 ? '' : 's'} at ${rounded} ${doc?.units ?? ''}.`
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
    if (interaction.mode !== 'face') {
      return;
    }
    dispatchInteraction({ type: 'keypad-open' });
    setKeypad({
      kind: 'offset',
      label: 'Offset',
      initial:
        currentOffset !== 0
          ? String(Math.round(currentOffset * 100) / 100)
          : '',
      unitKind: 'length'
    });
  }

  /**
   * Face-offset commit as a validated direct edit. `exact` preserves a typed
   * expression as the stored parametric value; plain drags store the number.
   */
  function handleOffsetCommit(offset: number, exact?: ParamValue) {
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
    dispatchInteraction({ type: 'commit-complete' });
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
      `Offset face by ${Math.round(offset * 100) / 100} ${doc?.units ?? ''}.`
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
      `Updated through-hole diameter to ${String(diameter)} ${doc?.units ?? ''}.`
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
        const sketchTool =
          event.key.toLowerCase() === 'l'
            ? ('line' as const)
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

  if (settingsOpen) {
    return (
      <SettingsPage
        settings={appSettings}
        accountState={accountSettings}
        session={session}
        busy={settingsBusy}
        message={settingsMessage}
        onChange={handleAppSettingsChange}
        onSave={() => void handleSaveAppSettings()}
        onSaveCredential={(token) => void handleSaveAssistantCredential(token)}
        onDeleteCredential={() => void handleDeleteAssistantCredential()}
        onTestAssistant={() => void handleTestAssistantConnection()}
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
          onToggleBodyVisibility={toggleBodyVisibility}
          onFeatureContextMenu={handleFeatureContextMenu}
          onSetParameter={(name, expression) =>
            executeCommand(commandFactories.setParameter({ name, expression }))
          }
          onDeleteParameter={(name) =>
            executeCommand(commandFactories.deleteParameter({ name }))
          }
          onDeleteFeature={handleDeleteFeature}
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
            sketches={sketchOverlays}
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
            hideViewerToolbar={
              tool === 'sketch' && !appSettings.experiments.directManipulation
            }
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
            edgeHandle={edgeHandleTarget}
            onEdgeRadiusPreview={requestEdgePreview}
            onEdgeCommit={handleEdgeCommit}
            onOpenEdgeKeypad={handleOpenEdgeKeypad}
            sketchMode={sketchModeState}
            onSketchCommit={handleSketchCommit}
            onSketchDrawingChange={(drawing) =>
              dispatchInteraction({ type: 'sketch-drawing', drawing })
            }
            modeOverlay={
              toolCardFor(interaction) ? (
                <>
                  <ToolCard
                    model={toolCardFor(interaction)!}
                    onSubMode={() =>
                      dispatchInteraction({ type: 'toggle-edge-op' })
                    }
                    onClose={() => dispatchInteraction({ type: 'escape' })}
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
                  {keypad && (
                    <NumericKeypad
                      request={keypad}
                      units={doc.units}
                      scope={parameterScope.scope}
                      anchorRef={keypadAnchorRef}
                      onPreview={(value) => {
                        offsetSetterRef.current?.(value);
                        if (keypad.kind === 'edge') {
                          requestEdgePreview(value);
                        }
                      }}
                      onCommit={(value, raw) => {
                        setKeypad(null);
                        dispatchInteraction({ type: 'keypad-close' });
                        // Expressions stay parametric in the stored feature.
                        const isExpression = !Number.isFinite(Number(raw));
                        if (keypad.kind === 'edge') {
                          handleEdgeCommit(value, isExpression ? raw : undefined);
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
                          clearEdgePreview();
                        }
                        dispatchInteraction({ type: 'keypad-close' });
                        setKeypad(null);
                      }}
                    />
                  )}
                </>
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
              ) : tool === 'sketch' &&
                appSettings.experiments.directManipulation ? (
                <div className="sketch-plane-prompt" role="status">
                  <span>
                    <strong>Pick a sketch plane</strong>
                    <small>
                      Click a planar face on the model, or start on a
                      principal plane.
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
              ) : tool === 'sketch' ? (
                <SketchWorkspace
                  sketchNumber={sketchOptions.length + 1}
                  units={doc.units}
                  snapStep={
                    appSettings.sketching.snapEnabled
                      ? appSettings.sketching.linearSnap
                      : null
                  }
                  onCancel={cancelPanel}
                  onFinish={finishSketch}
                />
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
        directMode ? null : (
          <AiCommandRail
            document={doc}
            selection={assistantSelection}
            onApply={handleApplyPatch}
            onPreview={handlePreviewPatch}
          />
        )
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
