import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectDocument,
  addPrimitiveFeature,
  booleanBodies
} from '@openzcad/document-core';
import { toBodyId, toUserId } from '@openzcad/shared';
import { CommandManager } from '@openzcad/command-system';
import type { GeometryWorkerResult } from '../worker/geometryWorker';
import { useGeometryWorker } from './useGeometryWorker';
import { ProjectionSender } from '../lib/projectionStream';
import { STALE_CHUNK_MESSAGE } from '../lib/staleChunk';
import { geometryContentKey } from '../worker/exactRebuildCache';

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
  vi.unstubAllEnvs();
});

describe('useGeometryWorker', () => {
  it('asks each worker to prepare the kernel once, and never when saving data', () => {
    installWorker();
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    act(() => {
      result.current.prepareKernel?.();
      result.current.prepareKernel?.();
    });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'prepare-kernel' });

    installWorker();
    vi.stubGlobal('navigator', {
      ...navigator,
      connection: { saveData: true }
    });
    const saving = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    act(() => saving.result.current.prepareKernel?.());
    expect(FakeWorker.instances[0]!.postMessage).not.toHaveBeenCalled();
  });

  it('waits for the accepted live projection even when the worker already reports ready', () => {
    installWorker();
    const document = createProjectDocument('Restored model', toUserId('user'));
    const manager = { document } as CommandManager;
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => manager,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    act(() => {
      result.current.sync(document);
      worker.emit({
        type: 'state',
        phase: 'ready',
        projectId: document.projectId,
        version: document.version,
        stale: false
      });
    });
    expect(result.current.state.phase).toBe('ready');
    expect(result.current.isReadyFor(document)).toBe(false);
    act(() =>
      worker.emit({
        type: 'sync',
        ok: true,
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      })
    );
    expect(result.current.isReadyFor(document)).toBe(true);
  });

  it('cancels the live broadcast on close and rebuilds if the same project is reopened', () => {
    installWorker();
    const document = createProjectDocument(
      'Reopened project',
      toUserId('user')
    );
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => null,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    act(() => result.current.sync(document));
    act(() => result.current.sync(null));
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'cancel' });
    act(() => result.current.sync(document));
    expect(worker.postMessage).toHaveBeenCalledTimes(3);
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'sync' })
    );
  });

  it('keeps completed geometry reusable after closing and reopening saved history', () => {
    installWorker();
    const document = createProjectDocument('Completed model', toUserId('user'));
    const manager = { document } as CommandManager;
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => manager,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    act(() => {
      result.current.sync(document);
      worker.emit({
        type: 'sync',
        ok: true,
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      });
      worker.emit({
        type: 'state',
        phase: 'ready',
        projectId: document.projectId,
        version: document.version,
        stale: false
      });
    });
    act(() => result.current.sync(null));
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'cancel' });
    const reopened = { ...document, version: document.version + 1 };
    act(() => {
      expect(result.current.retainReadyGeometry(reopened)).toBe(true);
      manager.document = reopened;
    });
    act(() => result.current.sync(reopened));
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(result.current.isReadyFor(reopened)).toBe(true);
  });

  it.each(['sync', 'projection-delta'] as const)(
    'rebuilds a transient %s result after closing and reopening',
    (messageType) => {
      installWorker();
      const document = createProjectDocument(
        'Missing source',
        toUserId('user')
      );
      const manager = { document } as CommandManager;
      const host = {
        manager: () => manager,
        onDerived: vi.fn(),
        onError: vi.fn()
      };
      const { result } = renderHook(() => useGeometryWorker(host));
      const worker = FakeWorker.instances[0]!;
      act(() => {
        result.current.sync(document);
        worker.emit(
          messageType === 'sync'
            ? {
                type: 'sync',
                ok: true,
                projectId: document.projectId,
                version: document.version,
                transient: true,
                derived: document.derived
              }
            : {
                type: 'projection-delta',
                projectId: document.projectId,
                version: document.version,
                transient: true,
                packet: new ProjectionSender('transient-worker').encode(
                  document.projectId,
                  document.derived
                )
              }
        );
        worker.emit({
          type: 'state',
          phase: 'ready',
          projectId: document.projectId,
          version: document.version,
          stale: false
        });
      });
      expect(host.onDerived).toHaveBeenCalledOnce();
      expect(result.current.retainReadyGeometry(document)).toBe(false);
      act(() => result.current.sync(null));
      expect(result.current.retainReadyGeometry(document)).toBe(false);
      act(() => result.current.sync(document));
      expect(worker.postMessage).toHaveBeenCalledTimes(3);
      expect(worker.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'sync' })
      );
    }
  );

  it.each([false, true])(
    'retains completed live geometry across metadata; invalidates only relevant demand (boolean=%s)',
    (withBoolean) => {
      installWorker();
      let document = createProjectDocument('Saved model', toUserId('user'));
      if (withBoolean) {
        for (const name of ['A', 'B'])
          document = addPrimitiveFeature(document, {
            name,
            primitiveKind: 'box',
            dimensions: { width: 10, height: 8, depth: 6 }
          });
        document = booleanBodies(document, {
          name: 'Union',
          operation: 'union',
          targetBodyIds: [...document.bodyOrder]
        }).document;
      }
      const manager = { document } as CommandManager;
      const host = {
        manager: () => manager,
        onDerived: vi.fn(),
        onError: vi.fn()
      };
      const { result } = renderHook(() => useGeometryWorker(host));
      const worker = FakeWorker.instances[0]!;
      act(() => result.current.sync(document));
      expect(result.current.retainReadyGeometry(document)).toBe(false);
      act(() => {
        worker.emit({
          type: 'state',
          phase: 'ready',
          projectId: document.projectId,
          version: document.version,
          stale: false
        });
        worker.emit({
          type: 'sync',
          ok: true,
          projectId: document.projectId,
          version: document.version,
          derived: document.derived
        });
      });
      const saved = {
        ...document,
        version: document.version + 1,
        checkpoints: [
          ...document.checkpoints,
          { ...document.checkpoints[0]!, reason: 'Before drilling' }
        ]
      };
      act(() => {
        expect(result.current.retainReadyGeometry(saved)).toBe(true);
        manager.document = saved;
      });
      expect(result.current.isReadyFor(saved)).toBe(true);
      act(() => result.current.sync(saved));
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      expect(
        result.current.retainReadyGeometry({ ...saved, name: 'Changed model' })
      ).toBe(false);
      expect(
        result.current.retainReadyGeometry({
          ...saved,
          projectId: 'another-project' as typeof document.projectId
        })
      ).toBe(false);
      act(() => result.current.sync(saved, [toBodyId('new-lineage-demand')]));
      expect(result.current.retainReadyGeometry(saved)).toBe(!withBoolean);
      expect(worker.postMessage).toHaveBeenCalledTimes(withBoolean ? 2 : 1);
    }
  );

  it('cannot reuse persisted display meshes or an invalidated worker result', () => {
    installWorker();
    const document = createProjectDocument('Reloaded model', toUserId('user'));
    const manager = { document } as CommandManager;
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => manager,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    act(() =>
      worker.emit({
        type: 'state',
        phase: 'ready',
        projectId: document.projectId,
        version: document.version,
        stale: false
      })
    );
    expect(result.current.retainReadyGeometry(document)).toBe(false);
    act(() => result.current.sync(document));
    act(() =>
      worker.emit({
        type: 'sync',
        ok: true,
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      })
    );
    act(() => result.current.invalidate());
    expect(result.current.retainReadyGeometry(document)).toBe(false);
  });
  it('routes a mass query by request ID without changing live derived state', async () => {
    installWorker();
    const document = createProjectDocument('Mass query', toUserId('user'));
    const bodyId = toBodyId('body_mass');
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const pending = result.current.massProperties(document, bodyId);
    const request = worker.postMessage.mock.calls.at(-1)![0] as {
      requestId: string;
    };
    expect(request).toMatchObject({ type: 'mass-properties', bodyId });
    const unavailable = {
      status: 'unavailable' as const,
      code: 'unsupported' as const,
      reason: 'No live solid is available.',
      epoch: 7
    };
    act(() => {
      worker.emit({
        type: 'mass-properties',
        ok: true,
        requestId: request.requestId,
        result: unavailable
      });
    });
    await expect(pending).resolves.toEqual(unavailable);
    expect(host.onDerived).not.toHaveBeenCalled();
  });

  it('cancels an obsolete queued mass query and discards its late reply', async () => {
    installWorker();
    const document = createProjectDocument('Mass query', toUserId('user'));
    const bodyId = toBodyId('body_mass');
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const controller = new AbortController();
    const pending = result.current.massProperties(document, bodyId, {
      signal: controller.signal
    });
    const request = worker.postMessage.mock.calls.at(-1)![0] as {
      requestId: string;
    };
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'cancel',
      requestId: request.requestId
    });
    act(() => {
      worker.emit({
        type: 'mass-properties',
        ok: true,
        requestId: request.requestId,
        result: {
          status: 'unavailable',
          code: 'unsupported',
          reason: 'stale',
          epoch: 1
        }
      });
    });
    expect(host.onDerived).not.toHaveBeenCalled();
  });
  it('cancels an abandoned drawing tessellation and discards its late reply', async () => {
    installWorker();
    const document = createProjectDocument('Drawing', toUserId('user'));
    const bodyId = toBodyId('body_drawn');
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const controller = new AbortController();
    const pending = result.current.drawingTessellation(document, [bodyId], {
      signal: controller.signal
    });
    const request = worker.postMessage.mock.calls.at(-1)![0] as {
      requestId: string;
    };
    expect(request).toMatchObject({
      type: 'drawing-tessellation',
      bodyIds: [bodyId]
    });
    // The Draw workspace closed: the queued job is cancelled in the worker.
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'cancel',
      requestId: request.requestId
    });
    act(() => {
      worker.emit({
        type: 'drawing-tessellation',
        ok: true,
        requestId: request.requestId,
        bodies: {}
      });
    });
    expect(host.onDerived).not.toHaveBeenCalled();
    // Already aborted: nothing is posted at all.
    const posts = worker.postMessage.mock.calls.length;
    await expect(
      result.current.drawingTessellation(document, [bodyId], {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).toHaveBeenCalledTimes(posts);
  });
  it('preserves selected analysis on one-off sync requests', async () => {
    installWorker();
    const document = createProjectDocument('Analysis', toUserId('user'));
    const host = { manager: () => null, onDerived: vi.fn(), onError: vi.fn() };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const analysis = { bodyId: 'imported', faceHashes: [701, 702] };
    const pending = result.current.syncOnce(document, analysis);
    const request = worker.postMessage.mock.calls.at(-1)![0] as {
      requestId: string;
    };
    expect(request).toMatchObject({ type: 'sync', document, analysis });
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
    expect(host.onDerived).not.toHaveBeenCalled();
  });

  it('routes disposable geometry previews to their caller without completing live analysis', async () => {
    installWorker();
    const document = createProjectDocument('Drag geometry', toUserId('user'));
    const host = {
      manager: () => null,
      onDerived: vi.fn(),
      onGeometryReady: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const pending = result.current.previewGeometry(document);
    const request = worker.postMessage.mock.calls.at(-1)![0] as {
      requestId: string;
    };
    expect(request).toMatchObject({ type: 'preview-geometry', document });
    const geometry = {
      bodyRepresentations: {},
      warnings: [],
      updatedAt: document.derived.updatedAt,
      analysis: 'pending' as const
    };
    act(() =>
      worker.emit({
        type: 'preview-geometry',
        ok: true,
        requestId: request.requestId,
        geometry
      })
    );
    await expect(pending).resolves.toEqual(geometry);
    expect(host.onDerived).not.toHaveBeenCalled();
    expect(host.onGeometryReady).not.toHaveBeenCalled();
    expect(result.current.isReadyFor(document)).toBe(false);
  });

  it('cancels obsolete geometry previews and discards their late results', async () => {
    installWorker();
    const document = createProjectDocument('Cancelled drag', toUserId('user'));
    const host = {
      manager: () => null,
      onDerived: vi.fn(),
      onGeometryReady: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const controller = new AbortController();
    const pending = result.current.previewGeometry(document, {
      signal: controller.signal
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError'
    });
    const request = worker.postMessage.mock.calls.at(-1)![0] as {
      requestId: string;
    };
    act(() => controller.abort());
    await rejected;
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: 'cancel',
      requestId: request.requestId
    });
    act(() =>
      worker.emit({
        type: 'preview-geometry',
        ok: true,
        requestId: request.requestId,
        geometry: {
          bodyRepresentations: {},
          warnings: [],
          updatedAt: document.derived.updatedAt,
          analysis: 'pending'
        }
      })
    );
    expect(host.onDerived).not.toHaveBeenCalled();
    expect(host.onGeometryReady).not.toHaveBeenCalled();
  });

  it('publishes accepted geometry only for the current revision without completing quantities', () => {
    installWorker();
    const document = createProjectDocument(
      'Geometry staging',
      toUserId('user')
    );
    const host = {
      manager: () => ({ document }) as CommandManager,
      onDerived: vi.fn(),
      onGeometryReady: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const geometry = {
      bodyRepresentations: {},
      warnings: [],
      updatedAt: document.derived.updatedAt,
      analysis: 'pending' as const
    };
    act(() => {
      worker.emit({
        type: 'geometry-ready',
        projectId: document.projectId,
        version: document.version,
        geometry
      });
      worker.emit({
        type: 'geometry-ready',
        projectId: document.projectId,
        version: document.version + 1,
        geometry
      });
      worker.emit({
        type: 'geometry-ready',
        projectId: 'other',
        version: document.version,
        geometry
      });
    });
    expect(host.onGeometryReady).toHaveBeenCalledExactlyOnceWith(
      geometry,
      document.projectId,
      document.version
    );
    expect(host.onDerived).not.toHaveBeenCalled();
    expect(result.current.isReadyFor(document)).toBe(false);
  });

  it('requests a full projection after a missing base and rejects stale analysis', () => {
    installWorker();
    const document = createProjectDocument('Recovery', toUserId('user'));
    const host = {
      manager: () => ({ document }) as CommandManager,
      onDerived: vi.fn(),
      onGeometryReady: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const sender = new ProjectionSender('recovery-worker');
    const geometry = {
      bodyRepresentations: {},
      warnings: [],
      updatedAt: document.derived.updatedAt,
      analysis: 'pending' as const
    };
    const emit = (
      packet: ReturnType<ProjectionSender['encode']>,
      version = document.version
    ) =>
      worker.emit({
        type: 'projection-delta',
        projectId: document.projectId,
        version,
        packet
      });
    act(() => {
      result.current.sync(document);
      emit(sender.encode(document.projectId, geometry));
      sender.encode(document.projectId, geometry); // A publication was dropped.
      emit(sender.encode(document.projectId, geometry));
      worker.emit({
        type: 'state',
        phase: 'ready',
        stale: false,
        projectId: document.projectId,
        version: document.version
      });
    });
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'sync',
      forceFull: true,
      document: { projectId: document.projectId, version: document.version }
    });
    expect(host.onDerived).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      phase: 'starting',
      stale: true
    });
    act(() => {
      emit(sender.encode(document.projectId, geometry, true));
      emit(
        sender.encode(document.projectId, document.derived),
        document.version - 1
      );
    });
    expect(host.onGeometryReady).toHaveBeenCalledTimes(2);
    expect(host.onDerived).not.toHaveBeenCalled();
    expect(result.current.isReadyFor(document)).toBe(false);
    act(() => {
      emit(sender.encode(document.projectId, document.derived));
      worker.emit({
        type: 'state',
        phase: 'ready',
        stale: false,
        projectId: document.projectId,
        version: document.version
      });
    });
    expect(host.onDerived).toHaveBeenCalledOnce();
    expect(result.current.isReadyFor(document)).toBe(true);
  });

  it('keeps upstream projections ephemeral and ignores other revisions', () => {
    installWorker();
    const document = createProjectDocument('Projection', toUserId('user'));
    const host = {
      manager: () => ({ document }) as CommandManager,
      onDerived: vi.fn(),
      onProjection: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    act(() => {
      worker.emit({
        type: 'projection',
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      });
      worker.emit({
        type: 'projection',
        projectId: document.projectId,
        version: document.version + 1,
        derived: document.derived
      });
      worker.emit({
        type: 'projection',
        projectId: 'another-project',
        version: document.version,
        derived: document.derived
      });
    });
    expect(host.onProjection).toHaveBeenCalledTimes(1);
    expect(host.onDerived).not.toHaveBeenCalled();
    expect(result.current.isReadyFor(document)).toBe(false);
  });

  it('marks only a matching broadcast projection as exact-ready', () => {
    installWorker();
    const document = createProjectDocument('Worker state', toUserId('user'));
    const host = {
      manager: () => ({ document }) as CommandManager,
      onDerived: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;

    expect(result.current.isReadyFor(document)).toBe(false);
    act(() => {
      result.current.sync(document);
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
    expect(result.current.isReadyFor(document)).toBe(false);
    act(() =>
      worker.emit({
        type: 'sync',
        ok: true,
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      })
    );
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
        manager: () => ({ document }) as CommandManager,
        onDerived: vi.fn(),
        onError: vi.fn()
      })
    );
    const worker = FakeWorker.instances[0]!;
    act(() => {
      result.current.sync(document);
      worker.emit({
        type: 'sync',
        ok: true,
        projectId: document.projectId,
        version: document.version,
        derived: document.derived
      });
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

  it('waits for the connection instead of spending respawns offline', async () => {
    // 13 November review I5: offline, the worker could not download, three
    // immediate respawns all failed, and the startup screen stayed at
    // "Building the model" after the connection came back.
    installWorker();
    vi.stubEnv('OZ_BUILD_COMMIT', '');
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError
        })
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await act(async () => {
          FakeWorker.instances.at(-1)!.onerror?.({} as ErrorEvent);
        });
      }
      expect(FakeWorker.instances).toHaveLength(1);
      expect(result.current.state.phase).toBe('starting');
      expect(onError).not.toHaveBeenCalled();

      onLine.mockReturnValue(true);
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      expect(FakeWorker.instances).toHaveLength(2);
      expect(result.current.state.phase).toBe('starting');
    } finally {
      onLine.mockRestore();
    }
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
    const rejected = expect(orphaned).rejects.toThrow(
      'Geometry worker crashed'
    );
    const first = FakeWorker.instances[0]!;
    await act(async () => {
      first.onerror?.({} as ErrorEvent);
    });

    // The crash rejects what was in flight, announces the restart, and
    // installs a fresh worker.
    await rejected;
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

  it('stops respawning after repeated boot failures and fails loudly', async () => {
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
      await act(async () => {
        current.onerror?.({} as ErrorEvent);
      });
    }

    expect(FakeWorker.instances).toHaveLength(4);
    expect(result.current.state.phase).toBe('failed');
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('reload the page to recover')
    );
  });

  it('stops retrying missing worker assets and offers a connection and reload action', async () => {
    installWorker();
    vi.stubEnv('OZ_BUILD_COMMIT', 'old-build');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ commit: 'new-build' })
      }))
    );
    const document = createProjectDocument('Stale worker', toUserId('user'));
    const onDerived = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useGeometryWorker({
        manager: () => ({ document }) as CommandManager,
        onDerived,
        onError
      })
    );
    const pending = result.current.syncOnce(document);
    const rejected = expect(pending).rejects.toThrow(STALE_CHUNK_MESSAGE);
    await act(async () => {
      FakeWorker.instances[0]!.onerror?.({} as ErrorEvent);
    });
    await rejected;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalled();
    expect(result.current.state.phase).toBe('failed');
    expect(result.current.isReadyFor(document)).toBe(false);
    expect(onDerived).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining(STALE_CHUNK_MESSAGE)
    );
    expect(STALE_CHUNK_MESSAGE).toMatch(/reload.*check your connection/i);
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

    it.each(['ready', 'failed'] as const)(
      'keeps recovery watched after the rejected job reports %s',
      (terminal) => {
        vi.useFakeTimers();
        installWorker();
        const document = createProjectDocument(
          'Recovery watchdog',
          toUserId('user')
        );
        const manager = { document } as CommandManager;
        const { result } = renderHook(() =>
          useGeometryWorker({
            manager: () => manager,
            onDerived: vi.fn(),
            onError: vi.fn()
          })
        );
        const worker = FakeWorker.instances[0]!;
        const sender = new ProjectionSender('recovery-watchdog');
        const emit = (packet: ReturnType<ProjectionSender['encode']>) =>
          worker.emit({
            type: 'projection-delta',
            projectId: document.projectId,
            version: document.version,
            packet
          });
        act(() => {
          result.current.sync(document);
          emit(sender.encode(document.projectId, document.derived));
          worker.emit({
            type: 'state',
            phase: 'ready',
            stale: false,
            projectId: document.projectId,
            version: document.version
          });
        });
        expect(result.current.isReadyFor(document)).toBe(true);
        act(() => {
          sender.encode(document.projectId, document.derived); // Dropped base.
          emit(sender.encode(document.projectId, document.derived));
          emit(sender.encode(document.projectId, document.derived));
          worker.emit({
            type: 'state',
            phase: terminal,
            stale: terminal !== 'ready',
            projectId: document.projectId,
            version: document.version
          });
          worker.emit({
            type: 'state',
            phase: 'starting',
            stale: true,
            projectId: document.projectId,
            version: document.version
          });
        });
        expect(result.current.isReadyFor(document)).toBe(false);
        expect(result.current.retainReadyGeometry(document)).toBe(false);
        expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
          forceFull: true
        });
        expect(worker.postMessage).toHaveBeenCalledTimes(2);
        act(() => {
          vi.advanceTimersByTime(20_000);
        });
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(FakeWorker.instances).toHaveLength(2);
        expect(FakeWorker.instances[1]!.postMessage).toHaveBeenCalledWith({
          type: 'sync',
          document,
          lineageDemand: []
        });
      }
    );

    it('settles recovery when a newer current document completes', () => {
      installWorker();
      const document = createProjectDocument(
        'New recovery revision',
        toUserId('user')
      );
      const manager = { document } as CommandManager;
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => manager,
          onDerived: vi.fn(),
          onError: vi.fn()
        })
      );
      const worker = FakeWorker.instances[0]!;
      const sender = new ProjectionSender('new-recovery-revision');
      const emit = (
        packet: ReturnType<ProjectionSender['encode']>,
        version = manager.document.version
      ) =>
        worker.emit({
          type: 'projection-delta',
          projectId: document.projectId,
          version,
          packet
        });
      act(() => {
        result.current.sync(document);
        emit(sender.encode(document.projectId, document.derived));
        sender.encode(document.projectId, document.derived);
        emit(sender.encode(document.projectId, document.derived));
      });
      expect(result.current.isReadyFor(document)).toBe(false);
      const newer = { ...document, version: document.version + 1 };
      act(() => {
        manager.document = newer;
        result.current.sync(newer);
        emit(sender.encode(newer.projectId, newer.derived, true));
        worker.emit({
          type: 'state',
          phase: 'ready',
          stale: false,
          projectId: newer.projectId,
          version: newer.version
        });
      });
      expect(result.current.isReadyFor(newer)).toBe(true);
      expect(result.current.isReadyFor(document)).toBe(false);
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
      // The live broadcast always carries the (here empty) lineage demand.
      expect(second.postMessage).toHaveBeenCalledWith({
        type: 'sync',
        document,
        lineageDemand: []
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

    it.each([false, true])(
      'allows a six-minute exact rebuild (request tagged: %s)',
      (tagged) => {
        vi.useFakeTimers();
        installWorker();
        const document = createProjectDocument(
          'Long exact build',
          toUserId('user')
        );
        const onError = vi.fn();
        const { result } = renderHook(() =>
          useGeometryWorker({
            manager: () => ({ document }) as CommandManager,
            onDerived: vi.fn(),
            onError
          })
        );
        const worker = FakeWorker.instances[0]!;
        result.current.sync(document);
        act(() => {
          worker.emit({
            type: 'state',
            phase: 'rebuilding',
            stale: true,
            projectId: document.projectId,
            version: document.version,
            ...(tagged ? { requestId: 'long-export' } : {})
          });
          vi.advanceTimersByTime(6 * 60_000);
        });
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(FakeWorker.instances).toHaveLength(1);
        expect(onError).not.toHaveBeenCalled();
        act(() => {
          worker.emit({
            type: 'sync',
            ok: true,
            projectId: document.projectId,
            version: document.version,
            derived: document.derived
          });
          worker.emit({
            type: 'state',
            phase: 'ready',
            stale: false,
            projectId: document.projectId,
            version: document.version
          });
        });
        expect(result.current.isReadyFor(document)).toBe(true);
      }
    );

    it('still replaces a rebuild that exceeds the bounded silence budget', () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument('Stalled build', toUserId('user'));
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError
        })
      );
      const worker = FakeWorker.instances[0]!;
      result.current.sync(document);
      act(() => {
        worker.emit({
          type: 'state',
          phase: 'rebuilding',
          stale: true,
          projectId: document.projectId,
          version: document.version
        });
        vi.advanceTimersByTime(15 * 60_000 + 1_000);
      });
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(FakeWorker.instances).toHaveLength(2);
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('stopped responding')
      );
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
        vi.advanceTimersByTime(14 * 60_000 + 1_000);
      });
      expect(FakeWorker.instances).toHaveLength(2);
    });

    function tagged(
      document: ReturnType<typeof createProjectDocument>,
      phase: 'starting' | 'rebuilding' | 'ready',
      requestId?: string
    ): GeometryWorkerResult {
      return {
        type: 'state',
        phase,
        stale: phase !== 'ready',
        projectId: document.projectId,
        version: document.version,
        ...(requestId ? { requestId } : {})
      };
    }

    it('respawns a request-tagged job that wedges after the live document is ready', async () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument('Wedged export', toUserId('user'));
      const manager = { document } as unknown as CommandManager;
      const onError = vi.fn();
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => manager,
          onDerived: vi.fn(),
          onError
        })
      );
      const worker = FakeWorker.instances[0]!;
      act(() => {
        result.current.sync(document);
        worker.emit(tagged(document, 'ready'));
      });

      // The export announces its rebuild, then one WASM call never returns.
      const exported = expect(
        result.current.exportModel('step', document, [])
      ).rejects.toThrow('stopped responding');
      const exportId = (
        worker.postMessage.mock.calls.at(-1)![0] as { requestId: string }
      ).requestId;
      act(() => worker.emit(tagged(document, 'rebuilding', exportId)));
      // The user keeps editing; the broadcast queues behind the stuck job.
      const edited = { ...document, version: document.version + 1 };
      act(() => {
        manager.document = edited;
        result.current.sync(edited);
      });

      // Within the rebuild budget the slow job is left alone...
      act(() => {
        vi.advanceTimersByTime(14 * 60_000);
      });
      expect(FakeWorker.instances).toHaveLength(1);
      // ...and past it the worker is replaced, the export settles and the
      // replacement owes the edited document its rebuild.
      act(() => {
        vi.advanceTimersByTime(60_000 + 2_000);
      });
      expect({
        respawned: FakeWorker.instances.length,
        liveReady: result.current.isReadyFor(edited)
      }).toEqual({ respawned: 2, liveReady: false });
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('stopped responding during "rebuilding"')
      );
      expect(FakeWorker.instances[1]!.postMessage).toHaveBeenCalledWith({
        type: 'sync',
        document: edited,
        lineageDemand: []
      });
      await exported;
    });

    it('keeps watching a request whose live document reported ready after it was posted', async () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument('Queued mass', toUserId('user'));
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError: vi.fn()
        })
      );
      const worker = FakeWorker.instances[0]!;
      result.current.sync(document);
      const pending = result.current.massProperties(
        document,
        toBodyId('body_mass')
      );
      const rejected = expect(pending).rejects.toThrow('stopped responding');
      const massId = (
        worker.postMessage.mock.calls.at(-1)![0] as { requestId: string }
      ).requestId;
      // The live rebuild finishes (which disarms the live watch), then the
      // queued mass query starts and goes silent.
      act(() => {
        worker.emit(tagged(document, 'ready'));
        worker.emit(tagged(document, 'starting', massId));
        worker.emit(tagged(document, 'rebuilding', massId));
        vi.advanceTimersByTime(15 * 60_000 + 1_000);
      });
      expect(FakeWorker.instances).toHaveLength(2);
      await rejected;
    });

    it('budgets a queued request by the job that announced last', () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument('Behind cancel', toUserId('user'));
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError: vi.fn()
        })
      );
      const worker = FakeWorker.instances[0]!;
      const controller = new AbortController();
      void result.current
        .exportModel('step', document, [], { signal: controller.signal })
        .catch(() => undefined);
      const exportId = (
        worker.postMessage.mock.calls.at(-1)![0] as { requestId: string }
      ).requestId;
      act(() => {
        worker.emit(tagged(document, 'starting', exportId));
        worker.emit(tagged(document, 'rebuilding', exportId));
        // A running WASM build cannot be interrupted; the cancelled export
        // keeps the worker busy while a section waits behind it.
        controller.abort();
      });
      void result.current
        .sectionOutline(document, { origin: [0, 0, 0], normal: [0, 0, 1] }, [])
        .catch(() => undefined);
      act(() => {
        vi.advanceTimersByTime(15 * 60_000);
      });
      // Not the 15 s start budget: the queue is behind a long rebuild.
      expect(FakeWorker.instances).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(FakeWorker.instances).toHaveLength(2);
    });

    it('leaves an idle worker alone after a cancelled preview ends without a terminal state', () => {
      vi.useFakeTimers();
      installWorker();
      const document = createProjectDocument(
        'Cancelled drag',
        toUserId('user')
      );
      const { result } = renderHook(() =>
        useGeometryWorker({
          manager: () => null,
          onDerived: vi.fn(),
          onError: vi.fn()
        })
      );
      const worker = FakeWorker.instances[0]!;
      act(() => {
        result.current.sync(document);
        worker.emit(tagged(document, 'ready'));
      });
      const controller = new AbortController();
      void result.current
        .previewGeometry(document, { signal: controller.signal })
        .catch(() => undefined);
      const previewId = (
        worker.postMessage.mock.calls.at(-1)![0] as { requestId: string }
      ).requestId;
      act(() => {
        worker.emit(tagged(document, 'starting', previewId));
        worker.emit(tagged(document, 'rebuilding', previewId));
        // The worker drops a cancelled preview's result and final state.
        controller.abort();
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(FakeWorker.instances).toHaveLength(1);
    });
  });
});

