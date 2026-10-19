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
 * cloned into the worker once per pass, not once per view. Where workers do
 * not exist (unit tests under happy-dom), projection runs inline.
 */
export class DrawingProjectionClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (results: Record<string, DrawingProjectionResult>) => void;
      reject: (error: Error) => void;
    }
  >();

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
    const worker = this.ensureWorker();
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const request: DrawingProjectionRequest = {
        type: 'project',
        requestId,
        bodies,
        views
      };
      worker.postMessage(request);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL('../../worker/drawingProjectionWorker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (event: MessageEvent<DrawingProjectionResponse>) => {
      const response = event.data;
      const entry = this.pending.get(response.requestId);
      if (!entry) return;
      this.pending.delete(response.requestId);
      entry.resolve(response.results);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.failAll(new Error('The drawing projection worker stopped.'));
      worker.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  dispose(): void {
    const closed = new Error('Drawing closed.');
    closed.name = 'AbortError';
    this.failAll(closed);
    this.worker?.terminate();
    this.worker = null;
  }
}
