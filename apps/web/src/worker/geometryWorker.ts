import {
  ProjectionSender,
  projectionTransferables,
  type ProjectionPacket
} from '../lib/projectionStream';
import type { GeometryReadyState } from '@openzcad/shared';
import type { EditAnalysisRequest } from '@openzcad/shared';
import type {
  BodyId,
  FaceRecognitionSummary,
  ProjectDocument,
  ProjectId,
  SketchId,
  UnitSystem
} from '@openzcad/shared';
import type {
  BuildCancellationSignal,
  booleanEvolutionProbeNeeded,
  createExactKernelAdapter,
  DirectEditProfile,
  DrawingBodyTessellation,
  DrawingSectionBody,
  DrawingSectionPlane,
  DxfFaceSelector,
  ExactSectionPlane,
  MeshQualityReport,
  MassPropertiesRead,
  RebuildProgress,
  SectionOutlineReport,
  SketchPlanarOperation,
  SketchPlanarResult,
  SketchSolveAnchor,
  SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  ExactRebuildCache,
  LatestBroadcastGate,
  geometryContentKey,
  lineageDemandCacheKey,
  rebindSketchGeometryForContent
} from './exactRebuildCache';
import { GeometryWorkerQueue } from './geometryWorkerQueue';
import { geometryYield } from './geometryYield';
import { geometryProgress } from './geometryProgress';
import {
  derivedMeshTransferables,
  unpackWorkerRequest
} from '../lib/meshTransport';
import { resolveExactSourceBytes } from '../lib/exactSourceResolver';
import { workerRefusalOf, type WorkerRefusal } from '../lib/workerRefusal';
import { documentFontsArrived, preloadDocumentFonts } from '../lib/textFonts';

/**
 * `step`, `stl`, and `dxf` produce text (STEP data, ASCII STL, DXF R12);
 * `stl-binary`, `3mf`, `obj`, `glb`, and `ply` produce bytes. Mesh formats
 * accept a deflection in millimetres — chordal tolerance after unit
 * scaling — defaulting to the adapter's standard export tessellation when
 * omitted. `dxf` exports a 2D outline and requires either a `face` (one
 * planar face's outline) or a `section` plane (the exact cross-section).
 * `svg` draws one saved sketch's exact curves and requires a `sketchId`.
 */
export type GeometryExportFormat =
  'step' | 'stl' | 'dxf' | 'svg' | 'stl-binary' | '3mf' | 'obj' | 'glb' | 'ply';

/** The export formats whose payload crosses back as transferred bytes. */
export type GeometryBinaryExportFormat = Extract<
  GeometryExportFormat,
  'stl-binary' | '3mf' | 'obj' | 'glb' | 'ply'
>;

export type GeometryWorkerRequest =
  | {
      type: 'refine-edit-preview';
      document: ProjectDocument;
      requestId: string;
      generation: number;
      profile?: boolean;
    }
  | {
      type: 'release-edit-preview';
      document: ProjectDocument;
      requestId: string;
    }
  | {
      type: 'preview-geometry';
      document: ProjectDocument;
      requestId: string;
      deferTopology?: boolean;
      profile?: boolean;
      /** An edit's preview may propose carrying a hash-only selection. */
      proposeCarry?: boolean;
    }
  | {
      type: 'sync';
      document: ProjectDocument;
      requestId?: string;
      analysis?: EditAnalysisRequest;
      /**
       * Transient lineage demand: body ids whose producing booleans must
       * probe. Present (even empty) only on the viewport's idle broadcast,
       * which opts into skipping the probe for unreferenced booleans; absent
       * means full lineage. UI state only — never part of the document, never
       * part of `canonicalProjectContentKey`, only of the rebuild cache key
       * and the adapter's history digest.
       */
      lineageDemand?: BodyId[];
      forceFull?: boolean;
      profile?: boolean;
      /**
       * An edit's validation may propose carrying a hash-only selection the
       * edit stranded; see `ExactKernelAdapter.syncDocument`. Keyed apart in
       * the result cache, so a plain rebuild never receives a carried result.
       */
      proposeCarry?: boolean;
    }
  | {
      type: 'export';
      requestId: string;
      document: ProjectDocument;
      bodyIds: BodyId[];
      format: GeometryExportFormat;
      deflection?: number;
      /** Mesh formats: the largest facet angle on curved faces, radians. */
      angularTolerance?: number;
      /**
       * The unit to write where the format carries one or holds bare
       * numbers (STEP, DXF, STL, 3MF, OBJ, PLY). Millimetres when unset.
       */
      units?: UnitSystem;
      /** One 'dxf' source: the planar face whose outline to export. */
      face?: DxfFaceSelector;
      /** The other 'dxf' source: the plane whose exact section to export. */
      section?: ExactSectionPlane;
      /** The third 'dxf' source, and the only 'svg' one: the saved sketch. */
      sketchId?: SketchId;
      /** 'svg' only: false paints a white background behind the curves. */
      transparent?: boolean;
      /** 'step' only: the name the file is saved under, for its header. */
      fileName?: string;
    }
  | {
      /**
       * The exact, kernel-computed section at one plane. Requested when the
       * section plane comes to rest, never while it is being dragged: the
       * viewport's clipped preview owns the drag.
       */
      type: 'section';
      requestId: string;
      document: ProjectDocument;
      plane: ExactSectionPlane;
      /**
       * The bodies to section. The caller names them because hiding and
       * isolating are device-local view state the document does not carry;
       * omitted, the adapter falls back to the document's own visibility
       * and would section a body the viewport is not showing.
       */
      bodyIds?: BodyId[];
    }
  | {
      type: 'mesh-quality';
      requestId: string;
      document: ProjectDocument;
      bodyIds: BodyId[];
      deflection: number;
      angularTolerance?: number;
      /** The space the writer tessellates in; millimetres when unset. */
      units?: UnitSystem;
    }
  | {
      /**
       * D01 drawing projection input: each body meshed at its nominal
       * deflection in canonical order, independent of the display mesh's
       * held deflection, so a sheet draws the same lines however the model
       * was built (see the adapter's `drawingTessellation`).
       */
      type: 'drawing-tessellation';
      requestId: string;
      document: ProjectDocument;
      bodyIds: BodyId[];
      /**
       * D03: cut each body by this section plane first (the adapter's
       * `drawingSection`), keeping what lies behind it.
       */
      section?: DrawingSectionPlane;
    }
  | {
      /** Reads live mass data, restoring exact history for a stale cache hit. */
      type: 'mass-properties';
      requestId: string;
      document: ProjectDocument;
      bodyId: BodyId;
    }
  | {
      type: 'solve-sketch';
      requestId: string;
      document: ProjectDocument;
      sketchId: SketchId;
      anchor?: SketchSolveAnchor;
    }
  | {
      /** One planar sketch edit: corner fillet, corner chamfer, or offset. */
      type: 'sketch-2d-op';
      requestId: string;
      document: ProjectDocument;
      operation: SketchPlanarOperation;
    }
  | {
      /**
       * On-demand per-face recognition of one imported STEP face (Phase D of
       * the imported STEP edit plan). Runs the existing
       * `recognizeImportedFeature` module against the rebuilt document and
       * answers with the recognized kind + dimensions, or the typed refusal
       * reason. Display-only: no document state changes, and the result never
       * enters the rebuild payload — the caller caches it additively.
       */
      type: 'recognize-imported-face';
      requestId: string;
      document: ProjectDocument;
      bodyId: BodyId;
      /** ADR-011 face hash of the selected face. */
      faceHash: number;
      /** Rebuild-local face identity the pick was made against. */
      topologyId?: string;
    }
  | {
      /**
       * Abandon a caller-owned request. A job still queued is skipped
       * without executing or posting anything; a job already running
       * completes (wasm cannot be interrupted) and the main thread discards
       * its result. Without an id, abandon the live broadcast and its retries.
       */
      type: 'cancel';
      requestId?: string;
    }
  | {
      /**
       * The user is about to open a project: start fetching and compiling the
       * exact kernel now, so a cold start's download and compile overlap the
       * click instead of following it. Handled outside the queue, with no
       * reply; a failed load is retried by the next job that needs the kernel.
       */
      type: 'prepare-kernel';
    };

