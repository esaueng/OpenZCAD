import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommandManager, commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  listParameters,
  normalizeDocument
} from '@openzcad/document-core';
import { parseStepMetadata } from '@openzcad/io-step';
import { parseStl } from '@openzcad/io-stl';
import { createKernelAdapter } from '@openzcad/kernel-adapter';
import type {
  BodyId,
  BodyRepresentation,
  BooleanOperation,
  FeatureId,
  FeatureNode,
  PrimitiveKind,
  ProjectDocument,
  ProjectSummary,
  SketchId,
  SketchNode,
  SketchObjectData,
  UnitSystem
} from '@openzcad/shared';
import { api } from './lib/api';
import { downloadText, exportFileStem, inferContentType } from './lib/model';
import { getCommand, type CommandContext, type WorkspaceId } from './lib/commands';
import {
  buildSessionCommand,
  createSession,
  formatDragValue,
  sessionManipulator,
  sessionPreview,
  sessionTitle,
  setSessionValue,
  sketchOverlays,
  toggleBooleanTarget,
  validateSession,
  type ToolSession
} from './lib/session';
import { AppShell } from './components/AppShell';
import { TopBar } from './components/TopBar';
import { ToolPalette } from './components/ToolPalette';
import { ModelBrowser } from './components/ModelBrowser';
import { ViewerShell } from './components/ViewerShell';
import { CommandHUD } from './components/CommandHUD';
import { CommandSearch } from './components/CommandSearch';
import { ShortcutSheet } from './components/ShortcutSheet';
import { ContextMenu, type ContextMenuState } from './components/ContextMenu';
import { PropertiesInspector } from './components/PropertiesInspector';
import { StatusBar } from './components/StatusBar';
import { StartScreen } from './components/StartScreen';
import { VisualizePanel } from './components/VisualizePanel';
import type {
  AxisProjection,
  DisplayMode,
  ProjectionMode,
  ViewerApi
} from './components/ModelViewer';
import type { GeometrySyncResult } from './worker/geometryWorker';

const kernel = createKernelAdapter();

