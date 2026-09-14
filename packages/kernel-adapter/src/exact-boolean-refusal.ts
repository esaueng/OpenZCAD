/**
 * The exact-only boolean contract.
 *
 * Remus's plain `cut` / `fuse` / `intersect` / `fuseAll` are exact-only. Where
 * the exact pipeline cannot produce a result they now THROW rather than hand
 * back a silently approximated, tessellated solid — which is the right
 * behaviour, and the reason the boolean face census that used to catch that
 * fallback is gone. What they throw is a bare `Error` carrying kernel prose,
 * so a caller that only propagates it tells the user "the kernel failed".
 *
 * The typed twins answer the same question as DATA: `cutDetailed`,
 * `fuseDetailed` and `intersectDetailed` return a status, a kernel code and a
 * category. Every boolean in the adapter goes through this module so that
 *
 * - the user reads a named product refusal — which operation refused, on
 *   which bodies, and that the geometry could not be built exactly — and
 * - downstream code branches on {@link ExactBooleanRefusal.category}, never
 *   on the English text of a message.
 *
 * Approximation is deliberately NOT offered as a rescue. Routing a refused
 * pair to `booleanWithQuality` without `exactOnly` was measured on the pinned
 * kernel against two offset unit spheres: it throws "non-manifold result" on
 * the same pair. That trades one failure for a worse one, and an approximate
 * body that would export as flats is exactly what this product refuses to
 * commit.
 */
import type {
  RemusKernel,
  SolidOperationDetailedResult
} from './remus-runtime';

/** The three exact booleans with a typed twin in the pinned kernel. */
export type ExactBooleanOperation = 'cut' | 'fuse' | 'intersect';

/** The kernel's own refusal taxonomy, kept in step with the pin. */
export type BooleanRefusalCategory = Extract<
  SolidOperationDetailedResult,
  { status: 'error' }
>['category'];

const OPERATION_NOUN: Record<ExactBooleanOperation, string> = {
  cut: 'Subtract',
  fuse: 'Union',
  intersect: 'Intersect'
};

const OPERATION_PAST_TENSE: Record<ExactBooleanOperation, string> = {
  cut: 'cut',
  fuse: 'combined',
  intersect: 'intersected'
};

/**
 * How to name the bodies to the person who asked for the operation.
 *
 * A caller that knows what the user called them passes them through; one that
 * is fusing anonymous instances or probing a candidate move does not, and
 * gets the neutral phrasing rather than an invented name.
 */
function operandPhrase(operands: readonly string[] | undefined): string {
  const named = (operands ?? []).filter((name) => name.trim().length > 0);
  if (named.length === 0) {
    return 'these bodies';
  }
  const quoted = named.map((name) => `"${name}"`);
  if (quoted.length === 1) {
    return quoted[0]!;
  }
  return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)!}`;
}

/**
 * The refusal as a clause, so a caller with its own heading — "Filling the
 * through-hole failed: …" — can say what happened without stacking two
 * headings onto one sentence.
 */
function refusalReason(
  operation: ExactBooleanOperation,
  category: BooleanRefusalCategory,
  subject: string
): string {
  const verb = OPERATION_PAST_TENSE[operation];
  switch (category) {
    case 'quality_refused':
      return `${subject} could not be ${verb} exactly, and an approximate result was declined`;
    case 'unsupported':
      return `${subject} are a combination the exact modeling engine does not support`;
    case 'nonconvergence':
      return `the exact surface intersection between ${subject} did not converge`;
    case 'resource_limit':
      return `${subject} exceeded the exact modeling engine's budget for this operation`;
    case 'tolerance_violation':
      return `${subject} could not be ${verb} within the exact tolerance`;
    case 'invalid_input':
      return `the exact modeling engine rejected the input for ${subject}`;
    case 'invalid_topology':
      return `${subject} produced an invalid topology`;
    case 'cancelled':
      return `the ${OPERATION_NOUN[operation].toLowerCase()} was cancelled`;
    case 'internal':
    default:
      return `the exact modeling engine failed internally on ${subject}`;
  }
}

/**
 * What to say when the exact pipeline declined the pair.
 *
 * Only what holds for every refusal in the category. The retired facet census
 * also told a refused union to "subtract instead — the same operands still
 * cut exactly", which it could say because it fired on a result the engine
 * HAD built; a quality refusal is a far wider trigger and the promise does not
 * survive it. Measured on the pin: a 20×20×10 box unioned with an r3 h10
 * cylinder overlapping it by ~1 µm refuses with `exact_only_unattainable` /
 * `quality_refused`, and `cutDetailed` on that same pair refuses identically
 * — so a user who followed the advice got a second refusal. Advice that fails
 * is worse than no advice.
 *
 * Repositioning is the one move worth suggesting: it is offered as something
 * that sometimes works rather than promised, and it addresses the contact
 * itself.
 */
