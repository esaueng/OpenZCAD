import {
  projectView,
  type ViewProjection,
  type ViewProjectionInput
} from '../lib/drawing/projectView';

export interface DrawingProjectionRequest {
  type: 'project';
  requestId: string;
  input: ViewProjectionInput;
}

export type DrawingProjectionResponse =
  | {
      type: 'projection';
      requestId: string;
      ok: true;
      projection: ViewProjection;
    }
  | { type: 'projection'; requestId: string; ok: false; error: string };

/**
 * D01 view projection off the main thread. Hidden-line removal samples every
 * edge against every body's triangles, which takes long enough on a detailed
 * part to stall the workspace; here it runs beside it. Stateless: each
 * request carries the bodies it projects, so a cancelled sheet simply drops
 * the answer.
 */
self.onmessage = (event: MessageEvent<DrawingProjectionRequest>) => {
  const request = event.data;
  if (request.type !== 'project') return;
  let response: DrawingProjectionResponse;
  try {
    const projection = projectView(request.input);
    response = {
      type: 'projection',
      requestId: request.requestId,
      ok: true,
      projection
    };
    self.postMessage(response, {
      transfer: [...projection.visible, ...projection.hidden].map(
        (line) => line.buffer
      )
    });
    return;
  } catch (error) {
    response = {
      type: 'projection',
      requestId: request.requestId,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'The view could not be projected.'
    };
  }
  self.postMessage(response);
};
