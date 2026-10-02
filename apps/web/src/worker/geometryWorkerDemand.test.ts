import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toBodyId, toUserId, type ProjectDocument } from '@openzcad/shared';
import type { GeometryWorkerRequest } from './geometryWorker';

function derived(label: string): ProjectDocument['derived'] {
  return {
    bodyRepresentations: {},
    exportableBodyIds: [],
    warnings: [label],
    updatedAt: '2026-08-01T00:00:00.000Z'
  };
}

interface FakeWorkerScope {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((event: MessageEvent<GeometryWorkerRequest>) => void) | null;
}

async function installWorker(
  syncDocument: (...args: unknown[]) => Promise<ProjectDocument['derived']>
) {
  const scope: FakeWorkerScope = {
    postMessage: vi.fn(),
    onmessage: null
  };
  const createExactKernelAdapter = vi.fn(async () => ({
    syncDocument,
    currentMassPropertiesEpoch: vi.fn(() => 1),
    prepareMassPropertiesForDocument: vi.fn(async () => 2),
    readCurrentMassProperties: vi.fn(() => ({
      status: 'unavailable',
      reason: 'No live solid is available.',
      epoch: 1
    })),
    exportStep: vi.fn(),
    exportStl: vi.fn(),
    exportMesh: vi.fn(),
    meshQuality: vi.fn(),
    inspectStep: vi.fn(),
    dispose: vi.fn()
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

describe('geometry worker lineage demand', () => {
  it('travels in the sync request and reaches syncDocument', async () => {
    const syncDocument = vi.fn(async () => derived('demanded'));
    const { scope } = await installWorker(syncDocument);
    const document = addPrimitiveFeature(
      createProjectDocument('Demand travel', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    post(scope, {
      type: 'sync',
      document,
      requestId: 'demanded',
      lineageDemand: [bodyId]
    });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sync', ok: true, requestId: 'demanded' })
      )
    );
    expect(syncDocument).toHaveBeenCalledOnce();
    // document, onProgress, onProjection, analysis, lineageDemand.
    const calls = syncDocument.mock.calls as unknown[][];
    expect(calls[0]?.[4]).toEqual([bodyId]);
  });

  it('changes the worker rebuild cache key', async () => {
    const syncDocument = vi.fn(async () => derived('done'));
    const { scope } = await installWorker(syncDocument);
    const document = addPrimitiveFeature(
      createProjectDocument('Demand cache', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = toBodyId('body_demanded');
    for (const [requestId, demand] of [
      ['plain', undefined],
      ['demanded', [bodyId]],
      ['plain-again', undefined]
    ] as const) {
      post(scope, {
        type: 'sync',
        document,
        requestId,
        ...(demand ? { lineageDemand: [...demand] } : {})
      });
      await vi.waitFor(() =>
        expect(scope.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'sync', ok: true, requestId })
        )
      );
    }
    // Plain, demanded, then plain-again hits the first entry: two builds.
    expect(syncDocument).toHaveBeenCalledTimes(2);
  });

  it('treats demand order as the same key', async () => {
    const syncDocument = vi.fn(async () => derived('done'));
    const { scope } = await installWorker(syncDocument);
    const document = addPrimitiveFeature(
      createProjectDocument('Demand order', toUserId('user')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const first = document.bodyOrder[0]!;
    post(scope, {
      type: 'sync',
      document,
      requestId: 'first',
      lineageDemand: [first]
    });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sync', ok: true, requestId: 'first' })
      )
    );
    post(scope, {
      type: 'sync',
      document,
      requestId: 'second',
      lineageDemand: [first]
    });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sync', ok: true, requestId: 'second' })
      )
    );
    expect(syncDocument).toHaveBeenCalledOnce();
  });
});
