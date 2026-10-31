import type {
  DrawingProjectionRequest,
  DrawingProjectionResponse,
  DrawingProjectionResult,
  DrawingProjectionViewRequest
} from '../../worker/drawingProjectionWorker';
import { projectView, type ProjectionBodyInput } from './projectView';

export type { DrawingProjectionResult, DrawingProjectionViewRequest };

/** The most projection workers a drawing runs at once. */
const MAX_PROJECTION_WORKERS = 4;

/**
 * How many views project at once: one per core the page can spare beside
 * the main thread, up to four — a starter sheet's views.
 */
export function projectionWorkerCount(cores: number | undefined): number {
  if (!cores || !Number.isFinite(cores)) return 2;
  return Math.max(1, Math.min(MAX_PROJECTION_WORKERS, Math.floor(cores) - 1));
}

/**
 * The main thread's handle on the drawing projection workers, for the
 * drawing workspace's lifetime. Hidden-line removal of one view is a long
 * single-threaded job, so a sheet's views project side by side, one per
 * worker, each answered as soon as it is done (`onView`) rather than when the
 * slowest view of the batch finishes. A worker is started only when a view
 * is waiting and none is free. Each worker is sent the batch's geometry once,
 * with its first view, and keeps it for the batch's other views.
 *
 * Latest wins: at most one batch is in the workers and one waits. A newer
 * batch replaces the waiting one, which is rejected as an abort, so
 * switching sheets quickly never queues geometry copies or makes the sheet on
 * screen wait behind projections nobody will see. (A worker cannot stop a
 * view it is already projecting; that one finishes.) Where workers do not
 * exist (unit tests under happy-dom), projection runs inline.
 */
export class DrawingProjectionClient {
  private readonly slots: Slot[] = [];
  private inFlight: Pending | null = null;
  private waiting: Pending | null = null;

  constructor(
    private readonly workerLimit = projectionWorkerCount(
      typeof navigator === 'undefined'
        ? undefined
        : navigator.hardwareConcurrency
    )
  ) {}

  project(
    bodies: Record<string, ProjectionBodyInput>,
    views: DrawingProjectionViewRequest[],
    onView?: (key: string, result: DrawingProjectionResult) => void
  ): Promise<Record<string, DrawingProjectionResult>> {
    if (typeof Worker === 'undefined') {
      const results: Record<string, DrawingProjectionResult> = {};
      for (const view of views) {
        try {
          results[view.key] = {
            ok: true,
            projection: projectView({
              orientation: view.orientation,
              hiddenLines: view.hiddenLines,
              bodies: view.bodyIds.flatMap((id) =>
                bodies[id] ? [bodies[id]] : []
              )
            })
          };
        } catch (error) {
          results[view.key] = {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
        onView?.(view.key, results[view.key]!);
      }
      return Promise.resolve(results);
    }
    return new Promise((resolve, reject) => {
      const request: Pending = {
        requestId: crypto.randomUUID(),
        bodies,
        queue: [...views],
        outstanding: 0,
        results: {},
        onView,
        resolve,
        reject
      };
      if (!this.inFlight) {
        this.start(request);
        return;
      }
      this.waiting?.reject(abortError('Superseded by a newer projection.'));
      this.waiting = request;
    });
  }

  private start(request: Pending): void {
    this.inFlight = request;
    this.dispatch();
  }

  /** Hands the batch's waiting views to free workers, starting more as allowed. */
  private dispatch(): void {
    const request = this.inFlight;
    if (!request) return;
    if (request.queue.length === 0 && request.outstanding === 0) {
      this.settle(request);
      return;
    }
    while (request.queue.length > 0) {
      let slot = this.slots.find((candidate) => !candidate.busy);
      try {
        // A worker that cannot start (a blocked policy) or a payload that
        // cannot be cloned throws here; the batch fails as a whole, and the
        // next one is not left waiting behind a phantom one.
        if (!slot) {
          if (this.slots.length >= this.workerLimit) return;
          slot = this.startWorker();
        }
        const view = request.queue[0]!;
        const message: DrawingProjectionRequest = {
          type: 'project',
          requestId: request.requestId,
          // Each worker keeps the batch's geometry from its first view.
          bodies:
            slot.heldRequestId === request.requestId
              ? undefined
              : request.bodies,
          views: [view]
        };
        slot.worker.postMessage(message);
        request.queue.shift();
        slot.heldRequestId = request.requestId;
        slot.busy = request.requestId;
        request.outstanding += 1;
      } catch (error) {
        if (slot) this.dropSlot(slot);
        this.fail(
          request,
          error instanceof Error ? error : new Error('Projection failed.')
        );
        return;
      }
    }
  }

  private startWorker(): Slot {
    const worker = new Worker(
      new URL('../../worker/drawingProjectionWorker.ts', import.meta.url),
      { type: 'module' }
    );
    const slot: Slot = { worker, busy: null, heldRequestId: null };
    worker.onmessage = (event: MessageEvent<DrawingProjectionResponse>) => {
      const response = event.data;
      slot.busy = null;
      const request = this.inFlight;
      if (request && request.requestId === response.requestId) {
        request.outstanding -= 1;
        for (const [key, result] of Object.entries(response.results)) {
          request.results[key] = result;
          request.onView?.(key, result);
        }
      }
      this.dispatch();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const lost = slot.busy;
      this.dropSlot(slot);
      const request = this.inFlight;
      if (request && lost === request.requestId)
        this.fail(request, new Error('The drawing projection worker stopped.'));
      else this.dispatch();
    };
    this.slots.push(slot);
    return slot;
  }

  private dropSlot(slot: Slot): void {
    slot.worker.terminate();
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
  }

  private settle(request: Pending): void {
    this.inFlight = null;
    this.release(request);
    request.resolve(request.results);
    this.next();
  }

  private fail(request: Pending, error: Error): void {
    if (this.inFlight === request) this.inFlight = null;
    this.release(request);
    request.reject(error);
    this.next();
  }

  /** Lets idle workers drop a finished batch's geometry. */
  private release(request: Pending): void {
    for (const slot of this.slots)
      if (slot.heldRequestId === request.requestId && !slot.busy) {
        slot.heldRequestId = null;
        slot.worker.postMessage({ type: 'release' });
      }
  }

  private next(): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) this.start(waiting);
  }

  dispose(): void {
    const closed = abortError('Drawing closed.');
    this.inFlight?.reject(closed);
    this.waiting?.reject(closed);
    this.inFlight = null;
    this.waiting = null;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots.length = 0;
  }
}

interface Slot {
  worker: Worker;
  /** The batch whose view the worker is projecting, or null when free. */
  busy: string | null;
  /** The batch whose geometry the worker holds. */
  heldRequestId: string | null;
}

interface Pending {
  requestId: string;
  bodies: Record<string, ProjectionBodyInput>;
  /** Views not yet sent to a worker. */
  queue: DrawingProjectionViewRequest[];
  /** Views sent and not yet answered. */
  outstanding: number;
  results: Record<string, DrawingProjectionResult>;
  onView?: (key: string, result: DrawingProjectionResult) => void;
  resolve: (results: Record<string, DrawingProjectionResult>) => void;
  reject: (error: Error) => void;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
