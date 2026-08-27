import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { CommandManager } from '@openzcad/command-system';
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

  it('respawns a crashed worker so later requests still settle', async () => {
    installWorker();
    const document = createProjectDocument('Respawn', toUserId('user'));
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError
      })
    );

    const orphaned = result.current.syncOnce(document);
    const first = FakeWorker.instances[0]!;
    act(() => {
      first.onerror?.({} as ErrorEvent);
    });

    // The crash rejects what was in flight, announces the restart, and
    // installs a fresh worker.
    await expect(orphaned).rejects.toThrow('Geometry worker crashed');
    expect(first.terminate).toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(2);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Restarting the geometry worker')
    );

    // A request made AFTER the crash reaches the replacement and settles —
    // this is the regression: it used to post into the corpse forever.
    const second = FakeWorker.instances[1]!;
    const followUp = result.current.syncOnce(document);
    expect(second.postMessage).toHaveBeenCalledTimes(1);
    const requestId = (
      second.postMessage.mock.calls[0]![0] as { requestId: string }
    ).requestId;
    act(() => {
      second.emit({
        type: 'sync',
        ok: true,
        projectId: document.projectId,
        version: document.version,
        requestId,
        derived: document.derived
      });
    });
    await expect(followUp).resolves.toEqual(document.derived);
  });

  it('stops respawning after repeated boot failures and fails loudly', () => {
    installWorker();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError
      })
    );

    // Initial worker plus three respawns; the fourth crash exhausts the
    // budget without creating a fifth instance.
    for (let crash = 0; crash < 4; crash += 1) {
      const current = FakeWorker.instances.at(-1)!;
      act(() => {
        current.onerror?.({} as ErrorEvent);
      });
    }

    expect(FakeWorker.instances).toHaveLength(4);
    expect(result.current.state.phase).toBe('failed');
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('reload the page to recover')
    );
  });

  it('routes request-tagged states to that request and not the live document', async () => {
    installWorker();
    const document = createProjectDocument('Progress', toUserId('user'));
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    const onState = vi.fn();
    const exported = result.current.exportModel('3mf', document, [], {
      onState
    });
    const requestId = (
      worker.postMessage.mock.calls[0]![0] as { requestId: string }
    ).requestId;

    const livePhase = result.current.state.phase;
    act(() => {
      worker.emit({
        type: 'state',
        phase: 'rebuilding',
        projectId: document.projectId,
        version: document.version,
        requestId,
        stale: true
      });
    });

    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'rebuilding', requestId })
    );
    expect(result.current.state.phase).toBe(livePhase);

    // Settling the request unsubscribes it: later states go nowhere.
    act(() => {
      worker.emit({
        type: 'export',
        ok: true,
        requestId,
        format: '3mf',
        data: new Uint8Array(new ArrayBuffer(0)),
        warnings: []
      });
      worker.emit({
        type: 'state',
        phase: 'ready',
        projectId: document.projectId,
        version: document.version,
        requestId,
        stale: false
      });
    });
    await exported;
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it('aborting an export rejects it, tells the worker, and drops the late result', async () => {
    installWorker();
    const document = createProjectDocument('Abort', toUserId('user'));
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    const controller = new AbortController();
    const exported = result.current.exportModel('3mf', document, [], {
      signal: controller.signal
    });
    const requestId = (
      worker.postMessage.mock.calls[0]![0] as { requestId: string }
    ).requestId;

    controller.abort();

    await expect(exported).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'cancel',
      requestId
    });

    // The worker was mid-job when the cancel landed; its result must be
    // swallowed, not resolved into a promise that no longer exists.
    act(() => {
      worker.emit({
        type: 'export',
        ok: true,
        requestId,
        format: '3mf',
        data: new Uint8Array(new ArrayBuffer(0)),
        warnings: []
      });
    });
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

  describe('watchdog', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('respawns a silent worker and re-posts the live document sync', () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument('Watchdog', toUserId('user'));
      const manager = { document } as unknown as CommandManager;
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => manager,
          onDerived: vi.fn(),
          onError
        })
      );
      const first = FakeWorker.instances[0]!;
      result.current.sync(document);
      expect(first.postMessage).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(20_000);
      });

      // The silent worker was judged wedged and replaced.
      expect(first.terminate).toHaveBeenCalled();
      expect(FakeWorker.instances).toHaveLength(2);
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('stopped responding')
      );
      // The replacement owes the visible document a rebuild without waiting
      // for the next edit — the regression: a respawn used to sit idle.
      const second = FakeWorker.instances[1]!;
      expect(second.postMessage).toHaveBeenCalledWith({
        type: 'sync',
        document
      });
    });

    it('does not respawn a worker that keeps reporting progress', () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument('Healthy', toUserId('user'));
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError: vi.fn()
        })
      );
      const worker = FakeWorker.instances[0]!;
      result.current.sync(document);
      const state = (phase: 'starting' | 'loading-remus' | 'rebuilding') => ({
        type: 'state' as const,
        phase,
        projectId: document.projectId,
        version: document.version,
        stale: true
      });

      act(() => {
        worker.emit(state('starting'));
        vi.advanceTimersByTime(10_000);
        worker.emit(state('loading-remus'));
        vi.advanceTimersByTime(60_000);
        worker.emit(state('rebuilding'));
        vi.advanceTimersByTime(90_000);
        worker.emit({
          type: 'state',
          phase: 'ready',
          projectId: document.projectId,
          version: document.version,
          stale: false
        });
        vi.advanceTimersByTime(120_000);
      });

      expect(FakeWorker.instances).toHaveLength(1);
      expect(result.current.state.phase).toBe('ready');
    });

    it('leaves an unarmed worker alone when no work was ever posted', () => {
      vi.useFakeTimers();
      installWorker();
      renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError: vi.fn()
        })
      );

      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(FakeWorker.instances).toHaveLength(1);
    });

    it('fails loudly when every respawn goes silent too', () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument('Dead', toUserId('user'));
      const manager = { document } as unknown as CommandManager;
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => manager,
          onDerived: vi.fn(),
          onError
        })
      );
      result.current.sync(document);

      act(() => {
        vi.advanceTimersByTime(80_000);
      });

      // Initial worker plus three silent respawns, then the loud failure.
      expect(FakeWorker.instances).toHaveLength(4);
      expect(result.current.state.phase).toBe('failed');
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('reload the page to recover')
      );
    });

    it('treats a worker the constructor cannot even create as a boot failure', () => {
      class ExplodingWorker {
        constructor() {
          throw new Error('blocked by policy');
        }
      }
      FakeWorker.instances = [];
      vi.stubGlobal('Worker', ExplodingWorker);
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError
        })
      );

      expect(result.current.state.phase).toBe('failed');
      expect(result.current.state.error).toContain('blocked by policy');
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('could not be started')
      );
    });

    it('extends the budget while a request-tagged job holds the queue', () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument('Tagged', toUserId('user'));
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError: vi.fn()
        })
      );
      const worker = FakeWorker.instances[0]!;
      result.current.sync(document);
      act(() => {
        worker.emit({
          type: 'state',
          phase: 'starting',
          projectId: document.projectId,
          version: document.version,
          stale: true
        });
      });
      // An export behind the live sync announces its own rebuild; the live
      // document waits in the queue while that long phase runs silently.
      const requestId = 'tagged-export';
      act(() => {
        worker.emit({
          type: 'state',
          phase: 'rebuilding',
          projectId: document.projectId,
          version: document.version,
          requestId,
          stale: true
        });
        vi.advanceTimersByTime(60_000);
      });

      expect(FakeWorker.instances).toHaveLength(1);

      // Past even the extended budget with no message at all, it respawns.
      act(() => {
        vi.advanceTimersByTime(70_000);
      });
      expect(FakeWorker.instances).toHaveLength(2);
    });
  });
});
