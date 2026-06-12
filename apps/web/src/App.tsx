import { useEffect, useMemo, useRef, useState } from 'react';
import { CommandManager, commandFactories, type AnyCommand } from '@openzcad/command-system';
import { getLatestBodyId, getLatestSketchId } from '@openzcad/document-core';
import { parseStepMetadata } from '@openzcad/io-step';
import { exportBodiesToStl, parseStl } from '@openzcad/io-stl';
import { createMockKernelAdapter } from '@openzcad/kernel-adapter';
import type {
  BodyNode,
  BodyRepresentation,
  BooleanOperation,
  PrimitiveKind,
  ProjectDocument,
  ProjectSummary,
  SketchObjectKind,
  UnitSystem
} from '@openzcad/shared';
import { api } from './lib/api';
import {
  canNavigateToStep,
  getBodyLoad,
  getBodyRole,
  getGenerateReadiness,
  getStepStates,
  getStudySettings,
  getWorkflowCounts,
  isReadyToGenerate,
  listBodies,
  loadMetadataPatch,
  roleMetadataPatch,
  studyMetadataPatch,
  WORKFLOW_STEP_IDS,
  type BodyLoad,
  type BodyRole,
  type StudySettings,
  type WorkflowStepId
} from './lib/workflow';
import { runMockGenerativeStudy, type GenerativeRunSummary } from './lib/generative';
import { AppShell } from './components/AppShell';
import { TopBar } from './components/TopBar';
import { StepBar } from './components/StepBar';
import { ViewerShell } from './components/ViewerShell';
import { ContextPanel } from './components/ContextPanel';
import { OutcomePanel } from './components/OutcomePanel';
import { StatusBar } from './components/StatusBar';
import { StartScreen } from './components/StartScreen';
import { ModelPanel } from './components/panels/ModelPanel';
import { PreservePanel } from './components/panels/PreservePanel';
import { ConstraintsPanel } from './components/panels/ConstraintsPanel';
import { LoadsPanel } from './components/panels/LoadsPanel';
import { StudyPanel } from './components/panels/StudyPanel';
import { GeneratePanel, type GenerateProgress } from './components/panels/GeneratePanel';
import { ResultsPanel } from './components/panels/ResultsPanel';
import type { GeometrySyncResult } from './worker/geometryWorker';

const kernel = createMockKernelAdapter();

const STEP_META: Record<WorkflowStepId, { title: string; helper: string }> = {
  model: {
    title: 'Model',
    helper:
      'Build the design space: add primitives, sketch and extrude profiles, combine bodies, or import an STL mesh.'
  },
  preserve: {
    title: 'Preserve',
    helper:
      'Mark geometry the optimizer must keep — mounting bosses, bearing seats, and functional interfaces.'
  },
  constraints: {
    title: 'Constraints',
    helper:
      'Anchor the part with fixed supports and reserve keep-out volumes as obstacles.'
  },
  loads: {
    title: 'Loads',
    helper: 'Apply the forces the part must carry. Loads render as amber arrows in the viewport.'
  },
  study: {
    title: 'Study',
    helper: 'Tune the optimization target, objective, and how many candidates to explore.'
  },
  generate: {
    title: 'Generate',
    helper: 'Check workflow readiness and run the generative study.'
  },
  results: {
    title: 'Results',
    helper: 'Compare candidate outcomes and preview them in the viewport.'
  }
};

const GENERATE_PHASES = [
  'Voxelizing design space',
  'Applying loads and constraints',
  'Optimizing topology',
  'Extracting outcomes'
];