it('requalifies live solved neighbors only after no-rebuild geometry equality and keeps old derived immutable', () => {
  installWorker();
  const initial = createProjectDocument('Solved neighbors', toUserId('user'));
  const manager = new CommandManager(initial);
  const derived = {
    ...initial.derived,
    sketchGeometry: {
      projectId: initial.projectId,
      documentVersion: initial.version,
      objects: {
        ent_line: { objectKind: 'line' as const, x1: 0, y1: 0, x2: 32, y2: 0 }
      }
    }
  };
  const { result } = renderHook(() =>
    useGeometryWorker({
      manager: () => manager,
      onDerived: (value) => {
        manager.commitDerivedState(value);
      },
      onError: vi.fn()
    })
  );
  const worker = FakeWorker.instances[0]!;
  act(() => {
    result.current.sync(initial);
    worker.emit({
      type: 'sync',
      ok: true,
      projectId: initial.projectId,
      version: initial.version,
      derived
    });
    worker.emit({
      type: 'state',
      phase: 'ready',
      projectId: initial.projectId,
      version: initial.version,
      stale: false
    });
  });
  const completed = manager.document;
  const oldDerived = completed.derived;
  const target = {
    ...completed,
    version: completed.version + 1,
    drawings: { sheets: [] },
    referenceImages: { images: [] }
  };
  const canonicalNodes = target.nodes;
  act(() => {
    expect(result.current.retainReadyGeometry(target)).toBe(true);
    manager.document = target;
  });
  expect(target.derived).not.toBe(oldDerived);
  expect(target.derived.bodyRepresentations).toBe(
    oldDerived.bodyRepresentations
  );
  expect(target.derived.sketchGeometry?.documentVersion).toBe(target.version);
  expect(
    Object.getOwnPropertyDescriptor(target.derived, 'sketchGeometry')
      ?.enumerable
  ).toBe(false);
  expect(completed.derived).toBe(oldDerived);
  expect(oldDerived.sketchGeometry?.documentVersion).toBe(completed.version);
  expect(target.nodes).toBe(canonicalNodes);
  expect(structuredClone(target).derived.sketchGeometry).toBeUndefined();
  const changed = {
    ...target,
    version: target.version + 1,
    units: 'cm' as const
  };
  const changedDerived = changed.derived;
  act(() => {
    expect(result.current.retainReadyGeometry(changed)).toBe(false);
  });
  expect(changed.derived).toBe(changedDerived);
  expect(changed.derived.sketchGeometry?.documentVersion).toBe(target.version);
  act(() => result.current.invalidate());
  expect(
    result.current.retainReadyGeometry({
      ...target,
      version: target.version + 1
    })
  ).toBe(false);
});

