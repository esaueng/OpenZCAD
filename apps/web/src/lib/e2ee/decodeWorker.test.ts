import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { E2eeError, type ContentBlobReference } from '@openzcad/crypto';
import {
  DEFAULT_DECODE_BUDGETS_MS,
  DecodeWorkerError,
  createE2eeDecoder,
  type DecodeWorkerHandle
} from './decodeWorker';
import type {
  DecodeResult,
  DecodeWorkerRequest,
  DecodeWorkerResponse
} from './decodeJobs';

/** A worker that answers only when the test tells it to. */
class FakeWorker implements DecodeWorkerHandle {
  onmessage: ((event: MessageEvent<DecodeWorkerResponse>) => void) | null =
    null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly posted: DecodeWorkerRequest[] = [];
  terminated = false;
  throwOnPost: Error | null = null;

  postMessage(message: DecodeWorkerRequest): void {
    if (this.throwOnPost) throw this.throwOnPost;
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: DecodeWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<DecodeWorkerResponse>);
  }

  resolveLast(result: DecodeResult = documentResult): void {
    this.reply({ id: this.posted.at(-1)!.id, ok: true, result });
  }

  crash(): void {
    this.onerror?.(new Event('error'));
  }
}

const documentResult: DecodeResult = {
  type: 'project-envelope',
  header: {} as never,
  value: {
    document: { nodes: {} },
    blobs: [],
    revisionVersionHashes: new Map()
  }
};

const projectJob = {
  kind: 'document' as const,
  versionKey: new Uint8Array(32),
  envelope: new Uint8Array(8)
};

const blobJob = {
  reference: { kind: 'import-source' } as ContentBlobReference,
  envelope: new Uint8Array(8),
  output: 'chunks' as const
};

let workers: FakeWorker[];
const createWorker = () => {
  const worker = new FakeWorker();
  workers.push(worker);
  return worker;
};

