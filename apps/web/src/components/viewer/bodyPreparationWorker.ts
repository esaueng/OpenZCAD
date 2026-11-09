import type { GeometryBodyRepresentation } from '@openzcad/shared';
import { prepareBodyGeometry } from '../../../../../packages/viewport/src/render/scene';
import { silhouetteCandidates } from '../../../../../packages/viewport/src/render/silhouette';
import { facetedSource } from '../../../../../packages/viewport/src/render/edgeOverlay';
import {
  FACETED_JOINT_MAX_ANGLE,
  tangentEdgeIds
} from '../../../../../packages/viewport/src/render/tangentEdges';
import type { PreparedBody } from '../../../../../packages/viewport/src/render/preparedBody';

type Request = { id: number; bodies: GeometryBodyRepresentation[] };
let pending: Request | null = null;
let scheduled = false;
self.onmessage = (event: MessageEvent<Request>) => {
  pending = event.data;
  if (scheduled) return;
  scheduled = true;
  // Drain queued messages first, keeping only the newest superseding frame.
  setTimeout(() => {
    scheduled = false;
    const request = pending!;
    pending = null;
    prepare(request);
  }, 0);
};

function prepare({ id, bodies }: Request) {
  try {
    const started = performance.now();
    const prepared: PreparedBody[] = bodies.map((body) => ({
      geometry: prepareBodyGeometry(body),
      tangentIds: body.topology
        ? tangentEdgeIds(
            body.mesh,
            body.topology,
            facetedSource(body.source) ? FACETED_JOINT_MAX_ANGLE : undefined
          )
        : new Set(),
      silhouettes: body.topology
        ? silhouetteCandidates(body.mesh, body.topology.faces)
        : null
    }));
    const buffers = new Set<ArrayBuffer>();
    const collect = (value: unknown) => {
      if (ArrayBuffer.isView(value)) buffers.add(value.buffer as ArrayBuffer);
      else if (value && typeof value === 'object')
        for (const child of Object.values(value)) collect(child);
    };
    collect(prepared);
    self.postMessage(
      { id, prepared, preparationMs: performance.now() - started },
      { transfer: [...buffers] }
    );
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
