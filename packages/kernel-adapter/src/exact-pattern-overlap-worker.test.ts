import { expect, it, vi } from 'vitest';
import { transformMatrix } from './exact-math';
import { MEASUREMENT_DEFLECTION } from './measurement-deflection';
import type { PatternOverlapRequest } from './pattern-overlap-workers';
import { RemusKernel } from './remus-runtime';

it('keeps the other exact intersections when a pair in the same request is refused', async () => {
  const scope: {
    onmessage?: (event: MessageEvent<PatternOverlapRequest>) => Promise<void>;
    postMessage: ReturnType<typeof vi.fn>;
  } = { postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  const kernel = new RemusKernel();
  try {
    const stock = kernel.makeCylinder(5, 10);
    const placedPair = (x: number) => {
      const copy = kernel.copyAndTransformSolid(
        stock,
        transformMatrix({ x, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
      );
      const bytes = kernel.serializeSolids(Uint32Array.of(stock, copy));
      const result = kernel.booleanWithQuality('intersect', stock, copy, true);
      expect(result.quality).toBe('exact');
      return {
        bytes,
        volume: kernel.volume(result.solid, MEASUREMENT_DEFLECTION)
      };
    };
    const first = placedPair(6);
    const last = placedPair(7);
    await import('./exact-pattern-overlap-worker');
    await scope.onmessage!(
      new MessageEvent('message', {
        data: { pairs: [first.bytes, new Uint8Array(), last.bytes] }
      })
    );
    expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({
      volumes: [first.volume, null, last.volume]
    });
  } finally {
    kernel.free();
    vi.unstubAllGlobals();
  }
});

it('warms locally after a receiver-side clone failure and refuses an unreadable work request', async () => {
  const worker = {
    postMessage: vi.fn(),
    onmessageerror: undefined as (() => void) | undefined
  };
  vi.resetModules();
  vi.stubGlobal('self', worker);
  try {
    await import('./exact-pattern-overlap-worker');
    worker.onmessageerror!();
    await vi.waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({ volumes: [] })
    );
    worker.onmessageerror!();
    expect(worker.postMessage).toHaveBeenLastCalledWith({ volumes: null });
  } finally {
    vi.unstubAllGlobals();
  }
});
