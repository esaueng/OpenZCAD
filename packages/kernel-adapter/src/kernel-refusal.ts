/**
 * One typed seam for every kernel refusal.
 *
 * Remus answers a failure in two different shapes. The modern entry points
 * return it as DATA — a status, a stable code and a category drawn from the
 * kernel's own failure taxonomy. The older ones throw a bare `Error` carrying
 * the kernel's diagnostic prose, and everything downstream that wanted to
 * behave differently for "the engine will not do this" than for "the input was
 * malformed" had no choice but to match that English.
 *
 * That matching is the defect this module exists to remove. `refusalLanguage`
 * in the web app still holds a regex table because some kernel families have
 * no typed twin on the pin; what changes here is that every family which DOES
 * have one stops feeding it. A refusal that carries a {@link KernelRefusal}
 * is branched on by {@link KernelRefusal.category}, never by its sentence.
 *
 * The category union is deliberately NOT restated here. It is extracted from
 * the pinned kernel's own `SolidOperationDetailedResult`, so a kernel bump
 * that adds a category is a compile error in the one place that enumerates
 * them ({@link KERNEL_REFUSAL_CATEGORIES}) rather than a silent gap in a
 * hand-written list.
 */
import type { SolidOperationDetailedResult } from './remus-runtime';

/**
 * The kernel's failure taxonomy, derived from the pin rather than restated.
 *
 * The parent of this seam introduced it for booleans; every family shares it,
 * because the kernel categorises a refused validation, a reverted heal and a
 * refused boolean out of the same set.
 */
export type KernelRefusalCategory = Extract<
  SolidOperationDetailedResult,
  { status: 'error' }
>['category'];

/**
 * Every category, once, for the presenters that must answer for all of them.
 *
 * The `satisfies` clause is half the guard: nothing that is not a category may
 * appear here. {@link UNENUMERATED_CATEGORIES} is the other half — it fails to
 * compile if the kernel gains a category this list omits, so a kernel bump
 * cannot quietly fall through to a generic sentence.
 */
export const KERNEL_REFUSAL_CATEGORIES = [
  'invalid_input',
  'invalid_topology',
  'unsupported',
  'nonconvergence',
  'resource_limit',
  'tolerance_violation',
  'quality_refused',
  'cancelled',
  'internal'
] as const satisfies readonly KernelRefusalCategory[];

type EnumeratedCategory = (typeof KERNEL_REFUSAL_CATEGORIES)[number];

/**
 * `never` while the list above and the kernel's union agree, and a real type
 * the empty array cannot satisfy the moment they diverge.
 */
type MissingCategory = Exclude<KernelRefusalCategory, EnumeratedCategory>;
export const UNENUMERATED_CATEGORIES: readonly MissingCategory[] = [];

/**
 * Which kernel API family refused.
 *
 * Present so a consumer can tell a refused boolean from a body that failed
 * validation after it was built — the category alone does not say that, and
 * the two want different sentences.
 */
export type KernelRefusalFamily =
  'boolean' | 'validation' | 'healing' | 'import';

export interface KernelRefusalInit {
  family: KernelRefusalFamily;
  category: KernelRefusalCategory;
  /** The kernel's stable code, or the adapter's when the kernel gave none. */
  kernelCode: string;
  kernelMessage: string;
  /** The whole product sentence: headline first, detail after a newline. */
  message: string;
  /** The headline without its operation heading, for callers that add one. */
  reason: string;
  cause?: unknown;
}

/**
 * A refusal the kernel classified, as a typed error.
 *
 * `message` is product copy and may be reworded at any time. `category` and
 * `family` are the branchable fields; nothing may parse `message`.
 */
export class KernelRefusal extends Error {
  readonly family: KernelRefusalFamily;
  readonly category: KernelRefusalCategory;
  readonly kernelCode: string;
  readonly kernelMessage: string;
  /** The refusal without its operation heading, for callers that add one. */
  readonly reason: string;

  constructor(init: KernelRefusalInit) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause }
    );
    this.name = 'KernelRefusal';
    this.family = init.family;
    this.category = init.category;
    this.kernelCode = init.kernelCode;
    this.kernelMessage = init.kernelMessage;
    this.reason = init.reason;
  }
}