const NAV_HINT_KEY = 'ozc.hint.nav';
const workspaceKey = (projectId: string) => `ozc.workspace.${projectId}`;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence of UI niceties is best-effort.
  }
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // Named `doc` (not `document`) so the global DOM document is never shadowed.
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [selectedFeatureNodeIds, setSelectedFeatureNodeIds] = useState<string[]>([]);
  const [session, setSession] = useState<ToolSession | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceId>('model');
  const [status, setStatus] = useState('Checking beta API...');
  const [busy, setBusy] = useState(false);
  const [viewerSettings, setViewerSettings] = useState({
    showGrid: true,
    displayMode: 'shaded-edges' as DisplayMode
  });
  const [projection, setProjection] = useState<ProjectionMode>('perspective');
  const [hiddenBodyIds, setHiddenBodyIds] = useState<ReadonlySet<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [lastSavedVersion, setLastSavedVersion] = useState<number | null>(null);
  const [navHintDismissed, setNavHintDismissed] = useState(
    () => storageGet(NAV_HINT_KEY) === '1'
  );

  const managerRef = useRef<CommandManager | null>(null);
  const geometryWorkerRef = useRef<Worker | null>(null);
  const lastSyncedKeyRef = useRef<string | null>(null);
  const viewerApiRef = useRef<ViewerApi | null>(null);
  const orientationRef = useRef<((axes: AxisProjection) => void) | null>(null);
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

  // ── Derived model state ────────────────────────────────────────────────

  const features = useMemo<FeatureNode[]>(() => (doc ? listFeaturesInOrder(doc) : []), [doc]);
  const parameters = useMemo(() => (doc ? listParameters(doc) : []), [doc]);
  const parameterScope = useMemo(
    () => (doc ? getParameterScope(doc) : { scope: {}, errors: [] }),
    [doc]
  );
  const scope = parameterScope.scope;

  const representations = useMemo(() => {
    if (!doc) {
      return {} as Record<string, BodyRepresentation>;
    }
    // Apply persisted appearance overrides (body node metadata.color).
    const bodyNodes = listNodesByKind(doc, 'body');
    const colorByBodyId = new Map<string, string>();
    for (const node of bodyNodes) {
      const color = node.metadata?.color;
      if (typeof color === 'string') {
        colorByBodyId.set(node.bodyId, color);
      }
    }
    const entries = Object.entries(doc.derived.bodyRepresentations).map(([bodyId, body]) => {
      const override = colorByBodyId.get(bodyId);
      return [bodyId, override ? { ...body, color: override } : body] as const;
    });
    return Object.fromEntries(entries) as Record<string, BodyRepresentation>;
  }, [doc]);

  const warnings = doc?.derived.warnings ?? [];

  const viewerBodies = useMemo<BodyRepresentation[]>(
    () =>
      Object.values(representations).filter(
        (body) => !body.consumed && !hiddenBodyIds.has(body.bodyId)
      ),
    [representations, hiddenBodyIds]
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

  const selectedFeatures = useMemo<FeatureNode[]>(() => {
    if (!doc) {
      return [];
    }
    return selectedFeatureNodeIds.flatMap((nodeId) => {
      const node = doc.nodes[nodeId];
      return node?.kind === 'feature' ? [node] : [];
    });
  }, [doc, selectedFeatureNodeIds]);

  const selectedFeature = selectedFeatures[0] ?? null;

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

  /** Live (non-consumed) bodies backing the selected features, in pick order. */
  const selectedBodyIds = useMemo<BodyId[]>(
    () =>
      selectedFeatures.flatMap((feature) => {
        if (!feature.bodyId) {
          return [];
        }
        const body = representations[feature.bodyId];
        return body && !body.consumed ? [feature.bodyId] : [];
      }),
    [selectedFeatures, representations]
  );

  const selectedBody = selectedFeature?.bodyId
    ? (representations[selectedFeature.bodyId] ?? null)
    : null;

  const bodyColorOverride = useMemo(() => {
    if (!doc || !selectedFeature?.bodyId) {
      return null;
    }
    const bodyNode = listNodesByKind(doc, 'body').find(
      (node) => node.bodyId === selectedFeature.bodyId
    );
    const color = bodyNode?.metadata?.color;
    return typeof color === 'string' ? color : null;
  }, [doc, selectedFeature]);

  const exportBodyIds = useMemo<BodyId[]>(() => {
    if (!doc) {
      return [];
    }
    if (selectedBody && !selectedBody.consumed && selectedBody.exportableStep) {
      return [selectedBody.bodyId];
    }
    return doc.derived.exportableBodyIds;
  }, [doc, selectedBody]);

  const liveBodyCount = useMemo(
    () => Object.values(representations).filter((body) => !body.consumed).length,
    [representations]
  );

  const commandCtx = useMemo<CommandContext>(
    () => ({
      sketchCount: doc?.sketchOrder.length ?? 0,
      liveBodyCount,
      selectedBodyCount: selectedBodyIds.length,
      sketchSelected: selectedFeature?.data.featureKind === 'sketch',
      featureSelected: selectedFeature !== null,
      canUndo: managerRef.current?.canUndo ?? false,
      canRedo: managerRef.current?.canRedo ?? false,
      canExport: exportBodyIds.length > 0,
      workspace
    }),
    [doc, liveBodyCount, selectedBodyIds, selectedFeature, exportBodyIds, workspace]
  );

  // ── Session-derived viewport state ─────────────────────────────────────

  const preview = useMemo(
    () => (session && doc ? sessionPreview(session, doc, scope) : null),
    [session, doc, scope]
  );
  const manipulator = useMemo(
    () => (session && doc ? sessionManipulator(session, doc, scope, representations) : null),
    [session, doc, scope, representations]
  );

  const sketchOverlayViews = useMemo(() => {
    if (!doc) {
      return [];
    }
    const selectedSketchIds = new Set(
      selectedFeatures.flatMap((feature) =>
        feature.data.featureKind === 'sketch' ? [feature.data.sketchId as string] : []
      )
    );
    if (session?.kind === 'extrude' && session.sketchId) {
      selectedSketchIds.add(session.sketchId);
    }
    if (session?.kind === 'revolve' && session.sketchId) {
      selectedSketchIds.add(session.sketchId);
    }
    return sketchOverlays(doc, scope).map((overlay) => ({
      ...overlay,
      sketchId: overlay.sketchId as string,
      selected: selectedSketchIds.has(overlay.sketchId as string)
    }));
  }, [doc, scope, selectedFeatures, session]);

  // During a boolean session the viewport highlights the picked targets.
  const highlightedBodyIds = useMemo<string[]>(() => {
    if (session?.kind === 'boolean') {
      return session.targetBodyIds;
    }
    if (session?.kind === 'move' && session.targetBodyId) {
      return [session.targetBodyId];
    }
    return selectedBodyIds;
  }, [session, selectedBodyIds]);

  const pickedBodyNames = useMemo(() => {
    if (session?.kind !== 'boolean') {
      return [];
    }
    return session.targetBodyIds.map(
      (bodyId) => representations[bodyId]?.name ?? 'Body'
    );
  }, [session, representations]);

  const activeCommandId = useMemo(() => {
    if (!session) {
      return null;
    }
    switch (session.kind) {
      case 'primitive':
        return `primitive.${session.primitiveKind}`;
      case 'sketch':
        return 'sketch.create';
      case 'boolean':
        return `boolean.${session.operation}`;
      case 'move':
        return 'move';
      default:
        return session.kind;
    }
  }, [session]);

  // ── Document / command plumbing ────────────────────────────────────────

  function hydrateDocument(nextDocument: ProjectDocument) {
    const normalized = normalizeDocument(nextDocument);
    managerRef.current = new CommandManager(normalized);
    lastSyncedKeyRef.current = null;
    setDoc(normalized);
    setSelectedFeatureNodeIds([]);
    setSession(null);
    setHiddenBodyIds(new Set());
    setLastSavedVersion(normalized.version);
    const savedWorkspace = storageGet(workspaceKey(normalized.projectId));
    setWorkspace(savedWorkspace === 'visualize' ? 'visualize' : 'model');
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

  // ── Session lifecycle ──────────────────────────────────────────────────

  const startSession = useCallback(
    (
      kind: ToolSession['kind'],
      options?: { primitiveKind?: PrimitiveKind; operation?: BooleanOperation }
    ) => {
      if (!doc) {
        return;
      }
      const selectedSketchId =
        selectedFeature?.data.featureKind === 'sketch' ? selectedFeature.data.sketchId : null;
      // Arming a new tool cancels the current session: nothing was committed,
      // so the model is untouched — the predictable rule.
      const next = createSession(kind, { doc, selectedBodyIds, selectedSketchId }, options);
      setSession(next);
      setStatus(`${sessionTitle(next)} — Enter confirms, Esc cancels.`);
    },
    [doc, selectedBodyIds, selectedFeature]
  );

  const cancelSession = useCallback(() => {
    setSession((current) => {
      if (current) {
        setStatus(`${sessionTitle(current)} cancelled.`);
      }
      return null;
    });
  }, []);

  const confirmSession = useCallback(() => {
    if (!session || !doc) {
      return;
    }
    const validation = validateSession(session, scope);
    if (!validation.ok) {
      setStatus(validation.message ?? 'Fix the highlighted values first.');
      return;
    }
    const command = buildSessionCommand(session, doc);
    if (!command) {
      return;
    }
    if (executeCommand(command)) {
      setSession(null);
      setSelectedFeatureNodeIds([]);
    }
  }, [session, doc, scope]);

  // ── High-level actions ─────────────────────────────────────────────────

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
    managerRef.current = null;
    setDoc(null);
    setSelectedFeatureNodeIds([]);
    setSession(null);
    try {
      const listed = await api.listProjects();
      setProjects(listed.projects);
      setStatus(`${listed.projects.length} project(s) available. Unsaved changes are discarded.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to refresh projects.'));
    }
  }

  function handleUndo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.undo());
    setSelectedFeatureNodeIds([]);
    setStatus('Undo');
  }

  function handleRedo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.redo());
    setSelectedFeatureNodeIds([]);
    setStatus('Redo');
  }

  async function handleSave() {
    if (!doc) {
      return;
    }
    try {
      await api.saveRevision({ projectId: doc.projectId, reason: 'Manual save', document: doc });
      setLastSavedVersion(doc.version);
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

  function handleDeleteFeature(featureId: FeatureId, name: string) {
    if (executeCommand(commandFactories.deleteFeature({ featureId }, `Delete ${name}`))) {
      setSelectedFeatureNodeIds([]);
    }
  }

  // ── Selection ──────────────────────────────────────────────────────────

  const featureNodeIdForBody = useCallback(
    (bodyId: string): string | null => {
      if (!doc) {
        return null;
      }
      const bodyNode = listNodesByKind(doc, 'body').find((body) => body.bodyId === bodyId);
      const feature = bodyNode
        ? features.find((candidate) => candidate.featureId === bodyNode.featureId)
        : undefined;
      return feature?.id ?? null;
    },
    [doc, features]
  );

  function handleSelectBodyFromViewer(bodyId: string | null, additive: boolean) {
    // Boolean sessions capture viewport picks as operation targets.
    if (session?.kind === 'boolean') {
      if (bodyId) {
        setSession(toggleBooleanTarget(session, bodyId as BodyId));
      }
      return;
    }
    // Move sessions re-target on body click.
    if (session?.kind === 'move') {
      if (bodyId) {
        setSession({ ...session, targetBodyId: bodyId as BodyId });
      }
      return;
    }
    if (session) {
      return; // other sessions ignore picks; Esc cancels, Enter commits
    }
    if (!bodyId) {
      if (!additive) {
        setSelectedFeatureNodeIds([]);
      }
      return;
    }
    const nodeId = featureNodeIdForBody(bodyId);
    if (!nodeId) {
      return;
    }
    setSelectedFeatureNodeIds((current) => {
      if (additive) {
        return current.includes(nodeId)
          ? current.filter((id) => id !== nodeId)
          : [...current, nodeId];
      }
      return current.length === 1 && current[0] === nodeId ? [] : [nodeId];
    });
    setInspectorCollapsed(false);
  }

  function handleSelectSketchFromViewer(sketchId: string, additive: boolean) {
    // Retarget sweep sessions on profile click.
    if (session?.kind === 'extrude' || session?.kind === 'revolve') {
      setSession({ ...session, sketchId: sketchId as SketchId });
      return;
    }
    if (session) {
      return;
    }
    if (!doc) {
      return;
    }
    const feature = features.find(
      (candidate) =>
        candidate.data.featureKind === 'sketch' && candidate.data.sketchId === sketchId
    );
    if (!feature) {
      return;
    }
    setSelectedFeatureNodeIds((current) => {
      if (additive) {
        return current.includes(feature.id)
          ? current.filter((id) => id !== feature.id)
          : [...current, feature.id];
      }
      return current.length === 1 && current[0] === feature.id ? [] : [feature.id];
    });
    setInspectorCollapsed(false);
  }

  function handleSelectFeatureFromTree(nodeId: string, additive: boolean) {
    setSession(null);
    setSelectedFeatureNodeIds((current) => {
      if (additive) {
        return current.includes(nodeId)
          ? current.filter((id) => id !== nodeId)
          : [...current, nodeId];
      }
      return current.length === 1 && current[0] === nodeId ? [] : [nodeId];
    });
    setInspectorCollapsed(false);
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

  // ── Command dispatch ───────────────────────────────────────────────────

  const runCommand = useCallback(
    (commandId: string) => {
      const spec = getCommand(commandId);
      if (spec && !spec.isEnabled(commandCtx)) {
        setStatus(spec.disabledReason(commandCtx) ?? `${spec.label} is unavailable.`);
        return;
      }
      switch (commandId) {
        case 'select':
          cancelSession();
          setSelectedFeatureNodeIds([]);
          break;
        case 'sketch.create':
          startSession('sketch');
          break;
        case 'extrude':
          startSession('extrude');
          break;
        case 'revolve':
          startSession('revolve');
          break;
        case 'primitive.box':
        case 'primitive.cylinder':
        case 'primitive.sphere':
        case 'primitive.cone':
        case 'primitive.torus':
          startSession('primitive', {
            primitiveKind: commandId.split('.')[1] as PrimitiveKind
          });
          break;
        case 'move':
          startSession('move');
          break;
        case 'boolean.union':
        case 'boolean.subtract':
        case 'boolean.intersect':
          startSession('boolean', {
            operation: commandId.split('.')[1] as BooleanOperation
          });
          break;
        case 'delete':
          if (selectedFeature) {
            handleDeleteFeature(selectedFeature.featureId, selectedFeature.name);
          }
          break;
        case 'view.fit':
          viewerApiRef.current?.fit('all');
          break;
        case 'view.fitSelection':
          viewerApiRef.current?.fit('selection');
          break;
        case 'view.front':
        case 'view.top':
        case 'view.right':
        case 'view.iso':
          viewerApiRef.current?.setView(commandId.split('.')[1] as 'front');
          break;
        case 'view.projection': {
          const next = projection === 'perspective' ? 'orthographic' : 'perspective';
          viewerApiRef.current?.setProjection(next);
          setProjection(next);
          break;
        }
        case 'view.grid':
          setViewerSettings((current) => ({ ...current, showGrid: !current.showGrid }));
          break;
        case 'view.showAll':
          setHiddenBodyIds(new Set());
          break;
        case 'undo':
          handleUndo();
          break;
        case 'redo':
          handleRedo();
          break;
        case 'save':
          void handleSave();
          break;
        case 'export.step':
          handleExport('step');
          break;
        case 'export.stl':
          handleExport('stl');
          break;
        case 'import':
          importInputRef.current?.click();
          break;
        case 'search':
          setSearchOpen(true);
          break;
        case 'help.shortcuts':
          setShortcutsOpen(true);
          break;
        default:
          break;
      }
    },
    [commandCtx, session, selectedFeature, projection, startSession, cancelSession]
  );

  // ── Keyboard map ───────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA');
      const inHud = typing && target.closest('.command-hud') !== null;
      const meta = event.ctrlKey || event.metaKey;

      // HUD inputs: Enter commits the command, Escape cancels it. Tab keeps
      // its native behavior, which already cycles the HUD parameter inputs.
      if (inHud) {
        if (event.key === 'Enter') {
          event.preventDefault();
          confirmSession();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelSession();
        }
        return;
      }
      if (typing) {
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
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (meta || event.altKey) {
        return;
      }

      if (event.key === 'Enter' && session) {
        event.preventDefault();
        confirmSession();
        return;
      }
      if (event.key === 'Escape') {
        if (searchOpen || shortcutsOpen || contextMenu) {
          return; // overlays close themselves
        }
        event.preventDefault();
        if (session) {
          cancelSession();
        } else {
          setSelectedFeatureNodeIds([]);
        }
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedFeature && !session) {
          event.preventDefault();
          handleDeleteFeature(selectedFeature.featureId, selectedFeature.name);
        }
        return;
      }
      if (event.key === 'F' && event.shiftKey) {
        event.preventDefault();
        runCommand('view.fitSelection');
        return;
      }
      if (event.shiftKey && event.key !== '?') {
        return;
      }

      const commandId = {
        k: 'sketch.create',
        e: 'extrude',
        r: 'revolve',
        b: 'primitive.box',
        c: 'primitive.cylinder',
        m: 'move',
        f: 'view.fit',
        g: 'view.grid',
        p: 'view.projection',
        s: 'search',
        '1': 'view.front',
        '2': 'view.top',
        '3': 'view.right',
        '0': 'view.iso',
        '?': 'help.shortcuts'
      }[event.key.toLowerCase()];
      if (commandId) {
        event.preventDefault();
        runCommand(commandId);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // ── Context menus ──────────────────────────────────────────────────────

  const menuActionsRef = useRef<Record<string, () => void>>({});

  function openMenu(
    x: number,
    y: number,
    entries: { item: ContextMenuState['items'][number]; run(): void }[]
  ) {
    menuActionsRef.current = Object.fromEntries(entries.map((entry) => [entry.item.id, entry.run]));
    setContextMenu({ x, y, items: entries.map((entry) => entry.item) });
  }

  function handleViewportContextMenu(x: number, y: number, bodyId: string | null) {
    if (!doc) {
      return;
    }
    if (!bodyId) {
      openMenu(x, y, [
        {
          item: { id: 'fit', label: 'Fit View', icon: 'Maximize2', shortcut: 'F' },
          run: () => runCommand('view.fit')
        },
        {
          item: {
            id: 'showAll',
            label: 'Show All Bodies',
            icon: 'Eye',
            disabled: hiddenBodyIds.size === 0
          },
          run: () => runCommand('view.showAll')
        },
        {
          item: { id: 'grid', label: 'Toggle Grid', icon: 'Grid3x3', shortcut: 'G' },
          run: () => runCommand('view.grid')
        }
      ]);
      return;
    }
    const nodeId = featureNodeIdForBody(bodyId);
    const feature = nodeId ? features.find((candidate) => candidate.id === nodeId) : null;
    if (!feature) {
      return;
    }
    // Make sure the clicked body is selected so contextual commands target it.
    if (!selectedFeatureNodeIds.includes(feature.id)) {
      setSelectedFeatureNodeIds([feature.id]);
    }
    openMenu(x, y, [
      {
        item: { id: 'move', label: 'Move / Rotate', icon: 'Move3d', shortcut: 'M' },
        run: () => runCommand('move')
      },
      {
        item: {
          id: 'subtract',
          label: 'Subtract…',
          icon: 'Scissors',
          disabled: liveBodyCount < 2
        },
        run: () => runCommand('boolean.subtract')
      },
      {
        item: {
          id: 'union',
          label: 'Union…',
          icon: 'Combine',
          disabled: liveBodyCount < 2
        },
        run: () => runCommand('boolean.union')
      },
      {
        item: { id: 'hide', label: 'Hide Body', icon: 'Eye', section: true },
        run: () => toggleBodyVisibility(bodyId)
      },
      {
        item: { id: 'fitSel', label: 'Fit Selection', icon: 'Focus', shortcut: '⇧F' },
        run: () => viewerApiRef.current?.fit('selection')
      },
      {
        item: { id: 'rename', label: 'Rename', section: true },
        run: () => setRenamingNodeId(feature.id)
      },
      {
        item: { id: 'delete', label: 'Delete', icon: 'Trash2', shortcut: 'Del', danger: true },
        run: () => handleDeleteFeature(feature.featureId, feature.name)
      }
    ]);
  }

  function handleFeatureContextMenu(event: React.MouseEvent, feature: FeatureNode) {
    const bodyId = feature.bodyId ?? null;
    const body = bodyId ? representations[bodyId] : null;
    openMenu(event.clientX, event.clientY, [
      {
        item: { id: 'edit', label: 'Edit Properties' },
        run: () => {
          setSelectedFeatureNodeIds([feature.id]);
          setInspectorCollapsed(false);
        }
      },
      {
        item: { id: 'rename', label: 'Rename' },
        run: () => setRenamingNodeId(feature.id)
      },
      ...(bodyId && body && !body.consumed
        ? [
            {
              item: {
                id: 'visibility',
                label: hiddenBodyIds.has(bodyId) ? 'Show Body' : 'Hide Body',
                icon: 'Eye',
                section: true
              },
              run: () => toggleBodyVisibility(bodyId)
            },
            {
              item: { id: 'zoom', label: 'Zoom To', icon: 'Focus' },
              run: () => {
                setSelectedFeatureNodeIds([feature.id]);
                // Fit after selection state lands in the viewer.
                window.setTimeout(() => viewerApiRef.current?.fit('selection'), 50);
              }
            }
          ]
        : []),
      {
        item: {
          id: 'delete',
          label: 'Delete',
          icon: 'Trash2',
          shortcut: 'Del',
          danger: true,
          section: true
        },
        run: () => handleDeleteFeature(feature.featureId, feature.name)
      }
    ]);
  }

  // ── Render ─────────────────────────────────────────────────────────────

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

  const hud = session ? (
    <CommandHUD
      session={session}
      scope={scope}
      units={doc.units}
      pickedBodyNames={pickedBodyNames}
      onSetValue={(key, value) => setSession((s) => (s ? setSessionValue(s, key, value) : s))}
      onSetPlane={(plane) => setSession((s) => (s?.kind === 'sketch' ? { ...s, plane } : s))}
      onSetShape={(shape) => setSession((s) => (s?.kind === 'sketch' ? { ...s, shape } : s))}
      onSetAxis={(axis) => setSession((s) => (s?.kind === 'revolve' ? { ...s, axis } : s))}
      onSetOperation={(operation) =>
        setSession((s) => (s?.kind === 'boolean' ? { ...s, operation } : s))
      }
      onConfirm={confirmSession}
      onCancel={cancelSession}
    />
  ) : null;

  return (
    <>
      <input
        ref={importInputRef}
        type="file"
        accept=".stl,.step,.stp"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) {
            void handleImportFile(file);
          }
        }}
      />
      <AppShell
        topBar={
          <TopBar
            projectName={doc.name}
            units={doc.units}
            dirty={lastSavedVersion !== null && doc.version !== lastSavedVersion}
            workspace={workspace}
            canUndo={managerRef.current?.canUndo ?? false}
            canRedo={managerRef.current?.canRedo ?? false}
            canExport={exportBodyIds.length > 0}
            exportScope={
              selectedBody && !selectedBody.consumed && selectedBody.exportableStep
                ? selectedBody.name
                : null
            }
            onWorkspaceChange={(next) => {
              setWorkspace(next);
              storageSet(workspaceKey(doc.projectId), next);
            }}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onSave={() => void handleSave()}
            onImportFile={(file) => void handleImportFile(file)}
            onExport={handleExport}
            onGoHome={() => void handleGoHome()}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenShortcuts={() => setShortcutsOpen(true)}
          />
        }
        palette={
          workspace === 'model' ? (
            <ToolPalette ctx={commandCtx} activeCommandId={activeCommandId} onRun={runCommand} />
          ) : (
            <VisualizePanel
              displayMode={viewerSettings.displayMode}
              showGrid={viewerSettings.showGrid}
              projection={projection}
              onDisplayMode={(displayMode) =>
                setViewerSettings((current) => ({ ...current, displayMode }))
              }
              onToggleGrid={() => runCommand('view.grid')}
              onToggleProjection={() => runCommand('view.projection')}
            />
          )
        }
        browser={
          <ModelBrowser
            parameters={parameters}
            parameterValues={scope}
            features={features}
            representations={representations}
            selectedFeatureNodeIds={selectedFeatureNodeIds}
            hiddenBodyIds={hiddenBodyIds}
            warnings={warnings}
            renamingNodeId={renamingNodeId}
            onSelectFeature={handleSelectFeatureFromTree}
            onRenameNode={(nodeId, name) => {
              const node = doc.nodes[nodeId];
              const commands: AnyCommand[] = [commandFactories.renameNode({ nodeId, name })];
              // Sketch features share their name with the sketch node.
              if (node?.kind === 'feature' && node.data.featureKind === 'sketch') {
                const sketch = findSketch(doc, node.data.sketchId);
                if (sketch) {
                  commands.push(commandFactories.renameNode({ nodeId: sketch.id, name }));
                }
              }
              executeTransaction(`Rename to ${name}`, commands);
            }}
            onRenameStateChange={setRenamingNodeId}
            onToggleBodyVisibility={toggleBodyVisibility}
            onFeatureContextMenu={handleFeatureContextMenu}
            onSetParameter={(name, expression) =>
              executeCommand(commandFactories.setParameter({ name, expression }))
            }
            onDeleteParameter={(name) =>
              executeCommand(commandFactories.deleteParameter({ name }))
            }
          />
        }
        viewer={
          <ViewerShell
            bodies={viewerBodies}
            sketches={sketchOverlayViews}
            totalFeatureCount={features.length}
            selectedBodyIds={highlightedBodyIds}
            settings={viewerSettings}
            preview={preview}
            manipulator={manipulator}
            projection={projection}
            apiRef={viewerApiRef}
            orientationRef={orientationRef}
            hud={hud}
            showOrbitHint={!navHintDismissed}
            onDismissOrbitHint={() => {
              setNavHintDismissed(true);
              storageSet(NAV_HINT_KEY, '1');
            }}
            onSelectBody={handleSelectBodyFromViewer}
            onSelectSketch={handleSelectSketchFromViewer}
            onContextMenu={handleViewportContextMenu}
            onManipulatorDrag={(valueKey, value) =>
              setSession((current) =>
                current ? setSessionValue(current, valueKey, formatDragValue(value)) : current
              )
            }
            onView={(view) => viewerApiRef.current?.setView(view)}
            onToggleProjection={() => runCommand('view.projection')}
            onToggleGrid={() => runCommand('view.grid')}
            onFit={(target) => viewerApiRef.current?.fit(target)}
            onStartSketch={() => runCommand('sketch.create')}
            onStartBox={() => runCommand('primitive.box')}
            onImportClick={() => importInputRef.current?.click()}
          />
        }
        inspector={
          <PropertiesInspector
            workspace={workspace}
            collapsed={inspectorCollapsed || session !== null}
            onToggleCollapsed={() => setInspectorCollapsed((value) => !value)}
            selectedFeature={session ? null : selectedFeature}
            selectedSketch={selectedSketch}
            selectedSketchObject={selectedSketchObject}
            selectedBody={selectedBody}
            bodyColorOverride={bodyColorOverride}
            scope={scope}
            sketches={sketchOptions}
            bodies={bodyOptions}
            units={doc.units}
            onClearSelection={() => setSelectedFeatureNodeIds([])}
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
            onSetBodyColor={(feature, color) => {
              if (!feature.bodyId) {
                return;
              }
              const bodyNode = listNodesByKind(doc, 'body').find(
                (node) => node.bodyId === feature.bodyId
              );
              if (bodyNode) {
                executeCommand(
                  commandFactories.setNodeMetadata(
                    { nodeId: bodyNode.id, metadata: { color } },
                    color ? 'Set body color' : 'Reset body color'
                  )
                );
              }
            }}
          />
        }
        statusBar={
          <StatusBar
            status={status}
            tone={tone}
            hint={
              session
                ? `${sessionTitle(session)} active — Enter confirms, Esc cancels`
                : selectedBodyIds.length > 0
                  ? `${selectedBodyIds.length} selected — right-click for actions`
                  : 'S searches commands · ? shows shortcuts'
            }
            projectName={doc.name}
            bodyCount={viewerBodies.length}
            featureCount={features.length}
            warningCount={warnings.length}
            documentVersion={doc.version}
          />
        }
      />
      {searchOpen && (
        <CommandSearch ctx={commandCtx} onRun={runCommand} onClose={() => setSearchOpen(false)} />
      )}
      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          onSelect={(itemId) => menuActionsRef.current[itemId]?.()}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
