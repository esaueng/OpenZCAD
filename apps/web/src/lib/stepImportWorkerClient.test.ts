import { afterEach, expect, it, vi } from 'vitest';
import { inspectStepSolidsInWorker } from './stepImportWorkerClient';
import type { StepImportInspectionResult } from '../worker/stepImportWorker';

class FakeWorker {
  static latest: FakeWorker;
  onmessage:
    ((event: MessageEvent<StepImportInspectionResult>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    FakeWorker.latest = this;
  }
}
afterEach(() => vi.unstubAllGlobals());
it('terminates inspection on cancellation and ignores a late success', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const abort = new AbortController();
  const pending = inspectStepSolidsInWorker(
    new File(['step'], 'two.step'),
    abort.signal
  );
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError'
  });
  abort.abort();
  FakeWorker.latest.onmessage?.({
    data: { ok: true, solidIndices: [0, 1] }
  } as MessageEvent<StepImportInspectionResult>);
  await rejected;
  expect(FakeWorker.latest.terminate).toHaveBeenCalledTimes(1);
});
it('returns declared solid indices unchanged and releases the worker', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const pending = inspectStepSolidsInWorker(new File(['step'], 'two.step'));
  FakeWorker.latest.onmessage?.({
    data: { ok: true, solidIndices: [0, 2] }
  } as MessageEvent<StepImportInspectionResult>);
  await expect(pending).resolves.toEqual([0, 2]);
  expect(FakeWorker.latest.terminate).toHaveBeenCalledTimes(1);
});
