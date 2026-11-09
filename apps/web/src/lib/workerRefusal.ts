/**
 * A kernel or adapter refusal's classification, carried across the geometry
 * worker boundary.
 *
 * A rebuild that throws instead of returning a feature warning used to reach
 * the app as a bare sentence: the worker posted `error: string`, the client
 * rejected with `new Error(sentence)`, and the release-refusal path could only
 * split prose. Everything that branches on a refusal reads its typed code
 * (`isStaleSelectionError` needs `reference_missing`), so the code has to
 * survive the trip. The worker attaches it here; the client rejects with a
 * {@link GeometryWorkerError} that keeps it.
 */
export interface WorkerRefusal {
  family: string;
  category: string;
  code: string;
  operation?: string;
}

/** Deep enough for any builder's wrapping; mirrors the adapter's own walk. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The refusal behind a thrown error, read structurally so the worker need
 * not load the kernel adapter to classify a failure: a `KernelRefusal` (or
 * an `AdapterRefusal`) carries `family`, `category` and `kernelCode`, at the
 * error itself or somewhere along its `cause` chain.
 */
export function workerRefusalOf(error: unknown): WorkerRefusal | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object') return undefined;
    const candidate = current as {
      family?: unknown;
      category?: unknown;
      kernelCode?: unknown;
      operation?: unknown;
      cause?: unknown;
    };
    if (
      typeof candidate.family === 'string' &&
      typeof candidate.category === 'string' &&
      typeof candidate.kernelCode === 'string'
    ) {
      return {
        family: candidate.family,
        category: candidate.category,
        code: candidate.kernelCode,
        ...(typeof candidate.operation === 'string'
          ? { operation: candidate.operation }
          : {})
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

/** A worker request's failure, with the refusal it carried, if any. */
export class GeometryWorkerError extends Error {
  constructor(
    message: string,
    readonly refusal?: WorkerRefusal
  ) {
    super(message);
    this.name = 'GeometryWorkerError';
  }
}

/** The typed refusal a failed worker request carried. */
export function refusalOfWorkerError(
  error: unknown
): WorkerRefusal | undefined {
  return error instanceof GeometryWorkerError ? error.refusal : undefined;
}
