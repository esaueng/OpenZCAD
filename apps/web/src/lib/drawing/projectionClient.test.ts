import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DrawingProjectionRelease,
  DrawingProjectionRequest
} from '../../worker/drawingProjectionWorker';
import type { ProjectionBodyInput } from './projectView';
import {
  DrawingProjectionClient,
  projectionWorkerCount
} from './projectionClient';

type Sent = DrawingProjectionRequest | DrawingProjectionRelease;

/** A stand-in worker that records what it is sent and answers on demand. */
class FakeWorker {
  static last: FakeWorker | null = null;
  static all: FakeWorker[] = [];
  sent: Sent[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
    FakeWorker.all.push(this);
  }
  postMessage(message: Sent) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** The project messages, without releases. */
  get projects(): DrawingProjectionRequest[] {
    return this.sent.filter(
      (message): message is DrawingProjectionRequest =>
        message.type === 'project'
    );
  }
  answer(index: number, results: Record<string, unknown> = {}) {
    const request = this.projects[index]!;
    this.onmessage?.({
      data: { type: 'projection', requestId: request.requestId, results }
    } as MessageEvent);
  }
  crash() {
    this.onerror?.({ preventDefault() {} } as ErrorEvent);
  }
}

const view = (key: string) => ({
  key,
  orientation: 'front' as const,
  hiddenLines: true,
  bodyIds: []
});

const ready = {
  ok: true,
  projection: { visible: [], hidden: [], bounds: null }
};

const body: ProjectionBodyInput = {
  vertices: new Float32Array(9),
  indices: Uint32Array.from([0, 1, 2]),
  edges: []
};

describe('DrawingProjectionClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.last = null;
    FakeWorker.all = [];
  });

  it('keeps one request in the worker and lets the latest waiting one win', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new DrawingProjectionClient(1);
    const first = client.project({}, [view('a')]);
    const second = client.project({}, [view('b')]);
    const third = client.project({}, [view('c')]);
    const worker = FakeWorker.last!;
    // Only the first went out; the second was superseded while it waited.
    expect(worker.projects.map((message) => message.views[0]!.key)).toEqual([
      'a'
    ]);
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    worker.answer(0);
    await expect(first).resolves.toEqual({});
    // The latest one goes next, once the worker is free.
    expect(worker.projects.map((message) => message.views[0]!.key)).toEqual([
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
      override postMessage(message: Sent) {
        if (ThrowingWorker.throwNext) {
          ThrowingWorker.throwNext = false;
          throw new DOMException('could not be cloned', 'DataCloneError');
        }
        super.postMessage(message);
      }
    }
    vi.stubGlobal('Worker', ThrowingWorker);
    const client = new DrawingProjectionClient(1);
    await expect(client.project({}, [view('a')])).rejects.toMatchObject({
      name: 'DataCloneError'
    });
    // The next request goes straight out rather than waiting forever.
    const next = client.project({}, [view('b')]);
    const worker = FakeWorker.last!;
    expect(worker.projects.map((message) => message.views[0]!.key)).toEqual([
      'b'
    ]);
    worker.answer(0);
    await expect(next).resolves.toEqual({});
    client.dispose();
  });

  it("projects a sheet's views side by side and shows each as it lands", async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new DrawingProjectionClient(3);
    const landed: string[] = [];
    const batch = client.project(
      { b1: body },
      ['front', 'top', 'left', 'iso'].map(view),
      (key) => landed.push(key)
    );
    // Three workers, one view each; the fourth waits for a free one.
    expect(FakeWorker.all).toHaveLength(3);
    expect(
      FakeWorker.all.map((worker) => worker.projects[0]!.views[0]!.key)
    ).toEqual(['front', 'top', 'left']);
    // Every worker is sent the geometry with its first view.
    for (const worker of FakeWorker.all)
      expect(worker.projects[0]!.bodies).toEqual({ b1: body });
    const [one, two, three] = FakeWorker.all as [
      FakeWorker,
      FakeWorker,
      FakeWorker
    ];
    two.answer(0, { top: ready });
    // The answered view lands at once, and its worker takes the last view
    // with the geometry it already holds.
    expect(landed).toEqual(['top']);
    expect(two.projects[1]!.views[0]!.key).toBe('iso');
    expect(two.projects[1]!.bodies).toBeUndefined();
    let settled = false;
    void batch.then(() => {
      settled = true;
    });
    two.answer(1, { iso: ready });
    one.answer(0, { front: ready });
    await Promise.resolve();
    expect(settled).toBe(false);
    three.answer(0, { left: ready });
    await expect(batch).resolves.toEqual({
      front: ready,
      top: ready,
      left: ready,
      iso: ready
    });
    expect(landed).toEqual(['top', 'iso', 'front', 'left']);
    // The finished batch's geometry is let go.
    for (const worker of FakeWorker.all)
      expect(worker.sent.at(-1)).toEqual({ type: 'release' });
    client.dispose();
  });

  it('fails the batch when a worker projecting it stops, and keeps the rest', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new DrawingProjectionClient(2);
    const landed: string[] = [];
    const batch = client.project({}, [view('a'), view('b')], (key) =>
      landed.push(key)
    );
    const [one, two] = FakeWorker.all as [FakeWorker, FakeWorker];
    one.answer(0, { a: ready });
    two.crash();
    await expect(batch).rejects.toThrow(/projection worker stopped/);
    expect(landed).toEqual(['a']);
    expect(two.terminated).toBe(true);
    // The next batch uses the surviving worker and starts a fresh one.
    const next = client.project({}, [view('c'), view('d')]);
    expect(one.projects.at(-1)!.views[0]!.key).toBe('c');
    expect(FakeWorker.all).toHaveLength(3);
    one.answer(1);
    FakeWorker.all[2]!.answer(0);
    await expect(next).resolves.toEqual({});
    client.dispose();
  });

  it('runs a worker per spare core, up to four', () => {
    expect(projectionWorkerCount(1)).toBe(1);
    expect(projectionWorkerCount(2)).toBe(1);
    expect(projectionWorkerCount(4)).toBe(3);
    expect(projectionWorkerCount(16)).toBe(4);
    expect(projectionWorkerCount(undefined)).toBe(2);
  });
});
