import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Download, FolderOpen, Grid3x3, Maximize2, Monitor, Save, Upload } from 'lucide-react';
import { CommandManager, commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  listParameters,
  normalizeDocument
} from '@openzcad/document-core';
import {
  PLANE_BASES,
  circleProfile,
  polygonProfile,
  rectangleProfile,
  type Vec2
} from '@openzcad/geometry';
import { parseStepMetadata } from '@openzcad/io-step';
import { parseStl } from '@openzcad/io-stl';
import { createKernelAdapter } from '@openzcad/kernel-adapter';
import type {
  BodyId,
  BodyRepresentation,
  FeatureId,
  FeatureNode,
  ProjectDocument,
  ProjectSummary,
  SketchNode,
  SketchObjectData,
  UnitSystem
} from '@openzcad/shared';
import { api } from './lib/api';
import { downloadText, evalParamValue, exportFileStem, inferContentType } from './lib/model';
import {
  SHORTCUT_TO_TOOL,
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  type ToolId
} from './lib/tools';
import { AppShell } from './components/AppShell';
import { TopBar } from './components/TopBar';
import { ToolBar } from './components/ToolBar';
import { Sidebar } from './components/Sidebar';
import { ViewerShell } from './components/ViewerShell';
import { Inspector } from './components/Inspector';
import { StatusBar } from './components/StatusBar';
import { StartScreen } from './components/StartScreen';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { DISPLAY_MODE_LABELS } from './components/ViewerToolbar';
import type {
  DisplayMode,
  SketchOverlay,
  StandardView,
  ViewerSettings
} from './components/ModelViewer';
import type { GeometrySyncResult } from './worker/geometryWorker';

const kernel = createKernelAdapter();