export type GeometryWorkerPhase =
  'starting' | 'loading-remus' | 'rebuilding' | 'ready' | 'failed';

export interface GeometryWorkerState {
  type: 'state';
  phase: GeometryWorkerPhase;
  projectId?: ProjectId;
  version?: number;
  requestId?: string;
  /** The UI should retain its last valid projection but not treat it as exact. */
  stale: boolean;
  error?: string;
  progress?: RebuildProgress;
}

/**
 * Result messages are tagged with the source document's identity so the main
 * thread can discard responses that no longer match the current document.
 */
export type GeometrySyncResult =
  | {
      type: 'sync';
      ok: true;
      projectId: ProjectId;
      version: number;
      requestId?: string;
      transient?: boolean;
      derived: ProjectDocument['derived'];
    }
  | {
      type: 'sync';
      ok: false;
      projectId: ProjectId;
      version: number;
      requestId?: string;
      error: string;
      /** The typed refusal behind the failure, when it was one. */
      refusal?: WorkerRefusal;
    };

export type GeometryExportResult =
  | {
      type: 'export';
      ok: true;
      requestId: string;
      format: 'step' | 'stl' | 'dxf' | 'svg';
      text: string;
      warnings: string[];
    }
  | {
      type: 'export';
      ok: true;
      requestId: string;
      format: GeometryBinaryExportFormat;
      /** Transferred, not copied — a fine mesh export can be tens of MB. */
      data: Uint8Array<ArrayBuffer>;
      warnings: string[];
    }
  | {
      type: 'export';
      ok: false;
      requestId: string;
      format: GeometryExportFormat;
      error: string;
    };

export type GeometryMeshQualityResult =
  | {
      type: 'mesh-quality';
      ok: true;
      requestId: string;
      report: MeshQualityReport;
    }
  | { type: 'mesh-quality'; ok: false; requestId: string; error: string };

export type GeometryDrawingTessellationResult =
  | {
      type: 'drawing-tessellation';
      ok: true;
      requestId: string;
      /** Transferred, not copied. */
      bodies: Record<BodyId, DrawingBodyTessellation | DrawingSectionBody>;
    }
  | {
      type: 'drawing-tessellation';
      ok: false;
      requestId: string;
      error: string;
    };

export type GeometryMassPropertiesResult =
  | {
      type: 'mass-properties';
      ok: true;
      requestId: string;
      result: MassPropertiesRead;
    }
  | { type: 'mass-properties'; ok: false; requestId: string; error: string };

export type GeometrySectionResult =
  | {
      type: 'section';
      ok: true;
      requestId: string;
      report: SectionOutlineReport;
    }
  | { type: 'section'; ok: false; requestId: string; error: string };

export type GeometrySolveSketchResult =
  | {
      type: 'solve-sketch';
      ok: true;
      requestId: string;
      outcome: SketchSolveOutcome;
    }
  | { type: 'solve-sketch'; ok: false; requestId: string; error: string };

export type GeometrySketch2dOpResult =
  | {
      type: 'sketch-2d-op';
      ok: true;
      requestId: string;
      result: SketchPlanarResult;
    }
  | { type: 'sketch-2d-op'; ok: false; requestId: string; error: string };

/**
 * Per-face recognition answer. The `summary` is the wire form of the shared
 * `FaceRecognitionSummary`: recognized kind + dimensions, or the typed
 * refusal reason with display copy. Callers key it by body + face identity;
 * a missing entry means "never queried", never "refused".
 */
export type GeometryRecognizeImportedFaceResult =
  | {
      type: 'recognize-imported-face';
      ok: true;
      requestId: string;
      bodyId: BodyId;
      faceHash: number;
      summary: FaceRecognitionSummary;
    }
  | {
      type: 'recognize-imported-face';
      ok: false;
      requestId: string;
      error: string;
    };

