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
  estimateStructuredBytes,
  ExactSectionPlane,
  isPersistedHistorySession,
  kernelSnapshotBuildId,
  MeshQualityReport,
  MassPropertiesRead,
  PersistedHistorySession,
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
  rebindSketchGeometryForContent,
  cloneDerivedSharingBodyGeometry
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
import { KERNEL_BUILD } from '../lib/kernelBuild';
import {
  kernelSessionIdentity,
  rejectKernelSession,
  loadKernelSession,
  saveKernelSession,
  touchKernelSession
} from '../lib/kernelSessionStore';
import { KernelSessionPersistence } from './kernelSessionPersistence';

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
      /**
       * Worker-internal: re-runs a completed `sync` whose result drew a
       * released edit's body with its draft display mesh, so the adapter
       * swaps in the full-quality mesh. Never posted by the main thread.
       */
      type: 'refine-committed-display';
      document: ProjectDocument;
      requestId: string;
      sync: Extract<GeometryWorkerRequest, { type: 'sync' }>;
    }
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
      /**
       * The live broadcast of a document this device keeps as the current
       * user's own local project: only then does the worker offer it a
       * persisted kernel session or capture one of it. Unset (a shared
       * link's model, someone else's project, any one-off rebuild) means
       * neither, and a broadcast without it drops any scheduled capture.
       */
      persistSession?: boolean;
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
    }
  | {
      /**
       * The main thread adopted a checked result as the live state without
       * a broadcast (`adoptValidatedResult`): only a draft display of this
       * content may still be refined. Handled outside the queue, with no
       * reply, and never cancels idle work of the same content.
       */
      type: 'live-content';
      projectId: ProjectId;
      /** `geometryContentKey` of the adopted document. */
      contentKey: string;
    }
  | {
      /**
       * Whether the live project may persist its kernel session changed
       * without its geometry changing (the app learned who owns it, or a
       * shared link of the same revision opened): the broadcast's
       * `persistSession`, applied to the project already live instead of
       * re-posting the document for a rebuild. False drops any scheduled
       * capture and warm-up and fences a running capture; true lets the
       * live result be captured once idle. Handled outside the queue, with
       * no reply, and never cancels idle work.
       */
      type: 'session-policy';
      projectId: ProjectId;
      persistSession: boolean;
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
      /**
       * The full-quality display of a result that drew a released edit's
       * body with its draft mesh. Identical to that result apart from the
       * display mesh, face triangle ranges and mesh-tightened box.
       */
      type: 'display-refined';
      projectId: ProjectId;
      version: number;
      /** `geometryContentKey` of the document this result was built for. */
      contentKey: string;
      derived: ProjectDocument['derived'];
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
/** Persisted-session helpers from the loaded adapter module. */
let sessionModule:
  | {
      estimateStructuredBytes: typeof estimateStructuredBytes;
      isPersistedHistorySession: typeof isPersistedHistorySession;
      kernelSnapshotBuildId: typeof kernelSnapshotBuildId;
    }
  | undefined;
/** What the adapter made of the session offered to the running sync. */
let lastSessionRestore: 'restored' | 'rejected' | undefined;

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
    sessionModule = module;
    return module.createExactKernelAdapter({
      resolveSourceBytes: resolveExactSourceBytes,
      // Unchanged bodies keep their buffer identity from sync to sync, so the
      // projection diff and the result cache skip them; see
      // `cloneDerivedSharingBodyGeometry` for the immutability this needs.
      shareRetainedMeasurements: true,
      onRebuildCacheEvent: (event) => {
        if (event.sessionRestore) lastSessionRestore = event.sessionRestore;
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
  clone: cloneDerivedSharingBodyGeometry,
  // A draft display is published once and refined, never served again.
  cacheable: (derived) =>
    !transientResults.has(derived) && !hasDraftDisplay(derived)
});
const broadcastGate = new LatestBroadcastGate();
const projectionSender = new ProjectionSender();

/**
 * Persisted kernel sessions: a reopened project restores its history kernel
 * instead of replaying it (see `kernelSessionPersistence.ts`). Off in dev
 * servers, whose app commit does not name the code that is running.
 */
const kernelSessions = new KernelSessionPersistence({
  identity: () =>
    import.meta.env.DEV || !sessionModule
      ? null
      : kernelSessionIdentity({
          appCommit: import.meta.env.OZ_BUILD_COMMIT,
          remusVersion: KERNEL_BUILD.packageVersion,
          remusCommit: KERNEL_BUILD.sourceCommit,
          kernelBuildId: sessionModule.kernelSnapshotBuildId()
        }),
  load: loadKernelSession,
  save: saveKernelSession,
  reject: rejectKernelSession,
  touch: touchKernelSession,
  isSession: (value): value is PersistedHistorySession =>
    sessionModule?.isPersistedHistorySession(value) ?? false,
  estimateBytes: (session) =>
    sessionModule?.estimateStructuredBytes(session) ?? Number.POSITIVE_INFINITY,
  workSerial: () => workRequestSerial,
  yieldControl: () => geometryYield(),
  now: () => performance.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) =>
    clearTimeout(timer as ReturnType<typeof setTimeout> | undefined),
  ...(import.meta.env.VITE_E2E === '1'
    ? {
        report: (event) =>
          console.debug('[kernel session]', JSON.stringify(event))
      }
    : {})
});
let lastExactSyncKey: string | null = null;
let lastExactSyncEpoch: number | null = null;

/**
 * Whether the live project may persist its kernel session: the newest
 * broadcast's `persistSession`, updated in place by `session-policy`.
 * Fail-closed: null (nothing live, or not told) persists nothing, and only
 * the project it names is offered a session or captured.
 */
let liveSessionPolicy: { projectId: ProjectId; persist: boolean } | null = null;
function persistsLiveSession(projectId: ProjectId): boolean {
  return (
    liveSessionPolicy?.projectId === projectId && liveSessionPolicy.persist
  );
}
/**
 * The live, complete result a capture would take (never a draft display or
 * a transient result), whatever the policy: a `session-policy` that turns
 * persistence on schedules it without another rebuild.
 */
let liveCapturable: {
  exact: ExactKernel;
  document: ProjectDocument;
  contentKey: string;
  lineageDemand: readonly BodyId[] | undefined;
} | null = null;
function noteLiveCapturable(next: typeof liveCapturable): void {
  liveCapturable = next;
  if (next && persistsLiveSession(next.document.projectId)) {
    kernelSessions.schedule(next.exact, next.document, next.contentKey);
    kernelSessions.scheduleWarmup(
      next.exact,
      next.document,
      next.lineageDemand
    );
  }
}

/**
 * Every request that carries work; `cancel` and `prepare-kernel` are handled
 * before the queue.
 */
type GeometryWorkerWorkRequest = Exclude<
  GeometryWorkerRequest,
  | { type: 'cancel' }
  | { type: 'prepare-kernel' }
  | { type: 'live-content' }
  | { type: 'session-policy' }
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
  /** Its `persistSession`: a joining request must ask the same. */
  persistSession: boolean;
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
    (request.persistSession === true) === running.persistSession &&
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
  if (request.type === 'refine-committed-display') {
    if (await refineCommittedDisplay(request)) armDisplayRefinement();
    return;
  }
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
    // The gesture that held refinement back has ended.
    armDisplayRefinement();
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
        // Own entries only (inline, to keep this chunk within its budget):
        // a body id such as "__proto__" must not resolve an inherited member.
        const representations = document.derived.bodyRepresentations;
        const faceReference =
          request.topologyId !== undefined &&
          typeof request.bodyId === 'string' &&
          Object.hasOwn(representations, request.bodyId)
            ? representations[request.bodyId]?.topology?.faces.find(
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
        key: resultKey,
        persistSession: request.persistSession === true
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
            // A reopened project's stored session, when this worker's
            // history kernel does not hold the project yet.
            const persistedSession =
              request.type === 'sync' &&
              !request.requestId &&
              persistsLiveSession(document.projectId) &&
              !request.analysis &&
              !request.proposeCarry
                ? await kernelSessions.offer(exact, document, contentKey!)
                : undefined;
            lastSessionRestore = undefined;
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
                  : {}),
                ...(persistedSession ? { persistedSession } : {})
              }
            );
            if (persistedSession)
              kernelSessions.noteOutcome(
                document.projectId,
                contentKey!,
                lastSessionRestore
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
      // The body buffers are shared with the result cache and the adapter's
      // retained measurements: transfer a copy, made here rather than on the
      // receiving main thread.
      const owned = structuredClone(result);
      post(owned, derivedMeshTransferables(owned.derived));
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
    if (request.type === 'sync')
      noteDisplayRefinement(request, derived, job.broadcastToken);
    // The live model at rest: persist its kernel session once idle, and
    // warm a restored kernel with this document, if the live policy allows
    // (`persistsLiveSession`; it may also allow it later). A draft waits for its
    // refinement, which schedules both; it, and a transient result, drop the
    // warm-up target so an older revision is never replayed in its place.
    if (request.type === 'sync' && !request.requestId) {
      if (
        !transient &&
        contentKey !== null &&
        exactForSync &&
        !hasDraftDisplay(cachedDerived)
      )
        noteLiveCapturable({
          exact: exactForSync,
          document,
          contentKey,
          lineageDemand: request.lineageDemand
        });
      else {
        liveCapturable = null;
        kernelSessions.dropWarmup();
      }
    }
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
    // A drag's frames say a gesture is under way: no idle work behind them.
    if (request.type !== 'preview-geometry') armDisplayRefinement();
  }
}

