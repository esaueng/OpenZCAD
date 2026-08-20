import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toSketchId, toUserId, type ProjectDocument } from '@openzcad/shared';
import type {
  GeometryWorkerRequest,
  GeometryWorkerResult
} from './geometryWorker';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function derived(label: string): ProjectDocument['derived'] {
  return {
    bodyRepresentations: {},
    exportableBodyIds: [],
    warnings: [label],
    updatedAt: '2026-08-01T00:00:00.000Z'
  };
}

interface FakeWorkerScope {
  postMessage: ReturnType<
    typeof vi.fn<
      (
        message: GeometryWorkerResult,
        options?: StructuredSerializeOptions
      ) => void
    >
  >;
  onmessage: ((event: MessageEvent<GeometryWorkerRequest>) => void) | null;
}

async function installWorker(
  syncDocument: (
    document: ProjectDocument
  ) => Promise<ProjectDocument['derived']>,
  adapterOverrides: Record<string, unknown> = {}
) {
  const scope: FakeWorkerScope = {
    postMessage: vi.fn(),
    onmessage: null
  };
  const createExactKernelAdapter = vi.fn(async () => ({
    syncDocument,
    exportStep: vi.fn(),
    exportStl: vi.fn(),
    exportMesh: vi.fn(),
    meshQuality: vi.fn(),
    inspectStep: vi.fn(),
    dispose: vi.fn(),
    ...adapterOverrides
  }));
  vi.stubGlobal('self', scope);
  vi.doMock('@openzcad/kernel-adapter/exact', () => ({
    createExactKernelAdapter
  }));
  await import('./geometryWorker');
  return { scope, createExactKernelAdapter };
}

