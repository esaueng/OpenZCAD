/**
 * Client for the ADR-024 decode worker (Decompression limits): decrypts,
 * inflates and parses end-to-end encrypted project data in a module Worker,
 * under a wall-clock budget per job.
 *
 * Contract for callers:
 *
 * - **Keep the last good version.** A job either resolves with a value that
 *   passed every limit or rejects; the caller must not replace what it shows
 *   or stores until a job resolves, and on any rejection keeps the version it
 *   already had. A refused version is never partially applied: content blobs
 *   resolve only once the whole blob has authenticated.
 * - **Never wait on a stuck worker.** Jobs run one at a time. Each one's
 *   budget starts when it reaches the worker. A job that overruns it rejects
 *   with `DecodeWorkerError` `timeout`, the worker is terminated (decryption
 *   and inflation cannot be interrupted any other way), and the next job runs
 *   on a fresh worker. A worker that crashes or fails to load rejects its job
 *   with `worker-failed` and is replaced the same way.
 * - **Typed refusals.** A version the worker refuses rejects with the
 *   `E2eeError` it raised: `limit-exceeded` for a declared size over the
 *   kind's ceiling, a body that inflates past its declared size, or JSON over
 *   the depth or value limits; `malformed` for a body that inflates to
 *   anything other than its declared size, or that is not UTF-8 JSON;
 *   `authentication-failed`, `context-mismatch` and the rest as the crypto
 *   package defines them. A refusal leaves the worker running for the next
 *   job.
 *
 * The worker script is loaded on the first job, not when this module is
 * imported, so it stays out of the entry chunk.
 */
import { E2eeError, type E2eeErrorCode } from '@openzcad/crypto';
import type {
  ContentBlobDecodeJob,
  ContentBlobDecodeResult,
  DecodeJob,
  DecodeResult,
  DecodeWorkerRequest,
  DecodeWorkerResponse,
  ProjectEnvelopeDecodeJob,
  ProjectEnvelopeDecodeResult,
  SealDocumentJob,
  SealDocumentResult
} from './decodeJobs';

export type {
  ContentBlobDecodeResult,
  ProjectEnvelopeDecodeResult,
  SealDocumentResult
} from './decodeJobs';

/**
 * Wall-clock budgets, in milliseconds. Judgment, not measurement: a 24 MiB
 * document or a 128 MiB blob decodes in a few seconds on ordinary hardware,
 * so these leave a wide margin and only bound a job that has stalled or is
 * grinding through something hostile.
 */
export const DEFAULT_DECODE_BUDGETS_MS = Object.freeze({
  'project-envelope': 20_000,
  'content-blob': 90_000,
  'seal-document': 60_000
});

export type DecodeWorkerErrorCode =
  /** The job overran its budget; its worker was terminated. */
  | 'timeout'
  /** The worker crashed, failed to load or sent an unreadable reply. */
  | 'worker-failed'
  /** The decoder was disposed before the job finished. */
  | 'disposed';

