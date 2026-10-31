import {
  projectView,
  projectionBuffers,
  type ProjectionBodyInput,
  type ViewProjection
} from '../lib/drawing/projectView';
import type { DrawingViewOrientation } from '@openzcad/shared';

/** One view to project from the batch's shared bodies. */
export interface DrawingProjectionViewRequest {
  key: string;
  orientation: DrawingViewOrientation;
  hiddenLines: boolean;
  bodyIds: string[];
}

/**
 * Views of one batch. The first message of a batch to a worker carries the
 * batch's bodies, each once however many views draw it; later views of the
 * same batch leave `bodies` out and use the ones the worker holds.
 */
export interface DrawingProjectionRequest {
  type: 'project';
  requestId: string;
  bodies?: Record<string, ProjectionBodyInput>;
  views: DrawingProjectionViewRequest[];
}

/** The batch is done: drop its geometry. */
export interface DrawingProjectionRelease {
  type: 'release';
}

export type DrawingProjectionResult =
  { ok: true; projection: ViewProjection } | { ok: false; error: string };

export interface DrawingProjectionResponse {
  type: 'projection';
  requestId: string;
  results: Record<string, DrawingProjectionResult>;
}

/** The geometry of the batch this worker last received. */
let held: {
  requestId: string;
  bodies: Record<string, ProjectionBodyInput>;
} | null = null;

/**
 * D01 view projection off the main thread. Hidden-line removal tests every
 * edge against every body's triangles, which takes long enough on a detailed
 * part to stall the workspace; here it runs beside it, and several of these
 * workers project a sheet's views side by side. A worker holds one batch's
 * geometry at a time, so a closed sheet simply drops the answer.
 */
self.onmessage = (
  event: MessageEvent<DrawingProjectionRequest | DrawingProjectionRelease>
) => {
  const request = event.data;
  if (request.type === 'release') {
    held = null;
    return;
  }
  if (request.type !== 'project') return;
  if (request.bodies)
    held = { requestId: request.requestId, bodies: request.bodies };
  const bodies =
    held?.requestId === request.requestId ? held.bodies : undefined;
  const results: Record<string, DrawingProjectionResult> = {};
  const transfer: ArrayBuffer[] = [];
  for (const view of request.views) {
    if (!bodies) {
      results[view.key] = {
        ok: false,
        error: "The view's geometry did not reach the projection worker."
      };
      continue;
    }
    try {
      const projection = projectView({
        orientation: view.orientation,
        hiddenLines: view.hiddenLines,
        bodies: view.bodyIds.flatMap((id) => {
          const body = bodies[id];
          return body ? [body] : [];
        })
      });
      results[view.key] = { ok: true, projection };
      for (const buffer of projectionBuffers(projection))
        transfer.push(buffer as ArrayBuffer);
    } catch (error) {
      results[view.key] = {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'The view could not be projected.'
      };
    }
  }
  const response: DrawingProjectionResponse = {
    type: 'projection',
    requestId: request.requestId,
    results
  };
  self.postMessage(response, { transfer });
};