function refusalRemedy(
  operation: ExactBooleanOperation,
  category: BooleanRefusalCategory
): string | null {
  if (category !== 'quality_refused' && category !== 'tolerance_violation') {
    return null;
  }
  return operation === 'fuse'
    ? 'Repositioning the overlap sometimes clears it; otherwise keep the ' +
        'bodies separate.'
    : 'Repositioning the overlap sometimes clears it.';
}

export interface ExactBooleanRefusalInit {
  operation: ExactBooleanOperation;
  category: BooleanRefusalCategory;
  kernelCode: string;
  kernelMessage: string;
  operands?: readonly string[];
  cause?: unknown;
}

/**
 * A boolean the exact pipeline refused, as a typed error.
 *
 * `message` is the whole product sentence; everything before its first
 * newline is what a tool card shows, and the kernel's own code and prose sit
 * behind the detail disclosure — the same split the feature warnings already
 * use. `category` is the branchable field; nothing should parse `message`.
 */
export class ExactBooleanRefusal extends Error {
  readonly operation: ExactBooleanOperation;
  readonly category: BooleanRefusalCategory;
  readonly kernelCode: string;
  readonly kernelMessage: string;
  readonly operands: readonly string[];
  /** The refusal without its operation heading, for callers that add one. */
  readonly reason: string;

  constructor(init: ExactBooleanRefusalInit) {
    const subject = operandPhrase(init.operands);
    const reason = refusalReason(init.operation, init.category, subject);
    const remedy = refusalRemedy(init.operation, init.category);
    super(
      `${OPERATION_NOUN[init.operation]} refused: ${reason}.` +
        (remedy ? ` ${remedy}` : '') +
        `\nKernel refusal ${init.kernelCode} (${init.category}): ${init.kernelMessage}`,
      init.cause === undefined ? undefined : { cause: init.cause }
    );
    this.name = 'ExactBooleanRefusal';
    this.operation = init.operation;
    this.category = init.category;
    this.kernelCode = init.kernelCode;
    this.kernelMessage = init.kernelMessage;
    this.operands = init.operands ?? [];
    this.reason = reason;
  }
}

/**
 * The refusal behind an error, however deeply a caller wrapped it.
 *
 * Several call sites add their own context with `{ cause }`, so branching on
 * `instanceof` at the top level alone would lose the category exactly where
 * the added context made the message longest.
 */
export function exactBooleanRefusalOf(
  error: unknown
): ExactBooleanRefusal | null {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof ExactBooleanRefusal) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The refusal clause behind an error, for callers with their own heading. */
export function exactBooleanRefusalReason(error: unknown): string | null {
  return exactBooleanRefusalOf(error)?.reason ?? null;
}

