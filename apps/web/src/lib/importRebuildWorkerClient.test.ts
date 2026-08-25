import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

import { rebuildImportInDisposableWorker } from './importRebuildWorkerClient';
import type {
  ImportRebuildWorkerRequest,
  ImportRebuildWorkerResult
} from '../worker/importRebuildWorker';

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
  FakeWorker.instances = [];
});

describe('disposable exact import rebuild worker client', () => {
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
