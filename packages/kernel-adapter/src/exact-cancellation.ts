/**
 * Typed, transactional cancellation of superseded exact rebuilds.
 *
 * A WASM call cannot observe a JS cancel while it is running, so in a
 * single-threaded worker cancellation is effective before a call and between
 * operations — the build loop checks the signal at each feature boundary and
 * latches the shared kernel token, and every cancellable boolean refuses a
 * latched token before touching topology. The kernel documents its own cancel
 * as transactional (no partial topology retained), and the adapter matches it:
 * a cancelled build throws instead of returning, so no partial
 * `ExactBuildResult` and no checkpoint row is ever committed as a success.
 *
 * Everything here branches on typed fields, never on kernel prose. A stale
 * generation reads as cancellation — a superseded rebuild IS a cancelled one —
 * and the only family that names an operation stays the booleans: the
 * cancellable kernel entry point on this pin is the boolean, and presenters
 * branch on `category`, never on `family`.
 */
import type {
  CancellableBooleanResult,
  OperationCancellationToken,
  RemusKernel
} from './remus-runtime';
import { KernelRefusal, kernelRefusalCategoryOf } from './kernel-refusal';
import {
  ExactBooleanRefusal,
  exactBooleanOutcome,
  type ExactBooleanOperation,
  type ExactBooleanOutcome
} from './exact-boolean-refusal';

/**
 * Cooperative cancel observed at feature boundaries and before kernel calls.
 *
 * The worker builds one from its queued-cancel set plus its broadcast gate; a
 * caller that versions its own rebuilds uses {@link generationCancellation}.
 */
export interface BuildCancellationSignal {
  isCancelled(): boolean;
}

/**
 * One rebuild's cancellation state: the cooperative signal plus the kernel
 * token every cancellable boolean of the build shares. The token is one-shot
 * by kernel design, which is what a superseded build wants — once latched,
 * every later call in the same build refuses without further checks.
 */
export interface BuildCancellation {
  readonly signal: BuildCancellationSignal;
  readonly token: OperationCancellationToken;
}

/** The kernel's stable cancellation code, observed on the pin. */
const CANCELLATION_CODE = 'operation_cancelled';

/**
 * A rebuild whose generation has moved on reads as cancelled.
 *
 * `generation` is the rebuild's own identity (the worker uses its broadcast
 * token); `isCurrent` answers whether that identity is still the newest. A
 * stale answer makes every boundary check throw, so a cancelled or stale
 * result can never overwrite a newer one.
 */
export function generationCancellation(
  generation: number,
  isCurrent: (generation: number) => boolean
): BuildCancellationSignal {
  return {
    isCancelled: () => !isCurrent(generation)
  };
}

/** The boolean a latched token refused, as a typed refusal. */
export function cancelledBooleanRefusal(
  operation: ExactBooleanOperation,
  operands?: readonly string[],
  kernelCode: string = CANCELLATION_CODE,
  kernelMessage = 'the kernel reported cancellation without committing a result'
): ExactBooleanRefusal {
  return new ExactBooleanRefusal({
    operation,
    category: 'cancelled',
    kernelCode,
    kernelMessage,
    operands
  });
}

/**
 * A build stopped at a feature boundary or its generation, as a typed refusal.
 *
 * This travels on the boolean family because the cancellable kernel entry
 * point on this pin is the boolean; the category is the branchable field.
 * It is always thrown, never recorded as a feature warning — recording it
 * would continue the build it exists to stop.
 */
export function cancelledBuildRefusal(): KernelRefusal {
  const reason = 'the rebuild was cancelled before it finished';
  const kernelMessage =
    'the rebuild was superseded before the kernel committed a result';
  return new KernelRefusal({
    family: 'boolean',
    category: 'cancelled',
    kernelCode: CANCELLATION_CODE,
    kernelMessage,
    reason,
    message:
      `Rebuild cancelled: ${reason}.` +
      `\nKernel refusal ${CANCELLATION_CODE} (cancelled): ${kernelMessage}`
  });
}

/** Throws the typed cancellation when the signal has fired. */
export function throwIfBuildCancelled(
  signal?: BuildCancellationSignal | null
): void {
  if (signal?.isCancelled()) {
    throw cancelledBuildRefusal();
  }
}

