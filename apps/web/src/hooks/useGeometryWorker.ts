import { useEffect, useRef, useState } from 'react';
import type { BodyId, ProjectDocument, SketchId } from '@openzcad/shared';
import type { CommandManager } from '@openzcad/command-system';
import { mark, measure, timed } from '../lib/perf';
import type {
  MeshQualityReport,
  SketchSolveOutcome,
  DxfFaceSelector
} from '@openzcad/kernel-adapter/exact';
import type {
  GeometryExportFormat,
  GeometryExportResult,
  GeometryWorkerPhase,
  GeometryWorkerState,
  GeometryWorkerResult
} from '../worker/geometryWorker';

type DerivedState = ProjectDocument['derived'];
type ExportSuccess = Extract<GeometryExportResult, { ok: true }>;

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

/**
 * How long a worker may stay silent (no message of any kind) while the live
 * document sits in a non-terminal phase before it is judged wedged. A silent
 * worker used to stay wedged forever — the status line read "Starting
 * geometry worker" indefinitely and every build-dependent tool, extrude
 * included, quietly did nothing until a manual reload.
 *
 * `starting` must hand off to a kernel or rebuild phase quickly; the kernel
 * budget absorbs a slow first fetch of the multi-megabyte wasm; `rebuilding`
 * is unbounded legitimate work, so its budget is the most generous.
 */
const RESPAWN_BUDGET_MS: Record<
  'starting' | 'loading-remus' | 'rebuilding',
  number
> = {
  starting: 15_000,
  'loading-remus': 90_000,
  rebuilding: 120_000
};

/** How often the watchdog samples worker silence. */
const WATCHDOG_TICK_MS = 1_000;

function respawnBudget(phase: GeometryWorkerPhase): number | null {
  return phase === 'ready' || phase === 'failed'
    ? null
    : RESPAWN_BUDGET_MS[phase];
}

/**
 * Shared posting discipline for broadcast syncs: dedupe per project/version so
 * a rebuild storm cannot loop, and record the key so a respawn can tell what
 * the replacement worker still owes. Every post also re-arms the watchdog.
 */
function postSync(
  worker: Worker,
  document: ProjectDocument,
  lastSyncedKey: { current: string | null },
  armed: { current: boolean }
): void {
  const syncKey = `${document.projectId}:${document.version}`;
  if (lastSyncedKey.current === syncKey) {
    return;
  }
  lastSyncedKey.current = syncKey;
  armed.current = true;
  worker.postMessage({ type: 'sync', document });
}

