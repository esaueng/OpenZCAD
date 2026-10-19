import type {
  DrawingProjectionRequest,
  DrawingProjectionResponse,
  DrawingProjectionResult,
  DrawingProjectionViewRequest
} from '../../worker/drawingProjectionWorker';
import { projectView, type ProjectionBodyInput } from './projectView';

export type { DrawingProjectionResult, DrawingProjectionViewRequest };

/**
 * The main thread's handle on the drawing projection worker: one worker for
 * the drawing workspace's lifetime. A sheet's missing views go in one
 * request that carries each body's geometry once, so a detailed model is
 * cloned into the worker once per pass, not once per view.
 *
 * Latest wins: at most one request is in the worker and one waits. A newer
 * request replaces the waiting one, which is rejected as an abort, so
 * switching sheets quickly never queues geometry copies or makes the sheet on
 * screen wait behind projections nobody will see. (The worker cannot stop a
 * batch it is already running; that one finishes.) Where workers do not
 * exist (unit tests under happy-dom), projection runs inline.
 */
export class DrawingProjectionClient {
  private worker: Worker | null = null;
  private inFlight: Pending | null = null;
  private waiting: Pending | null = null;

  project(
    bodies: Record<string, ProjectionBodyInput>,
    views: DrawingProjectionViewRequest[]
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
      }
      return Promise.resolve(results);
    }
    return new Promise((resolve, reject) => {
      const request: Pending = {
        requestId: crypto.randomUUID(),
        bodies,
        views,
        resolve,
        reject
      };
      if (!this.inFlight) {
        this.send(request);
        return;
      }
      this.waiting?.reject(abortError('Superseded by a newer projection.'));
      this.waiting = request;
    });
  }

  private send(request: Pending): void {
    this.inFlight = request;
    const message: DrawingProjectionRequest = {
      type: 'project',
      requestId: request.requestId,
      bodies: request.bodies,
      views: request.views
    };
    this.ensureWorker().postMessage(message);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL('../../worker/drawingProjectionWorker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (event: MessageEvent<DrawingProjectionResponse>) => {
      const response = event.data;
      const entry = this.inFlight;
      if (!entry || entry.requestId !== response.requestId) return;
      this.inFlight = null;
      entry.resolve(response.results);
      this.next();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const entry = this.inFlight;
      this.inFlight = null;
      worker.terminate();
      this.worker = null;
      entry?.reject(new Error('The drawing projection worker stopped.'));
      this.next();
    };
    this.worker = worker;
    return worker;
  }

  private next(): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) this.send(waiting);
  }

  dispose(): void {
    const closed = abortError('Drawing closed.');
    this.inFlight?.reject(closed);
    this.waiting?.reject(closed);
    this.inFlight = null;
    this.waiting = null;
    this.worker?.terminate();
    this.worker = null;
  }
}

interface Pending {
  requestId: string;
  bodies: Record<string, ProjectionBodyInput>;
  views: DrawingProjectionViewRequest[];
  resolve: (results: Record<string, DrawingProjectionResult>) => void;
  reject: (error: Error) => void;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
