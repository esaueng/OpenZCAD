import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBodyId, type GeometryBodyRepresentation } from '@openzcad/shared';
import {
  preparedBodies,
  type PreparedBody
} from '../../../../../packages/viewport/src/render/preparedBody';
import { denseBodyNeedsPreparation } from './bodyPreparationPolicy';
import { usePreparedBodies } from './usePreparedBodies';

function body(id = 'part', triangles = 20_001) {
  return {
    bodyId: toBodyId(id),
    mesh: {
      vertices: new Float32Array(9),
      indices: new Uint32Array(triangles * 3)
    }
  } as GeometryBodyRepresentation;
}
class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners = new Set<(event: MessageEvent) => void>();
  postMessage = vi.fn();
  terminate = vi.fn();
  onerror?: () => void;
  constructor() {
    FakeWorker.instances.push(this);
  }
  addEventListener(_name: string, listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_name: string, listener: (event: MessageEvent) => void) {
    this.listeners.delete(listener);
  }
  reply(data: unknown) {
    for (const listener of this.listeners) listener({ data } as MessageEvent);
  }
}
const prepared = {
  geometry: {},
  tangentIds: new Set(),
  silhouettes: null
} as PreparedBody;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

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
    const result = renderHook(() => usePreparedBodies(source));
    expect(result.result.current).toEqual({ bodies: source, preparing: false });
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it('installs only current replies and never transfers authoritative buffers', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const first = [body()];
    const next = [body()];
    const view = renderHook(({ source }) => usePreparedBodies(source), {
      initialProps: { source: first }
    });
    const worker = FakeWorker.instances[0]!;
    expect(view.result.current.preparing).toBe(true);
    expect(view.result.current.bodies).toHaveLength(0);
    expect(worker.postMessage.mock.calls[0]).toHaveLength(1);
    view.rerender({ source: next });
    act(() => worker.reply({ id: 1, prepared: [prepared] }));
    expect(preparedBodies.has(first[0]!)).toBe(false);
    expect(view.result.current.preparing).toBe(true);
    act(() => worker.reply({ id: 2, prepared: [prepared] }));
    expect(preparedBodies.get(next[0]!)).toBe(prepared);
    expect(view.result.current).toEqual({ bodies: next, preparing: false });
    const third = [body()];
    view.rerender({ source: third });
    expect(view.result.current).toEqual({ bodies: next, preparing: true });
    view.rerender({ source: [body('another document')] });
    expect(view.result.current.bodies).toHaveLength(0);
    view.unmount();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('falls back to the existing renderer on a worker failure', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const source = [body()];
    const view = renderHook(() => usePreparedBodies(source));
    act(() => FakeWorker.instances[0]!.reply({ id: 1, error: 'failed' }));
    expect(view.result.current).toEqual({ bodies: source, preparing: false });
  });
});
