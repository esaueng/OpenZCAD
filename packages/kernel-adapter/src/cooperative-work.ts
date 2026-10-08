/** Yield to message tasks, rather than only the promise microtask queue. */
export function yieldToWorkerMessages(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Bounded synchronous work slices; a single kernel call remains atomic. */
export class CooperativeWork {
  private started = performance.now();

  constructor(
    private readonly budgetMs = 8,
    private readonly yieldTask = yieldToWorkerMessages
  ) {}

  async checkpoint(force = false): Promise<void> {
    if (force || performance.now() - this.started >= this.budgetMs) {
      await this.yieldTask();
      this.started = performance.now();
    }
  }
}