beforeEach(() => {
  workers = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('decode worker client', () => {
  it('starts no worker until the first job', async () => {
    const decoder = createE2eeDecoder({ createWorker });
    expect(workers).toHaveLength(0);
    const job = decoder.decodeProjectEnvelope(projectJob);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted[0]!.job).toMatchObject({
      type: 'project-envelope',
      kind: 'document'
    });
    workers[0]!.resolveLast();
    await expect(job).resolves.toEqual(documentResult);
    decoder.dispose();
  });

  it('terminates a job past its budget and runs the next on a fresh worker', async () => {
    const decoder = createE2eeDecoder({ createWorker });
    const stalled = decoder.decodeProjectEnvelope(projectJob);
    const next = decoder.decodeProjectEnvelope(projectJob);
    const stalledOutcome = stalled.catch((error: unknown) => error);
    // The second job waits; it is not sent to the busy worker.
    expect(workers[0]!.posted).toHaveLength(1);

    vi.advanceTimersByTime(DEFAULT_DECODE_BUDGETS_MS['project-envelope']);
    const error = await stalledOutcome;
    expect(error).toBeInstanceOf(DecodeWorkerError);
    expect(error).toMatchObject({ code: 'timeout' });
    expect(workers[0]!.terminated).toBe(true);

    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toHaveLength(1);
    workers[1]!.resolveLast();
    await expect(next).resolves.toEqual(documentResult);
    expect(workers[1]!.terminated).toBe(false);
    decoder.dispose();
  });

  it('starts each budget when the job reaches the worker, not when queued', async () => {
    const decoder = createE2eeDecoder({
      createWorker,
      budgetsMs: { 'project-envelope': 1_000 }
    });
    const first = decoder.decodeProjectEnvelope(projectJob);
    const second = decoder.decodeProjectEnvelope(projectJob);
    vi.advanceTimersByTime(900);
    workers[0]!.resolveLast();
    await expect(first).resolves.toEqual(documentResult);
    // 900 ms queued plus 900 ms running: still inside its own 1 s.
    vi.advanceTimersByTime(900);
    workers[0]!.resolveLast();
    await expect(second).resolves.toEqual(documentResult);
    expect(workers).toHaveLength(1);
    decoder.dispose();
  });

  it('applies a per-job budget and the content blob default', async () => {
    const decoder = createE2eeDecoder({ createWorker });
    const blob = decoder.decodeContentBlob(blobJob);
    const blobOutcome = blob.catch((error: unknown) => error);
    vi.advanceTimersByTime(DEFAULT_DECODE_BUDGETS_MS['project-envelope']);
    expect(workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(
      DEFAULT_DECODE_BUDGETS_MS['content-blob'] -
        DEFAULT_DECODE_BUDGETS_MS['project-envelope']
    );
    expect(await blobOutcome).toMatchObject({ code: 'timeout' });

    const quick = decoder
      .decodeProjectEnvelope(projectJob, { budgetMs: 50 })
      .catch((error: unknown) => error);
    vi.advanceTimersByTime(50);
    expect(await quick).toMatchObject({ code: 'timeout' });
    expect(workers.map((worker) => worker.terminated)).toEqual([true, true]);
    await expect(
      decoder.decodeProjectEnvelope(projectJob, { budgetMs: Number.NaN })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    decoder.dispose();
  });

  it('surfaces a refusal as its E2eeError and keeps the worker', async () => {
    const decoder = createE2eeDecoder({ createWorker });
    const refused = decoder.decodeProjectEnvelope(projectJob);
    workers[0]!.reply({
      id: workers[0]!.posted[0]!.id,
      ok: false,
      error: { code: 'limit-exceeded', message: 'Payload is too large' }
    });
    await expect(refused).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof E2eeError &&
        error.code === 'limit-exceeded' &&
        error.message === 'Payload is too large'
    );
    expect(workers[0]!.terminated).toBe(false);

    // Not wedged: the next job runs, on the same worker.
    const next = decoder.decodeProjectEnvelope(projectJob);
    expect(workers[0]!.posted).toHaveLength(2);
    workers[0]!.resolveLast();
    await expect(next).resolves.toEqual(documentResult);
    expect(workers).toHaveLength(1);
    decoder.dispose();
  });

  it('replaces a worker that crashes or replies with nonsense', async () => {
    const decoder = createE2eeDecoder({ createWorker });
    const crashed = decoder.decodeProjectEnvelope(projectJob);
    workers[0]!.crash();
    await expect(crashed).rejects.toMatchObject({ code: 'worker-failed' });
    expect(workers[0]!.terminated).toBe(true);

    const garbled = decoder.decodeProjectEnvelope(projectJob);
    workers[1]!.reply({
      id: workers[1]!.posted[0]!.id,
      ok: true,
      result: { type: 'content-blob', byteLength: 0, chunks: [] }
    });
    await expect(garbled).rejects.toMatchObject({ code: 'worker-failed' });
    expect(workers[1]!.terminated).toBe(true);

    const next = decoder.decodeProjectEnvelope(projectJob);
    workers[2]!.resolveLast();
    await expect(next).resolves.toEqual(documentResult);
    decoder.dispose();
  });

  it('ignores replies for another job', async () => {
    const decoder = createE2eeDecoder({ createWorker });
    const job = decoder.decodeProjectEnvelope(projectJob);
    const id = workers[0]!.posted[0]!.id;
    workers[0]!.reply({ id: id + 100, ok: true, result: documentResult });
    let settled = false;
    void job.finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    workers[0]!.reply({ id, ok: true, result: documentResult });
    await expect(job).resolves.toEqual(documentResult);
    decoder.dispose();
  });

  it('refuses a job that cannot be sent without dropping the worker', async () => {
    const decoder = createE2eeDecoder({ createWorker });
    const first = decoder.decodeProjectEnvelope(projectJob);
    workers[0]!.resolveLast();
    await first;
    workers[0]!.throwOnPost = new DOMException('no', 'DataCloneError');
    await expect(
      decoder.decodeProjectEnvelope(projectJob)
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(workers[0]!.terminated).toBe(false);
    workers[0]!.throwOnPost = null;
    const next = decoder.decodeProjectEnvelope(projectJob);
    workers[0]!.resolveLast();
    await expect(next).resolves.toEqual(documentResult);
    decoder.dispose();
  });

  it('rejects a job whose worker cannot start, then tries again', async () => {
    let fail = true;
    const decoder = createE2eeDecoder({
      createWorker: () => {
        if (fail) throw new Error('blocked');
        return createWorker();
      }
    });
    await expect(
      decoder.decodeProjectEnvelope(projectJob)
    ).rejects.toMatchObject({ code: 'worker-failed' });
    fail = false;
    const next = decoder.decodeProjectEnvelope(projectJob);
    workers[0]!.resolveLast();
    await expect(next).resolves.toEqual(documentResult);
    decoder.dispose();
  });

  it('disposes the worker and every pending job', async () => {
    const decoder = createE2eeDecoder({ createWorker });
    const running = decoder.decodeProjectEnvelope(projectJob);
    const queued = decoder.decodeContentBlob(blobJob);
    decoder.dispose();
    await expect(running).rejects.toMatchObject({ code: 'disposed' });
    await expect(queued).rejects.toMatchObject({ code: 'disposed' });
    expect(workers[0]!.terminated).toBe(true);
    await expect(
      decoder.decodeProjectEnvelope(projectJob)
    ).rejects.toMatchObject({ code: 'disposed' });
    expect(workers).toHaveLength(1);
  });
});
