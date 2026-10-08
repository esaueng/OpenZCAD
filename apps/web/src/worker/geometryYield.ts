/**
 * Give the worker message queue a turn after a bounded amount of geometry
 * work. Microtask yields cannot deliver `message` events. Task yields allow
 * the broadcast gate to observe newer edits without overlapping kernel jobs.
 * A single WASM operation is synchronous and may exceed this budget.
 */
export function geometryYield(
  now: () => number = () => performance.now(),
  task: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 0)),
  budgetMs = 8
): () => Promise<void> | void {
  let lastYield = now();
  return () => {
    if (now() - lastYield < budgetMs) return;
    return task().then(() => {
      lastYield = now();
    });
  };
}