function post(scope: FakeWorkerScope, request: GeometryWorkerRequest): void {
  scope.onmessage?.({ data: request } as MessageEvent<GeometryWorkerRequest>);
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('geometry worker rebuild coordination', () => {
  it('does not load the exact-kernel chunk for an empty project', async () => {
    const { scope, createExactKernelAdapter } = await installWorker(async () =>
      derived('unexpected')
    );
    const document = createProjectDocument('Empty', toUserId('user'));
    post(scope, { type: 'sync', document });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sync', ok: true })
      )
    );
    expect(createExactKernelAdapter).not.toHaveBeenCalled();
  });

  it('executes identical explicit syncs once and clones cached results', async () => {
    const first = deferred<ProjectDocument['derived']>();
    const syncDocument = vi.fn(() => first.promise);
    const { scope } = await installWorker(syncDocument);
    const document = addPrimitiveFeature(
      createProjectDocument('Cached', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    post(scope, { type: 'sync', document, requestId: 'left' });
    post(scope, { type: 'sync', document, requestId: 'right' });
    await vi.waitFor(() => expect(syncDocument).toHaveBeenCalledOnce());
    first.resolve(derived('shared'));

    await vi.waitFor(() => {
      const results = scope.postMessage.mock.calls
        .map(([message]) => message)
        .filter(
          (message) =>
            message.type === 'sync' && message.ok && message.requestId
        );
      expect(results).toHaveLength(2);
    });
    expect(syncDocument).toHaveBeenCalledOnce();
    const results = scope.postMessage.mock.calls
      .map(([message]) => message)
      .filter(
        (
          message
        ): message is Extract<
          GeometryWorkerResult,
          { type: 'sync'; ok: true }
        > => message.type === 'sync' && message.ok
      );
    expect(results[0]!.derived).not.toBe(results[1]!.derived);
  });

  it('retries the exact-kernel load after a failed fetch instead of staying bricked', async () => {
    const scope: FakeWorkerScope = {
      postMessage: vi.fn(),
      onmessage: null
    };
    const syncDocument = vi.fn(async () => derived('recovered'));
    const createExactKernelAdapter = vi
      .fn()
      .mockRejectedValueOnce(new Error('WASM chunk fetch failed'))
      .mockResolvedValue({
        syncDocument,
        exportStep: vi.fn(),
        exportStl: vi.fn(),
        inspectStep: vi.fn(),
        dispose: vi.fn()
      });
    vi.stubGlobal('self', scope);
    vi.doMock('@openzcad/kernel-adapter/exact', () => ({
      createExactKernelAdapter
    }));
    await import('./geometryWorker');
    const document = addPrimitiveFeature(
      createProjectDocument('Retry', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );

    post(scope, { type: 'sync', document, requestId: 'first' });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sync',
          ok: false,
          requestId: 'first',
          error: 'WASM chunk fetch failed'
        })
      )
    );

    // A transient network failure must not disable geometry until page
    // reload: the next request attempts a fresh load.
    post(scope, { type: 'sync', document, requestId: 'second' });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sync', ok: true, requestId: 'second' })
      )
    );
    expect(createExactKernelAdapter).toHaveBeenCalledTimes(2);
    expect(syncDocument).toHaveBeenCalledOnce();
  });

  it('publishes only the newest broadcast when a rebuild is superseded', async () => {
    const first = deferred<ProjectDocument['derived']>();
    const syncDocument = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(derived('newest'));
    const { scope } = await installWorker(syncDocument);
    const original = addPrimitiveFeature(
      createProjectDocument('Original', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const newest = {
      ...original,
      name: 'Newest',
      version: original.version + 1
    };
    post(scope, { type: 'sync', document: original });
    await vi.waitFor(() => expect(syncDocument).toHaveBeenCalledOnce());
    post(scope, { type: 'sync', document: newest });
    first.resolve(derived('stale'));

    await vi.waitFor(() => expect(syncDocument).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      const newestResult = scope.postMessage.mock.calls
        .map(([message]) => message)
        .find(
          (
            message
          ): message is Extract<
            GeometryWorkerResult,
            { type: 'sync'; ok: true }
          > =>
            message.type === 'sync' &&
            message.ok &&
            message.version === newest.version
        );
      expect(newestResult?.derived.warnings).toEqual(['newest']);
    });
    const broadcastResults = scope.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'sync' && !message.requestId);
    expect(broadcastResults).toHaveLength(1);
    expect(broadcastResults[0]).toMatchObject({ version: newest.version });
  });

  it('transfers binary mesh exports back with their request id', async () => {
    const exportMesh = vi.fn(async () => new Uint8Array([80, 75, 3, 4]));
    const { scope } = await installWorker(async () => derived('unused'), {
      exportMesh
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Mesh Export', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    post(scope, {
      type: 'export',
      requestId: 'mesh-1',
      document,
      bodyIds: document.bodyOrder,
      format: '3mf',
      deflection: 0.05
    });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'export',
          ok: true,
          format: '3mf',
          requestId: 'mesh-1',
          data: new Uint8Array([80, 75, 3, 4])
        }),
        // The payload buffer is transferred, not structured-cloned.
        expect.objectContaining({ transfer: [expect.any(ArrayBuffer)] })
      )
    );
    expect(exportMesh).toHaveBeenCalledWith(document, document.bodyOrder, {
      format: '3mf',
      deflection: 0.05
    });
  });

  it('skips a queued export cancelled before it started', async () => {
    const gate = deferred<Uint8Array>();
    const exportMesh = vi
      .fn<() => Promise<Uint8Array>>()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(async () => new Uint8Array([1]));
    const { scope } = await installWorker(async () => derived('unused'), {
      exportMesh
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Cancelled Export', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const exportRequest = (requestId: string) =>
      ({
        type: 'export',
        requestId,
        document,
        bodyIds: document.bodyOrder,
        format: '3mf',
        deflection: 0.05
      }) as const;
    post(scope, exportRequest('mesh-a'));
    post(scope, exportRequest('mesh-b'));
    // The cancel lands while mesh-b is still queued behind the running job.
    post(scope, { type: 'cancel', requestId: 'mesh-b' });
    gate.resolve(new Uint8Array([9]));

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'export',
          ok: true,
          requestId: 'mesh-a'
        }),
        expect.anything()
      )
    );
    // Let the queue surface (and skip) the cancelled job.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exportMesh).toHaveBeenCalledTimes(1);
    const meshBMessages = scope.postMessage.mock.calls.filter(
      ([message]) => (message as { requestId?: string }).requestId === 'mesh-b'
    );
    expect(meshBMessages).toHaveLength(0);
  });

  it('answers solve-sketch requests with the adapter outcome', async () => {
    const outcome = {
      classification: 'solved',
      converged: true,
      iterations: 3,
      maxResidual: 0,
      rolledBack: false,
      dof: { dof: 4, rank: 2, numParams: 6, numEquations: 2 },
      constraintResiduals: [],
      objects: []
    };
    const solveSketch = vi.fn(async () => outcome);
    const { scope } = await installWorker(async () => derived('unused'), {
      solveSketch
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Sketch Solve', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    post(scope, {
      type: 'solve-sketch',
      requestId: 'solve-1',
      document,
      sketchId: toSketchId('sketch_a')
    });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'solve-sketch',
          ok: true,
          requestId: 'solve-1',
          outcome
        })
      )
    );
    expect(solveSketch).toHaveBeenCalledWith(document, 'sketch_a');
  });

  it('answers mesh-quality requests with the adapter report', async () => {
    const report = { watertight: true, bodies: [] };
    const meshQuality = vi.fn(async () => report);
    const { scope } = await installWorker(async () => derived('unused'), {
      meshQuality
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Quality Check', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    post(scope, {
      type: 'mesh-quality',
      requestId: 'quality-1',
      document,
      bodyIds: document.bodyOrder,
      deflection: 0.08
    });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mesh-quality',
          ok: true,
          requestId: 'quality-1',
          report
        })
      )
    );
    expect(meshQuality).toHaveBeenCalledWith(
      document,
      document.bodyOrder,
      0.08
    );
  });
});