function hasDraftDisplay(derived: ProjectDocument['derived']): boolean {
  return Object.values(derived.bodyRepresentations).some(
    (body) => body.displayQuality === 'draft'
  );
}

/**
 * A result that drew a released edit's body with its draft display mesh
 * (see `exact-display-refinement.ts`), still waiting for its full-quality
 * display.
 */
interface PendingDisplayRefinement {
  sync: Extract<GeometryWorkerRequest, { type: 'sync' }>;
  broadcastToken: number | null;
  projectId: ProjectId;
  contentKey: string;
  /**
   * Whether the main thread shows it: a broadcast's result always, a checked
   * release's once the main thread adopts it (`live-content`). Only a live
   * draft is refined; re-syncing anything else would rewind the history
   * kernel away from what is on screen.
   */
  live: boolean;
  /** Not before then: a different checked result awaits its adoption. */
  heldUntilMs: number;
  /** Refinements that failed other than by cancellation; one retry. */
  failures: number;
}

/**
 * Drafts waiting for refinement, newest first: at most the live one and a
 * newer release not adopted yet. Whatever the main thread reports live
 * (`live-content`, a broadcast) keeps only the draft of that content; a
 * broadcast's own result, never a draft, settles them all.
 *
 * Refinement is idle work. It is queued only once the worker has been idle
 * for {@link DISPLAY_REFINEMENT_IDLE_MS} and no drag is under way, never as
 * a broadcast (the live state stays ready), and any new request cancels it
 * at the next build boundary; it then waits for the next idle moment. The
 * release it refines was accepted already, so nothing the user does next
 * waits behind it.
 */
