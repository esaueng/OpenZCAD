import { useEffect, useRef, useState } from 'react';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { CommandManager } from '@openzcad/command-system';
import { mark, measure, timed } from '../lib/perf';
import type {
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
    format: 'step' | 'stl',
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<ExportSuccess>;
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
    mark('worker.requested');
    const worker = timed(
      'worker.create',
      () =>
        new Worker(new URL('../worker/geometryWorker.ts', import.meta.url), {
          type: 'module'
        })
    );
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<GeometryWorkerResult>) => {
      if (event.data.type === 'state') {
        if (event.data.phase === 'loading-remus') {
          mark('kernel.loading');
        } else if (
          event.data.phase === 'ready' &&
          !firstReadyMarkedRef.current
        ) {
          firstReadyMarkedRef.current = true;
          mark('worker.ready');
          measure('worker.firstReady', 'worker.requested', 'worker.ready');
          measure('kernel.ready', 'kernel.loading', 'worker.ready');
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

    const rejectOutstanding = (error: Error) => {
      for (const request of exportRequests.current.values()) {
        request.reject(error);
      }
      exportRequests.current.clear();
      for (const request of syncRequests.current.values()) {
        request.reject(error);
      }
      syncRequests.current.clear();
    };

    worker.onerror = () => {
      const error = new Error('Geometry worker crashed.');
      rejectOutstanding(error);
      lastSyncedKey.current = null;
      setState({
        type: 'state',
        phase: 'failed',
        stale: true,
        error: error.message
      });
      hostRef.current.onError(error.message);
    };
    worker.onmessageerror = () => {
      const error = new Error(
        'Geometry worker returned an unreadable message.'
      );
      rejectOutstanding(error);
      lastSyncedKey.current = null;
      setState({
        type: 'state',
        phase: 'failed',
        stale: true,
        error: error.message
      });
      hostRef.current.onError(error.message);
    };

    return () => {
      const closed = new Error('Geometry worker closed.');
      rejectOutstanding(closed);
      worker.terminate();
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
    exportModel(format, document, bodyIds) {
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
          format
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
