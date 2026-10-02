import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toBodyId, toUserId } from '@openzcad/shared';
import type { GeometryWorkerResult } from '../worker/geometryWorker';
import { useGeometryWorker } from './useGeometryWorker';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<GeometryWorkerResult>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  emit(message: GeometryWorkerResult) {
    this.onmessage?.({ data: message } as MessageEvent<GeometryWorkerResult>);
  }
}

function installWorker() {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useGeometryWorker lineage demand', () => {
  it('posts demand on broadcast syncs and dedupes per version+demand', () => {
    installWorker();
    const document = createProjectDocument('Demand sync', toUserId('user'));
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const bodyId = toBodyId('body_demanded');

    result.current.sync(document);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'sync' })
    );

    result.current.sync(document, [bodyId]);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'sync', lineageDemand: [bodyId] })
    );

    // Same version+demand does not re-post.
    const calls = worker.postMessage.mock.calls.length;
    result.current.sync(document, [bodyId]);
    expect(worker.postMessage.mock.calls.length).toBe(calls);
  });

  it('gives one-off syncs full lineage unless they ask for a demand', async () => {
    installWorker();
    const document = createProjectDocument('Demand once', toUserId('user'));
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const bodyId = toBodyId('body_demanded');

    result.current.sync(document, [bodyId]);
    // A preview, preflight or demo seed reads lineage from the result, so it
    // must not opt into the idle skip just because the viewport demanded.
    const pending = result.current.syncOnce(document);
    const request = worker.postMessage.mock.calls.at(-1)![0] as {
      requestId: string;
      lineageDemand?: unknown;
    };
    expect(request.lineageDemand).toBeUndefined();
    // Left unanswered; it rejects when the hook unmounts.
    result.current
      .syncOnce(document, undefined, [bodyId])
      .catch(() => undefined);
    const explicit = worker.postMessage.mock.calls.at(-1)![0] as {
      lineageDemand?: unknown;
    };
    expect(explicit.lineageDemand).toEqual([bodyId]);
    act(() => {
      worker.emit({
        type: 'sync',
        ok: true,
        requestId: request.requestId,
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      });
    });
    await expect(pending).resolves.toEqual(document.derived);
  });
});