function stringField(
  details: Record<string, unknown>,
  key: string
): string | null {
  const value = details[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export type ExactBooleanOutcome =
  | { status: 'ok'; solid: number }
  | { status: 'refused'; refusal: ExactBooleanRefusal };

/**
 * Run one exact boolean and return the kernel's verdict as data.
 *
 * For the probes — "do these two share material?", "would this move fuse?" —
 * a refusal is an answer rather than an exception, and they read this
 * directly. Note that the typed twins report an invalid handle the same way,
 * so a programming error surfaces as `invalid_input` instead of a throw.
 */
export function exactBooleanOutcome(
  kernel: RemusKernel,
  operation: ExactBooleanOperation,
  a: number,
  b: number,
  operands?: readonly string[]
): ExactBooleanOutcome {
  const detailed =
    operation === 'cut'
      ? kernel.cutDetailed(a, b)
      : operation === 'fuse'
        ? kernel.fuseDetailed(a, b)
        : kernel.intersectDetailed(a, b);
  if (detailed.status === 'ok') {
    return { status: 'ok', solid: detailed.value };
  }
  const details = detailed.details ?? {};
  return {
    status: 'refused',
    refusal: new ExactBooleanRefusal({
      operation,
      category: detailed.category,
      kernelCode: stringField(details, 'kernelCode') ?? detailed.code,
      kernelMessage:
        stringField(details, 'message') ??
        'the exact modeling engine gave no further detail',
      operands
    })
  };
}

/** Run one exact boolean, refusing by name rather than by kernel prose. */
export function exactBoolean(
  kernel: RemusKernel,
  operation: ExactBooleanOperation,
  a: number,
  b: number,
  operands?: readonly string[]
): number {
  const outcome = exactBooleanOutcome(kernel, operation, a, b, operands);
  if (outcome.status === 'refused') {
    throw outcome.refusal;
  }
  return outcome.solid;
}

export function exactCut(
  kernel: RemusKernel,
  target: number,
  tool: number,
  operands?: readonly string[]
): number {
  return exactBoolean(kernel, 'cut', target, tool, operands);
}

export function exactFuse(
  kernel: RemusKernel,
  a: number,
  b: number,
  operands?: readonly string[]
): number {
  return exactBoolean(kernel, 'fuse', a, b, operands);
}

export function exactIntersect(
  kernel: RemusKernel,
  a: number,
  b: number,
  operands?: readonly string[]
): number {
  return exactBoolean(kernel, 'intersect', a, b, operands);
}

/**
 * The two members a failing fold step was working on.
 *
 * The accumulator is everything fused so far, which has no single name, so
 * only the member being added is named — that is the one the user can move.
 */
function memberNames(
  labels: readonly string[] | undefined,
  index: number
): readonly string[] | undefined {
  const label = labels?.[index];
  return label === undefined ? undefined : [label];
}

/**
 * Retire a solid the diagnosis fold created, and only one it created.
 *
 * `deleteSolid` retires the handle and its unshared topology subtree; shared
 * topology and every caller-owned input survive it, which is what makes it
 * safe to drop a superseded accumulator while the fold keeps going. It
 * throws for a handle that is already gone or still referenced, and a failed
 * release must never replace the refusal the fold exists to report.
 */
function releaseIntermediate(kernel: RemusKernel, solid: number): void {
  try {
    kernel.deleteSolid(solid);
  } catch {
    // Nothing to do: the fold is diagnosis, and an arena handle it could not
    // retire is not a reason to lose the attribution.
  }
}

function firstRefusedMember(
  kernel: RemusKernel,
  solids: readonly number[],
  labels: readonly string[] | undefined,
  cause: unknown
): ExactBooleanRefusal | null {
  let accumulated = solids[0];
  if (accumulated === undefined) {
    return null;
  }
  // Every partial union the fold builds is scratch. `owned` is the one the
  // fold allocated and still holds; the caller's inputs are never in it.
  let owned: number | null = null;
  try {
    for (let index = 1; index < solids.length; index += 1) {
      let outcome: ExactBooleanOutcome;
      try {
        outcome = exactBooleanOutcome(
          kernel,
          'fuse',
          accumulated,
          solids[index]!,
          memberNames(labels, index)
        );
      } catch {
        // The fold exists only to attribute a refusal that already happened.
        // If it cannot run at all, the original error is still the answer.
        return null;
      }
      if (outcome.status === 'refused') {
        return new ExactBooleanRefusal({
          operation: 'fuse',
          category: outcome.refusal.category,
          kernelCode: outcome.refusal.kernelCode,
          kernelMessage: outcome.refusal.kernelMessage,
          operands: memberNames(labels, index),
          cause
        });
      }
      if (owned !== null) {
        releaseIntermediate(kernel, owned);
      }
      accumulated = outcome.solid;
      owned = outcome.solid;
    }
    return null;
  } finally {
    if (owned !== null) {
      releaseIntermediate(kernel, owned);
    }
  }
}

/**
 * Fuse a cluster, and on refusal say WHICH member the exact engine declined.
 *
 * `fuseAll` has no typed twin in the pin and reduces overlapping solids in a
 * balanced tree, so its bare throw names nothing: a hundred-instance pattern
 * reports one sentence about the whole row. The pairwise fold runs only after
 * that throw, purely to attribute it — the first `fuseDetailed` refusal
 * identifies the member, and its label goes into the message.
 *
 * The fold is diagnosis, not a rescue. A left fold can succeed where the
 * balanced reduction refused; accepting that result would make a cluster's
 * fate depend on the order the diagnosis happened to take, so when the fold
 * finds no culprit the original refusal stands unchanged. Because the partial
 * unions it builds are scratch, each is retired as soon as the next step
 * supersedes it and the last is retired on the way out — the fold leaves the
 * arena as it found it, holding at most one extra solid at a time.
 *
 * It costs a second pass, bounded by the cluster: a feature may contribute at
 * most 100 solids, and 99 fuses plus their releases measured 54 ms on the pin
 * for a 100-box row. That is spent only after `fuseAll` has already thrown.
 */
export function exactFuseAll(
  kernel: RemusKernel,
  solids: readonly number[],
  labels?: readonly string[]
): number {
  try {
    return kernel.fuseAll(Uint32Array.from(solids));
  } catch (error) {
    throw firstRefusedMember(kernel, solids, labels, error) ?? error;
  }
}
