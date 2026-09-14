import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toSketchId,
  toUserId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
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

  it('tags rebuild progress with the request identity', async () => {
    const progress = {
      stage: 'feature' as const,
      name: 'Box',
      index: 1,
      total: 1,
      status: 'started' as const
    };
    const { scope } = await installWorker(
      async (_document, onProgress?: (event: typeof progress) => void) => {
        onProgress?.(progress);
        return derived('done');
      }
    );
    const document = addPrimitiveFeature(
      createProjectDocument('Progress', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      }
    );
    post(scope, { type: 'sync', document, requestId: 'progress-request' });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'state',
          phase: 'rebuilding',
          projectId: document.projectId,
          version: document.version,
          requestId: 'progress-request',
          progress
        })
      )
    );
  });

  it('keeps selected analysis separate from ordinary rebuild cache entries', async () => {
    const syncDocument = vi.fn(async () => derived('done'));
    const { scope } = await installWorker(syncDocument);
    const document = addPrimitiveFeature(
      createProjectDocument('Analysis', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const analysis = {
      bodyId: String(document.bodyOrder[0]),
      faceHashes: [123, 456]
    };
    for (const [requestId, scopeAnalysis] of [
      ['normal', undefined],
      ['selected', analysis],
      ['normal-again', undefined]
    ] as const) {
      post(scope, {
        type: 'sync',
        document,
        requestId,
        ...(scopeAnalysis ? { analysis: scopeAnalysis } : {})
      });
      await vi.waitFor(() =>
        expect(scope.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'sync', ok: true, requestId })
        )
      );
    }
    expect(syncDocument).toHaveBeenCalledTimes(2);
    expect(syncDocument).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.any(Function),
      undefined,
      analysis
    );
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

  it('answers a section request with the adapter\'s exact outline', async () => {
    const report = {
      plane: { origin: [0, 0, 3], normal: [0, 0, 1] },
      regions: [
        {
          bodyId: 'body_1',
          area: 200,
          loops: [{ kind: 'outer', points: [[0, 0, 3]] }],
          positions: new Float32Array([0, 0, 3]),
          indices: new Uint32Array([0])
        }
      ],
      refusals: []
    };
    const sectionOutline = vi.fn(async () => report);
    const { scope } = await installWorker(async () => derived('unused'), {
      sectionOutline
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Section', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const plane = { origin: [0, 0, 3], normal: [0, 0, 1] } as const;
    post(scope, {
      type: 'section',
      requestId: 'section-1',
      document,
      plane,
      bodyIds: document.bodyOrder
    });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'section',
          ok: true,
          requestId: 'section-1',
          report
        })
      )
    );
    // The caller's body list reaches the adapter: hiding and isolating are
    // device-local view state the document does not carry, so a section
    // taken without it draws bodies the viewport is not showing.
    expect(sectionOutline).toHaveBeenCalledWith(
      document,
      plane,
      document.bodyOrder
    );
  });

  it('reports a refused section as a failure the caller can show', async () => {
    const sectionOutline = vi.fn(async () => {
      throw new Error('The section plane does not cut any body.');
    });
    const { scope } = await installWorker(async () => derived('unused'), {
      sectionOutline
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Section', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    post(scope, {
      type: 'section',
      requestId: 'section-2',
      document,
      plane: { origin: [0, 0, 300], normal: [0, 0, 1] }
    });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'section',
          ok: false,
          requestId: 'section-2',
          error: 'The section plane does not cut any body.'
        })
      )
    );
  });

  it('routes a DXF export with a plane to the section exporter', async () => {
    const exportSectionDxf = vi.fn(async () => '0\r\nSECTION\r\n');
    const exportFaceDxf = vi.fn(async () => 'face');
    const { scope } = await installWorker(async () => derived('unused'), {
      exportSectionDxf,
      exportFaceDxf
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Section DXF', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const plane = { origin: [0, 0, 3], normal: [0, 0, 1] } as const;
    post(scope, {
      type: 'export',
      requestId: 'dxf-1',
      document,
      bodyIds: document.bodyOrder,
      format: 'dxf',
      section: plane
    });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'export',
          ok: true,
          format: 'dxf',
          requestId: 'dxf-1',
          text: '0\r\nSECTION\r\n'
        })
      )
    );
    // The drawing is of the same bodies the section on screen was cut from.
    expect(exportSectionDxf).toHaveBeenCalledWith(
      document,
      plane,
      document.bodyOrder
    );
    expect(exportFaceDxf).not.toHaveBeenCalled();
  });

  it('leaves the body selection to the adapter when the caller names none', async () => {
    const exportSectionDxf = vi.fn(async () => '0\r\nSECTION\r\n');
    const { scope } = await installWorker(async () => derived('unused'), {
      exportSectionDxf
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Section DXF', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const plane = { origin: [0, 0, 3], normal: [0, 0, 1] } as const;
    post(scope, {
      type: 'export',
      requestId: 'dxf-2',
      document,
      bodyIds: [],
      format: 'dxf',
      section: plane
    });

    await vi.waitFor(() =>
      expect(exportSectionDxf).toHaveBeenCalledWith(document, plane, undefined)
    );
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

  it('answers recognize-imported-face requests with the adapter summary', async () => {
    const summary = {
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
    const recognizeImportedFace = vi.fn(
      async (input: {
        document: ProjectDocument;
        bodyId: BodyId;
        faceHash: number;
      }): Promise<typeof summary> => {
        expect(input.faceHash).toBe(701);
        return summary;
      }
    );
    const { scope } = await installWorker(async () => derived('unused'), {
      recognizeImportedFace
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Recognition Check', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    post(scope, {
      type: 'recognize-imported-face',
      requestId: 'recognition-1',
      document,
      bodyId,
      faceHash: 701,
      topologyId: 'face:701'
    });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'recognize-imported-face',
          ok: true,
          requestId: 'recognition-1',
          bodyId,
          faceHash: 701,
          summary
        })
      )
    );
    // The worker resolves the v5 face reference from the derived topology
    // rather than trusting the caller's pick blindly.
    expect(recognizeImportedFace).toHaveBeenCalledOnce();
    expect(recognizeImportedFace.mock.calls[0]![0]).toMatchObject({
      bodyId,
      faceHash: 701
    });
  });

  it('reports a recognize-imported-face adapter failure by request id', async () => {
    const recognizeImportedFace = vi.fn(async () => {
      throw new Error('kernel refused the query');
    });
    const { scope } = await installWorker(async () => derived('unused'), {
      recognizeImportedFace
    });
    const document = addPrimitiveFeature(
      createProjectDocument('Recognition Failure', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    post(scope, {
      type: 'recognize-imported-face',
      requestId: 'recognition-2',
      document,
      bodyId: document.bodyOrder[0]!,
      faceHash: 702
    });

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'recognize-imported-face',
          ok: false,
          requestId: 'recognition-2',
          error: 'kernel refused the query'
        })
      )
    );
  });
});