let pendingDisplayRefinements: PendingDisplayRefinement[] = [];
const DISPLAY_REFINEMENT_IDLE_MS = 100;
/**
 * How long a completed checked sync of other content holds a live draft's
 * refinement back: the main thread adopts a release within a frame or two,
 * and that adoption retires the draft. Anything else (a copy, an analysis)
 * is never adopted, and the draft is refined once the hold lapses.
 */
const DISPLAY_REFINEMENT_ADOPTION_HOLD_MS = 1_000;
/**
 * How long after its last frame a drag still holds refinement back. A
 * released or cancelled cylinder drag says it ended; a cancelled face drag
 * does not, so the hold lapses on its own.
 */
const DISPLAY_REFINEMENT_GESTURE_HOLD_MS = 1_000;
let displayRefinementTimer: ReturnType<typeof setTimeout> | undefined;
/** When the drag under way last sent a frame; null once it has ended. */
let previewGestureFrameAtMs: number | null = null;
/** Counts work requests, so idle work can tell it has been overtaken. */
let workRequestSerial = 0;

function noteDisplayRefinement(
  sync: Extract<GeometryWorkerRequest, { type: 'sync' }>,
  derived: ProjectDocument['derived'],
  broadcastToken: number | null
): void {
  const projectId = sync.document.projectId;
  if (hasDraftDisplay(derived)) {
    const contentKey = geometryContentKey(sync.document);
    pendingDisplayRefinements = [
      {
        sync,
        broadcastToken,
        projectId,
        contentKey,
        live: !sync.requestId,
        heldUntilMs: 0,
        failures: 0
      },
      ...pendingDisplayRefinements.filter(
        (entry) =>
          entry.live &&
          !(entry.projectId === projectId && entry.contentKey === contentKey)
      )
    ].slice(0, 2);
  } else if (!sync.requestId) {
    // A broadcast's build is never a draft: the adapter refined the measured
    // body, or the document moved on.
    pendingDisplayRefinements = [];
  } else if (pendingDisplayRefinements.length > 0) {
    // A checked result of other content may be adopted next, which would
    // retire every draft here; refining one now would rewind the history
    // kernel away from it.
    const contentKey = geometryContentKey(sync.document);
    const heldUntilMs = performance.now() + DISPLAY_REFINEMENT_ADOPTION_HOLD_MS;
    for (const entry of pendingDisplayRefinements)
      if (entry.projectId !== projectId || entry.contentKey !== contentKey)
        entry.heldUntilMs = heldUntilMs;
  }
}

