import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  type AnyCommand
} from '@openzcad/command-system';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import {
  createProjectDocument,
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
  FeatureId,
  FeatureNode,
  ProjectDocument,
  ProjectSummary,
  SketchNode,
  SketchObjectData,
  TopologySelection,
  UnitSystem
} from '@openzcad/shared';
import type { AuthSession } from '@openzcad/shared';
import { toUserId } from '@openzcad/shared';
import { api } from './lib/api';
import { downloadText, exportFileStem, inferContentType } from './lib/model';
import { AppShell } from './components/AppShell';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ViewerShell } from './components/ViewerShell';
import { Inspector, type ToolId } from './components/Inspector';
import { StatusBar } from './components/StatusBar';
import { StartScreen } from './components/StartScreen';
import { AiCommandRail } from './components/AiCommandRail';
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

const kernel = createKernelAdapter();
const localUserId = toUserId('user_local_browser');
const MAX_EMBEDDED_STEP_BYTES = 12 * 1024 * 1024;

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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // Named `doc` (not `document`) so the global DOM document is never shadowed.
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [selectedFeatureNodeId, setSelectedFeatureNodeId] = useState<
    string | null
  >(null);
  const [selectedTopology, setSelectedTopology] =
    useState<TopologySelection | null>(null);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [status, setStatus] = useState('Checking beta API...');
  const [busy, setBusy] = useState(false);
  const [viewerSettings, setViewerSettings] = useState({ showGrid: true });
  const [previewDoc, setPreviewDoc] = useState<ProjectDocument | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'offline'>(
    'saving'
  );
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
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
  const lastSyncedKeyRef = useRef<string | null>(null);

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
      hydrateDocument(remoteDocument);
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
      worker.terminate();
      geometryWorkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    void (async () => {
      const [local, remote] = await Promise.all([
        listLocalProjects().catch(() => []),
        Promise.all([api.health(), api.session(), api.listProjects()]).catch(
          () => null
        )
      ]);
      const remoteProjects = remote?.[2].projects ?? [];
      const merged = mergeProjectSummaries(local, remoteProjects);
      setProjects(merged);
      setCloudAvailable(Boolean(remote));
      setSession(remote?.[1] ?? null);
      setSaveState(remote ? 'saved' : 'offline');
      setStatus(
        remote
          ? `Beta API ready · ${merged.length} project(s)`
          : `Offline workspace · ${merged.length} local project(s)`
      );
    })();
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
  const warnings = doc?.derived.warnings ?? [];

  const viewerBodies = useMemo<BodyRepresentation[]>(
    () =>
      previewDoc
        ? Object.values(previewDoc.derived.bodyRepresentations).filter(
            (body) => !body.consumed
          )
        : doc
          ? Object.values(doc.derived.bodyRepresentations).filter(
              (body) => !body.consumed
            )
          : [],
    [doc, previewDoc]
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
  const selectedBodyId =
    selectedTopology?.bodyId ??
    (selectedBody && !selectedBody.consumed ? selectedBody.bodyId : null);

  const exportBodyIds = useMemo<BodyId[]>(() => {
    if (!doc) {
      return [];
    }
    if (selectedBody && !selectedBody.consumed && selectedBody.exportableStep) {
      return [selectedBody.bodyId];
    }
    return doc.derived.exportableBodyIds;
  }, [doc, selectedBody]);

  function hydrateDocument(nextDocument: ProjectDocument) {
    const normalized = normalizeDocument(nextDocument);
    managerRef.current = new CommandManager(normalized);
    lastSyncedKeyRef.current = null;
    setDoc(normalized);
    setPreviewDoc(null);
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setTool(null);
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
      // Back to the tool launcher so sequential adds stay one click away;
      // the new feature is selectable from the history or the viewport.
      setTool(null);
      setSelectedFeatureNodeId(null);
      setSelectedTopology(null);
    }
  }

  async function handleCreateProject(name: string, units: UnitSystem) {
    setBusy(true);
    try {
      const response = await api.createProject({ name, units });
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
    managerRef.current = null;
    setDoc(null);
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
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
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setStatus('Undo');
  }

  function handleRedo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.redo());
    setSelectedFeatureNodeId(null);
    setSelectedTopology(null);
    setStatus('Redo');
  }

  async function handleSave() {
    if (!doc) {
      return;
    }
    try {
      setSaveState('saving');
      await saveLocalProject(doc);
      const saved = await api.saveRevision({
        projectId: doc.projectId,
        reason: 'Manual save',
        document: doc
      });
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

  function handlePreviewPatch(proposal: CadPatchProposal | null) {
    if (!proposal || !doc) {
      setPreviewDoc(null);
      setStatus('Preview cleared.');
      return;
    }
    try {
      const previewManager = new CommandManager(doc);
      const preview = previewManager.runTransaction(
        'Preview AI patch',
        commandsForCadPatch(doc, proposal)
      );
      setPreviewDoc({ ...preview, derived: kernel.syncDocument(preview) });
      setStatus(
        'Previewing proposed patch · exact rebuild occurs after apply.'
      );
    } catch (error) {
      setPreviewDoc(null);
      setStatus(errorMessage(error, 'Patch preview failed.'));
    }
  }

  function handleApplyPatch(proposal: CadPatchProposal) {
    if (!doc) {
      return;
    }
    try {
      executeTransaction('Apply AI patch', commandsForCadPatch(doc, proposal));
    } catch (error) {
      setStatus(errorMessage(error, 'Patch could not be applied.'));
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
            throw new Error(
              `Upload failed with status ${uploadResponse.status}.`
            );
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
            throw new Error(`Upload failed (${uploadResponse.status}).`);
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
      downloadText(`${stem}.${format}`, result.text);
      if (format === 'step') {
        setStatus(
          result.warnings.length > 0
            ? `Exported STEP with ${result.warnings.length} warning(s).`
            : `Exported ${exportBodyIds.length} body(ies) to ${stem}.step (AP214).`
        );
      } else {
        setStatus(`Exported ${exportBodyIds.length} body(ies) to ${stem}.stl.`);
      }
      // Record the export with the worker API; the download already happened.
      api
        .requestExport({
          projectId: doc.projectId,
          bodyIds: exportBodyIds,
          format
        })
        .catch(() => undefined);
    } catch (error) {
      setStatus(errorMessage(error, `${format.toUpperCase()} export failed.`));
    }
  }

  function handleSelectTopologyFromViewer(selection: TopologySelection | null) {
    if (!doc || !selection) {
      setSelectedFeatureNodeId(null);
      setSelectedTopology(null);
      return;
    }
    const bodyNode = listNodesByKind(doc, 'body').find(
      (body) => body.bodyId === selection.bodyId
    );
    const feature = bodyNode
      ? features.find((candidate) => candidate.featureId === bodyNode.featureId)
      : undefined;
    setTool(null);
    setSelectedTopology(selection);
    setSelectedFeatureNodeId(feature?.id ?? null);
  }

  function handleDeleteFeature(featureId: FeatureId, name: string) {
    if (
      executeCommand(
        commandFactories.deleteFeature({ featureId }, `Delete ${name}`)
      )
    ) {
      setSelectedFeatureNodeId(null);
      setSelectedTopology(null);
    }
  }

  // Keyboard shortcuts: undo/redo/save/delete (ignored while typing).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA')
      ) {
        return;
      }
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if (meta && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        handleRedo();
      } else if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void handleSave();
      } else if (event.key === 'Delete' && selectedFeature) {
        event.preventDefault();
        handleDeleteFeature(selectedFeature.featureId, selectedFeature.name);
      } else if (event.key === 'Escape') {
        setTool(null);
        setSelectedFeatureNodeId(null);
        setSelectedTopology(null);
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

  const tone: 'ready' | 'warning' | 'running' =
    /fail|error|invalid|unable|denied/i.test(status) ? 'warning' : 'ready';

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
        />
      }
      sidebar={
        <Sidebar
          parameters={parameters}
          parameterValues={parameterScope.scope}
          features={features}
          representations={representations}
          selectedFeatureNodeId={selectedFeatureNodeId}
          warnings={warnings}
          onSelectFeature={(nodeId) => {
            setTool(null);
            setSelectedTopology(null);
            setSelectedFeatureNodeId((current) =>
              current === nodeId ? null : nodeId
            );
          }}
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
          selectedBodyId={selectedBodyId}
          selectedTopology={selectedTopology}
          settings={viewerSettings}
          fitSignal={fitSignal}
          onSelectTopology={handleSelectTopologyFromViewer}
          onToggleGrid={() =>
            setViewerSettings((current) => ({
              ...current,
              showGrid: !current.showGrid
            }))
          }
          onFit={() => setFitSignal((value) => value + 1)}
        />
      }
      inspector={
        <Inspector
          tool={tool}
          selectedFeature={selectedFeature}
          selectedSketch={selectedSketch}
          selectedSketchObject={selectedSketchObject}
          selectedBody={selectedBody}
          selectedTopology={selectedTopology}
          scope={parameterScope.scope}
          sketches={sketchOptions}
          bodies={bodyOptions}
          units={doc.units}
          onLaunchTool={(nextTool) => {
            setTool(nextTool);
          }}
          onCancel={() => {
            setTool(null);
            setSelectedFeatureNodeId(null);
            setSelectedTopology(null);
          }}
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
          onDeleteFeature={(feature) =>
            handleDeleteFeature(feature.featureId, feature.name)
          }
        />
      }
      assistant={
        <AiCommandRail
          document={doc}
          selectedTopology={selectedTopology}
          onApply={handleApplyPatch}
          onPreview={handlePreviewPatch}
        />
      }
      statusBar={
        <StatusBar
          status={status}
          tone={tone}
          projectName={doc.name}
          bodyCount={viewerBodies.length}
          featureCount={features.length}
          warningCount={warnings.length}
          documentVersion={doc.version}
          units={doc.units}
        />
      }
    />
  );
}
