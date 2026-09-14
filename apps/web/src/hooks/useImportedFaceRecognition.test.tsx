import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
  type FaceRecognitionSummary
} from '@openzcad/shared';
import {
  recognitionCacheKey,
  useImportedFaceRecognition
} from './useImportedFaceRecognition';

const bodyId = toBodyId('body_imported');

function summary(): FaceRecognitionSummary {
  return {
    kind: 'recognized',
    featureKind: 'counterbore',
    message: 'Counterbore recognized from the imported STEP body.',
    dimensions: {
      outerDiameter: 10,
      innerDiameter: 5,
      counterboreDepth: 2,
      totalDepth: 6
    }
  };
}

describe('useImportedFaceRecognition', () => {
  it.each([false, true])(
    'settles a StrictMode request (failure: %s)',
    async (fails) => {
      const document = createProjectDocument('Imported', toUserId('user'));
      const geometry = {
        recognizeImportedFace: vi.fn(async () => {
          if (fails) throw new Error('worker gone');
          return summary();
        })
      };
      const cache = new Map<string, FaceRecognitionSummary>();
      const { result } = renderHook(
        () =>
          useImportedFaceRecognition(
            geometry,
            document,
            { bodyId, faceHash: 701 },
            cache
          ),
        { wrapper: StrictMode }
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.pending).toBe(false);
      expect(result.current.summary).toEqual(fails ? null : summary());
      expect(result.current.error).toBe(fails ? 'worker gone' : null);
      expect(cache.size).toBe(fails ? 0 : 1);
    }
  );

  it('ignores a cancelled response when the same face is selected again', async () => {
    const document = createProjectDocument('Imported', toUserId('user'));
    const resolvers: Array<(value: FaceRecognitionSummary) => void> = [];
    const geometry = {
      recognizeImportedFace: vi.fn(
        () =>
          new Promise<FaceRecognitionSummary>((resolve) => {
            resolvers.push(resolve);
          })
      )
    };
    const cache = new Map<string, FaceRecognitionSummary>();
    const { result, rerender } = renderHook(
      ({ hash }) =>
        useImportedFaceRecognition(
          geometry,
          document,
          { bodyId, faceHash: hash },
          cache
        ),
      { initialProps: { hash: 701 } }
    );
    rerender({ hash: 702 });
    rerender({ hash: 701 });

    await act(async () => {
      resolvers[0]!({ ...summary(), message: 'Cancelled' });
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.summary).toBeNull();
    expect(cache.size).toBe(0);
    await act(async () => {
      resolvers[2]!(summary());
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.summary).toEqual(summary());
    await act(async () => {
      resolvers[1]!({ ...summary(), message: 'Other face' });
    });
    expect(result.current.summary).toEqual(summary());
    expect(cache.size).toBe(1);
  });

  it('keys the cache by body and face identity', () => {
    expect(recognitionCacheKey(bodyId, 701, 'face:701')).toBe(
      'body_imported:face:701:701'
    );
    // Two faces sharing one hash must not share a cache entry: answering
    // from the other's query would be a wrong-face hit.
    expect(recognitionCacheKey(bodyId, 7, 'face:a')).not.toBe(
      recognitionCacheKey(bodyId, 7, 'face:b')
    );
  });

  it('queries once per document version and serves reselection from the cache', async () => {
    const document = createProjectDocument('Imported', toUserId('user'));
    const geometry = { recognizeImportedFace: vi.fn(async () => summary()) };
    const cache = new Map<string, FaceRecognitionSummary>();
    const query = { bodyId, faceHash: 701, topologyId: 'face:701' };

    const { result, rerender } = renderHook(
      ({ doc }) => useImportedFaceRecognition(geometry, doc, query, cache),
      { initialProps: { doc: document } }
    );
    expect(result.current.pending).toBe(true);
    expect(result.current.summary).toBeNull();

    await act(async () => {
      await Promise.resolve();
    });
    expect(geometry.recognizeImportedFace).toHaveBeenCalledTimes(1);
    expect(geometry.recognizeImportedFace).toHaveBeenCalledWith({
      document,
      bodyId,
      faceHash: 701,
      topologyId: 'face:701'
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.summary).toEqual(summary());

    // Reselecting the same face is a cache hit: no second worker query.
    rerender({ doc: document });
    expect(geometry.recognizeImportedFace).toHaveBeenCalledTimes(1);
    expect(result.current.summary).toEqual(summary());

    // A new document version drops the entry: hashes are rebuild-local and
    // the geometry may have moved.
    rerender({ doc: { ...document, version: document.version + 1 } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(geometry.recognizeImportedFace).toHaveBeenCalledTimes(2);
  });

  it('does not query without a selected face', () => {
    const document = createProjectDocument('Imported', toUserId('user'));
    const geometry = { recognizeImportedFace: vi.fn() };
    const { result } = renderHook(() =>
      useImportedFaceRecognition(geometry, document, null, new Map())
    );
    expect(result.current).toEqual({
      summary: null,
      pending: false,
      error: null
    });
    expect(geometry.recognizeImportedFace).not.toHaveBeenCalled();
  });

  it('surfaces a worker transport failure without caching it', async () => {
    const document = createProjectDocument('Imported', toUserId('user'));
    const geometry = {
      recognizeImportedFace: vi.fn(async () => {
        throw new Error('worker gone');
      })
    };
    const cache = new Map<string, FaceRecognitionSummary>();
    const { result } = renderHook(() =>
      useImportedFaceRecognition(
        geometry,
        document,
        { bodyId, faceHash: 702 },
        cache
      )
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.summary).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBe('worker gone');
    expect(cache.size).toBe(0);
  });
});
