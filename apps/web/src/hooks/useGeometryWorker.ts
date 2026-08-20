import { useEffect, useRef, useState } from 'react';
import type { BodyId, ProjectDocument, SketchId } from '@openzcad/shared';
import type { CommandManager } from '@openzcad/command-system';
import { mark, measure, timed } from '../lib/perf';
import type {
  MeshQualityReport,
  SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';
import type {
  GeometryExportFormat,
  GeometryExportResult,
  GeometryWorkerState,
  GeometryWorkerResult
} from '../worker/geometryWorker';

type DerivedState = ProjectDocument['derived'];
type ExportSuccess = Extract<GeometryExportResult, { ok: true }>;

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

export interface GeometryWorkerHost {
  /**
   * The manager whose document a broadcast rebuild must match. Read at
   * message time, because results arrive after the document may have moved
   * on.
   */
  manager(): CommandManager | null;
  /** A rebuild arrived for the document currently on screen. */
  onDerived(derived: DerivedState): void;
  /** A rebuild failed; the message is already human-readable. */
  onError(message: string): void;
}

export interface GeometryWorkerApi {
  /** Lifecycle for the broadcast document currently shown in the workspace. */
  state: GeometryWorkerState;
  isReadyFor(document: ProjectDocument | null): boolean;
  /**
   * Posts a rebuild for the live document, at most once per model version.
   * Derived-state commits keep the same version, which is what breaks the
   * otherwise infinite post -> derive -> commit -> post cycle.
   */
  sync(document: ProjectDocument | null): void;
  /**
   * One-off exact rebuild resolved by request id — used for seeding demo
   * documents, whose finishing features need exact edge ordinals before the
   * document is ever opened.
   */
  syncOnce(document: ProjectDocument): Promise<DerivedState>;
  exportModel(
    format: GeometryExportFormat,
    document: ProjectDocument,
    bodyIds: BodyId[],
    options?: { deflection?: number }
  ): Promise<ExportSuccess>;
  /**
   * Pre-export printability check: watertightness per body at the deflection
   * the export would use, in millimetres.
   */
  meshQuality(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number
  ): Promise<MeshQualityReport>;
  /**
   * Solves one sketch's persisted constraints via the kernel's GCS and
   * returns solved geometry plus classification and DOF diagnostics.
   */
  solveSketch(
    document: ProjectDocument,
    sketchId: SketchId
  ): Promise<SketchSolveOutcome>;
  /** Forces the next `sync` to post even if the version has not changed. */
  invalidate(): void;
}

/**
 * Owns the geometry worker: its lifetime, the pending request maps, and the
 * routing of results back to whoever asked.
 *
 * Three kinds of message share one worker. Exports and one-off syncs are
 * request/response and resolve their own promise; a broadcast sync has no
 * request id and belongs to whatever document is on screen, so it is checked
 * against the live manager before being applied.
 */
export function useGeometryWorker(host: GeometryWorkerHost): GeometryWorkerApi {
  const workerRef = useRef<Worker | null>(null);
  const exportRequests = useRef(
    new Map<string, PendingRequest<ExportSuccess>>()
  );
  const meshQualityRequests = useRef(
    new Map<string, PendingRequest<MeshQualityReport>>()
  );
  const solveSketchRequests = useRef(
    new Map<string, PendingRequest<SketchSolveOutcome>>()
  );
  const syncRequests = useRef(new Map<string, PendingRequest<DerivedState>>());
  const lastSyncedKey = useRef<string | null>(null);
  const firstReadyMarkedRef = useRef(false);
  const [state, setState] = useState<GeometryWorkerState>({
    type: 'state',
    phase: 'starting',
    stale: true
  });

  // The host closes over React state that changes every render; reading it
  // through a ref keeps the worker from being torn down and rebuilt.
  const hostRef = useRef(host);
  hostRef.current = host;

  useEffect(() => {
    // A crashed worker used to stay installed as a corpse: outstanding
    // requests were rejected, but every LATER sync or export posted into the
    // dead worker and its promise never settled, and only a page reload
    // recovered. Supervise instead: terminate and respawn on error, with a
    // boot-loop cap so a worker that cannot start (missing chunk, wasm abort
    // on load) fails permanently and loudly rather than cycling forever. A
    // successful `ready` resets the budget — a crash after hours of editing
    // should not be charged against startup attempts.
    const RESPAWN_LIMIT = 3;
    let disposed = false;
    let respawnsSinceReady = 0;

    const rejectOutstanding = (error: Error) => {
      for (const request of exportRequests.current.values()) {
        request.reject(error);
      }
      exportRequests.current.clear();
      for (const request of meshQualityRequests.current.values()) {
        request.reject(error);
      }
      meshQualityRequests.current.clear();
      for (const request of solveSketchRequests.current.values()) {
        request.reject(error);
      }
      solveSketchRequests.current.clear();
      for (const request of syncRequests.current.values()) {
        request.reject(error);
      }
      syncRequests.current.clear();
    };

    const spawn = () => {
      mark('worker.requested');
      const worker = timed(
        'worker.create',
        () =>
          new Worker(new URL('../worker/geometryWorker.ts', import.meta.url), {
            type: 'module'
          })
      );
      workerRef.current = worker;

      const failAndMaybeRespawn = (message: string) => {
        if (workerRef.current !== worker) {
          return; // A stale handler from an already-replaced worker.
        }
        rejectOutstanding(new Error(message));
        lastSyncedKey.current = null;
        worker.terminate();
        workerRef.current = null;
        if (!disposed && respawnsSinceReady < RESPAWN_LIMIT) {
          respawnsSinceReady += 1;
          hostRef.current.onError(
            `${message} Restarting the geometry worker (attempt ${respawnsSinceReady} of ${RESPAWN_LIMIT}).`
          );
          setState({ type: 'state', phase: 'starting', stale: true });
          spawn();
        } else {
          setState({
            type: 'state',
            phase: 'failed',
            stale: true,
            error: message
          });
          hostRef.current.onError(
            `${message} The geometry worker could not be restarted; reload the page to recover.`
          );
        }
      };

      worker.onmessage = (event: MessageEvent<GeometryWorkerResult>) => {
        if (event.data.type === 'state') {
          if (event.data.phase === 'loading-remus') {
            mark('kernel.loading');
          } else if (event.data.phase === 'ready') {
            respawnsSinceReady = 0;
            if (!firstReadyMarkedRef.current) {
              firstReadyMarkedRef.current = true;
              mark('worker.ready');
              measure('worker.firstReady', 'worker.requested', 'worker.ready');
              measure('kernel.ready', 'kernel.loading', 'worker.ready');
            }
          }
          // One-off previews and exports have their own promises and must not
          // make the live document look stale or ready out of order.
          if (!event.data.requestId) {
            setState(event.data);
            if (event.data.phase === 'failed' && event.data.error) {
              hostRef.current.onError(
                `Geometry rebuild failed: ${event.data.error}`
              );
            }
          }
          return;
        }
        if (event.data.type === 'export') {
          const pending = exportRequests.current.get(event.data.requestId);
          if (!pending) {
            return;
          }
          exportRequests.current.delete(event.data.requestId);
          if (event.data.ok) {
            pending.resolve(event.data);
          } else {
            pending.reject(new Error(event.data.error));
          }
          return;
        }
        if (event.data.type === 'mesh-quality') {
          const pending = meshQualityRequests.current.get(event.data.requestId);
          if (!pending) {
            return;
          }
          meshQualityRequests.current.delete(event.data.requestId);
          if (event.data.ok) {
            pending.resolve(event.data.report);
          } else {
            pending.reject(new Error(event.data.error));
          }
          return;
        }
        if (event.data.type === 'solve-sketch') {
          const pending = solveSketchRequests.current.get(event.data.requestId);
          if (!pending) {
            return;
          }
          solveSketchRequests.current.delete(event.data.requestId);
          if (event.data.ok) {
            pending.resolve(event.data.outcome);
          } else {
            pending.reject(new Error(event.data.error));
          }
          return;
        }
        if (event.data.requestId) {
          const pending = syncRequests.current.get(event.data.requestId);
          if (pending) {
            syncRequests.current.delete(event.data.requestId);
            if (event.data.ok) {
              pending.resolve(event.data.derived);
            } else {
              pending.reject(new Error(event.data.error));
            }
          }
          return;
        }
        const manager = hostRef.current.manager();
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
          lastSyncedKey.current = null;
          hostRef.current.onError(`Geometry rebuild failed: ${result.error}`);
          return;
        }
        hostRef.current.onDerived(result.derived);
      };

      worker.onerror = () => {
        failAndMaybeRespawn('Geometry worker crashed.');
      };
      worker.onmessageerror = () => {
        failAndMaybeRespawn('Geometry worker returned an unreadable message.');
      };
    };

    spawn();

    return () => {
      disposed = true;
      const closed = new Error('Geometry worker closed.');
      rejectOutstanding(closed);
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  return {
    state,
    isReadyFor(document) {
      return Boolean(
        document &&
        state.phase === 'ready' &&
        !state.stale &&
        state.projectId === document.projectId &&
        state.version === document.version
      );
    },
    sync(document) {
      const worker = workerRef.current;
      if (!document || !worker) {
        return;
      }
      const syncKey = `${document.projectId}:${document.version}`;
      if (lastSyncedKey.current === syncKey) {
        return;
      }
      lastSyncedKey.current = syncKey;
      worker.postMessage({ type: 'sync', document });
    },
    syncOnce(document) {
      const worker = workerRef.current;
      if (!worker) {
        return Promise.reject(new Error('Geometry worker unavailable.'));
      }
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        syncRequests.current.set(requestId, { resolve, reject });
        worker.postMessage({ type: 'sync', document, requestId });
      });
    },
    exportModel(format, document, bodyIds, options) {
      const worker = workerRef.current;
      if (!worker) {
        return Promise.reject(new Error('Geometry worker is unavailable.'));
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        exportRequests.current.set(requestId, { resolve, reject });
        worker.postMessage({
          type: 'export',
          requestId,
          document,
          bodyIds,
          format,
          ...(options?.deflection !== undefined
            ? { deflection: options.deflection }
            : {})
        });
      });
    },
    meshQuality(document, bodyIds, deflection) {
      const worker = workerRef.current;
      if (!worker) {
        return Promise.reject(new Error('Geometry worker is unavailable.'));
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        meshQualityRequests.current.set(requestId, { resolve, reject });
        worker.postMessage({
          type: 'mesh-quality',
          requestId,
          document,
          bodyIds,
          deflection
        });
      });
    },
    solveSketch(document, sketchId) {
      const worker = workerRef.current;
      if (!worker) {
        return Promise.reject(new Error('Geometry worker is unavailable.'));
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        solveSketchRequests.current.set(requestId, { resolve, reject });
        worker.postMessage({
          type: 'solve-sketch',
          requestId,
          document,
          sketchId
        });
      });
    },
    invalidate() {
      lastSyncedKey.current = null;
      setState((current) => ({
        ...current,
        phase: 'starting',
        stale: true,
        error: undefined
      }));
    }
  };
}
