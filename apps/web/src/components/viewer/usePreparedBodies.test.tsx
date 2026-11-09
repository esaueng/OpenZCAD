import { useLayoutEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBodyId, type GeometryBodyRepresentation } from '@openzcad/shared';
import {
  preparedBodies,
  type PreparedBody
} from '../../../../../packages/viewport/src/render/preparedBody';
import type { FaceDragTraceEvent } from '../../lib/faceDragTrace';
import { denseBodyNeedsPreparation } from './bodyPreparationPolicy';
import {
  BODY_PREPARATION_TIMEOUT_MS,
  usePreparedBodies
} from './usePreparedBodies';

function body(id = 'part', triangles = 20_001): GeometryBodyRepresentation {
  return {
    bodyId: toBodyId(id),
    name: id,
    source: 'primitive',
    color: '#334455',
    faceCount: 1,
    consumed: false,
    exportableStep: true,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(9),
      indices: new Uint32Array(triangles * 3)
    }
  };
}
class FakeWorker {
  static instances: FakeWorker[] = [];
  postMessage =
    vi.fn<
      (message: { id: number; bodies: GeometryBodyRepresentation[] }) => void
    >();
  terminate = vi.fn();
  onerror?: () => void;
  onmessageerror?: () => void;
  onmessage?: (event: MessageEvent) => void;
  constructor() {
    FakeWorker.instances.push(this);
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  complete(prepared: PreparedBody[] = [preparation]) {
    const { id } = this.postMessage.mock.lastCall![0] as { id: number };
    act(() => this.reply({ id, prepared }));
  }
}
const preparation = {
  geometry: {},
  tangentIds: new Set(),
  silhouettes: null
} as PreparedBody;
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});
function start() {
  vi.stubGlobal('Worker', FakeWorker);
  const source = [body()];
  const view = renderHook(({ source }) => usePreparedBodies(source), {
    initialProps: { source }
  });
  const next = [body()];
  view.rerender({ source: next });
  return { view, source, next, worker: FakeWorker.instances[0]! };
}