/** Whether an error is a typed cancellation, however deeply it was wrapped. */
export function isBuildCancelled(error: unknown): boolean {
  return kernelRefusalCategoryOf(error) === 'cancelled';
}

/**
 * One exact boolean through the cancellable kernel entry point.
 *
 * Exact-only semantics are unchanged: the call passes `exact_only`, a
 * completed non-exact disclosure refuses as `quality_refused` rather than
 * committing a faceted body, and any other failure is re-classified through
 * the detailed twin that owns the taxonomy — the cancellable entry throws
 * where the twin returns data, and re-running it once classifies without
 * reading prose. That re-run happens on the failure path only; the success
 * path costs exactly one boolean.
 *
 * A `undefined` cancellation runs the classic detailed path untouched, so
 * callers without a signal observe byte-identical behaviour.
 */
export function exactBooleanOutcomeWithCancellation(
  kernel: RemusKernel,
  operation: ExactBooleanOperation,
  a: number,
  b: number,
  cancellation: BuildCancellation | undefined,
  operands?: readonly string[]
): ExactBooleanOutcome {
  if (cancellation === undefined) {
    return exactBooleanOutcome(kernel, operation, a, b, operands);
  }
  if (cancellation.signal.isCancelled()) {
    // Latch the shared token so later calls in the same superseded build
    // refuse at the kernel too, then answer without touching topology.
    cancellation.token.cancel();
    return {
      status: 'refused',
      refusal: cancelledBooleanRefusal(
        operation,
        operands,
        CANCELLATION_CODE,
        'cancellation was requested before the boolean ran'
      )
    };
  }
  let completed: CancellableBooleanResult;
  try {
    completed = kernel.booleanWithCancellation(
      operation,
      a,
      b,
      cancellation.token,
      true
    );
  } catch {
    if (cancellation.signal.isCancelled()) {
      return {
        status: 'refused',
        refusal: cancelledBooleanRefusal(operation, operands)
      };
    }
    return exactBooleanOutcome(kernel, operation, a, b, operands);
  }
  if (completed.status === 'cancelled') {
    return {
      status: 'refused',
      refusal: cancelledBooleanRefusal(
        operation,
        operands,
        completed.code ?? CANCELLATION_CODE
      )
    };
  }
  const result = completed.result;
  if (!result || result.quality !== 'exact') {
    return {
      status: 'refused',
      refusal: new ExactBooleanRefusal({
        operation,
        category: 'quality_refused',
        kernelCode: 'exact_only_unattainable',
        kernelMessage: 'the cancellable boolean disclosed a non-exact result',
        operands
      })
    };
  }
  return { status: 'ok', solid: result.solid };
}

/** One exact cut, refusing by name rather than by kernel prose. */
export function exactCutWithCancellation(
  kernel: RemusKernel,
  target: number,
  tool: number,
  cancellation: BuildCancellation | undefined,
  operands?: readonly string[]
): number {
  const outcome = exactBooleanOutcomeWithCancellation(
    kernel,
    'cut',
    target,
    tool,
    cancellation,
    operands
  );
  if (outcome.status === 'refused') {
    throw outcome.refusal;
  }
  return outcome.solid;
}

/** One exact union, refusing by name rather than by kernel prose. */
export function exactFuseWithCancellation(
  kernel: RemusKernel,
  a: number,
  b: number,
  cancellation: BuildCancellation | undefined,
  operands?: readonly string[]
): number {
  const outcome = exactBooleanOutcomeWithCancellation(
    kernel,
    'fuse',
    a,
    b,
    cancellation,
    operands
  );
  if (outcome.status === 'refused') {
    throw outcome.refusal;
  }
  return outcome.solid;
}

/** One exact intersection, refusing by name rather than by kernel prose. */
export function exactIntersectWithCancellation(
  kernel: RemusKernel,
  target: number,
  tool: number,
  cancellation: BuildCancellation | undefined,
  operands?: readonly string[]
): number {
  const outcome = exactBooleanOutcomeWithCancellation(
    kernel,
    'intersect',
    target,
    tool,
    cancellation,
    operands
  );
  if (outcome.status === 'refused') {
    throw outcome.refusal;
  }
  return outcome.solid;
}
