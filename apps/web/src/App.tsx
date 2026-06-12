import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandManager, commandFactories, type AnyCommand } from '@openzcad/command-system';
import { getLatestBodyId, getLatestSketchId } from '@openzcad/document-core';
import { parseStepMetadata } from '@openzcad/io-step';
import { exportBodiesToStl, parseStl } from '@openzcad/io-stl';
import { createMockKernelAdapter } from '@openzcad/kernel-adapter';
import type {
  BodyRepresentation,
  PrimitiveKind,
  ProjectDocument,
  SketchObjectKind
} from '@openzcad/shared';
import { api } from './lib/api';
import { CadViewport } from './components/CadViewport';
import { CommandConsole } from './components/CommandConsole';
import { ModelTree } from './components/ModelTree';
import { PropertiesPanel } from './components/PropertiesPanel';
import type { GeometrySyncResult } from './worker/geometryWorker';

const kernel = createMockKernelAdapter();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function App() {
  const [projects, setProjects] = useState<string[]>([]);
  // Named `doc` (not `document`) so the global DOM document is never shadowed.
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('Checking beta API...');
  const managerRef = useRef<CommandManager | null>(null);
  const geometryWorkerRef = useRef<Worker | null>(null);
  const lastSyncedKeyRef = useRef<string | null>(null);

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
        setStatus(`Geometry sync failed: ${result.error}`);
        return;
      }
      const nextDocument = manager.commitDerivedState(result.derived);
      setDoc(nextDocument);
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
        setProjects(listed.projects.map((project) => project.projectId));
        setStatus(
          `API ${health.status} on ${health.environment}. ${listed.projects.length} project(s) available.`
        );
        if (listed.projects[0]) {
          const loaded = await api.loadProject(listed.projects[0].projectId);
          hydrateDocument(loaded);
        }
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
    // commits keep the same version, which is what breaks the otherwise
    // infinite post -> derive -> commit -> post cycle.
    const syncKey = `${doc.projectId}:${doc.version}`;
    if (lastSyncedKeyRef.current === syncKey) {
      return;
    }
    lastSyncedKeyRef.current = syncKey;
    geometryWorkerRef.current.postMessage(doc);
  }, [doc]);

  const bodies = useMemo<BodyRepresentation[]>(
    () => (doc ? Object.values(doc.derived.bodyRepresentations) : []),
    [doc]
  );

  const selectedBodyId = useMemo(() => {
    if (!doc || !selectedId) {
      return null;
    }

    const node = doc.nodes[selectedId];
    return node?.kind === 'body' ? node.bodyId : null;
  }, [doc, selectedId]);

  function hydrateDocument(nextDocument: ProjectDocument) {
    managerRef.current = new CommandManager(nextDocument);
    setDoc(nextDocument);
    setSelectedId(nextDocument.activePartId);
  }

  function executeCommand(command: AnyCommand) {
    if (!managerRef.current) {
      return;
    }
    try {
      const nextDocument = managerRef.current.execute(command);
      setDoc(nextDocument);
      setStatus(command.label);
    } catch (error) {
      setStatus(errorMessage(error, 'Command failed.'));
    }
  }

  async function handleCreateProject(name: string) {
    try {
      const response = await api.createProject({ name });
      hydrateDocument(response.document);
      setProjects((current: string[]) => [response.project.projectId, ...current]);
      setStatus(`Created ${response.project.name}.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to create project.'));
    }
  }

  function handlePrimitive(kind: PrimitiveKind) {
    executeCommand(
      commandFactories.addPrimitive({
        name: `${kind} ${(doc?.bodyOrder.length ?? 0) + 1}`,
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
    executeCommand(
      commandFactories.addSketch({
        name: `${kind} sketch`,
        plane: 'XY',
        objectKind: kind,
        rectangle: { width: 32, height: 18 },
        circle: { radius: 14 },
        line: { start: { x: -12, y: 0 }, end: { x: 12, y: 0 } }
      })
    );
  }

  function handleExtrude() {
    if (!doc) {
      return;
    }
    const sketchId = getLatestSketchId(doc);
    if (!sketchId) {
      setStatus('Create a sketch before extruding.');
      return;
    }
    executeCommand(
      commandFactories.extrudeSketch({
        name: 'Extrude 1',
        sketchId,
        distance: 24
      })
    );
  }

  function handleBoolean(operation: 'union' | 'subtract' | 'intersect') {
    if (!doc || doc.bodyOrder.length < 2) {
      setStatus('At least two bodies are required for a boolean operation.');
      return;
    }
    const targets = doc.bodyOrder.slice(-2);
    executeCommand(
      commandFactories.booleanBodies({
        name: `${operation} result`,
        operation,
        targetBodyIds: targets
      })
    );
  }

  function handleTransform() {
    if (!doc) {
      return;
    }
    const bodyId = getLatestBodyId(doc);
    if (!bodyId) {
      setStatus('Create a body before transforming.');
      return;
    }
    executeCommand(
      commandFactories.transformBody({
        name: 'Move body',
        targetBodyId: bodyId,
        translation: { x: 12, y: 10, z: 6 },
        rotationDeg: { x: 0, y: 25, z: 0 }
      })
    );
  }

  function handleUndo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.undo());
    setStatus('Undo');
  }

  function handleRedo() {
    if (!managerRef.current) {
      return;
    }
    setDoc(managerRef.current.redo());
    setStatus('Redo');
  }

  async function handleSave() {
    if (!doc) {
      return;
    }
    try {
      await api.saveRevision({
        projectId: doc.projectId,
        reason: 'Manual save',
        document: doc
      });
      // Keep the live CommandManager (and with it the undo history) instead
      // of re-hydrating from the echoed document.
      setStatus('Saved revision to persistence.');
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to save revision.'));
    }
  }

  async function handleImportFile(file: File) {
    if (!managerRef.current || !doc) {
      return;
    }

    try {
      const contentType = file.type || inferContentType(file.name);
      const uploadSession = await api.createUploadSession({
        projectId: doc.projectId,
        fileName: file.name,
        contentType
      });

      if (uploadSession.session.uploadUrl) {
        const uploadResponse = await fetch(uploadSession.session.uploadUrl, {
          method: 'PUT',
          body: file,
          headers: {
            'content-type': contentType
          }
        });
        if (!uploadResponse.ok) {
          throw new Error(`Upload failed with status ${uploadResponse.status}.`);
        }
      }

      const lowerName = file.name.toLowerCase();
      if (lowerName.endsWith('.stl')) {
        const parsed = parseStl(await file.arrayBuffer(), file.name);
        executeCommand(
          commandFactories.importMesh({
            name: parsed.name,
            artifactId: uploadSession.session.artifactId,
            sourceName: parsed.name,
            triangleCount: parsed.triangleCount
          })
        );
        await api.finalizeImport({
          projectId: doc.projectId,
          uploadSessionId: uploadSession.session.uploadSessionId,
          artifactId: uploadSession.session.artifactId,
          fileName: file.name,
          contentType
        });
        setStatus(`Imported STL mesh reference (${parsed.triangleCount} triangles).`);
        return;
      }

      const metadata = await parseStepMetadata(kernel, file.name, await file.text());
      setStatus(
        `STEP metadata parsed for ${metadata.name}. Native B-Rep import remains staged for the OpenCascade.js adapter.`
      );
    } catch (error) {
      setStatus(errorMessage(error, 'Import failed.'));
    }
  }

  async function handleExport(format: 'step' | 'stl') {
    if (!doc || doc.bodyOrder.length === 0) {
      setStatus('Create a body before exporting.');
      return;
    }
    const bodyIds = doc.bodyOrder.slice(-1);
    try {
      if (format === 'stl') {
        const stl = await exportBodiesToStl(kernel, doc, bodyIds);
        downloadText('openzcad-export.stl', stl);
        await api.requestExport({
          projectId: doc.projectId,
          bodyIds,
          format: 'stl'
        });
        setStatus('Exported STL from derived solid geometry.');
        return;
      }

      await kernel.exportStep(doc, bodyIds);
    } catch (error) {
      setStatus(errorMessage(error, `${format.toUpperCase()} export failed.`));
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>OpenZCAD</strong>
          <span>beta</span>
        </div>
        <small>{projects.length} persisted project(s)</small>
      </header>
      <main className="workspace">
        <aside className="left-pane">
          <h2>Model Tree</h2>
          <ModelTree document={doc} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
        <section className="center-pane">
          <CadViewport bodies={bodies} selectedBodyId={selectedBodyId} />
          <CommandConsole
            document={doc}
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
            status={status}
          />
        </section>
        <aside className="right-pane">
          <h2>Properties</h2>
          <PropertiesPanel document={doc} selectedId={selectedId} />
        </aside>
      </main>
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