/** How deep a `cause` chain this module walks before giving up. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The refusal behind an error, however deeply a caller wrapped it.
 *
 * Several call sites add their own context with `{ cause }`, so branching on
 * `instanceof` at the top level alone would lose the category exactly where
 * the added context made the message longest.
 */
export function kernelRefusalOf(error: unknown): KernelRefusal | null {
  return kernelRefusalIn(error, isAnyRefusal);
}

/** Accepts every refusal, for the caller that does not care which family. */
function isAnyRefusal(refusal: KernelRefusal): refusal is KernelRefusal {
  return refusal instanceof KernelRefusal;
}

/**
 * The nearest refusal in the chain that `accept` recognises.
 *
 * A family with a richer subclass — a boolean refusal naming its operands —
 * looks for its own type, so a wrapper that is itself a `KernelRefusal` from
 * another family cannot hide it.
 */
export function kernelRefusalIn<T extends KernelRefusal>(
  error: unknown,
  accept: (refusal: KernelRefusal) => refusal is T
): T | null {
  let current = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current instanceof Error;
    depth += 1
  ) {
    if (current instanceof KernelRefusal && accept(current)) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** The kernel's own classification behind an error, when it gave one. */
export function kernelRefusalCategoryOf(
  error: unknown
): KernelRefusalCategory | null {
  return kernelRefusalOf(error)?.category ?? null;
}

/** The refusal clause behind an error, for callers with their own heading. */
export function kernelRefusalReason(error: unknown): string | null {
  return kernelRefusalOf(error)?.reason ?? null;
}

/**
 * The record a refusal travels on once it leaves the adapter.
 *
 * Kept structural rather than importing `FeatureWarning`, so the adapter's
 * error types do not depend on the document schema. `operation` is present
 * only for a family that has one — booleans name `cut` / `fuse` / `intersect`;
 * a validation refusal has no operand pair to name.
 */
export interface KernelRefusalRecord {
  family: KernelRefusalFamily;
  operation?: string;
  category: string;
  code: string;
}

/** The record for an error, or undefined when the kernel gave no category. */
export function kernelRefusalRecordOf(
  error: unknown
): KernelRefusalRecord | undefined {
  const refusal = kernelRefusalOf(error);
  if (!refusal) {
    return undefined;
  }
  const operation = (refusal as { operation?: unknown }).operation;
  return {
    family: refusal.family,
    ...(typeof operation === 'string' ? { operation } : {}),
    category: refusal.category,
    code: refusal.kernelCode
  };
}

/**
 * Read a string field out of a kernel `details` bag.
 *
 * The bag is `Record<string, unknown>` by declaration and the kernel is free
 * to omit anything in it, so every read is checked.
 */
export function kernelDetailString(
  details: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = details?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parse a kernel result that is declared `any` and arrives as JSON text.
 *
 * Several typed twins (`validateSolidDetailed`, `unifyFacesChecked`,
 * `runHealPipeline`) are typed `any` in the pinned `.d.ts`. Measured on the
 * pin: all three hand back a JSON string. They are parsed defensively and in
 * one place, because these results GATE whether geometry is published — a
 * payload that cannot be read must raise, never read as a pass.
 */
export function readKernelPayload(
  raw: unknown,
  what: string
): Record<string, unknown> {
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error(`The kernel returned an unreadable ${what} result.`);
  }
  return payload as Record<string, unknown>;
}

/**
 * An arena handle field of a kernel payload, or a raise.
 *
 * Separate from {@link kernelPayloadCount} because the two mean different
 * things on the failing path. A count the adapter cannot read is a report it
 * cannot summarise; a handle it cannot read is a body it cannot find. The
 * second is the worse one — the operation that returned the payload has
 * already committed, so the caller's pre-operation handle is no longer an
 * answer, only a stale one.
 */
export function kernelPayloadHandle(
  payload: Record<string, unknown>,
  key: string,
  what: string
): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `The kernel's ${what} result is missing its "${key}" handle.`
    );
  }
  return value;
}

/** A non-negative integer field of a kernel payload, or a raise. */
export function kernelPayloadCount(
  payload: Record<string, unknown>,
  key: string,
  what: string
): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `The kernel's ${what} result is missing its "${key}" count.`
    );
  }
  return value;
}
