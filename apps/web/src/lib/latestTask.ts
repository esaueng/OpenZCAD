/** Main-thread coalescing also works while the worker is inside synchronous WASM. */
export class LatestTask<T> {
  private running = false;
  private pending: {
    run(): Promise<T>;
    resolve(value: T): void;
    reject(error: Error): void;
  } | null = null;

  request(run: () => Promise<T>): Promise<T> {
    this.cancelPending();
    return new Promise((resolve, reject) => {
      this.pending = { run, resolve, reject };
      void this.drain();
    });
  }

  cancelPending(): void {
    if (this.pending) {
      this.pending.reject(
        new DOMException('Superseded request.', 'AbortError')
      );
      this.pending = null;
    }
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const job = this.pending;
        this.pending = null;
        try {
          job.resolve(await job.run());
        } catch (error) {
          job.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.running = false;
    }
  }
}