/** The main thread shows this content now (null: nothing). */
function noteLiveContent(
  live: { projectId: ProjectId; contentKey: string } | null
): void {
  pendingDisplayRefinements = pendingDisplayRefinements.filter((entry) => {
    const current =
      live !== null &&
      entry.projectId === live.projectId &&
      entry.contentKey === live.contentKey;
    if (current) {
      entry.live = true;
      entry.heldUntilMs = 0;
    }
    return current;
  });
}

function nextDisplayRefinement(): PendingDisplayRefinement | undefined {
  return pendingDisplayRefinements.find((entry) => entry.live);
}

function armDisplayRefinement(): void {
  const pending = nextDisplayRefinement();
  if (!pending || displayRefinementTimer !== undefined) return;
  const now = performance.now();
  const delay = Math.max(
    DISPLAY_REFINEMENT_IDLE_MS,
    pending.heldUntilMs - now,
    previewGestureFrameAtMs === null
      ? 0
      : previewGestureFrameAtMs + DISPLAY_REFINEMENT_GESTURE_HOLD_MS - now
  );
  const serial = workRequestSerial;
  displayRefinementTimer = setTimeout(() => {
    displayRefinementTimer = undefined;
    // Overtaken: the job that just arrived re-arms when it finishes.
    if (serial !== workRequestSerial) return;
    const next = nextDisplayRefinement();
    if (!next) return;
    if (!broadcastGate.isCurrent(next.broadcastToken)) {
      pendingDisplayRefinements = pendingDisplayRefinements.filter(
        (entry) => entry !== next
      );
      armDisplayRefinement();
      return;
    }
    const at = performance.now();
    if (
      next.heldUntilMs > at ||
      (previewGestureFrameAtMs !== null &&
        previewGestureFrameAtMs + DISPLAY_REFINEMENT_GESTURE_HOLD_MS > at)
    ) {
      armDisplayRefinement();
      return;
    }
    previewGestureFrameAtMs = null;
    const requestId = `refine-display:${crypto.randomUUID()}`;
    queue.enqueue({
      request: {
        type: 'refine-committed-display',
        document: next.sync.document,
        requestId,
        sync: next.sync
      },
      requestId,
      queuedAtMs: performance.now(),
      broadcastToken: null
    });
  }, delay);
}

/**
 * Runs one refinement. Resolves whether to arm the next idle moment: not
 * after a cancellation nothing new caused (the draft was retired), since
 * that would only spin.
 */
