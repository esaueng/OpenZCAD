import { observeWorker } from '../../lib/diagnosticSignal';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import {
  preparedBodies,
  type PreparedBody
} from '../../../../../packages/viewport/src/render/preparedBody';
import { traceFaceDrag } from '../../lib/faceDragTrace';
import {
  sameBodyRenderGeometry,
  sameBodyPickingTopology
} from '../../../../../packages/viewport/src/render/scene';
import { denseBodyNeedsPreparation } from './bodyPreparationPolicy';
import { prepareBody } from './prepareBody';
import { RestoredMeshPreparation } from './restoredMeshPreparation';

// A lost worker must not hold revision readiness (or a stale frame) indefinitely.
export const BODY_PREPARATION_TIMEOUT_MS = 5_000;
type Bodies = readonly GeometryBodyRepresentation[];
interface Snapshot<T> {
  id: number;
  source: Bodies;
  presentation: T;
}
interface Request<T> extends Snapshot<T> {
  bodies: GeometryBodyRepresentation[];
  timeout: ReturnType<typeof setTimeout>;
}
function sameBodySet(a: Bodies, b: Bodies) {
  const ids = new Set(a.map((body) => body.bodyId));
  return a.length === b.length && b.every((body) => ids.has(body.bodyId));
}

function createPreparationWorker(): Worker {
  return observeWorker(
    new Worker(new URL('./bodyPreparationWorker.ts', import.meta.url), {
      type: 'module'
    })
  );
}