describe('adopting a validated edit result as the live result', () => {
  /**
   * A two-box union shown with a lineage demand, then a validated edit that
   * appends a third box. Returns what each case needs to commit it.
   */
  function validatedEdit() {
    installWorker();
    let base = createProjectDocument('Adopted edit', toUserId('user'));
    for (const name of ['A', 'B'])
      base = addPrimitiveFeature(base, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 8, depth: 6 }
      });
    base = booleanBodies(base, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [...base.bodyOrder]
    }).document;
    const demand = [base.bodyOrder.at(-1)!];
    const manager = { document: base } as CommandManager;
    const host = {
      manager: () => manager,
      onDerived: vi.fn(),
      onError: vi.fn()
    };
    const { result } = renderHook(() => useGeometryWorker(host));
    const worker = FakeWorker.instances[0]!;
    const finishLive = () =>
      act(() => {
        worker.emit({
          type: 'sync',
          ok: true,
          projectId: base.projectId,
          version: base.version,
          derived: base.derived
        });
        worker.emit({
          type: 'state',
          phase: 'ready',
          projectId: base.projectId,
          version: base.version,
          stale: false
        });
      });
    act(() => result.current.sync(base, demand));
    const candidate = addPrimitiveFeature(base, {
      name: 'C',
      primitiveKind: 'box',
      dimensions: { width: 4, height: 4, depth: 4 }
    });
    // The commit appends its revision: bookkeeping the rebuild never reads.
    const committed = {
      ...candidate,
      version: candidate.version + 1,
      revisions: [...candidate.revisions]
    };
    const validate = async (
      options: {
        lineageDemand?: readonly (typeof demand)[number][];
        transient?: boolean;
        derived?: typeof candidate.derived;
      } = {}
    ) => {
      const derived = options.derived ?? {
        ...candidate.derived,
        warnings: []
      };
      const pending = result.current.syncOnce(
        candidate,
        undefined,
        'lineageDemand' in options
          ? options.lineageDemand
          : result.current.liveLineageDemand(),
        { proposeCarry: true }
      );
      const request = worker.postMessage.mock.calls.at(-1)![0] as {
        requestId: string;
      };
      act(() =>
        worker.emit({
          type: 'sync',
          ok: true,
          requestId: request.requestId,
          projectId: candidate.projectId,
          version: candidate.version,
          ...(options.transient ? { transient: true } : {}),
          derived
        })
      );
      return pending;
    };
    return {
      base,
      committed,
      demand,
      host,
      manager,
      result,
      worker,
      finishLive,
      validate
    };
  }

  it('answers the commit broadcast with the validation result instead of rebuilding it', async () => {
    const edit = validatedEdit();
    edit.finishLive();
    expect(edit.result.current.liveLineageDemand()).toEqual(edit.demand);
    const derived = await edit.validate();
    const posted = edit.worker.postMessage.mock.calls.length;
    act(() => {
      edit.manager.document = edit.committed;
      expect(
        edit.result.current.adoptValidatedResult(edit.committed, derived)
      ).toBe(true);
    });
    // Delivered exactly as a broadcast reply would be.
    expect(edit.host.onDerived).toHaveBeenLastCalledWith(derived);
    expect(edit.result.current.isReadyFor(edit.committed)).toBe(true);
    // No broadcast follows, so the worker is told what is live: only a
    // draft display of this content may still be refined.
    expect(edit.worker.postMessage).toHaveBeenCalledTimes(posted + 1);
    expect(edit.worker.postMessage).toHaveBeenLastCalledWith({
      type: 'live-content',
      projectId: edit.committed.projectId,
      contentKey: geometryContentKey(edit.committed)
    });
    // The commit's own sync finds the result already live: nothing is posted.
    act(() => edit.result.current.sync(edit.committed, edit.demand));
    expect(edit.worker.postMessage).toHaveBeenCalledTimes(posted + 1);
    // A wider demand still asks the worker for its lineage.
    act(() =>
      edit.result.current.sync(edit.committed, [
        ...edit.demand,
        edit.base.bodyOrder[0]!
      ])
    );
    expect(edit.worker.postMessage).toHaveBeenCalledTimes(posted + 2);
  });

  /** A one-body result; `draft` marks the released edit's display mesh. */
  function releasedResult(
    edit: ReturnType<typeof validatedEdit>,
    scale: number,
    draft: boolean
  ) {
    const bodyId = edit.committed.bodyOrder.at(-1)!;
    return {
      ...edit.committed.derived,
      warnings: [],
      bodyRepresentations: {
        [bodyId]: {
          bodyId,
          name: 'C',
          source: 'primitive' as const,
          mesh: {
            kind: 'mesh' as const,
            vertices: new Float32Array([0, 0, 0, scale, 0, 0, 0, scale, 0]),
            indices: new Uint32Array([0, 1, 2])
          },
          faceCount: 1,
          color: '#ffffff',
          exportableStep: true,
          consumed: false,
          volume: 64,
          bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } },
          ...(draft ? { displayQuality: 'draft' as const } : {})
        }
      }
    };
  }

  it('replaces a live draft display with its full-quality refinement', async () => {
    const edit = validatedEdit();
    edit.finishLive();
    const draft = await edit.validate({
      derived: releasedResult(edit, 1, true)
    });
    act(() => {
      edit.manager.document = edit.committed;
      expect(
        edit.result.current.adoptValidatedResult(edit.committed, draft)
      ).toBe(true);
    });
    // What the host's commitDerivedState made live.
    edit.manager.document = { ...edit.committed, derived: draft };
    const refined = releasedResult(edit, 2, false);
    const delivered = edit.host.onDerived.mock.calls.length;
    const refine = (projectId = edit.committed.projectId) =>
      act(() =>
        edit.worker.emit({
          type: 'display-refined',
          projectId,
          version: edit.committed.version,
          contentKey: geometryContentKey(edit.committed),
          derived: refined
        })
      );
    // Another project's refinement is never shown.
    refine('project_other' as typeof edit.committed.projectId);
    expect(edit.host.onDerived).toHaveBeenCalledTimes(delivered);
    refine();
    expect(edit.host.onDerived).toHaveBeenCalledTimes(delivered + 1);
    const shown = edit.host.onDerived.mock.calls.at(-1)![0] as typeof refined;
    expect(shown.bodyRepresentations).toEqual(refined.bodyRepresentations);
    expect(edit.result.current.isReadyFor(edit.committed)).toBe(true);
    // Once full quality is live, a repeat changes nothing.
    edit.manager.document = { ...edit.committed, derived: shown };
    refine();
    expect(edit.host.onDerived).toHaveBeenCalledTimes(delivered + 1);
  });

  it('adopts a refinement that arrived before its draft became live', async () => {
    const edit = validatedEdit();
    edit.finishLive();
    const draft = await edit.validate({
      derived: releasedResult(edit, 1, true)
    });
    const refined = releasedResult(edit, 2, false);
    const delivered = edit.host.onDerived.mock.calls.length;
    act(() =>
      edit.worker.emit({
        type: 'display-refined',
        projectId: edit.committed.projectId,
        version: edit.committed.version,
        contentKey: geometryContentKey(edit.committed),
        derived: refined
      })
    );
    // The base on screen is not a draft: nothing is replaced yet.
    expect(edit.host.onDerived).toHaveBeenCalledTimes(delivered);
    act(() => {
      edit.manager.document = edit.committed;
      expect(
        edit.result.current.adoptValidatedResult(edit.committed, draft)
      ).toBe(true);
    });
    const shown = edit.host.onDerived.mock.calls.at(-1)![0] as typeof refined;
    expect(shown.bodyRepresentations).toEqual(refined.bodyRepresentations);
  });

  it.each([
    ['was validated with full lineage, not the live demand', 'eager'],
    ['proposed carrying a later selection', 'carry'],
    ['waited on a font or source', 'transient'],
    ['was committed with different geometry content', 'content'],
    ['arrives while the live broadcast is still running', 'running'],
    ['came from somewhere other than a validation sync', 'foreign'],
    ['is for a document the commit already moved past', 'moved']
  ] as const)(
    'rebuilds normally when the result %s',
    async (_label, reason) => {
      const edit = validatedEdit();
      if (reason !== 'running') edit.finishLive();
      const derived =
        reason === 'foreign'
          ? { ...edit.committed.derived, warnings: [] }
          : await edit.validate(
              reason === 'eager'
                ? { lineageDemand: undefined }
                : reason === 'transient'
                  ? { transient: true }
                  : reason === 'carry'
                    ? {
                        derived: {
                          ...edit.committed.derived,
                          warnings: [],
                          edgeHashRepairs: [
                            {
                              featureId: edit.committed.featureOrder[0]!,
                              index: 0,
                              hash: 7
                            }
                          ] as unknown as NonNullable<
                            typeof edit.committed.derived.edgeHashRepairs
                          >
                        }
                      }
                    : {}
            );
      const committed =
        reason === 'content'
          ? { ...edit.committed, name: 'Renamed while validating' }
          : edit.committed;
      const posted = edit.worker.postMessage.mock.calls.length;
      const delivered = edit.host.onDerived.mock.calls.length;
      act(() => {
        // A normalization written by the commit (a projection write-back)
        // already replaced the committed document.
        edit.manager.document =
          reason === 'moved'
            ? { ...committed, version: committed.version + 1 }
            : committed;
        expect(
          edit.result.current.adoptValidatedResult(committed, derived)
        ).toBe(false);
      });
      expect(edit.host.onDerived).toHaveBeenCalledTimes(delivered);
      expect(edit.result.current.isReadyFor(committed)).toBe(false);
      act(() => edit.result.current.sync(committed, edit.demand));
      expect(edit.worker.postMessage).toHaveBeenCalledTimes(posted + 1);
      expect(edit.worker.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'sync' })
      );
    }
  );
});