export type GeometryWorkerResult =
  | {
      type: 'direct-edit-profile';
      requestId?: string;
      operation: string;
      profile: DirectEditProfile;
    }
  | {
      type: 'preview-geometry';
      ok: true;
      requestId: string;
      geometry: GeometryReadyState;
      /** Worker-side durations, for drag tracing. */
      timings?: {
        queueMs: number;
        kernelMs: number;
        yields: number;
        yieldMs: number;
      };
    }
  | {
      type: 'preview-geometry';
      ok: false;
      requestId: string;
      error: string;
      /** The typed refusal behind the failure, when it was one. */
      refusal?: WorkerRefusal;
    }
  | {
      type: 'projection-delta';
      projectId: ProjectId;
      version: number;
      transient?: boolean;
      packet: ProjectionPacket;
    }
  | {
      type: 'geometry-ready';
      projectId: string;
      version: number;
      geometry: GeometryReadyState;
    }
  | {
      type: 'projection';
      projectId: string;
      version: number;
      derived: ProjectDocument['derived'];
    }
  | GeometryWorkerState
  | GeometrySyncResult
  | GeometryExportResult
  | GeometryMeshQualityResult
  | GeometryDrawingTessellationResult
  | GeometryMassPropertiesResult
  | GeometrySectionResult
  | GeometrySolveSketchResult
  | GeometrySketch2dOpResult
  | GeometryRecognizeImportedFaceResult;

type ExactKernel = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let exactKernelStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let exactKernelError: unknown;
let exactKernelPromise: Promise<ExactKernel | null> | null = null;
let booleanProbeNeeded: typeof booleanEvolutionProbeNeeded | undefined;
let rebuildMetrics: Record<string, number> = {};

/**
 * The kernel is a multi-megabyte wasm fetch plus compile; a stalled fetch
 * must fail the job (and clear the memoized promise so the next attempt
 * retries) rather than hang the queue forever.
 */
const KERNEL_LOAD_BUDGET_MS = 90_000;

function loadExactKernel(): Promise<ExactKernel | null> {
  if (exactKernelPromise) {
    return exactKernelPromise;
  }
  exactKernelStatus = 'loading';
  const attempt = import('@openzcad/kernel-adapter/exact').then((module) => {
    booleanProbeNeeded =
      'booleanEvolutionProbeNeeded' in module
        ? module.booleanEvolutionProbeNeeded
        : undefined;
    return module.createExactKernelAdapter({
      resolveSourceBytes: resolveExactSourceBytes,
      onRebuildCacheEvent: (event) => {
        rebuildMetrics = {
          replayedFeatures: event.replayed,
          restoredFeatures: event.restored,
          reusedPrimitives: event.reusedPrimitives ?? 0,
          measuredBodies: event.remeasured,
          reusedMeasurements: event.reusedMeasurements,
          ...(event.checkpointMemory
            ? {
                allocatedWasmBytes:
                  event.checkpointMemory.linearMemoryBytes ?? 0,
                estimatedCheckpointBytes: event.checkpointMemory.estimatedBytes,
                nextMutationEstimatedBytes:
                  event.checkpointMemory.nextMutationEstimatedBytes,
                uniqueNurbsBytes: event.checkpointMemory.uniqueNurbsBytes,
                retiredSlots: event.checkpointMemory.retiredSlots
              }
            : {}),
          ...(event.measurementCache
            ? {
                retainedMeasurementBytes: event.measurementCache.retainedBytes
              }
            : {})
        };
        if (import.meta.env.VITE_E2E === '1')
          console.debug('[geometry cache]', JSON.stringify(event));
      },
      ...(import.meta.env.VITE_E2E === '1'
        ? {
            measurementCacheDiagnostics: true
          }
        : {})
    });
  });
  // The budget losing the race leaves `attempt` pending; keep its eventual
  // rejection from surfacing as an unhandled one.
  attempt.catch(() => undefined);
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    budgetTimer = setTimeout(
      () => reject(new Error('The exact Remus kernel took too long to load.')),
      KERNEL_LOAD_BUDGET_MS
    );
  });
  exactKernelPromise = Promise.race([attempt, budget]).then(
    (adapter) => {
      clearTimeout(budgetTimer);
      exactKernelStatus = 'ready';
      return adapter;
    },
    (error: unknown) => {
      clearTimeout(budgetTimer);
      // A load failure is usually transient — the WASM chunk fetch lost a
      // network race. Clearing the memoized promise lets the next rebuild
      // or export attempt a fresh load instead of leaving this worker
      // permanently kernel-less until the page reloads. The failed status
      // and error stick around for messaging until a retry begins. The
      // budget above feeds this same path, so a stalled fetch also retries.
      exactKernelStatus = 'failed';
      exactKernelError = error;
      exactKernelPromise = null;
      return null;
    }
  );
  return exactKernelPromise;
}

/** Results the adapter says waited on a font face or source still to come. */
const transientResults = new WeakSet<object>();
const rebuildCache = new ExactRebuildCache<ProjectDocument['derived']>({
  maxEntries: 8,
  maxBytes: 32 * 1024 * 1024,
  maxInFlight: 4,
  cacheable: (derived) => !transientResults.has(derived)
});
const broadcastGate = new LatestBroadcastGate();
const projectionSender = new ProjectionSender();
let lastExactSyncKey: string | null = null;
let lastExactSyncEpoch: number | null = null;

/**
 * Every request that carries work; `cancel` and `prepare-kernel` are handled
 * before the queue.
 */
type GeometryWorkerWorkRequest = Exclude<
  GeometryWorkerRequest,
  { type: 'cancel' } | { type: 'prepare-kernel' }
>;

/**
 * The newest live broadcast, and whether its last completed rebuild waited
 * on this device's moment — a font face past its preload budget, a source
 * download that failed. That result was never cached; the broadcast re-runs
 * on bounded timers, once a face lands or the connection returns, so the
 * missing body appears without another edit. A recovery during the rebuild
 * is latched and re-runs it as soon as it completes; each live rebuild clears
 * both flags.
 */
