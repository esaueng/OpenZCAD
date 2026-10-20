import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingProjectionRequest } from '../../worker/drawingProjectionWorker';
import { DrawingProjectionClient } from './projectionClient';

/** A stand-in worker that records what it is sent and answers on demand. */
class FakeWorker {
  static last: FakeWorker | null = null;
  sent: DrawingProjectionRequest[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(message: DrawingProjectionRequest) {
    this.sent.push(message);
  }
  terminate() {}
  answer(index: number) {
    const request = this.sent[index]!;
    this.onmessage?.({
      data: { type: 'projection', requestId: request.requestId, results: {} }
    } as MessageEvent);
  }
}

const view = (key: string) => ({
  key,
  orientation: 'front' as const,
  hiddenLines: true,
  bodyIds: []
});

describe('DrawingProjectionClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps one request in the worker and lets the latest waiting one win', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new DrawingProjectionClient();
    const first = client.project({}, [view('a')]);
    const second = client.project({}, [view('b')]);
    const third = client.project({}, [view('c')]);
    const worker = FakeWorker.last!;
    // Only the first went out; the second was superseded while it waited.
    expect(worker.sent.map((message) => message.views[0]!.key)).toEqual(['a']);
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    worker.answer(0);
    await expect(first).resolves.toEqual({});
    // The latest one goes next, once the worker is free.
    expect(worker.sent.map((message) => message.views[0]!.key)).toEqual([
      'a',
      'c'
    ]);
    worker.answer(1);
    await expect(third).resolves.toEqual({});
    client.dispose();
  });

  it('does not leave a phantom request in flight when sending throws', async () => {
    class ThrowingWorker extends FakeWorker {
      static throwNext = true;
      override postMessage(message: DrawingProjectionRequest) {
        if (ThrowingWorker.throwNext) {
          ThrowingWorker.throwNext = false;
          throw new DOMException('could not be cloned', 'DataCloneError');
        }
        super.postMessage(message);
      }
    }
    vi.stubGlobal('Worker', ThrowingWorker);
    const client = new DrawingProjectionClient();
    await expect(client.project({}, [view('a')])).rejects.toMatchObject({
      name: 'DataCloneError'
    });
    // The next request goes straight out rather than waiting forever.
    const next = client.project({}, [view('b')]);
    const worker = FakeWorker.last!;
    expect(worker.sent.map((message) => message.views[0]!.key)).toEqual(['b']);
    worker.answer(0);
    await expect(next).resolves.toEqual({});
    client.dispose();
  });
});
