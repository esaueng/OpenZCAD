import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

import { rebuildImportInDisposableWorker } from './importRebuildWorkerClient';
import type {
  ImportRebuildWorkerRequest,
  ImportRebuildWorkerResult
} from '../worker/importRebuildWorker';
import { onStaleChunk, STALE_CHUNK_MESSAGE } from './staleChunk';

class FakeWorker {
  static instances: FakeWorker[] = [];

  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<ImportRebuildWorkerResult>) => void) | null =
    null;
  request: ImportRebuildWorkerRequest | null = null;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: ImportRebuildWorkerRequest): void {
    this.request = request;
  }

  terminate(): void {
    this.terminated = true;
  }
}

function emptyDerived(document: ProjectDocument): ProjectDocument['derived'] {
  return {
    bodyRepresentations: {},
    exportableBodyIds: [],
    warnings: [],
    updatedAt: document.derived.updatedAt
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  FakeWorker.instances = [];
});

describe('disposable exact import rebuild worker client', () => {
  it('terminates a missing worker and reports the deployment recovery action', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubEnv('OZ_BUILD_COMMIT', 'old-build');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ commit: 'new-build' })
      }))
    );
    const notice = vi.fn();
    const stop = onStaleChunk(notice);
    const document = createProjectDocument('Import', toUserId('user'));
    const original = structuredClone(document);
    try {
      const pending = rebuildImportInDisposableWorker(document);
      const rejected = expect(pending).rejects.toThrow(STALE_CHUNK_MESSAGE);
      const worker = FakeWorker.instances[0]!;
      worker.onerror?.();
      expect(worker.terminated).toBe(true);
      await rejected;
      expect(notice).toHaveBeenCalledOnce();
      expect(document).toEqual(original);
    } finally {
      stop();
    }
  });

  it('reports missing lazy kernel chunks as a reloadable failure', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const document = createProjectDocument('Import', toUserId('user'));
    const pending = rebuildImportInDisposableWorker(document);
    const rejected = expect(pending).rejects.toThrow(STALE_CHUNK_MESSAGE);
    const worker = FakeWorker.instances[0]!;
    worker.onmessage?.({
      data: {
        type: 'result',
        requestId: worker.request!.requestId,
        ok: false,
        error:
          'Failed to fetch dynamically imported module: /assets/exact-old.js'
      }
    } as MessageEvent<ImportRebuildWorkerResult>);
    await rejected;
    expect(worker.terminated).toBe(true);
  });

  it('terminates a rebuild on cancel and creates a clean worker for retry', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const document = createProjectDocument(
      'Cancelled import',
      toUserId('user_import_worker')
    );
    const controller = new AbortController();
    const cancelled = rebuildImportInDisposableWorker(
      document,
      controller.signal
    );
    const first = FakeWorker.instances[0]!;

    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.terminated).toBe(true);

    const retry = rebuildImportInDisposableWorker(document);
    const second = FakeWorker.instances[1]!;
    expect(second).not.toBe(first);
    expect(second.terminated).toBe(false);
    second.onmessage?.({
      data: {
        type: 'result',
        requestId: second.request!.requestId,
        ok: true,
        derived: emptyDerived(document)
      }
    } as MessageEvent<ImportRebuildWorkerResult>);

    await expect(retry).resolves.toEqual(emptyDerived(document));
    expect(second.terminated).toBe(true);
  });

  it('terminates after an exact-kernel refusal', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const document = createProjectDocument(
      'Refused import',
      toUserId('user_import_refusal')
    );
    const pending = rebuildImportInDisposableWorker(document);
    const worker = FakeWorker.instances[0]!;
    worker.onmessage?.({
      data: {
        type: 'result',
        requestId: worker.request!.requestId,
        ok: false,
        error: 'STEP topology is invalid.'
      }
    } as MessageEvent<ImportRebuildWorkerResult>);

    await expect(pending).rejects.toThrow('STEP topology is invalid.');
    expect(worker.terminated).toBe(true);
  });
});