/** Cancellation rejection, named so callers can tell it from a failure. */
function abortError(): Error {
  const error = new Error('Export cancelled.');
  error.name = 'AbortError';
  return error;
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
  /**
   * `onState` receives this request's own lifecycle states (kernel load,
   * rebuild) so a dialog can narrate progress. Aborting the `signal` rejects
   * with an `AbortError`-named error, discards the eventual worker result,
   * and — when the job has not started yet — skips it entirely.
   */
  exportModel(
    format: GeometryExportFormat,
    document: ProjectDocument,
    bodyIds: BodyId[],
    options?: {
      deflection?: number;
      /** Required for 'dxf': the planar face whose outline to export. */
      face?: DxfFaceSelector;
      signal?: AbortSignal;
      onState?(state: GeometryWorkerState): void;
    }
  ): Promise<ExportSuccess>;
  /**
   * Pre-export printability check: watertightness per body at the deflection
   * the export would use, in millimetres.
   */
  meshQuality(
    document: ProjectDocument,
    bodyIds: BodyId[],
    deflection: number,
    options?: { onState?(state: GeometryWorkerState): void }
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
  // Callers who asked to watch their own request's lifecycle states.
  const stateSubscribers = useRef(
    new Map<string, (state: GeometryWorkerState) => void>()
  );
  const lastSyncedKey = useRef<string | null>(null);
  const firstReadyMarkedRef = useRef(false);
  // True while work has been posted whose terminal state has not arrived.
  // An unarmed worker is legitimately idle and must never be judged silent
  // by the watchdog.
  const armedRef = useRef(false);
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

    // Watchdog clocks. `quietBudgetUntil` extends the budget when a
    // request-tagged job (an export, a preview) is itself in a long phase
    // while the live document waits behind it in the job queue.
    let livePhase: GeometryWorkerPhase = 'starting';
    let lastWorkerMessageAt = 0;
    let quietBudgetPhase: 'loading-remus' | 'rebuilding' | null = null;
    let quietBudgetUntil = 0;

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
      stateSubscribers.current.clear();
    };

    const failAndMaybeRespawn = (failed: Worker | null, message: string) => {
      if (failed && workerRef.current !== failed) {
        return; // A stale handler from an already-replaced worker.
      }
      rejectOutstanding(new Error(message));
      lastSyncedKey.current = null;
      failed?.terminate();
      workerRef.current = null;
      if (!disposed && respawnsSinceReady < RESPAWN_LIMIT) {
        respawnsSinceReady += 1;
        hostRef.current.onError(
          `${message} Restarting the geometry worker (attempt ${respawnsSinceReady} of ${RESPAWN_LIMIT}).`
        );
        setState({ type: 'state', phase: 'starting', stale: true });
        spawn();
        // The replacement worker owes the visible document a rebuild: a
        // respawn used to sit idle at "starting" until the next edit
        // happened to post a sync again.
        const manager = hostRef.current.manager();
        const replacement = workerRef.current;
        if (manager && replacement) {
          postSync(replacement, manager.document, lastSyncedKey, armedRef);
        }
      } else {
        armedRef.current = false;
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

    const spawn = () => {
      mark('worker.requested');
      let worker: Worker;
      try {
        worker = timed(
          'worker.create',
          () =>
            new Worker(new URL('../worker/geometryWorker.ts', import.meta.url), {
              type: 'module'
            })
        );
      } catch (error) {
        // A blocked or unsupported worker environment throws synchronously.
        // Swallowing it used to leave workerRef null: every sync silently
        // no-oped and the UI sat at "Starting geometry worker" forever.
        failAndMaybeRespawn(
          null,
          `Geometry worker could not be started: ${
            error instanceof Error ? error.message : 'unknown error'
          }.`
        );
        return;
      }
      workerRef.current = worker;
      lastWorkerMessageAt = Date.now();
      livePhase = 'starting';
      quietBudgetPhase = null;
      quietBudgetUntil = 0;

      worker.onmessage = (event: MessageEvent<GeometryWorkerResult>) => {
        lastWorkerMessageAt = Date.now();
        if (event.data.type === 'state') {
          if (!event.data.requestId) {
            livePhase = event.data.phase;
            if (event.data.phase === 'ready' || event.data.phase === 'failed') {
              armedRef.current = false;
            }
          } else if (
            event.data.phase === 'loading-remus' ||
            event.data.phase === 'rebuilding'
          ) {
            // A request-tagged job is itself in a long phase; extend the
            // budget so the watchdog does not kill a healthy-but-slow worker
            // while the live document waits behind it in the queue.
            quietBudgetPhase = event.data.phase;
            quietBudgetUntil = Date.now() + RESPAWN_BUDGET_MS[event.data.phase];
          }
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
          // make the live document look stale or ready out of order; their
          // states go to the caller that asked to watch them, or nowhere.
          if (event.data.requestId) {
            stateSubscribers.current.get(event.data.requestId)?.(event.data);
            return;
          }
          setState(event.data);
          if (event.data.phase === 'failed' && event.data.error) {
            hostRef.current.onError(
              `Geometry rebuild failed: ${event.data.error}`
            );
          }
          return;
        }
        if (event.data.type === 'export') {
          const pending = exportRequests.current.get(event.data.requestId);
          if (!pending) {
            return; // Cancelled — the caller's promise is already rejected.
          }
          exportRequests.current.delete(event.data.requestId);
          stateSubscribers.current.delete(event.data.requestId);
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
          stateSubscribers.current.delete(event.data.requestId);
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
        failAndMaybeRespawn(worker, 'Geometry worker crashed.');
      };
      worker.onmessageerror = () => {
        failAndMaybeRespawn(
          worker,
          'Geometry worker returned an unreadable message.'
        );
      };
    };

    spawn();

    // The wedged-worker watchdog. A worker that boots, takes work, and then
    // goes silent — a stalled module fetch, a hung wasm compile, a crashed
    // boot the browser never reports — used to hold the UI at "Starting
    // geometry worker" until a manual reload. Silence longer than the
    // current phase's budget is treated as a crash: terminate, respawn, and
    // re-request the visible document's rebuild.
    const watchdog = setInterval(() => {
      const worker = workerRef.current;
      if (!worker || !armedRef.current) {
        return;
      }
      const budget = respawnBudget(livePhase);
      if (budget === null) {
        return;
      }
      const quietFor = Date.now() - lastWorkerMessageAt;
      const floor =
        quietBudgetPhase !== null && Date.now() < quietBudgetUntil
          ? RESPAWN_BUDGET_MS[quietBudgetPhase]
          : 0;
      if (quietFor <= Math.max(budget, floor)) {
        return;
      }
      failAndMaybeRespawn(
        worker,
        `The geometry worker stopped responding during "${livePhase}".`
      );
    }, WATCHDOG_TICK_MS);

    return () => {
      disposed = true;
      clearInterval(watchdog);
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
      postSync(worker, document, lastSyncedKey, armedRef);
    },
    syncOnce(document) {
      const worker = workerRef.current;
      if (!worker) {
        return Promise.reject(new Error('Geometry worker unavailable.'));
      }
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        syncRequests.current.set(requestId, { resolve, reject });
        armedRef.current = true;
        worker.postMessage({ type: 'sync', document, requestId });
      });
    },
    exportModel(format, document, bodyIds, options) {
      const worker = workerRef.current;
      if (!worker) {
        return Promise.reject(new Error('Geometry worker is unavailable.'));
      }
      if (options?.signal?.aborted) {
        return Promise.reject(abortError());
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (!exportRequests.current.delete(requestId)) {
            return; // Already settled.
          }
          stateSubscribers.current.delete(requestId);
          // Best effort: the worker drops the job if it has not started; a
          // running wasm build cannot be interrupted, but its result finds
          // no pending request and is discarded.
          armedRef.current = true;
          workerRef.current?.postMessage({ type: 'cancel', requestId });
          reject(abortError());
        };
        exportRequests.current.set(requestId, {
          resolve: (value) => {
            options?.signal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
          reject: (error) => {
            options?.signal?.removeEventListener('abort', onAbort);
            reject(error);
          }
        });
        if (options?.onState) {
          stateSubscribers.current.set(requestId, options.onState);
        }
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        armedRef.current = true;
        worker.postMessage({
          type: 'export',
          requestId,
          document,
          bodyIds,
          format,
          ...(options?.deflection !== undefined
            ? { deflection: options.deflection }
            : {}),
          ...(options?.face !== undefined ? { face: options.face } : {})
        });
      });
    },
    meshQuality(document, bodyIds, deflection, options) {
      const worker = workerRef.current;
      if (!worker) {
        return Promise.reject(new Error('Geometry worker is unavailable.'));
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        meshQualityRequests.current.set(requestId, { resolve, reject });
        if (options?.onState) {
          stateSubscribers.current.set(requestId, options.onState);
        }
        armedRef.current = true;
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
        armedRef.current = true;
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
