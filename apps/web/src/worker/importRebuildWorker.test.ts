import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { ExactKernelAdapterOptions } from '@openzcad/kernel-adapter/exact';

import type {
  ImportRebuildWorkerRequest,
  ImportRebuildWorkerResult
} from './importRebuildWorker';

interface FakeWorkerScope {
  postMessage: ReturnType<typeof vi.fn<(result: ImportRebuildWorkerResult) => void>>;
  onmessage: ((event: MessageEvent<ImportRebuildWorkerRequest>) => void) | null;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('disposable exact import rebuild worker', () => {
  it('publishes only the derived state produced by the exact kernel', async () => {
    const scope: FakeWorkerScope = {
      postMessage: vi.fn(),
      onmessage: null
    };
    const document = createProjectDocument(
      'Exact import',
      toUserId('user_exact_import')
    );
    const derived = {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: ['exact-kernel-verdict'],
      updatedAt: document.derived.updatedAt
    };
    const syncDocument = vi.fn(async () => derived);
    const dispose = vi.fn();
    const createExactKernelAdapter = vi.fn(
      async (_options: ExactKernelAdapterOptions) => ({
        syncDocument,
        dispose
      })
    );
    const preloadDocumentFonts = vi.fn(async () => undefined);
    vi.stubGlobal('self', scope);
    vi.doMock('@openzcad/kernel-adapter/exact', () => ({
      createExactKernelAdapter
    }));
    vi.doMock('../lib/textFonts', () => ({ preloadDocumentFonts }));
    await import('./importRebuildWorker');

    scope.onmessage?.({
      data: { type: 'rebuild', requestId: 'rebuild-1', document }
    } as MessageEvent<ImportRebuildWorkerRequest>);

    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith({
        type: 'result',
        requestId: 'rebuild-1',
        ok: true,
        derived
      })
    );
    expect(preloadDocumentFonts).toHaveBeenCalledWith(document);
    expect(syncDocument).toHaveBeenCalledWith(document);
    expect(createExactKernelAdapter).toHaveBeenCalledOnce();
    expect(
      typeof createExactKernelAdapter.mock.calls[0]![0].resolveSourceBytes
    ).toBe('function');
    expect(dispose).toHaveBeenCalledOnce();
  });
});
