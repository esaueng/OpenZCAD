import { afterEach, describe, expect, it, vi } from 'vitest';

import { inspectShaprPair } from './shaprImportWorkerClient';
import type { ShaprImportWorkerResult } from '../worker/shaprImportWorker';

class FakeWorker {
  static latest: FakeWorker | null = null;

  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<ShaprImportWorkerResult>) => void) | null =
    null;
  terminated = false;

  constructor() {
    FakeWorker.latest = this;
  }

  postMessage(): void {}

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.latest = null;
});

describe('SHAPR parser worker client', () => {
  it('terminates the parser worker when the preview is cancelled', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new AbortController();
    const pending = inspectShaprPair(
      new File(['shapr'], 'sample.shapr'),
      new File(['step'], 'sample.step'),
      { signal: controller.signal }
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.latest?.terminated).toBe(true);
  });

  it('terminates after a parser failure', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const pending = inspectShaprPair(
      new File(['shapr'], 'sample.shapr'),
      new File(['step'], 'sample.step')
    );
    const worker = FakeWorker.latest!;

    worker.onmessage?.({
      data: {
        type: 'result',
        requestId: 'mismatched-request',
        ok: false,
        error: 'Unsupported schema'
      }
    } as MessageEvent<ShaprImportWorkerResult>);

    // A mismatched request id is intentionally ignored; crashing still closes
    // the worker and settles the pending request.
    worker.onerror?.();
    await expect(pending).rejects.toThrow('parser worker crashed');
    expect(worker.terminated).toBe(true);
  });
});