async function refineCommittedDisplay(
  request: Extract<GeometryWorkerRequest, { type: 'refine-committed-display' }>
): Promise<boolean> {
  const pending = pendingDisplayRefinements.find(
    (entry) => entry.sync === request.sync
  );
  if (!pending?.live) return true;
  const exact = exactKernelStatus === 'ready' ? await exactKernelPromise : null;
  if (!exact) return false;
  const { sync } = request;
  const document = sync.document;
  const contentKey = pending.contentKey;
  const serial = workRequestSerial;
  const retired = () => !pendingDisplayRefinements.includes(pending);
  try {
    const refined = await rebuildCache.get(
      rebuildResultKey(sync, contentKey),
      async () => {
        const result = await exact.syncDocument(
          document,
          undefined,
          undefined,
          sync.analysis,
          {
            cancellation: {
              isCancelled: () =>
                serial !== workRequestSerial ||
                retired() ||
                !broadcastGate.isCurrent(pending.broadcastToken)
            },
            yieldControl: geometryYield(),
            displayRefinement: true,
            ...(sync.lineageDemand
              ? { lineageDemand: sync.lineageDemand }
              : {}),
            ...(sync.proposeCarry ? { proposeCarry: true } : {})
          }
        );
        if (exact.hasTransientFailures(result)) transientResults.add(result);
        // The same bookkeeping as the sync it refines.
        if (sync.proposeCarry) {
          lastExactSyncKey = null;
          lastExactSyncEpoch = null;
        } else {
          lastExactSyncKey = contentKey;
          lastExactSyncEpoch = exact.currentMassPropertiesEpoch();
        }
        return result;
      }
    );
    if (retired()) return true;
    pendingDisplayRefinements = pendingDisplayRefinements.filter(
      (entry) => entry !== pending
    );
    if (
      hasDraftDisplay(refined) ||
      !broadcastGate.isCurrent(pending.broadcastToken)
    )
      return true;
    // Body buffers are shared with the result cache and the adapter's
    // retained measurements (see `cloneDerivedSharingBodyGeometry`):
    // transfer a copy, never them.
    const derived = structuredClone(
      rebindSketchGeometryForContent(document, refined, contentKey)
    );
    self.postMessage(
      {
        type: 'display-refined',
        projectId: document.projectId,
        version: document.version,
        contentKey,
        derived
      } satisfies GeometryWorkerResult,
      { transfer: derivedMeshTransferables(derived) }
    );
    if (
      !sync.requestId &&
      !sync.analysis &&
      !sync.proposeCarry &&
      !transientResults.has(refined)
    )
      noteLiveCapturable({
        exact,
        document,
        contentKey,
        lineageDemand: sync.lineageDemand
      });
    return true;
  } catch (error) {
    if ((error as { category?: unknown } | null)?.category === 'cancelled')
      // Overtaken: retried at the next idle moment.
      return serial !== workRequestSerial;
    // A refinement is never a modelling refusal. A failed one is retried
    // once, which after a dropped history cache is a full rebuild, so a
    // draft never stays on screen for want of a second attempt.
    pending.failures += 1;
    if (pending.failures > 1)
      pendingDisplayRefinements = pendingDisplayRefinements.filter(
        (entry) => entry !== pending
      );
    return true;
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
  // Not input either: it only says which draft display is on screen.
  if (event.data.type === 'live-content') {
    noteLiveContent(event.data);
    // A checked result adopted without a broadcast: the broadcast's own
    // result is no longer what is live.
    if (liveCapturable?.contentKey !== event.data.contentKey)
      liveCapturable = null;
    armDisplayRefinement();
    return;
  }
  // Nor is a change of the persistence policy alone: it rebuilds nothing.
  if (event.data.type === 'session-policy') {
    const { projectId, persistSession } = event.data;
    if (
      liveSessionPolicy?.projectId === projectId &&
      liveSessionPolicy.persist === persistSession
    )
      return;
    if (!persistSession || liveSessionPolicy?.projectId !== projectId)
      kernelSessions.forget();
    liveSessionPolicy = { projectId, persist: persistSession };
    if (
      persistSession &&
      liveCapturable &&
      liveCapturable.document.projectId === projectId
    )
      noteLiveCapturable(liveCapturable);
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
  // Idle work yields to anything that asks for the worker.
  workRequestSerial += 1;
  clearTimeout(displayRefinementTimer);
  displayRefinementTimer = undefined;
  if (request.type === 'cancel') {
    if (request.requestId !== undefined)
      cancelledRequests.add(request.requestId);
    else {
      clearEnvironmentRetry();
      latestBroadcast = null;
      broadcastAwaitsEnvironment = environmentRecovered = false;
      broadcastGate.issue(true);
      // Nothing is live: no draft is left to refine.
      noteLiveContent(null);
      // The project closed: nothing of it is captured or warmed any more,
      // so deleting it right after cannot be undone by a late write.
      liveSessionPolicy = null;
      liveCapturable = null;
      kernelSessions.forget();
    }
    // Idle again unless a drag is under way, which holds refinement back
    // until it ends or goes quiet.
    armDisplayRefinement();
    return;
  }
  if (request.type === 'preview-geometry')
    previewGestureFrameAtMs = performance.now();
  else if (request.type === 'sync' || request.type === 'release-edit-preview')
    previewGestureFrameAtMs = null;
  const isBroadcast = request.type === 'sync' && !request.requestId;
  // A live document that is not the user's own local project (a shared
  // link's model, a collaborator's): nothing scheduled for an earlier one
  // may write, and nothing of this one is captured.
  if (isBroadcast) {
    if (request.persistSession !== true) kernelSessions.forget();
    // Its own result is what a later `session-policy` would capture.
    liveCapturable = null;
    liveSessionPolicy = {
      projectId: request.document.projectId,
      persist: request.persistSession === true
    };
  }
  // A broadcast is what the main thread shows next: only a draft of that
  // content is still worth refining.
  if (isBroadcast && pendingDisplayRefinements.length > 0)
    noteLiveContent({
      projectId: request.document.projectId,
      contentKey: geometryContentKey(request.document)
    });
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
