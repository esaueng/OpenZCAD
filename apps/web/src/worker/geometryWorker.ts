import type { BodyId, ProjectDocument, ProjectId } from '@openzcad/shared';
import type { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  ExactRebuildCache,
  LatestBroadcastGate,
  canonicalProjectContentKey
} from './exactRebuildCache';
import { GeometryWorkerQueue } from './geometryWorkerQueue';
import { preloadDocumentFonts } from '../lib/textFonts';
import { loadSourceBlob, putSourceBlob } from '../lib/localProjectStore';

export type GeometryWorkerRequest =
  | { type: 'sync'; document: ProjectDocument; requestId?: string }
  | {
      type: 'export';
      requestId: string;
      document: ProjectDocument;
      bodyIds: BodyId[];
      format: 'step' | 'stl';
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
      ok: false;
      requestId: string;
      format: 'step' | 'stl';
      error: string;
    };

export type GeometryWorkerResult =
  GeometryWorkerState | GeometrySyncResult | GeometryExportResult;

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
        exactKernelStatus = 'failed';
        exactKernelError = error;
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

async function execute(job: GeometryWorkerJob): Promise<void> {
  const request = job.request;
  const document = request.document;
  const post = (message: GeometryWorkerResult) => {
    if (broadcastGate.isCurrent(job.broadcastToken)) {
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

    if (request.type === 'export') {
      if (exactKernelStatus === 'idle' || exactKernelStatus === 'loading') {
        post(stateFor('loading-remus', request, { stale: true }));
      }
      const exact = await loadExactKernel();
      if (!exact) {
        throw exactKernelError instanceof Error
          ? exactKernelError
          : new Error('The exact Remus kernel failed to load.');
      }
      post(stateFor('rebuilding', request, { stale: true }));
      const text =
        request.format === 'step'
          ? await exact.exportStep(document, request.bodyIds)
          : await exact.exportStl(document, request.bodyIds);
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
            if (
              exactKernelStatus === 'idle' ||
              exactKernelStatus === 'loading'
            ) {
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
