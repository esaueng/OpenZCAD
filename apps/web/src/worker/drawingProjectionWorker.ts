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
 * Every view a sheet still needs, with each body's geometry carried once
 * however many views draw it.
 */
export interface DrawingProjectionRequest {
  type: 'project';
  requestId: string;
  bodies: Record<string, ProjectionBodyInput>;
  views: DrawingProjectionViewRequest[];
}

export type DrawingProjectionResult =
  { ok: true; projection: ViewProjection } | { ok: false; error: string };

export interface DrawingProjectionResponse {
  type: 'projection';
  requestId: string;
  results: Record<string, DrawingProjectionResult>;
}

/**
 * D01 view projection off the main thread. Hidden-line removal tests every
 * edge against every body's triangles, which takes long enough on a detailed
 * part to stall the workspace; here it runs beside it. Stateless: each
 * request carries the bodies it projects, so a closed sheet simply drops the
 * answer.
 */
self.onmessage = (event: MessageEvent<DrawingProjectionRequest>) => {
  const request = event.data;
  if (request.type !== 'project') return;
  const results: Record<string, DrawingProjectionResult> = {};
  const transfer: ArrayBuffer[] = [];
  for (const view of request.views) {
    try {
      const projection = projectView({
        orientation: view.orientation,
        hiddenLines: view.hiddenLines,
        bodies: view.bodyIds.flatMap((id) => {
          const body = request.bodies[id];
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
