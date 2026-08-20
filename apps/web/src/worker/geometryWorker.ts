import type {
  BodyId,
  ProjectDocument,
  ProjectId,
  SketchId
} from '@openzcad/shared';
import type {
  createExactKernelAdapter,
  MeshQualityReport,
  SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import {
  ExactRebuildCache,
  LatestBroadcastGate,
  canonicalProjectContentKey
} from './exactRebuildCache';
import { GeometryWorkerQueue } from './geometryWorkerQueue';
import { preloadDocumentFonts } from '../lib/textFonts';
import { loadSourceBlob, putSourceBlob } from '../lib/localProjectStore';

/**
 * `step` and `stl` produce text (STEP data, ASCII STL); `stl-binary` and
 * `3mf` produce bytes. Mesh formats accept a deflection in millimetres —
 * chordal tolerance after unit scaling — defaulting to the adapter's
 * standard export tessellation when omitted.
 */
export type GeometryExportFormat = 'step' | 'stl' | 'stl-binary' | '3mf';

export type GeometryWorkerRequest =
  | { type: 'sync'; document: ProjectDocument; requestId?: string }
  | {
      type: 'export';
      requestId: string;
      document: ProjectDocument;
      bodyIds: BodyId[];
      format: GeometryExportFormat;
      deflection?: number;
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
      format: 'step' | 'stl';
      text: string;
      warnings: string[];
    }
  | {
      type: 'export';
      ok: true;
      requestId: string;
      format: 'stl-binary' | '3mf';
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

export type GeometrySolveSketchResult =
  | {
      type: 'solve-sketch';
      ok: true;
      requestId: string;
      outcome: SketchSolveOutcome;
    }
  | { type: 'solve-sketch'; ok: false; requestId: string; error: string };

export type GeometryWorkerResult =
  | GeometryWorkerState
  | GeometrySyncResult
  | GeometryExportResult
  | GeometryMeshQualityResult
  | GeometrySolveSketchResult;

type ExactKernel = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let exactKernelStatus: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let exactKernelError: unknown;
let exactKernelPromise: Promise<ExactKernel | null> | null = null;

/**
 * Produces bytes for reference-form imports: the local blob store first, then
 * the artifact archived at import time. A cloud fetch is written back to the
 * blob store so the next rebuild is local. `putSourceBlob` hashes what it
 * stores, so a corrupted or wrong download can never satisfy the reference.
 */
async function resolveSourceBytes(
  ref: { checksumSha256: string },
  context: { artifactId: string; sourceName: string }
): Promise<Uint8Array> {
  const local = await loadSourceBlob(ref.checksumSha256);
  if (local) {
    return local;
  }
  if (!context.artifactId.startsWith('artifact_local_')) {
    const response = await fetch(
      `/api/artifacts/${context.artifactId}/download`
    );
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const stored = await putSourceBlob(bytes);
      if (stored.checksumSha256 === ref.checksumSha256) {
        return bytes;
      }
    }
  }
  throw new Error(
    `Import source for "${context.sourceName}" is not in local storage and could not be fetched.`
  );
}

function loadExactKernel(): Promise<ExactKernel | null> {
  if (exactKernelPromise) {
    return exactKernelPromise;
  }
  exactKernelStatus = 'loading';
  exactKernelPromise = import('@openzcad/kernel-adapter/exact')
    .then(({ createExactKernelAdapter }) =>
      createExactKernelAdapter({ resolveSourceBytes })
    )
    .then(
      (adapter) => {
        exactKernelStatus = 'ready';
        return adapter;
      },
      (error: unknown) => {
        // A load failure is usually transient — the WASM chunk fetch lost a
        // network race. Clearing the memoized promise lets the next rebuild
        // or export attempt a fresh load instead of leaving this worker
        // permanently kernel-less until the page reloads. The failed status
        // and error stick around for messaging until a retry begins.
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

interface GeometryWorkerJob {
  request: GeometryWorkerRequest;
  requestId?: string;
  broadcastToken: number | null;
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
  request: GeometryWorkerRequest,
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
      request.type === 'solve-sketch'
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
      if (request.format === 'stl-binary' || request.format === '3mf') {
        const data = await exact.exportMesh(document, request.bodyIds, {
          format: request.format === '3mf' ? '3mf' : 'stl-binary',
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
          : await exact.exportStl(document, request.bodyIds, request.deflection);
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
          canonicalProjectContentKey(document),
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
            return exact.syncDocument(document);
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
    } else if (request.type === 'solve-sketch') {
      post({
        type: 'solve-sketch',
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
  }
}

const queue = new GeometryWorkerQueue<GeometryWorkerJob>(execute);

self.onmessage = (event: MessageEvent<GeometryWorkerRequest>) => {
  const request = event.data;
  const isBroadcast = request.type === 'sync' && !request.requestId;
  queue.enqueue({
    request,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    broadcastToken: broadcastGate.issue(isBroadcast)
  });
};

export {};