/** Dense replacements prepare off-thread; displayed geometry and its props travel together. */
export function usePreparedBodies<T = undefined>(
  source: Bodies,
  presentation?: T,
  editingSketch = false
) {
  const [ready, setReady] = useState<Snapshot<T | undefined>>({
    id: 0,
    source,
    presentation
  });
  const [restored] = useState(() => new RestoredMeshPreparation());
  const latestSource = useRef(source);
  const displayed = useRef({ source, presentation });
  const workerRef = useRef<Worker | null>(null);
  const warmWorker = useRef<Worker | null>(null);
  const active = useRef<Request<T | undefined> | null>(null);
  const serial = useRef(0);
  const [unavailable, setUnavailable] = useState(false);

  // First open and structural changes cannot borrow an entire old body set.
  // Prepare synchronously once, before the renderer sees it, rather than blanking
  // the scene. Reuse an unchanged display or an exactly matching recent mesh.
  useMemo(() => {
    const previousById = new Map(
      displayed.current.source.map((body) => [body.bodyId, body])
    );
    for (const body of source) {
      const previous = previousById.get(body.bodyId);
      if (
        !denseBodyNeedsPreparation(body) ||
        previous === body ||
        preparedBodies.get(body)?.geometry
      )
        continue;
      const prepared = previous && preparedBodies.get(previous);
      if (
        previous &&
        prepared &&
        sameBodyRenderGeometry(previous, body) &&
        sameBodyPickingTopology(previous, body)
      )
        preparedBodies.set(body, prepared);
      else {
        const cached = restored.restore(body);
        if (cached) preparedBodies.set(body, cached);
      }
    }
    if (
      unavailable ||
      (ready.source !== source && sameBodySet(ready.source, source))
    )
      return;
    for (const body of source)
      if (denseBodyNeedsPreparation(body) && !preparedBodies.has(body)) {
        const prepared = prepareBody(body);
        restored.remember(body, prepared);
        preparedBodies.set(body, prepared);
      }
  }, [source, ready.source, unavailable, restored]);
  const preparing =
    !unavailable &&
    source.some(
      (body) => denseBodyNeedsPreparation(body) && !preparedBodies.has(body)
    );

  // Start the display worker while the user is editing the sketch. Its first
  // replacement mesh can then use the worker as soon as the kernel replies.
  const warmForSketch =
    editingSketch && !unavailable && source.some(denseBodyNeedsPreparation);
  useEffect(() => {
    if (!warmForSketch || workerRef.current) return;
    let worker: Worker;
    try {
      worker = createPreparationWorker();
    } catch {
      return;
    }
    warmWorker.current = worker;
    const discard = () => {
      if (warmWorker.current !== worker) return;
      warmWorker.current = null;
      worker.terminate();
    };
    worker.onerror = discard;
    worker.onmessageerror = discard;
    return discard;
  }, [warmForSketch]);

  useEffect(
    () => () => {
      if (active.current) clearTimeout(active.current.timeout);
      active.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    []
  );

  useEffect(() => {
    // A reply can populate the weak cache between render and this passive effect.
    const bodies = source.filter(
      (body) => denseBodyNeedsPreparation(body) && !preparedBodies.has(body)
    );
    if (!preparing || bodies.length === 0) {
      if (ready.source !== source)
        setReady({ id: ++serial.current, source, presentation });
      return;
    }
    // One in-flight request, then the latest source. This bounds memory, avoids
    // copying an unchanged dense body again, and lets fast drags make progress.
    if (active.current) return;
    const fail = (reason: string) => {
      if (active.current) clearTimeout(active.current.timeout);
      active.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
      performance.mark?.('oz:viewer.preparation-fallback', {
        detail: { reason }
      });
      traceFaceDrag('prepare-fallback', { message: reason });
      setUnavailable(true);
    };
    let worker = workerRef.current;
    if (!worker) {
      try {
        worker = warmWorker.current ?? createPreparationWorker();
        warmWorker.current = null;
        worker.onerror = () => fail('error');
        worker.onmessageerror = () => fail('messageerror');
        worker.onmessage = (
          event: MessageEvent<{
            id: number;
            prepared?: PreparedBody[];
            preparationMs?: number;
          }>
        ) => {
          const request = active.current;
          if (!request) return;
          if (!event.data || typeof event.data.id !== 'number') {
            fail('bad-reply');
            return;
          }
          if (event.data.id !== request.id) return;
          if (
            !Array.isArray(event.data.prepared) ||
            event.data.prepared.length !== request.bodies.length
          ) {
            fail('bad-reply');
            return;
          }
          clearTimeout(request.timeout);
          active.current = null;
          // Cache completed work even if a later source is already waiting.
          request.bodies.forEach((body, index) => {
            const prepared = event.data.prepared![index]!;
            if (latestSource.current === request.source)
              restored.remember(body, prepared);
            preparedBodies.set(body, prepared);
          });
          performance.mark?.('oz:viewer.prepared', {
            detail: {
              workerMs: event.data.preparationMs ?? null,
              bodies: request.bodies.length
            }
          });
          setReady((previous) =>
            request.id > previous.id
              ? {
                  id: request.id,
                  source: request.source,
                  presentation: request.presentation
                }
              : { ...previous }
          );
        };
        workerRef.current = worker;
      } catch {
        fail('construction');
        return;
      }
    }
    const id = ++serial.current;
    active.current = {
      id,
      source,
      presentation,
      bodies,
      timeout: setTimeout(() => fail('timeout'), BODY_PREPARATION_TIMEOUT_MS)
    };
    // Structured cloning copies authoritative mesh/topology on the main thread.
    // Measure it separately from installation; never detach picking/undo buffers.
    const started = performance.now();
    try {
      worker.postMessage({ id, bodies });
      const ms = performance.now() - started;
      performance.mark?.('oz:viewer.preparation-post', {
        detail: { ms, bodies: bodies.length }
      });
      traceFaceDrag('prepare-post', { ms, detail: { bodies: bodies.length } });
    } catch {
      fail('post-failure');
    }
  }, [source, preparing, ready, presentation, restored]);

  const bodies = preparing ? ready.source : source;
  const shownPresentation = preparing
    ? displayed.current.source === ready.source
      ? displayed.current.presentation
      : ready.presentation
    : presentation;
  useLayoutEffect(() => {
    latestSource.current = source;
    displayed.current = { source: bodies, presentation: shownPresentation };
  }, [bodies, shownPresentation, source]);
  return { bodies, presentation: shownPresentation, preparing };
}