let latestBroadcast: GeometryWorkerWorkRequest | null = null;
let broadcastAwaitsEnvironment = false;
let environmentRecovered = false;
const ENVIRONMENT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
let environmentRetry = 0;
let environmentRetryTimer: ReturnType<typeof setTimeout> | undefined;

function clearEnvironmentRetry(): void {
  clearTimeout(environmentRetryTimer);
  environmentRetryTimer = undefined;
}

function scheduleEnvironmentRetry(): void {
  const request = latestBroadcast;
  const delay = ENVIRONMENT_RETRY_DELAYS_MS[environmentRetry];
  if (!request || delay === undefined) return;
  environmentRetryTimer = setTimeout(() => {
    environmentRetryTimer = undefined;
    if (latestBroadcast === request && broadcastAwaitsEnvironment) {
      environmentRetry += 1;
      rerunLatestBroadcast();
    }
  }, delay);
}

function rerunLatestBroadcast(): void {
  clearEnvironmentRetry();
  broadcastAwaitsEnvironment = false;
  if (latestBroadcast)
    queue.enqueue({
      request: latestBroadcast,
      queuedAtMs: performance.now(),
      broadcastToken: broadcastGate.issue(true)
    });
}

function environmentRecovery(): void {
  environmentRecovered = true;
  if (broadcastAwaitsEnvironment) rerunLatestBroadcast();
}
self.ononline = environmentRecovery;

interface GeometryWorkerJob {
  refinementGeneration?: number;
  request: GeometryWorkerWorkRequest;
  requestId?: string;
  broadcastToken: number | null;
  queuedAtMs: number;
}

/**
 * Requests cancelled while still queued. Entries are consumed when the
 * skipped job surfaces, or cleared when a cancel raced a job that was
 * already running by the time it arrived.
 */
const cancelledRequests = new Set<string>();

/**
 * The rebuild-cache key a request's exact result is stored under. Two
 * requests with the same key receive the same derived state: the demand part
 * is the adapter's own boolean-probe decisions once the kernel module has
 * loaded (and the stricter raw demand before), so a demand that cannot
 * enrich lineage does not change it.
 */
function rebuildResultKey(
  request: GeometryWorkerWorkRequest,
  contentKey: string
): string {
  const sync = request.type === 'sync' ? request : undefined;
  return `${contentKey}${sync?.analysis ? `:analysis:${JSON.stringify(sync.analysis)}` : ''}${
    // Preserve the eager/lazy distinction when boolean probes can enrich
    // lineage. A model with no boolean has identical results in both modes.
    lineageDemandCacheKey(
      request.document,
      sync?.lineageDemand,
      booleanProbeNeeded
    )
  }${sync?.proposeCarry ? ':carry-proposal' : ''}`;
}

/**
 * The live broadcast rebuild in progress, by the result key it will fill.
 * Set once its key is known (after the kernel module loaded) and cleared when
 * the job ends.
 */
let runningBroadcast: {
  token: number;
  projectId: string;
  version: number;
  key: string;
} | null = null;

/**
 * Whether a newer broadcast asks for exactly the result the running live
 * rebuild will publish: same project version, same result key, no projection
 * recovery. Picking a face on the saved projection while a reopened project
 * is still replaying its history adds lineage demand for that body; when the
 * boolean probe decisions already cover it, superseding the build would
 * stop it at the next feature boundary and replay again from the last
 * history checkpoint, for an identical result. The newer request joins
 * the running build instead, which keeps its broadcast token and publishes
 * under the same project version the newer request names.
 */
function joinsRunningBroadcast(request: GeometryWorkerWorkRequest): boolean {
  const running = runningBroadcast;
  if (
    !running ||
    request.type !== 'sync' ||
    request.requestId ||
    request.forceFull ||
    !broadcastGate.isCurrent(running.token)
  )
    return false;
  const { document } = request;
  return (
    document.projectId === running.projectId &&
    document.version === running.version &&
    !isGeometryEmpty(document) &&
    rebuildResultKey(request, geometryContentKey(document)) === running.key
  );
}

function isGeometryEmpty(document: ProjectDocument): boolean {
  return document.featureOrder.length === 0 && document.bodyOrder.length === 0;
}

function emptyDerived(document: ProjectDocument): ProjectDocument['derived'] {
  return {
    bodyRepresentations: {},
    exportableBodyIds: [],
    warnings: [],
    updatedAt: document.derived.updatedAt
  };
}

