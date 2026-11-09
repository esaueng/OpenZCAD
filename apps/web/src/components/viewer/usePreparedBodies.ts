import { useEffect, useRef, useState } from 'react';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import {
  preparedBodies,
  type PreparedBody
} from '../../../../../packages/viewport/src/render/preparedBody';

import { denseBodyNeedsPreparation } from './bodyPreparationPolicy';

/** Small meshes stay synchronous; dense previews prepare without blocking input. */
const empty: readonly GeometryBodyRepresentation[] = [];

export function usePreparedBodies(
  source: readonly GeometryBodyRepresentation[]
) {
  const [ready, setReady] = useState<{
    source: readonly GeometryBodyRepresentation[];
    bodies: readonly GeometryBodyRepresentation[];
  }>({ source: empty, bodies: empty });
  const workerRef = useRef<Worker | null>(null);
  const serial = useRef(0);
  const [unavailable, setUnavailable] = useState(false);
  const pending =
    !unavailable &&
    source.some(
      (body) => denseBodyNeedsPreparation(body) && !preparedBodies.has(body)
    );

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (!pending) {
      setReady({ source, bodies: source });
      return;
    }
    let worker = workerRef.current;
    if (!worker) {
      try {
        worker = new Worker(
          new URL('./bodyPreparationWorker.ts', import.meta.url),
          { type: 'module' }
        );
        worker.onerror = () => setUnavailable(true);
        workerRef.current = worker;
      } catch {
        setUnavailable(true);
        return;
      }
    }
    const id = ++serial.current;
    const bodies = source.filter(
      (body) => denseBodyNeedsPreparation(body) && !preparedBodies.has(body)
    );
    const receive = (
      event: MessageEvent<{
        id: number;
        prepared?: PreparedBody[];
        error?: string;
        preparationMs?: number;
      }>
    ) => {
      if (event.data.id !== id) return;
      if (
        !event.data.prepared ||
        event.data.prepared.length !== bodies.length
      ) {
        // Preserve the synchronous renderer when workers are unsupported or fail.
        setUnavailable(true);
        return;
      }
      for (let index = 0; index < bodies.length; index++)
        preparedBodies.set(bodies[index]!, event.data.prepared[index]!);
      performance.mark?.('oz:viewer.prepared', {
        detail: {
          workerMs: event.data.preparationMs ?? null,
          bodies: bodies.length
        }
      });
      setReady({ source, bodies: source });
    };
    worker.addEventListener('message', receive);
    // Do not transfer authoritative mesh buffers: picking, export and undo own them.
    try {
      worker.postMessage({ id, bodies });
    } catch {
      setUnavailable(true);
    }
    return () => worker.removeEventListener('message', receive);
  }, [source, pending]);

  useEffect(
    () => () => {
      // Keep preparation bounded to this input set, not the undo/history lifetime.
      for (const body of source) preparedBodies.delete(body);
    },
    [source]
  );

  // Never carry geometry into another document/body set while a worker finishes.
  const sameBodies =
    ready.bodies.length === source.length &&
    ready.bodies.every((body, index) => body.bodyId === source[index]?.bodyId);
  const preparing = pending && ready.source !== source;
  return {
    bodies: preparing ? (sameBodies ? ready.bodies : empty) : source,
    preparing
  };
}