describe('dense body preparation', () => {
  it('keeps small and large facet-reference bodies on their direct upload path', () => {
    expect(denseBodyNeedsPreparation(body('small', 20_000))).toBe(false);
    expect(
      denseBodyNeedsPreparation({
        ...body('large', 500_000),
        meshReference: true
      })
    ).toBe(false);
    vi.stubGlobal('Worker', FakeWorker);
    const source = [body('small', 10)];
    const view = renderHook(() => usePreparedBodies(source));
    expect(view.result.current).toMatchObject({
      bodies: source,
      preparing: false
    });
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('never reposts unchanged dense A when only B changes, including while in flight', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const a = body('A');
    const source = [a, body('B')];
    const view = renderHook(({ source }) => usePreparedBodies(source), {
      initialProps: { source }
    });
    const cached = preparedBodies.get(a);
    expect(cached).toBeDefined();
    view.rerender({ source: [a, body('B')] });
    const worker = FakeWorker.instances[0]!;
    const latest = [a, body('B')];
    view.rerender({ source: latest });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.complete();
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    worker.complete();
    for (const [message, ...transfer] of worker.postMessage.mock.calls) {
      expect(
        message.bodies.map((b: GeometryBodyRepresentation) => b.bodyId)
      ).toEqual(['B']);
      expect(transfer).toHaveLength(0);
    }
    expect(preparedBodies.get(a)).toBe(cached);
    expect(view.result.current.bodies).toBe(latest);
  });
  it('shows and caches intermediate replies, skips unsent ticks, and never regresses', () => {
    const { view, source, next, worker } = start();
    expect(view.result.current.bodies).toBe(source);
    const skipped = [body()];
    view.rerender({ source: skipped });
    const latest = [body()];
    view.rerender({ source: latest });
    worker.complete();
    expect(preparedBodies.get(next[0]!)).toBe(preparation);
    expect(view.result.current).toMatchObject({
      bodies: next,
      preparing: true
    });
    expect(worker.postMessage.mock.lastCall![0].bodies).toEqual(latest);
    worker.complete();
    expect(view.result.current).toMatchObject({
      bodies: latest,
      preparing: false
    });
    // Late duplicate reply is harmless and cannot rewind the display.
    act(() => worker.reply({ id: 1, prepared: [preparation] }));
    expect(view.result.current.bodies).toBe(latest);
    view.unmount();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('never blanks first open, add, merge, split, delete, undo or document replacement', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const initial = [body('A')];
    const view = renderHook(({ source }) => usePreparedBodies(source), {
      initialProps: { source: initial }
    });
    expect(view.result.current).toMatchObject({
      bodies: initial,
      preparing: false
    });
    const added = [initial[0]!, body('B')];
    const merged = [body('merged')];
    const split = [body('left'), body('right')];
    for (const source of [
      added,
      merged,
      split,
      [split[0]!],
      initial,
      [body('other document')]
    ]) {
      view.rerender({ source });
      expect(view.result.current.bodies).toBe(source);
      expect(view.result.current.preparing).toBe(false);
    }
    expect(FakeWorker.instances).toHaveLength(0);
    view.rerender({ source: [] });
    expect(view.result.current.bodies).toHaveLength(0); // An actually empty document.
  });
  it('caches old replies without displaying a prior body set after a synchronous structural change', () => {
    const { view, next, worker } = start();
    const replacement = [body('new')];
    view.rerender({ source: replacement });
    worker.complete();
    expect(preparedBodies.get(next[0]!)).toBe(preparation);
    expect(view.result.current).toMatchObject({
      bodies: replacement,
      preparing: false
    });
  });
  it.each(['reply', 'error', 'messageerror', 'timeout', 'post'] as const)(
    'recovers from worker %s without withholding current or later geometry',
    (failure) => {
      vi.useFakeTimers();
      const { view, worker, next } = start();
      act(() => {
        if (failure === 'reply') worker.reply({ id: 1, error: 'failed' });
        if (failure === 'error') worker.onerror!();
        if (failure === 'messageerror') worker.onmessageerror!();
        if (failure === 'timeout') {
          // Churning input must not restart the in-flight deadline.
          vi.advanceTimersByTime(BODY_PREPARATION_TIMEOUT_MS - 1);
          view.rerender({ source: [body()] });
          vi.advanceTimersByTime(1);
        }
        if (failure === 'post') {
          worker.postMessage.mockImplementation(() => {
            throw new Error('clone failed');
          });
          view.rerender({ source: [body()] });
          worker.complete();
        }
      });
      expect(view.result.current.preparing).toBe(false);
      if (failure !== 'timeout' && failure !== 'post')
        expect(view.result.current.bodies).toBe(next);
      expect(worker.terminate).toHaveBeenCalledOnce();
      const later = [body()];
      view.rerender({ source: later });
      expect(view.result.current).toMatchObject({
        bodies: later,
        preparing: false
      });
      expect(FakeWorker.instances).toHaveLength(1);
    }
  );
  it('falls back if worker construction is unsupported', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('unsupported');
        }
      }
    );
    const source = [body()];
    const view = renderHook(({ source }) => usePreparedBodies(source), {
      initialProps: { source }
    });
    const next = [body()];
    view.rerender({ source: next });
    expect(view.result.current).toMatchObject({
      bodies: next,
      preparing: false
    });
  });
  it('does not post an empty request if preparation lands between render and effects', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const source = [body()];
    const view = renderHook(
      ({ source, cacheInLayout }) => {
        const result = usePreparedBodies(source);
        useLayoutEffect(() => {
          if (cacheInLayout) preparedBodies.set(source[0]!, preparation);
        }, [source, cacheInLayout]);
        return result;
      },
      { initialProps: { source, cacheInLayout: false } }
    );
    const next = [body()];
    view.rerender({ source: next, cacheInLayout: true });
    expect(view.result.current).toMatchObject({
      bodies: next,
      preparing: false
    });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('records the main-thread post/copy duration separately from installation', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const trace: FaceDragTraceEvent[] = [];
    const scope = window as unknown as { __ozFaceDragTrace?: unknown[] };
    scope.__ozFaceDragTrace = trace;
    try {
      const source = [body()];
      const view = renderHook(({ source }) => usePreparedBodies(source), {
        initialProps: { source }
      });
      view.rerender({ source: [body()] });
      expect(trace).toEqual([
        expect.objectContaining({
          kind: 'prepare-post',
          detail: { bodies: 1 }
        })
      ]);
      expect(trace[0]!.ms).toBeGreaterThanOrEqual(0);
    } finally {
      delete scope.__ozFaceDragTrace;
    }
  });

  it('clears the deadline on completion and unmount', () => {
    vi.useFakeTimers();
    const { view, worker } = start();
    worker.complete();
    act(() => {
      vi.advanceTimersByTime(BODY_PREPARATION_TIMEOUT_MS);
    });
    expect(worker.terminate).not.toHaveBeenCalled();
    view.rerender({ source: [body()] });
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('holds selection/highlight/handle props with the displayed projection, including intermediate replies', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const original = [body()];
    const first = { selection: 'face-1', handle: 'handle-1' };
    const view = renderHook(
      ({ source, props }) => usePreparedBodies(source, props),
      {
        initialProps: { source: original, props: first }
      }
    );
    const picked = { selection: 'picked-face', handle: 'picked-handle' };
    view.rerender({ source: original, props: picked });
    const next = [body()];
    const second = { selection: 'face-2', handle: 'handle-2' };
    view.rerender({ source: next, props: second });
    expect(view.result.current.presentation).toBe(picked);
    const latest = [body()];
    const third = { selection: 'face-3', handle: 'handle-3' };
    view.rerender({ source: latest, props: third });
    const worker = FakeWorker.instances[0]!;
    worker.complete();
    expect(view.result.current.bodies).toBe(next);
    expect(view.result.current.presentation).toBe(second);
    worker.complete();
    expect(view.result.current.bodies).toBe(latest);
    expect(view.result.current.presentation).toBe(third);
  });
});
