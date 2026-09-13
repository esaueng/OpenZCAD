import { afterEach, describe, expect, it, vi } from 'vitest';
import { onStaleChunk, STALE_CHUNK_MESSAGE } from './staleChunk';
import { describeWorkerFailure } from './workerFailure';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('worker failures across deployments', () => {
  it('offers a reload for a generic crash when the running bundle was replaced', async () => {
    vi.stubEnv('OZ_BUILD_COMMIT', 'old');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ commit: 'new' }) }))
    );
    const listener = vi.fn();
    const stop = onStaleChunk(listener);
    try {
      expect(await describeWorkerFailure('Worker crashed.')).toEqual({
        message: STALE_CHUNK_MESSAGE,
        reloadRequired: true
      });
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it.each(['same build', 'offline'])(
    'preserves the crash diagnosis when %s',
    async (scenario) => {
      vi.stubEnv('OZ_BUILD_COMMIT', 'same');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (scenario === 'offline') throw new TypeError('Offline');
          return { ok: true, json: async () => ({ commit: 'same' }) };
        })
      );
      const listener = vi.fn();
      const stop = onStaleChunk(listener);
      try {
        expect(await describeWorkerFailure('Worker crashed.')).toEqual({
          message: 'Worker crashed.',
          reloadRequired: false
        });
        expect(listener).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    }
  );

  it('recognizes a worker dynamic import failure even without metadata', async () => {
    vi.stubEnv('OZ_BUILD_COMMIT', '');
    expect(
      await describeWorkerFailure(
        'Failed to fetch dynamically imported module: /assets/exact-old.js'
      )
    ).toEqual({ message: STALE_CHUNK_MESSAGE, reloadRequired: true });
  });
});
