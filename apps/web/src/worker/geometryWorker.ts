import type { EditAnalysisRequest } from '@openzcad/shared';
import type {
  BodyId,
  FaceRecognitionSummary,
  ProjectDocument,
  ProjectId,
  SketchId
} from '@openzcad/shared';
import type {
  createExactKernelAdapter,
  DxfFaceSelector,
  ExactSectionPlane,
  MeshQualityReport,
  RebuildProgress,
  SectionOutlineReport,
  SketchPlanarOperation,
  SketchPlanarResult,
  SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  ExactRebuildCache,
  LatestBroadcastGate,
  canonicalProjectContentKey
} from './exactRebuildCache';
import { GeometryWorkerQueue } from './geometryWorkerQueue';
import { unpackWorkerRequest } from '../lib/meshTransport';
import { resolveExactSourceBytes } from '../lib/exactSourceResolver';
import { preloadDocumentFonts } from '../lib/textFonts';

/**
 * `step`, `stl`, and `dxf` produce text (STEP data, ASCII STL, DXF R12);
 * `stl-binary`, `3mf`, `obj`, and `glb` produce bytes. Mesh formats accept
 * a deflection in millimetres — chordal tolerance after unit scaling —
 * defaulting to the adapter's standard export tessellation when omitted.
 * `dxf` exports a 2D outline and requires either a `face` (one planar
 * face's outline) or a `section` plane (the exact cross-section).
 */
export type GeometryExportFormat =
  'step' | 'stl' | 'dxf' | 'stl-binary' | '3mf' | 'obj' | 'glb';

/** The export formats whose payload crosses back as transferred bytes. */
export type GeometryBinaryExportFormat = Extract<
  GeometryExportFormat,
  'stl-binary' | '3mf' | 'obj' | 'glb'
>;

export type GeometryWorkerRequest =
  | {
      type: 'sync';
      document: ProjectDocument;
      requestId?: string;
      analysis?: EditAnalysisRequest;
    }
  | {
      type: 'export';
      requestId: string;
      document: ProjectDocument;
      bodyIds: BodyId[];
      format: GeometryExportFormat;
      deflection?: number;
      /** One 'dxf' source: the planar face whose outline to export. */
      face?: DxfFaceSelector;
      /** The other 'dxf' source: the plane whose exact section to export. */
      section?: ExactSectionPlane;
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
    }
  | {
      type: 'solve-sketch';
      requestId: string;
      document: ProjectDocument;
      sketchId: SketchId;
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
       * its result. Never applies to broadcasts, which have no request id.
       */
      type: 'cancel';
      requestId: string;
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
      derived: ProjectDocument['derived'];
    }
  | {
      type: 'sync';
      ok: false;
      projectId: ProjectId;
      version: number;
      requestId?: string;
      error: string;
    };

export type GeometryExportResult =
  | {
      type: 'export';
      ok: true;
      requestId: string;
      format: 'step' | 'stl' | 'dxf';
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
      type: 'projection';
      projectId: string;
      version: number;
      derived: ProjectDocument['derived'];
    }
  | GeometryWorkerState
  | GeometrySyncResult
  | GeometryExportResult
  | GeometryMeshQualityResult
  | GeometrySectionResult
  | GeometrySolveSketchResult
  | GeometrySketch2dOpResult
  | GeometryRecognizeImportedFaceResult;

type ExactKernel = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let exactKernelStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let exactKernelError: unknown;
let exactKernelPromise: Promise<ExactKernel | null> | null = null;

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
  const attempt = import('@openzcad/kernel-adapter/exact').then(
    ({ createExactKernelAdapter }) =>
      createExactKernelAdapter({
        resolveSourceBytes: resolveExactSourceBytes
      })
  );
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

const rebuildCache = new ExactRebuildCache<ProjectDocument['derived']>({
  maxEntries: 8,
  maxBytes: 32 * 1024 * 1024,
  maxInFlight: 4
});
const broadcastGate = new LatestBroadcastGate();

/** Every request that carries work; `cancel` is handled before the queue. */
type GeometryWorkerWorkRequest = Exclude<
  GeometryWorkerRequest,
  { type: 'cancel' }
>;

interface GeometryWorkerJob {
  request: GeometryWorkerWorkRequest;
  requestId?: string;
  broadcastToken: number | null;
}

/**
 * Requests cancelled while still queued. Entries are consumed when the
 * skipped job surfaces, or cleared when a cancel raced a job that was
 * already running by the time it arrived.
 */