describe('resolveSourceBytes download safeguards', () => {
  interface ResolveSourceBytes {
    (
      ref: { checksumSha256: string },
      context: { artifactId: string; sourceName: string }
    ): Promise<Uint8Array>;
  }

  async function installResolver() {
    const scope: FakeWorkerScope = {
      postMessage: vi.fn(),
      onmessage: null
    };
    let resolveSourceBytes!: ResolveSourceBytes;
    const createExactKernelAdapter = vi.fn(
      async (deps: { resolveSourceBytes: ResolveSourceBytes }) => {
        resolveSourceBytes = deps.resolveSourceBytes;
        return {
          syncDocument: vi.fn(async () => derived('unused')),
          exportStep: vi.fn(),
          exportStl: vi.fn(),
          exportMesh: vi.fn(),
          meshQuality: vi.fn(),
          inspectStep: vi.fn(),
          dispose: vi.fn()
        };
      }
    );
    const putSourceBlob = vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => ({
      checksumSha256: await sha256Hex(bytes)
    }));
    vi.stubGlobal('self', scope);
    vi.doMock('@openzcad/kernel-adapter/exact', () => ({
      createExactKernelAdapter
    }));
    vi.doMock('../lib/localProjectStore', () => ({
      loadSourceBlob: vi.fn(async () => null),
      putSourceBlob,
      sha256Hex
    }));
    await import('./geometryWorker');
    // Loading the exact kernel captures the resolver wired into the adapter.
    const document = addPrimitiveFeature(
      createProjectDocument('Imports', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    post(scope, { type: 'sync', document });
    await vi.waitFor(() => expect(createExactKernelAdapter).toHaveBeenCalled());
    return { resolveSourceBytes, putSourceBlob };
  }

  async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0')
    ).join('');
  }

  const context = { artifactId: 'artifact_cloud', sourceName: 'part.step' };

  it('verifies the checksum before persisting a downloaded artifact', async () => {
    const { resolveSourceBytes, putSourceBlob } = await installResolver();
    const bytes = new TextEncoder().encode('ISO-10303-21;');
    const checksumSha256 = await sha256Hex(bytes);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes))
    );

    const resolved = await resolveSourceBytes({ checksumSha256 }, context);

    expect(resolved).toEqual(bytes);
    expect(putSourceBlob).toHaveBeenCalledOnce();
  });

  it('rejects a checksum mismatch without persisting the bytes', async () => {
    const { resolveSourceBytes, putSourceBlob } = await installResolver();
    const correct = await sha256Hex(new TextEncoder().encode('expected'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new TextEncoder().encode('tampered')))
    );

    await expect(
      resolveSourceBytes({ checksumSha256: correct }, context)
    ).rejects.toThrow('could not be fetched');
    expect(putSourceBlob).not.toHaveBeenCalled();
  });

  it('refuses a download whose declared length exceeds the import budget', async () => {
    const { resolveSourceBytes, putSourceBlob } = await installResolver();
    const checksumSha256 = await sha256Hex(new Uint8Array(1));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(1), {
            headers: { 'content-length': String(129 * 1024 * 1024) }
          })
      )
    );

    await expect(
      resolveSourceBytes({ checksumSha256 }, context)
    ).rejects.toThrow('could not be fetched');
    expect(putSourceBlob).not.toHaveBeenCalled();
  });

  it('stops reading a streamed body once it passes the import budget', async () => {
    const { resolveSourceBytes, putSourceBlob } = await installResolver();
    const checksumSha256 = await sha256Hex(new Uint8Array(1));
    // No content-length: the byte ceiling has to hold while streaming.
    const chunk = new Uint8Array(16 * 1024 * 1024);
    let chunksRemaining = 9; // 144 MiB > 128 MiB budget.
    const body = new ReadableStream<Uint8Array>({
      pull(controllerInstance) {
        if (chunksRemaining === 0) {
          controllerInstance.close();
          return;
        }
        chunksRemaining -= 1;
        controllerInstance.enqueue(chunk);
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body))
    );

    await expect(
      resolveSourceBytes({ checksumSha256 }, context)
    ).rejects.toThrow('could not be fetched');
    expect(putSourceBlob).not.toHaveBeenCalled();
  });
});
