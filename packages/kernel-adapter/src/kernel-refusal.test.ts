import { describe, expect, it } from 'vitest';
import {
  KERNEL_REFUSAL_CATEGORIES,
  KernelRefusal,
  UNENUMERATED_CATEGORIES,
  kernelDetailString,
  kernelPayloadCount,
  kernelRefusalCategoryOf,
  kernelRefusalOf,
  kernelRefusalRecordOf,
  readKernelPayload,
  type KernelRefusalCategory
} from './kernel-refusal';
import {
  ExactBooleanRefusal,
  exactBooleanRefusalOf
} from './exact-boolean-refusal';

function refusal(
  category: KernelRefusalCategory,
  cause?: unknown
): KernelRefusal {
  return new KernelRefusal({
    family: 'validation',
    category,
    kernelCode: 'test_code',
    kernelMessage: 'kernel words',
    message: 'Product sentence.',
    reason: 'product reason',
    ...(cause === undefined ? {} : { cause })
  });
}

describe('the shared kernel refusal taxonomy', () => {
  /**
   * The category list is the presenters' exhaustive switch. It is derived
   * from the pin at compile time; this asserts the runtime half — that every
   * category the kernel documents is listed, once.
   */
  it('enumerates exactly the pinned kernel categories', () => {
    expect([...KERNEL_REFUSAL_CATEGORIES].sort()).toEqual(
      [
        'cancelled',
        'internal',
        'invalid_input',
        'invalid_topology',
        'nonconvergence',
        'quality_refused',
        'resource_limit',
        'tolerance_violation',
        'unsupported'
      ].sort()
    );
    expect(new Set(KERNEL_REFUSAL_CATEGORIES).size).toBe(
      KERNEL_REFUSAL_CATEGORIES.length
    );
    // Inert while the list and the kernel union agree; a kernel bump that
    // adds a category makes this array's element type non-`never`, which is
    // a compile error at its declaration rather than a silent gap here.
    expect(UNENUMERATED_CATEGORIES).toEqual([]);
  });

  it('finds a refusal through a chain of wrapping causes', () => {
    const inner = refusal('resource_limit');
    const wrapped = new Error('outer', {
      cause: new Error('middle', { cause: inner })
    });
    expect(kernelRefusalOf(wrapped)).toBe(inner);
    expect(kernelRefusalCategoryOf(wrapped)).toBe('resource_limit');
  });

  it('gives up rather than walking an unbounded cause chain', () => {
    let error = refusal('internal') as Error;
    for (let depth = 0; depth < 12; depth += 1) {
      error = new Error(`layer ${depth}`, { cause: error });
    }
    expect(kernelRefusalOf(error)).toBeNull();
  });

  it('reports no refusal for an ordinary kernel throw', () => {
    expect(kernelRefusalOf(new Error('invalid solid handle'))).toBeNull();
    expect(kernelRefusalCategoryOf('not an error')).toBeNull();
    expect(kernelRefusalRecordOf(new Error('plain'))).toBeUndefined();
  });

  /**
   * A boolean refusal is a `KernelRefusal`, so the general seam sees its
   * category — and the boolean-specific lookup still skips a wrapper from
   * another family rather than stopping at it.
   */
  it('shares one class hierarchy with the boolean refusal', () => {
    const boolean = new ExactBooleanRefusal({
      operation: 'fuse',
      category: 'quality_refused',
      kernelCode: 'exact_only_unattainable',
      kernelMessage: 'exact-only policy: …',
      operands: ['Plate']
    });
    expect(boolean).toBeInstanceOf(KernelRefusal);
    expect(boolean.family).toBe('boolean');
    expect(kernelRefusalCategoryOf(boolean)).toBe('quality_refused');
    expect(kernelRefusalRecordOf(boolean)).toEqual({
      family: 'boolean',
      operation: 'fuse',
      category: 'quality_refused',
      code: 'exact_only_unattainable'
    });

    const shadowed = refusal('internal', boolean);
    expect(kernelRefusalOf(shadowed)?.family).toBe('validation');
    expect(exactBooleanRefusalOf(shadowed)).toBe(boolean);
  });

  it('records a validation refusal without inventing an operation', () => {
    expect(kernelRefusalRecordOf(refusal('invalid_topology'))).toEqual({
      family: 'validation',
      category: 'invalid_topology',
      code: 'test_code'
    });
  });

  it('reads a details bag without trusting it', () => {
    expect(kernelDetailString({ message: 'said' }, 'message')).toBe('said');
    expect(kernelDetailString({ message: '' }, 'message')).toBeNull();
    expect(kernelDetailString({ message: 7 }, 'message')).toBeNull();
    expect(kernelDetailString(undefined, 'message')).toBeNull();
  });
});

describe('reading a kernel payload that is typed `any`', () => {
  it('accepts the JSON string the pinned kernel actually returns', () => {
    expect(readKernelPayload('{"errorCount":0}', 'validation')).toEqual({
      errorCount: 0
    });
  });

  it('accepts an already-parsed object', () => {
    expect(readKernelPayload({ errorCount: 1 }, 'validation')).toEqual({
      errorCount: 1
    });
  });

  /** A gating result that cannot be read must raise, never read as a pass. */
  it.each([['not json'], ['null'], ['[1,2]'], [42], [null], [undefined]])(
    'raises rather than passing on %p',
    (raw) => {
      expect(() => readKernelPayload(raw, 'validation')).toThrow(
        /unreadable validation result/
      );
    }
  );

  it('raises on a missing or nonsensical count', () => {
    expect(() => kernelPayloadCount({}, 'errorCount', 'validation')).toThrow(
      /missing its "errorCount" count/
    );
    expect(() =>
      kernelPayloadCount({ errorCount: -1 }, 'errorCount', 'validation')
    ).toThrow(/errorCount/);
    expect(() =>
      kernelPayloadCount({ errorCount: 1.5 }, 'errorCount', 'validation')
    ).toThrow(/errorCount/);
    expect(kernelPayloadCount({ errorCount: 3 }, 'errorCount', 'x')).toBe(3);
  });
});