const cancelledRequests = new Set<string>();

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
  if (job.requestId && cancelledRequests.delete(job.requestId)) {
    return; // Cancelled while queued; the caller already dropped its promise.
  }
  const request = job.request;
  const document = request.document;
  const post = (message: GeometryWorkerResult, transfer?: Transferable[]) => {
    if (!broadcastGate.isCurrent(job.broadcastToken)) {
      return;
    }
    if (transfer && transfer.length > 0) {
      self.postMessage(message, { transfer });
    } else {
      self.postMessage(message);
    }
  };
  try {
    post(stateFor('starting', request, { stale: true }));

    // The text fast path resolves faces synchronously, so every face this
    // document names has to be parsed before the rebuild reads it. A miss is
    // reported as a profile diagnostic rather than thrown, so this never
    // blocks the rest of the model on one unavailable font.
    await preloadDocumentFonts(document);

    if (
      request.type === 'export' ||
      request.type === 'mesh-quality' ||
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
            ? document.derived.bodyRepresentations[request.bodyId]?.topology?.faces.find(
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
        const outcome = await exact.solveSketch(document, request.sketchId);
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
      if (request.type === 'mesh-quality') {
        const report = await exact.meshQuality(
          document,
          request.bodyIds,
          request.deflection
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
        if (!request.face && !request.section) {
          throw new Error('DXF export needs a face selection or a section plane.');
        }
        const text = request.section
          ? await exact.exportSectionDxf(
              document,
              request.section,
              // Same bodies as the section on screen. An empty selection
              // means the caller has nothing to narrow it by, so the
              // adapter's own document visibility stands.
              request.bodyIds.length > 0 ? request.bodyIds : undefined
            )
          : await exact.exportFaceDxf(document, request.face!);
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
      if (request.format !== 'step' && request.format !== 'stl') {
        const data = await exact.exportMesh(document, request.bodyIds, {
          format: request.format,
          deflection: request.deflection ?? DEFAULT_EXPORT_DEFLECTION
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
          ? await exact.exportStep(document, request.bodyIds)
          : await exact.exportStl(
              document,
              request.bodyIds,
              request.deflection
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

    const derived = isGeometryEmpty(document)
      ? emptyDerived(document)
      : await rebuildCache.get(
          `${canonicalProjectContentKey(document)}${request.type === 'sync' && request.analysis ? `:analysis:${JSON.stringify(request.analysis)}` : ''}`,
          async () => {
            // 'failed' retries on the next load call, so it counts as a
            // loading state here too.
            if (exactKernelStatus !== 'ready') {
              post(stateFor('loading-remus', request, { stale: true }));
            }
            const exact = await loadExactKernel();
            if (!exact) {
              throw exactKernelError instanceof Error
                ? exactKernelError
                : new Error('The exact Remus kernel failed to load.');
            }
            if (!broadcastGate.isCurrent(job.broadcastToken)) {
              throw new Error('Superseded geometry broadcast.');
            }
            post(stateFor('rebuilding', request, { stale: true }));
            return exact.syncDocument(
              document,
              (progress) => {
                if (!broadcastGate.isCurrent(job.broadcastToken)) return;
                post({
                  ...stateFor('rebuilding', request, { stale: true }),
                  progress
                });
              },
              request.requestId
                ? undefined
                : (projection) => {
                    post({
                      type: 'projection',
                      projectId: document.projectId,
                      version: document.version,
                      derived: projection
                    });
                  },
              request.type === 'sync' ? request.analysis : undefined
            );
          }
        );
    if (!broadcastGate.isCurrent(job.broadcastToken)) {
      return;
    }
    const result: GeometrySyncResult = {
      type: 'sync',
      ok: true,
      projectId: document.projectId,
      version: document.version,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      derived
    };
    post(result);
    post(stateFor('ready', request, { stale: false }));
  } catch (error) {
    if (!broadcastGate.isCurrent(job.broadcastToken)) {
      return;
    }
    const message = errorMessage(error);
    if (request.type === 'export') {
      const result: GeometryExportResult = {
        type: 'export',
        ok: false,
        requestId: request.requestId,
        format: request.format,
        error: message
      };
      post(result);
    } else if (request.type === 'mesh-quality') {
      post({
        type: 'mesh-quality',
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
        error: message
      };
      post(result);
    }
    post(stateFor('failed', request, { stale: true, error: message }));
  } finally {
    // A cancel that raced a job already running leaves its entry behind;
    // sweep it so the set cannot grow across a long session.
    if (job.requestId) {
      cancelledRequests.delete(job.requestId);
    }
  }
}

const queue = new GeometryWorkerQueue<GeometryWorkerJob>(execute);

self.onmessage = (event: MessageEvent<GeometryWorkerRequest>) => {
  // Unpack before anything reads the document: every consumer past this point
  // — the rebuild, the cache key, the history digest — expects plain arrays.
  const request = unpackWorkerRequest(event.data);
  if (request.type === 'cancel') {
    cancelledRequests.add(request.requestId);
    return;
  }
  const isBroadcast = request.type === 'sync' && !request.requestId;
  queue.enqueue({
    request,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    broadcastToken: broadcastGate.issue(isBroadcast)
  });
};

export {};