/** A failure of the worker itself, as opposed to a refused version. */
export class DecodeWorkerError extends Error {
  override readonly name = 'DecodeWorkerError';
  constructor(
    readonly code: DecodeWorkerErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** The part of `Worker` the client uses, so tests can supply a fake. */
export interface DecodeWorkerHandle {
  onmessage: ((event: MessageEvent<DecodeWorkerResponse>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: DecodeWorkerRequest): void;
  terminate(): void;
}

export interface DecodeWorkerOptions {
  /** Starts a worker; defaults to the module Worker. */
  readonly createWorker?: () => DecodeWorkerHandle;
  /** Overrides `DEFAULT_DECODE_BUDGETS_MS` per job type. */
  readonly budgetsMs?: Partial<Record<DecodeJob['type'], number>>;
}

export interface JobOptions {
  /** This job's budget, instead of the default for its type. */
  readonly budgetMs?: number;
}

export interface E2eeDecoder {
  decodeProjectEnvelope(
    job: Omit<ProjectEnvelopeDecodeJob, 'type'>,
    options?: JobOptions
  ): Promise<ProjectEnvelopeDecodeResult>;
  decodeContentBlob(
    job: Omit<ContentBlobDecodeJob, 'type'>,
    options?: JobOptions
  ): Promise<ContentBlobDecodeResult>;
  /** Encodes and encrypts a document version (`sealDocumentJob`). */
  sealDocument(
    job: Omit<SealDocumentJob, 'type'>,
    options?: JobOptions
  ): Promise<SealDocumentResult>;
  /** Terminates the worker and rejects every pending job (`disposed`). */
  dispose(): void;
}

function startModuleWorker(): DecodeWorkerHandle {
  return new Worker(
    new URL('../../worker/e2eeDecodeWorker.ts', import.meta.url),
    { type: 'module' }
  ) as unknown as DecodeWorkerHandle;
}

interface PendingJob {
  readonly id: number;
  readonly job: DecodeJob;
  readonly budgetMs: number;
  readonly resolve: (result: DecodeResult) => void;
  readonly reject: (error: Error) => void;
}

function refusal(error: unknown): Error {
  const failure = error as { code?: unknown; message?: unknown } | null;
  const message =
    typeof failure?.message === 'string' && failure.message
      ? failure.message
      : 'The decode worker failed';
  return typeof failure?.code === 'string'
    ? new E2eeError(failure.code as E2eeErrorCode, message)
    : new DecodeWorkerError('worker-failed', message);
}

function validBudget(budgetMs: number): boolean {
  return Number.isFinite(budgetMs) && budgetMs > 0;
}

export function createE2eeDecoder(
  options: DecodeWorkerOptions = {}
): E2eeDecoder {
  const createWorker = options.createWorker ?? startModuleWorker;
  const budgets = { ...DEFAULT_DECODE_BUDGETS_MS, ...options.budgetsMs };
  const queue: PendingJob[] = [];
  let worker: DecodeWorkerHandle | null = null;
  let running: {
    readonly pending: PendingJob;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let nextId = 1;
  let disposed = false;

  const discardWorker = () => {
    const current = worker;
    worker = null;
    if (!current) return;
    current.onmessage = null;
    current.onerror = null;
    current.onmessageerror = null;
    current.terminate();
  };

  /** Settles the running job and moves on; `replace` drops its worker. */
  const finish = (
    outcome: { ok: true; result: DecodeResult } | { ok: false; error: Error },
    replace: boolean
  ) => {
    const current = running;
    if (!current) {
      if (replace) discardWorker();
      return;
    }
    running = null;
    clearTimeout(current.timer);
    if (replace) discardWorker();
    if (outcome.ok) current.pending.resolve(outcome.result);
    else current.pending.reject(outcome.error);
    pump();
  };

  const startWorker = (): DecodeWorkerHandle => {
    const created = createWorker();
    created.onmessage = (event) => {
      if (worker !== created) return;
      const reply = event.data;
      if (!running || reply?.id !== running.pending.id) return;
      if (
        reply.ok === true &&
        reply.result?.type === running.pending.job.type
      ) {
        finish({ ok: true, result: reply.result }, false);
      } else if (reply.ok === false) {
        finish({ ok: false, error: refusal(reply.error) }, false);
      } else {
        finish(
          {
            ok: false,
            error: new DecodeWorkerError(
              'worker-failed',
              'The decode worker sent an unexpected reply'
            )
          },
          true
        );
      }
    };
    const crashed = (message: string) => (event: Event) => {
      if (worker !== created) return;
      event.preventDefault?.();
      finish(
        { ok: false, error: new DecodeWorkerError('worker-failed', message) },
        true
      );
    };
    created.onerror = crashed('The decode worker failed');
    created.onmessageerror = crashed('The decode worker reply was unreadable');
    return created;
  };

  const pump = () => {
    while (!running && !disposed) {
      const pending = queue.shift();
      if (!pending) return;
      let target: DecodeWorkerHandle;
      try {
        target = worker ??= startWorker();
      } catch {
        worker = null;
        pending.reject(
          new DecodeWorkerError(
            'worker-failed',
            'The decode worker did not start'
          )
        );
        continue;
      }
      const timer = setTimeout(() => {
        if (running?.pending !== pending) return;
        finish(
          {
            ok: false,
            error: new DecodeWorkerError(
              'timeout',
              `Decoding took longer than ${pending.budgetMs} ms`
            )
          },
          true
        );
      }, pending.budgetMs);
      running = { pending, timer };
      try {
        target.postMessage({ id: pending.id, job: pending.job });
      } catch (error) {
        // Nothing reached the worker (the job could not be cloned), so it
        // stays usable for the next job.
        finish(
          {
            ok: false,
            error: new E2eeError(
              'invalid-argument',
              'The decode job could not be sent to the worker',
              { cause: error }
            )
          },
          false
        );
      }
    }
  };

  const submit = <R extends DecodeResult>(
    job: DecodeJob,
    jobOptions: JobOptions | undefined
  ): Promise<R> => {
    if (disposed) {
      return Promise.reject(
        new DecodeWorkerError('disposed', 'The decoder was disposed')
      );
    }
    const budgetMs = jobOptions?.budgetMs ?? budgets[job.type];
    if (!validBudget(budgetMs)) {
      return Promise.reject(
        new E2eeError(
          'invalid-argument',
          'A decode budget must be a positive number of milliseconds'
        )
      );
    }
    return new Promise<R>((resolve, reject) => {
      queue.push({
        id: nextId++,
        job,
        budgetMs,
        resolve: resolve as (result: DecodeResult) => void,
        reject
      });
      pump();
    });
  };

  return {
    decodeProjectEnvelope: (job, jobOptions) =>
      submit({ ...job, type: 'project-envelope' }, jobOptions),
    decodeContentBlob: (job, jobOptions) =>
      submit({ ...job, type: 'content-blob' }, jobOptions),
    sealDocument: (job, jobOptions) =>
      submit({ ...job, type: 'seal-document' }, jobOptions),
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new DecodeWorkerError(
        'disposed',
        'The decoder was disposed'
      );
      const current = running;
      running = null;
      if (current) clearTimeout(current.timer);
      discardWorker();
      current?.pending.reject(error);
      for (const pending of queue.splice(0)) pending.reject(error);
    }
  };
}
