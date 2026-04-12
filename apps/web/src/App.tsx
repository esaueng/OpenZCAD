import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandManager, commandFactories } from '@openzcad/command-system';
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

const kernel = createMockKernelAdapter();

export function App() {
  const [projects, setProjects] = useState<string[]>([]);
  const [document, setDocument] = useState<ProjectDocument | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('Checking beta API...');
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
      setDocument({ ...nextDocument });
    };

    return () => geometryWorkerRef.current?.terminate();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const health = await api.health();
        const listed = await api.listProjects();
        setProjects(listed.projects.map((project) => project.projectId));
        setStatus(`API ${health.status} on ${health.environment}. ${listed.projects.length} project(s) available.`);
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

  const selectedBodyId = useMemo(() => {
    if (!document || !selectedId) {
      return null;
    }

    const node = document.nodes[selectedId];
    return node?.kind === 'body' ? node.bodyId : null;
  }, [document, selectedId]);

  function hydrateDocument(nextDocument: ProjectDocument) {
    managerRef.current = new CommandManager(nextDocument);
    setDocument(nextDocument);
    setSelectedId(nextDocument.activePartId);
  }

  function executeCommand(factory: Parameters<CommandManager['execute']>[0]) {
    if (!managerRef.current) {
      return;
    }
    const nextDocument = managerRef.current.execute(factory);
    setDocument({ ...nextDocument });
    setStatus(factory.label);
  }

  async function handleCreateProject(name: string) {
    const response = await api.createProject({ name });
    hydrateDocument(response.document);
    setProjects((current: string[]) => [response.project.projectId, ...current]);
    setStatus(`Created ${response.project.name}.`);
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
    setDocument({ ...nextDocument });
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
    setDocument({ ...nextDocument });
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
    setDocument({ ...nextDocument });
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
    setDocument({ ...nextDocument });
    setStatus('Applied transform feature to the latest body.');
  }

  function handleUndo() {
    if (!managerRef.current) {
      return;
    }
    setDocument({ ...managerRef.current.undo() });
    setStatus('Undo');
  }

  function handleRedo() {
    if (!managerRef.current) {
      return;
    }
    setDocument({ ...managerRef.current.redo() });
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
      setDocument({ ...nextDocument });
      await api.finalizeImport({
        projectId: document.projectId,
        uploadSessionId: uploadSession.session.uploadSessionId,
        artifactId: uploadSession.session.artifactId,
        fileName: file.name,
        contentType: file.type || 'model/stl'
      });
      setStatus(`Imported STL mesh reference (${parsed.triangleCount} triangles).`);
      return;
    }

    const metadata = await parseStepMetadata(kernel, file.name, await file.text());
    setStatus(
      `STEP metadata parsed for ${metadata.name}. Native B-Rep import remains staged for the OpenCascade.js adapter.`
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
          <ModelTree document={document} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
        <section className="center-pane">
          <CadViewport bodies={bodies} selectedBodyId={selectedBodyId} />
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
            status={status}
          />
        </section>
        <aside className="right-pane">
          <h2>Properties</h2>
          <PropertiesPanel document={document} selectedId={selectedId} />
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
