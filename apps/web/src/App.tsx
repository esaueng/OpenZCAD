import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { getLatestBodyId, getLatestSketchId } from '@openzcad/document-core';
import { parseStepMetadata } from '@openzcad/io-step';
import { exportBodiesToStl, parseStl } from '@openzcad/io-stl';
import { createMockKernelAdapter } from '@openzcad/kernel-adapter';
import type {
  BodyRepresentation,
  PrimitiveKind,
  ProjectDocument,
  ProjectSummary,
  SketchObjectKind
} from '@openzcad/shared';
import { api } from './lib/api';
import { CadViewport } from './components/CadViewport';
import { CommandConsole } from './components/CommandConsole';
import { ModelTree } from './components/ModelTree';
import { PropertiesPanel } from './components/PropertiesPanel';
import { StatusBar } from './components/StatusBar';
import type { ViewPreset } from './lib/view';

const kernel = createMockKernelAdapter();

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [document, setDocument] = useState<ProjectDocument | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('Checking beta API...');
  const [viewPreset, setViewPreset] = useState<ViewPreset>('iso');
  const [fitToken, setFitToken] = useState(0);
  const managerRef = useRef<CommandManager | null>(null);
  const geometryWorkerRef = useRef<Worker | null>(null);

  useEffect(() => {
    geometryWorkerRef.current = new Worker(
      new URL('./worker/geometryWorker.ts', import.meta.url),
      { type: 'module' }
    );
    geometryWorkerRef.current.onmessage = (event: MessageEvent<ProjectDocument['derived']>) => {
      if (!managerRef.current) {
        return;
      }
      const nextDocument = managerRef.current.commitDerivedState(event.data);
      startTransition(() => {
        setDocument({ ...nextDocument });
      });
    };

    return () => geometryWorkerRef.current?.terminate();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const health = await api.health();
        const listed = await api.listProjects();
        setProjects(listed.projects);
        setStatus(
          `API ${health.status} on ${health.environment}. ${listed.projects.length} project(s) available.`
        );
        if (listed.projects[0]) {
          const loaded = await api.loadProject(listed.projects[0].projectId);
          hydrateDocument(loaded);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Failed to reach API.');
      }
    })();
  }, []);

  useEffect(() => {
    if (document && geometryWorkerRef.current) {
      geometryWorkerRef.current.postMessage(document);
    }
  }, [document]);

  const bodies = useMemo<BodyRepresentation[]>(
    () => (document ? Object.values(document.derived.bodyRepresentations) : []),
    [document]
  );
  const deferredBodies = useDeferredValue(bodies);

  const selectedBodyId = useMemo(() => {
    if (!document || !selectedId) {
      return null;
    }

    const node = document.nodes[selectedId];
    return node?.kind === 'body' ? node.bodyId : null;
  }, [document, selectedId]);

  const activeProject = useMemo(
    () =>
      (document &&
        projects.find((project) => project.projectId === document.projectId)) ??
      null,
    [document, projects]
  );

  const selectedNode = useMemo(
    () => (document && selectedId ? document.nodes[selectedId] ?? null : null),
    [document, selectedId]
  );

  function hydrateDocument(nextDocument: ProjectDocument) {
    managerRef.current = new CommandManager(nextDocument);
    startTransition(() => {
      setDocument(nextDocument);
    });
    setSelectedId(nextDocument.activePartId);
    setViewPreset('iso');
    setFitToken((current) => current + 1);
  }

  function executeCommand(factory: Parameters<CommandManager['execute']>[0]) {
    if (!managerRef.current) {
      return;
    }
    const nextDocument = managerRef.current.execute(factory);
    startTransition(() => {
      setDocument({ ...nextDocument });
    });
    setStatus(factory.label);
  }

  async function refreshProjects() {
    const listed = await api.listProjects();
    setProjects(listed.projects);
  }

  async function handleCreateProject(name: string) {
    const response = await api.createProject({ name });
    hydrateDocument(response.document);
    setProjects((current) => [response.project, ...current]);
    setStatus(`Created ${response.project.name}.`);
  }

  async function handleLoadProject(projectId: string) {
    const loaded = await api.loadProject(projectId);
    hydrateDocument(loaded);
    setStatus(`Loaded ${loaded.name}.`);
  }

  function handlePrimitive(kind: PrimitiveKind) {
    executeCommand(
      commandFactories.addPrimitive({
        name: `${kind} ${(document?.bodyOrder.length ?? 0) + 1}`,
        // Keep primitive creation deterministic for the vertical slice.
        primitiveKind: kind,
        dimensions:
          kind === 'box'
            ? { width: 30, height: 18, depth: 24 }
            : kind === 'cylinder'
              ? { radius: 14, height: 28 }
              : { radius: 16 }
      })
    );
  }

  function handleSketch(kind: SketchObjectKind) {
    if (!managerRef.current) {
      return;
    }
    const command = commandFactories.addSketch({
      name: `${kind} sketch`,
      plane: 'XY',
      objectKind: kind,
      rectangle: { width: 32, height: 18 },
      circle: { radius: 14 },
      line: { start: { x: -12, y: 0 }, end: { x: 12, y: 0 } }
    });
    const nextDocument = managerRef.current.execute(command);
    startTransition(() => {
      setDocument({ ...nextDocument });
    });
    setStatus(`Added ${kind} sketch.`);
  }

  function handleExtrude() {
    if (!managerRef.current || !document) {
      return;
    }
    const sketchId = getLatestSketchId(document);
    if (!sketchId) {
      setStatus('Create a sketch before extruding.');
      return;
    }
    const nextDocument = managerRef.current.execute(
      commandFactories.extrudeSketch({
        name: 'Extrude 1',
        sketchId,
        distance: 24
      })
    );
    startTransition(() => {
      setDocument({ ...nextDocument });
    });
    setStatus('Extrude feature added.');
  }

  function handleBoolean(operation: 'union' | 'subtract' | 'intersect') {
    if (!managerRef.current || !document || document.bodyOrder.length < 2) {
      setStatus('At least two bodies are required for a boolean operation.');
      return;
    }
    const targets = document.bodyOrder.slice(-2);
    const nextDocument = managerRef.current.execute(
      commandFactories.booleanBodies({
        name: `${operation} result`,
        operation,
        targetBodyIds: targets
      })
    );
    startTransition(() => {
      setDocument({ ...nextDocument });
    });
    setStatus(`Boolean ${operation} created from the last two bodies.`);
  }

  function handleTransform() {
    if (!managerRef.current || !document) {
      return;
    }
    const bodyId = getLatestBodyId(document);
    if (!bodyId) {
      setStatus('Create a body before transforming.');
      return;
    }
    const nextDocument = managerRef.current.execute(
      commandFactories.transformBody({
        name: 'Move body',
        targetBodyId: bodyId,
        translation: { x: 12, y: 10, z: 6 },
        rotationDeg: { x: 0, y: 25, z: 0 }
      })
    );
    startTransition(() => {
      setDocument({ ...nextDocument });
    });
    setStatus('Applied transform feature to the latest body.');
  }

  function handleUndo() {
    const manager = managerRef.current;
    if (!manager) {
      return;
    }
    const nextDocument = manager.undo();
    startTransition(() => {
      setDocument({ ...nextDocument });
    });
    setStatus('Undo');
  }

  function handleRedo() {
    const manager = managerRef.current;
    if (!manager) {
      return;
    }
    const nextDocument = manager.redo();
    startTransition(() => {
      setDocument({ ...nextDocument });
    });
    setStatus('Redo');
  }

  async function handleSave() {
    if (!document) {
      return;
    }
    const saved = await api.saveRevision({
      projectId: document.projectId,
      reason: 'Manual save',
      document
    });
    hydrateDocument(saved);
    await refreshProjects();
    setStatus('Saved revision to persistence.');
  }

  async function handleImportFile(file: File) {
    if (!managerRef.current || !document) {
      return;
    }

    const uploadSession = await api.createUploadSession({
      projectId: document.projectId,
      fileName: file.name,
      contentType: file.type || inferContentType(file.name)
    });

    if (uploadSession.session.uploadUrl) {
      await fetch(uploadSession.session.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'content-type': file.type || inferContentType(file.name)
        }
      });
    }

    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith('.stl')) {
      const parsed = parseStl(await file.arrayBuffer(), file.name);
      const nextDocument = managerRef.current.execute(
        commandFactories.importMesh({
          name: parsed.name,
          artifactId: uploadSession.session.artifactId,
          sourceName: parsed.name,
          triangleCount: parsed.triangleCount
        })
      );
      startTransition(() => {
        setDocument({ ...nextDocument });
      });
      await api.finalizeImport({
        projectId: document.projectId,
        uploadSessionId: uploadSession.session.uploadSessionId,
        artifactId: uploadSession.session.artifactId,
        fileName: file.name,
        contentType: file.type || 'model/stl'
      });
      await refreshProjects();
      setViewPreset('iso');
      setFitToken((current) => current + 1);
      setStatus(`Imported STL mesh reference (${parsed.triangleCount} triangles).`);
      return;
    }

    const metadata = await parseStepMetadata(kernel, file.name, await file.text());
    const nextDocument = managerRef.current.execute(
      commandFactories.importMesh({
        name:
          metadata.products[0]
            ? `${metadata.products[0]} Preview`
            : `${file.name.replace(/\.(stp|step)$/i, '')} Preview`,
        artifactId: uploadSession.session.artifactId,
        sourceName: file.name,
        triangleCount: Math.max(metadata.products.length * 24, 48)
      })
    );
    startTransition(() => {
      setDocument({ ...nextDocument });
    });
    await api.finalizeImport({
      projectId: document.projectId,
      uploadSessionId: uploadSession.session.uploadSessionId,
      artifactId: uploadSession.session.artifactId,
      fileName: file.name,
      contentType: file.type || 'model/step'
    });
    await refreshProjects();
    setViewPreset('iso');
    setFitToken((current) => current + 1);
    setStatus(
      `Imported STEP preview for ${metadata.products.length || 1} part(s). Exact B-Rep reconstruction remains staged for the OpenCascade.js adapter.`
    );
  }

  async function handleExport(format: 'step' | 'stl') {
    if (!document || document.bodyOrder.length === 0) {
      setStatus('Create a body before exporting.');
      return;
    }
    const bodyIds = document.bodyOrder.slice(-1);
    if (format === 'stl') {
      const stl = await exportBodiesToStl(kernel, document, bodyIds);
      downloadText(`openzcad-export.stl`, stl);
      await api.requestExport({
        projectId: document.projectId,
        bodyIds,
        format: 'stl'
      });
      setStatus('Exported STL from derived solid geometry.');
      return;
    }

    try {
      await kernel.exportStep(document, bodyIds);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'STEP export failed.');
    }
  }

  return (
    <div className="app-shell">
      <header className="window-bar">
        <div className="window-bar__brand">
          <strong>OpenZCAD</strong>
          <span>beta workspace</span>
        </div>
        <div className="window-bar__meta">
          <span>{activeProject?.name ?? 'No active project'}</span>
          <span>{projects.length} saved projects</span>
          <span>{document ? `${document.revisions.length} revisions` : 'No revision history'}</span>
        </div>
      </header>

      <CommandConsole
        document={document}
        onCreateProject={handleCreateProject}
        onPrimitive={handlePrimitive}
        onSketch={handleSketch}
        onExtrude={handleExtrude}
        onBoolean={handleBoolean}
        onTransform={handleTransform}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSave={handleSave}
        onImportFile={handleImportFile}
        onExport={handleExport}
        onFitView={() => setFitToken((current) => current + 1)}
        onSetView={setViewPreset}
        status={status}
      />

      <main className="workspace">
        <aside className="left-pane cad-panel">
          <section className="pane-section">
            <div className="pane-section__header">
              <div>
                <p className="panel-kicker">Browser</p>
                <h2>Projects</h2>
              </div>
              <span className="pane-count">{projects.length}</span>
            </div>
            <div className="project-list">
              {projects.length === 0 ? (
                <div className="panel-empty">Create a project to start modeling.</div>
              ) : (
                projects.map((project) => (
                  <button
                    key={project.projectId}
                    className={`project-list__item ${
                      document?.projectId === project.projectId ? 'is-active' : ''
                    }`}
                    onClick={() => void handleLoadProject(project.projectId)}
                  >
                    <strong>{project.name}</strong>
                    <span>{project.revisionCount} rev</span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="pane-section pane-section--fill">
            <div className="pane-section__header">
              <div>
                <p className="panel-kicker">Assembly</p>
                <h2>Model tree</h2>
              </div>
              <span className="pane-count">{document?.bodyOrder.length ?? 0}</span>
            </div>
            <ModelTree document={document} selectedId={selectedId} onSelect={setSelectedId} />
          </section>
        </aside>

        <section className="center-pane">
          <div className="viewport-header">
            <div>
              <p className="panel-kicker">Viewport</p>
              <h2>{document?.name ?? 'No project loaded'}</h2>
            </div>
            <div className="viewport-header__stats">
              <span>{document ? `${document.bodyOrder.length} bodies` : '0 bodies'}</span>
              <span>{document ? `${document.featureOrder.length} features` : '0 features'}</span>
              <span>
                {document?.derived.warnings.length
                  ? `${document.derived.warnings.length} warnings`
                  : 'No warnings'}
              </span>
            </div>
          </div>
          <CadViewport
            bodies={deferredBodies}
            selectedBodyId={selectedBodyId}
            viewPreset={viewPreset}
            fitToken={fitToken}
            onViewPresetChange={setViewPreset}
          />
        </section>

        <aside className="right-pane cad-panel">
          <section className="pane-section">
            <div className="pane-section__header">
              <div>
                <p className="panel-kicker">Inspector</p>
                <h2>Properties</h2>
              </div>
              <span className="pane-count">{selectedNode?.kind ?? 'none'}</span>
            </div>
            <PropertiesPanel document={document} selectedId={selectedId} />
          </section>

          <section className="pane-section">
            <div className="pane-section__header">
              <div>
                <p className="panel-kicker">Session</p>
                <h2>Model status</h2>
              </div>
            </div>
            <div className="inspector-metrics">
              <div>
                <dt>Units</dt>
                <dd>{document?.units ?? 'mm'}</dd>
              </div>
              <div>
                <dt>Selection</dt>
                <dd>{selectedNode?.name ?? 'None'}</dd>
              </div>
              <div>
                <dt>Warnings</dt>
                <dd>{document?.derived.warnings.length ?? 0}</dd>
              </div>
              <div>
                <dt>Artifacts</dt>
                <dd>{document?.bodyOrder.length ?? 0}</dd>
              </div>
            </div>
          </section>
        </aside>
      </main>

      <StatusBar
        status={status}
        document={document}
        selectedId={selectedId}
        viewPreset={viewPreset}
      />
    </div>
  );
}

function inferContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.stl')) {
    return 'model/stl';
  }
  if (lower.endsWith('.step') || lower.endsWith('.stp')) {
    return 'model/step';
  }
  return 'application/octet-stream';
}

function downloadText(name: string, value: string) {
  const blob = new Blob([value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
