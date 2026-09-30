import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertFreecadFile } from './freecadImportWorkerClient';

class FakeWorker {
  static latest: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request!: { requestId: string; file: File };
  terminate = vi.fn();
  postMessage = vi.fn((request: typeof this.request) => {
    this.request = request;
  });
  constructor() {
    FakeWorker.latest = this;
  }
  reply(data: object) {
    this.onmessage?.({
      data: { requestId: this.request.requestId, ...data }
    } as MessageEvent);
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('FreeCAD disposable conversion worker', () => {
  it('returns a portable STEP source and terminates after success', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const onProgress = vi.fn();
    const promise = convertFreecadFile(new File(['zip'], 'model.FCStd'), {
      onProgress
    });
    const worker = FakeWorker.latest;
    worker.reply({ type: 'progress', message: 'Converting…' });
    expect(onProgress).toHaveBeenCalledWith('Converting…');
    worker.reply({
      type: 'result',
      ok: true,
      solidCount: 2,
      stepBytes: new TextEncoder().encode('STEP').buffer
    });
    const result = await promise;
    expect(result.stepFile.name).toBe('model.FCStd.step');
    expect(result.solidCount).toBe(2);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('terminates on cancellation and ignores results from unrelated requests', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const abort = new AbortController();
    const promise = convertFreecadFile(new File(['zip'], 'model.fcstd'), {
      signal: abort.signal
    });
    const rejected = expect(promise).rejects.toMatchObject({
      name: 'AbortError'
    });
    FakeWorker.latest.onmessage?.({
      data: {
        requestId: 'other',
        type: 'result',
        ok: false,
        error: 'Wrong request'
      }
    } as MessageEvent);
    expect(FakeWorker.latest.terminate).not.toHaveBeenCalled();
    abort.abort();
    await rejected;
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce();
  });
  it.each(['error', 'crash', 'messageerror', 'timeout'])(
    'terminates on %s',
    async (reason) => {
      vi.useFakeTimers();
      vi.stubGlobal('Worker', FakeWorker);
      const promise = convertFreecadFile(new File(['zip'], 'model.fcstd'));
      const rejected = expect(promise).rejects.toThrow();
      const worker = FakeWorker.latest;
      if (reason === 'error')
        worker.reply({ type: 'result', ok: false, error: 'Invalid geometry' });
      if (reason === 'crash') worker.onerror?.();
      if (reason === 'messageerror') worker.onmessageerror?.();
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(120000);
      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  );
  it('declines oversized or already cancelled files before constructing a worker', async () => {
    const worker = vi.fn();
    vi.stubGlobal('Worker', worker);
    const abort = new AbortController();
    abort.abort();
    await expect(
      convertFreecadFile(new File(['x'], 'model.fcstd'), {
        signal: abort.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      convertFreecadFile({ size: 33 * 1024 * 1024 } as File)
    ).rejects.toThrow(/32 MB/);
    expect(worker).not.toHaveBeenCalled();
  });
});