const DISPLAY_MODE_ORDER: DisplayMode[] = ['shaded-edges', 'shaded', 'wireframe'];

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // Named `doc` (not `document`) so the global DOM document is never shadowed.
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [selectedFeatureNodeId, setSelectedFeatureNodeId] = useState<string | null>(null);
  // Viewport body selection in click order; drives boolean/move pre-fills.
  const [selectedBodyIds, setSelectedBodyIds] = useState<BodyId[]>([]);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [status, setStatus] = useState('Checking beta API...');
  const [busy, setBusy] = useState(false);
  const [viewerSettings, setViewerSettings] = useState<ViewerSettings>({
    showGrid: true,
    displayMode: 'shaded-edges'
  });
  const [fitSignal, setFitSignal] = useState(0);
  const [viewRequest, setViewRequest] = useState<{ view: StandardView; nonce: number } | null>(
    null
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Document version last persisted as a revision; drives the dirty flag.
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const managerRef = useRef<CommandManager | null>(null);
  const geometryWorkerRef = useRef<Worker | null>(null);
  const lastSyncedKeyRef = useRef<string | null>(null);
  const viewNonceRef = useRef(0);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./worker/geometryWorker.ts', import.meta.url), {
      type: 'module'
    });
    geometryWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent<GeometrySyncResult>) => {
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
      worker.terminate();
      geometryWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const health = await api.health();
        const listed = await api.listProjects();
        setProjects(listed.projects);
        setStatus(
          `API ${health.status} on ${health.environment} · ${listed.projects.length} project(s)`
        );
      } catch (error) {
        setStatus(errorMessage(error, 'Failed to reach API.'));
      }
    })();
  }, []);

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
    geometryWorkerRef.current.postMessage(doc);
  }, [doc]);

  const features = useMemo<FeatureNode[]>(() => (doc ? listFeaturesInOrder(doc) : []), [doc]);
  const parameters = useMemo(() => (doc ? listParameters(doc) : []), [doc]);
  const parameterScope = useMemo(
    () => (doc ? getParameterScope(doc) : { scope: {}, errors: [] }),
    [doc]
  );

  const representations = doc?.derived.bodyRepresentations ?? {};
  const warnings = doc?.derived.warnings ?? [];

  const viewerBodies = useMemo<BodyRepresentation[]>(
    () => (doc ? Object.values(doc.derived.bodyRepresentations).filter((body) => !body.consumed) : []),
    [doc]
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
      return [{ bodyId, name: node.name, consumed: representation?.consumed ?? false }];
    });
  }, [doc]);

  const sketchOptions = useMemo(() => {
    if (!doc) {
      return [];
    }
    const sketches = listNodesByKind(doc, 'sketch');
    return doc.sketchOrder.flatMap((sketchId) => {
      const sketch = sketches.find((candidate) => candidate.sketchId === sketchId);
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
    if (!doc || !selectedFeature || selectedFeature.data.featureKind !== 'sketch') {
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

  const exportBodyIds = useMemo<BodyId[]>(() => {
    if (!doc) {
      return [];
    }
    if (selectedBody && !selectedBody.consumed && selectedBody.exportableStep) {
      return [selectedBody.bodyId];
    }
    return doc.derived.exportableBodyIds;
  }, [doc, selectedBody]);

  // Sketch profiles lifted onto their 3D planes for the viewport overlay.
  const sketchOverlays = useMemo<SketchOverlay[]>(() => {
    if (!doc) {
      return [];
    }
    const scope = parameterScope.scope;
    return listNodesByKind(doc, 'sketch').flatMap((sketch) => {
      const objectNode = sketch.objectIds[0] ? doc.nodes[sketch.objectIds[0]] : undefined;
      if (objectNode?.kind !== 'sketch-object') {
        return [];
      }
      const data = objectNode.data;
      const offset = evalParamValue(sketch.offset, scope) ?? 0;
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
      const basis = PLANE_BASES[sketch.plane];
      const points = profile.map((point) => ({
        x: basis.u.x * point.x + basis.v.x * point.y + basis.normal.x * offset,
        y: basis.u.y * point.x + basis.v.y * point.y + basis.normal.y * offset,
        z: basis.u.z * point.x + basis.v.z * point.y + basis.normal.z * offset
      }));
      return [
        {
          sketchId: sketch.sketchId,
          name: sketch.name,
          selected: selectedSketch?.sketchId === sketch.sketchId,
          points
        }
      ];
    });
  }, [doc, parameterScope, selectedSketch]);

  const availability = {
    sketchCount: sketchOptions.length,
    liveBodyCount: viewerBodies.length
  };
  const dirty = doc !== null && savedVersion !== null && doc.version !== savedVersion;

  function hydrateDocument(nextDocument: ProjectDocument) {
    const normalized = normalizeDocument(nextDocument);
    managerRef.current = new CommandManager(normalized);
    lastSyncedKeyRef.current = null;
    setDoc(normalized);
    setSavedVersion(normalized.version);
    setSelectedFeatureNodeId(null);
    setSelectedBodyIds([]);
    setTool(null);
  }

  function executeCommand(command: AnyCommand): boolean {
    if (!managerRef.current) {
      return false;
    }
    try {
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
      setSelectedBodyIds([]);
    }
  }

  function launchTool(nextTool: ToolId) {
    const reason = toolDisabledReason(nextTool, availability);
    if (reason) {
      setStatus(`${TOOL_META[nextTool].label}: ${reason}.`);
      return;
    }
    // Selection is kept on purpose: booleans/move/extrude pre-fill from it.
    setTool(nextTool);
  }

  function cancelPanel() {
    setTool(null);
    setSelectedFeatureNodeId(null);
  }

  function clearSelection() {
    setSelectedFeatureNodeId(null);
    setSelectedBodyIds([]);
  }

  function requestView(view: StandardView) {
    setViewRequest({ view, nonce: ++viewNonceRef.current });
  }

  function cycleDisplayMode() {
    const index = DISPLAY_MODE_ORDER.indexOf(viewerSettings.displayMode);
    const next = DISPLAY_MODE_ORDER[(index + 1) % DISPLAY_MODE_ORDER.length] ?? 'shaded-edges';
    setViewerSettings((current) => ({ ...current, displayMode: next }));
    setStatus(`Display: ${DISPLAY_MODE_LABELS[next]}.`);
  }

  async function handleCreateProject(name: string, units: UnitSystem) {
    setBusy(true);
    try {
      const response = await api.createProject({ name, units });
      hydrateDocument(response.document);
      setProjects((current) => [response.project, ...current]);
      setStatus(`Created ${response.project.name}.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to create project.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenProject(projectId: string) {
    setBusy(true);
    try {
      const loaded = await api.loadProject(projectId);
      hydrateDocument(loaded);
      setStatus(`Opened ${loaded.name}.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to open project.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoHome() {
    if (dirty && !window.confirm('You have unsaved changes. Discard them and leave?')) {
      return;
    }
    managerRef.current = null;
    setDoc(null);
    setSavedVersion(null);
    setSelectedFeatureNodeId(null);
    setSelectedBodyIds([]);
    setTool(null);
    try {
      const listed = await api.listProjects();
      setProjects(listed.projects);
      setStatus(`${listed.projects.length} project(s) available.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to refresh projects.'));
    }
  }

  function handleUndo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.undo());
    clearSelection();
    setStatus('Undo');
  }

  function handleRedo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.redo());
    clearSelection();
    setStatus('Redo');
  }

  async function handleSave() {
    if (!doc) {
      return;
    }
    try {
      await api.saveRevision({ projectId: doc.projectId, reason: 'Manual save', document: doc });
      setSavedVersion(doc.version);
      setStatus('Saved revision.');
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to save revision.'));
    }
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
        const uploadSession = await api.createUploadSession({
          projectId: doc.projectId,
          fileName: file.name,
          contentType
        });
        if (uploadSession.session.uploadUrl) {
          const uploadResponse = await fetch(uploadSession.session.uploadUrl, {
            method: 'PUT',
            body: file,
            headers: { 'content-type': contentType }
          });
          if (!uploadResponse.ok) {
            throw new Error(`Upload failed with status ${uploadResponse.status}.`);
          }
        }
        await api.finalizeImport({
          projectId: doc.projectId,
          uploadSessionId: uploadSession.session.uploadSessionId,
          artifactId: uploadSession.session.artifactId,
          fileName: file.name,
          contentType
        });
        artifactId = uploadSession.session.artifactId;
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
            (archived ? '.' : ' (original file not archived: upload unavailable).')
        );
      }
      return;
    }

    try {
      const metadata = parseStepMetadata(file.name, await file.text());
      const products = metadata.products.slice(0, 3).join(', ') || 'no products found';
      setStatus(
        `STEP metadata read (${products}). Full B-Rep STEP import needs the native kernel and is not available yet.`
      );
    } catch (error) {
      setStatus(errorMessage(error, 'Import failed.'));
    }
  }

  function handleExport(format: 'step' | 'stl') {
    if (!doc || exportBodyIds.length === 0) {
      setStatus('Create a body before exporting.');
      return;
    }
    const stem = exportFileStem(doc.name);
    try {
      if (format === 'step') {
        const result = kernel.exportStep(doc, exportBodyIds);
        downloadText(`${stem}.step`, result.text);
        setStatus(
          result.warnings.length > 0
            ? `Exported STEP with ${result.warnings.length} warning(s).`
            : `Exported ${exportBodyIds.length} body(ies) to ${stem}.step (AP214).`
        );
      } else {
        const stl = kernel.exportStl(doc, exportBodyIds);
        downloadText(`${stem}.stl`, stl);
        setStatus(`Exported ${exportBodyIds.length} body(ies) to ${stem}.stl.`);
      }
      // Record the export with the worker API; the download already happened.
      api
        .requestExport({ projectId: doc.projectId, bodyIds: exportBodyIds, format })
        .catch(() => undefined);
    } catch (error) {
      setStatus(errorMessage(error, `${format.toUpperCase()} export failed.`));
    }
  }

  function featureNodeIdForBody(bodyId: BodyId): string | null {
    if (!doc) {
      return null;
    }
    const bodyNode = listNodesByKind(doc, 'body').find((body) => body.bodyId === bodyId);
    const feature = bodyNode
      ? features.find((candidate) => candidate.featureId === bodyNode.featureId)
      : undefined;
    return feature?.id ?? null;
  }

  function handleSelectBodyFromViewer(rawBodyId: string | null, additive: boolean) {
    if (!doc) {
      return;
    }
    // The viewer reports plain strings; brand them once at the boundary.
    const bodyId = rawBodyId as BodyId | null;
    if (!bodyId) {
      if (!additive) {
        clearSelection();
      }
      return;
    }
    const nextIds = additive
      ? selectedBodyIds.includes(bodyId)
        ? selectedBodyIds.filter((id) => id !== bodyId)
        : [...selectedBodyIds, bodyId]
      : [bodyId];
    setSelectedBodyIds(nextIds);
    if (!additive) {
      setTool(null);
    }
    // The edit panel follows a single-body selection; multi-select keeps the
    // viewport clear so the pick order reads as boolean/move input.
    setSelectedFeatureNodeId(nextIds.length === 1 ? featureNodeIdForBody(nextIds[0]!) : null);
  }

  function handleSelectFeatureFromTree(nodeId: string) {
    setTool(null);
    const next = selectedFeatureNodeId === nodeId ? null : nodeId;
    setSelectedFeatureNodeId(next);
    const node = next && doc ? doc.nodes[next] : undefined;
    const bodyId = node?.kind === 'feature' ? node.bodyId : undefined;
    const representation = bodyId ? doc?.derived.bodyRepresentations[bodyId] : undefined;
    setSelectedBodyIds(bodyId && representation && !representation.consumed ? [bodyId] : []);
  }

  function handleDeleteFeature(featureId: FeatureId, name: string) {
    if (executeCommand(commandFactories.deleteFeature({ featureId }, `Delete ${name}`))) {
      clearSelection();
    }
  }

  // Warn before the tab closes with unsaved edits.
  useEffect(() => {
    if (!dirty) {
      return;
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Workspace keyboard map (ignored while typing in a field).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!doc) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
      const meta = event.ctrlKey || event.metaKey;

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

      switch (event.key) {
        case 'Escape':
          if (tool || selectedFeatureNodeId) {
            cancelPanel();
          } else {
            clearSelection();
          }
          return;
        case 'Delete':
        case 'Backspace':
          if (selectedFeature) {
            event.preventDefault();
            handleDeleteFeature(selectedFeature.featureId, selectedFeature.name);
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
        setViewerSettings((current) => ({ ...current, showGrid: !current.showGrid }));
        return;
      }
      if (key === 'w') {
        cycleDisplayMode();
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

  if (!doc) {
    return (
      <StartScreen
        projects={projects}
        status={status}
        busy={busy}
        onCreate={(name, units) => void handleCreateProject(name, units)}
        onOpen={(projectId) => void handleOpenProject(projectId)}
      />
    );
  }

  const tone: 'ready' | 'warning' | 'running' = /fail|error|invalid|unable|denied/i.test(status)
    ? 'warning'
    : 'ready';

  const hint = tool
    ? 'Enter creates · Esc cancels'
    : selectedBodyIds.length >= 2
      ? `${selectedBodyIds.length} bodies picked — U union · X subtract · I intersect`
      : selectedFeature
        ? 'Edit in the panel · Del deletes · Esc closes'
        : viewerBodies.length > 0
          ? 'Click a body to edit · Shift+Click adds to selection'
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
      run: () => setViewerSettings((current) => ({ ...current, showGrid: !current.showGrid }))
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
      id: 'file-save',
      label: 'Save revision',
      group: 'File',
      shortcut: 'Ctrl+S',
      icon: <Save size={16} aria-hidden="true" />,
      run: () => void handleSave()
    },
    {
      id: 'file-export-step',
      label: 'Export STEP (AP214)',
      group: 'File',
      icon: <Download size={16} aria-hidden="true" />,
      disabledReason: exportBodyIds.length === 0 ? 'Create a body first' : null,
      run: () => handleExport('step')
    },
    {
      id: 'file-export-stl',
      label: 'Export STL',
      group: 'File',
      icon: <Download size={16} aria-hidden="true" />,
      disabledReason: exportBodyIds.length === 0 ? 'Create a body first' : null,
      run: () => handleExport('stl')
    },
    {
      id: 'file-import',
      label: 'Import STL / STEP…',
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
    }
  ];

  const inspectorActive = tool !== null || selectedFeature !== null;

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
            selectedBody && !selectedBody.consumed && selectedBody.exportableStep
              ? selectedBody.name
              : null
          }
          dirty={dirty}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onSave={() => void handleSave()}
          onImportFile={(file) => void handleImportFile(file)}
          onExport={handleExport}
          onGoHome={() => void handleGoHome()}
        />
      }
      toolBar={<ToolBar activeTool={tool} availability={availability} onLaunchTool={launchTool} />}
      sidebar={
        <Sidebar
          parameters={parameters}
          parameterValues={parameterScope.scope}
          features={features}
          representations={representations}
          selectedFeatureNodeId={selectedFeatureNodeId}
          warnings={warnings}
          onSelectFeature={handleSelectFeatureFromTree}
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
        <ViewerShell
          bodies={viewerBodies}
          sketches={sketchOverlays}
          selectedBodyIds={selectedBodyIds}
          settings={viewerSettings}
          fitSignal={fitSignal}
          viewRequest={viewRequest}
          onSelectBody={handleSelectBodyFromViewer}
          onToggleGrid={() =>
            setViewerSettings((current) => ({ ...current, showGrid: !current.showGrid }))
          }
          onFit={() => setFitSignal((value) => value + 1)}
          onView={requestView}
          onCycleDisplayMode={cycleDisplayMode}
        />
      }
      inspector={
        inspectorActive ? (
          <Inspector
            tool={tool}
            selectedFeature={selectedFeature}
            selectedSketch={selectedSketch}
            selectedSketchObject={selectedSketchObject}
            selectedBody={selectedBody}
            scope={parameterScope.scope}
            sketches={sketchOptions}
            bodies={bodyOptions}
            units={doc.units}
            selectedBodyIds={selectedBodyIds}
            preferredSketchId={selectedSketch?.sketchId ?? null}
            onCancel={cancelPanel}
            onCreatePrimitive={(kind, name, dimensions) =>
              createFeature(commandFactories.addPrimitive({ name, primitiveKind: kind, dimensions }))
            }
            onCreateSketch={(value) => createFeature(commandFactories.addSketch(value))}
            onCreateExtrude={(value) => createFeature(commandFactories.extrudeSketch(value))}
            onCreateRevolve={(value) => createFeature(commandFactories.revolveSketch(value))}
            onCreateBoolean={(value) => createFeature(commandFactories.booleanBodies(value))}
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
            onApplyPrimitive={(feature, name, dimensions) =>
              executeCommand(
                commandFactories.updateFeature(
                  { featureId: feature.featureId, name, data: { dimensions } },
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
                  commandFactories.renameNode({ nodeId: feature.id, name: value.name }),
                  commandFactories.renameNode({ nodeId: selectedSketch.id, name: value.name })
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
                    data: { featureKind: 'revolve', sketchId: value.sketchId, axis: value.axis }
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
            onDeleteFeature={(feature) => handleDeleteFeature(feature.featureId, feature.name)}
          />
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
            <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
          )}
          {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
        </>
      }
    />
  );
}
