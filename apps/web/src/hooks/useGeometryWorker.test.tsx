import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
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

describe('useGeometryWorker', () => {
  it('marks only a matching broadcast projection as exact-ready', () => {
    installWorker();
    const document = createProjectDocument('Worker state', toUserId('user'));
    const host = {
      manager: () => null,
      onDerived: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;

    expect(result.current.isReadyFor(document)).toBe(false);
    act(() => {
      worker.emit({
        type: 'state',
        phase: 'rebuilding',
        projectId: document.projectId,
        version: document.version,
        stale: true
      });
    });
    expect(result.current.state.phase).toBe('rebuilding');
    expect(result.current.isReadyFor(document)).toBe(false);

    act(() => {
      worker.emit({
        type: 'state',
        phase: 'ready',
        projectId: document.projectId,
        version: document.version,
        stale: false
      });
    });
    expect(result.current.isReadyFor(document)).toBe(true);
    expect(result.current.isReadyFor({ ...document, version: 2 })).toBe(false);
    act(() => result.current.invalidate());
    expect(result.current.state.stale).toBe(true);
    expect(result.current.isReadyFor(document)).toBe(false);
  });

  it('does not let one-off request state overwrite the live document state', () => {
    installWorker();
    const document = createProjectDocument('Live state', toUserId('user'));
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    act(() => {
      worker.emit({
        type: 'state',
        phase: 'ready',
        projectId: document.projectId,
        version: document.version,
        stale: false
      });
      worker.emit({
        type: 'state',
        phase: 'rebuilding',
        projectId: document.projectId,
        version: document.version + 1,
        requestId: 'preview',
        stale: true
      });
    });

    expect(result.current.isReadyFor(document)).toBe(true);
  });

  it('rejects every outstanding promise when the worker terminates', async () => {
    installWorker();
    const document = createProjectDocument('Pending', toUserId('user'));
    const { result, unmount } = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );

    const sync = result.current.syncOnce(document);
    const exported = result.current.exportModel('stl', document, []);
    unmount();

    await expect(sync).rejects.toThrow('Geometry worker closed');
    await expect(exported).rejects.toThrow('Geometry worker closed');
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
