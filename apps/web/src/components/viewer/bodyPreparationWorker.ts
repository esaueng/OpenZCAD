import type { GeometryBodyRepresentation } from '@openzcad/shared';
import { prepareBody } from './prepareBody';

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
    const prepared = bodies.map(prepareBody);
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