const IDLE_PROGRESS: GenerateProgress = { running: false, phase: '', percent: 0 };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // Named `doc` (not `document`) so the global DOM document is never shadowed.
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('Checking beta API...');
  const [busy, setBusy] = useState(false);
  const [activeStep, setActiveStep] = useState<WorkflowStepId>('model');
  const [run, setRun] = useState<GenerativeRunSummary | null>(null);
  const [runDocVersion, setRunDocVersion] = useState<number | null>(null);
  const [selectedOutcomeId, setSelectedOutcomeId] = useState<string | null>(null);
  const [progress, setProgress] = useState<GenerateProgress>(IDLE_PROGRESS);
  const [viewerSettings, setViewerSettings] = useState({ showGrid: true, showLoads: true });
  const [fitSignal, setFitSignal] = useState(0);
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

  const bodies = useMemo<BodyRepresentation[]>(
    () => (doc ? Object.values(doc.derived.bodyRepresentations) : []),
    [doc]
  );

  const bodyNodes = useMemo<BodyNode[]>(() => (doc ? listBodies(doc) : []), [doc]);

  const bodyRoles = useMemo<Record<string, BodyRole | null>>(
    () => Object.fromEntries(bodyNodes.map((body) => [body.bodyId, getBodyRole(body)])),
    [bodyNodes]
  );

  const bodyLoads = useMemo<Record<string, BodyLoad>>(() => {
    const loads: Record<string, BodyLoad> = {};
    for (const body of bodyNodes) {
      const load = getBodyLoad(body);
      if (load) {
        loads[body.bodyId] = load;
      }
    }
    return loads;
  }, [bodyNodes]);

  const counts = useMemo(
    () =>
      doc
        ? getWorkflowCounts(doc)
        : { bodies: 0, designBodies: 0, preserved: 0, fixed: 0, obstacles: 0, loaded: 0 },
    [doc]
  );

  const stepStates = useMemo(() => getStepStates(doc, run !== null), [doc, run]);
  const readiness = useMemo(() => (doc ? getGenerateReadiness(doc) : []), [doc]);
  const studySettings = useMemo<StudySettings>(
    () =>
      doc
        ? getStudySettings(doc)
        : { volumeFraction: 0.4, resolution: 'standard', objective: 'stiffness', confirmed: false },
    [doc]
  );

  const selectedBodyId = useMemo(() => {
    if (!doc || !selectedId) {
      return null;
    }
    const node = doc.nodes[selectedId];
    return node?.kind === 'body' ? node.bodyId : null;
  }, [doc, selectedId]);

  const runIsStale = run !== null && doc !== null && runDocVersion !== doc.version;
  const selectedOutcome =
    run?.outcomes.find((outcome) => outcome.id === selectedOutcomeId) ?? run?.outcomes[0] ?? null;
  const previewActive = activeStep === 'results' && run !== null && selectedOutcome !== null;

  function hydrateDocument(nextDocument: ProjectDocument) {
    managerRef.current = new CommandManager(nextDocument);
    setDoc(nextDocument);
    setSelectedId(null);
    setRun(null);
    setRunDocVersion(null);
    setSelectedOutcomeId(null);
    setActiveStep('model');
  }

  function executeCommand(command: AnyCommand) {
    if (!managerRef.current) {
      return;
    }
    try {
      setDoc(managerRef.current.execute(command));
      setStatus(command.label);
    } catch (error) {
      setStatus(errorMessage(error, 'Command failed.'));
    }
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
    managerRef.current = null;
    setDoc(null);
    setSelectedId(null);
    setRun(null);
    setRunDocVersion(null);
    setSelectedOutcomeId(null);
    setActiveStep('model');
    try {
      const listed = await api.listProjects();
      setProjects(listed.projects);
      setStatus(`${listed.projects.length} project(s) available. Unsaved changes are discarded.`);
    } catch (error) {
      setStatus(errorMessage(error, 'Failed to refresh projects.'));
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
    executeCommand(commandFactories.extrudeSketch({ name: 'Extrude 1', sketchId, distance: 24 }));
  }

  function handleBoolean(operation: BooleanOperation) {
    if (!doc || doc.bodyOrder.length < 2) {
      setStatus('At least two bodies are required for a boolean operation.');
      return;
    }
    executeCommand(
      commandFactories.booleanBodies({
        name: `${operation} result`,
        operation,
        targetBodyIds: doc.bodyOrder.slice(-2)
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

  function handleSetRole(body: BodyNode, role: BodyRole | null) {
    executeCommand(
      commandFactories.setNodeMetadata(
        { nodeId: body.id, metadata: roleMetadataPatch(role) },
        role ? `Mark ${body.name} as ${role}` : `Clear role on ${body.name}`
      )
    );
  }

  function handleSetLoad(body: BodyNode, load: BodyLoad | null) {
    executeCommand(
      commandFactories.setNodeMetadata(
        { nodeId: body.id, metadata: loadMetadataPatch(load) },
        load ? `Apply load to ${body.name}` : `Remove load from ${body.name}`
      )
    );
  }

  function handleApplyStudy(settings: StudySettings) {
    if (!doc) {
      return;
    }
    executeCommand(
      commandFactories.setNodeMetadata(
        { nodeId: doc.rootNodeId, metadata: studyMetadataPatch(settings) },
        'Apply study settings'
      )
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
      await api.saveRevision({ projectId: doc.projectId, reason: 'Manual save', document: doc });
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
          headers: { 'content-type': contentType }
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
        await api.requestExport({ projectId: doc.projectId, bodyIds, format: 'stl' });
        setStatus('Exported STL from derived solid geometry.');
        return;
      }
      await kernel.exportStep(doc, bodyIds);
    } catch (error) {
      setStatus(errorMessage(error, `${format.toUpperCase()} export failed.`));
    }
  }

  async function handleGenerate() {
    const manager = managerRef.current;
    if (!manager || progress.running || !isReadyToGenerate(manager.document)) {
      return;
    }
    setActiveStep('generate');
    try {
      for (let index = 0; index < GENERATE_PHASES.length; index += 1) {
        setProgress({
          running: true,
          phase: GENERATE_PHASES[index]!,
          percent: Math.round(((index + 1) / (GENERATE_PHASES.length + 1)) * 100)
        });
        await delay(420);
      }
      const summary = runMockGenerativeStudy(manager.document);
      setRun(summary);
      setRunDocVersion(manager.document.version);
      setSelectedOutcomeId(summary.outcomes[0]?.id ?? null);
      setActiveStep('results');
      setStatus(`Generated ${summary.outcomes.length} outcomes (mock solver).`);
    } catch (error) {
      setStatus(errorMessage(error, 'Generative run failed.'));
    } finally {
      setProgress(IDLE_PROGRESS);
    }
  }

  function handleSelectBodyFromViewer(bodyId: string | null) {
    if (!bodyId) {
      setSelectedId(null);
      return;
    }
    const node = bodyNodes.find((body) => body.bodyId === bodyId);
    setSelectedId(node ? node.id : null);
  }

  function navigateStep(offset: -1 | 1): (() => void) | undefined {
    const index = WORKFLOW_STEP_IDS.indexOf(activeStep);
    const next = WORKFLOW_STEP_IDS[index + offset];
    if (!next || !canNavigateToStep(next, doc, run !== null)) {
      return undefined;
    }
    return () => setActiveStep(next);
  }

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

  const stepIndex = WORKFLOW_STEP_IDS.indexOf(activeStep) + 1;
  const meta = STEP_META[activeStep];
  const tone = progress.running
    ? 'running'
    : /fail|error|unable|denied/i.test(status)
      ? 'warning'
      : 'ready';

  const panelContent = (() => {
    switch (activeStep) {
      case 'model':
        return (
          <ModelPanel
            document={doc}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onPrimitive={handlePrimitive}
            onSketch={handleSketch}
            onExtrude={handleExtrude}
            onBoolean={handleBoolean}
            onTransform={handleTransform}
            onImportFile={(file) => void handleImportFile(file)}
            onExport={(format) => void handleExport(format)}
          />
        );
      case 'preserve':
        return (
          <PreservePanel
            bodies={bodyNodes}
            selectedNodeId={selectedId}
            preservedCount={counts.preserved}
            onSelect={setSelectedId}
            onSetRole={handleSetRole}
          />
        );
      case 'constraints':
        return (
          <ConstraintsPanel
            bodies={bodyNodes}
            selectedNodeId={selectedId}
            fixedCount={counts.fixed}
            obstacleCount={counts.obstacles}
            onSelect={setSelectedId}
            onSetRole={handleSetRole}
          />
        );
      case 'loads':
        return (
          <LoadsPanel
            bodies={bodyNodes}
            selectedNodeId={selectedId}
            loadedCount={counts.loaded}
            onSelect={setSelectedId}
            onSetLoad={handleSetLoad}
          />
        );
      case 'study':
        return <StudyPanel settings={studySettings} onApply={handleApplyStudy} />;
      case 'generate':
        return (
          <GeneratePanel
            readiness={readiness}
            progress={progress}
            lastRun={run}
            onGenerate={() => void handleGenerate()}
          />
        );
      case 'results':
        return (
          <ResultsPanel
            run={run}
            selectedOutcomeId={selectedOutcomeId}
            stale={runIsStale}
            onSelectOutcome={setSelectedOutcomeId}
            onExportStl={() => void handleExport('stl')}
          />
        );
    }
  })();

  return (
    <AppShell
      topBar={
        <TopBar
          projectName={doc.name}
          units={doc.units}
          activeStepTitle={meta.title}
          canUndo={managerRef.current?.canUndo ?? false}
          canRedo={managerRef.current?.canRedo ?? false}
          generating={progress.running}
          canGenerate={isReadyToGenerate(doc)}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onSave={() => void handleSave()}
          onGenerate={() => void handleGenerate()}
          onGoHome={() => void handleGoHome()}
        />
      }
      stepBar={
        <StepBar
          activeStep={activeStep}
          stepStates={stepStates}
          canNavigate={(step) => canNavigateToStep(step, doc, run !== null)}
          units={doc.units}
          solver="mock"
          onSelect={setActiveStep}
        />
      }
      viewer={
        <ViewerShell
          bodies={bodies}
          bodyRoles={bodyRoles}
          bodyLoads={bodyLoads}
          counts={counts}
          selectedBodyId={selectedBodyId}
          settings={viewerSettings}
          fitSignal={fitSignal}
          outcomePreviewScale={previewActive ? selectedOutcome.previewScale : null}
          previewOutcomeName={previewActive ? selectedOutcome.name : null}
          onSelectBody={handleSelectBodyFromViewer}
          onToggleGrid={() =>
            setViewerSettings((current) => ({ ...current, showGrid: !current.showGrid }))
          }
          onToggleLoads={() =>
            setViewerSettings((current) => ({ ...current, showLoads: !current.showLoads }))
          }
          onFit={() => setFitSignal((value) => value + 1)}
        />
      }
      contextPanel={
        <ContextPanel
          stepIndex={stepIndex}
          stepCount={WORKFLOW_STEP_IDS.length}
          title={meta.title}
          helper={meta.helper}
          onBack={navigateStep(-1)}
          onNext={navigateStep(1)}
        >
          {panelContent}
        </ContextPanel>
      }
      bottomPanel={
        run && (activeStep === 'generate' || activeStep === 'results') ? (
          <OutcomePanel
            run={run}
            selectedOutcomeId={selectedOutcome?.id ?? null}
            onSelectOutcome={(outcomeId) => {
              setSelectedOutcomeId(outcomeId);
              setActiveStep('results');
            }}
          />
        ) : undefined
      }
      statusBar={
        <StatusBar
          status={status}
          tone={tone}
          projectName={doc.name}
          bodyCount={counts.bodies}
          outcomeCount={run?.outcomes.length ?? 0}
          documentVersion={doc.version}
        />
      }
    />
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