function stateFor(
  phase: GeometryWorkerPhase,
  request: GeometryWorkerWorkRequest,
  options: Pick<GeometryWorkerState, 'stale' | 'error'>
): GeometryWorkerState {
  return {
    type: 'state',
    phase,
    projectId: request.document.projectId,
    version: request.document.version,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    stale: options.stale,
    ...(options.error ? { error: options.error } : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Geometry operation failed.';
}

/** Matches the adapter's standard export tessellation, in millimetres. */
const DEFAULT_EXPORT_DEFLECTION = 0.08;

async function execute(job: GeometryWorkerJob): Promise<void> {
  if (!broadcastGate.isCurrent(job.broadcastToken)) return;
  if (job.requestId && cancelledRequests.delete(job.requestId)) {
    return; // Cancelled while queued; the caller already dropped its promise.
  }
  const request = job.request;
  if (request.type === 'refine-edit-preview') {
    if (request.generation !== refinementGeneration) return;
    const exact =
      exactKernelStatus === 'ready' ? await exactKernelPromise : null;
    const finish = request.profile
      ? (await import('@openzcad/kernel-adapter/exact')).profileDirectEdits()
      : undefined;
    const started = request.profile ? performance.now() : 0;
    // This is mesh-cache warming only: no canonical journal or publication.
    try {
      if (await exact?.refineEditPreview?.(request.document))
        refinedPreviewKey = previewRefinementKey(request.document);
    } catch {
      /* A speculative miss must never become a modelling refusal. */
    } finally {
      if (finish) {
        performance.measure('oz:edit.refine', {
          start: started,
          end: performance.now()
        });
        self.postMessage({
          type: 'direct-edit-profile',
          operation: 'refine-edit-preview',
          requestId: request.requestId,
          profile: finish()
        } satisfies GeometryWorkerResult);
      }
    }
    return;
  }
  if (request.type === 'release-edit-preview') {
    refinedPreviewKey = undefined;
    const exact =
      exactKernelStatus === 'ready' ? await exactKernelPromise : null;
    exact?.releaseEditPreview?.();
    return;
  }
  const document = request.document;
  const workerStartedMs = performance.now();
  const queueMs = workerStartedMs - job.queuedAtMs;
  rebuildMetrics = {};
  let resultCacheHit = true;
  let transient = false;
  let forceFull = request.type === 'sync' && request.forceFull === true;
  const profiling = 'profile' in request && request.profile === true;
  let postMs = 0;
  let postCalls = 0;
  const post = (message: GeometryWorkerResult, transfer?: Transferable[]) => {
    if (!broadcastGate.isCurrent(job.broadcastToken)) {
      return;
    }
    const started = profiling ? performance.now() : 0;
    if (transfer && transfer.length > 0) {
      self.postMessage(message, { transfer });
    } else {
      self.postMessage(message);
    }
    if (profiling) {
      postMs += performance.now() - started;
      postCalls++;
    }
  };
  const finishProfile = profiling
    ? (await import('@openzcad/kernel-adapter/exact')).profileDirectEdits()
    : undefined;
  try {
    post(stateFor('starting', request, { stale: true }));

    if (request.type === 'preview-geometry') {
      if (exactKernelStatus !== 'ready')
        post(stateFor('loading-remus', request, { stale: true }));
      const exact = await loadExactKernel();
      if (!exact) {
        throw exactKernelError instanceof Error
          ? exactKernelError
          : new Error('The exact Remus kernel failed to load.');
      }
      await preloadDocumentFonts(document);
      post(stateFor('rebuilding', request, { stale: true }));
      const kernelStartedMs = performance.now();
      const yieldTask = geometryYield();
      let yields = 0;
      let yieldMs = 0;
      const geometry = await exact.previewGeometry(document, {
        deferTopology: request.deferTopology,
        ...(request.proposeCarry ? { proposeCarry: true } : {}),
        cancellation: {
          isCancelled: () => cancelledRequests.has(request.requestId)
        },
        yieldControl: () => {
          const pending = yieldTask();
          if (!pending) return;
          const started = performance.now();
          yields += 1;
          return pending.then(() => {
            yieldMs += performance.now() - started;
          });
        }
      });
      if (cancelledRequests.has(request.requestId)) return;
      // Geometry-only work has no completed result-cache entry or live mass
      // epoch. A release runs a full sync against its actual candidate.
      lastExactSyncKey = null;
      lastExactSyncEpoch = null;
      post(
        {
          type: 'preview-geometry',
          ok: true,
          requestId: request.requestId,
          geometry,
          timings: {
            queueMs,
            kernelMs: performance.now() - kernelStartedMs,
            yields,
            yieldMs
          }
        },
        derivedMeshTransferables(geometry)
      );
      post(stateFor('ready', request, { stale: false }));
      if (
        request.deferTopology &&
        exact.refineEditPreview &&
        refinedPreviewKey !== previewRefinementKey(document) &&
        job.refinementGeneration === refinementGeneration
      ) {
        const generation = job.refinementGeneration;
        clearTimeout(refinementTimer);
        refinementTimer = setTimeout(() => {
          refinementTimer = undefined;
          if (generation !== refinementGeneration) return;
          const requestId = `refine:${request.requestId}`;
          queue.enqueue({
            request: {
              type: 'refine-edit-preview',
              document,
              requestId,
              generation,
              profile: request.profile
            },
            requestId,
            queuedAtMs: performance.now(),
            broadcastToken: null
          });
        }, 150);
      }
      return;
    }

    if (request.type === 'mass-properties') {
      let result: MassPropertiesRead;
      if (
        !document.bodyOrder.includes(request.bodyId) ||
        isGeometryEmpty(document)
      ) {
        result = {
          status: 'unavailable',
          code: 'unsupported',
          reason: 'Mass properties are unavailable for this body.',
          epoch: null
        };
      } else {
        const key = geometryContentKey(document);
        if (exactKernelStatus !== 'ready')
          post(stateFor('loading-remus', request, { stale: true }));
        const exact = await loadExactKernel();
        if (!exact) {
          throw exactKernelError instanceof Error
            ? exactKernelError
            : new Error('The exact Remus kernel failed to load.');
        }
        // Preparing can replay the whole history; announce it so the host's
        // watchdog budgets a rebuild here, not a fifteen-second start.
        post(stateFor('rebuilding', request, { stale: true }));
        const prepare = async () => {
          await preloadDocumentFonts(document);
          const nextEpoch =
            await exact.prepareMassPropertiesForDocument(document);
          lastExactSyncKey = key;
          lastExactSyncEpoch = nextEpoch;
          return nextEpoch;
        };
        let epoch = exact.currentMassPropertiesEpoch();
        if (
          key !== lastExactSyncKey ||
          epoch === null ||
          epoch !== lastExactSyncEpoch
        ) {
          epoch = await prepare();
        }
        result = exact.readCurrentMassProperties({
          projectId: document.projectId,
          version: document.version,
          bodyId: request.bodyId,
          epoch
        });
        if (result.status === 'unavailable' && result.code === 'stale') {
          epoch = await prepare();
          result = exact.readCurrentMassProperties({
            projectId: document.projectId,
            version: document.version,
            bodyId: request.bodyId,
            epoch
          });
        }
      }
      post({
        type: 'mass-properties',
        ok: true,
        requestId: request.requestId,
        result
      });
      post(stateFor('ready', request, { stale: false }));
      return;
    }

    // The text fast path resolves faces synchronously, so every face this
    // document names has to be parsed before the rebuild reads it. A miss is
    // reported as a profile diagnostic rather than thrown, so this never
    // blocks the rest of the model on one unavailable font.
    if (!job.requestId) {
      broadcastAwaitsEnvironment = environmentRecovered = false;
    }
    await preloadDocumentFonts(document);
    // Watched from here, not from the result: a face that outlived the
    // budget may land while the rebuild is still running.
    if (!job.requestId) {
      void documentFontsArrived(document).then(
        (arrived) =>
          arrived &&
          broadcastGate.isCurrent(job.broadcastToken) &&
          environmentRecovery(),
        () => undefined
      );
    }

    if (
      request.type === 'export' ||
      request.type === 'mesh-quality' ||
      request.type === 'drawing-tessellation' ||
      request.type === 'section' ||
      request.type === 'solve-sketch' ||
      request.type === 'sketch-2d-op' ||
      request.type === 'recognize-imported-face'
    ) {
      // 'failed' means the next load call retries, so it is a loading state
      // here too, not a terminal one.
      if (exactKernelStatus !== 'ready') {
        post(stateFor('loading-remus', request, { stale: true }));
      }
      const exact = await loadExactKernel();
      if (!exact) {
        throw exactKernelError instanceof Error
          ? exactKernelError
          : new Error('The exact Remus kernel failed to load.');
      }
      post(stateFor('rebuilding', request, { stale: true }));
      if (request.type === 'sketch-2d-op') {
        const result = await exact.sketchPlanarOperation(request.operation);
        post({
          type: 'sketch-2d-op',
          ok: true,
          requestId: request.requestId,
          result
        });
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      if (request.type === 'recognize-imported-face') {
        // The face reference is resolved worker-side against the rebuilt
        // document: the main thread's pick carries rebuild-local identity
        // (hash + topology id) that only matches the live derived topology.
        const faceReference =
          request.topologyId !== undefined
            ? document.derived.bodyRepresentations[
                request.bodyId
              ]?.topology?.faces.find(
                (face) => face.topologyId === request.topologyId
              )?.reference
            : undefined;
        const summary = await exact.recognizeImportedFace({
          document,
          bodyId: request.bodyId,
          faceHash: request.faceHash,
          ...(faceReference?.kind === 'face' ? { faceReference } : {})
        });
        post({
          type: 'recognize-imported-face',
          ok: true,
          requestId: request.requestId,
          bodyId: request.bodyId,
          faceHash: request.faceHash,
          summary
        });
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      if (request.type === 'solve-sketch') {
        const outcome = request.anchor
          ? await exact.solveSketch(document, request.sketchId, {
              anchor: request.anchor
            })
          : await exact.solveSketch(document, request.sketchId);
        post({
          type: 'solve-sketch',
          ok: true,
          requestId: request.requestId,
          outcome
        });
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      if (request.type === 'section') {
        const report = await exact.sectionOutline(
          document,
          request.plane,
          request.bodyIds
        );
        post({
          type: 'section',
          ok: true,
          requestId: request.requestId,
          report
        });
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      if (request.type === 'drawing-tessellation') {
        const bodies = request.section
          ? await exact.drawingSection(
              document,
              request.bodyIds,
              request.section
            )
          : await exact.drawingTessellation(document, request.bodyIds);
        const transfer: ArrayBuffer[] = [];
        for (const body of Object.values(bodies)) {
          transfer.push(
            body.vertices.buffer as ArrayBuffer,
            body.indices.buffer as ArrayBuffer
          );
          for (const edge of body.edges)
            transfer.push(edge.buffer as ArrayBuffer);
        }
        post(
          {
            type: 'drawing-tessellation',
            ok: true,
            requestId: request.requestId,
            bodies
          },
          transfer
        );
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      if (request.type === 'mesh-quality') {
        const report = await exact.meshQuality(
          document,
          request.bodyIds,
          request.deflection,
          {
            ...(request.units ? { units: request.units } : {}),
            ...(request.angularTolerance !== undefined
              ? { angularTolerance: request.angularTolerance }
              : {})
          }
        );
        post({
          type: 'mesh-quality',
          ok: true,
          requestId: request.requestId,
          report
        });
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      if (request.format === 'dxf') {
        if (!request.face && !request.section && !request.sketchId) {
          throw new Error(
            'DXF export needs a face selection, a section plane, or a sketch.'
          );
        }
        const units = request.units ? { units: request.units } : {};
        const text = request.sketchId
          ? await exact.exportSketchDxf(document, request.sketchId, units)
          : request.section
            ? await exact.exportSectionDxf(
                document,
                request.section,
                // Same bodies as the section on screen. An empty selection
                // means the caller has nothing to narrow it by, so the
                // adapter's own document visibility stands.
                request.bodyIds.length > 0 ? request.bodyIds : undefined,
                units
              )
            : await exact.exportFaceDxf(document, request.face!, units);
        post({
          type: 'export',
          ok: true,
          requestId: request.requestId,
          format: 'dxf',
          text,
          warnings: []
        });
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      if (request.format === 'svg') {
        if (!request.sketchId) {
          throw new Error('SVG export needs a sketch.');
        }
        const text = await exact.exportSketchSvg(document, request.sketchId, {
          ...(request.transparent === false ? { transparent: false } : {})
        });
        post({
          type: 'export',
          ok: true,
          requestId: request.requestId,
          format: 'svg',
          text,
          warnings: []
        });
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      if (request.format !== 'step' && request.format !== 'stl') {
        const data = await exact.exportMesh(document, request.bodyIds, {
          format: request.format,
          deflection: request.deflection ?? DEFAULT_EXPORT_DEFLECTION,
          ...(request.units ? { units: request.units } : {}),
          ...(request.angularTolerance !== undefined
            ? { angularTolerance: request.angularTolerance }
            : {})
        });
        post(
          {
            type: 'export',
            ok: true,
            requestId: request.requestId,
            format: request.format,
            data,
            warnings: []
          },
          [data.buffer]
        );
        post(stateFor('ready', request, { stale: false }));
        return;
      }
      const text =
        request.format === 'step'
          ? await exact.exportStep(document, request.bodyIds, {
              ...(request.units ? { units: request.units } : {}),
              ...(request.fileName ? { fileName: request.fileName } : {})
            })
          : await exact.exportStl(
              document,
              request.bodyIds,
              request.deflection,
              {
                ...(request.units ? { units: request.units } : {}),
                ...(request.angularTolerance !== undefined
                  ? { angularTolerance: request.angularTolerance }
                  : {})
              }
            );
      const result: GeometryExportResult = {
        type: 'export',
        ok: true,
        requestId: request.requestId,
        format: request.format,
        text,
        warnings: []
      };
      post(result);
      post(stateFor('ready', request, { stale: false }));
      return;
    }

    const contentKey = isGeometryEmpty(document)
      ? null
      : geometryContentKey(document);
    // Resolve the decision function before the first result-cache key too.
    // The module is already resident for every subsequent drag/idle echo.
    let exactForSync: ExactKernel | null = null;
    if (contentKey !== null) {
      if (exactKernelStatus !== 'ready')
        post(stateFor('loading-remus', request, { stale: true }));
      exactForSync = await loadExactKernel();
    }
    const resultKey =
      contentKey === null ? null : rebuildResultKey(request, contentKey);
    if (
      resultKey !== null &&
      request.type === 'sync' &&
      job.broadcastToken !== null
    )
      runningBroadcast = {
        token: job.broadcastToken,
        projectId: document.projectId,
        version: document.version,
        key: resultKey
      };
    const cachedDerived =
      resultKey === null
        ? emptyDerived(document)
        : await rebuildCache.get(resultKey, async () => {
            resultCacheHit = false;
            // 'failed' retries on the next load call, so it counts as a
            // loading state here too.
            if (exactKernelStatus !== 'ready') {
              post(stateFor('loading-remus', request, { stale: true }));
            }
            const exact = exactForSync;
            if (!exact) {
              throw exactKernelError instanceof Error
                ? exactKernelError
                : new Error('The exact Remus kernel failed to load.');
            }
            if (!broadcastGate.isCurrent(job.broadcastToken)) {
              throw new Error('Superseded geometry broadcast.');
            }
            post(stateFor('rebuilding', request, { stale: true }));
            // A superseded rebuild stops at the next feature boundary (a
            // running WASM call still completes); the adapter rejects typed
            // and commits nothing, and the gate below drops anything stale.
            const cancellation: BuildCancellationSignal = {
              isCancelled: () =>
                (job.requestId
                  ? cancelledRequests.has(job.requestId)
                  : false) || !broadcastGate.isCurrent(job.broadcastToken)
            };
            const result = await exact.syncDocument(
              document,
              geometryProgress((progress) => {
                if (!broadcastGate.isCurrent(job.broadcastToken)) return;
                post({
                  ...stateFor('rebuilding', request, { stale: true }),
                  progress
                });
              }),
              request.requestId
                ? undefined
                : (projection) => {
                    if (!broadcastGate.isCurrent(job.broadcastToken)) return;
                    post({
                      type: 'projection',
                      projectId: document.projectId,
                      version: document.version,
                      derived: projection
                    });
                  },
              request.type === 'sync' ? request.analysis : undefined,
              {
                cancellation,
                ...(!request.requestId
                  ? {
                      onGeometryReady: (geometry: GeometryReadyState) => {
                        if (!broadcastGate.isCurrent(job.broadcastToken))
                          return;
                        const encodingStartedMs = performance.now();
                        const packet = projectionSender.encode(
                          document.projectId,
                          geometry,
                          forceFull
                        );
                        forceFull = false;
                        packet.metrics = {
                          queueMs,
                          resultCacheHit: 0,
                          encodingMs: performance.now() - encodingStartedMs,
                          workerMs: performance.now() - workerStartedMs
                        };
                        post(
                          {
                            type: 'projection-delta',
                            projectId: document.projectId,
                            version: document.version,
                            packet
                          },
                          projectionTransferables(packet)
                        );
                      }
                    }
                  : {}),
                yieldControl: geometryYield(),
                ...(request.type === 'sync' && request.lineageDemand
                  ? { lineageDemand: request.lineageDemand }
                  : {}),
                ...(request.type === 'sync' && request.proposeCarry
                  ? { proposeCarry: true }
                  : {})
              }
            );
            if (exact.hasTransientFailures(result)) {
              transientResults.add(result);
              transient = true;
            }
            // A carry proposal built a kernel state a plain build of the
            // same content would not (a carried selection), so mass
            // properties must not read it as that content's: they prepare
            // again from a plain build, as after a preview.
            if (request.type === 'sync' && request.proposeCarry) {
              lastExactSyncKey = null;
              lastExactSyncEpoch = null;
            } else {
              lastExactSyncKey = contentKey;
              lastExactSyncEpoch = exact.currentMassPropertiesEpoch();
            }
            return result;
          });
    const derived =
      contentKey === null
        ? cachedDerived
        : rebindSketchGeometryForContent(document, cachedDerived, contentKey);
    if (!broadcastGate.isCurrent(job.broadcastToken)) {
      return;
    }
    const result: GeometrySyncResult = {
      type: 'sync',
      ok: true,
      projectId: document.projectId,
      version: document.version,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(transient ? { transient: true } : {}),
      derived
    };
    if (request.requestId) {
      post(result, derivedMeshTransferables(derived));
    } else {
      const encodingStartedMs = performance.now();
      const packet = projectionSender.encode(
        document.projectId,
        derived,
        forceFull
      );
      packet.metrics = {
        ...rebuildMetrics,
        queueMs,
        resultCacheHit: resultCacheHit ? 1 : 0,
        encodingMs: performance.now() - encodingStartedMs,
        workerMs: performance.now() - workerStartedMs
      };
      post(
        {
          type: 'projection-delta',
          projectId: document.projectId,
          version: document.version,
          ...(transient ? { transient: true } : {}),
          packet
        },
        projectionTransferables(packet)
      );
      if (transient && environmentRecovered) rerunLatestBroadcast();
      else {
        broadcastAwaitsEnvironment = transient;
        if (transient) scheduleEnvironmentRetry();
      }
    }
    post(stateFor('ready', request, { stale: transient }));
  } catch (error) {
    if (!broadcastGate.isCurrent(job.broadcastToken)) {
      return;
    }
    // Cancelled while running: the caller already dropped its promise and
    // the job that superseded it reports its own state, so a typed
    // cancellation is not a failure to surface.
    if (
      job.requestId &&
      cancelledRequests.has(job.requestId) &&
      (error as { category?: unknown } | null)?.category === 'cancelled'
    ) {
      return;
    }
    const message = errorMessage(error);
    // A refusal keeps its code across the boundary; see `workerRefusal.ts`.
    const refusal = workerRefusalOf(error);
    if (request.type === 'preview-geometry') {
      post({
        type: 'preview-geometry',
        ok: false,
        requestId: request.requestId,
        error: message,
        ...(refusal ? { refusal } : {})
      });
    } else if (request.type === 'export') {
      const result: GeometryExportResult = {
        type: 'export',
        ok: false,
        requestId: request.requestId,
        format: request.format,
        error: message
      };
      post(result);
    } else if (request.type === 'mass-properties') {
      post({
        type: 'mass-properties',
        ok: false,
        requestId: request.requestId,
        error: message
      });
    } else if (request.type === 'mesh-quality') {
      post({
        type: 'mesh-quality',
        ok: false,
        requestId: request.requestId,
        error: message
      });
    } else if (request.type === 'drawing-tessellation') {
      post({
        type: 'drawing-tessellation',
        ok: false,
        requestId: request.requestId,
        error: message
      });
    } else if (request.type === 'section') {
      post({
        type: 'section',
        ok: false,
        requestId: request.requestId,
        error: message
      });
    } else if (request.type === 'solve-sketch') {
      post({
        type: 'solve-sketch',
        ok: false,
        requestId: request.requestId,
        error: message
      });
    } else if (request.type === 'sketch-2d-op') {
      post({
        type: 'sketch-2d-op',
        ok: false,
        requestId: request.requestId,
        error: message
      });
    } else if (request.type === 'recognize-imported-face') {
      post({
        type: 'recognize-imported-face',
        ok: false,
        requestId: request.requestId,
        error: message
      });
    } else {
      const result: GeometrySyncResult = {
        type: 'sync',
        ok: false,
        projectId: document.projectId,
        version: document.version,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        error: message,
        ...(refusal ? { refusal } : {})
      };
      post(result);
    }
    post(stateFor('failed', request, { stale: true, error: message }));
    // A translator chunk can fail before a rebuild returns any transient
    // projection. Keep that live document recoverable without treating a
    // source parse or ordinary modeling refusal as an environmental miss.
    if (
      !job.requestId &&
      (error as { category?: unknown } | null)?.category === 'environment-load'
    ) {
      if (environmentRecovered) rerunLatestBroadcast();
      else {
        broadcastAwaitsEnvironment = true;
        scheduleEnvironmentRetry();
      }
    }
  } finally {
    if (runningBroadcast?.token === job.broadcastToken) runningBroadcast = null;
    if (finishProfile) {
      const profile = finishProfile();
      profile.stages.workerPost = { calls: postCalls, ms: postMs };
      profile.stages.workerQueue = { calls: 1, ms: queueMs };
      post({
        type: 'direct-edit-profile',
        operation: request.type,
        ...(job.requestId ? { requestId: job.requestId } : {}),
        profile
      });
    }
    // A cancel that raced a job already running leaves its entry behind;
    // sweep it so the set cannot grow across a long session.
    if (job.requestId) {
      cancelledRequests.delete(job.requestId);
    }
  }
}

const queue = new GeometryWorkerQueue<GeometryWorkerJob>(execute);
let refinementGeneration = 0;
let refinementTimer: ReturnType<typeof setTimeout> | undefined;
let refinedPreviewKey: string | undefined;
function previewRefinementKey(document: ProjectDocument): string {
  // Candidate feature IDs can be regenerated on every pointer frame. The
  // source history identifies the gesture; warming unchanged faces once is
  // enough, and repeated synchronous warm-ups would stall the next pointer.
  return `${document.projectId}:${document.featureOrder.slice(0, -1).join(',')}`;
}

self.onmessage = (event: MessageEvent<GeometryWorkerRequest>) => {
  // Not input: preparing the kernel must not cancel a queued warm-up.
  if (event.data.type === 'prepare-kernel') {
    void loadExactKernel();
    return;
  }
  // Any newer input cancels a queued warm-up. A synchronous WASM tessellation
  // already running completes; never accumulate obsolete warm-up frames.
  clearTimeout(refinementTimer);
  refinementTimer = undefined;
  refinementGeneration++;
  // Unpack before anything reads the document: every consumer past this point
  // — the rebuild, the cache key, the history digest — expects plain arrays.
  const request = unpackWorkerRequest(event.data);
  if (request.type === 'cancel') {
    if (request.requestId !== undefined)
      cancelledRequests.add(request.requestId);
    else {
      clearEnvironmentRetry();
      latestBroadcast = null;
      broadcastAwaitsEnvironment = environmentRecovered = false;
      broadcastGate.issue(true);
    }
    return;
  }
  const isBroadcast = request.type === 'sync' && !request.requestId;
  if (isBroadcast && joinsRunningBroadcast(request)) {
    // The running build answers this request; its retry bookkeeping stays
    // with it, and a retry re-runs the newest (equivalent) request.
    latestBroadcast = request;
    // Session-local diagnostic beside the host's `[geometry rebuild]` lines;
    // identifiers only, no document contents.
    console.debug(
      '[geometry broadcast]',
      JSON.stringify({
        projectId: request.document.projectId,
        version: request.document.version,
        joinedRunningRebuild: true
      })
    );
    return;
  }
  if (isBroadcast) {
    clearEnvironmentRetry();
    environmentRetry = 0;
    broadcastAwaitsEnvironment = environmentRecovered = false;
    latestBroadcast = request;
  }
  queue.enqueue({
    request,
    refinementGeneration,
    queuedAtMs: performance.now(),
    ...(request.requestId ? { requestId: request.requestId } : {}),
    broadcastToken: broadcastGate.issue(isBroadcast)
  });
};

export {};
