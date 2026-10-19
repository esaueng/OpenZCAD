import type {
  DrawingProjectionRequest,
  DrawingProjectionResponse
} from '../../worker/drawingProjectionWorker';
import {
  projectView,
  type ViewProjection,
  type ViewProjectionInput
} from './projectView';

/**
 * The main thread's handle on the drawing projection worker: one worker for
 * the drawing workspace's lifetime, requests answered in any order. Where
 * workers do not exist (unit tests under happy-dom), projection runs inline.
 */
export class DrawingProjectionClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<
    string,
    {
      resolve: (projection: ViewProjection) => void;
      reject: (error: Error) => void;
    }
  >();

  project(input: ViewProjectionInput): Promise<ViewProjection> {
    if (typeof Worker === 'undefined') {
      try {
        return Promise.resolve(projectView(input));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
    const worker = this.ensureWorker();
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const request: DrawingProjectionRequest = {
        type: 'project',
        requestId,
        input
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
      if (response.ok) entry.resolve(response.projection);
      else entry.reject(new Error(response.error));
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
