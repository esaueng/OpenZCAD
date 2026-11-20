import type { BuildCancellationSignal } from './exact-cancellation';

export interface PatternOverlapRequest {
  pairs: Uint8Array[];
}

export interface PatternOverlapReply {
  volumes: (number | null)[] | null;
}

const RESPONSE_TIMEOUT_MS = 350;
const STARTUP_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 15000;

/** Each worker handles one request at a time. Closing its pool aborts the
 * reply listener as well as the WASM operation running in the worker. */
function request(
  worker: Worker,
  pairs: Uint8Array[],
  signal: AbortSignal
): Promise<(number | null)[]> {
  return new Promise((resolve, reject) => {
    const clear = () => {
      signal.removeEventListener('abort', failed);
      worker.removeEventListener('error', failed);
      worker.removeEventListener('messageerror', failed);
      worker.removeEventListener('message', receive);
    };
    const failed = () => {
      clear();
      reject(new Error('Pattern intersection worker unavailable.'));
    };
    const receive = ({ data }: MessageEvent<PatternOverlapReply>) => {
      const volumes = data?.volumes;
      if (!Array.isArray(volumes) || volumes.length !== pairs.length) {
        failed();
        return;
      }
      clear();
      resolve(volumes);
    };
    signal.addEventListener('abort', failed, { once: true });
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    worker.addEventListener('message', receive);
    try {
      worker.postMessage({ pairs } satisfies PatternOverlapRequest);
    } catch {
      failed();
    }
  });
}

/** One adapter's auxiliary exact kernels. Warm-up runs in the background.
 * Every missed or refused measurement remains the live kernel's job. */
export class PatternOverlapWorkers {
  private workers: Worker[] = [];
  private controller?: AbortController;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disabled = false;

  get available(): boolean {
    return this.workers.length > 0 && !this.controller;
  }

  warm(): void {
    if (
      this.workers.length ||
      this.disabled ||
      typeof Worker === 'undefined' ||
      typeof document !== 'undefined' ||
      typeof navigator === 'undefined' ||
      navigator.hardwareConcurrency < 4 ||
      !navigator.hardwareConcurrency
    )
      return;
    try {
      const count = Math.min(4, navigator.hardwareConcurrency - 1);
      for (let i = 0; i < count; i++) {
        this.workers.push(
          new Worker(
            new URL('./exact-pattern-overlap-worker.ts', import.meta.url),
            { type: 'module' }
          )
        );
      }
      // An empty request loads the same pinned module as the live kernel.
      void this.run(
        this.workers.map(() => []),
        STARTUP_TIMEOUT_MS
      );
    } catch {
      this.stop(true);
    }
  }

  measure(
    pairs: Uint8Array[],
    signal?: BuildCancellationSignal
  ): Promise<(number | null)[] | undefined> | undefined {
    if (!this.available || signal?.isCancelled()) return;
    const width = this.workers.length;
    const chunks: Uint8Array[][] = this.workers.map(() => []);
    for (const [index, pair] of pairs.entries())
      chunks[index % width]!.push(pair);
    // Post synchronously so the live kernel can fuse while the helpers run.
    const batch = this.run(chunks, RESPONSE_TIMEOUT_MS).then(
      (replies) =>
        replies &&
        pairs.map((_, i) => replies[i % width]![Math.floor(i / width)] ?? null)
    );
    if (!signal) return batch;
    // A superseding edit can rebuild immediately. Keep the old jobs isolated
    // and unavailable for reuse until they reply or hit their deadline.
    return new Promise((resolve) => {
      const cancel = setInterval(() => {
        if (signal.isCancelled()) {
          clearInterval(cancel);
          resolve(undefined);
        }
      }, 25);
      void batch.then((values) => {
        clearInterval(cancel);
        resolve(signal.isCancelled() ? undefined : values);
      });
    });
  }

  private async run(chunks: Uint8Array[][], timeout: number) {
    clearTimeout(this.idleTimer);
    const controller = new AbortController();
    this.controller = controller;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // A synchronous fuse on this thread can last longer than the deadline.
    // Let it yield before starting the clock for missing worker replies.
    queueMicrotask(() => {
      if (this.controller === controller)
        deadline = setTimeout(() => controller.abort(), timeout);
    });
    try {
      return await Promise.all(
        this.workers.map((worker, index) =>
          request(worker, chunks[index]!, controller.signal)
        )
      );
    } catch {
      if (this.controller === controller) this.stop(true);
      return undefined;
    } finally {
      clearTimeout(deadline);
      if (this.controller === controller) {
        this.controller = undefined;
        this.idleTimer = setTimeout(() => this.dispose(), IDLE_TIMEOUT_MS);
      }
    }
  }

  dispose(): void {
    this.stop(false);
  }

  private stop(disabled: boolean): void {
    this.disabled = disabled;
    clearTimeout(this.idleTimer);
    this.controller?.abort();
    this.controller = undefined;
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}
